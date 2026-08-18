
import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { UploadedImage, Region, Language, RestoreBox, ThemeType, SketchStroke } from '../types';
import { t } from '../services/translations';
import { useCanvasInteraction } from '../hooks/useCanvasInteraction';
import { usePanelSnap } from '../hooks/usePanelSnap';
import { renderRegionWithRestore, loadImage, releaseObjectURL, compositeSketchStrokes } from '../services/imageUtils';

// Helper: convert a canvas to a Blob-backed Object URL (memory-efficient,
// avoids the giant base64 string that toDataURL produces).
const canvasToObjectURL = (canvas: HTMLCanvasElement, type: string = 'image/png'): Promise<string> => {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(URL.createObjectURL(blob));
            else reject(new Error('canvas.toBlob returned null'));
        }, type);
    });
};

interface EditorCanvasProps {
  image: UploadedImage;
  onUpdateRegions: (imageId: string, regions: Region[]) => void;
  disabled?: boolean;
  language: Language;
  onOpenEditor: (regionId: string) => void;
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string | null) => void;
  onOcrRegion?: (regionId: string) => void;
  onFlipRegion?: (regionId: string) => void;
  onApplyRegionAsOriginal?: (imageId: string, regionId: string) => void;
  onRemoveRegionWithIopaint?: (imageId: string, regionId: string) => void;
  /** Brush-style IOPaint removal: paint free-form on the whole image, then execute. */
  removeBrushMode?: boolean;
  removeBrushSize?: number;
  theme?: ThemeType;
  onExecuteRemoveBrush?: (payload: { maskDataUrl: string; bbox: { x: number; y: number; width: number; height: number } }) => void;
  onClearRemoveBrush?: () => void;
  onExitRemoveBrush?: () => void;
  showOcrButton?: boolean;
  showEditorButton?: boolean;
  onAdjustRegionSize?: (regionId: string, isExpand: boolean) => void;
  onInteractionStart?: () => void;
  viewMode?: 'original' | 'result';
  restoreMode?: boolean;
  onUpdateRestoreBoxes?: (regionId: string, boxes: RestoreBox[]) => void;
  onUpdateRestoreMask?: (regionId: string, maskBase64: string | null) => void;
  restoreBrushMode?: boolean;
  restoreBrushSize?: number;
  restoreSelectedRegionId?: string | null;
  onSelectRestoreRegion?: (regionId: string | null) => void;
  /** Sketch brush: AI-visible guidance strokes on the whole image. */
  brushMode?: boolean;
  brushColor?: string;
  brushSize?: number;
  brushEraser?: boolean;
  onUpdateSketchStrokes?: (imageId: string, strokes: SketchStroke[]) => void;
  onClearSketchStrokes?: () => void;
  /** When enabled, a drawn region's edges snap to the nearest panel border on mouse-up. */
  enablePanelSnap?: boolean;
}

/**
 * NEW ARCHITECTURE: Pure transform-based zoom & pan
 *
 * Old approach (BROKEN):
 *   viewport(overflow:auto) > centering-wrapper(flex center) > sizing-div(w*zoom,h*zoom) > content-div(transform:scale)
 *   Problems: ResizeObserver resets zoom, flex centering misaligns scroll coords, scroll+transform conflict
 *
 * New approach:
 *   viewport(overflow:hidden) > content-div(transform: translate + scale)
 *   - No scroll container, no flex centering, no sizing wrapper
 *   - Zoom & pan are a single CSS transform on the content div
 *   - Pan via mouse drag (middle button, Alt+left, or Space+left)
 *   - Zoom via Ctrl+Wheel, zooming towards cursor
 *   - ResizeObserver only resets zoom on actual viewport resize, not on zoom changes
 *   - Coordinate calculation uses the content div's getBoundingClientRect which is always correct
 */

const EditorCanvas: React.FC<EditorCanvasProps> = React.memo(({
    image,
    onUpdateRegions,
    disabled = false,
    language,
    onOpenEditor,
    selectedRegionId,
    onSelectRegion,
    onOcrRegion,
    onFlipRegion,
    onApplyRegionAsOriginal,
    onRemoveRegionWithIopaint,
    removeBrushMode = false,
    removeBrushSize = 8,
    theme = 'light',
    onExecuteRemoveBrush,
    onClearRemoveBrush,
    onExitRemoveBrush,
    showOcrButton = false,
    showEditorButton = false,
    onAdjustRegionSize,
    onInteractionStart,
    viewMode = 'original',
    restoreMode = false,
    onUpdateRestoreBoxes,
    onUpdateRestoreMask,
    restoreBrushMode = false,
    restoreBrushSize = 8,
    restoreSelectedRegionId = null,
    onSelectRestoreRegion,
    brushMode = false,
    brushColor = '#ff3b30',
    brushSize = 2,
    brushEraser = false,
    onUpdateSketchStrokes,
    onClearSketchStrokes,
    enablePanelSnap = true,
}) => {
  // --- Refs ---
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRegionRef = useRef<HTMLDivElement>(null);

  // --- Zoom & Pan State ---
  // zoom: scale factor (1 = fit-to-screen, >1 = zoomed in)
  // panX/panY: offset in screen pixels from the "centered" position
  const [zoom, setZoom] = useState(0.01); // Start tiny to avoid flash of oversized image
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);

  // Track whether the initial fit-to-screen has been applied
  const [isZoomReady, setIsZoomReady] = useState(false);

  // Viewport dimensions as state (so transform re-renders when viewport resizes)
  const [vpW, setVpW] = useState(0);
  const [vpH, setVpH] = useState(0);

  // Track whether user has manually changed zoom (to prevent ResizeObserver from resetting it)
  const userZoomedRef = useRef(false);

  // --- Pan interaction refs ---
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  const spaceHeldRef = useRef(false);

  // --- Fit-to-screen calculation ---
  // Subtract padding so the fitted image is slightly smaller than the viewport,
  // leaving room for region action buttons (toolbar) to be visible even when
  // a region sits at the image edge.
  const FIT_PADDING = 80; // px — enough for toolbar buttons (24px) + gap (12px)
  const calculateFitZoom = useCallback(() => {
    if (!viewportRef.current || !image.originalWidth) return 1;
    const vw = viewportRef.current.clientWidth - FIT_PADDING;
    const vh = viewportRef.current.clientHeight - FIT_PADDING;
    if (vw <= 0 || vh <= 0) return 1;
    // fit zoom: scale image to fit within viewport (minus padding), but never exceed 1
    return Math.min(vw / image.originalWidth, vh / image.originalHeight, 1);
  }, [image.originalWidth, image.originalHeight]);

  // Initialize: fit to screen and center
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const fit = calculateFitZoom();
        setZoom(fit);
        setPanX(0);
        setPanY(0);
        userZoomedRef.current = false;
        setIsZoomReady(true);
      });
    });
  }, [calculateFitZoom]);

  // ResizeObserver: track viewport size, only reset zoom on genuine resize when user hasn't manually zoomed
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const w = viewport.clientWidth;
      const h = viewport.clientHeight;
      setVpW(w);
      setVpH(h);
      if (!userZoomedRef.current) {
        const fit = calculateFitZoom();
        setZoom(fit);
        setPanX(0);
        setPanY(0);
      }
      // If user has manually zoomed, we respect their zoom/pan. They can click "fit" to reset.
    });
    // Record initial size
    setVpW(viewport.clientWidth);
    setVpH(viewport.clientHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [calculateFitZoom]);

  // --- Zoom handlers ---
  const handleZoomIn = useCallback(() => {
    userZoomedRef.current = true;
    setZoom(z => Math.min(z * 1.25, 10));
  }, []);

  const handleZoomOut = useCallback(() => {
    userZoomedRef.current = true;
    setZoom(z => Math.max(z / 1.25, 0.1));
  }, []);

  const handleZoomReset = useCallback(() => {
    userZoomedRef.current = false;
    const fit = calculateFitZoom();
    setZoom(fit);
    setPanX(0);
    setPanY(0);
  }, [calculateFitZoom]);

  // --- Ctrl+Wheel zoom (zoom towards cursor) ---
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || restoreMode) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        const delta = -e.deltaY;
        const factor = delta > 0 ? 1.1 : 1 / 1.1;

        // Mouse position relative to viewport
        const rect = viewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // We need to compute the adjustment so the image point under the cursor stays fixed.
        // Use functional updates to get the latest state.
        setZoom(prevZoom => {
          const newZoom = Math.max(0.1, Math.min(10, prevZoom * factor));

          // The offset of the image's top-left corner from the viewport's top-left:
          //   offsetX = (vpW - imgW * zoom) / 2 + panX
          //   offsetY = (vpH - imgH * zoom) / 2 + panY
          // The image point under cursor: (mouseX - offsetX) / zoom  (in image pixels)
          // After zoom change, we want same image point under cursor:
          //   mouseX = newOffsetX + imgPointX * newZoom
          //   newOffsetX = mouseX - imgPointX * newZoom
          //             = mouseX - (mouseX - offsetX) / prevZoom * newZoom
          //   newPanX = newOffsetX - (vpW - imgW * newZoom) / 2

          const imgW = image.originalWidth || 800;
          const imgH = image.originalHeight || 600;

          // We need current panX/panY — read from refs to avoid stale closure
          // But since setZoom and setPanX are batched, we can use a ref for pan.
          // Actually, let's use the zoom effect handler with a layout effect instead.
          // Simpler: store the mouse position and adjust pan in a layout effect.

          // Store info for the layout effect to adjust pan:
          wheelAdjustRef.current = {
            mouseX, mouseY, prevZoom, newZoom, imgW, imgH, vpW: rect.width, vpH: rect.height
          };

          return newZoom;
        });

        userZoomedRef.current = true;
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [restoreMode, image.originalWidth, image.originalHeight]);

  // Ref for wheel zoom adjustment data
  const wheelAdjustRef = useRef<{
    mouseX: number; mouseY: number; prevZoom: number; newZoom: number;
    imgW: number; imgH: number; vpW: number; vpH: number;
  } | null>(null);

  // After zoom changes (from wheel), adjust pan to keep cursor point fixed
  useLayoutEffect(() => {
    const adj = wheelAdjustRef.current;
    if (!adj) return;
    wheelAdjustRef.current = null;

    const { mouseX, mouseY, prevZoom, newZoom, imgW, imgH, vpW, vpH } = adj;

    setPanX(prevPanX => {
      const oldOffsetX = (vpW - imgW * prevZoom) / 2 + prevPanX;
      const newOffsetX = mouseX - (mouseX - oldOffsetX) * (newZoom / prevZoom);
      return newOffsetX - (vpW - imgW * newZoom) / 2;
    });
    setPanY(prevPanY => {
      const oldOffsetY = (vpH - imgH * prevZoom) / 2 + prevPanY;
      const newOffsetY = mouseY - (mouseY - oldOffsetY) * (newZoom / prevZoom);
      return newOffsetY - (vpH - imgH * newZoom) / 2;
    });
  }, [zoom]);

  // --- Pan: middle-mouse, Alt+Left, Space+Left ---
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && spaceHeldRef.current)) {
        e.preventDefault();
        // Use currentPanRef to get latest pan values (avoids stale closure)
        panStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panX: currentPanRef.current.x, panY: currentPanRef.current.y };
        isPanningRef.current = true;
        viewport.style.cursor = 'grabbing';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.mouseX;
      const dy = e.clientY - panStartRef.current.mouseY;
      setPanX(panStartRef.current.panX + dx);
      setPanY(panStartRef.current.panY + dy);
    };

    const handleMouseUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        viewport.style.cursor = spaceHeldRef.current ? 'grab' : '';
      }
    };

    viewport.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      viewport.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Ref to keep current pan values in sync for the pan mousedown handler
  const currentPanRef = useRef({ x: 0, y: 0 });
  currentPanRef.current = { x: panX, y: panY };

  // --- Space key for pan mode ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        // Don't capture space if user is in an input
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
        spaceHeldRef.current = true;
        if (viewportRef.current) viewportRef.current.style.cursor = 'grab';
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        if (viewportRef.current && !isPanningRef.current) viewportRef.current.style.cursor = '';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // --- Panel snap: auto-snap drawn regions to nearby panel borders ---
  const { snapRect } = usePanelSnap(image, enablePanelSnap);

  // --- Interaction hook ---
  const {
      interaction,
      handleBackgroundMouseDown,
      handleRegionMouseDown,
      handleResizeMouseDown
  } = useCanvasInteraction(
      containerRef,
      image,
      onUpdateRegions,
      onSelectRegion,
      onInteractionStart,
      viewMode as 'original' | 'result',
      disabled,
      enablePanelSnap ? snapRect : undefined
  );

  // --- Restore mode state ---
  const [restoreBoxDrawing, setRestoreBoxDrawing] = useState(false);
  const [restoreBoxStart, setRestoreBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [restoreBoxCurrent, setRestoreBoxCurrent] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // Cache of composited URLs per region. Stored in a ref so reads in JSX
  // don't trigger React reconciliation, plus a counter to opt-in to re-render
  // when the cache actually changes.
  const restoreCompositedCacheRef = useRef<Record<string, string>>({});
  const [restoreCacheVersion, setRestoreCacheVersion] = useState(0);
  const [isInverseMode, setIsInverseMode] = useState(false);

  // --- Preview toggle state (adjusted <-> original for the selected region) ---
  // Local UI state only: never written to Region / history / MCP snapshots.
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);

  // Reset the preview toggle whenever the selection changes.
  useEffect(() => {
    setShowOriginalPreview(false);
  }, [selectedRegionId]);

  // --- Brush restore state ---
  const [isPainting, setIsPainting] = useState(false);
  const [maskReady, setMaskReady] = useState(false);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const brushOverlayRef = useRef<HTMLCanvasElement | null>(null);

  // --- Brush IOPaint-remove state (free-form mask over the whole image) ---
  const [isRemovePainting, setIsRemovePainting] = useState(false);
  const [removeMaskReady, setRemoveMaskReady] = useState(false);
  const removeMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const removeBrushOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const [brushRemoveSize, setBrushRemoveSize] = useState(removeBrushSize);

  // --- Sketch brush state (AI-visible guidance strokes) ---
  const [isSketchPainting, setIsSketchPainting] = useState(false);
  const sketchOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const liveStrokeRef = useRef<SketchStroke | null>(null);
  const cursorRingRef = useRef<HTMLDivElement | null>(null);

  // Signature that captures only the fields we care about for the restore composite.
  // Identity of `image.regions` changes on every drag/prompt edit, but the signature
  // stays stable unless the restore-relevant data actually changes.
  const restoreSignature = useMemo(
    () => image.regions
      .filter(r => r.status === 'completed' && r.processedImageUrl)
      .map(r => `${r.id}|${r.processedImageUrl}|${r.restoreMaskUrl || ''}|${(r.restoreBoxes || []).length}`)
      .join('||'),
    [image.regions]
  );

  // Update composited cache when restore boxes or mask actually change.
  useEffect(() => {
    let cancelled = false;
    const updateCache = async () => {
      const oldCache = restoreCompositedCacheRef.current;
      const newCache: Record<string, string> = {};
      for (const region of image.regions) {
        if (region.status === 'completed' && region.processedImageUrl) {
          const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || !!region.restoreMaskUrl;
          if (hasRestore) {
            try {
              newCache[region.id] = await renderRegionWithRestore(
                region.processedImageUrl,
                region.restoreBoxes,
                region.restoreMaskUrl
              );
            } catch (e) {
              console.error('Failed to render restore for region', region.id, e);
            }
          }
        }
      }
      if (cancelled) {
        // Component unmounted or signature changed again — release what we just built.
        Object.values(newCache).forEach(releaseObjectURL);
        return;
      }
      // Swap atomically and release the previous generation.
      restoreCompositedCacheRef.current = newCache;
      Object.values(oldCache).forEach(releaseObjectURL);
      setRestoreCacheVersion(v => v + 1);
    };
    updateCache();
    return () => { cancelled = true; };
  }, [restoreSignature]);

  // Final unmount: release any URLs still held in the cache ref.
  useEffect(() => {
    return () => {
      Object.values(restoreCompositedCacheRef.current).forEach(releaseObjectURL);
      restoreCompositedCacheRef.current = {};
    };
  }, []);

  // Initialize brush mask canvas when entering brush mode on a selected region
  useEffect(() => {
    if (!restoreBrushMode || !restoreSelectedRegionId) {
      maskCanvasRef.current = null;
      setMaskReady(false);
      return;
    }
    const region = image.regions.find(r => r.id === restoreSelectedRegionId);
    if (!region || !region.processedImageUrl) return;

    const initMask = async () => {
      const img = await loadImage(region.processedImageUrl!);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = w;
      maskCanvas.height = h;
      const mctx = maskCanvas.getContext('2d');
      if (!mctx) return;
      if (region.restoreMaskUrl) {
        const maskImg = await loadImage(region.restoreMaskUrl);
        mctx.drawImage(maskImg, 0, 0);
      } else {
        mctx.fillStyle = 'white';
        mctx.fillRect(0, 0, w, h);
      }
      maskCanvasRef.current = maskCanvas;
      setMaskReady(true);
    };
    setMaskReady(false);
    initMask();
  }, [restoreBrushMode, restoreSelectedRegionId, image.regions]);

  // Sync brush overlay with mask when mask is ready
  useEffect(() => {
    if (!restoreBrushMode || !brushOverlayRef.current || !maskCanvasRef.current || !maskReady) return;
    const overlay = brushOverlayRef.current;
    const mask = maskCanvasRef.current;
    overlay.width = mask.width;
    overlay.height = mask.height;
    const octx = overlay.getContext('2d');
    if (octx) {
      octx.drawImage(mask, 0, 0);
      octx.globalCompositeOperation = 'source-atop';
      octx.fillStyle = 'rgba(255, 0, 0, 0.25)';
      octx.fillRect(0, 0, overlay.width, overlay.height);
    }
  }, [restoreBrushMode, maskReady]);

  // --- Coordinate helpers ---
  // Since containerRef has transform applied, getBoundingClientRect returns the visual (scaled) rect.
  // This means (clientX - rect.left) / rect.width * 100 gives correct percentage regardless of zoom.
  const getRelativeCoords = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return { x, y };
  }, []);

  const getRegionRelativeCoords = useCallback((clientX: number, clientY: number, region: Region) => {
    const container = getRelativeCoords(clientX, clientY);
    const rx = ((container.x - region.x) / region.width) * 100;
    const ry = ((container.y - region.y) / region.height) * 100;
    return { x: Math.max(0, Math.min(100, rx)), y: Math.max(0, Math.min(100, ry)) };
  }, [getRelativeCoords]);

  // --- Region actions ---
  const toggleContextOnly = (regionId: string) => {
    if (disabled) return;
    const newRegions = image.regions.map(r =>
      r.id === regionId ? { ...r, contextOnly: !r.contextOnly } : r
    );
    onUpdateRegions(image.id, newRegions);
  };

  const removeRegion = (regionId: string) => {
    if (disabled) return;
    onUpdateRegions(
      image.id,
      image.regions.filter((r) => r.id !== regionId)
    );
    if (selectedRegionId === regionId) onSelectRegion(null);
  };

  const resetRegion = (regionId: string) => {
    if (disabled) return;
    const newRegions = image.regions.map((r) => {
      if (r.id === regionId) {
        return { ...r, status: 'pending', processedImageUrl: undefined, restoreBoxes: undefined } as Region;
      }
      return r;
    });
    onUpdateRegions(image.id, newRegions);
  };

  // --- Restore box mouse handlers ---
  const handleRestoreContainerMouseDown = (e: React.MouseEvent) => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    if (target.closest('[data-restore-handle]')) return;

    if (!target.closest('[data-region-id]')) {
      onSelectRestoreRegion?.(null);
      return;
    }
  };

  const handleRestoreRegionClick = (e: React.MouseEvent, region: Region) => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;
    if (region.status !== 'completed') return;
    e.stopPropagation();
    onSelectRestoreRegion?.(region.id === restoreSelectedRegionId ? null : region.id);
  };

  const handleRestoreBoxMouseDown = (e: React.MouseEvent, region: Region) => {
    if (!restoreMode || !onUpdateRestoreBoxes || region.id !== restoreSelectedRegionId) return;
    if (e.button !== 0) return;
    e.stopPropagation();

    const coords = getRegionRelativeCoords(e.clientX, e.clientY, region);
    setRestoreBoxDrawing(true);
    setRestoreBoxStart(coords);
    setRestoreBoxCurrent({ x: coords.x, y: coords.y, width: 0, height: 0 });
  };

  // --- Brush painting callbacks ---
  const saveBrushMask = useCallback(async () => {
    if (!maskCanvasRef.current || !restoreSelectedRegionId || !onUpdateRestoreMask) return;
    const url = await canvasToObjectURL(maskCanvasRef.current);
    onUpdateRestoreMask(restoreSelectedRegionId, url);
  }, [restoreSelectedRegionId, onUpdateRestoreMask]);

  const handleClearBrushMask = useCallback(() => {
    if (!restoreSelectedRegionId || !onUpdateRestoreMask) return;
    onUpdateRestoreMask(restoreSelectedRegionId, null);
    maskCanvasRef.current = null;
    setMaskReady(false);
  }, [restoreSelectedRegionId, onUpdateRestoreMask]);

  // Window-level mouse handlers for restore box drawing
  useEffect(() => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!restoreBoxDrawing || !restoreBoxStart || !restoreSelectedRegionId) return;
      const region = image.regions.find(r => r.id === restoreSelectedRegionId);
      if (!region) return;

      const coords = getRegionRelativeCoords(e.clientX, e.clientY, region);
      const x = Math.min(restoreBoxStart.x, coords.x);
      const y = Math.min(restoreBoxStart.y, coords.y);
      const width = Math.abs(coords.x - restoreBoxStart.x);
      const height = Math.abs(coords.y - restoreBoxStart.y);

      setRestoreBoxCurrent({ x, y, width, height });
    };

    const handleWindowMouseUp = () => {
      if (!restoreBoxDrawing || !restoreBoxStart || !restoreBoxCurrent || !restoreSelectedRegionId) {
        setRestoreBoxDrawing(false);
        setRestoreBoxStart(null);
        setRestoreBoxCurrent(null);
        return;
      }

      const { width, height } = restoreBoxCurrent;
      if (width > 0.5 && height > 0.5) {
        const region = image.regions.find(r => r.id === restoreSelectedRegionId);
        if (region && onUpdateRestoreBoxes) {
          const newBox: RestoreBox = {
            id: crypto.randomUUID(),
            x: restoreBoxCurrent.x,
            y: restoreBoxCurrent.y,
            width: restoreBoxCurrent.width,
            height: restoreBoxCurrent.height,
            inverse: isInverseMode,
          };
          onUpdateRestoreBoxes(restoreSelectedRegionId, [...(region.restoreBoxes || []), newBox]);
        }
      }

      setRestoreBoxDrawing(false);
      setRestoreBoxStart(null);
      setRestoreBoxCurrent(null);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [restoreMode, restoreBoxDrawing, restoreBoxStart, restoreBoxCurrent, restoreSelectedRegionId, image.regions, onUpdateRestoreBoxes, getRegionRelativeCoords, isInverseMode]);

  // Window-level mouse handlers for brush painting
  useEffect(() => {
    if (!restoreMode || !restoreBrushMode) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!isPainting || !brushOverlayRef.current || !maskCanvasRef.current || !restoreSelectedRegionId) return;
      const overlay = brushOverlayRef.current;
      const mask = maskCanvasRef.current;
      const mctx = mask.getContext('2d');
      if (!mctx) return;

      const rect = overlay.getBoundingClientRect();
      const scaleX = mask.width / Math.max(1, rect.width);
      const scaleY = mask.height / Math.max(1, rect.height);
      const mx = (e.clientX - rect.left) * scaleX;
      const my = (e.clientY - rect.top) * scaleY;

      const region = image.regions.find(r => r.id === restoreSelectedRegionId);
      const brushRadius = region ? (restoreBrushSize / 100) * Math.max(mask.width, mask.height) : 10;

      mctx.globalCompositeOperation = 'destination-out';
      mctx.beginPath();
      mctx.arc(mx, my, brushRadius, 0, Math.PI * 2);
      mctx.fill();

      const octx = overlay.getContext('2d');
      if (octx) {
        octx.clearRect(0, 0, overlay.width, overlay.height);
        octx.drawImage(mask, 0, 0);
        octx.globalCompositeOperation = 'source-atop';
        octx.fillStyle = 'rgba(255, 0, 0, 0.25)';
        octx.fillRect(0, 0, overlay.width, overlay.height);
        octx.globalCompositeOperation = 'source-over';
        octx.beginPath();
        octx.arc(mx, my, brushRadius, 0, Math.PI * 2);
        octx.strokeStyle = 'rgba(255,255,255,0.8)';
        octx.lineWidth = 2;
        octx.stroke();
      }
    };

    const handleWindowMouseUp = () => {
      if (isPainting) {
        setIsPainting(false);
        if (maskCanvasRef.current && restoreSelectedRegionId && onUpdateRestoreMask) {
          canvasToObjectURL(maskCanvasRef.current)
            .then(url => onUpdateRestoreMask(restoreSelectedRegionId, url))
            .catch(e => console.error('Failed to persist brush mask', e));
        }
      }
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [restoreMode, restoreBrushMode, isPainting, restoreSelectedRegionId, image.regions, restoreBrushSize, onUpdateRestoreMask]);

  const handleClearRestoreBoxes = () => {
    if (!restoreSelectedRegionId || !onUpdateRestoreBoxes) return;
    onUpdateRestoreBoxes(restoreSelectedRegionId, []);
    onSelectRestoreRegion?.(null);
  };

  // --- Brush IOPaint-remove: mask init (full-image sized, black + white paint = remove area) ---
  useEffect(() => {
    if (!removeBrushMode) {
      removeMaskCanvasRef.current = null;
      setRemoveMaskReady(false);
      return;
    }
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = image.originalWidth || 800;
    maskCanvas.height = image.originalHeight || 600;
    const mctx = maskCanvas.getContext('2d');
    if (!mctx) return;
    mctx.fillStyle = '#000000';
    mctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    removeMaskCanvasRef.current = maskCanvas;
    setRemoveMaskReady(true);
  }, [removeBrushMode, image.originalWidth, image.originalHeight]);

  // Overlay shows a translucent theme-following veil (mode visible immediately)
  // + darker translucent circles where the user paints. The mask canvas stays
  // black-background + white strokes (what actually gets sent to IOPaint).
  const tintBase = theme === 'dark' ? '255, 255, 255' : '0, 0, 0';
  const veilAlpha = theme === 'dark' ? 0.14 : 0.18;
  const strokeAlpha = theme === 'dark' ? 0.5 : 0.5;

  const paintRemoveStrokeOnOverlay = useCallback((overlay: HTMLCanvasElement, mx: number, my: number, radius: number) => {
    const octx = overlay.getContext('2d');
    if (!octx) return;
    octx.globalCompositeOperation = 'source-over';
    octx.fillStyle = `rgba(${tintBase}, ${strokeAlpha})`;
    octx.beginPath();
    octx.arc(mx, my, radius, 0, Math.PI * 2);
    octx.fill();
  }, [tintBase, strokeAlpha]);

  const renderRemoveOverlay = useCallback((overlay: HTMLCanvasElement, mask: HTMLCanvasElement, cursor?: { mx: number; my: number; radius: number }) => {
    const octx = overlay.getContext('2d');
    if (!octx) return;
    overlay.width = mask.width;
    overlay.height = mask.height;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    // Base translucent veil — makes the brush mode visible at once.
    octx.fillStyle = `rgba(${tintBase}, ${veilAlpha})`;
    octx.fillRect(0, 0, overlay.width, overlay.height);
    // Cursor ring
    if (cursor) {
      octx.beginPath();
      octx.arc(cursor.mx, cursor.my, cursor.radius, 0, Math.PI * 2);
      octx.strokeStyle = theme === 'dark' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)';
      octx.lineWidth = 2;
      octx.stroke();
    }
  }, [tintBase, veilAlpha, theme]);

  useEffect(() => {
    if (!removeBrushMode || !removeBrushOverlayRef.current || !removeMaskCanvasRef.current || !removeMaskReady) return;
    const overlay = removeBrushOverlayRef.current;
    const mask = removeMaskCanvasRef.current;
    renderRemoveOverlay(overlay, mask);
  }, [removeBrushMode, removeMaskReady, renderRemoveOverlay]);

  // Window-level mouse handlers for brush painting (remove mode)
  useEffect(() => {
    if (!removeBrushMode) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!isRemovePainting || !removeBrushOverlayRef.current || !removeMaskCanvasRef.current) return;
      const overlay = removeBrushOverlayRef.current;
      const mask = removeMaskCanvasRef.current;
      const mctx = mask.getContext('2d');
      if (!mctx) return;

      const rect = overlay.getBoundingClientRect();
      const scaleX = mask.width / Math.max(1, rect.width);
      const scaleY = mask.height / Math.max(1, rect.height);
      const mx = (e.clientX - rect.left) * scaleX;
      const my = (e.clientY - rect.top) * scaleY;

      // Use the LOCAL brushRemoveSize (slider) — the prop is only the initial value.
      const brushRadius = (brushRemoveSize / 100) * Math.max(mask.width, mask.height);

      // Submit mask: white stroke on black background (what IOPaint receives)
      mctx.globalCompositeOperation = 'source-over';
      mctx.fillStyle = '#FFFFFF';
      mctx.beginPath();
      mctx.arc(mx, my, brushRadius, 0, Math.PI * 2);
      mctx.fill();

      // Visual overlay: translucent stroke on the veil
      paintRemoveStrokeOnOverlay(overlay, mx, my, brushRadius);
    };

    const handleWindowMouseUp = () => {
      setIsRemovePainting(false);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [removeBrushMode, isRemovePainting, brushRemoveSize, paintRemoveStrokeOnOverlay]);

  // Compute painted bbox (percent coords) + mask dataURL, then hand off to App.
  const executeRemoveBrush = useCallback(async () => {
    const mask = removeMaskCanvasRef.current;
    if (!mask || !onExecuteRemoveBrush) return;
    const mctx = mask.getContext('2d');
    if (!mctx) return;
    const imgData = mctx.getImageData(0, 0, mask.width, mask.height).data;
    let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        // mask 是黑底（不透明，alpha 恒 255）+ 白笔迹——只能按"白"判定已涂抹
        const i = (y * mask.width + x) * 4;
        if (imgData[i] > 200 && imgData[i + 1] > 200 && imgData[i + 2] > 200) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return; // nothing painted
    const bbox = {
      x: (minX / mask.width) * 100,
      y: (minY / mask.height) * 100,
      width: ((maxX - minX + 1) / mask.width) * 100,
      height: ((maxY - minY + 1) / mask.height) * 100,
    };
    // IOPaint 端 b64decode 无法解 blob: URL——必须传 dataURL（base64）
    const dataUrl = await new Promise<string>((resolve, reject) => {
      mask.toBlob((blob) => {
        if (!blob) { reject(new Error('canvas.toBlob returned null')); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }, 'image/png');
    });
    onExecuteRemoveBrush({ maskDataUrl: dataUrl, bbox });
  }, [onExecuteRemoveBrush]);

  const clearRemoveBrush = useCallback(() => {
    const mask = removeMaskCanvasRef.current;
    if (!mask) return;
    const mctx = mask.getContext('2d');
    if (!mctx) return;
    mctx.fillStyle = '#000000';
    mctx.fillRect(0, 0, mask.width, mask.height);
    const overlay = removeBrushOverlayRef.current;
    if (overlay) {
      renderRemoveOverlay(overlay, mask);
    }
    onClearRemoveBrush?.();
  }, [onClearRemoveBrush, renderRemoveOverlay]);

  const handleDeleteRestoreBox = (regionId: string, boxId: string) => {
    if (!onUpdateRestoreBoxes) return;
    const region = image.regions.find(r => r.id === regionId);
    if (!region) return;
    onUpdateRestoreBoxes(regionId, (region.restoreBoxes || []).filter(b => b.id !== boxId));
  };

  const isOriginalMode = viewMode === 'original';
  const isRestoreActive = restoreMode && viewMode === 'result';

  // --- Sketch brush: render strokes onto the overlay canvas (full-res px) ---
  const renderSketchOverlay = useCallback(() => {
    const overlay = sketchOverlayRef.current;
    if (!overlay) return;
    const octx = overlay.getContext('2d');
    if (!octx) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    compositeSketchStrokes(octx, image.sketchStrokes || [], overlay.width, overlay.height);
  }, [image.sketchStrokes]);

  // Size the overlay to the image and (re)render whenever strokes / mode change.
  useEffect(() => {
    const overlay = sketchOverlayRef.current;
    if (!overlay) return;
    overlay.width = image.originalWidth || 800;
    overlay.height = image.originalHeight || 600;
    renderSketchOverlay();
  }, [isOriginalMode, brushMode, image.originalWidth, image.originalHeight, image.sketchStrokes, renderSketchOverlay]);

  // Window-level mouse handlers for sketch brush painting / erasing
  useEffect(() => {
    if (!brushMode || !isOriginalMode) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      const overlay = sketchOverlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * 100;
      const py = ((e.clientY - rect.top) / rect.height) * 100;

      // Cursor ring follows the pointer in brush mode (hover + painting)
      if (cursorRingRef.current) {
        cursorRingRef.current.style.display = 'block';
        cursorRingRef.current.style.left = `${px}%`;
        cursorRingRef.current.style.top = `${py}%`;
      }

      if (!isSketchPainting) return;

      if (brushEraser) {
        // Vector eraser: remove whole strokes whose any point is within radius
        const radiusPct = brushSize;
        const current = image.sketchStrokes || [];
        const remaining = current.filter(s =>
          !s.points.some(p => Math.hypot(p.x - px, p.y - py) <= radiusPct)
        );
        if (remaining.length !== current.length && onUpdateSketchStrokes) {
          onUpdateSketchStrokes(image.id, remaining);
        }
        return;
      }

      const live = liveStrokeRef.current;
      if (!live) return;
      const octx = overlay.getContext('2d');
      if (!octx) return;
      const prev = live.points[live.points.length - 1];
      const sizePx = (live.size / 100) * Math.max(overlay.width, overlay.height);
      octx.strokeStyle = live.color;
      octx.lineWidth = sizePx;
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      octx.beginPath();
      octx.moveTo((prev.x / 100) * overlay.width, (prev.y / 100) * overlay.height);
      octx.lineTo((px / 100) * overlay.width, (py / 100) * overlay.height);
      octx.stroke();
      live.points.push({ x: px, y: py });
    };

    const handleWindowMouseUp = () => {
      if (!isSketchPainting) return;
      setIsSketchPainting(false);
      const live = liveStrokeRef.current;
      liveStrokeRef.current = null;
      if (live && live.points.length > 0 && !brushEraser && onUpdateSketchStrokes) {
        onUpdateSketchStrokes(image.id, [...(image.sketchStrokes || []), live]);
      }
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [brushMode, isOriginalMode, isSketchPainting, brushEraser, brushSize, image.id, image.sketchStrokes, onUpdateSketchStrokes]);

  // A completed region's patch overlay shows when:
  // - result view: always (all completed patches), unchanged
  // - original (work) view: only for the selected region, when not previewing
  //   the original and not mid-drag/resize (avoids anchor mismatch while the box moves)
  const shouldShowPatchOverlay = (r: Region) => {
    if (r.status !== 'completed' || !r.processedImageUrl) return false;
    if (!isOriginalMode) return true;
    const isManipulatingRegion =
      (interaction.type === 'moving' || interaction.type === 'resizing') && interaction.regionId === r.id;
    return selectedRegionId === r.id && !showOriginalPreview && !isManipulatingRegion;
  };

  const imgW = image.originalWidth || 800;
  const imgH = image.originalHeight || 600;

  // Zoom compensation: inverse scale factor so overlay UI elements maintain
  // consistent screen-pixel size regardless of zoom level.
  const invZoom = 1 / zoom;

  // Build the combined transform: center the image, then apply pan offset
  // The content div is sized to the image's native dimensions.
  // transform: translate centers the image in the viewport, then panX/panY offset it.
  // The order matters: translate first (centering), then scale (zoom).
  // CSS transform applies right-to-left, so we write scale first then translate.
  // But we want: final_pos = center_offset + pan + scale * local_pos
  // So: transform: translate(centerX + panX, centerY + panY) scale(zoom)
  // Actually the easiest is to compute the top-left corner position:
  //   left = (viewportW - imgW * zoom) / 2 + panX
  //   top  = (viewportH - imgH * zoom) / 2 + panY
  // Then: transform: translate(left, top) scale(zoom)
  // But we need transformOrigin: '0 0' so scale applies from top-left.

  return (
    <div className="relative w-full h-full flex flex-col select-none">
      {/* Viewport: overflow hidden, no scrollbars. All pan/zoom via transform. */}
      <div
        ref={viewportRef}
        className="flex-1 overflow-hidden relative"
        style={{ cursor: spaceHeldRef.current ? 'grab' : undefined }}
      >
        {/* Content container: sized to original image dimensions, positioned via transform */}
        <div
          ref={containerRef}
          className={`absolute shadow-xl ${isOriginalMode && !restoreMode ? '' : 'cursor-default'}`}
          onMouseDown={isRestoreActive ? handleRestoreContainerMouseDown : removeBrushMode ? (e) => {
            // Brush remove: start painting a free-form removal mask
            if (e.button !== 0) return;
            if (e.altKey || spaceHeldRef.current) return;
            setIsRemovePainting(true);
          } : brushMode && isOriginalMode ? (e) => {
            // Sketch brush: start a new guidance stroke (or erase)
            if (e.button !== 0) return;
            if (disabled) return;
            if (e.altKey || spaceHeldRef.current) return;
            const overlay = sketchOverlayRef.current;
            if (!overlay) return;
            const rect = overlay.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * 100;
            const py = ((e.clientY - rect.top) / rect.height) * 100;
            setIsSketchPainting(true);
            if (!brushEraser) {
              liveStrokeRef.current = {
                id: crypto.randomUUID(),
                color: brushColor,
                size: brushSize,
                points: [{ x: px, y: py }],
              };
              const octx = overlay.getContext('2d');
              if (octx) {
                const sizePx = (brushSize / 100) * Math.max(overlay.width, overlay.height);
                octx.fillStyle = brushColor;
                octx.beginPath();
                octx.arc((px / 100) * overlay.width, (py / 100) * overlay.height, sizePx / 2, 0, Math.PI * 2);
                octx.fill();
              }
            }
          } : (e) => {
            // Block left-click background interaction when panning with space or alt
            if (e.button === 0 && (e.altKey || spaceHeldRef.current)) return;
            handleBackgroundMouseDown(e);
          }}
          onMouseLeave={() => { if (cursorRingRef.current) cursorRingRef.current.style.display = 'none'; }}
          style={{
            width: imgW,
            height: imgH,
            transformOrigin: '0 0',
            transform: `translate(${(vpW - imgW * zoom) / 2 + panX}px, ${(vpH - imgH * zoom) / 2 + panY}px) scale(${zoom})`,
            cursor: isRestoreActive ? 'crosshair' : (removeBrushMode ? 'crosshair' : (brushMode && isOriginalMode ? 'crosshair' : (isOriginalMode && interaction.type === 'drawing' ? 'crosshair' : 'default'))),
            visibility: isZoomReady ? 'visible' : 'hidden',
          }}
        >
          {/* Brush remove overlay: shows painted removal area in red */}
          {removeBrushMode && (
            <canvas
              ref={(c) => { removeBrushOverlayRef.current = c; }}
              className="absolute inset-0 pointer-events-none"
              style={{ width: '100%', height: '100%', zIndex: 6 }}
            />
          )}

          {/* Sketch brush cursor ring (brush-mode only, zoom-compensated) */}
          {brushMode && isOriginalMode && (
            <div
              ref={cursorRingRef}
              className="absolute pointer-events-none rounded-full border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
              style={{
                display: 'none',
                width: (brushSize / 100) * Math.max(imgW, imgH),
                height: (brushSize / 100) * Math.max(imgW, imgH),
                transform: `translate(-50%, -50%) scale(${invZoom})`,
                transformOrigin: 'center',
                zIndex: 8,
              }}
            />
          )}

          {/* Sketch brush overlay: AI-visible guidance strokes (hidden in result view) */}
          <canvas
            ref={sketchOverlayRef}
            className="absolute inset-0 pointer-events-none"
            style={{
              width: '100%',
              height: '100%',
              zIndex: 7,
              display: isOriginalMode && (brushMode || (image.sketchStrokes && image.sketchStrokes.length > 0)) ? 'block' : 'none',
            }}
          />

          {/* Base Image */}
          <img
            src={image.previewUrl}
            alt="Workarea"
            className="block pointer-events-none select-none rounded bg-skin-surface ring-1 ring-skin-border"
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'fill' }}
            draggable={false}
          />

          {/* Processed image overlays (result view: all completed; work view: selected region only) */}
          {image.regions.filter(shouldShowPatchOverlay).map((region) => {
            const ax = region.anchorX ?? region.x;
            const ay = region.anchorY ?? region.y;
            const aw = region.anchorWidth ?? region.width;
            const ah = region.anchorHeight ?? region.height;
            const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || region.restoreMaskUrl;
            const clipTop    = aw > 0 && ah > 0 ? Math.max(0, ((region.y - ay) / ah) * 100) : 0;
            const clipRight  = aw > 0 && ah > 0 ? Math.max(0, ((ax + aw - region.x - region.width) / aw) * 100) : 0;
            const clipBottom = aw > 0 && ah > 0 ? Math.max(0, ((ay + ah - region.y - region.height) / ah) * 100) : 0;
            const clipLeft   = aw > 0 && ah > 0 ? Math.max(0, ((region.x - ax) / aw) * 100) : 0;
            return (
              <img
                key={`overlay-${region.id}`}
                src={hasRestore ? (restoreCompositedCacheRef.current[region.id] || region.processedImageUrl) : region.processedImageUrl}
                className="absolute pointer-events-none select-none"
                style={{
                  left: `${ax}%`,
                  top: `${ay}%`,
                  width: `${aw}%`,
                  height: `${ah}%`,
                  objectFit: 'contain',
                  objectPosition: 'center center',
                  clipPath: `inset(${clipTop}% ${clipRight}% ${clipBottom}% ${clipLeft}%)`,
                  zIndex: 5,
                }}
                alt=""
              />
            );
          })}

          {/* Regions */}
          {image.regions.map((region) => {
            const isSelected = selectedRegionId === region.id && isOriginalMode;
            const isEditable = isOriginalMode && !disabled && region.status !== 'processing' && !removeBrushMode;

            const isManipulating = (interaction.type === 'moving' || interaction.type === 'resizing') && interaction.regionId === region.id;

            const x = isManipulating && interaction.currentRect?.x !== undefined ? interaction.currentRect.x : region.x;
            const y = isManipulating && interaction.currentRect?.y !== undefined ? interaction.currentRect.y : region.y;
            const width = isManipulating && interaction.currentRect?.width !== undefined ? interaction.currentRect.width : region.width;
            const height = isManipulating && interaction.currentRect?.height !== undefined ? interaction.currentRect.height : region.height;

            let styleClasses = '';

            if (!isOriginalMode) {
                if (isRestoreActive) {
                    const isRestoreSelected = region.id === restoreSelectedRegionId;
                    styleClasses = isRestoreSelected
                      ? 'border-2 border-amber-400 bg-amber-400/10 shadow-[0_0_0_2px_rgba(251,191,36,0.5)] z-30 cursor-crosshair'
                      : 'border border-white/30 bg-transparent z-10 cursor-pointer hover:border-amber-400/50';
                } else {
                    styleClasses = 'z-10 border-0';
                }
            } else {
                if (region.status === 'processing') {
                    styleClasses = 'border-2 border-amber-500 bg-amber-500/10 animate-pulse z-20';
                } else if (region.status === 'failed') {
                    styleClasses = 'border-2 border-rose-500 bg-rose-500/10 z-10';
                } else if (region.status === 'completed') {
                     if (isSelected) {
                         styleClasses = 'border-2 border-emerald-500 bg-emerald-500/20 shadow-[0_0_0_2px_rgba(255,255,255,0.8),0_0_0_4px_#10b981] z-30 cursor-move';
                     } else {
                         styleClasses = 'border-2 border-emerald-500 bg-emerald-500/10 z-10 cursor-pointer';
                     }
                } else {
                    if (isSelected) {
                        styleClasses = 'border-2 border-skin-primary bg-skin-primary/10 shadow-[0_0_0_1px_rgba(255,255,255,0.5)] z-20 cursor-move';
                    } else {
                        styleClasses = 'border-2 border-skin-primary hover:border-skin-primary bg-skin-primary/5 z-10 cursor-pointer';
                    }
                }
            }

            if (region.contextOnly) {
                styleClasses = isSelected
                  ? 'border-2 border-dashed border-amber-400 bg-amber-400/10 shadow-[0_0_0_1px_rgba(251,191,36,0.5)] z-20 cursor-move'
                  : 'border-2 border-dashed border-gray-400 bg-gray-400/5 z-10 cursor-pointer hover:border-amber-400/50';
            }

            // Compute the region's screen position to decide if action buttons
            // should be placed above or below the region. If the top of the
            // region is too close to the viewport top edge, buttons go below.
            const getToolbarPlacement = () => {
              if (!containerRef.current || !viewportRef.current) return 'above';
              const cRect = containerRef.current.getBoundingClientRect();
              const vRect = viewportRef.current.getBoundingClientRect();
              // Region top edge in screen coords
              const regionScreenTop = cRect.top + (y / 100) * cRect.height;
              const toolbarScreenHeight = 24; // button height (w-6 h-6)
              const margin = 2; // small extra margin for flipping decision
              if (regionScreenTop - vRect.top < toolbarScreenHeight + margin) {
                return 'below';
              }
              return 'above';
            };
            const toolbarPlacement = (isSelected && !isManipulating && !restoreMode)
              ? getToolbarPlacement()
              : 'above';
            const toolbarGap = 12 * invZoom; // fixed 12 screen-pixel gap between region and toolbar
            const cursorStyle = isRestoreActive ? (region.id === restoreSelectedRegionId ? 'crosshair' : 'pointer') : (isEditable ? (interaction.type === 'moving' ? 'grabbing' : 'move') : 'default');
            const handleBaseStyle = "absolute bg-white border border-skin-primary rounded-full z-30 transition-transform shadow-sm hover:shadow-lg hover:border-skin-primary/80";
            const handleSize = 14;
            // Resize handles: positioned at percentage points on the region,
            // then centered with translate(-50%,-50%) and zoom-compensated with scale(1/zoom).
            // transformOrigin must be center so the position doesn't shift.
            const handleStyle = (left: string, top: string) => ({
              left, top,
              width: handleSize,
              height: handleSize,
              transform: `translate(-50%, -50%) scale(${invZoom})`,
              transformOrigin: 'center',
            });

            return (
              <div
                key={region.id}
                ref={isSelected ? selectedRegionRef : null}
                data-region-id={region.id}
                onMouseDown={(e) => {
                  if (isRestoreActive) {
                    if (region.status === 'completed') {
                      handleRestoreRegionClick(e, region);
                    }
                  } else {
                    // Block region interaction when panning with space or alt
                    if (e.button === 0 && (e.altKey || spaceHeldRef.current)) return;
                    handleRegionMouseDown(e, region);
                  }
                }}
                className={`absolute transition-all duration-75 group ${styleClasses}`}
                style={{
                  left: `${x}%`,
                  top: `${y}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                  transition: isManipulating ? 'none' : undefined,
                  cursor: isOriginalMode || isRestoreActive ? cursorStyle : 'default',
                  overflow: (isRestoreActive || !isOriginalMode) ? 'hidden' : 'visible'
                }}
              >
                {/* RESTORE MODE: Overlay on selected region */}
                {isRestoreActive && region.id === restoreSelectedRegionId && (
                  <div className="absolute inset-0 z-40">
                    {restoreBrushMode ? (
                      <div className="absolute inset-0 cursor-crosshair"
                        onMouseDown={(e) => { e.stopPropagation(); setIsPainting(true); }}
                      >
                        <canvas ref={(c) => { brushOverlayRef.current = c; }} className="w-full h-full pointer-events-none absolute inset-0" />
                      </div>
                    ) : (
                      <div className="absolute inset-0 cursor-crosshair" onMouseDown={(e) => handleRestoreBoxMouseDown(e, region)}>
                        {(region.restoreBoxes || []).map(box => (
                          <div key={box.id} className={`absolute border-2 pointer-events-none ${box.inverse ? 'border-blue-400 bg-blue-400/10' : 'border-rose-400 bg-rose-400/10'}`}
                            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` }}>
                            <button data-restore-handle
                              className="absolute bg-rose-500 text-white rounded-full flex items-center justify-center text-[8px] leading-none pointer-events-auto hover:bg-rose-600 z-50"
                              style={{
                                top: -8 * invZoom,
                                right: -8 * invZoom,
                                width: 16 * invZoom,
                                height: 16 * invZoom,
                                transform: `scale(${invZoom})`,
                                transformOrigin: 'top right',
                              }}
                              onClick={(e) => { e.stopPropagation(); handleDeleteRestoreBox(region.id, box.id); }}
                            >✕</button>
                            <button data-restore-handle
                              className={`absolute rounded-full flex items-center justify-center text-[8px] leading-none pointer-events-auto z-50 ${box.inverse ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-rose-500 text-white hover:bg-rose-600'}`}
                              style={{
                                bottom: -8 * invZoom,
                                right: -8 * invZoom,
                                width: 16 * invZoom,
                                height: 16 * invZoom,
                                transform: `scale(${invZoom})`,
                                transformOrigin: 'bottom right',
                              }}
                              onClick={(e) => { e.stopPropagation(); if (!onUpdateRestoreBoxes) return; const updated = (region.restoreBoxes || []).map(b => b.id === box.id ? { ...b, inverse: !b.inverse } : b); onUpdateRestoreBoxes(region.id, updated); }}
                            >{box.inverse ? '⊡' : '⊞'}</button>
                          </div>
                        ))}
                        {restoreBoxDrawing && restoreBoxCurrent && restoreBoxCurrent.width > 0 && restoreBoxCurrent.height > 0 && (
                          <div className={`absolute border-2 border-dashed pointer-events-none ${isInverseMode ? 'border-blue-400 bg-blue-400/10' : 'border-rose-400 bg-rose-400/10'}`}
                            style={{ left: `${restoreBoxCurrent.x}%`, top: `${restoreBoxCurrent.y}%`, width: `${restoreBoxCurrent.width}%`, height: `${restoreBoxCurrent.height}%` }} />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* RESTORE MODE: Restore box indicators on non-selected regions */}
                {isRestoreActive && region.id !== restoreSelectedRegionId && region.status === 'completed' && region.restoreBoxes && region.restoreBoxes.length > 0 && (
                  <>
                    {(region.restoreBoxes || []).map(box => (
                      <div
                        key={box.id}
                        className={`absolute border pointer-events-none ${box.inverse ? 'border-blue-400/50' : 'border-rose-400/50'}`}
                        style={{
                          left: `${box.x}%`,
                          top: `${box.y}%`,
                          width: `${box.width}%`,
                          height: `${box.height}%`,
                        }}
                      />
                    ))}
                  </>
                )}

                {/* ORIGINAL MODE: Resize Handles */}
                {isSelected && isEditable && !restoreMode && (
                  <>
                    <div className={`${handleBaseStyle} cursor-nw-resize`} style={handleStyle('0%', '0%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'nw')} />
                    <div className={`${handleBaseStyle} cursor-ne-resize`} style={handleStyle('100%', '0%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'ne')} />
                    <div className={`${handleBaseStyle} cursor-sw-resize`} style={handleStyle('0%', '100%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'sw')} />
                    <div className={`${handleBaseStyle} cursor-se-resize`} style={handleStyle('100%', '100%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'se')} />

                    <div className={`${handleBaseStyle} cursor-n-resize`} style={handleStyle('50%', '0%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'n')} />
                    <div className={`${handleBaseStyle} cursor-s-resize`} style={handleStyle('50%', '100%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 's')} />
                    <div className={`${handleBaseStyle} cursor-w-resize`} style={handleStyle('0%', '50%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'w')} />
                    <div className={`${handleBaseStyle} cursor-e-resize`} style={handleStyle('100%', '50%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'e')} />
                  </>
                )}

                {/* ORIGINAL MODE: Action Buttons */}
                {isSelected && !isManipulating && !restoreMode && (
                   <div
                      className="absolute left-1/2 flex gap-1 z-50"
                      style={toolbarPlacement === 'above' ? {
                        top: -toolbarGap,
                        transform: `translateX(-50%) scale(${invZoom})`,
                        transformOrigin: 'bottom center',
                      } : {
                        bottom: -toolbarGap,
                        transform: `translateX(-50%) scale(${invZoom})`,
                        transformOrigin: 'top center',
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                   >
                       {!disabled && onOcrRegion && showOcrButton && (
                           <button
                             onClick={(e) => {
                               e.stopPropagation();
                               onOcrRegion(region.id);
                             }}
                             className={`w-6 h-6 bg-skin-primary text-skin-primary-fg border border-transparent rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all ${region.isOcrLoading ? 'opacity-70 cursor-wait' : ''}`}
                             title={t(language, 'ocrBtn')}
                             disabled={region.isOcrLoading}
                           >
                            {region.isOcrLoading ? (
                               <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                            ) : (
                               <span className="text-[9px] font-bold tracking-tighter">OCR</span>
                            )}
                          </button>
                      )}
                      {!disabled && showEditorButton && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenEditor(region.id);
                            }}
                             className="w-6 h-6 bg-skin-primary text-skin-primary-fg border border-transparent rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all"
                             title="Edit Patch (Brush/Text)"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                          </button>
                      )}
                      {!disabled && region.status === 'completed' && region.processedImageUrl && (
                          <>
                            {/* Toggle preview: adjusted <-> original (non-destructive) */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowOriginalPreview(v => !v);
                              }}
                              className={`w-6 h-6 border rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all ${showOriginalPreview ? 'bg-amber-100 text-amber-600 border-amber-400' : 'bg-skin-surface text-skin-text border-skin-border'}`}
                              title={showOriginalPreview ? t(language, 'showAdjusted') : t(language, 'showOriginal')}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                            </button>
                            {/* Commit current preview state: showing original -> real revert; showing patch -> bake into original */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (showOriginalPreview) {
                                  resetRegion(region.id);
                                  setShowOriginalPreview(false);
                                } else if (onApplyRegionAsOriginal) {
                                  onApplyRegionAsOriginal(image.id, region.id);
                                  setShowOriginalPreview(false);
                                }
                              }}
                              className={`w-6 h-6 border rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all ${showOriginalPreview ? 'bg-rose-500 text-white border-rose-500' : 'bg-emerald-500 text-white border-emerald-500'}`}
                              title={showOriginalPreview ? t(language, 'confirmRevert') : t(language, 'applyRegionAsOriginal')}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                            </button>
                          </>
                      )}
                       {!disabled && onRemoveRegionWithIopaint && region.status !== 'processing' && (
                           <button
                             onClick={(e) => {
                               e.stopPropagation();
                               onRemoveRegionWithIopaint!(image.id, region.id);
                             }}
                             className="w-6 h-6 bg-skin-surface text-skin-text border border-skin-border rounded-full flex items-center justify-center shadow-md hover:shadow-lg hover:bg-skin-fill transition-all"
                             title={t(language, 'iopaintRemove')}
                           >
                             <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
                           </button>
                       )}
                       {!disabled && region.status === 'failed' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              resetRegion(region.id);
                            }}
                             className="w-6 h-6 bg-skin-surface text-skin-text border border-skin-border rounded-full flex items-center justify-center shadow-md hover:shadow-lg hover:bg-skin-fill transition-all"
                             title="Reset / Redo"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                          </button>
                      )}
                      {!disabled && region.status !== 'processing' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleContextOnly(region.id);
                            }}
                             className={`w-6 h-6 border rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all ${region.contextOnly ? 'bg-amber-100 text-amber-600 border-amber-400' : 'bg-skin-surface text-skin-muted border-skin-border'}`}
                            title={region.contextOnly ? 'Context Only (click to enable translation)' : 'Mark as Context Only'}
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                          </button>
                      )}
                      {!disabled && onFlipRegion && region.status !== 'processing' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onFlipRegion(region.id);
                            }}
                             className="w-6 h-6 bg-skin-surface text-skin-text border border-skin-border rounded-full flex items-center justify-center shadow-md hover:shadow-lg hover:bg-skin-fill transition-all"
                             title="Flip Horizontal"
                          >
                            <span className="text-[11px] font-bold leading-none">⇄</span>
                          </button>
                      )}
                      {!disabled && region.status !== 'processing' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeRegion(region.id);
                            }}
                             className="w-6 h-6 bg-skin-surface text-rose-500 border border-skin-border rounded-full flex items-center justify-center shadow-md hover:shadow-lg hover:bg-rose-50 transition-all"
                             title="Delete Region"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                          </button>
                      )}
                   </div>
                )}

                {/* ORIGINAL MODE: Status Badge */}
                {isOriginalMode && region.status !== 'pending' && !isManipulating && (
                  <div
                    className={`absolute text-[8px] font-bold px-1 py-0.5 rounded backdrop-blur-md shadow-sm border pointer-events-none select-none z-10 ${
                      region.status === 'completed' ? 'bg-emerald-100/90 text-emerald-700 border-emerald-200' :
                      region.status === 'processing' ? 'bg-amber-100/90 text-amber-700 border-amber-200' :
                      'bg-rose-100/90 text-rose-700 border-rose-200'
                    }`}
                    style={{
                      top: 2 * invZoom,
                      left: 2 * invZoom,
                      transform: `scale(${invZoom})`,
                      transformOrigin: 'top left',
                    }}
                  >
                    {t(language, `status_${region.status}` as any)}
                  </div>
                )}
              </div>
            );
          })}

          {/* Drawing preview rectangle */}
          {isOriginalMode && interaction.type === 'drawing' && interaction.currentRect && !restoreMode && (
            <div
              className="absolute border-2 border-dashed border-skin-primary bg-skin-primary/20 pointer-events-none z-50"
              style={{
                left: `${interaction.currentRect.x}%`,
                top: `${interaction.currentRect.y}%`,
                width: `${interaction.currentRect.width}%`,
                height: `${interaction.currentRect.height}%`,
              }}
            />
          )}
        </div>
      </div>

      {/* Zoom controls */}
      {isOriginalMode && !restoreMode && !removeBrushMode && (
        <div className="absolute bottom-4 right-4 flex gap-1 z-40">
          <button onClick={handleZoomOut} className="w-7 h-7 bg-skin-surface border border-skin-border rounded flex items-center justify-center text-sm hover:bg-skin-fill transition" title="Zoom Out">−</button>
          <span className="w-12 h-7 bg-skin-surface border border-skin-border rounded flex items-center justify-center text-[10px] font-mono">{Math.round(zoom * 100)}%</span>
          <button onClick={handleZoomIn} className="w-7 h-7 bg-skin-surface border border-skin-border rounded flex items-center justify-center text-sm hover:bg-skin-fill transition" title="Zoom In">+</button>
          <button onClick={handleZoomReset} className="w-7 h-7 bg-skin-surface border border-skin-border rounded flex items-center justify-center text-[10px] hover:bg-skin-fill transition" title="Fit to Screen">⊡</button>
        </div>
      )}

      {/* Brush remove toolbar */}
      {removeBrushMode && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-skin-surface/95 border border-skin-border rounded-full px-4 py-2 shadow-lg">
          <span className="text-[10px] font-bold text-skin-muted">{t(language, 'removeBrushModeDesc')}</span>
          <span className="text-[9px] text-skin-muted ml-1">大小</span>
          <input type="range" min="1" max="20" step="0.5" value={brushRemoveSize}
            onChange={(e) => setBrushRemoveSize(Number(e.target.value))}
            className="w-16 h-1 accent-rose-500" />
          <span className="text-[9px] text-skin-muted w-4">{brushRemoveSize}</span>
          <button
            onClick={executeRemoveBrush}
            className="px-3 py-1 text-[11px] font-bold rounded-full bg-rose-500 text-white hover:bg-rose-600 transition-all"
          >{t(language, 'executeRemoveBrush')}</button>
          <button
            onClick={clearRemoveBrush}
            className="px-2 py-1 text-[10px] font-bold rounded-full bg-skin-surface text-skin-text border border-skin-border hover:bg-skin-fill transition-all"
          >{t(language, 'clearRemoveBrush')}</button>
          <button
            onClick={onExitRemoveBrush}
            className="px-2 py-1 text-[10px] font-bold rounded-full bg-skin-surface text-skin-muted border border-skin-border hover:bg-skin-fill transition-all"
          >✕</button>
        </div>
      )}
    </div>
  );
});

export default EditorCanvas;
