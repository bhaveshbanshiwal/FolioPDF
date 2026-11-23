import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
} from '@cantoo/pdf-lib';
import JSZip from 'jszip';
import type {
  CreatePdfBlock,
  PageOverlayItem,
  PdfFontFamilyKey,
  PdfFormFieldSummary,
  ToolResult,
} from '../types/tools';
import {
  extractHtmlTitle,
  normalizeWebpageUrl,
  parseCsvRows,
  parseJinaReaderResponse,
  parseMarkdownToBlocks,
  parsePageRanges,
  sanitizeBaseName,
  splitRangesIntoGroups,
  stripHtmlToBlocks,
  type StructuredTextBlock,
} from '../utils/pdfUtils';
import {
  pdfToCsv,
  pdfToPptx,
  pdfToXlsx,
  pptxToPdf,
  spreadsheetToPdf,
} from './officeConverter';
import {
  closePdfJsDocument,
  extractPdfTextByPage,
  openPdfJsDocument,
  renderPdfPageToCanvas,
} from './pdfRenderer';

export function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buf], { type: mimeType });
}

export function buildResultFromBytes(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  meta: Partial<ToolResult> = {},
): ToolResult {
  const blob = bytesToBlob(bytes, mimeType);
  return {
    blob,
    url: URL.createObjectURL(blob),
    fileName,
    mimeType,
    outputBytes: blob.size,
    ...meta,
  };
}

export function buildResultFromBlob(
  blob: Blob,
  fileName: string,
  meta: Partial<ToolResult> = {},
): ToolResult {
  return {
    blob,
    url: URL.createObjectURL(blob),
    fileName,
    mimeType: blob.type || 'application/octet-stream',
    outputBytes: blob.size,
    ...meta,
  };
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return [0.06, 0.09, 0.16];
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

function wrapTextToLines(
  text: string,
  font: { widthOfTextAtSize: (t: string, s: number) => number },
  fontSize: number,
  maxWidth: number,
): string[] {
  const safeText = text.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, ' ');
  const paragraphs = safeText.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${current} ${words[i]}`;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Generates a crisp multi-page sample PDF locally (including an embedded raster diagram)
 * so users can test every single tool immediately without uploading a file.
 */
export async function createSamplePdf(variant: 'v1' | 'v2' | 'stamp' = 'v1'): Promise<File> {
  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  if (variant === 'stamp') {
    const page = doc.addPage([595.28, 841.89]);
    page.drawRectangle({
      x: 32,
      y: 780,
      width: 531,
      height: 32,
      color: rgb(0.95, 0.96, 0.98),
      borderColor: rgb(0.88, 0.11, 0.28),
      borderWidth: 1,
    });
    page.drawText('CONFIDENTIAL · INTERNAL REVIEW COPY · FOLIO STUDIO', {
      x: 52,
      y: 791,
      size: 11,
      font: fontBold,
      color: rgb(0.88, 0.11, 0.28),
    });
    page.drawText('APPROVED LETTERHEAD', {
      x: 130,
      y: 420,
      size: 32,
      font: fontBold,
      color: rgb(0.88, 0.11, 0.28),
      opacity: 0.2,
      rotate: degrees(32),
    });
    const bytes = await doc.save();
    return new File([bytesToBlob(bytes, 'application/pdf')], 'sample-letterhead-overlay.pdf', {
      type: 'application/pdf',
    });
  }

  // Embed a crisp generated chart PNG into Page 1 so Extract PDF Images has real embedded images
  const chartCanvas = document.createElement('canvas');
  chartCanvas.width = 480;
  chartCanvas.height = 180;
  const ctx = chartCanvas.getContext('2d');
  let embeddedChart: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  if (ctx) {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, 480, 180);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(1, 1, 478, 178);
    const bars = variant === 'v1' ? [72, 95, 118, 134, 148] : [72, 108, 126, 152, 162];
    const labels = ['Q1', 'Q2', 'Q3', 'Q4', 'Proj'];
    bars.forEach((h, idx) => {
      const x = 44 + idx * 84;
      ctx.fillStyle = idx === 4 ? '#e11d48' : '#0f172a';
      ctx.fillRect(x, 150 - h, 46, h);
      ctx.fillStyle = '#475569';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(labels[idx], x + 10, 170);
    });
    const pngDataUrl = chartCanvas.toDataURL('image/png');
    const pngBytes = dataUrlToUint8Array(pngDataUrl);
    embeddedChart = await doc.embedPng(pngBytes);
  }

  const pageSpecs = [
    {
      title: variant === 'v1' ? 'Quarterly Operations Brief — Draft v1' : 'Quarterly Operations Brief — Revised v2',
      subtitle: variant === 'v1' ? 'Prepared October 2026 · Northwind Systems' : 'Prepared November 2026 · Northwind Systems (Final)',
      paragraphs: [
        variant === 'v1'
          ? 'This brief summarizes regional throughput, quality benchmarks, and local document workflows across four operating hubs.'
          : 'This revised brief summarizes regional throughput, updated quality benchmarks, and browser-native workflows across five operating hubs.',
        'All figures below were compiled locally without cloud uploads. Use this sample document to test merging, splitting, rotating, signing, watermarking, redaction, and OCR.',
        variant === 'v1'
          ? 'Projected Q4 target: $148,000 net savings with 99.2% on-time delivery.'
          : 'Updated Q4 target: $162,000 net savings with 99.7% on-time delivery.',
      ],
    },
    {
      title: 'Section 2: Architecture & Security Review',
      subtitle: 'Page 2 · Compliance & Retention Controls',
      paragraphs: [
        'Client-side processing ensures sensitive contracts, invoices, and scanned archives stay strictly inside the user browser tab.',
        'Redacted clauses: Account Reference #4829-ALPHA and Billing Contact jane.doe@example.com should be masked before external distribution.',
        variant === 'v1'
          ? 'Review Sign-off: Pending legal approval.'
          : 'Review Sign-off: Approved by Legal & Operations.',
      ],
    },
    {
      title: 'Section 3: Execution Checklist & Signatures',
      subtitle: 'Page 3 · Final Approval',
      paragraphs: [
        '1. Verify page order and remove any draft appendices before distribution.',
        '2. Apply document page numbers and company letterhead overlay.',
        '3. Protect final archive with AES-256 password encryption.',
      ],
    },
  ];

  pageSpecs.forEach((spec, idx) => {
    const page = doc.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 0, y: 825, width: 595.28, height: 16.89, color: rgb(0.88, 0.11, 0.28) });
    page.drawText(spec.title, { x: 54, y: 760, size: 19, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
    page.drawText(spec.subtitle, { x: 54, y: 736, size: 10.5, font: fontReg, color: rgb(0.39, 0.45, 0.55) });
    page.drawLine({
      start: { x: 54, y: 722 },
      end: { x: 541, y: 722 },
      thickness: 0.75,
      color: rgb(0.82, 0.85, 0.9),
    });

    let y = 690;
    for (const para of spec.paragraphs) {
      const lines = wrapTextToLines(para, fontReg, 11.5, 486);
      for (const line of lines) {
        page.drawText(line, { x: 54, y, size: 11.5, font: fontReg, color: rgb(0.15, 0.2, 0.29) });
        y -= 18;
      }
      y -= 12;
    }

    if (idx === 0 && embeddedChart) {
      page.drawImage(embeddedChart, { x: 54, y: y - 165, width: 420, height: 158 });
    }

    if (idx === 2) {
      page.drawRectangle({
        x: 54,
        y: 340,
        width: 220,
        height: 70,
        borderColor: rgb(0.75, 0.8, 0.86),
        borderWidth: 1,
      });
      page.drawText('Authorized Signature Area', {
        x: 64,
        y: 324,
        size: 9.5,
        font: fontReg,
        color: rgb(0.45, 0.5, 0.58),
      });
    }

    page.drawText(`Sample Document (${variant.toUpperCase()}) · Page ${idx + 1} of 3`, {
      x: 54,
      y: 36,
      size: 9,
      font: fontReg,
      color: rgb(0.55, 0.6, 0.68),
    });
  });

  const bytes = await doc.save();
  const fileName = variant === 'v1' ? 'sample-operations-brief-v1.pdf' : 'sample-operations-brief-v2.pdf';
  return new File([bytesToBlob(bytes, 'application/pdf')], fileName, { type: 'application/pdf' });
}

export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 1. Merge PDF */
export async function mergePdfs(
  items: Array<{ file: File; range?: string }>,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  const merged = await PDFDocument.create();
  let originalBytes = 0;

  for (let i = 0; i < items.length; i++) {
    const { file, range } = items[i];
    originalBytes += file.size;
    const srcBytes = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: false });
    const total = srcDoc.getPageCount();
    const parsed = parsePageRanges(range ?? '', total, { deduplicate: false });
    if (parsed.error) {
      throw new Error(`${file.name}: ${parsed.error}`);
    }
    const zeroIndices = parsed.pages.map((p) => p - 1);
    const copied = await merged.copyPages(srcDoc, zeroIndices);
    copied.forEach((p) => merged.addPage(p));
    onProgress?.(Math.round(((i + 1) / items.length) * 90));
  }

  const outBytes = await merged.save({ useObjectStreams: true });
  onProgress?.(100);
  return buildResultFromBytes(outBytes, 'merged-document.pdf', 'application/pdf', {
    originalBytes,
    pageCount: merged.getPageCount(),
    summary: `Merged ${items.length} PDFs into ${merged.getPageCount()} pages.`,
  });
}

/** 2. Split PDF */
export async function splitPdf(
  file: File,
  mode: 'ranges' | 'every-n' | 'all-pages',
  rangeText: string,
  everyN: number,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  const srcDoc = await PDFDocument.load(await file.arrayBuffer());
  const total = srcDoc.getPageCount();
  let groups: number[][] = [];

  if (mode === 'all-pages') {
    groups = Array.from({ length: total }, (_, i) => [i + 1]);
  } else if (mode === 'every-n') {
    const step = Math.max(1, Math.floor(everyN));
    for (let start = 1; start <= total; start += step) {
      const grp: number[] = [];
      for (let p = start; p < start + step && p <= total; p++) grp.push(p);
      groups.push(grp);
    }
  } else {
    const parsed = splitRangesIntoGroups(rangeText, total);
    if (parsed.error) throw new Error(parsed.error);
    groups = parsed.groups;
  }

  const base = sanitizeBaseName(file.name);

  if (groups.length === 1) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(srcDoc, groups[0].map((p) => p - 1));
    copied.forEach((p) => out.addPage(p));
    const bytes = await out.save({ useObjectStreams: true });
    onProgress?.(100);
    return buildResultFromBytes(bytes, `${base}-split.pdf`, 'application/pdf', {
      originalBytes: file.size,
      pageCount: out.getPageCount(),
      summary: `Split into 1 PDF (${out.getPageCount()} pages).`,
    });
  }

  const zip = new JSZip();
  for (let i = 0; i < groups.length; i++) {
    const grp = groups[i];
    const partDoc = await PDFDocument.create();
    const copied = await partDoc.copyPages(srcDoc, grp.map((p) => p - 1));
    copied.forEach((p) => partDoc.addPage(p));
    const partBytes = await partDoc.save({ useObjectStreams: true });
    const label = grp.length === 1 ? `p${grp[0]}` : `p${grp[0]}-${grp[grp.length - 1]}`;
    zip.file(`${base}_part${i + 1}_${label}.pdf`, partBytes);
    onProgress?.(Math.round(((i + 1) / groups.length) * 90));
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  onProgress?.(100);
  return buildResultFromBlob(zipBlob, `${base}-split.zip`, {
    originalBytes: file.size,
    pageCount: total,
    summary: `Split into ${groups.length} PDF files bundled in a ZIP archive.`,
  });
}

async function inflateDeflateBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    return null;
  }
}

async function reencodeImageStreamToCompactJpeg(
  rawBytes: Uint8Array,
  filterName: string,
  width: number,
  height: number,
  colorSpaceName: string,
  bitsPerComponent: number,
  maxDimension: number,
  quality: number,
): Promise<{ jpgBytes: Uint8Array; newWidth: number; newHeight: number } | null> {
  let sourceCanvas: HTMLCanvasElement | null = null;
  try {
    const scale = Math.min(1, maxDimension / Math.max(width, height, 1));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    if (filterName === '/DCTDecode') {
      const blob = bytesToBlob(rawBytes, 'image/jpeg');
      const bitmap = await createImageBitmap(blob);
      try {
        sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = targetW;
        sourceCanvas.height = targetH;
        const ctx = sourceCanvas.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      } finally {
        bitmap.close();
      }
    } else if (
      filterName === '/FlateDecode' &&
      bitsPerComponent === 8 &&
      (colorSpaceName === '/DeviceRGB' || colorSpaceName === '/DeviceGray')
    ) {
      const inflated = await inflateDeflateBytes(rawBytes);
      if (!inflated) return null;
      const channels = colorSpaceName === '/DeviceGray' ? 1 : 3;
      if (inflated.length < width * height * channels) return null;

      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = width;
      tmpCanvas.height = height;
      const tmpCtx = tmpCanvas.getContext('2d');
      if (!tmpCtx) return null;
      const imgData = tmpCtx.createImageData(width, height);
      const dst = imgData.data;
      if (channels === 3) {
        for (let i = 0, j = 0; i < dst.length; i += 4, j += 3) {
          dst[i] = inflated[j];
          dst[i + 1] = inflated[j + 1];
          dst[i + 2] = inflated[j + 2];
          dst[i + 3] = 255;
        }
      } else {
        for (let i = 0, j = 0; i < dst.length; i += 4, j += 1) {
          const g = inflated[j];
          dst[i] = g;
          dst[i + 1] = g;
          dst[i + 2] = g;
          dst[i + 3] = 255;
        }
      }
      tmpCtx.putImageData(imgData, 0, 0);

      if (targetW !== width || targetH !== height) {
        sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = targetW;
        sourceCanvas.height = targetH;
        const ctx = sourceCanvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(tmpCanvas, 0, 0, targetW, targetH);
        tmpCanvas.width = 0;
        tmpCanvas.height = 0;
      } else {
        sourceCanvas = tmpCanvas;
      }
    } else {
      return null;
    }

    const jpgBlob = await new Promise<Blob | null>((resolve) => {
      sourceCanvas!.toBlob((b) => resolve(b), 'image/jpeg', quality);
    });
    if (!jpgBlob) return null;
    const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
    return { jpgBytes, newWidth: targetW, newHeight: targetH };
  } catch {
    return null;
  } finally {
    if (sourceCanvas) {
      sourceCanvas.width = 0;
      sourceCanvas.height = 0;
    }
  }
}

/** 3. Compress PDF (Lossless, Smart Hybrid Image-Only keeping vector text, or Strong Raster DPI) */
export async function compressPdf(
  file: File,
  mode: 'structural' | 'hybrid-images' | 'raster',
  dpi: number,
  jpegQuality: number,
  onProgress?: (pct: number, stage?: string) => void,
): Promise<ToolResult> {
  const base = sanitizeBaseName(file.name);
  if (mode === 'structural') {
    onProgress?.(25, 'Compacting PDF object streams…');
    const src = await PDFDocument.load(await file.arrayBuffer());
    const clean = await PDFDocument.create();
    const copied = await clean.copyPages(src, src.getPageIndices());
    copied.forEach((p) => clean.addPage(p));
    clean.setTitle('');
    clean.setAuthor('');
    clean.setSubject('');
    clean.setKeywords([]);
    clean.setProducer('FolioPDF');
    clean.setCreator('FolioPDF');
    const bytes = await clean.save({ useObjectStreams: true, addDefaultPage: false });
    onProgress?.(100, 'Complete');
    return buildResultFromBytes(bytes, `${base}-compressed.pdf`, 'application/pdf', {
      originalBytes: file.size,
      pageCount: clean.getPageCount(),
      summary: 'Lossless structural optimization complete (object streams compacted, metadata cleaned).',
    });
  }

  if (mode === 'hybrid-images') {
    onProgress?.(10, 'Scanning embedded PDF images while preserving vector text…');
    const doc = await PDFDocument.load(await file.arrayBuffer());
    const clampedQuality = Math.max(0.25, Math.min(0.92, jpegQuality));
    // Map chosen target DPI to a sensible max pixel dimension for embedded photos/charts
    const maxDim = dpi <= 72 ? 850 : dpi <= 110 ? 1280 : 1700;

    const candidates: Array<{
      ref: Parameters<typeof doc.context.assign>[0];
      stream: PDFRawStream;
      filterName: string;
      width: number;
      height: number;
      colorSpaceName: string;
      bpc: number;
    }> = [];

    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
      // Skip image masks or soft masks so transparency/stencils remain intact
      if (dict.get(PDFName.of('ImageMask'))?.toString() === 'true') continue;
      if (dict.get(PDFName.of('SMask')) || dict.get(PDFName.of('Mask'))) continue;

      const filterObj = dict.get(PDFName.of('Filter'));
      const filterName = filterObj?.toString() ?? '';
      if (filterName !== '/DCTDecode' && filterName !== '/FlateDecode') continue;

      const widthObj = dict.get(PDFName.of('Width'));
      const heightObj = dict.get(PDFName.of('Height'));
      const bpcObj = dict.get(PDFName.of('BitsPerComponent'));
      const csObj = dict.get(PDFName.of('ColorSpace'));

      const width = widthObj instanceof PDFNumber ? widthObj.asNumber() : 0;
      const height = heightObj instanceof PDFNumber ? heightObj.asNumber() : 0;
      const bpc = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;
      const colorSpaceName = csObj?.toString() ?? '/DeviceRGB';

      // Skip tiny icons/bullets (< 10 KB) where re-encoding saves nothing
      if (width < 64 || height < 64 || obj.contents.length < 10 * 1024) continue;

      candidates.push({ ref, stream: obj, filterName, width, height, colorSpaceName, bpc });
    }

    let reencodedCount = 0;
    let savedImageBytes = 0;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const res = await reencodeImageStreamToCompactJpeg(
        c.stream.contents,
        c.filterName,
        c.width,
        c.height,
        c.colorSpaceName,
        c.bpc,
        maxDim,
        clampedQuality,
      );
      if (res && res.jpgBytes.length < c.stream.contents.length * 0.94) {
        savedImageBytes += c.stream.contents.length - res.jpgBytes.length;
        const newDict = c.stream.dict.clone(doc.context);
        newDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
        newDict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
        newDict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
        newDict.set(PDFName.of('Width'), PDFNumber.of(res.newWidth));
        newDict.set(PDFName.of('Height'), PDFNumber.of(res.newHeight));
        newDict.set(PDFName.of('Length'), PDFNumber.of(res.jpgBytes.length));
        newDict.delete(PDFName.of('DecodeParms'));
        doc.context.assign(c.ref, PDFRawStream.of(newDict, res.jpgBytes));
        reencodedCount++;
      }
      onProgress?.(
        15 + Math.round(((i + 1) / Math.max(1, candidates.length)) * 75),
        `Re-encoding embedded image ${i + 1} of ${candidates.length}…`,
      );
      if (i % 3 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    onProgress?.(94, 'Saving vector-preserving compressed PDF…');
    const outBytes = await doc.save({ useObjectStreams: true });
    onProgress?.(100, 'Complete');
    const summary =
      reencodedCount > 0
        ? `Smart Hybrid compression re-encoded ${reencodedCount} embedded image(s) (saved ~${Math.round(savedImageBytes / 1024)} KB in images) while preserving 100% selectable vector text.`
        : 'Smart Hybrid scan complete: no oversized embedded raster images found; compacted object streams while keeping 100% vector text.';

    return buildResultFromBytes(outBytes, `${base}-smart-compressed.pdf`, 'application/pdf', {
      originalBytes: file.size,
      pageCount: doc.getPageCount(),
      summary,
    });
  }

  // Raster re-encoding compression (great for image-heavy scans)
  const pdfJsDoc = await openPdfJsDocument(file);
  const outDoc = await PDFDocument.create();
  const scale = dpi / 72;
  const clampedQuality = Math.max(0.15, Math.min(0.95, jpegQuality));
  try {
    for (let i = 1; i <= pdfJsDoc.numPages; i++) {
      const page = await pdfJsDoc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const { canvas } = await renderPdfPageToCanvas(pdfJsDoc, i, scale);
      const jpgBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error(`Failed to encode page ${i} as JPEG.`))),
          'image/jpeg',
          clampedQuality,
        );
      });
      // Immediately release bitmap backing store for large multi-page PDFs
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
      const img = await outDoc.embedJpg(jpgBytes);
      const outPage = outDoc.addPage([vp1.width, vp1.height]);
      outPage.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      onProgress?.(Math.round((i / pdfJsDoc.numPages) * 92), `Compressing page ${i} of ${pdfJsDoc.numPages}…`);
      if (i % 4 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    await closePdfJsDocument(pdfJsDoc);
  }

  const outBytes = await outDoc.save({ useObjectStreams: true });
  onProgress?.(100, 'Complete');
  return buildResultFromBytes(outBytes, `${base}-compressed-${dpi}dpi.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: outDoc.getPageCount(),
    summary: `Re-encoded ${outDoc.getPageCount()} pages at ${dpi} DPI (${Math.round(jpegQuality * 100)}% JPEG quality).`,
  });
}

/** Inspect native AcroForm fields in a PDF so Edit PDF can display fillable inputs */
export async function inspectPdfFormFields(file: File): Promise<PdfFormFieldSummary[]> {
  try {
    const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    const form = doc.getForm();
    const fields = form.getFields();
    const summaries: PdfFormFieldSummary[] = [];

    for (const field of fields) {
      const name = field.getName();
      const readOnly = field.isReadOnly();
      if (field instanceof PDFTextField) {
        summaries.push({
          name,
          kind: 'text',
          value: field.getText() ?? '',
          readOnly,
        });
      } else if (field instanceof PDFCheckBox) {
        summaries.push({
          name,
          kind: 'checkbox',
          value: field.isChecked(),
          readOnly,
        });
      } else if (field instanceof PDFDropdown) {
        summaries.push({
          name,
          kind: 'dropdown',
          value: field.getSelected()[0] ?? '',
          options: field.getOptions(),
          readOnly,
        });
      } else if (field instanceof PDFRadioGroup) {
        summaries.push({
          name,
          kind: 'radio',
          value: field.getSelected() ?? '',
          options: field.getOptions(),
          readOnly,
        });
      } else if (field instanceof PDFOptionList) {
        summaries.push({
          name,
          kind: 'option-list',
          value: field.getSelected()[0] ?? '',
          options: field.getOptions(),
          readOnly,
        });
      }
    }
    return summaries;
  } catch {
    return [];
  }
}

async function resolveOverlayStandardFont(
  doc: PDFDocument,
  cache: Map<string, PDFFont>,
  family: PdfFontFamilyKey = 'sans',
  isBold = false,
  isItalic = false,
): Promise<PDFFont> {
  const key = `${family}-${isBold ? 'b' : 'r'}-${isItalic ? 'i' : 'n'}`;
  const existing = cache.get(key);
  if (existing) return existing;

  let std = StandardFonts.Helvetica;
  if (family === 'serif') {
    std =
      isBold && isItalic
        ? StandardFonts.TimesRomanBoldItalic
        : isBold
          ? StandardFonts.TimesRomanBold
          : isItalic
            ? StandardFonts.TimesRomanItalic
            : StandardFonts.TimesRoman;
  } else if (family === 'mono') {
    std =
      isBold && isItalic
        ? StandardFonts.CourierBoldOblique
        : isBold
          ? StandardFonts.CourierBold
          : isItalic
            ? StandardFonts.CourierOblique
            : StandardFonts.Courier;
  } else {
    std =
      isBold && isItalic
        ? StandardFonts.HelveticaBoldOblique
        : isBold
          ? StandardFonts.HelveticaBold
          : isItalic
            ? StandardFonts.HelveticaOblique
            : StandardFonts.Helvetica;
  }

  const embedded = await doc.embedFont(std);
  cache.set(key, embedded);
  return embedded;
}

/** 4 & 5. Edit PDF (existing text editing, deep scrub rebuild, forms, annotations) & Sign PDF */
export async function applyCanvasOverlaysToPdf(
  file: File,
  overlays: PageOverlayItem[],
  suffix: 'edited' | 'signed',
  onProgress?: (pct: number, stage?: string) => void,
  options?: {
    scrubEditedPages?: boolean;
    scrubDpi?: number;
    formUpdates?: Record<string, string | boolean>;
    flattenForms?: boolean;
  },
): Promise<ToolResult> {
  const srcBytes = await file.arrayBuffer();
  const baseDoc = await PDFDocument.load(srcBytes);

  // Apply native AcroForm updates first (before any optional deep-scrub page rebuild)
  let formUpdatedCount = 0;
  if (options?.formUpdates && Object.keys(options.formUpdates).length > 0) {
    try {
      const form = baseDoc.getForm();
      for (const [name, val] of Object.entries(options.formUpdates)) {
        try {
          const field = form.getField(name);
          if (field instanceof PDFTextField && typeof val === 'string') {
            field.setText(val);
            formUpdatedCount++;
          } else if (field instanceof PDFCheckBox && typeof val === 'boolean') {
            if (val) field.check();
            else field.uncheck();
            formUpdatedCount++;
          } else if (field instanceof PDFDropdown && typeof val === 'string') {
            if (val) field.select(val);
            formUpdatedCount++;
          } else if (field instanceof PDFRadioGroup && typeof val === 'string') {
            if (val) field.select(val);
            formUpdatedCount++;
          } else if (field instanceof PDFOptionList && typeof val === 'string') {
            if (val) field.select(val);
            formUpdatedCount++;
          }
        } catch {
          // Ignore individual read-only or incompatible field errors
        }
      }
      if (options.flattenForms) {
        form.flatten();
      }
    } catch {
      // Document has no AcroForm
    }
  } else if (options?.flattenForms) {
    try {
      baseDoc.getForm().flatten();
    } catch {
      // Ignore if no form
    }
  }

  const scrubPageSet = new Set<number>();
  if (options?.scrubEditedPages) {
    for (const ov of overlays) {
      if (ov.kind === 'replace-text') {
        scrubPageSet.add(ov.pageIndex);
      }
    }
  }

  let doc = baseDoc;

  // Deep Scrub Mode: rebuild ONLY pages that contain edited existing text so the old text layer is permanently removed
  if (scrubPageSet.size > 0) {
    onProgress?.(12, `Deep-scrubbing old text layer on ${scrubPageSet.size} edited page(s)…`);
    const intermediateBytes = await baseDoc.save({ useObjectStreams: true });
    const pdfJsDoc = await openPdfJsDocument(intermediateBytes);
    const rebuilt = await PDFDocument.create();
    const scrubScale = (options?.scrubDpi ?? 200) / 72;
    const total = baseDoc.getPageCount();

    try {
      for (let idx = 0; idx < total; idx++) {
        if (!scrubPageSet.has(idx)) {
          const [copied] = await rebuilt.copyPages(baseDoc, [idx]);
          rebuilt.addPage(copied);
        } else {
          const jsPage = await pdfJsDoc.getPage(idx + 1);
          const vp1 = jsPage.getViewport({ scale: 1 });
          const { canvas } = await renderPdfPageToCanvas(pdfJsDoc, idx + 1, scrubScale);
          const ctx = canvas.getContext('2d')!;
          // Paint matched background cover over every replaced-text box directly on the bitmap
          const pageReplaces = overlays.filter(
            (o) => o.pageIndex === idx && o.kind === 'replace-text',
          );
          for (const rep of pageReplaces) {
            ctx.fillStyle = rep.bgColor ?? '#ffffff';
            const padLeft = Math.max(2, canvas.width * 0.004);
            const padRight = Math.max(6, rep.width * canvas.width * 0.04 + canvas.width * 0.01);
            const padY = Math.max(2, rep.height * canvas.height * 0.22);
            ctx.fillRect(
              Math.max(0, rep.x * canvas.width - padLeft),
              Math.max(0, rep.y * canvas.height - padY * 0.45),
              rep.width * canvas.width + padLeft + padRight,
              rep.height * canvas.height + padY * 1.5,
            );
          }
          const jpgBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (b) => (b ? resolve(b) : reject(new Error(`Failed to rebuild page ${idx + 1}.`))),
              'image/jpeg',
              0.92,
            );
          });
          canvas.width = 0;
          canvas.height = 0;
          jsPage.cleanup();
          const img = await rebuilt.embedJpg(new Uint8Array(await jpgBlob.arrayBuffer()));
          const newPage = rebuilt.addPage([vp1.width, vp1.height]);
          newPage.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        }
        onProgress?.(
          15 + Math.round(((idx + 1) / total) * 50),
          `Compiling page ${idx + 1} of ${total}…`,
        );
      }
    } finally {
      await closePdfJsDocument(pdfJsDoc);
    }
    doc = rebuilt;
  }

  const fontCache = new Map<string, PDFFont>();
  const pages = doc.getPages();

  for (let idx = 0; idx < overlays.length; idx++) {
    const item = overlays[idx];
    const page = pages[item.pageIndex];
    if (!page) continue;

    const { width: pw, height: ph } = page.getSize();
    const xPt = item.x * pw;
    const wPt = item.width * pw;
    const hPt = item.height * ph;
    // Convert top-down normalized Y to bottom-up PDF coordinates
    const yBottomPt = ph - (item.y + item.height) * ph;
    const [r, g, b] = hexToRgbTuple(item.color ?? '#0f172a');

    if (item.kind === 'replace-text') {
      // Unless already scrubbed onto bitmap, cover the original text with its sampled background color
      if (!scrubPageSet.has(item.pageIndex)) {
        const [br, bg, bb] = hexToRgbTuple(item.bgColor ?? '#ffffff');
        const padLeft = 2;
        const padRight = Math.max(6, wPt * 0.04 + 4);
        const padBottom = Math.max(2.0, hPt * 0.24);
        const padTop = Math.max(1.2, hPt * 0.12);
        page.drawRectangle({
          x: Math.max(0, xPt - padLeft),
          y: Math.max(0, yBottomPt - padBottom),
          width: Math.max(8, wPt + padLeft + padRight),
          height: Math.max(6, hPt + padBottom + padTop),
          color: rgb(br, bg, bb),
        });
      }
      const newText = item.text ?? '';
      if (newText.trim().length > 0) {
        const font = await resolveOverlayStandardFont(
          doc,
          fontCache,
          item.fontFamily ?? 'sans',
          Boolean(item.isBold),
          Boolean(item.isItalic),
        );
        const fontSize = Math.max(6, item.fontSize ?? 11);
        const baselineY = ph - item.y * ph - fontSize * 0.86;
        const lines = newText.split('\n');
        let cursorY = baselineY;
        for (const line of lines) {
          page.drawText(line.replace(/[^\x20-\x7E\xA0-\xFF]/g, ' '), {
            x: xPt,
            y: cursorY,
            size: fontSize,
            font,
            color: rgb(r, g, b),
          });
          cursorY -= fontSize * 1.24;
        }
      }
    } else if (item.kind === 'text' && item.text) {
      const font = await resolveOverlayStandardFont(
        doc,
        fontCache,
        item.fontFamily ?? 'sans',
        Boolean(item.isBold),
        Boolean(item.isItalic),
      );
      const fontSize = item.fontSize ?? 14;
      const lines = item.text.split('\n');
      let cursorY = ph - item.y * ph - fontSize;
      for (const line of lines) {
        page.drawText(line.replace(/[^\x20-\x7E\xA0-\xFF]/g, ' '), {
          x: xPt,
          y: cursorY,
          size: fontSize,
          font,
          color: rgb(r, g, b),
        });
        cursorY -= fontSize * 1.25;
      }
    } else if (item.kind === 'whiteout') {
      page.drawRectangle({
        x: xPt,
        y: yBottomPt,
        width: Math.max(4, wPt),
        height: Math.max(4, hPt),
        color: rgb(1, 1, 1),
      });
    } else if (item.kind === 'highlight') {
      page.drawRectangle({
        x: xPt,
        y: yBottomPt,
        width: Math.max(4, wPt),
        height: Math.max(4, hPt),
        color: rgb(r, g, b),
        opacity: item.opacity ?? 0.35,
      });
    } else if (item.kind === 'rect') {
      page.drawRectangle({
        x: xPt,
        y: yBottomPt,
        width: Math.max(4, wPt),
        height: Math.max(4, hPt),
        borderColor: rgb(r, g, b),
        borderWidth: item.strokeWidth ?? 2,
      });
    } else if (item.kind === 'freehand' && item.points && item.points.length > 1) {
      for (let i = 1; i < item.points.length; i++) {
        const p0 = item.points[i - 1];
        const p1 = item.points[i];
        page.drawLine({
          start: { x: p0.x * pw, y: ph - p0.y * ph },
          end: { x: p1.x * pw, y: ph - p1.y * ph },
          thickness: item.strokeWidth ?? 2,
          color: rgb(r, g, b),
          opacity: item.opacity ?? 1,
        });
      }
    } else if (item.kind === 'image' && item.imageDataUrl) {
      const imgBytes = dataUrlToUint8Array(item.imageDataUrl);
      const embedded = item.imageDataUrl.startsWith('data:image/jpeg')
        ? await doc.embedJpg(imgBytes)
        : await doc.embedPng(imgBytes);
      page.drawImage(embedded, {
        x: xPt,
        y: yBottomPt,
        width: Math.max(10, wPt),
        height: Math.max(10, hPt),
        opacity: item.opacity ?? 1,
      });
    }

    onProgress?.(
      (scrubPageSet.size > 0 ? 68 : 10) +
        Math.round(((idx + 1) / Math.max(1, overlays.length)) * (scrubPageSet.size > 0 ? 24 : 82)),
      'Applying edits to PDF…',
    );
  }

  onProgress?.(95, 'Compiling final PDF…');
  const outBytes = await doc.save({ useObjectStreams: true });
  onProgress?.(100, 'Complete');
  const base = sanitizeBaseName(file.name);
  const replacedCount = overlays.filter((o) => o.kind === 'replace-text').length;
  const parts: string[] = [];
  if (replacedCount > 0) {
    parts.push(
      `${replacedCount} existing text edit(s)${scrubPageSet.size > 0 ? ` (deep-scrubbed ${scrubPageSet.size} page(s))` : ''}`,
    );
  }
  const otherCount = overlays.length - replacedCount;
  if (otherCount > 0) {
    parts.push(`${otherCount} ${suffix === 'signed' ? 'signature' : 'annotation'} element(s)`);
  }
  if (formUpdatedCount > 0) {
    parts.push(`${formUpdatedCount} form field(s)${options?.flattenForms ? ' flattened' : ' updated'}`);
  } else if (options?.flattenForms) {
    parts.push('form fields flattened');
  }

  return buildResultFromBytes(outBytes, `${base}-${suffix}.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: doc.getPageCount(),
    summary: parts.length > 0 ? `Applied ${parts.join(', ')} to PDF.` : 'Saved updated PDF.',
  });
}

/** 7. Images to PDF */
export async function imagesToPdf(
  files: File[],
  pageSize: 'a4' | 'letter' | 'fit',
  orientation: 'portrait' | 'landscape',
  marginPt: number,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  const doc = await PDFDocument.create();
  let originalBytes = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    originalBytes += file.size;
    const { bytes, isJpeg } = await normalizeImageToEmbeddableBytes(file);
    const img = isJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);

    let pw: number;
    let ph: number;
    if (pageSize === 'fit') {
      pw = img.width + marginPt * 2;
      ph = img.height + marginPt * 2;
    } else {
      const baseW = pageSize === 'a4' ? 595.28 : 612;
      const baseH = pageSize === 'a4' ? 841.89 : 792;
      pw = orientation === 'portrait' ? baseW : baseH;
      ph = orientation === 'portrait' ? baseH : baseW;
    }

    const page = doc.addPage([pw, ph]);
    const availW = Math.max(20, pw - marginPt * 2);
    const availH = Math.max(20, ph - marginPt * 2);
    const ratio = Math.min(availW / img.width, availH / img.height);
    const drawW = img.width * ratio;
    const drawH = img.height * ratio;
    page.drawImage(img, {
      x: (pw - drawW) / 2,
      y: (ph - drawH) / 2,
      width: drawW,
      height: drawH,
    });
    onProgress?.(Math.round(((i + 1) / files.length) * 90));
  }

  const outBytes = await doc.save({ useObjectStreams: true });
  onProgress?.(100);
  return buildResultFromBytes(outBytes, 'images-combined.pdf', 'application/pdf', {
    originalBytes,
    pageCount: doc.getPageCount(),
    summary: `Converted ${files.length} image(s) into a ${doc.getPageCount()}-page PDF.`,
  });
}

async function normalizeImageToEmbeddableBytes(
  file: File,
): Promise<{ bytes: Uint8Array; isJpeg: boolean }> {
  const raw = new Uint8Array(await file.arrayBuffer());
  // Native PNG
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) {
    return { bytes: raw, isJpeg: false };
  }
  // Native JPEG
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) {
    return { bytes: raw, isJpeg: true };
  }
  // WebP / other browser-decodable format -> transcode via canvas to PNG
  const url = URL.createObjectURL(file);
  try {
    const imgEl = await loadHtmlImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = imgEl.naturalWidth || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(imgEl, 0, 0);
    return { bytes: dataUrlToUint8Array(canvas.toDataURL('image/png')), isJpeg: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image file.'));
    img.src = url;
  });
}

/** 8. PDF to Images */
export async function pdfToImages(
  file: File,
  format: 'png' | 'jpeg' | 'webp',
  dpi: number,
  rangeText: string,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  const doc = await openPdfJsDocument(file);
  const base = sanitizeBaseName(file.name);
  const parsed = parsePageRanges(rangeText, doc.numPages);
  if (parsed.error) {
    await closePdfJsDocument(doc);
    throw new Error(parsed.error);
  }

  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const ext = format === 'jpeg' ? 'jpg' : format;
  const scale = dpi / 72;
  const extractedImages: NonNullable<ToolResult['extractedImages']> = [];

  try {
    const zip = new JSZip();
    for (let i = 0; i < parsed.pages.length; i++) {
      const pageNum = parsed.pages[i];
      const { canvas, width, height } = await renderPdfPageToCanvas(doc, pageNum, scale);
      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to encode canvas image.'))),
          mime,
          0.92,
        );
      });
      const name = `${base}_page_${String(pageNum).padStart(3, '0')}.${ext}`;
      zip.file(name, blob);
      extractedImages.push({
        name,
        url: URL.createObjectURL(blob),
        blob,
        width,
        height,
      });
      onProgress?.(Math.round(((i + 1) / parsed.pages.length) * 90));
    }

    if (extractedImages.length === 1) {
      onProgress?.(100);
      return {
        blob: extractedImages[0].blob,
        url: extractedImages[0].url,
        fileName: extractedImages[0].name,
        mimeType: mime,
        outputBytes: extractedImages[0].blob.size,
        originalBytes: file.size,
        pageCount: 1,
        extractedImages,
        summary: `Rendered 1 page as ${ext.toUpperCase()} at ${dpi} DPI.`,
      };
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    onProgress?.(100);
    return buildResultFromBlob(zipBlob, `${base}-images-${dpi}dpi.zip`, {
      originalBytes: file.size,
      pageCount: extractedImages.length,
      extractedImages,
      summary: `Rendered ${extractedImages.length} pages as ${ext.toUpperCase()} (${dpi} DPI) in a ZIP bundle.`,
    });
  } finally {
    await closePdfJsDocument(doc);
  }
}

/** 9. Extract PDF images (embedded XObjects) */
export async function extractEmbeddedImages(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  const doc = await PDFDocument.load(await file.arrayBuffer());
  const base = sanitizeBaseName(file.name);
  const extractedImages: NonNullable<ToolResult['extractedImages']> = [];
  const objects = doc.context.enumerateIndirectObjects();
  let imgCounter = 0;

  for (let i = 0; i < objects.length; i++) {
    const [, obj] = objects[i];
    if (obj instanceof PDFRawStream) {
      const dict: PDFDict = obj.dict;
      const subtype = dict.get(PDFName.of('Subtype'));
      if (subtype && subtype.toString() === '/Image') {
        const filterObj = dict.get(PDFName.of('Filter'));
        const filterStr = filterObj ? filterObj.toString() : '';
        const width = Number(dict.get(PDFName.of('Width'))?.toString() ?? 0);
        const height = Number(dict.get(PDFName.of('Height'))?.toString() ?? 0);

        // Direct JPEG stream (DCTDecode)
        if (filterStr.includes('DCTDecode')) {
          imgCounter++;
          const blob = bytesToBlob(obj.contents, 'image/jpeg');
          extractedImages.push({
            name: `${base}_image_${String(imgCounter).padStart(2, '0')}.jpg`,
            url: URL.createObjectURL(blob),
            blob,
            width,
            height,
          });
        } else if (filterStr.includes('FlateDecode') && width > 0 && height > 0) {
          // Decode raw Flate RGB/Grayscale pixel streams via browser DecompressionStream!
          try {
            const decompressed = await inflateZlibBytes(obj.contents);
            const csStr = dict.get(PDFName.of('ColorSpace'))?.toString() ?? '';
            const channels = csStr.includes('DeviceGray') ? 1 : csStr.includes('DeviceCMYK') ? 4 : 3;
            const expectedLen = width * height * channels;
            if (decompressed.length >= expectedLen) {
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d')!;
              const imgData = ctx.createImageData(width, height);
              const px = imgData.data;
              for (let p = 0; p < width * height; p++) {
                if (channels === 1) {
                  const v = decompressed[p];
                  px[p * 4] = v;
                  px[p * 4 + 1] = v;
                  px[p * 4 + 2] = v;
                  px[p * 4 + 3] = 255;
                } else if (channels === 3) {
                  px[p * 4] = decompressed[p * 3];
                  px[p * 4 + 1] = decompressed[p * 3 + 1];
                  px[p * 4 + 2] = decompressed[p * 3 + 2];
                  px[p * 4 + 3] = 255;
                } else {
                  const c = decompressed[p * 4] / 255;
                  const m = decompressed[p * 4 + 1] / 255;
                  const y = decompressed[p * 4 + 2] / 255;
                  const k = decompressed[p * 4 + 3] / 255;
                  px[p * 4] = Math.round(255 * (1 - c) * (1 - k));
                  px[p * 4 + 1] = Math.round(255 * (1 - m) * (1 - k));
                  px[p * 4 + 2] = Math.round(255 * (1 - y) * (1 - k));
                  px[p * 4 + 3] = 255;
                }
              }
              ctx.putImageData(imgData, 0, 0);
              const blob: Blob = await new Promise((resolve, reject) =>
                canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'),
              );
              imgCounter++;
              extractedImages.push({
                name: `${base}_image_${String(imgCounter).padStart(2, '0')}.png`,
                url: URL.createObjectURL(blob),
                blob,
                width,
                height,
              });
            }
          } catch {
            // Skip exotic predictors/indexed palettes gracefully
          }
        }
      }
    }
    if (i % 15 === 0) {
      onProgress?.(Math.round((i / Math.max(1, objects.length)) * 85));
    }
  }

  if (extractedImages.length === 0) {
    throw new Error(
      'No directly extractable embedded raster images were found in this PDF (it may contain only vector text/shapes). Use "PDF to Images" to render full pages instead.',
    );
  }

  const zip = new JSZip();
  extractedImages.forEach((img) => zip.file(img.name, img.blob));
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  onProgress?.(100);

  return buildResultFromBlob(zipBlob, `${base}-extracted-images.zip`, {
    originalBytes: file.size,
    extractedImages,
    summary: `Extracted ${extractedImages.length} embedded raster image(s) from the PDF.`,
  });
}

async function inflateZlibBytes(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const safeCopy = new Uint8Array(compressed.byteLength);
  safeCopy.set(compressed);
  writer.write(safeCopy);
  writer.close();
  const response = new Response(ds.readable);
  return new Uint8Array(await response.arrayBuffer());
}

/** 10. Protect PDF (AES-256 native client-side encryption via @cantoo/pdf-lib) */
export async function protectPdf(
  file: File,
  options: {
    userPassword: string;
    ownerPassword: string;
    allowPrinting: boolean;
    allowCopying: boolean;
    allowModifying: boolean;
  },
): Promise<ToolResult> {
  if (!options.userPassword && !options.ownerPassword) {
    throw new Error('Enter at least a User open password or an Owner permissions password.');
  }
  const doc = await PDFDocument.load(await file.arrayBuffer());
  doc.encrypt({
    userPassword: options.userPassword || undefined,
    ownerPassword: options.ownerPassword || options.userPassword,
    algorithm: 'AES-256',
    permissions: {
      printing: options.allowPrinting ? 'highResolution' : false,
      copying: options.allowCopying,
      modifying: options.allowModifying,
      annotating: options.allowModifying,
      fillingForms: options.allowModifying,
      documentAssembly: options.allowModifying,
      contentAccessibility: true,
    },
  });
  const outBytes = await doc.save({ useObjectStreams: true });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-protected.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: doc.getPageCount(),
    summary: 'Encrypted with AES-256 password security locally in your browser.',
  });
}

/** 11. Unlock PDF (when user knows the password) */
export async function unlockPdf(file: File, password: string): Promise<ToolResult> {
  const bytes = await file.arrayBuffer();
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { password: password || undefined });
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Could not unlock PDF: ${err.message}. Check that the password is correct.`
        : 'Could not unlock PDF. Check that the password is correct.',
    );
  }
  // Copy into a clean unencrypted PDFDocument
  const clean = await PDFDocument.create();
  const copied = await clean.copyPages(doc, doc.getPageIndices());
  copied.forEach((p) => clean.addPage(p));
  const outBytes = await clean.save({ useObjectStreams: true });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-unlocked.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: clean.getPageCount(),
    summary: 'Removed encryption and usage restrictions from the PDF.',
  });
}

/** 12. Rotate PDF pages */
export async function rotatePdfPages(
  file: File,
  rotationsByPageIndex: Record<number, number>,
): Promise<ToolResult> {
  const doc = await PDFDocument.load(await file.arrayBuffer());
  const pages = doc.getPages();
  let rotatedCount = 0;
  pages.forEach((page, idx) => {
    const delta = rotationsByPageIndex[idx] ?? 0;
    if (delta % 360 !== 0) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + delta + 360) % 360));
      rotatedCount++;
    }
  });
  const outBytes = await doc.save({ useObjectStreams: true });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-rotated.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: doc.getPageCount(),
    summary: `Saved PDF with ${rotatedCount} rotated page(s).`,
  });
}

/** 13. Remove PDF pages */
export async function removePdfPages(file: File, zeroBasedToRemove: number[]): Promise<ToolResult> {
  const doc = await PDFDocument.load(await file.arrayBuffer());
  const total = doc.getPageCount();
  const removeSet = new Set(zeroBasedToRemove);
  const keepIndices = Array.from({ length: total }, (_, i) => i).filter((i) => !removeSet.has(i));
  if (keepIndices.length === 0) {
    throw new Error('Cannot remove every page from the document. Keep at least 1 page.');
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(doc, keepIndices);
  copied.forEach((p) => out.addPage(p));
  const outBytes = await out.save({ useObjectStreams: true });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-trimmed.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: out.getPageCount(),
    summary: `Removed ${removeSet.size} page(s); ${out.getPageCount()} page(s) remaining.`,
  });
}

/** 14. Extract PDF pages */
export async function extractPdfPages(
  file: File,
  zeroBasedToExtract: number[],
  asSeparateZip: boolean,
): Promise<ToolResult> {
  if (zeroBasedToExtract.length === 0) {
    throw new Error('Select at least one page to extract.');
  }
  const src = await PDFDocument.load(await file.arrayBuffer());
  const base = sanitizeBaseName(file.name);

  if (!asSeparateZip || zeroBasedToExtract.length === 1) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, zeroBasedToExtract);
    copied.forEach((p) => out.addPage(p));
    const bytes = await out.save({ useObjectStreams: true });
    return buildResultFromBytes(bytes, `${base}-extracted.pdf`, 'application/pdf', {
      originalBytes: file.size,
      pageCount: out.getPageCount(),
      summary: `Extracted ${out.getPageCount()} page(s) into a new PDF.`,
    });
  }

  const zip = new JSZip();
  for (const idx of zeroBasedToExtract) {
    const single = await PDFDocument.create();
    const [copied] = await single.copyPages(src, [idx]);
    single.addPage(copied);
    zip.file(`${base}_page_${idx + 1}.pdf`, await single.save({ useObjectStreams: true }));
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return buildResultFromBlob(zipBlob, `${base}-extracted-pages.zip`, {
    originalBytes: file.size,
    pageCount: zeroBasedToExtract.length,
    summary: `Extracted ${zeroBasedToExtract.length} separate PDFs into a ZIP archive.`,
  });
}

/** 15. Rearrange PDF pages */
export async function rearrangePdfPages(
  file: File,
  newOrderZeroBased: number[],
): Promise<ToolResult> {
  const src = await PDFDocument.load(await file.arrayBuffer());
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, newOrderZeroBased);
  copied.forEach((p) => out.addPage(p));
  const outBytes = await out.save({ useObjectStreams: true });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-rearranged.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: out.getPageCount(),
    summary: `Reordered ${out.getPageCount()} pages into your custom sequence.`,
  });
}

/** 18. Add Watermark */
export async function addWatermarkToPdf(
  file: File,
  options: {
    kind: 'text' | 'image';
    text: string;
    imageFile?: File | null;
    fontSize: number;
    opacity: number;
    rotation: number;
    color: string;
    position: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'tiled';
    pageRange: string;
  },
): Promise<ToolResult> {
  const doc = await PDFDocument.load(await file.arrayBuffer());
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const parsed = parsePageRanges(options.pageRange, doc.getPageCount());
  if (parsed.error) throw new Error(parsed.error);
  const targetPages = new Set(parsed.pages.map((p) => p - 1));

  let embeddedImg: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  if (options.kind === 'image') {
    if (!options.imageFile) throw new Error('Select a PNG or JPEG watermark image first.');
    const norm = await normalizeImageToEmbeddableBytes(options.imageFile);
    embeddedImg = norm.isJpeg ? await doc.embedJpg(norm.bytes) : await doc.embedPng(norm.bytes);
  } else if (!options.text.trim()) {
    throw new Error('Enter watermark text.');
  }

  const [r, g, b] = hexToRgbTuple(options.color);
  const pages = doc.getPages();

  pages.forEach((page, idx) => {
    if (!targetPages.has(idx)) return;
    const { width, height } = page.getSize();

    if (options.kind === 'text') {
      const text = options.text.trim();
      const textW = font.widthOfTextAtSize(text, options.fontSize);

      if (options.position === 'tiled') {
        const stepX = Math.max(150, textW + 70);
        const stepY = 150;
        for (let y = 40; y < height + 60; y += stepY) {
          for (let x = 20; x < width + 60; x += stepX) {
            page.drawText(text, {
              x,
              y,
              size: options.fontSize,
              font,
              color: rgb(r, g, b),
              opacity: options.opacity,
              rotate: degrees(options.rotation),
            });
          }
        }
      } else {
        const coords = resolveStampPosition(options.position, width, height, textW, options.fontSize);
        page.drawText(text, {
          x: coords.x,
          y: coords.y,
          size: options.fontSize,
          font,
          color: rgb(r, g, b),
          opacity: options.opacity,
          rotate: degrees(options.rotation),
        });
      }
    } else if (embeddedImg) {
      const maxW = width * 0.35;
      const scale = Math.min(1, maxW / embeddedImg.width);
      const drawW = embeddedImg.width * scale;
      const drawH = embeddedImg.height * scale;
      const coords = resolveStampPosition(
        options.position === 'tiled' ? 'center' : options.position,
        width,
        height,
        drawW,
        drawH,
      );
      page.drawImage(embeddedImg, {
        x: coords.x,
        y: coords.y,
        width: drawW,
        height: drawH,
        opacity: options.opacity,
        rotate: degrees(options.rotation),
      });
    }
  });

  const outBytes = await doc.save({ useObjectStreams: true });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-watermarked.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: doc.getPageCount(),
    summary: `Applied watermark to ${targetPages.size} page(s).`,
  });
}

function resolveStampPosition(
  pos: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
  pageW: number,
  pageH: number,
  itemW: number,
  itemH: number,
): { x: number; y: number } {
  const pad = 42;
  switch (pos) {
    case 'top-left':
      return { x: pad, y: pageH - pad - itemH };
    case 'top-right':
      return { x: Math.max(pad, pageW - pad - itemW), y: pageH - pad - itemH };
    case 'bottom-left':
      return { x: pad, y: pad };
    case 'bottom-right':
      return { x: Math.max(pad, pageW - pad - itemW), y: pad };
    default:
      return { x: (pageW - itemW) / 2, y: (pageH - itemH) / 2 };
  }
}

/** 19. Add Page Numbers */
export async function addPageNumbersToPdf(
  file: File,
  options: {
    format: 'number' | 'x-of-y' | 'slash';
    position: 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left';
    startNumber: number;
    fontSize: number;
    marginPt: number;
  },
): Promise<ToolResult> {
  const doc = await PDFDocument.load(await file.arrayBuffer());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;

  pages.forEach((page, idx) => {
    const num = options.startNumber + idx;
    const totalLabel = options.startNumber + total - 1;
    const label =
      options.format === 'x-of-y'
        ? `Page ${num} of ${totalLabel}`
        : options.format === 'slash'
          ? `${num} / ${totalLabel}`
          : `${num}`;

    const { width, height } = page.getSize();
    const textW = font.widthOfTextAtSize(label, options.fontSize);
    const m = options.marginPt;

    let x = (width - textW) / 2;
    if (options.position.endsWith('left')) x = m;
    if (options.position.endsWith('right')) x = width - m - textW;

    const y = options.position.startsWith('top') ? height - m - options.fontSize : m;

    page.drawText(label, {
      x,
      y,
      size: options.fontSize,
      font,
      color: rgb(0.25, 0.3, 0.38),
    });
  });

  const outBytes = await doc.save({ useObjectStreams: true });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-numbered.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: total,
    summary: `Added page numbers to ${total} page(s).`,
  });
}

/** 20. PDF Overlay */
export async function overlayPdfs(
  baseFile: File,
  overlayFile: File,
  options: {
    placement: 'over' | 'under';
    opacity: number;
    repeatFirstPage: boolean;
  },
): Promise<ToolResult> {
  const baseDoc = await PDFDocument.load(await baseFile.arrayBuffer());
  const overlayDoc = await PDFDocument.load(await overlayFile.arrayBuffer());
  const outDoc = await PDFDocument.create();

  const baseCount = baseDoc.getPageCount();
  const overlayCount = overlayDoc.getPageCount();
  const embeddedBase = await outDoc.embedPdf(baseDoc, Array.from({ length: baseCount }, (_, i) => i));
  const embeddedOverlay = await outDoc.embedPdf(
    overlayDoc,
    Array.from({ length: overlayCount }, (_, i) => i),
  );

  for (let i = 0; i < baseCount; i++) {
    const bp = embeddedBase[i];
    const page = outDoc.addPage([bp.width, bp.height]);
    const ovIdx = options.repeatFirstPage ? 0 : i < overlayCount ? i : -1;
    const ov = ovIdx >= 0 ? embeddedOverlay[ovIdx] : null;

    if (options.placement === 'under' && ov) {
      page.drawPage(ov, {
        x: 0,
        y: 0,
        width: bp.width,
        height: bp.height,
        opacity: options.opacity,
      });
    }
    page.drawPage(bp, { x: 0, y: 0, width: bp.width, height: bp.height });
    if (options.placement === 'over' && ov) {
      page.drawPage(ov, {
        x: 0,
        y: 0,
        width: bp.width,
        height: bp.height,
        opacity: options.opacity,
      });
    }
  }

  const outBytes = await outDoc.save({ useObjectStreams: true });
  const base = sanitizeBaseName(baseFile.name);
  return buildResultFromBytes(outBytes, `${base}-overlaid.pdf`, 'application/pdf', {
    originalBytes: baseFile.size + overlayFile.size,
    pageCount: baseCount,
    summary: `Blended "${overlayFile.name}" ${options.placement} ${baseCount} page(s).`,
  });
}

/** 22. Web Optimize PDF (Structural Object-Stream Compaction & Metadata Cleanup) */
export async function webOptimizePdf(file: File, stripMetadata: boolean): Promise<ToolResult> {
  const src = await PDFDocument.load(await file.arrayBuffer());
  const clean = await PDFDocument.create();
  const copied = await clean.copyPages(src, src.getPageIndices());
  copied.forEach((p) => clean.addPage(p));
  if (stripMetadata) {
    clean.setTitle('');
    clean.setAuthor('');
    clean.setSubject('');
    clean.setKeywords([]);
    clean.setCreator('');
    clean.setProducer('');
  }
  const outBytes = await clean.save({ useObjectStreams: true, objectsPerTick: 50 });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-web-optimized.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: clean.getPageCount(),
    summary: stripMetadata
      ? 'Compacted object streams and stripped metadata for smaller transfer.'
      : 'Compacted object streams for web delivery.',
  });
}

/** 23. Redact PDF (True Permanent Burn-In via High-DPI Rasterization on Redacted Pages) */
export async function redactPdf(
  file: File,
  boxes: PageOverlayItem[],
  dpi = 180,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  if (boxes.length === 0) {
    throw new Error('Draw at least one redaction box on a page first.');
  }

  const srcDoc = await PDFDocument.load(await file.arrayBuffer());
  const pdfJsDoc = await openPdfJsDocument(file);
  const outDoc = await PDFDocument.create();

  const boxesByPage = new Map<number, PageOverlayItem[]>();
  for (const box of boxes) {
    const arr = boxesByPage.get(box.pageIndex) ?? [];
    arr.push(box);
    boxesByPage.set(box.pageIndex, arr);
  }

  const total = srcDoc.getPageCount();
  const scale = dpi / 72;

  try {
    for (let idx = 0; idx < total; idx++) {
      const pageBoxes = boxesByPage.get(idx);
      if (!pageBoxes || pageBoxes.length === 0) {
        const [copied] = await outDoc.copyPages(srcDoc, [idx]);
        outDoc.addPage(copied);
      } else {
        // True permanent redaction: render page to canvas, paint opaque black masks,
        // and embed raster image so original PDF text objects under masks no longer exist!
        const srcPage = srcDoc.getPage(idx);
        const { width: pw, height: ph } = srcPage.getSize();
        const { canvas, width: cw, height: ch } = await renderPdfPageToCanvas(
          pdfJsDoc,
          idx + 1,
          scale,
        );
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000000';
        for (const box of pageBoxes) {
          ctx.fillRect(
            Math.floor(box.x * cw),
            Math.floor(box.y * ch),
            Math.ceil(box.width * cw),
            Math.ceil(box.height * ch),
          );
        }
        const pngBytes = dataUrlToUint8Array(canvas.toDataURL('image/png'));
        const embedded = await outDoc.embedPng(pngBytes);
        const newPage = outDoc.addPage([pw, ph]);
        newPage.drawImage(embedded, { x: 0, y: 0, width: pw, height: ph });
      }
      onProgress?.(Math.round(((idx + 1) / total) * 92));
    }
  } finally {
    await closePdfJsDocument(pdfJsDoc);
  }

  const outBytes = await outDoc.save({ useObjectStreams: true });
  onProgress?.(100);
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-redacted.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: total,
    summary: `Permanently burned ${boxes.length} redaction mask(s) across ${boxesByPage.size} page(s). Underlying text on redacted pages has been destroyed.`,
  });
}

/** 25. Crop PDF */
export async function cropPdf(
  file: File,
  cropNormalized: { top: number; right: number; bottom: number; left: number },
  scope: 'all' | 'current',
  currentPageIndex: number,
): Promise<ToolResult> {
  const doc = await PDFDocument.load(await file.arrayBuffer());
  const pages = doc.getPages();

  pages.forEach((page, idx) => {
    if (scope === 'current' && idx !== currentPageIndex) return;
    const { width, height } = page.getSize();
    const x = Math.max(0, cropNormalized.left * width);
    const y = Math.max(0, cropNormalized.bottom * height);
    const w = Math.max(36, width - (cropNormalized.left + cropNormalized.right) * width);
    const h = Math.max(36, height - (cropNormalized.top + cropNormalized.bottom) * height);
    page.setCropBox(x, y, w, h);
    page.setMediaBox(x, y, w, h);
  });

  const outBytes = await doc.save({ useObjectStreams: true });
  const base = sanitizeBaseName(file.name);
  return buildResultFromBytes(outBytes, `${base}-cropped.pdf`, 'application/pdf', {
    originalBytes: file.size,
    pageCount: pages.length,
    summary:
      scope === 'all'
        ? `Cropped margins across all ${pages.length} page(s).`
        : `Cropped margins on page ${currentPageIndex + 1}.`,
  });
}

/** 24. Create PDF & 16. Webpage/HTML/Markdown to PDF */
export async function createPdfFromStructuredBlocks(
  blocks: StructuredTextBlock[],
  options: {
    pageSize: 'a4' | 'letter';
    marginPt: number;
    fileName: string;
    title?: string;
    sourceUrl?: string;
    summary?: string;
  },
): Promise<ToolResult> {
  const doc = await PDFDocument.create();
  if (options.title) doc.setTitle(options.title);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageW = options.pageSize === 'a4' ? 595.28 : 612;
  const pageH = options.pageSize === 'a4' ? 841.89 : 792;
  const m = options.marginPt;
  const contentW = pageW - m * 2;
  const bottomLimit = options.sourceUrl ? m + 16 : m;

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - m;

  if (options.sourceUrl) {
    const safeUrl = options.sourceUrl.replace(/[^\x20-\x7E]/g, '').slice(0, 110);
    const metaLabel = `Source: ${safeUrl}`;
    const metaLines = wrapTextToLines(metaLabel, fontReg, 8.5, contentW);
    for (const ml of metaLines) {
      page.drawText(ml, {
        x: m,
        y: y - 8.5,
        size: 8.5,
        font: fontReg,
        color: rgb(0.42, 0.48, 0.57),
      });
      y -= 12;
    }
    y -= 2;
    page.drawLine({
      start: { x: m, y },
      end: { x: pageW - m, y },
      thickness: 0.5,
      color: rgb(0.84, 0.87, 0.91),
    });
    y -= 14;
  }

  const ensureSpace = (needed: number) => {
    if (y - needed < bottomLimit) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - m;
    }
  };

  for (const block of blocks) {
    if (block.type === 'divider') {
      ensureSpace(18);
      y -= 6;
      page.drawLine({
        start: { x: m, y },
        end: { x: pageW - m, y },
        thickness: 0.75,
        color: rgb(0.8, 0.84, 0.89),
      });
      y -= 14;
      continue;
    }

    const isHeading = block.type === 'heading';
    const isSub = block.type === 'subheading';
    const isBullet = block.type === 'bullet';
    const font = isHeading || isSub ? fontBold : fontReg;
    const size = isHeading ? 20 : isSub ? 14 : 11;
    const lineH = size * 1.45;
    const indent = isBullet ? 16 : 0;
    const lines = wrapTextToLines(block.text, font, size, contentW - indent);

    if (isHeading) y -= 4;
    for (let i = 0; i < lines.length; i++) {
      ensureSpace(lineH);
      if (isBullet && i === 0) {
        page.drawText('•', { x: m + 4, y: y - size, size, font: fontBold, color: rgb(0.88, 0.11, 0.28) });
      }
      page.drawText(lines[i], {
        x: m + indent,
        y: y - size,
        size,
        font,
        color: isHeading ? rgb(0.06, 0.09, 0.16) : rgb(0.18, 0.23, 0.32),
      });
      y -= lineH;
    }
    y -= isHeading ? 10 : isSub ? 6 : 8;
  }

  if (options.sourceUrl) {
    const pages = doc.getPages();
    const total = pages.length;
    pages.forEach((p, idx) => {
      const footerText = `Page ${idx + 1} of ${total}`;
      const textW = fontReg.widthOfTextAtSize(footerText, 8.5);
      p.drawText(footerText, {
        x: pageW - m - textW,
        y: Math.max(20, m * 0.45),
        size: 8.5,
        font: fontReg,
        color: rgb(0.47, 0.53, 0.62),
      });
    });
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return buildResultFromBytes(bytes, options.fileName, 'application/pdf', {
    pageCount: doc.getPageCount(),
    summary: options.summary ?? `Generated a ${doc.getPageCount()}-page vector PDF locally.`,
  });
}

export async function createPdfFromComposerBlocks(
  blocks: CreatePdfBlock[],
  options: { pageSize: 'a4' | 'letter'; marginPt: number; title: string },
): Promise<ToolResult> {
  const doc = await PDFDocument.create();
  doc.setTitle(options.title || 'Untitled Document');
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageW = options.pageSize === 'a4' ? 595.28 : 612;
  const pageH = options.pageSize === 'a4' ? 841.89 : 792;
  const m = options.marginPt;
  const contentW = pageW - m * 2;

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - m;

  const ensureSpace = (needed: number) => {
    if (y - needed < m) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - m;
    }
  };

  for (const block of blocks) {
    if (block.type === 'divider') {
      ensureSpace(18);
      y -= 6;
      page.drawLine({
        start: { x: m, y },
        end: { x: pageW - m, y },
        thickness: 0.75,
        color: rgb(0.8, 0.84, 0.89),
      });
      y -= 14;
    } else if (block.type === 'heading') {
      const lines = wrapTextToLines(block.content, fontBold, 19, contentW);
      for (const line of lines) {
        ensureSpace(26);
        page.drawText(line, { x: m, y: y - 19, size: 19, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
        y -= 26;
      }
      y -= 8;
    } else if (block.type === 'paragraph') {
      const lines = wrapTextToLines(block.content, fontReg, 11, contentW);
      for (const line of lines) {
        ensureSpace(16);
        page.drawText(line, { x: m, y: y - 11, size: 11, font: fontReg, color: rgb(0.18, 0.23, 0.32) });
        y -= 16;
      }
      y -= 8;
    } else if (block.type === 'bullets') {
      const items = block.content.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const item of items) {
        const lines = wrapTextToLines(item, fontReg, 11, contentW - 18);
        for (let i = 0; i < lines.length; i++) {
          ensureSpace(16);
          if (i === 0) {
            page.drawText('•', { x: m + 4, y: y - 11, size: 11, font: fontBold, color: rgb(0.88, 0.11, 0.28) });
          }
          page.drawText(lines[i], { x: m + 18, y: y - 11, size: 11, font: fontReg, color: rgb(0.18, 0.23, 0.32) });
          y -= 16;
        }
      }
      y -= 8;
    } else if (block.type === 'table') {
      const rows = parseCsvRows(block.content);
      if (rows.length > 0) {
        const colCount = Math.max(...rows.map((r) => r.length));
        const colW = contentW / Math.max(1, colCount);
        const rowH = 22;
        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          ensureSpace(rowH + 4);
          if (rIdx === 0) {
            page.drawRectangle({
              x: m,
              y: y - rowH,
              width: contentW,
              height: rowH,
              color: rgb(0.95, 0.96, 0.98),
            });
          }
          for (let cIdx = 0; cIdx < colCount; cIdx++) {
            const val = (rows[rIdx][cIdx] ?? '').slice(0, 36);
            page.drawRectangle({
              x: m + cIdx * colW,
              y: y - rowH,
              width: colW,
              height: rowH,
              borderColor: rgb(0.84, 0.87, 0.91),
              borderWidth: 0.5,
            });
            page.drawText(val.replace(/[^\x20-\x7E\xA0-\xFF]/g, ' '), {
              x: m + cIdx * colW + 6,
              y: y - 15,
              size: 9.5,
              font: rIdx === 0 ? fontBold : fontReg,
              color: rgb(0.1, 0.14, 0.22),
            });
          }
          y -= rowH;
        }
        y -= 12;
      }
    } else if (block.type === 'image' && block.imageDataUrl) {
      const imgBytes = dataUrlToUint8Array(block.imageDataUrl);
      const img = block.imageDataUrl.startsWith('data:image/jpeg')
        ? await doc.embedJpg(imgBytes)
        : await doc.embedPng(imgBytes);
      const scale = Math.min(contentW / img.width, 260 / img.height, 1);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      ensureSpace(drawH + 14);
      page.drawImage(img, { x: m, y: y - drawH, width: drawW, height: drawH });
      y -= drawH + 14;
    }
  }

  const outBytes = await doc.save({ useObjectStreams: true });
  const safeName = `${sanitizeBaseName(options.title || 'new-document')}.pdf`;
  return buildResultFromBytes(outBytes, safeName, 'application/pdf', {
    pageCount: doc.getPageCount(),
    summary: `Built "${safeName}" (${doc.getPageCount()} page(s)) from ${blocks.length} content block(s).`,
  });
}

export interface FetchedWebpageSource {
  sourceUrl: string;
  hostname: string;
  title: string;
  mode: 'html' | 'markdown';
  content: string;
  fetchedVia: 'direct' | 'reader' | 'cors-fallback';
}

const MAX_WEBPAGE_TEXT_BYTES = 4 * 1024 * 1024;

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<{ text: string; contentType: string }> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (
      contentType &&
      !contentType.includes('text/') &&
      !contentType.includes('html') &&
      !contentType.includes('xml') &&
      !contentType.includes('json') &&
      !contentType.includes('markdown')
    ) {
      throw new Error(`Unsupported binary content type (${contentType.split(';')[0]}).`);
    }
    const text = await res.text();
    if (text.length > MAX_WEBPAGE_TEXT_BYTES) {
      return { text: text.slice(0, MAX_WEBPAGE_TEXT_BYTES), contentType };
    }
    return { text, contentType };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Fetches a live public webpage directly in the browser (100% static / GitHub Pages compatible).
 * Tries direct CORS fetch first, then falls back to public CORS-enabled readers for public domains.
 */
export async function fetchWebpageFromUrl(
  rawUrl: string,
  onProgress?: (pct: number, stage?: string) => void,
): Promise<FetchedWebpageSource> {
  const normalized = normalizeWebpageUrl(rawUrl);
  if (normalized.error || !normalized.url || !normalized.hostname) {
    throw new Error(normalized.error ?? 'Enter a valid webpage URL.');
  }

  const targetUrl = normalized.url;
  const hostname = normalized.hostname;

  const isSameOrigin =
    typeof globalThis.location !== 'undefined' &&
    new URL(targetUrl).origin === globalThis.location.origin;
  const isCorsFriendlyRawHost =
    hostname === 'raw.githubusercontent.com' ||
    hostname === 'gist.githubusercontent.com' ||
    hostname === 'cdn.jsdelivr.net' ||
    /\.(?:md|txt)(?:[?#].*)?$/i.test(targetUrl);

  const tryDirectFetch = async (): Promise<FetchedWebpageSource | null> => {
    try {
      const direct = await fetchTextWithTimeout(targetUrl, 7000, {
        Accept: 'text/html,text/markdown,text/plain;q=0.9,*/*;q=0.5',
      });
      const isMarkdown =
        direct.contentType.includes('markdown') ||
        direct.contentType.includes('text/plain') ||
        /\.md(?:[?#].*)?$/i.test(targetUrl);
      if (direct.text.trim().length > 0) {
        const title = (!isMarkdown ? extractHtmlTitle(direct.text) : null) || hostname;
        onProgress?.(65, 'Extracted webpage content directly…');
        return {
          sourceUrl: targetUrl,
          hostname,
          title,
          mode: isMarkdown ? 'markdown' : 'html',
          content: direct.text,
          fetchedVia: 'direct',
        };
      }
      return null;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Unsupported binary content type')) {
        throw new Error(
          `${err.message} This tool converts HTML/text webpages — download the file directly or use our PDF/Image tools instead.`,
        );
      }
      return null;
    }
  };

  onProgress?.(15, `Connecting to ${hostname}…`);

  // For same-origin, private/local URLs, or raw Markdown/text hosts, try direct browser fetch first
  if (isSameOrigin || normalized.isPrivateHost || isCorsFriendlyRawHost) {
    const directResult = await tryDirectFetch();
    if (directResult) return directResult;

    if (normalized.isPrivateHost) {
      throw new Error(
        `Direct fetch to "${hostname}" was blocked by browser CORS, and private/local addresses are never sent to external readers. Save the page as .html (Ctrl+S) and drop the file above instead.`,
      );
    }
  }

  // Primary strategy for public external websites: CORS-friendly reader (r.jina.ai) — works cleanly on static GitHub Pages without CORS console errors
  onProgress?.(35, `Fetching ${hostname} via public webpage reader…`);
  try {
    const readerUrl = `https://r.jina.ai/${targetUrl}`;
    const readerRes = await fetchTextWithTimeout(readerUrl, 20000, {
      Accept: 'text/plain',
    });
    const parsed = parseJinaReaderResponse(readerRes.text, targetUrl);
    if (parsed.markdown.trim().length > 0) {
      onProgress?.(70, 'Parsed webpage article content…');
      return {
        sourceUrl: targetUrl,
        hostname,
        title: parsed.title || hostname,
        mode: 'markdown',
        content: parsed.markdown,
        fetchedVia: 'reader',
      };
    }
  } catch {
    // Fall through to backup readers
  }

  // Fallback 1: Secondary raw HTML CORS relay
  onProgress?.(55, `Trying backup webpage reader for ${hostname}…`);
  try {
    const backupUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
    const backupRes = await fetchTextWithTimeout(backupUrl, 10000);
    if (backupRes.text.trim().length > 0) {
      const title = extractHtmlTitle(backupRes.text) || hostname;
      onProgress?.(75, 'Extracted HTML content…');
      return {
        sourceUrl: targetUrl,
        hostname,
        title,
        mode: 'html',
        content: backupRes.text,
        fetchedVia: 'cors-fallback',
      };
    }
  } catch {
    // Fall through to direct fetch fallback
  }

  // Fallback 2: Direct browser fetch (in case the site allows CORS and public readers were unreachable)
  if (!isSameOrigin && !normalized.isPrivateHost && !isCorsFriendlyRawHost) {
    const directFallback = await tryDirectFetch();
    if (directFallback) return directFallback;
  }

  throw new Error(
    `Could not fetch "${hostname}" automatically (the site may require login, sit behind a paywall, or block automated readers). Save the webpage in your browser (Ctrl+S → Webpage, HTML Only) and drop the saved .html file above.`,
  );
}

/** 16a. Webpage / HTML / Markdown to PDF */
export async function webpageHtmlToPdf(
  sourceText: string,
  mode: 'html' | 'markdown',
  pageSize: 'a4' | 'letter',
  options?: {
    title?: string;
    sourceUrl?: string;
    fileName?: string;
    summary?: string;
  },
): Promise<ToolResult> {
  if (!sourceText.trim()) {
    throw new Error('Enter a webpage link, paste HTML/Markdown, or upload an .html/.md file first.');
  }
  const blocks = mode === 'html' ? stripHtmlToBlocks(sourceText) : parseMarkdownToBlocks(sourceText);
  if (blocks.length === 0) {
    throw new Error('No printable text content was found in the provided markup.');
  }
  const inferredTitle =
    options?.title ||
    (mode === 'html' ? extractHtmlTitle(sourceText) : null) ||
    blocks.find((b) => b.type === 'heading')?.text ||
    'Converted Document';
  const defaultName = options?.fileName
    ? `${sanitizeBaseName(options.fileName)}.pdf`
    : mode === 'html'
      ? 'webpage-converted.pdf'
      : 'markdown-converted.pdf';

  return createPdfFromStructuredBlocks(blocks, {
    pageSize,
    marginPt: 48,
    fileName: defaultName,
    title: inferredTitle,
    sourceUrl: options?.sourceUrl,
    summary: options?.summary,
  });
}

/** 16b. Live Webpage URL Link to PDF */
export async function webpageUrlToPdf(
  rawUrl: string,
  pageSize: 'a4' | 'letter',
  onProgress?: (pct: number, stage?: string) => void,
): Promise<ToolResult> {
  const fetched = await fetchWebpageFromUrl(rawUrl, onProgress);
  onProgress?.(85, 'Building vector PDF…');

  const cleanHost = fetched.hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9-]+/g, '-');
  const cleanTitle =
    fetched.title && fetched.title !== fetched.hostname
      ? fetched.title
          .slice(0, 42)
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
      : '';
  const baseName = cleanTitle ? `${cleanHost}-${cleanTitle}` : cleanHost || 'webpage';

  const methodLabel =
    fetched.fetchedVia === 'direct'
      ? 'direct browser fetch'
      : fetched.fetchedVia === 'reader'
        ? 'public webpage reader'
        : 'backup HTML reader';

  const result = await webpageHtmlToPdf(fetched.content, fetched.mode, pageSize, {
    title: fetched.title,
    sourceUrl: fetched.sourceUrl,
    fileName: baseName,
    summary: `Converted "${fetched.title}" (${fetched.sourceUrl}) via ${methodLabel}.`,
  });
  onProgress?.(100, 'Complete');
  return result;
}

/** 6. Multi-format PDF Converter */
export type PdfConverterTarget =
  | 'pdf'
  | 'txt'
  | 'md'
  | 'html'
  | 'docx'
  | 'pptx'
  | 'pptx-visual'
  | 'xlsx'
  | 'csv'
  | 'png-zip';

export async function convertWithPdfConverter(
  files: File[],
  targetFormat: PdfConverterTarget,
  onProgress?: (pct: number) => void,
  options?: { sheetOrientation?: 'auto' | 'portrait' | 'landscape' },
): Promise<ToolResult> {
  if (files.length === 0) throw new Error('Select at least one file to convert.');
  const first = files[0];
  const base = sanitizeBaseName(first.name);

  if (targetFormat === 'pdf') {
    // Convert Images, PPTX, Sheets (XLSX/ODS/CSV/TSV), DOCX, TXT, MD, or HTML to PDF
    const ext = first.name.toLowerCase().split('.').pop() ?? '';
    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      return imagesToPdf(files, 'a4', 'portrait', 36, onProgress);
    }
    if (ext === 'pptx') {
      return pptxToPdf(first, onProgress);
    }
    if (['xlsx', 'ods', 'csv', 'tsv'].includes(ext)) {
      return spreadsheetToPdf(first, options?.sheetOrientation ?? 'auto', onProgress);
    }
    if (ext === 'ppt' || ext === 'xls' || ext === 'doc') {
      throw new Error(
        `Legacy binary .${ext} (Office 97–2003) files cannot be parsed directly in the browser. Save/export as .${ext}x (or .csv) and drop it here.`,
      );
    }
    if (ext === 'docx') {
      const text = await extractTextFromBasicDocx(first);
      const blocks = parseMarkdownToBlocks(text);
      return createPdfFromStructuredBlocks(blocks, {
        pageSize: 'a4',
        marginPt: 48,
        fileName: `${base}.pdf`,
        title: base,
      });
    }
    const rawText = await first.text();
    const isHtml = ext === 'html' || ext === 'htm' || /<\s*(html|body|p|h1|div)\b/i.test(rawText);
    const blocks = isHtml ? stripHtmlToBlocks(rawText) : parseMarkdownToBlocks(rawText);
    return createPdfFromStructuredBlocks(blocks, {
      pageSize: 'a4',
      marginPt: 48,
      fileName: `${base}.pdf`,
      title: base,
    });
  }

  // Converting FROM PDF
  if (targetFormat === 'png-zip') {
    return pdfToImages(first, 'png', 150, '', onProgress);
  }
  if (targetFormat === 'pptx') {
    return pdfToPptx(first, 'editable', onProgress);
  }
  if (targetFormat === 'pptx-visual') {
    return pdfToPptx(first, 'visual', onProgress);
  }
  if (targetFormat === 'xlsx') {
    return pdfToXlsx(first, onProgress);
  }
  if (targetFormat === 'csv') {
    return pdfToCsv(first, onProgress);
  }

  const pages = await extractPdfTextByPage(first, onProgress);

  if (targetFormat === 'txt') {
    const joined = pages.map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
    const blob = new Blob([joined], { type: 'text/plain;charset=utf-8' });
    return buildResultFromBlob(blob, `${base}.txt`, {
      originalBytes: first.size,
      pageCount: pages.length,
      extraText: joined,
      summary: `Extracted text from ${pages.length} PDF page(s) to plain text.`,
    });
  }

  if (targetFormat === 'md') {
    const joined = pages.map((p) => `## Page ${p.pageNumber}\n\n${p.text}`).join('\n\n---\n\n');
    const blob = new Blob([joined], { type: 'text/markdown;charset=utf-8' });
    return buildResultFromBlob(blob, `${base}.md`, {
      originalBytes: first.size,
      pageCount: pages.length,
      extraText: joined,
      summary: `Converted ${pages.length} PDF page(s) into Markdown.`,
    });
  }

  if (targetFormat === 'html') {
    const body = pages
      .map(
        (p) =>
          `<section><h2>Page ${p.pageNumber}</h2>${p.text
            .split('\n')
            .map((line) => `<p>${escapeXml(line)}</p>`)
            .join('')}</section>`,
      )
      .join('\n<hr />\n');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeXml(base)}</title><style>body{font-family:system-ui,sans-serif;max-width:780px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#0f172a}</style></head><body>${body}</body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    return buildResultFromBlob(blob, `${base}.html`, {
      originalBytes: first.size,
      pageCount: pages.length,
      summary: `Converted ${pages.length} PDF page(s) to clean semantic HTML.`,
    });
  }

  // Basic .docx generation using JSZip (valid OOXML Word document)
  const docxBlob = await buildBasicDocxBlob(pages);
  return buildResultFromBlob(docxBlob, `${base}.docx`, {
    originalBytes: first.size,
    pageCount: pages.length,
    summary: `Exported ${pages.length} PDF page(s) to a basic Word (.docx) document.`,
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function extractTextFromBasicDocx(file: File): Promise<string> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) {
    throw new Error('Could not find word/document.xml inside this .docx archive.');
  }
  const xml = await xmlFile.async('string');
  return xml
    .replace(/<\/w:p>/g, '\n\n')
    .replace(/<w:tab\/>/g, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

async function buildBasicDocxBlob(pages: Array<{ pageNumber: number; text: string }>): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  const paragraphsXml = pages
    .map((p) => {
      const lines = p.text.split('\n').filter(Boolean);
      const heading = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Page ${p.pageNumber}</w:t></w:r></w:p>`;
      const body = lines
        .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
        .join('');
      return heading + body;
    })
    .join('');

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphsXml}<w:sectPr/></w:body>
</w:document>`,
  );

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}
