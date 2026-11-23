import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, rgb, StandardFonts } from '@cantoo/pdf-lib';
import JSZip from 'jszip';
import type { ToolResult } from '../types/tools';
import {
  extractBlocksFromLegacyDoc,
  extractRichSlidesFromLegacyPpt,
  extractSheetsFromLegacyXls,
  parseEnhancedDocxXml,
  parseOdtContentXml,
  parseRichOdpXml,
  parseRtfToBlocks,
} from '../utils/legacyOfficeUtils';
import {
  buildEditablePptxBlob,
  buildVisualPptxBlob,
  buildXlsxBlob,
  decodeXmlEntities,
  groupPdfLinesIntoSheetRows,
  type ParsedSheet,
  parseOdsContentXml,
  parseTsvRows,
  parseXlsxSharedStringsXml,
  parseXlsxWorksheetXml,
  rowsToCsv,
} from '../utils/officeUtils';
import { parsePptxArchive } from '../utils/pptxParser';
import type {
  RichParsedSlide,
  SlideGradient,
  SlideImageCrop,
  SlideImageSource,
  SlideShapeElement,
  SlideTableElement,
} from '../utils/presentationTypes';
import {
  parseCsvRows,
  sanitizeBaseName,
  stripHtmlToBlocks,
  type StructuredTextBlock,
} from '../utils/pdfUtils';
import {
  closePdfJsDocument,
  extractAllPagesEditableTextLines,
  openPdfJsDocument,
  renderPdfPageToCanvas,
} from './pdfRenderer';

function sanitizeWinAnsi(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\xFF\u2022]/g, '?');
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return rgb(0.08, 0.11, 0.17);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function wrapTextToWidth(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const safe = sanitizeWinAnsi(text);
  const words = safe.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';

  const pushOversizedWord = (word: string) => {
    let chunk = '';
    for (const ch of word) {
      if (font.widthOfTextAtSize(chunk + ch, fontSize) <= maxWidth || chunk.length === 0) {
        chunk += ch;
      } else {
        lines.push(chunk);
        chunk = ch;
      }
    }
    if (chunk) current = chunk;
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        current = '';
      }
      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
        current = word;
      } else {
        pushOversizedWord(word);
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function makeResult(
  blob: Blob,
  fileName: string,
  meta: {
    originalBytes: number;
    pageCount?: number;
    summary: string;
    extraText?: string;
  },
): ToolResult {
  const url = URL.createObjectURL(blob);
  return {
    blob,
    url,
    fileName,
    mimeType: blob.type || 'application/octet-stream',
    outputBytes: blob.size,
    originalBytes: meta.originalBytes,
    pageCount: meta.pageCount,
    summary: meta.summary,
    extraText: meta.extraText,
  };
}

function parseRelationshipMap(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<Relationship\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(relsXml)) !== null) {
    const tag = match[0];
    const idMatch = /\bId="([^"]+)"/.exec(tag);
    const targetMatch = /\bTarget="([^"]+)"/.exec(tag);
    if (idMatch && targetMatch) {
      map.set(idMatch[1], targetMatch[1]);
    }
  }
  return map;
}

function resolveZipTargetPath(baseDir: string, target: string): string {
  const cleaned = target.replace(/^\/+/, '');
  const parts = (baseDir ? `${baseDir}/${cleaned}` : cleaned).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
}

function detectImageMime(bytes: Uint8Array, pathOrMime?: string): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  const low = (pathOrMime ?? '').toLowerCase();
  if (low.includes('svg')) return 'image/svg+xml';
  if (low.endsWith('.png') || low === 'image/png') return 'image/png';
  if (low.endsWith('.jpg') || low.endsWith('.jpeg') || low === 'image/jpeg') return 'image/jpeg';
  if (low.endsWith('.webp') || low === 'image/webp') return 'image/webp';
  if (low.endsWith('.gif') || low === 'image/gif') return 'image/gif';
  if (low.endsWith('.bmp') || low === 'image/bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function getHexLuminance(hex: string): number {
  const clean = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(clean, 16);
  if (!Number.isFinite(n)) return 1;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Rasterizes an image via browser canvas when cropping, rounded/circular masking,
 * or non-native PDF formats (BMP, WebP, GIF, SVG) are needed.
 */
async function rasterizeImageForPdf(
  bytes: Uint8Array,
  mime: string,
  options?: {
    crop?: SlideImageCrop;
    mask?: 'rect' | 'roundRect' | 'ellipse';
    cornerRadiusFrac?: number;
    targetAspect?: number;
  },
): Promise<{ bytes: Uint8Array; format: 'png' | 'jpg' } | null> {
  if (typeof document === 'undefined') return null;

  const blob = new Blob(
    [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
    { type: mime },
  );

  let source: ImageBitmap | HTMLImageElement | null = null;
  let natW = 0;
  let natH = 0;
  let objectUrl: string | null = null;

  try {
    if (mime !== 'image/svg+xml' && typeof createImageBitmap === 'function') {
      const bm = await createImageBitmap(blob);
      source = bm;
      natW = bm.width;
      natH = bm.height;
    } else {
      objectUrl = URL.createObjectURL(blob);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Image load failed'));
        el.src = objectUrl!;
      });
      source = img;
      natW = img.naturalWidth || img.width || 600;
      natH = img.naturalHeight || img.height || 400;
    }

    if (natW <= 0 || natH <= 0 || !source) return null;

    const crop = options?.crop;
    const sx = crop ? Math.round(crop.l * natW) : 0;
    const sy = crop ? Math.round(crop.t * natH) : 0;
    const sw = Math.max(1, Math.round(natW * (1 - (crop?.l ?? 0) - (crop?.r ?? 0))));
    const sh = Math.max(1, Math.round(natH * (1 - (crop?.t ?? 0) - (crop?.b ?? 0))));

    // Clamp giant source images to 1800px max edge for crisp quality + fast PDF size
    const maxEdge = 1800;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const cw = Math.max(1, Math.round(sw * scale));
    const ch = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const needsAlpha =
      mime === 'image/png' ||
      mime === 'image/svg+xml' ||
      mime === 'image/webp' ||
      mime === 'image/gif' ||
      options?.mask === 'ellipse' ||
      options?.mask === 'roundRect';

    ctx.save();
    if (options?.mask === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(cw / 2, ch / 2, cw / 2, ch / 2, 0, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
    } else if (options?.mask === 'roundRect') {
      const r = Math.min(cw, ch) * (options.cornerRadiusFrac ?? 0.14);
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(cw - r, 0);
      ctx.quadraticCurveTo(cw, 0, cw, r);
      ctx.lineTo(cw, ch - r);
      ctx.quadraticCurveTo(cw, ch, cw - r, ch);
      ctx.lineTo(r, ch);
      ctx.quadraticCurveTo(0, ch, 0, ch - r);
      ctx.lineTo(0, r);
      ctx.quadraticCurveTo(0, 0, r, 0);
      ctx.closePath();
      ctx.clip();
    } else if (!needsAlpha) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
    }

    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, cw, ch);
    ctx.restore();

    const outMime = needsAlpha ? 'image/png' : 'image/jpeg';
    const outBlob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), outMime, 0.9),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!outBlob) return null;

    return {
      bytes: new Uint8Array(await outBlob.arrayBuffer()),
      format: needsAlpha ? 'png' : 'jpg',
    };
  } catch {
    return null;
  } finally {
    if (source && 'close' in source && typeof source.close === 'function') {
      source.close();
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function renderGradientToImage(
  pdfDoc: PDFDocument,
  grad: SlideGradient,
  widthPt: number,
  heightPt: number,
  geometry: 'rect' | 'roundRect' | 'ellipse',
  cornerRadiusFrac?: number,
): Promise<PDFImage | null> {
  if (typeof document === 'undefined') return null;
  const cw = Math.max(64, Math.min(640, Math.round(widthPt * 1.2)));
  const ch = Math.max(64, Math.min(480, Math.round(heightPt * 1.2)));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const rad = ((grad.angleDeg ?? 90) * Math.PI) / 180;
  const cx = cw / 2;
  const cy = ch / 2;
  const dx = Math.cos(rad) * cx;
  const dy = Math.sin(rad) * cy;
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  g.addColorStop(0, grad.fromHex);
  g.addColorStop(1, grad.toHex);

  ctx.save();
  if (geometry === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(cx, cy, cx, cy, 0, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  } else if (geometry === 'roundRect') {
    const r = Math.min(cw, ch) * (cornerRadiusFrac ?? 0.14);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(cw - r, 0);
    ctx.quadraticCurveTo(cw, 0, cw, r);
    ctx.lineTo(cw, ch - r);
    ctx.quadraticCurveTo(cw, ch, cw - r, ch);
    ctx.lineTo(r, ch);
    ctx.quadraticCurveTo(0, ch, 0, ch - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.clip();
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, ch);
  ctx.restore();

  const outMime = geometry === 'rect' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), outMime, 0.92));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return outMime === 'image/png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  } catch {
    return null;
  }
}

/** Builds an SVG path for a rounded rectangle in pdf-lib drawSvgPath (y-down relative to top-left x,y). */
function buildRoundedRectSvgPath(w: number, h: number, rRaw: number): string {
  const r = Math.max(0.5, Math.min(rRaw, w / 2, h / 2));
  return [
    `M ${r} 0`,
    `L ${w - r} 0`,
    `Q ${w} 0 ${w} ${r}`,
    `L ${w} ${h - r}`,
    `Q ${w} ${h} ${w - r} ${h}`,
    `L ${r} ${h}`,
    `Q 0 ${h} 0 ${h - r}`,
    `L 0 ${r}`,
    `Q 0 0 ${r} 0`,
    'Z',
  ].join(' ');
}

/**
 * Unified high-fidelity slide -> PDF engine used by .pptx/.pptm/.ppsx/.potx, legacy .ppt, and .odp.
 * Preserves slide dimensions, backgrounds (solid, gradient, image), master/layout frames,
 * z-ordered shapes (fills, gradients, rounded rectangles, ellipses, lines, borders),
 * embedded images (PNG/JPEG/BMP/WebP/GIF/SVG with crops & frame masks), positioned styled tables,
 * and rich aligned typography with smart frame auto-fit.
 */
async function renderRichSlidesToPdf(
  slides: RichParsedSlide[],
  meta: {
    file: File;
    label: string;
    zip?: JSZip;
  },
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  if (slides.length === 0) {
    throw new Error(`No slide content could be extracted from "${meta.file.name}".`);
  }

  const pdfDoc = await PDFDocument.create();
  const baseName = sanitizeBaseName(meta.file.name);
  pdfDoc.setTitle(baseName);
  pdfDoc.setCreator('FolioPDF');

  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const boldItalicFont = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);

  const pickFont = (isBold?: boolean, isItalic?: boolean): PDFFont => {
    if (isBold && isItalic) return boldItalicFont;
    if (isBold) return boldFont;
    if (isItalic) return italicFont;
    return regularFont;
  };

  // Cache embedded images across slides (huge win for repeated master logos/backgrounds)
  const imageCache = new Map<string, PDFImage | null>();
  const bytesKeyMap = new WeakMap<Uint8Array, number>();
  let nextBytesId = 1;
  let embeddedImagesCount = 0;

  const resolveAndEmbedImage = async (
    source: SlideImageSource,
    options?: {
      crop?: SlideImageCrop;
      mask?: 'rect' | 'roundRect' | 'ellipse';
      cornerRadiusFrac?: number;
    },
  ): Promise<PDFImage | null> => {
    let baseKey: string;
    let rawBytes: Uint8Array | null = null;
    let hint = '';

    if (source.kind === 'zip') {
      if (!meta.zip) return null;
      const cleanPath = source.path.replace(/^\/+/, '');
      baseKey = `zip:${cleanPath}`;
      hint = cleanPath;
    } else {
      let id = bytesKeyMap.get(source.bytes);
      if (!id) {
        id = nextBytesId++;
        bytesKeyMap.set(source.bytes, id);
      }
      baseKey = `bytes:${id}`;
      hint = source.mime;
    }

    const cropKey = options?.crop
      ? `${options.crop.l.toFixed(3)},${options.crop.t.toFixed(3)},${options.crop.r.toFixed(3)},${options.crop.b.toFixed(3)}`
      : '';
    const cacheKey = `${baseKey}|${cropKey}|${options?.mask ?? 'rect'}`;

    if (imageCache.has(cacheKey)) {
      return imageCache.get(cacheKey) ?? null;
    }

    if (source.kind === 'zip') {
      const cleanPath = source.path.replace(/^\/+/, '');
      const entry =
        meta.zip!.file(cleanPath) ??
        Object.values(meta.zip!.files).find(
          (f) => !f.dir && f.name.toLowerCase() === cleanPath.toLowerCase(),
        );
      if (!entry) {
        imageCache.set(cacheKey, null);
        return null;
      }
      rawBytes = await entry.async('uint8array');
    } else {
      rawBytes = source.bytes;
    }

    const mime = detectImageMime(rawBytes, hint);
    const needsCanvasTransform = Boolean(
      options?.crop ||
        options?.mask === 'ellipse' ||
        options?.mask === 'roundRect' ||
        (mime !== 'image/png' && mime !== 'image/jpeg'),
    );

    let embedded: PDFImage | null = null;
    try {
      if (needsCanvasTransform) {
        const raster = await rasterizeImageForPdf(rawBytes, mime, options);
        if (raster) {
          embedded =
            raster.format === 'png'
              ? await pdfDoc.embedPng(raster.bytes)
              : await pdfDoc.embedJpg(raster.bytes);
        }
      }
      if (!embedded && mime === 'image/png') {
        embedded = await pdfDoc.embedPng(rawBytes);
      } else if (!embedded && mime === 'image/jpeg') {
        embedded = await pdfDoc.embedJpg(rawBytes);
      }
    } catch {
      // Retry via canvas normalization if pdf-lib rejected an exotic PNG/JPEG variant (e.g. progressive/CMYK/16-bit)
      try {
        const raster = await rasterizeImageForPdf(rawBytes, mime, options);
        if (raster) {
          embedded =
            raster.format === 'png'
              ? await pdfDoc.embedPng(raster.bytes)
              : await pdfDoc.embedJpg(raster.bytes);
        }
      } catch {
        embedded = null;
      }
    }

    imageCache.set(cacheKey, embedded);
    if (embedded) embeddedImagesCount++;
    return embedded;
  };

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const pageW = slide.widthPt || 720;
    const pageH = slide.heightPt || 540;
    const page = pdfDoc.addPage([pageW, pageH]);

    // 1. Slide background (solid, gradient, or full-bleed background image)
    const slideBgHex = slide.bgHex ?? '#ffffff';
    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageW,
      height: pageH,
      color: hexToRgb(slideBgHex),
    });

    if (slide.bgGradient) {
      const gradImg = await renderGradientToImage(pdfDoc, slide.bgGradient, pageW, pageH, 'rect');
      if (gradImg) {
        page.drawImage(gradImg, { x: 0, y: 0, width: pageW, height: pageH });
      }
    }

    if (slide.bgImage) {
      const bgImg = await resolveAndEmbedImage(slide.bgImage);
      if (bgImg) {
        page.drawImage(bgImg, { x: 0, y: 0, width: pageW, height: pageH });
      }
    }

    const slideBgIsDark = !slide.bgImage && getHexLuminance(slideBgHex) < 0.36;
    const marginX = Math.max(32, pageW * 0.055);
    const defaultTextWidth = pageW - marginX * 2;
    let flowCursorY = pageH - 52;

    // 2. Render every element in exact painter's z-order
    for (const el of slide.elements) {
      if (el.kind === 'image') {
        const embedded = await resolveAndEmbedImage(el.source, {
          crop: el.crop,
          mask: el.geometry,
          cornerRadiusFrac: el.cornerRadiusFrac,
        });
        if (!embedded) continue;

        const boxX = el.hasPosition ? el.xFrac * pageW : marginX;
        const boxW = Math.max(12, el.hasPosition ? el.wFrac * pageW : defaultTextWidth * 0.65);
        const boxH = Math.max(12, el.hasPosition ? el.hFrac * pageH : pageH * 0.48);
        const boxYTop = el.hasPosition ? el.yFrac * pageH : pageH - flowCursorY;
        const boxYBottom = pageH - boxYTop - boxH;

        let drawX = boxX;
        let drawY = boxYBottom;
        let drawW = boxW;
        let drawH = boxH;

        if (el.fitMode === 'contain') {
          const scale = Math.min(boxW / embedded.width, boxH / embedded.height);
          drawW = embedded.width * scale;
          drawH = embedded.height * scale;
          drawX = boxX + (boxW - drawW) / 2;
          drawY = boxYBottom + (boxH - drawH) / 2;
        }

        page.drawImage(embedded, {
          x: drawX,
          y: drawY,
          width: drawW,
          height: drawH,
        });

        if (el.borderHex && (el.borderWidthPt ?? 0) > 0) {
          const bw = el.borderWidthPt ?? 1;
          if (el.geometry === 'ellipse') {
            page.drawEllipse({
              x: drawX + drawW / 2,
              y: drawY + drawH / 2,
              xScale: drawW / 2,
              yScale: drawH / 2,
              borderColor: hexToRgb(el.borderHex),
              borderWidth: bw,
            });
          } else if (el.geometry === 'roundRect') {
            const path = buildRoundedRectSvgPath(
              drawW,
              drawH,
              Math.min(drawW, drawH) * (el.cornerRadiusFrac ?? 0.14),
            );
            page.drawSvgPath(path, {
              x: drawX,
              y: drawY + drawH,
              borderColor: hexToRgb(el.borderHex),
              borderWidth: bw,
            });
          } else {
            page.drawRectangle({
              x: drawX,
              y: drawY,
              width: drawW,
              height: drawH,
              borderColor: hexToRgb(el.borderHex),
              borderWidth: bw,
            });
          }
        }

        if (!el.hasPosition) {
          flowCursorY = Math.min(flowCursorY, drawY - 14);
        }
        continue;
      }

      if (el.kind === 'table') {
        flowCursorY = drawStyledSlideTable(
          page,
          el,
          pageW,
          pageH,
          marginX,
          defaultTextWidth,
          flowCursorY,
          regularFont,
          boldFont,
        );
        continue;
      }

      // 3. Shape / Frame / Card / Line / TextBox
      flowCursorY = await drawStyledSlideShape(
        pdfDoc,
        page,
        el,
        pageW,
        pageH,
        marginX,
        defaultTextWidth,
        flowCursorY,
        slideBgIsDark,
        pickFont,
        resolveAndEmbedImage,
      );
    }

    onProgress?.(10 + Math.round(((i + 1) / slides.length) * 85));
    if (i % 6 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const outBytes = await pdfDoc.save({ useObjectStreams: true });
  onProgress?.(100);
  const blob = new Blob(
    [outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer],
    { type: 'application/pdf' },
  );
  return makeResult(blob, `${baseName}.pdf`, {
    originalBytes: meta.file.size,
    pageCount: slides.length,
    summary: `Converted ${slides.length} ${meta.label} slide(s)${
      embeddedImagesCount > 0 ? ` and ${embeddedImagesCount} embedded image(s)` : ''
    } to PDF with preserved layout and frames.`,
  });
}

async function drawStyledSlideShape(
  pdfDoc: PDFDocument,
  page: PDFPage,
  shape: SlideShapeElement,
  pageW: number,
  pageH: number,
  marginX: number,
  defaultTextWidth: number,
  flowCursorY: number,
  slideBgIsDark: boolean,
  pickFont: (isBold?: boolean, isItalic?: boolean) => PDFFont,
  resolveAndEmbedImage: (
    source: SlideImageSource,
    options?: { crop?: SlideImageCrop; mask?: 'rect' | 'roundRect' | 'ellipse'; cornerRadiusFrac?: number },
  ) => Promise<PDFImage | null>,
): Promise<number> {
  const useExplicit = shape.hasPosition;
  const boxX = useExplicit ? shape.xFrac * pageW : marginX;
  const boxW = useExplicit ? Math.max(2, shape.wFrac * pageW) : defaultTextWidth;
  const boxH = useExplicit ? Math.max(2, shape.hFrac * pageH) : Math.max(28, shape.hFrac * pageH);
  const boxYTop = useExplicit ? shape.yFrac * pageH : pageH - flowCursorY;
  const boxYBottom = pageH - boxYTop - boxH;

  // Line / Connector element
  if (shape.geometry === 'line') {
    const strokeHex = shape.borderHex ?? shape.fillHex ?? '#334155';
    const thickness = Math.max(0.6, shape.borderWidthPt ?? 1);
    const startX = shape.flipH ? boxX + boxW : boxX;
    const endX = shape.flipH ? boxX : boxX + boxW;
    const startY = shape.flipV ? boxYBottom : boxYBottom + boxH;
    const endY = shape.flipV ? boxYBottom + boxH : boxYBottom;
    page.drawLine({
      start: { x: startX, y: startY },
      end: { x: endX, y: endY },
      thickness,
      color: hexToRgb(strokeHex),
      opacity: shape.borderOpacity ?? 1,
      dashArray: shape.borderDash ? [5, 3] : undefined,
    });
    return flowCursorY;
  }

  // Draw shape fill / gradient / image fill / border frame
  const hasFill = Boolean(shape.fillHex);
  const hasBorder = Boolean(shape.borderHex && (shape.borderWidthPt ?? 0) > 0);
  const fillOpacity = shape.fillOpacity ?? 1;
  const borderOpacity = shape.borderOpacity ?? 1;
  const borderWidth = shape.borderWidthPt ?? 1;

  if (shape.fillImage) {
    const img = await resolveAndEmbedImage(shape.fillImage, {
      crop: shape.fillImageCrop,
      mask: shape.geometry === 'ellipse' || shape.geometry === 'roundRect' ? shape.geometry : 'rect',
      cornerRadiusFrac: shape.cornerRadiusFrac,
    });
    if (img) {
      page.drawImage(img, {
        x: boxX,
        y: boxYBottom,
        width: boxW,
        height: boxH,
      });
    }
  } else if (shape.gradient) {
    const gGeom =
      shape.geometry === 'ellipse' || shape.geometry === 'roundRect' ? shape.geometry : 'rect';
    const gradImg = await renderGradientToImage(
      pdfDoc,
      shape.gradient,
      boxW,
      boxH,
      gGeom,
      shape.cornerRadiusFrac,
    );
    if (gradImg) {
      page.drawImage(gradImg, {
        x: boxX,
        y: boxYBottom,
        width: boxW,
        height: boxH,
        opacity: fillOpacity,
      });
    } else if (hasFill) {
      page.drawRectangle({
        x: boxX,
        y: boxYBottom,
        width: boxW,
        height: boxH,
        color: hexToRgb(shape.fillHex!),
        opacity: fillOpacity,
      });
    }
  }

  // Draw vector geometry (fill if no gradient/image filled it, plus border stroke)
  const drawVectorFill = hasFill && !shape.gradient && !shape.fillImage;
  if (drawVectorFill || hasBorder) {
    if (shape.geometry === 'ellipse') {
      page.drawEllipse({
        x: boxX + boxW / 2,
        y: boxYBottom + boxH / 2,
        xScale: boxW / 2,
        yScale: boxH / 2,
        color: drawVectorFill ? hexToRgb(shape.fillHex!) : undefined,
        opacity: drawVectorFill ? fillOpacity : undefined,
        borderColor: hasBorder ? hexToRgb(shape.borderHex!) : undefined,
        borderWidth: hasBorder ? borderWidth : undefined,
        borderOpacity: hasBorder ? borderOpacity : undefined,
      });
    } else if (shape.geometry === 'roundRect') {
      const r = Math.min(boxW, boxH) * (shape.cornerRadiusFrac ?? 0.14);
      const path = buildRoundedRectSvgPath(boxW, boxH, r);
      page.drawSvgPath(path, {
        x: boxX,
        y: boxYBottom + boxH,
        color: drawVectorFill ? hexToRgb(shape.fillHex!) : undefined,
        opacity: drawVectorFill ? fillOpacity : undefined,
        borderColor: hasBorder ? hexToRgb(shape.borderHex!) : undefined,
        borderWidth: hasBorder ? borderWidth : undefined,
        borderOpacity: hasBorder ? borderOpacity : undefined,
      });
    } else if (shape.geometry === 'triangle') {
      const triPath = `M ${boxW / 2} 0 L ${boxW} ${boxH} L 0 ${boxH} Z`;
      page.drawSvgPath(triPath, {
        x: boxX,
        y: boxYBottom + boxH,
        color: drawVectorFill ? hexToRgb(shape.fillHex!) : undefined,
        opacity: drawVectorFill ? fillOpacity : undefined,
        borderColor: hasBorder ? hexToRgb(shape.borderHex!) : undefined,
        borderWidth: hasBorder ? borderWidth : undefined,
        borderOpacity: hasBorder ? borderOpacity : undefined,
      });
    } else {
      page.drawRectangle({
        x: boxX,
        y: boxYBottom,
        width: boxW,
        height: boxH,
        color: drawVectorFill ? hexToRgb(shape.fillHex!) : undefined,
        opacity: drawVectorFill ? fillOpacity : undefined,
        borderColor: hasBorder ? hexToRgb(shape.borderHex!) : undefined,
        borderWidth: hasBorder ? borderWidth : undefined,
        borderOpacity: hasBorder ? borderOpacity : undefined,
      });
    }
  }

  if (shape.paragraphs.length === 0) {
    return flowCursorY;
  }

  // Render text paragraphs inside the shape frame with alignment, vertical centering, and smart auto-fit
  const cornerSafePad =
    shape.geometry === 'roundRect'
      ? Math.min(16, Math.max(9, Math.min(boxW, boxH) * (shape.cornerRadiusFrac ?? 0.14) * 0.42))
      : 6;
  const pad = shape.paddingPt
    ? {
        l: Math.max(shape.paddingPt.l, shape.geometry === 'roundRect' ? cornerSafePad : 0),
        t: Math.max(shape.paddingPt.t, shape.geometry === 'roundRect' ? Math.round(cornerSafePad * 0.75) : 0),
        r: Math.max(shape.paddingPt.r, shape.geometry === 'roundRect' ? cornerSafePad : 0),
        b: Math.max(shape.paddingPt.b, shape.geometry === 'roundRect' ? Math.round(cornerSafePad * 0.75) : 0),
      }
    : {
        l: cornerSafePad,
        t: shape.geometry === 'roundRect' ? Math.round(cornerSafePad * 0.85) : 5,
        r: cornerSafePad,
        b: shape.geometry === 'roundRect' ? Math.round(cornerSafePad * 0.85) : 5,
      };
  const innerX = boxX + pad.l;
  const innerW = Math.max(24, boxW - pad.l - pad.r);
  const innerH = Math.max(12, boxH - pad.t - pad.b);

  const shapeSurfaceDark = shape.fillHex
    ? getHexLuminance(shape.fillHex) < 0.42
    : shape.fillImage
      ? true
      : slideBgIsDark;

  interface LaidOutLine {
    text: string;
    font: PDFFont;
    size: number;
    lineH: number;
    colorHex: string;
    align: 'left' | 'center' | 'right';
    indent: number;
    paraGapAfter: number;
  }

  const layoutAtScale = (scale: number): { lines: LaidOutLine[]; totalH: number } => {
    const out: LaidOutLine[] = [];
    let totalH = 0;

    for (const para of shape.paragraphs) {
      const baseSize = Math.max(7, Math.min(48, para.fontSizePt ?? (shape.isTitle ? 26 : 14)));
      const size = Math.max(6.5, baseSize * scale);
      const font = pickFont(para.isBold, para.isItalic);
      const level = Math.max(0, Math.min(4, para.level ?? 0));
      const indent = (para.isBullet ? 10 : 0) + level * 12;
      const bulletPrefix = para.isBullet ? `${para.bulletChar ? sanitizeWinAnsi(para.bulletChar) : '\u2022'} ` : '';
      const rawText = `${bulletPrefix}${para.text}`;
      const wrapped = wrapTextToWidth(rawText, font, size, Math.max(20, innerW - indent));
      const lineH = size * 1.28;
      const paraGap = (shape.isTitle ? 6 : 4) * scale;
      const colorHex = para.colorHex ?? (shapeSurfaceDark ? '#ffffff' : '#0f172a');
      const align = para.align ?? 'left';

      for (let li = 0; li < wrapped.length; li++) {
        const gap = li === wrapped.length - 1 ? paraGap : 0;
        out.push({
          text: wrapped[li],
          font,
          size,
          lineH,
          colorHex,
          align,
          indent,
          paraGapAfter: gap,
        });
        totalH += lineH + gap;
      }
    }
    return { lines: out, totalH };
  };

  let laidOut = layoutAtScale(1);
  if (useExplicit && laidOut.totalH > innerH * 1.06 && innerH > 18) {
    // Gently shrink font up to 0.72x so wrapped text stays inside its card/frame cleanly
    const ratio = Math.max(0.72, Math.sqrt(innerH / laidOut.totalH));
    laidOut = layoutAtScale(ratio);
  }

  let cursorY: number;
  if (useExplicit) {
    const topY = boxYBottom + boxH - pad.t;
    if (shape.verticalAlign === 'middle' && laidOut.totalH < innerH) {
      cursorY = topY - (innerH - laidOut.totalH) / 2;
    } else if (shape.verticalAlign === 'bottom' && laidOut.totalH < innerH) {
      cursorY = topY - (innerH - laidOut.totalH);
    } else {
      cursorY = topY;
    }
  } else {
    cursorY = flowCursorY;
  }

  const minY = useExplicit ? Math.max(6, boxYBottom - 6) : 22;

  for (const line of laidOut.lines) {
    const baselineY = cursorY - line.size;
    if (baselineY < minY) break;

    const textW = line.font.widthOfTextAtSize(line.text, line.size);
    let drawX = innerX + line.indent;
    if (line.align === 'center') {
      drawX = innerX + Math.max(0, (innerW - textW) / 2);
    } else if (line.align === 'right') {
      drawX = innerX + Math.max(0, innerW - textW);
    }

    page.drawText(line.text, {
      x: drawX,
      y: baselineY,
      size: line.size,
      font: line.font,
      color: hexToRgb(line.colorHex),
    });
    cursorY -= line.lineH + line.paraGapAfter;
  }

  return useExplicit ? flowCursorY : Math.min(flowCursorY, cursorY - 8);
}

function drawStyledSlideTable(
  page: PDFPage,
  table: SlideTableElement,
  pageW: number,
  pageH: number,
  marginX: number,
  defaultTextWidth: number,
  flowCursorY: number,
  regularFont: PDFFont,
  boldFont: PDFFont,
): number {
  if (table.rows.length === 0) return flowCursorY;

  const colCount = Math.max(1, ...table.rows.map((r) => r.length));
  const useExplicit = table.hasPosition;
  const tblX = useExplicit ? Math.max(8, table.xFrac * pageW) : marginX;
  const tblW = useExplicit
    ? Math.max(60, Math.min(pageW - tblX - 8, table.wFrac * pageW))
    : defaultTextWidth;
  const tblH = useExplicit ? Math.max(24, table.hFrac * pageH) : table.rows.length * 22;
  let cursorY = useExplicit ? pageH - table.yFrac * pageH : Math.min(flowCursorY, pageH * 0.55);

  const colWidths =
    table.colWidthFracs && table.colWidthFracs.length === colCount
      ? table.colWidthFracs.map((f) => f * tblW)
      : new Array<number>(colCount).fill(tblW / colCount);

  const rowH = Math.max(16, Math.min(34, tblH / table.rows.length));

  for (let rIdx = 0; rIdx < table.rows.length; rIdx++) {
    if (cursorY - rowH < 10) break;
    const isHeader = rIdx === 0;
    const row = table.rows[rIdx];
    let cellX = tblX;

    for (let cIdx = 0; cIdx < colCount; cIdx++) {
      const colW = colWidths[cIdx] ?? tblW / colCount;
      const cell = row[cIdx];
      const cellFillHex =
        cell?.fillHex ??
        (isHeader ? '#1e293b' : rIdx % 2 === 1 ? '#f8fafc' : '#ffffff');

      page.drawRectangle({
        x: cellX,
        y: cursorY - rowH,
        width: colW,
        height: rowH,
        color: hexToRgb(cellFillHex),
        borderColor: hexToRgb(table.borderHex ?? '#cbd5e1'),
        borderWidth: 0.55,
      });

      const cellText = cell?.text ?? '';
      if (cellText) {
        const font = cell?.isBold || isHeader ? boldFont : regularFont;
        const fSize = Math.max(7.5, Math.min(11, cell?.fontSizePt ?? 9));
        const clipped = clipTextToWidth(cellText, font, fSize, Math.max(10, colW - 8));
        const txtW = font.widthOfTextAtSize(clipped, fSize);
        let drawX = cellX + 4;
        if (cell?.align === 'center') drawX = cellX + Math.max(4, (colW - txtW) / 2);
        else if (cell?.align === 'right') drawX = cellX + Math.max(4, colW - txtW - 4);

        const defaultTxtHex = getHexLuminance(cellFillHex) < 0.42 ? '#ffffff' : '#0f172a';
        page.drawText(clipped, {
          x: drawX,
          y: cursorY - rowH + Math.max(4, (rowH - fSize) / 2 + 1),
          size: fSize,
          font,
          color: hexToRgb(cell?.textColorHex ?? defaultTxtHex),
        });
      }

      cellX += colW;
    }

    cursorY -= rowH;
  }

  return useExplicit ? flowCursorY : Math.min(flowCursorY, cursorY - 12);
}

/**
 * Converts a PowerPoint (.pptx / .pptm / .ppsx / .potx) presentation into a rich multi-page PDF
 * preserving slide aspect ratio, theme/master/layout backgrounds & frames, grouped shapes,
 * rounded cards, borders, cropped/masked images, positioned tables, and styled typography.
 */
export async function pptxToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(5);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = await parsePptxArchive(zip);
  if (slides.length === 0) {
    throw new Error('No slides found inside this PowerPoint presentation.');
  }
  return renderRichSlidesToPdf(slides, { file, label: 'PowerPoint', zip }, onProgress);
}

function clipTextToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const safe = sanitizeWinAnsi(text);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  const ellipsis = '...';
  const ellipsisW = font.widthOfTextAtSize(ellipsis, size);
  let out = '';
  for (const ch of safe) {
    if (font.widthOfTextAtSize(out + ch, size) + ellipsisW <= maxWidth) {
      out += ch;
    } else {
      break;
    }
  }
  return out ? `${out}${ellipsis}` : safe.slice(0, 1);
}

/** Reads an .xlsx, .ods, .csv, or .tsv File into structured worksheets. */
export async function parseSpreadsheetFile(file: File): Promise<ParsedSheet[]> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';

  if (ext === 'csv') {
    const rows = parseCsvRows(await file.text());
    return [{ name: sanitizeBaseName(file.name), rows }];
  }

  if (ext === 'tsv') {
    const rows = parseTsvRows(await file.text());
    return [{ name: sanitizeBaseName(file.name), rows }];
  }

  if (ext === 'ods') {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const contentFile = zip.file('content.xml');
    if (!contentFile) {
      throw new Error('Could not find content.xml inside this .ods spreadsheet.');
    }
    const sheets = parseOdsContentXml(await contentFile.async('string'));
    if (sheets.length === 0) {
      throw new Error('No populated rows were found in this .ods spreadsheet.');
    }
    return sheets;
  }

  if (ext === 'xls') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sheets = extractSheetsFromLegacyXls(bytes, sanitizeBaseName(file.name));
    if (sheets.length === 0) {
      throw new Error(
        'Could not extract worksheet cells from this legacy .xls file. It may be password-protected or corrupted.',
      );
    }
    return sheets;
  }

  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xltx') {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const sharedStringsFile = zip.file('xl/sharedStrings.xml');
    const sharedStrings = sharedStringsFile
      ? parseXlsxSharedStringsXml(await sharedStringsFile.async('string'))
      : [];

    const sheetSpecs: Array<{ name: string; path: string }> = [];
    const workbookFile = zip.file('xl/workbook.xml');
    const relsFile = zip.file('xl/_rels/workbook.xml.rels');

    if (workbookFile && relsFile) {
      const wbXml = await workbookFile.async('string');
      const relMap = parseRelationshipMap(await relsFile.async('string'));
      const sheetRe = /<sheet\b[^>]*>/gi;
      let sm: RegExpExecArray | null;
      while ((sm = sheetRe.exec(wbXml)) !== null) {
        const tag = sm[0];
        const nameMatch = /\bname="([^"]+)"/.exec(tag);
        const rIdMatch = /\br:id="([^"]+)"/.exec(tag);
        if (!rIdMatch) continue;
        const target = relMap.get(rIdMatch[1]);
        if (!target) continue;
        const fullPath = resolveZipTargetPath('xl', target);
        if (zip.file(fullPath)) {
          sheetSpecs.push({
            name: nameMatch ? decodeXmlEntities(nameMatch[1]) : `Sheet ${sheetSpecs.length + 1}`,
            path: fullPath,
          });
        }
      }
    }

    // Fallback: enumerate xl/worksheets/sheetN.xml
    if (sheetSpecs.length === 0) {
      const found: Array<{ num: number; path: string }> = [];
      zip.forEach((relPath, entry) => {
        if (entry.dir) return;
        const m = /^xl\/worksheets\/sheet(\d+)\.xml$/i.exec(relPath);
        if (m) found.push({ num: Number.parseInt(m[1], 10), path: relPath });
      });
      found.sort((a, b) => a.num - b.num);
      for (const item of found) {
        sheetSpecs.push({ name: `Sheet ${item.num}`, path: item.path });
      }
    }

    const sheets: ParsedSheet[] = [];
    for (const spec of sheetSpecs) {
      const wsXml = await zip.file(spec.path)!.async('string');
      const rows = parseXlsxWorksheetXml(wsXml, sharedStrings);
      if (rows.length > 0) {
        sheets.push({ name: spec.name, rows });
      }
    }

    if (sheets.length === 0) {
      throw new Error(`No populated worksheets found inside this .${ext} workbook.`);
    }
    return sheets;
  }

  throw new Error(
    `Unsupported spreadsheet format ".${ext}". Use .xlsx, .xlsm, .xltx, .xls, .ods, .csv, or .tsv.`,
  );
}

/**
 * Converts Excel (.xlsx), OpenDocument (.ods), CSV, or TSV spreadsheets into a crisp,
 * multi-sheet auto-fitted PDF with styled headers, alternating rows, and automatic pagination.
 */
export async function spreadsheetToPdf(
  file: File,
  orientationMode: 'auto' | 'portrait' | 'landscape' = 'auto',
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(10);
  const sheets = await parseSpreadsheetFile(file);
  const pdfDoc = await PDFDocument.create();
  const baseName = sanitizeBaseName(file.name);
  pdfDoc.setTitle(baseName);
  pdfDoc.setCreator('FolioPDF');

  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const margin = 34;
  let totalPagesCreated = 0;

  for (let sIdx = 0; sIdx < sheets.length; sIdx++) {
    const sheet = sheets[sIdx];
    const maxCols = Math.max(1, ...sheet.rows.map((r) => r.length));

    const useLandscape =
      orientationMode === 'landscape' || (orientationMode === 'auto' && maxCols > 5);
    const pageW = useLandscape ? 841.89 : 595.28;
    const pageH = useLandscape ? 595.28 : 841.89;
    const contentW = pageW - margin * 2;

    // Split ultra-wide sheets (> 12 columns) into horizontal column bands so text stays legible
    const maxColsPerBand = useLandscape ? 12 : 7;
    const colBands: Array<{ start: number; end: number }> = [];
    for (let start = 0; start < maxCols; start += maxColsPerBand) {
      colBands.push({ start, end: Math.min(maxCols, start + maxColsPerBand) });
    }

    const headerRow = sheet.rows[0] ?? [];

    for (let bandIdx = 0; bandIdx < colBands.length; bandIdx++) {
      const band = colBands[bandIdx];
      const bandColCount = band.end - band.start;

      // Compute proportional column widths from first 60 rows
      const sampleRows = sheet.rows.slice(0, 60);
      const weights: number[] = [];
      for (let c = band.start; c < band.end; c++) {
        let maxLen = 4;
        for (const r of sampleRows) {
          maxLen = Math.max(maxLen, (r[c] ?? '').length);
        }
        weights.push(Math.min(36, maxLen + 2));
      }
      const totalWeight = weights.reduce((a, b) => a + b, 0) || bandColCount;
      const colWidths = weights.map((w) => (w / totalWeight) * contentW);

      const fontSize = bandColCount >= 9 ? 7.5 : bandColCount >= 6 ? 8.5 : 9.5;
      const rowHeight = Math.round(fontSize * 2.15);

      let page: PDFPage | null = null;
      let cursorY = 0;
      let sheetPageNum = 0;

      const startNewSheetPage = () => {
        page = pdfDoc.addPage([pageW, pageH]);
        totalPagesCreated++;
        sheetPageNum++;
        cursorY = pageH - margin;

        // Sheet banner header
        const bandSuffix =
          colBands.length > 1 ? ` (Cols ${band.start + 1}–${band.end})` : '';
        const contSuffix = sheetPageNum > 1 ? ` · cont.` : '';
        const heading = sanitizeWinAnsi(`${sheet.name}${bandSuffix}${contSuffix}`);
        page.drawText(heading, {
          x: margin,
          y: cursorY - 12,
          size: 12.5,
          font: boldFont,
          color: rgb(0.06, 0.09, 0.16),
        });

        const metaText = `${sheet.rows.length} rows × ${maxCols} cols`;
        const metaW = regularFont.widthOfTextAtSize(metaText, 8.5);
        page.drawText(metaText, {
          x: pageW - margin - metaW,
          y: cursorY - 11,
          size: 8.5,
          font: regularFont,
          color: rgb(0.42, 0.48, 0.56),
        });

        cursorY -= 24;
      };

      const drawRow = (row: string[], isHeader: boolean, zebraIndex: number) => {
        if (!page || cursorY - rowHeight < margin + 12) {
          startNewSheetPage();
          if (!isHeader && headerRow.length > 0 && sheet.rows.length > 1) {
            drawRow(headerRow, true, 0);
          }
        }
        const activePage = page!;

        activePage.drawRectangle({
          x: margin,
          y: cursorY - rowHeight,
          width: contentW,
          height: rowHeight,
          color: isHeader
            ? rgb(0.12, 0.16, 0.23)
            : zebraIndex % 2 === 1
              ? rgb(0.97, 0.98, 0.99)
              : rgb(1, 1, 1),
          borderColor: rgb(0.84, 0.87, 0.91),
          borderWidth: 0.5,
        });

        let xCursor = margin;
        for (let localC = 0; localC < bandColCount; localC++) {
          const absC = band.start + localC;
          const colW = colWidths[localC];
          const val = row[absC] ?? '';
          const font = isHeader ? boldFont : regularFont;
          const clipped = clipTextToWidth(val, font, fontSize, Math.max(12, colW - 8));

          if (localC > 0) {
            activePage.drawLine({
              start: { x: xCursor, y: cursorY },
              end: { x: xCursor, y: cursorY - rowHeight },
              thickness: 0.4,
              color: isHeader ? rgb(0.24, 0.3, 0.4) : rgb(0.86, 0.89, 0.93),
            });
          }

          if (clipped) {
            activePage.drawText(clipped, {
              x: xCursor + 4,
              y: cursorY - rowHeight + Math.max(4, (rowHeight - fontSize) / 2 + 1),
              size: fontSize,
              font,
              color: isHeader ? rgb(1, 1, 1) : rgb(0.1, 0.14, 0.2),
            });
          }

          xCursor += colW;
        }

        cursorY -= rowHeight;
      };

      startNewSheetPage();
      for (let rIdx = 0; rIdx < sheet.rows.length; rIdx++) {
        drawRow(sheet.rows[rIdx], rIdx === 0 && sheet.rows.length > 1, rIdx);
      }
    }

    onProgress?.(15 + Math.round(((sIdx + 1) / sheets.length) * 80));
    await new Promise((r) => setTimeout(r, 0));
  }

  const outBytes = await pdfDoc.save({ useObjectStreams: true });
  onProgress?.(100);
  const blob = new Blob([outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer], {
    type: 'application/pdf',
  });
  return makeResult(blob, `${baseName}.pdf`, {
    originalBytes: file.size,
    pageCount: totalPagesCreated,
    summary: `Converted ${sheets.length} worksheet(s) into a ${totalPagesCreated}-page vector PDF table.`,
  });
}

/**
 * Exports a PDF to PowerPoint (.pptx):
 * - 'editable': Places extracted PDF text lines as real editable PowerPoint text boxes at exact coordinates.
 * - 'visual': Renders each PDF page at 150 DPI as a full-bleed slide image preserving exact charts & visuals.
 */
export async function pdfToPptx(
  file: File,
  mode: 'editable' | 'visual',
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  const baseName = sanitizeBaseName(file.name);

  if (mode === 'editable') {
    const doc = await openPdfJsDocument(file);
    const pageDims: Array<{ widthPt: number; heightPt: number }> = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const vp = p.getViewport({ scale: 1 });
        pageDims.push({ widthPt: vp.width, heightPt: vp.height });
        p.cleanup();
      }
    } finally {
      await closePdfJsDocument(doc);
    }

    const lines = await extractAllPagesEditableTextLines(file, (pct) =>
      onProgress?.(Math.round(pct * 0.85)),
    );

    const slides = pageDims.map((dims, pageIdx) => ({
      widthPt: dims.widthPt,
      heightPt: dims.heightPt,
      lines: lines
        .filter((l) => l.pageIndex === pageIdx)
        .map((l) => ({
          text: l.text,
          x: l.x,
          y: l.y,
          width: l.width,
          height: l.height,
          fontSizePt: l.fontSizePt,
          isBold: l.isBold,
          isItalic: l.isItalic,
        })),
    }));

    const pptxBlob = await buildEditablePptxBlob(slides);
    onProgress?.(100);
    return makeResult(pptxBlob, `${baseName}.pptx`, {
      originalBytes: file.size,
      pageCount: slides.length,
      summary: `Exported ${slides.length} PDF page(s) to an editable PowerPoint (.pptx) deck (${lines.length} text boxes).`,
    });
  }

  // Visual slide deck mode (150 DPI page snapshots)
  const doc = await openPdfJsDocument(file);
  const slides: Array<{ widthPt: number; heightPt: number; jpegBytes: Uint8Array }> = [];
  try {
    const scale = 150 / 72;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const { canvas } = await renderPdfPageToCanvas(doc, i, scale);
      const jpgBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b: Blob | null) => (b ? resolve(b) : reject(new Error('Failed to encode slide image.'))),
          'image/jpeg',
          0.88,
        );
      });
      const jpegBytes = new Uint8Array(await jpgBlob.arrayBuffer());
      slides.push({ widthPt: vp.width, heightPt: vp.height, jpegBytes });
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      onProgress?.(Math.round((i / doc.numPages) * 88));
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    await closePdfJsDocument(doc);
  }

  const pptxBlob = await buildVisualPptxBlob(slides);
  onProgress?.(100);
  return makeResult(pptxBlob, `${baseName}-slides.pptx`, {
    originalBytes: file.size,
    pageCount: slides.length,
    summary: `Exported ${slides.length} PDF page(s) as exact visual PowerPoint (.pptx) slides at 150 DPI.`,
  });
}

/**
 * Exports a PDF to a structured Excel / Sheets workbook (.xlsx) using coordinate-aware
 * row & column reconstruction across every page.
 */
export async function pdfToXlsx(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  const baseName = sanitizeBaseName(file.name);
  const doc = await openPdfJsDocument(file);
  const numPages = doc.numPages;
  await closePdfJsDocument(doc);

  const allLines = await extractAllPagesEditableTextLines(file, (pct) =>
    onProgress?.(Math.round(pct * 0.85)),
  );

  const sheets: ParsedSheet[] = [];
  const combinedRows: string[][] = [];

  for (let p = 0; p < numPages; p++) {
    const pageLines = allLines.filter((l) => l.pageIndex === p);
    const rows = groupPdfLinesIntoSheetRows(pageLines);
    sheets.push({
      name: `Page ${p + 1}`,
      rows: rows.length > 0 ? rows : [['(No selectable text on this page)']],
    });
    if (rows.length > 0) {
      if (numPages > 1) combinedRows.push([`--- Page ${p + 1} ---`]);
      combinedRows.push(...rows);
    }
  }

  if (numPages > 1 && combinedRows.length > 0) {
    sheets.unshift({ name: 'All Pages', rows: combinedRows });
  }

  const xlsxBlob = await buildXlsxBlob(sheets);
  onProgress?.(100);
  return makeResult(xlsxBlob, `${baseName}.xlsx`, {
    originalBytes: file.size,
    pageCount: numPages,
    summary: `Exported ${numPages} PDF page(s) into a structured Excel / Sheets workbook (.xlsx) with ${sheets.length} sheet(s).`,
  });
}

/**
 * Exports a PDF to RFC-4180 CSV using coordinate-aware row & column reconstruction.
 */
export async function pdfToCsv(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  const baseName = sanitizeBaseName(file.name);
  const doc = await openPdfJsDocument(file);
  const numPages = doc.numPages;
  await closePdfJsDocument(doc);

  const allLines = await extractAllPagesEditableTextLines(file, (pct) =>
    onProgress?.(Math.round(pct * 0.9)),
  );

  const allRows: string[][] = [];
  for (let p = 0; p < numPages; p++) {
    const pageLines = allLines.filter((l) => l.pageIndex === p);
    const rows = groupPdfLinesIntoSheetRows(pageLines);
    if (rows.length > 0) {
      if (numPages > 1) allRows.push([`Page ${p + 1}`]);
      allRows.push(...rows);
    }
  }

  const csvText = rowsToCsv(allRows);
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  onProgress?.(100);
  return makeResult(blob, `${baseName}.csv`, {
    originalBytes: file.size,
    pageCount: numPages,
    extraText: csvText,
    summary: `Extracted ${allRows.length} structured row(s) from ${numPages} PDF page(s) to CSV.`,
  });
}

/** Converts legacy PowerPoint 97–2003 (.ppt) binary presentations into rich PDF slides. */
export async function legacyPptToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(8);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const slides = extractRichSlidesFromLegacyPpt(bytes);
  return renderRichSlidesToPdf(slides, { file, label: 'PowerPoint (.ppt)' }, onProgress);
}

/** Converts OpenDocument Presentation (.odp) files into rich positioned PDF slides. */
export async function odpToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(8);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const contentFile = zip.file('content.xml');
  if (!contentFile) {
    throw new Error('Could not find content.xml inside this .odp presentation.');
  }
  const stylesFile = zip.file('styles.xml');
  const stylesXml = stylesFile ? await stylesFile.async('string') : undefined;
  const slides = parseRichOdpXml(await contentFile.async('string'), stylesXml);
  return renderRichSlidesToPdf(slides, { file, label: 'OpenDocument (.odp)', zip }, onProgress);
}

/** Shared structured document + tables -> crisp vector A4 PDF renderer. */
async function renderDocumentBlocksAndTablesToPdf(
  blocks: StructuredTextBlock[],
  tables: string[][][],
  file: File,
  label: string,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  if (blocks.length === 0 && tables.length === 0) {
    throw new Error(`No readable content was found inside "${file.name}".`);
  }

  const pdfDoc = await PDFDocument.create();
  const baseName = sanitizeBaseName(file.name);
  pdfDoc.setTitle(baseName);
  pdfDoc.setCreator('FolioPDF');

  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageW = 595.28;
  const pageH = 841.89;
  const margin = 46;
  const contentW = pageW - margin * 2;

  let page = pdfDoc.addPage([pageW, pageH]);
  let cursorY = pageH - margin;

  const ensureSpace = (needed: number) => {
    if (cursorY - needed < margin) {
      page = pdfDoc.addPage([pageW, pageH]);
      cursorY = pageH - margin;
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i];
    if (blk.type === 'divider') {
      ensureSpace(16);
      page.drawLine({
        start: { x: margin, y: cursorY - 6 },
        end: { x: pageW - margin, y: cursorY - 6 },
        thickness: 0.7,
        color: rgb(0.82, 0.85, 0.9),
      });
      cursorY -= 16;
      continue;
    }

    const isHeading = blk.type === 'heading';
    const isSub = blk.type === 'subheading';
    const isBullet = blk.type === 'bullet';
    const fontSize = isHeading ? 18 : isSub ? 13.5 : 10.5;
    const font = isHeading || isSub ? boldFont : regularFont;
    const lineH = fontSize * 1.42;
    const prefix = isBullet ? '* ' : '';
    const indent = isBullet ? 12 : 0;

    const wrapped = wrapTextToWidth(`${prefix}${blk.text}`, font, fontSize, contentW - indent);
    if (isHeading) cursorY -= 4;
    for (const line of wrapped) {
      ensureSpace(lineH);
      page.drawText(line, {
        x: margin + indent,
        y: cursorY - fontSize,
        size: fontSize,
        font,
        color: isHeading
          ? rgb(0.06, 0.09, 0.16)
          : isSub
            ? rgb(0.15, 0.21, 0.3)
            : rgb(0.18, 0.23, 0.31),
      });
      cursorY -= lineH;
    }
    cursorY -= isHeading ? 8 : isSub ? 5 : 4;

    if (i % 50 === 0) onProgress?.(10 + Math.round((i / Math.max(1, blocks.length)) * 65));
  }

  // Render document tables cleanly
  for (const table of tables) {
    if (table.length === 0) continue;
    cursorY -= 8;
    const colCount = Math.max(1, ...table.map((r) => r.length));
    const colW = contentW / colCount;
    const rowH = 20;

    for (let rIdx = 0; rIdx < table.length; rIdx++) {
      ensureSpace(rowH + 2);
      const isHeader = rIdx === 0 && table.length > 1;
      page.drawRectangle({
        x: margin,
        y: cursorY - rowH,
        width: contentW,
        height: rowH,
        color: isHeader
          ? rgb(0.12, 0.16, 0.23)
          : rIdx % 2 === 1
            ? rgb(0.97, 0.98, 0.99)
            : rgb(1, 1, 1),
        borderColor: rgb(0.84, 0.87, 0.91),
        borderWidth: 0.5,
      });

      for (let cIdx = 0; cIdx < colCount; cIdx++) {
        const font = isHeader ? boldFont : regularFont;
        const val = clipTextToWidth(table[rIdx][cIdx] ?? '', font, 9, Math.max(14, colW - 8));
        page.drawText(val, {
          x: margin + cIdx * colW + 4,
          y: cursorY - rowH + 6,
          size: 9,
          font,
          color: isHeader ? rgb(1, 1, 1) : rgb(0.12, 0.16, 0.23),
        });
      }
      cursorY -= rowH;
    }
    cursorY -= 10;
  }

  const outBytes = await pdfDoc.save({ useObjectStreams: true });
  onProgress?.(100);
  const blob = new Blob([outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer], {
    type: 'application/pdf',
  });
  return makeResult(blob, `${baseName}.pdf`, {
    originalBytes: file.size,
    pageCount: pdfDoc.getPageCount(),
    summary: `Converted ${label} document into a ${pdfDoc.getPageCount()}-page vector PDF${
      tables.length > 0 ? ` (${tables.length} table(s) formatted)` : ''
    }.`,
  });
}

/** Converts modern Word (.docx, .docm, .dotx) files into vector PDF preserving headings, bullets, and tables. */
export async function enhancedDocxToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(8);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) {
    throw new Error(`Could not find word/document.xml inside "${file.name}".`);
  }
  const { blocks, tables } = parseEnhancedDocxXml(await docXmlFile.async('string'));
  return renderDocumentBlocksAndTablesToPdf(blocks, tables, file, 'Word (.docx)', onProgress);
}

/** Converts OpenDocument Text (.odt) files into vector PDF. */
export async function odtToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(8);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const contentFile = zip.file('content.xml');
  if (!contentFile) {
    throw new Error('Could not find content.xml inside this .odt document.');
  }
  const { blocks, tables } = parseOdtContentXml(await contentFile.async('string'));
  return renderDocumentBlocksAndTablesToPdf(blocks, tables, file, 'OpenDocument (.odt)', onProgress);
}

/** Converts legacy Word 97–2003 (.doc) files (OLE2, RTF-disguised, or HTML-disguised) into PDF. */
export async function legacyDocToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(10);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const blocks = extractBlocksFromLegacyDoc(bytes);
  return renderDocumentBlocksAndTablesToPdf(blocks, [], file, 'Word (.doc)', onProgress);
}

/** Converts Rich Text Format (.rtf) files into vector PDF. */
export async function rtfToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(10);
  const text = await file.text();
  const blocks = parseRtfToBlocks(text);
  return renderDocumentBlocksAndTablesToPdf(blocks, [], file, 'Rich Text (.rtf)', onProgress);
}

/** Converts E-Book (.epub) chapters into a clean multi-page vector PDF. */
export async function epubToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(8);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const chapterPaths: string[] = [];

  // Attempt OPF spine ordering first
  let opfPath: string | null = null;
  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const containerXml = await containerFile.async('string');
    const rf = /full-path="([^"]+)"/i.exec(containerXml);
    if (rf) opfPath = rf[1];
  }
  if (opfPath && zip.file(opfPath)) {
    const opfXml = await zip.file(opfPath)!.async('string');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const manifest = new Map<string, string>();
    const itemRe = /<item\b[^>]*>/gi;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(opfXml)) !== null) {
      const id = /\bid="([^"]+)"/.exec(im[0])?.[1];
      const href = /\bhref="([^"]+)"/.exec(im[0])?.[1];
      if (id && href) manifest.set(id, href);
    }
    const itemrefRe = /<itemref\b[^>]*idref="([^"]+)"/gi;
    let rm: RegExpExecArray | null;
    while ((rm = itemrefRe.exec(opfXml)) !== null) {
      const href = manifest.get(rm[1]);
      if (href) {
        const full = resolveZipTargetPath(opfDir, href);
        if (zip.file(full)) chapterPaths.push(full);
      }
    }
  }

  // Fallback: discover .xhtml/.html files in zip
  if (chapterPaths.length === 0) {
    zip.forEach((relPath, entry) => {
      if (!entry.dir && /\.(xhtml|html|htm)$/i.test(relPath) && !/toc|nav/i.test(relPath)) {
        chapterPaths.push(relPath);
      }
    });
    chapterPaths.sort();
  }

  const allBlocks: StructuredTextBlock[] = [];
  for (let i = 0; i < chapterPaths.length; i++) {
    const html = await zip.file(chapterPaths[i])!.async('string');
    const chapterBlocks = stripHtmlToBlocks(html);
    if (chapterBlocks.length > 0) {
      if (allBlocks.length > 0) allBlocks.push({ type: 'divider', text: '' });
      allBlocks.push(...chapterBlocks);
    }
    onProgress?.(10 + Math.round(((i + 1) / Math.max(1, chapterPaths.length)) * 40));
  }

  return renderDocumentBlocksAndTablesToPdf(allBlocks, [], file, 'EPUB (.epub)', onProgress);
}

