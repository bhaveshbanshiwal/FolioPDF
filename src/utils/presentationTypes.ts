export type SlideGeometry = 'rect' | 'roundRect' | 'ellipse' | 'line' | 'triangle';

export interface SlideGradient {
  fromHex: string;
  toHex: string;
  angleDeg?: number;
}

export interface SlideImageCrop {
  /** Fractions 0..1 cropped off each edge (from OOXML a:srcRect). */
  l: number;
  t: number;
  r: number;
  b: number;
}

export type SlideImageSource =
  | { kind: 'zip'; path: string }
  | { kind: 'bytes'; bytes: Uint8Array; mime: string };

export interface SlideTextRun {
  text: string;
  fontSizePt?: number;
  isBold?: boolean;
  isItalic?: boolean;
  isUnderline?: boolean;
  colorHex?: string;
}

export interface SlideParagraph {
  text: string;
  runs?: SlideTextRun[];
  fontSizePt?: number;
  isBold?: boolean;
  isItalic?: boolean;
  colorHex?: string;
  align?: 'left' | 'center' | 'right';
  isBullet?: boolean;
  bulletChar?: string;
  level?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
}

export interface SlideShapeElement {
  kind: 'shape';
  xFrac: number;
  yFrac: number;
  wFrac: number;
  hFrac: number;
  hasPosition: boolean;
  rotationDeg?: number;
  geometry: SlideGeometry;
  cornerRadiusFrac?: number;
  fillHex?: string;
  fillOpacity?: number;
  gradient?: SlideGradient;
  fillImage?: SlideImageSource;
  fillImageCrop?: SlideImageCrop;
  borderHex?: string;
  borderWidthPt?: number;
  borderOpacity?: number;
  borderDash?: boolean;
  /** For line/connector elements: start-to-end flip flags */
  flipH?: boolean;
  flipV?: boolean;
  isTitle?: boolean;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  paddingPt?: { l: number; t: number; r: number; b: number };
  paragraphs: SlideParagraph[];
}

export interface SlideImageElement {
  kind: 'image';
  xFrac: number;
  yFrac: number;
  wFrac: number;
  hFrac: number;
  hasPosition: boolean;
  rotationDeg?: number;
  source: SlideImageSource;
  crop?: SlideImageCrop;
  geometry?: 'rect' | 'roundRect' | 'ellipse';
  cornerRadiusFrac?: number;
  borderHex?: string;
  borderWidthPt?: number;
  /** When true (default in PPTX), stretch image to exact frame; otherwise contain-fit. */
  fitMode?: 'stretch' | 'contain';
}

export interface SlideTableCell {
  text: string;
  fillHex?: string;
  textColorHex?: string;
  isBold?: boolean;
  fontSizePt?: number;
  align?: 'left' | 'center' | 'right';
}

export interface SlideTableElement {
  kind: 'table';
  xFrac: number;
  yFrac: number;
  wFrac: number;
  hFrac: number;
  hasPosition: boolean;
  colWidthFracs?: number[];
  borderHex?: string;
  rows: SlideTableCell[][];
}

export type SlideElement = SlideShapeElement | SlideImageElement | SlideTableElement;

export interface RichParsedSlide {
  slideNumber: number;
  widthPt: number;
  heightPt: number;
  bgHex?: string;
  bgGradient?: SlideGradient;
  bgImage?: SlideImageSource;
  /** Painter's z-order elements: master background frames -> layout frames -> slide elements */
  elements: SlideElement[];
}
