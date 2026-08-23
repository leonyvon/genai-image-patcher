
import { useState, useRef, useMemo } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, Region } from '../types';
import { loadImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, cropRegion, padImageToSquare, depadImageByRatio, depadImageFromSquare, stitchImage, stitchImageInverted, extractCropFromFullImage, compressImageToTargetSize, PaddingInfo, urlToBase64, base64ToObjectURLAsync, releaseObjectURL, isEffectiveReference } from '../services/imageUtils';
import { generateRegionEdit, generateTranslation } from '../services/aiService';
import { playCompletionSound } from '../services/sound';
import { AsyncSemaphore, runWithConcurrency } from '../services/concurrencyUtils';
import { t } from '../services/translations';
import { detectBubbles } from '../services/detectionService';

/**
 * Sentinel string that marks the start of a cached translation block inside
 * `region.customPrompt`. Anything BEFORE this line is treated as the user's
 * own instructions; anything AFTER is reused as the cached translation
 * result (skipping the translation API on subsequent runs).
 *
 * To force a re-translation, the user can delete this line (or the whole
 * customPrompt) in the sidebar textarea.
 */
const TRANSLATION_CACHE_MARKER = '以下是为你提供的图片文字以及文字在图上的坐标/位置数据，请参考：';

const splitTranslationCache = (prompt?: string): { userPart: string; cached: string | null } => {
    if (!prompt) return { userPart: '', cached: null };
    const idx = prompt.indexOf(TRANSLATION_CACHE_MARKER);
    if (idx < 0) return { userPart: prompt.trim(), cached: null };
    const cached = prompt.slice(idx + TRANSLATION_CACHE_MARKER.length).trim();
    return {
        userPart: prompt.slice(0, idx).trim(),
        cached: cached.length > 0 ? cached : null,
    };
};

const writeTranslationCache = (userPart: string, translation: string): string => {
    return userPart
        ? `${userPart}\n\n${TRANSLATION_CACHE_MARKER}\n${translation}`
        : `${TRANSLATION_CACHE_MARKER}\n${translation}`;
};

export function useImageProcessor(
    images: UploadedImage[],
    updateImage: (id: string, updater: (img: UploadedImage) => UploadedImage) => void,
    updateAllImages: (updater: (img: UploadedImage) => UploadedImage) => void,
    config: AppConfig,
    selectedImage: UploadedImage | undefined
) {
    const [processingState, setProcessingState] = useState<ProcessingStep>(ProcessingStep.IDLE);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [isDetecting, setIsDetecting] = useState(false);
    const abortControllerRef = useRef<AbortController | null>(null);

    // 有效参考图列表：config 中仍被图库图片引用的条目（过滤孤儿残留）。
    // AI 请求基于此列表组装 images[]——保证 prompt 里的 [image N] 与实际数组位置一致，
    // 且孤儿条目不占编号、不发给模型。
    const aiConfig = useMemo<AppConfig>(() => {
        const effectiveRefs = config.grsaiReferenceImages.filter((b64) =>
            images.some((img) => img.referenceBase64 === b64)
        );
        return effectiveRefs.length === config.grsaiReferenceImages.length
            ? config
            : { ...config, grsaiReferenceImages: effectiveRefs };
    }, [config, images]);

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        updateAllImages(img => ({
            ...img,
            regions: img.regions.map(r => r.status === 'processing' ? { ...r, status: 'pending' } : r)
        }));
        setProcessingState(ProcessingStep.IDLE);
        setErrorMsg(t(config.language, 'stopped_by_user'));
    };

    const processSingleImage = async (imageSnapshot: UploadedImage, signal: AbortSignal, globalSemaphore: AsyncSemaphore) => {
        if (signal.aborted) return;
        if (imageSnapshot.isSkipped) return;
        if (isEffectiveReference(imageSnapshot, config.grsaiReferenceImages)) return;

        const regionsMap = new Map<string, Region>();
        imageSnapshot.regions.forEach(r => regionsMap.set(r.id, r));

        let initialRegions = [...imageSnapshot.regions];
        if (initialRegions.length === 0 && config.processFullImageIfNoRegions) {
            const fullRegion: Region = {
                id: crypto.randomUUID(),
                x: 0, y: 0, width: 100, height: 100,
                type: 'rect',
                status: 'pending',
                source: 'manual'
            };
            initialRegions = [fullRegion];
            regionsMap.set(fullRegion.id, fullRegion);
            updateImage(imageSnapshot.id, img => ({ ...img, regions: initialRegions }));
        }

        const allActiveRegions = Array.from(regionsMap.values()).filter(r => r.status !== 'processing');
        const regionsToProcess = allActiveRegions.filter(r => (r.status === 'pending' || r.status === 'failed') && !r.contextOnly);
        if (regionsToProcess.length === 0) return;

        // 已完成补丁（含 IOPaint 涂抹/选区移除）合成进 AI 输入基底：AI 编辑的是"用户当前看到的画面"，
        // 而不是原始图。排除本次要处理的选区（重置后无补丁；即便残留也不应把旧补丁喂给 AI）。
        const completedPatchesToComposite = allActiveRegions.filter(
            r => r.status === 'completed' && !!r.processedImageUrl && !regionsToProcess.some(p => p.id === r.id)
        );
        // 单选区裁剪路径用原图基底（保裁剪清晰）；全图遮罩/翻译上下文用 preview 基底（保 mask 画布内存）。
        let compositedOriginalUrl: string | null = null;
        let compositedPreviewUrl: string | null = null;
        if (completedPatchesToComposite.length > 0) {
            if (!config.useFullImageMasking) {
                compositedOriginalUrl = await stitchImage(imageSnapshot.originalUrl || imageSnapshot.previewUrl, completedPatchesToComposite);
            }
            if (imageSnapshot.previewUrl && imageSnapshot.previewUrl !== imageSnapshot.originalUrl) {
                compositedPreviewUrl = await stitchImage(imageSnapshot.previewUrl, completedPatchesToComposite);
            }
        }
        const releaseCompositedBases = () => {
            if (compositedOriginalUrl) releaseObjectURL(compositedOriginalUrl);
            if (compositedPreviewUrl && compositedPreviewUrl !== compositedOriginalUrl) releaseObjectURL(compositedPreviewUrl);
        };

        // The mask canvas is created at the source image resolution. Using the
        // original (e.g. 6000x8000) burns ~190MB of canvas memory; the preview
        // is already capped at 2048 in balanced mode, so prefer it for mask
        // input. cropRegion / single-region path keeps imgElement at full res
        // so per-region crops sent to the API stay sharp.
        const imgElement = await loadImage(compositedOriginalUrl ?? (imageSnapshot.originalUrl || imageSnapshot.previewUrl));
        const maskImg = imageSnapshot.previewUrl && imageSnapshot.previewUrl !== imageSnapshot.originalUrl
            ? await loadImage(compositedPreviewUrl ?? imageSnapshot.previewUrl)
            : imgElement;
        regionsToProcess.forEach(r => regionsMap.set(r.id, { ...r, status: 'processing' }));
        updateImage(imageSnapshot.id, img => ({ ...img, regions: Array.from(regionsMap.values()) }));

        if (signal.aborted) {
            releaseCompositedBases();
            return;
        }
        setProcessingState(ProcessingStep.CROPPING);

        if (config.useFullImageMasking) {
            await globalSemaphore.acquire();
            try {
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                
                // Handle Inverted Masking — now returns Object URL
                let inputImageUrl: string;
                if (config.useInvertedMasking) {
                    inputImageUrl = await createInvertedMultiMaskedFullImage(maskImg, allActiveRegions, imageSnapshot.sketchStrokes);
                } else {
                    inputImageUrl = await createMultiMaskedFullImage(maskImg, allActiveRegions, imageSnapshot.sketchStrokes);
                }

                // Square Fill Logic — returns Object URL.
                // Inverted masking already outputs a full-image patch, so padding+depad
                // is a no-op round trip that just wastes tokens / time. Skip it.
                let payloadUrl = inputImageUrl;
                let paddingInfo: PaddingInfo | null = null;
                const useSquareFill = config.enableSquareFill && !config.useInvertedMasking;
                if (useSquareFill) {
                    const padded = await padImageToSquare(inputImageUrl);
                    payloadUrl = padded.url;
                    paddingInfo = padded.info;
                    // Release the non-padded input — we now have the padded version
                    releaseObjectURL(inputImageUrl);
                }

                // Compress for AI payload — separate encodings for translation
                // (smaller target, token-efficient) and redraw (larger target,
                // preserves dims for the stitch/depad workflow). Both keep pixel
                // dimensions, so masking/depadding math is unaffected.
                let translationPayloadUrl = payloadUrl;
                let redrawPayloadUrl = payloadUrl;
                if (config.enableAiPayloadCompression) {
                    redrawPayloadUrl = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadRedrawTargetKB });
                    translationPayloadUrl = config.enableTranslationMode
                        ? await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB })
                        : redrawPayloadUrl;
                    releaseObjectURL(payloadUrl);
                }

                // Convert to base64 lazily; each API call uses its own compressed payload.
                let translationBase64: string | null = null;
                let redrawBase64: string | null = null;
                const getTranslationBase64 = async () => {
                    if (translationBase64 == null) translationBase64 = await urlToBase64(translationPayloadUrl);
                    return translationBase64;
                };
                const getRedrawBase64 = async () => {
                    if (redrawBase64 == null) redrawBase64 = await urlToBase64(redrawPayloadUrl);
                    return redrawBase64;
                };

                let translationText = '';
                // Split image-level customPrompt the same way region.customPrompt is split:
                // userPart = user-written instructions (overrides global prompt in this mode),
                // cached = prior translation block (if any). Reused → skip translation API.
                const { userPart: imageUserPart, cached: imageCachedTranslation } = splitTranslationCache(imageSnapshot.customPrompt);
                if (config.enableTranslationMode) {
                   if (imageCachedTranslation) {
                       translationText = imageCachedTranslation;
                   } else {
                       setProcessingState(ProcessingStep.API_CALLING);
                        translationText = await generateTranslation(await getTranslationBase64(), aiConfig, signal);

                       // Persist translation back into image.customPrompt for reuse next run.
                       if (translationText) {
                           const newImagePrompt = writeTranslationCache(imageUserPart, translationText);
                           updateImage(imageSnapshot.id, img => ({ ...img, customPrompt: newImagePrompt }));
                       }
                   }
                }

                setProcessingState(ProcessingStep.API_CALLING);
                // Global prompt is ALWAYS the base — image/region customPrompts append to it,
                // never replace it. Keeps the global prompt's contract (size/resolution rules,
                // style guides etc.) effective regardless of per-image overrides.
                let effectivePrompt = config.prompt.trim();
                if (imageUserPart) {
                   effectivePrompt += ` ${imageUserPart}`;
                }
                if (translationText) {
                    effectivePrompt += `\n\n${TRANSLATION_CACHE_MARKER}\n${translationText}`;
                }
                let apiResultBase64 = await generateRegionEdit(await getRedrawBase64(), effectivePrompt, aiConfig, signal);
                translationBase64 = null;
                redrawBase64 = null;
                // apiResultBase64 is a data:image/... string from the API

                // Release the payload URLs — we're done with them
                if (translationPayloadUrl !== redrawPayloadUrl) releaseObjectURL(translationPayloadUrl);
                releaseObjectURL(redrawPayloadUrl);

                // Convert API base64 result to Object URL for further processing
                let apiResultUrl: string;
                if (apiResultBase64.startsWith('data:')) {
                    apiResultUrl = await base64ToObjectURLAsync(apiResultBase64);
                    apiResultBase64 = ''; // Allow GC of the large base64 string
                } else {
                    apiResultUrl = apiResultBase64; // Already a URL
                    apiResultBase64 = '';
                }
                
                // Depad — returns Object URL
                if (useSquareFill && paddingInfo) {
                    const depadResultUrl = config.squareFillMode === 'ratio'
                        ? await depadImageByRatio(apiResultUrl, paddingInfo)
                        : await depadImageFromSquare(apiResultUrl, paddingInfo, config.squareFillMargin);
                    releaseObjectURL(apiResultUrl);
                    apiResultUrl = depadResultUrl;
                }

                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

                if (config.useInvertedMasking) {
                    const stitchedUrl = await stitchImageInverted(imageSnapshot.previewUrl, apiResultUrl, regionsToProcess);
                    regionsToProcess.forEach(r => {
                        regionsMap.set(r.id, { ...r, status: 'completed' as const });
                    });
                    const currentAllRegions = Array.from(regionsMap.values());

                    updateImage(imageSnapshot.id, img => {
                        const updatedHistory = [...img.history];
                        // Release old fullAiResultUrl in history if present
                        if (updatedHistory[img.historyIndex]?.fullAiResultUrl) {
                            releaseObjectURL(updatedHistory[img.historyIndex].fullAiResultUrl);
                        }
                        if (updatedHistory[img.historyIndex]) {
                           updatedHistory[img.historyIndex] = {
                               ...updatedHistory[img.historyIndex],
                               fullAiResultUrl: apiResultUrl
                           };
                        }
                        // Release old finalResultUrl
                        if (img.finalResultUrl) releaseObjectURL(img.finalResultUrl);
                        if (img.fullAiResultUrl) releaseObjectURL(img.fullAiResultUrl);

                        return {
                            ...img,
                            fullAiResultUrl: apiResultUrl,
                            finalResultUrl: stitchedUrl,
                            regions: currentAllRegions,
                            history: updatedHistory
                        };
                    });
                } else {
                    // Standard Masking Mode
                    for (const region of regionsToProcess) {
                        const finalRegionImageUrl = await extractCropFromFullImage(
                            apiResultUrl,
                            region,
                            maskImg.naturalWidth,
                            maskImg.naturalHeight,
                            config.fullImageOpaquePercent
                        );
                        const completedRegion = { ...region, processedImageUrl: finalRegionImageUrl, status: 'completed' as const, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                        regionsMap.set(region.id, completedRegion);
                    }

                    const currentAllRegions = Array.from(regionsMap.values());
                    
                    updateImage(imageSnapshot.id, img => {
                        const updatedHistory = [...img.history];
                        if (updatedHistory[img.historyIndex]?.fullAiResultUrl) {
                            releaseObjectURL(updatedHistory[img.historyIndex].fullAiResultUrl);
                        }
                        if (updatedHistory[img.historyIndex]) {
                           updatedHistory[img.historyIndex] = {
                               ...updatedHistory[img.historyIndex],
                               fullAiResultUrl: apiResultUrl
                           };
                        }
                        if (img.fullAiResultUrl) releaseObjectURL(img.fullAiResultUrl);

                        return { ...img, fullAiResultUrl: apiResultUrl, regions: currentAllRegions, history: updatedHistory };
                    });
                }
            } catch (err: any) {
                if (err.name !== 'AbortError') {
                    console.error(`Failed to process regions for ${imageSnapshot.file.name}:`, err);
                    setErrorMsg(err?.message || "Unknown error");
                    regionsToProcess.forEach(r => {
                        regionsMap.set(r.id, { ...r, status: 'failed' as const, errorMessage: (err as Error)?.message || String(err) });
                    });
                    updateImage(imageSnapshot.id, img => ({ ...img, regions: Array.from(regionsMap.values()) }));
                }
            } finally {
                globalSemaphore.release();
            }
            releaseCompositedBases();
            return;
        }

        // Pre-generate masked full image as context for translation (compressed, shared across all regions)
        let maskedContextUrl: string | undefined;
        if (config.enableTranslationMode && config.sendMaskedContextForTranslation) {
            try {
                // Same mask-canvas size concern as the useFullImageMasking branch.
                const fullMaskedUrl = await createMultiMaskedFullImage(maskImg, allActiveRegions, imageSnapshot.sketchStrokes);
                if (config.enableAiPayloadCompression) {
                    maskedContextUrl = await compressImageToTargetSize(fullMaskedUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB });
                    releaseObjectURL(fullMaskedUrl);
                } else {
                    maskedContextUrl = fullMaskedUrl;
                }
            } catch (e) {
                console.warn('Failed to generate masked context image for translation:', e);
                maskedContextUrl = undefined;
            }
        }

        // LEGACY / SINGLE REGION PROCESSING (Standard Mode Only)
        const processRegionTask = async (region: Region) => {
            if (signal.aborted) return;
            await globalSemaphore.acquire();
            // Track URLs created in this task for cleanup on error
            let croppedUrl: string | undefined;
            let paddedUrl: string | undefined;
            let translationPayloadUrl: string | undefined;
            let redrawPayloadUrl: string | undefined;
            let apiResultUrl: string | undefined;

            try {
                if (signal.aborted) return;
                croppedUrl = await cropRegion(imgElement, region, imageSnapshot.sketchStrokes);

                let payloadUrl = croppedUrl;
                let paddingInfo: PaddingInfo | null = null;
                if (config.enableSquareFill) {
                    const padded = await padImageToSquare(croppedUrl);
                    paddedUrl = padded.url;
                    payloadUrl = paddedUrl;
                    paddingInfo = padded.info;
                    // Release the non-padded crop — we now have the padded version
                    releaseObjectURL(croppedUrl);
                    croppedUrl = undefined;
                }

                if (signal.aborted) return;

                // Compress for AI payload — separate encodings for translation
                // (smaller target) and redraw (larger target). Per-region crops
                // are often already under both targets, in which case the WebP
                // encoder short-circuits at the 0.92 probe.
                let translationActiveUrl = payloadUrl;
                let redrawActiveUrl = payloadUrl;
                if (config.enableAiPayloadCompression) {
                    redrawPayloadUrl = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadRedrawTargetKB });
                    redrawActiveUrl = redrawPayloadUrl;
                    if (config.enableTranslationMode) {
                        translationPayloadUrl = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB });
                        translationActiveUrl = translationPayloadUrl;
                    } else {
                        translationActiveUrl = redrawPayloadUrl;
                    }
                    // Original (cropped/padded) no longer needed
                    releaseObjectURL(payloadUrl);
                    if (paddedUrl) paddedUrl = undefined;
                    if (croppedUrl) { releaseObjectURL(croppedUrl); croppedUrl = undefined; }
                }

                // Convert to base64 lazily; each API call uses its own compressed payload.
                let translationBase64: string | null = null;
                let redrawBase64: string | null = null;
                const getTranslationBase64 = async () => {
                    if (translationBase64 == null) translationBase64 = await urlToBase64(translationActiveUrl);
                    return translationBase64;
                };
                const getRedrawBase64 = async () => {
                    if (redrawBase64 == null) redrawBase64 = await urlToBase64(redrawActiveUrl);
                    return redrawBase64;
                };

                let translationText = '';
                // Pre-split customPrompt up front: userPart = user instructions,
                // cached = prior translation block (if any). Reused both for the
                // cache-skip check and for rebuilding the prompt below.
                const { userPart: userCustomPrompt, cached: cachedTranslation } = splitTranslationCache(region.customPrompt);
                if (config.enableTranslationMode) {
                   if (cachedTranslation) {
                       translationText = cachedTranslation;
                   } else {
                       setProcessingState(ProcessingStep.API_CALLING);
                       const contextBase64 = maskedContextUrl ? await urlToBase64(maskedContextUrl) : undefined;
                       translationText = await generateTranslation(await getTranslationBase64(), aiConfig, signal, contextBase64);

                       // Persist the translation back into region.customPrompt so the
                       // textarea reflects the cached value and next run reuses it.
                       if (translationText) {
                           const newCustomPrompt = writeTranslationCache(userCustomPrompt, translationText);
                           const current = regionsMap.get(region.id);
                           if (current) regionsMap.set(region.id, { ...current, customPrompt: newCustomPrompt });
                           updateImage(imageSnapshot.id, img => ({
                               ...img,
                               regions: img.regions.map(r =>
                                   r.id === region.id ? { ...r, customPrompt: newCustomPrompt } : r
                               )
                           }));
                       }
                   }
                }
                setProcessingState(ProcessingStep.API_CALLING);
                // Global prompt is ALWAYS the base. image.customPrompt (when present in the
                // "no-regions auto-full-image" path) appends to it instead of replacing.
                let basePrompt = config.prompt.trim();
                if (imageSnapshot.regions.length === 0 && config.processFullImageIfNoRegions && imageSnapshot.customPrompt) {
                   const { userPart: imgUserPart } = splitTranslationCache(imageSnapshot.customPrompt);
                   if (imgUserPart) basePrompt += ` ${imgUserPart}`;
                }
                // Use ONLY the user-written portion here; translation is appended
                // separately so the format stays identical whether translation came
                // from the cache or a fresh API call.
                let effectivePrompt = basePrompt;
                if (userCustomPrompt) {
                    effectivePrompt += ` ${userCustomPrompt}`;
                }
                if (translationText) {
                    effectivePrompt += `\n\n${TRANSLATION_CACHE_MARKER}\n${translationText}`;
                }
                let apiResultBase64 = await generateRegionEdit(await getRedrawBase64(), effectivePrompt, aiConfig, signal);
                translationBase64 = null; // release reference; let the big string GC
                redrawBase64 = null;

                // Release payload URLs — done with them
                if (translationPayloadUrl && translationPayloadUrl !== redrawPayloadUrl) {
                    releaseObjectURL(translationPayloadUrl);
                    translationPayloadUrl = undefined;
                }
                if (redrawPayloadUrl) {
                    releaseObjectURL(redrawPayloadUrl);
                    redrawPayloadUrl = undefined;
                }
                if (!config.enableAiPayloadCompression) {
                    // payloadUrl was the original cropped/padded URL, not yet released
                    releaseObjectURL(payloadUrl);
                    if (paddedUrl) paddedUrl = undefined;
                    if (croppedUrl) { releaseObjectURL(croppedUrl); croppedUrl = undefined; }
                }

                // Convert API base64 result to Object URL
                if (apiResultBase64.startsWith('data:')) {
                    apiResultUrl = await base64ToObjectURLAsync(apiResultBase64);
                    apiResultBase64 = ''; // Allow GC
                } else {
                    apiResultUrl = apiResultBase64;
                    apiResultBase64 = '';
                }
                
                // Depad
                if (config.enableSquareFill && paddingInfo) {
                    const depadResultUrl = config.squareFillMode === 'ratio'
                        ? await depadImageByRatio(apiResultUrl, paddingInfo)
                        : await depadImageFromSquare(apiResultUrl, paddingInfo, config.squareFillMargin);
                    releaseObjectURL(apiResultUrl);
                    apiResultUrl = depadResultUrl;
                }

                if (signal.aborted) return;

                // Release old region URL before setting new one
                const oldRegion = regionsMap.get(region.id);
                if (oldRegion?.processedImageUrl) releaseObjectURL(oldRegion.processedImageUrl);

                // Base the completed region on the LATEST regionsMap entry (which may
                // already include the cached translation written into customPrompt
                // earlier in this task). Spreading the original `region` snapshot here
                // would silently overwrite that update.
                const baseRegion = regionsMap.get(region.id) ?? region;
                const completedRegion = { ...baseRegion, processedImageUrl: apiResultUrl, status: 'completed' as const, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                regionsMap.set(region.id, completedRegion);
                apiResultUrl = undefined; // Ownership transferred to state
                
                const currentAllRegions = Array.from(regionsMap.values());
                
                updateImage(imageSnapshot.id, img => ({ ...img, regions: currentAllRegions }));
            } catch (err: any) {
                if (err.name === 'AbortError') return;
                console.error(`Failed to process region ${region.id}:`, err);
                setErrorMsg(err?.message || "Unknown error");
                // Clean up any URLs we created in this task
                if (apiResultUrl) releaseObjectURL(apiResultUrl);
                if (translationPayloadUrl && translationPayloadUrl !== redrawPayloadUrl) releaseObjectURL(translationPayloadUrl);
                if (redrawPayloadUrl) releaseObjectURL(redrawPayloadUrl);
                if (paddedUrl) releaseObjectURL(paddedUrl);
                if (croppedUrl) releaseObjectURL(croppedUrl);

                const failedRegion = { ...region, status: 'failed' as const, errorMessage: (err as Error)?.message || String(err) };
                regionsMap.set(region.id, failedRegion);
                updateImage(imageSnapshot.id, img => ({ ...img, regions: Array.from(regionsMap.values()) }));
            } finally {
                globalSemaphore.release();
            }
        };
        await runWithConcurrency(regionsToProcess, config.concurrencyLimit, processRegionTask, signal, 0);

        // Release shared context URL after all regions are done
        if (maskedContextUrl) releaseObjectURL(maskedContextUrl);
        releaseCompositedBases();
    };

    const handleProcess = async (processAll: boolean) => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;
        setProcessingState(ProcessingStep.CROPPING);
        setErrorMsg(null);
        const targets: UploadedImage[] = processAll 
            ? images.filter(img => !img.isSkipped && !isEffectiveReference(img, config.grsaiReferenceImages))
            : (selectedImage && !isEffectiveReference(selectedImage, config.grsaiReferenceImages) ? [selectedImage] : []);
        if (targets.length === 0) {
            setProcessingState(ProcessingStep.IDLE);
            return ProcessingStep.IDLE;
        }
        const actualLimit = config.executionMode === 'serial' ? 1 : config.concurrencyLimit;
        const globalSemaphore = new AsyncSemaphore(actualLimit);
        try {
            if (config.executionMode === 'concurrent') {
                await runWithConcurrency<UploadedImage, void>(
                    targets, 
                    config.concurrencyLimit, 
                    (img) => processSingleImage(img, controller.signal, globalSemaphore),
                    controller.signal, 0 
                );
            } else {
                for (const img of targets) {
                    if (controller.signal.aborted) break;
                    await processSingleImage(img, controller.signal, globalSemaphore);
                }
            }
            if (controller.signal.aborted) {
                setErrorMsg(t(config.language, 'stopped_by_user'));
            } else {
                // 正常完成：播放提示音（浏览器自动播放策略下需用户手势，点击"开始生成"已满足）
                playCompletionSound();
            }
            setProcessingState(ProcessingStep.DONE);
            return ProcessingStep.DONE;
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                 setErrorMsg(e.message || "Unknown error occurred");
            }
            setProcessingState(ProcessingStep.IDLE);
            return ProcessingStep.IDLE;
        }
    };

    const handleAutoDetect = async (scope: 'current' | 'all') => {
        setIsDetecting(true);
        setErrorMsg(null);
        const controller = new AbortController();
        abortControllerRef.current = controller;
        try {
            const targets = scope === 'current' 
               ? (selectedImage ? [selectedImage] : [])
               : images.filter(img => !img.isSkipped);
            if (targets.length === 0) {
               setIsDetecting(false);
               return;
            }
            const detectTask = async (img: UploadedImage) => {
               try {
                   const newRegions = await detectBubbles(img.previewUrl, config);
                   if (newRegions.length > 0) {
                       updateImage(img.id, currentImg => ({ ...currentImg, regions: [...currentImg.regions, ...newRegions] }));
                   }
               } catch (e: any) {
                   console.error(`Detection failed for ${img.file.name}:`, e);
               }
            };
            await runWithConcurrency(targets, config.concurrencyLimit, detectTask, controller.signal, 0);
        } catch (e: any) {
            setErrorMsg("Detection Error: " + e.message);
        } finally {
            setIsDetecting(false);
            abortControllerRef.current = null;
        }
    };

    return {
        processingState,
        setProcessingState,
        errorMsg,
        setErrorMsg,
        isDetecting,
        handleProcess,
        handleStop,
        handleAutoDetect
    };
}
