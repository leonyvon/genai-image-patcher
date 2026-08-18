
export interface SketchStroke {
  id: string;
  color: string;                      // hex，如 '#ff3b30'
  size: number;                       // 粗细：图片最大边长的百分比（0-100），与 restoreBrushSize 语义一致
  points: { x: number; y: number }[]; // 百分比坐标 0-100，相对整图
}

export interface RestoreBox {
  id: string;
  x: number;       // Percentage 0-100 relative to the region (not the full image)
  y: number;
  width: number;
  height: number;
  inverse: boolean; // true = keep AI result inside box, restore outside
}

export interface Region {
  id: string;
  x: number; // Percentage 0-100 relative to image
  y: number; // Percentage 0-100 relative to image
  width: number; // Percentage 0-100
  height: number; // Percentage 0-100
  type: 'rect'; // Extensible for future shapes
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processedImageUrl?: string; // Object URL of the API-generated patch
  /** The region dimensions at the time processedImageUrl was generated (percentages). Used for display/stitch alignment when the green frame is resized. */
  anchorX?: number;
  anchorY?: number;
  anchorWidth?: number;
  anchorHeight?: number;
  source?: 'manual' | 'auto' | 'iopaint'; // To distinguish manually drawn vs AI detected vs local IOPaint removal regions
  customPrompt?: string; // Image-specific prompt overrides global prompt
  contextOnly?: boolean; // If true, region is visible context only — not translated or painted
  ocrText?: string; // Detected text from OCR
  isOcrLoading?: boolean; // Loading state for OCR
  restoreBoxes?: RestoreBox[]; // Box-based restore regions (框选还原)
  restoreMaskUrl?: string; // Brush-based restore mask Object URL (涂抹还原), alpha=1=processed, 0=original
  errorMessage?: string; // 最近一次失败的原因（供 MCP 快照与 UI 诊断）
}

export interface ImageHistoryState {
  previewUrl: string;
  regions: Region[];
  finalResultUrl?: string;
  width: number;
  height: number;
  fullAiResultUrl?: string; // Added to history
  /** Full-resolution source for API crops at this history point (undo/redo restores it). */
  originalUrl?: string;
}

export interface UploadedImage {
  id: string;
  file: File;
  previewUrl: string;       // Display URL (may be compressed in balanced mode)
  originalUrl: string;      // Original full-resolution URL for API crop (never compressed)
  thumbnailUrl: string;     // Small thumbnail for gallery
  originalWidth: number;
  originalHeight: number;
  regions: Region[];
  finalResultUrl?: string; // The stitched final image
  fullAiResultUrl?: string; // The raw full-size output from the AI (before any cropping)
  isSkipped?: boolean; // If true, excluded from batch processing but included in zip (as original)
  customPrompt?: string; // Full image specific prompt
  
  // History for Undo/Redo of "Apply as Original"
  history: ImageHistoryState[];
  historyIndex: number;
  isReference?: boolean; // If true, image is a grsai reference only — excluded from processing and ZIP export
  /** Compressed base64 data URL stored in config.grsaiReferenceImages (used for badge index and unmarking). */
  referenceBase64?: string;
  /** AI 可见的草图指引线条（矢量、百分比坐标）。永不写入最终输出，仅合成进 AI 输入。 */
  sketchStrokes?: SketchStroke[];
}

export type AiProvider = 'openai' | 'gemini' | 'grsai';

export type ThemeType = 'light' | 'dark';

export type Language = 'zh' | 'en';

export type ProcessingMode = 'api' | 'manual';

export type PerformanceMode = 'unlimited' | 'balanced';

export type SquareFillMode = 'ratio' | 'detect';

export interface AppConfig {
  prompt: string;
  // Execution Mode is now effectively handled by concurrencyLimit
  // 1 = Serial, >1 = Concurrent
  executionMode: 'concurrent' | 'serial'; 
  concurrencyLimit: number;
  
  // Advanced: If an image has no regions, process the whole image
  processFullImageIfNoRegions: boolean;
  
  // Retry & Timeout Settings
  apiTimeout: number; // in milliseconds
  maxRetries: number; // count

  // Workflow Mode
  processingMode: ProcessingMode;

  // Performance Mode
  performanceMode: PerformanceMode;
  
  // Theme & Language
  theme: ThemeType;
  language: Language;

  // Provider Settings
  provider: AiProvider;
  
  // OpenAI Specifics
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiStream: boolean; // New: Stream Toggle
  enableSquareFill: boolean; // New: Pad image to 1:1 square before sending
  squareFillMargin: number; // px: safety margin to trim from each edge after depadding (only for 'detect' mode)
  squareFillMode: SquareFillMode; // 'ratio' = crop by proportion, 'detect' = scan dark pixels + margin
  
  // Gemini Specifics
  geminiApiKey: string;
  geminiModel: string;

  // grsai (GPT Image 2) Specifics
  grsaiApiKey: string;
  grsaiModel: string;
  /** Global reference images (compressed base64 data URLs). Sent as images[1..n] on grsai requests; [image 1] is always the region slice. */
  grsaiReferenceImages: string[];

  // Backend Detection Settings (Python)
  detectionApiUrl: string; // e.g. http://localhost:8000/detect
  ocrApiUrl: string; // e.g. http://localhost:8000/ocr

  // Local IOPaint (LaMa) erase service
  iopaintUrl: string; // e.g. http://127.0.0.1:8080
  
  // Detection Tuning
  detectionInflationPercent: number; // e.g. 10 for 10% expansion
  detectionOffsetXPercent: number; // e.g. 0
  detectionOffsetYPercent: number; // e.g. 0
  detectionConfidenceThreshold: number; // e.g. 30 for 0.3
  
  // Manga Module Settings (New Structure)
  enableMangaMode: boolean;        // Master switch
  enableBubbleDetection: boolean;  // Sub switch: Auto-detect regions
  enableOCR: boolean;              // Sub switch: Text recognition
  enableManualEditor: boolean;     // Sub switch: Brush/Text editor
  enableVerticalTextDefault: boolean; // Sub switch: Default text orientation
  enablePanelSnap: boolean;          // Snap drawn region edges to the nearest panel border

  // Logic Switch
  useFullImageMasking: boolean; // Send full image with non-selected areas masked white
  useInvertedMasking: boolean; // New: Selected areas are masked white (AI generates BG), Orginal regions kept.
  fullImageOpaquePercent: number; // 0-100, default 99. Determines how much of the center is opaque before feathering starts.

  // Translation Mode Settings
  enableTranslationMode: boolean;
  sendMaskedContextForTranslation: boolean;
  translationBaseUrl: string;
  translationApiKey: string;
  translationModel: string;
  translationPrompt: string;
  /** User's custom prompt for translation WITHOUT masked context (cached) */
  translationPromptNoContext?: string;
  /** User's custom prompt for translation WITH masked context (cached) */
  translationPromptWithContext?: string;

  /** When true, images sent to translation/redraw APIs are re-encoded to WebP
   *  at a target file size (binary search on quality). Preserves pixel
   *  dimensions — no resampling. When false, raw originals are sent. */
  enableAiPayloadCompression: boolean;
  /** Target size in KB for the translation API payload + context image. */
  aiPayloadTranslationTargetKB: number;
  /** Target size in KB for the redraw (image edit) API payload. */
  aiPayloadRedrawTargetKB: number;
}

export enum ProcessingStep {
  IDLE = 'IDLE',
  CROPPING = 'CROPPING',
  API_CALLING = 'API_CALLING',
  STITCHING = 'STITCHING',
  DONE = 'DONE',
}