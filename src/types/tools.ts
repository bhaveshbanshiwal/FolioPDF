export type ToolCategory = 'organize' | 'convert' | 'edit' | 'security';

export type CapabilityTier = 'native' | 'workaround' | 'on-demand-wasm';

export type ToolId =
  | 'merge'
  | 'split'
  | 'compress'
  | 'edit'
  | 'sign'
  | 'converter'
  | 'images-to-pdf'
  | 'pdf-to-images'
  | 'extract-images'
  | 'protect'
  | 'unlock'
  | 'rotate'
  | 'remove-pages'
  | 'extract-pages'
  | 'rearrange'
  | 'webpage-to-pdf'
  | 'ocr'
  | 'watermark'
  | 'page-numbers'
  | 'overlay'
  | 'compare'
  | 'web-optimize'
  | 'redact'
  | 'create-pdf'
  | 'crop';

export interface ToolDefinition {
  id: ToolId;
  name: string;
  shortName: string;
  category: ToolCategory;
  description: string;
  capability: CapabilityTier;
  capabilityNote?: string;
  accept: string;
  multiple: boolean;
  /** Expected binary header kind for instant preflight probe */
  expectedKind: 'pdf' | 'image' | 'any' | 'html' | 'converter';
  /** Estimated peak memory multiplier relative to input file bytes */
  memoryMultiplier: number;
  /** Relative CPU compute weight (seconds per ~10 MB on a 4-thread baseline) */
  computeWeight?: number;
  /** Whether this tool can start without uploading a file (e.g. Create PDF, Webpage to PDF) */
  noUploadRequired?: boolean;
}

export type TabStatus = 'idle' | 'processing' | 'done' | 'error';

export interface WorkspaceTab {
  id: string;
  toolId: ToolId | 'launcher';
  title: string;
  status: TabStatus;
  progress: number;
  loadedBytes: number;
  initialFiles?: File[];
}

export interface ToolResult {
  blob: Blob;
  url: string;
  fileName: string;
  mimeType: string;
  outputBytes: number;
  originalBytes?: number;
  pageCount?: number;
  extraText?: string;
  extractedImages?: Array<{
    name: string;
    url: string;
    blob: Blob;
    width: number;
    height: number;
  }>;
  summary?: string;
}

export type PreflightSeverity =
  | 'ok'
  | 'caution'
  | 'high-risk'
  | 'crash-imminent'
  | 'unprocessable';

export type ComputeLoadTier = 'light' | 'moderate' | 'heavy' | 'extreme';

export interface PreflightIssue {
  id: string;
  severity: Exclude<PreflightSeverity, 'ok'>;
  title: string;
  detail: string;
  fileName?: string;
  actionHint?: string;
}

export interface DeviceProfile {
  deviceMemoryGb: number | null;
  hardwareConcurrency: number;
  isMobile: boolean;
  jsHeapLimitBytes: number | null;
  estimatedSafeBudgetBytes: number;
}

export interface PreflightAssessment {
  level: PreflightSeverity;
  issues: PreflightIssue[];
  estimatedPeakBytes: number;
  deviceBudgetBytes: number;
  totalInputBytes: number;
  otherTabsBytes: number;
  estimatedComputeSeconds: number;
  computeTier: ComputeLoadTier;
  computeLabel: string;
  deviceSummary: string;
  tips: string[];
}

/** Normalized 0..1 overlay elements used by Edit PDF, Sign PDF, and Redact PDF */
export type OverlayKind =
  | 'text'
  | 'replace-text'
  | 'rect'
  | 'highlight'
  | 'whiteout'
  | 'freehand'
  | 'image'
  | 'redact';

export type PdfFontFamilyKey = 'sans' | 'serif' | 'mono';

export interface PageOverlayItem {
  id: string;
  pageIndex: number; // 0-based
  kind: OverlayKind;
  x: number; // normalized 0..1 from left
  y: number; // normalized 0..1 from top
  width: number; // normalized 0..1
  height: number; // normalized 0..1
  color?: string;
  bgColor?: string;
  strokeWidth?: number;
  opacity?: number;
  text?: string;
  originalText?: string;
  fontSize?: number; // in PDF pt
  fontFamily?: PdfFontFamilyKey;
  isBold?: boolean;
  isItalic?: boolean;
  points?: Array<{ x: number; y: number }>; // normalized 0..1 for freehand
  imageDataUrl?: string;
}

export interface EditablePdfTextLine {
  id: string;
  pageIndex: number; // 0-based
  text: string;
  x: number; // normalized 0..1 from left
  y: number; // normalized 0..1 from top
  width: number; // normalized 0..1
  height: number; // normalized 0..1
  fontSizePt: number;
  fontFamily: PdfFontFamilyKey;
  isBold: boolean;
  isItalic: boolean;
  bgColor: string;
}

export interface PdfFormFieldSummary {
  name: string;
  kind: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'option-list' | 'unknown';
  value: string | boolean;
  options?: string[];
  readOnly: boolean;
}

export interface CreatePdfBlock {
  id: string;
  type: 'heading' | 'paragraph' | 'bullets' | 'table' | 'divider' | 'image';
  content: string;
  imageDataUrl?: string;
  imageName?: string;
}
