
import React, { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { Region, ProcessingStep, AppConfig, RestoreBox } from './types';
import Sidebar from './components/Sidebar';
import EditorCanvas from './components/EditorCanvas';
import type { TextObject } from './components/PatchEditor';
import { loadImage, cropRegion, stitchImage, createInvertedMultiMaskedFullImage, extractCropFromFullImage, stitchImageInverted, releaseObjectURL, compressImageToTargetSize, urlToBase64, isEffectiveReference, flipImageHorizontal } from './services/imageUtils';
import { fetchOpenAIModels } from './services/aiService';
import { recognizeText } from './services/detectionService';
import { t } from './services/translations';
import { useConfig } from './hooks/useConfig';
import { useImageManager } from './hooks/useImageManager';
import { useImageProcessor } from './hooks/useImageProcessor';
import { useBridge, BridgeHandlerMap } from './hooks/useBridge';
import { BridgeStateSnapshot } from './services/bridgeClient';

// Heavy components: only loaded when user opens the editor / help dialog.
// PatchEditor pulls in ~1000 lines of canvas/text-rendering logic that is
// useless before the user clicks "edit patch".
const PatchEditor = lazy(() => import('./components/PatchEditor'));
const HelpModal = lazy(() => import('./components/HelpModal'));
const GlobalSettings = lazy(() => import('./components/GlobalSettings'));

export default function App() {
  const { config, setConfig } = useConfig();
  
  const {
    images,
    updateImage,
    updateAllImages,
    selectedImage,
    selectedImageId,
    selectedRegionId,
    setSelectedRegionId,
    viewMode,
    setViewMode,
    addImageFiles,
    uploadProgress,
    handleSelectImage,
    handleUpdateRegions,
    handleUpdateRegionPrompt,
    handleUpdateImagePrompt,
    handleToggleSkip,
    handleDeleteImage,
    handleClearAllImages,
    handleApplyResultAsOriginal,
    handleUndoImage,
    handleRedoImage,
    getStitchedUrl
  } = useImageManager(config.performanceMode);

  const {
      processingState,
      errorMsg,
      setErrorMsg,
      isDetecting,
      handleProcess,
      handleStop,
      handleAutoDetect
  } = useImageProcessor(images, updateImage, updateAllImages, config, selectedImage);

  // grsai 全局参考图：图库图片标记/取消标记。标记时压缩并持久化到 config。
  // 有效参考图判定：referenceBase64 必须仍存在于 config.grsaiReferenceImages。
  const referenceToggleInFlight = useRef<Set<string>>(new Set());
  const handleToggleReference = useCallback(async (imageId: string) => {
    const img = images.find(i => i.id === imageId);
    if (!img) return;
    if (referenceToggleInFlight.current.has(imageId)) return;
    referenceToggleInFlight.current.add(imageId);
    try {
      if (img.referenceBase64 && config.grsaiReferenceImages.includes(img.referenceBase64)) {
        // 取消标记：只移除一个匹配条目，避免同内容图片互相误删
        setConfig(prev => {
          const idx = prev.grsaiReferenceImages.indexOf(img.referenceBase64!);
          if (idx < 0) return prev;
          const next = [...prev.grsaiReferenceImages];
          next.splice(idx, 1);
          return { ...prev, grsaiReferenceImages: next };
        });
        updateImage(imageId, i => ({ ...i, isReference: false, referenceBase64: undefined }));
        return;
      }

      // 标记：压缩 → base64 → 写入配置（含配额保护与去重）
      const compressed = await compressImageToTargetSize(img.originalUrl, { targetSizeKB: 200, maxDimension: 1024 });
      let b64: string;
      try {
        b64 = await urlToBase64(compressed);
      } finally {
        // 压缩函数失败回退时可能原样返回入参 URL，不能误 revoke 图片自身的 URL
        if (compressed !== img.originalUrl && compressed !== img.previewUrl) {
          URL.revokeObjectURL(compressed);
        }
      }

      if (config.grsaiReferenceImages.includes(b64)) {
        // 同内容参考图已存在：只标记图片本身
        updateImage(imageId, i => ({ ...i, isReference: true, referenceBase64: b64 }));
        return;
      }
      const totalLen = config.grsaiReferenceImages.reduce((s, b) => s + b.length, 0) + b64.length;
      if (totalLen > 4_500_000) {
        alert('参考图总大小超过 localStorage 配额（约 4.5MB），未添加。请在设置面板删除部分参考图。');
        return;
      }
      setConfig(prev => ({ ...prev, grsaiReferenceImages: [...prev.grsaiReferenceImages, b64] }));
      updateImage(imageId, i => ({ ...i, isReference: true, referenceBase64: b64 }));
    } catch (e) {
      console.warn('Failed to add reference image:', e);
    } finally {
      referenceToggleInFlight.current.delete(imageId);
    }
  }, [images, setConfig, updateImage, config.grsaiReferenceImages]);

  // 删除图库图片时同步移除其参考图配置条目，避免孤儿引用
  const handleDeleteImageWithReferenceCleanup = useCallback((imageId: string) => {
    const img = images.find(i => i.id === imageId);
    if (img?.referenceBase64) {
      setConfig(prev => {
        const idx = prev.grsaiReferenceImages.indexOf(img.referenceBase64!);
        if (idx < 0) return prev;
        const next = [...prev.grsaiReferenceImages];
        next.splice(idx, 1);
        return { ...prev, grsaiReferenceImages: next };
      });
    }
    handleDeleteImage(imageId);
  }, [images, handleDeleteImage, setConfig]);

  // --- MCP Bridge ---
  // 快照不含 bridgeConnected 字段（已从 BridgeStateSnapshot 类型移除）；
  // 连接状态由桥接 /health 的 appConnected 提供，Agent 经 get_status 读取。
  const bridgeSnapshot = useMemo<BridgeStateSnapshot | null>(() => ({
    processingState,
    selectedImageId,
    images: images.map((img) => ({
      id: img.id,
      name: img.file.name,
      width: img.originalWidth,
      height: img.originalHeight,
      isReference: isEffectiveReference(img, config.grsaiReferenceImages),
      hasResult: !!img.finalResultUrl || img.regions.some((r) => !!r.processedImageUrl),
      regions: img.regions.map((r) => ({
        id: r.id,
        status: r.status,
        x: r.x, y: r.y, width: r.width, height: r.height,
        customPrompt: r.customPrompt ?? null,
        hasResult: !!r.processedImageUrl,
      })),
    })),
    config: {
      provider: config.provider,
      model: config.provider === 'openai' ? config.openaiModel : config.provider === 'grsai' ? config.grsaiModel : config.geminiModel,
      prompt: config.prompt,
      processingMode: config.processingMode,
      referenceCount: config.grsaiReferenceImages.length,
    },
  }), [images, config, processingState, selectedImageId]);

  const bridgeHandlers: BridgeHandlerMap = {
    upload: async ({ files }) => {
      if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'no files in params' };
      try {
        const fileObjs = await Promise.all(files.map(async (f: any) => {
          const blob = await fetch(f.url).then((r) => r.blob());
          return new File([blob], f.name || 'upload.png', { type: blob.type || 'image/png' });
        }));
        const ids = await addImageFiles(fileObjs);
        return { ok: true, result: { ids } };
      } catch (e) {
        return { ok: false, error: (e as Error).message || String(e) };
      }
    },
    select_image: async ({ image_id }) => {
      if (!images.some((i) => i.id === image_id)) return { ok: false, error: `image not found: ${image_id}` };
      handleSelectImage(image_id);
      return { ok: true };
    },
    mark_reference: async ({ image_id }) => {
      const img = images.find((i) => i.id === image_id);
      if (!img) return { ok: false, error: `image not found: ${image_id}` };
      if (isEffectiveReference(img, config.grsaiReferenceImages)) return { ok: true };
      await handleToggleReference(image_id);
      return { ok: true };
    },
    unmark_reference: async ({ image_id }) => {
      const img = images.find((i) => i.id === image_id);
      if (!img) return { ok: false, error: `image not found: ${image_id}` };
      if (!isEffectiveReference(img, config.grsaiReferenceImages)) return { ok: true };
      await handleToggleReference(image_id);
      return { ok: true };
    },
    set_prompt: async ({ prompt, image_id, region_id }) => {
      if (typeof prompt !== 'string' || !prompt) return { ok: false, error: 'prompt is required' };
      if (image_id && region_id) {
        if (!images.some((i) => i.id === image_id)) return { ok: false, error: `image not found: ${image_id}` };
        const img = images.find((i) => i.id === image_id);
        if (!img!.regions.some((r) => r.id === region_id)) return { ok: false, error: `region not found: ${region_id}` };
        handleUpdateRegionPrompt(image_id, region_id, prompt);
      } else if (image_id) {
        if (!images.some((i) => i.id === image_id)) return { ok: false, error: `image not found: ${image_id}` };
        handleUpdateImagePrompt(image_id, prompt);
      } else {
        setConfig((prev) => ({ ...prev, prompt }));
      }
      return { ok: true };
    },
    generate: async ({ scope }) => {
      if (scope !== 'single' && scope !== 'all') return { ok: false, error: "scope must be 'single' or 'all'" };
      handleProcess(scope === 'all');
      return { ok: true };
    },
    get_full_image: async ({ image_id }) => {
      const img = images.find((i) => i.id === image_id);
      if (!img) return { ok: false, error: `image not found: ${image_id}` };
      let url: string | null = null;
      const hasPatches = img.regions.some((r) => r.status === 'completed' && !!r.processedImageUrl);
      if (hasPatches) {
        // 标准区域模式：最终结果是"原图+补丁拼合"，经 getStitchedUrl 按需计算（缓存）
        url = await getStitchedUrl(img);
      } else {
        // 反向遮罩 / 无补丁路径：取已存结果
        url = img.finalResultUrl ?? img.fullAiResultUrl ?? null;
      }
      if (!url) return { ok: false, error: 'no result available yet — run generate first' };
      const dataUrl = await urlToBase64(url);
      const [header, base64] = dataUrl.split(',');
      const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
      return { ok: true, result: { mime, base64, kind: 'full' } };
    },
    get_region_patch: async ({ image_id, region_id }) => {
      const img = images.find((i) => i.id === image_id);
      if (!img) return { ok: false, error: `image not found: ${image_id}` };
      const region = img.regions.find((r) => r.id === region_id);
      if (!region) return { ok: false, error: `region not found: ${region_id}` };
      const url = region.processedImageUrl ?? null;
      if (!url) return { ok: false, error: 'no patch result for this region yet — run generate first' };
      const dataUrl = await urlToBase64(url);
      const [header, base64] = dataUrl.split(',');
      const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
      return { ok: true, result: { mime, base64, kind: 'patch' } };
    },
  };

  const { connected: bridgeConnected } = useBridge({
    enabled: import.meta.env.DEV,
    snapshot: bridgeSnapshot,
    handlers: bridgeHandlers,
  });

  const [isDragging, setIsDragging] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [restoreMode, setRestoreMode] = useState(false);
  const [restoreBrushMode, setRestoreBrushMode] = useState(false);
  const [restoreBrushSize, setRestoreBrushSize] = useState(8);
  const [restoreSelectedRegionId, setRestoreSelectedRegionId] = useState<string | null>(null);
  
  const [transModels, setTransModels] = useState<string[]>([]);
  const [editingRegion, setEditingRegion] = useState<{ 
      imageId: string, 
      regionId: string, 
      startBase64: string,
      initialTextObjects?: TextObject[]
  } | null>(null);
  
  // Debounce Timer Ref for Heavy Operations
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Custom wrapper for manual patch updates to handle Full Image row special case
  const handleManualPatchUpdate = useCallback((imageId: string, regionId: string, imageDataUrl: string) => {
    // imageDataUrl is now typically an Object URL (blob:), but may still be base64 from paste

    if (regionId === 'special-full-image-mask') {
        const targetImg = images.find(img => img.id === imageId);
        if (!targetImg) return;

        // Start processing the update
        (async () => {
            const updatedRegions: Region[] = [];
            
            if (config.useInvertedMasking) {
                for (const r of targetImg.regions) {
                    updatedRegions.push({ ...r, status: 'completed' });
                }
                const stitchedUrl = await stitchImageInverted(targetImg.previewUrl, imageDataUrl, updatedRegions);
                
                updateImage(imageId, img => {
                    const currentHistory = [...img.history];
                    if (currentHistory[img.historyIndex]) {
                       currentHistory[img.historyIndex].fullAiResultUrl = imageDataUrl;
                    }
                    // Release old URLs
                    if (img.fullAiResultUrl) releaseObjectURL(img.fullAiResultUrl);
                    if (img.finalResultUrl) releaseObjectURL(img.finalResultUrl);

                    return {
                        ...img,
                        fullAiResultUrl: imageDataUrl,
                        finalResultUrl: stitchedUrl,
                        regions: updatedRegions,
                        originalUrl: img.originalUrl,
                        history: currentHistory
                    };
                });
            } else {
                for (const r of targetImg.regions) {
                    try {
                        const crop = await extractCropFromFullImage(
                            imageDataUrl, 
                            r, 
                            targetImg.originalWidth, 
                            targetImg.originalHeight,
                            config.fullImageOpaquePercent
                        );
                        updatedRegions.push({ ...r, processedImageUrl: crop, status: 'completed', anchorX: r.x, anchorY: r.y, anchorWidth: r.width, anchorHeight: r.height });
                    } catch (e) {
                        console.error("Failed to extract crop for region", r.id, e);
                        updatedRegions.push({ ...r, status: 'failed' });
                    }
                }
                
                updateImage(imageId, img => {
                    const currentHistory = [...img.history];
                    if (currentHistory[img.historyIndex]) {
                       currentHistory[img.historyIndex].fullAiResultUrl = imageDataUrl;
                    }
                    if (img.fullAiResultUrl) releaseObjectURL(img.fullAiResultUrl);

                    return {
                        ...img,
                        fullAiResultUrl: imageDataUrl,
                        regions: updatedRegions,
                        originalUrl: img.originalUrl,
                        history: currentHistory
                    };
                });
            }
        })();
        return;
    }

    updateImage(imageId, img => {
        let updatedRegions: Region[];

        // Legacy/Alternative Manual Full Image as a new region (fallback)
        if (regionId === 'manual-full-image') {
            const fullRegion: Region = {
                id: crypto.randomUUID(),
                x: 0, y: 0, width: 100, height: 100,
                type: 'rect',
                status: 'completed',
                processedImageUrl: imageDataUrl,
                source: 'manual' as const,
                anchorX: 0, anchorY: 0, anchorWidth: 100, anchorHeight: 100,
            };
           updatedRegions = [...img.regions, fullRegion];
        } else {
           // Release old region URL before replacing
           const oldRegion = img.regions.find(r => r.id === regionId);
           if (oldRegion?.processedImageUrl) releaseObjectURL(oldRegion.processedImageUrl);

           updatedRegions = img.regions.map(r =>
              r.id === regionId ? { ...r, processedImageUrl: imageDataUrl, status: 'completed' as const, anchorX: r.x, anchorY: r.y, anchorWidth: r.width, anchorHeight: r.height } : r
           );
        }

        const currentHistory = [...img.history];
        if (currentHistory[img.historyIndex]) {
            currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: updatedRegions };
        }

        return { ...img, regions: updatedRegions, history: currentHistory };
    });
  }, [images, config.useInvertedMasking, config.fullImageOpaquePercent, updateImage]);

  // --- Interaction Start Handler (Called by EditorCanvas on mousedown) ---
  const handleInteractionStart = useCallback(() => {
      // Cancel any pending debounce timer
      if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
      }
  }, []);

  // --- Regions Update Handler ---
  // Green frame resize/move no longer re-crops processedImageUrl.
  // The processed image stays at its anchor size; the green frame acts as a viewport window.
  const onRegionsChanged = useCallback((imageId: string, newRegions: Region[]) => {
      handleUpdateRegions(imageId, newRegions);

      if (config.useInvertedMasking) {
          const targetImage = images.find(img => img.id === imageId);
          if (targetImage && targetImage.fullAiResultUrl) {
              if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
              debounceTimerRef.current = setTimeout(async () => {
                  const stitchedUrl = await stitchImageInverted(targetImage.previewUrl, targetImage.fullAiResultUrl!, newRegions);
                  updateImage(imageId, img => ({ ...img, finalResultUrl: stitchedUrl }));
              }, 200);
          }
          return;
      }
  }, [handleUpdateRegions, config.useInvertedMasking, images, updateImage]);

  // --- Handlers ---
  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Materialize the file list into a plain array BEFORE resetting input.value.
    // input.files is a live view: clearing value empties a captured FileList
    // reference, which silently skipped the upload entirely.
    const inputFiles = e.target.files;
    const files = inputFiles ? Array.from<File>(inputFiles) : [];
    // Reset value first so re-selecting the same file(s) still fires onChange.
    e.target.value = '';
    if (files.length > 0) {
      await addImageFiles(files);
    }
  }, [addImageFiles]);

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                const file = items[i].getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length > 0) {
            e.preventDefault();
            await addImageFiles(files);
        }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [addImageFiles]); 

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.matches('input, textarea') || target.isContentEditable) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            if (images.length === 0) return;
            const currentIndex = images.findIndex(img => img.id === selectedImageId);
            let newIndex = currentIndex;
            if (currentIndex === -1) {
                newIndex = 0;
            } else {
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                    newIndex = Math.max(0, currentIndex - 1);
                } else {
                    newIndex = Math.min(images.length - 1, currentIndex + 1);
                }
            }
            if (newIndex !== currentIndex) {
                handleSelectImage(images[newIndex].id);
            }
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [images, selectedImageId, handleSelectImage]);

  const handleOpenEditor = useCallback(async (imageId: string, regionId: string) => {
      const img = images.find(i => i.id === imageId);
      if (!img) return;

      if (regionId === 'manual-full-image') {
          const textObjects: TextObject[] = img.regions.map((r, index) => {
             const boxH = (r.height / 100) * img.originalHeight;
             const fontSize = Math.max(14, Math.round(boxH * 0.3));
             const width = (r.width / 100) * img.originalWidth;
             const height = (r.height / 100) * img.originalHeight;
             return {
                 id: r.id,
                 x: (r.x / 100) * img.originalWidth,
                 y: (r.y / 100) * img.originalHeight,
                 width: width,
                 height: height,
                 text: r.ocrText || `Text ${index + 1}`,
                 fontSize: fontSize,
                 color: '#000000',
                 outlineColor: '#ffffff',
                 outlineWidth: 3,
                 backgroundColor: 'transparent',
                 isVertical: r.height > r.width * 1.5,
                 isBold: true,
                 rotation: 0
             };
          });
          setEditingRegion({
              imageId,
              regionId,
              startBase64: img.finalResultUrl || img.previewUrl,
              initialTextObjects: textObjects
          });
          return;
      }

      const region = img.regions.find(r => r.id === regionId);
      if (!region) return;
      let startBase64 = region.processedImageUrl;
      if (!startBase64) {
         const imgEl = await loadImage(img.previewUrl);
         startBase64 = await cropRegion(imgEl, region);
      }
      let singleTextObj: TextObject[] | undefined = undefined;
      if (region.ocrText) {
          singleTextObj = [{
             id: crypto.randomUUID(),
             x: 10, y: 10,
             text: region.ocrText,
             fontSize: 24,
             color: '#000000',
             outlineColor: '#ffffff',
             outlineWidth: 3,
             backgroundColor: 'transparent',
             isVertical: region.height > region.width * 1.5,
             isBold: true,
             rotation: 0
          }];
      }
      setEditingRegion({ imageId, regionId, startBase64, initialTextObjects: singleTextObj });
  }, [images]);

  const handleEditorSave = useCallback((newBase64: string) => {
      if (editingRegion) {
          handleManualPatchUpdate(editingRegion.imageId, editingRegion.regionId, newBase64);
      }
      setEditingRegion(null);
  }, [editingRegion, handleManualPatchUpdate]);

  const handleOcrRegion = useCallback(async (imageId: string, regionId: string) => {
     const img = images.find(i => i.id === imageId);
     const region = img?.regions.find(r => r.id === regionId);
     if (!img || !region) return;
     updateImage(imageId, currentImg => ({
         ...currentImg,
         regions: currentImg.regions.map(r => r.id === regionId ? { ...r, isOcrLoading: true } : r)
     }));
     try {
         const imgEl = await loadImage(img.previewUrl);
         const cropUrl = await cropRegion(imgEl, region);
         const text = await recognizeText(cropUrl, config);
         // Release the temporary crop URL after OCR is done
         releaseObjectURL(cropUrl);
         updateImage(imageId, currentImg => ({
             ...currentImg,
             regions: currentImg.regions.map(r => r.id === regionId ? { ...r, ocrText: text, isOcrLoading: false } : r)
         }));
     } catch (e: any) {
         setErrorMsg("OCR Error: " + e.message);
         updateImage(imageId, currentImg => ({
             ...currentImg,
             regions: currentImg.regions.map(r => r.id === regionId ? { ...r, isOcrLoading: false } : r)
         }));
     }
  }, [images, config, updateImage, setErrorMsg]);

  // --- RESTORE BOXES HANDLER ---
  const handleUpdateRestoreBoxes = useCallback((regionId: string, boxes: RestoreBox[]) => {
      updateAllImages(img => ({
          ...img,
          regions: img.regions.map(r => r.id === regionId ? { ...r, restoreBoxes: boxes } : r)
      }));
  }, [updateAllImages]);

  const handleUpdateRestoreMask = useCallback((regionId: string, maskBase64: string | null) => {
      updateAllImages(img => ({
          ...img,
          regions: img.regions.map(r => r.id === regionId ? { ...r, restoreMaskUrl: maskBase64 || undefined } : r)
      }));
  }, [updateAllImages]);

  // ON-DEMAND STITCHING for Download
  const handleDownload = useCallback(async () => {
      if (!selectedImage) return;
      try {
          let stitchedUrl: string;
          let isCached = false;
          if (config.useInvertedMasking && selectedImage.fullAiResultUrl) {
              stitchedUrl = await stitchImageInverted(selectedImage.previewUrl, selectedImage.fullAiResultUrl, selectedImage.regions);
          } else {
              stitchedUrl = await getStitchedUrl(selectedImage);
              isCached = true;
          }
          const link = document.createElement('a');
          link.href = stitchedUrl;
          link.download = selectedImage.file.name.replace(/\.[^.]+$/, '') + '.png';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          // Only release if we created the URL here; cached URLs are owned by useImageManager.
          if (!isCached) releaseObjectURL(stitchedUrl);
      } catch (e) {
          console.error("Failed to stitch for download", e);
          setErrorMsg("Failed to generate download image.");
      }
  }, [selectedImage, config.useInvertedMasking, getStitchedUrl, setErrorMsg]);

  // ON-DEMAND STITCHING for Apply
  const handleApplyAsOriginalWrapper = useCallback(async () => {
      if (!selectedImage) return;
      try {
          let stitchedUrl: string;
          if (config.useInvertedMasking && selectedImage.fullAiResultUrl) {
              stitchedUrl = await stitchImageInverted(selectedImage.previewUrl, selectedImage.fullAiResultUrl, selectedImage.regions);
          } else {
              stitchedUrl = await stitchImage(selectedImage.previewUrl, selectedImage.regions);
          }
          handleApplyResultAsOriginal(selectedImage.id, stitchedUrl);
      } catch (e) {
          console.error("Failed to stitch for apply", e);
          setErrorMsg("Failed to apply changes.");
      }
  }, [selectedImage, config.useInvertedMasking, handleApplyResultAsOriginal, setErrorMsg]);

  // 选区编辑：水平翻转选区内容。有补丁→翻转补丁；无补丁→裁原图翻转成手动补丁。
  const handleFlipRegion = useCallback(async (imageId: string, regionId: string) => {
    const img = images.find((i) => i.id === imageId);
    if (!img) return;
    const region = img.regions.find((r) => r.id === regionId);
    if (!region) return;
    let cropUrl: string | null = null;
    try {
      let sourceUrl: string;
      if (region.processedImageUrl) {
        sourceUrl = region.processedImageUrl;
      } else {
        const imgEl = await loadImage(img.originalUrl || img.previewUrl);
        cropUrl = await cropRegion(imgEl, region);
        sourceUrl = cropUrl;
      }
      const flippedUrl = await flipImageHorizontal(sourceUrl);
      if (cropUrl) releaseObjectURL(cropUrl);
      if (region.processedImageUrl && region.processedImageUrl !== flippedUrl) {
        releaseObjectURL(region.processedImageUrl);
      }
      updateImage(imageId, (prev) => ({
        ...prev,
        regions: prev.regions.map((r) => r.id === regionId ? {
          ...r,
          processedImageUrl: flippedUrl,
          status: 'completed' as const,
          anchorX: r.x, anchorY: r.y, anchorWidth: r.width, anchorHeight: r.height,
          restoreBoxes: undefined,
          restoreMaskUrl: undefined,
        } : r),
      }));
    } catch (e) {
      if (cropUrl) releaseObjectURL(cropUrl);
      console.error('Failed to flip region', e);
      setErrorMsg('Failed to flip region.');
    }
  }, [images, updateImage, setErrorMsg]);

  // --- REFINEMENT HANDLER (Scroll to adjust box) ---
  const handleAdjustRegion = useCallback(async (imageId: string, regionId: string, isExpand: boolean) => {
      const img = images.find(i => i.id === imageId);
      if (!img) return;
      
      const region = img.regions.find(r => r.id === regionId);
      if (!region || region.status !== 'completed') return;

      const step = 1.0; 
      const direction = isExpand ? 1 : -1;
      
      let newX = region.x - (step * direction);
      let newY = region.y - (step * direction);
      let newW = region.width + (step * 2 * direction);
      let newH = region.height + (step * 2 * direction);

      if (newW < 1) return;
      if (newH < 1) return;
      if (newX < 0) { newW += newX; newX = 0; }
      if (newY < 0) { newH += newY; newY = 0; }
      if (newX + newW > 100) newW = 100 - newX;
      if (newY + newH > 100) newH = 100 - newY;

      const updatedRegions = img.regions.map(r => 
        r.id === regionId 
          ? { ...r, x: newX, y: newY, width: newW, height: newH } 
          : r
      );
      handleUpdateRegions(imageId, updatedRegions);

      // Inverted Mode Refinement (requires fullAiResultUrl)
      if (config.useInvertedMasking && img.fullAiResultUrl) {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = setTimeout(async () => {
              const stitchedUrl = await stitchImageInverted(img.previewUrl, img.fullAiResultUrl!, updatedRegions);
              updateImage(imageId, i => ({ ...i, finalResultUrl: stitchedUrl }));
          }, 200);
      }
  }, [images, config.useInvertedMasking, handleUpdateRegions, updateImage]);

  // --- DRAG & DROP ---
  const onDragEnter = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
       await addImageFiles(Array.from(e.dataTransfer.files));
    }
  };

  const updateConfig = useCallback((key: keyof AppConfig, value: any) => {
      setConfig(prev => ({ ...prev, [key]: value }));
  }, [setConfig]);

  const fetchTransModels = useCallback(async () => {
      if (!config.translationBaseUrl || !config.translationApiKey) return;
      try {
          const models = await fetchOpenAIModels(config.translationBaseUrl, config.translationApiKey);
          setTransModels(models);
      } catch(e) { console.error(e); }
  }, [config.translationBaseUrl, config.translationApiKey]);

  // Stable adapters for EditorCanvas — bind selectedImage.id so the child only sees a regionId arg.
  const selectedImageId_safe = selectedImage?.id;
  const editorOnUpdateRegions = onRegionsChanged;
  const editorOnOpenEditor = useCallback((regionId: string) => {
      if (selectedImageId_safe) handleOpenEditor(selectedImageId_safe, regionId);
  }, [selectedImageId_safe, handleOpenEditor]);
  const editorOnOcrRegion = useCallback((regionId: string) => {
      if (selectedImageId_safe) handleOcrRegion(selectedImageId_safe, regionId);
  }, [selectedImageId_safe, handleOcrRegion]);
  const editorOnAdjustRegionSize = useCallback((regionId: string, isExpand: boolean) => {
      if (selectedImageId_safe) handleAdjustRegion(selectedImageId_safe, regionId, isExpand);
  }, [selectedImageId_safe, handleAdjustRegion]);

  // Stable adapters for Sidebar.
  const sidebarOnOpenGlobalSettings = useCallback(() => setShowGlobalSettings(true), []);
  const sidebarOnOpenHelp = useCallback(() => setShowHelp(true), []);

  const showEditor = config.enableMangaMode && config.enableManualEditor;

  return (
    <div 
      className="flex h-screen w-screen bg-skin-fill text-skin-text overflow-hidden font-sans relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Sidebar
        config={config}
        setConfig={setConfig}
        images={images}
        selectedImageId={selectedImageId}
        selectedRegionId={selectedRegionId}
        onSelectImage={handleSelectImage}
        onUpload={handleUpload}
        onProcess={handleProcess}
        onStop={handleStop}
        processingState={processingState}
        currentImage={selectedImage}
        onDownload={handleDownload}
        onManualPatchUpdate={handleManualPatchUpdate}
        onUpdateRegionPrompt={handleUpdateRegionPrompt}
        onUpdateImagePrompt={handleUpdateImagePrompt}
        onDeleteImage={handleDeleteImageWithReferenceCleanup}
        onClearAllImages={handleClearAllImages} 
        onToggleSkip={handleToggleSkip}
        onToggleReference={handleToggleReference}
        onAutoDetect={handleAutoDetect}
        isDetecting={isDetecting}
        onOpenEditor={handleOpenEditor}
        onOcrRegion={handleOcrRegion}
        onOpenGlobalSettings={sidebarOnOpenGlobalSettings}
        onOpenHelp={sidebarOnOpenHelp}
        showEditor={showEditor}
        onApplyAsOriginal={handleApplyAsOriginalWrapper}
        uploadProgress={uploadProgress}
        bridgeConnected={bridgeConnected}
        getStitchedUrl={getStitchedUrl}
      />
      
      <main className="flex-1 relative bg-checkerboard flex flex-col">
        {selectedImage ? (
           <>
             <div className="absolute top-4 left-4 z-10 flex gap-2">
                 <button 
                   onClick={() => setViewMode('original')}
                   className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'original' ? 'bg-skin-primary text-skin-primary-fg border-skin-primary' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                 >
                   {t(config.language, 'readyToCreate')}
                 </button>
                  {(selectedImage.regions.some(r => r.status === 'completed') || selectedImage.isSkipped || selectedImage.finalResultUrl) && (
                     <button 
                         onClick={() => { setViewMode('result'); setRestoreMode(false); }}
                         className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'result' && !restoreMode ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                     >
                         {t(config.language, 'status_completed')}
                     </button>
                  )}
                  {viewMode === 'result' && selectedImage.regions.some(r => r.status === 'completed') && (
                     <button 
                         onClick={() => { setRestoreMode(!restoreMode); setRestoreBrushMode(false); setRestoreSelectedRegionId(null); }}
                         className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${restoreMode ? 'bg-amber-500 text-white border-amber-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                     >
                         {restoreMode ? '退出还原' : '🔧 框选还原'}
                     </button>
                  )}
                  {/* Restore toolbar - only when restore mode is active */}
                  {restoreMode && (
                    <div className="flex gap-1 items-center">
                      <button
                        onClick={() => setRestoreBrushMode(false)}
                        className={`px-2 py-1 text-[10px] font-bold rounded border ${!restoreBrushMode ? 'bg-amber-500 text-white border-amber-500' : 'bg-black/60 text-amber-400 border-amber-400/50 hover:border-amber-400'}`}
                      >□ 框选</button>
                      <button
                        onClick={() => setRestoreBrushMode(true)}
                        className={`px-2 py-1 text-[10px] font-bold rounded border ${restoreBrushMode ? 'bg-amber-500 text-white border-amber-500' : 'bg-black/60 text-amber-400 border-amber-400/50 hover:border-amber-400'}`}
                      >🖌 涂抹</button>
                      {restoreBrushMode && (
                        <>
                          <span className="text-[9px] text-white/70 ml-1">大小</span>
                          <input type="range" min="1" max="20" step="0.5" value={restoreBrushSize}
                            onChange={(e) => setRestoreBrushSize(Number(e.target.value))}
                            className="w-10 h-1 accent-amber-400" />
                          <span className="text-[9px] text-white/60 w-4">{restoreBrushSize}</span>
                        </>
                      )}
                      <button
                        onClick={() => {
                          if (!restoreSelectedRegionId || !selectedImage) return;
                          updateImage(selectedImage.id, img => ({
                              ...img,
                              regions: img.regions.map(r => {
                                if (r.id !== restoreSelectedRegionId) return r;
                                return { ...r, restoreBoxes: undefined, restoreMaskUrl: undefined };
                              })
                          }));
                        }}
                        className="px-2 py-1 text-[10px] font-bold bg-rose-500/80 text-white rounded border border-rose-500 hover:bg-rose-500 disabled:opacity-30"
                        disabled={!restoreSelectedRegionId}
                      >清除</button>
                    </div>
                  )}
                 {selectedImage.isSkipped && (
                     <span className="px-3 py-1.5 rounded-full text-xs font-bold bg-zinc-500 text-white border border-zinc-500 backdrop-blur-md shadow-sm">
                        {t(config.language, 'skipped')}
                     </span>
                 )}

                 <div className="flex gap-1 ml-2 border-l border-white/20 pl-2">
                    <button
                        onClick={() => handleUndoImage(selectedImage.id)}
                        disabled={selectedImage.historyIndex <= 0}
                        className="px-2 py-1.5 rounded-full bg-skin-surface/80 hover:bg-white text-skin-text disabled:opacity-40 disabled:hover:bg-skin-surface/80 border border-skin-border backdrop-blur-md shadow-sm transition-all"
                        title={t(config.language, 'undoImage')}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
                    </button>
                    <button
                        onClick={() => handleRedoImage(selectedImage.id)}
                        disabled={selectedImage.historyIndex >= selectedImage.history.length - 1}
                        className="px-2 py-1.5 rounded-full bg-skin-surface/80 hover:bg-white text-skin-text disabled:opacity-40 disabled:hover:bg-skin-surface/80 border border-skin-border backdrop-blur-md shadow-sm transition-all"
                        title={t(config.language, 'redoImage')}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6"></path></svg>
                    </button>
                 </div>
             </div>

             {viewMode === 'result' && config.useInvertedMasking && selectedImage.finalResultUrl ? (
                 // Special Render for Inverted Mode Result: Just the full stitched image
                 <div className="w-full h-full flex items-center justify-center p-8 overflow-hidden select-none">
                    <div className="relative shadow-xl">
                        <img 
                            src={selectedImage.finalResultUrl} 
                            className="max-h-[85vh] max-w-full block object-contain pointer-events-none rounded bg-skin-surface shadow-sm ring-1 ring-skin-border"
                            alt="Result"
                        />
                    </div>
                 </div>
              ) : (
                  // Standard Mode (Original & Result using EditorCanvas) or Inverted Mode Original
                  <EditorCanvas
                    key={selectedImage.id}
                    image={selectedImage}
                    onUpdateRegions={editorOnUpdateRegions}
                    disabled={processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE}
                    language={config.language}
                    onOpenEditor={editorOnOpenEditor}
                    selectedRegionId={selectedRegionId}
                    onSelectRegion={setSelectedRegionId}
                    onOcrRegion={editorOnOcrRegion}
                    showOcrButton={config.enableMangaMode && config.enableOCR}
                    showEditorButton={showEditor}
                    onAdjustRegionSize={editorOnAdjustRegionSize}
                    onFlipRegion={(regionId) => handleFlipRegion(selectedImage.id, regionId)}
                    onInteractionStart={handleInteractionStart}
                    viewMode={viewMode}
                    restoreMode={restoreMode}
                    onUpdateRestoreBoxes={restoreMode ? handleUpdateRestoreBoxes : undefined}
                    onUpdateRestoreMask={restoreMode ? handleUpdateRestoreMask : undefined}
                    restoreBrushMode={restoreBrushMode}
                    restoreBrushSize={restoreBrushSize}
                    restoreSelectedRegionId={restoreSelectedRegionId}
                    onSelectRestoreRegion={setRestoreSelectedRegionId}
                />
              )}
            </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-skin-muted select-none">
            <div className="w-24 h-24 mb-4 rounded-3xl bg-skin-surface border-2 border-dashed border-skin-border flex items-center justify-center animate-pulse">
                <svg className="w-10 h-10 text-skin-border" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
            </div>
            <p className="text-lg font-medium">{t(config.language, 'readyToCreate')}</p>
            <p className="text-sm opacity-60">{t(config.language, 'uploadHint')}</p>
          </div>
        )}

        {errorMsg && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-rose-500 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-4 flex items-center gap-2 z-50">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                {errorMsg}
                <button onClick={() => setErrorMsg(null)} className="ml-2 opacity-80 hover:opacity-100">✕</button>
            </div>
        )}
      </main>
      
      {editingRegion && (
         <Suspense fallback={null}>
            <PatchEditor
                imageBase64={editingRegion.startBase64}
                onSave={handleEditorSave}
                onCancel={() => setEditingRegion(null)}
                language={config.language}
                initialTextObjects={editingRegion.initialTextObjects}
                defaultVertical={config.enableVerticalTextDefault}
            />
         </Suspense>
      )}

      {showGlobalSettings && (
        <Suspense fallback={null}>
          <GlobalSettings
            config={config}
            setConfig={setConfig}
            updateConfig={updateConfig}
            transModels={transModels}
            setTransModels={setTransModels}
            fetchTransModels={fetchTransModels}
            onClose={() => setShowGlobalSettings(false)}
          />
        </Suspense>
      )}
      {showHelp && (
          <Suspense fallback={null}>
              <HelpModal onClose={() => setShowHelp(false)} language={config.language} />
          </Suspense>
      )}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-skin-fill/80 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-200 pointer-events-none">
           <div className="w-[80%] h-[80%] border-4 border-dashed border-skin-primary rounded-3xl flex flex-col items-center justify-center text-skin-primary">
              <svg className="w-24 h-24 mb-4 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
              <h2 className="text-3xl font-bold">{t(config.language, 'dropToUpload')}</h2>
           </div>
        </div>
      )}
    </div>
  );
}
