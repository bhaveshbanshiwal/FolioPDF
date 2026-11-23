import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, rgb, StandardFonts } from '@cantoo/pdf-lib';
import JSZip from 'jszip';
import type { ToolResult } from '../types/tools';
import {
  buildEditablePptxBlob,
  buildVisualPptxBlob,
  buildXlsxBlob,
  decodeXmlEntities,
  groupPdfLinesIntoSheetRows,
  type ParsedSheet,
  parseOdsContentXml,
  parsePptxSlideXml,
  parseTsvRows,
  parseXlsxSharedStringsXml,
  parseXlsxWorksheetXml,
  rowsToCsv,
} from '../utils/officeUtils';
import { parseCsvRows, sanitizeBaseName } from '../utils/pdfUtils';
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
    .replace(/\u2022/g, '*')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?');
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

async function embedZipMediaImage(
  pdfDoc: PDFDocument,
  bytes: Uint8Array,
  mediaPath: string,
): Promise<PDFImage | null> {
  const ext = mediaPath.toLowerCase().split('.').pop() ?? '';
  try {
    if (ext === 'png') {
      return await pdfDoc.embedPng(bytes);
    }
    if (ext === 'jpg' || ext === 'jpeg') {
      return await pdfDoc.embedJpg(bytes);
    }
    // Convert WebP / GIF / BMP via browser canvas if available
    if (typeof document !== 'undefined' && ['webp', 'gif', 'bmp'].includes(ext)) {
      const mime = ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/bmp';
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mime });
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const jpgBlob = await new Promise<Blob | null>((res) =>
          canvas.toBlob((b) => res(b), 'image/jpeg', 0.9),
        );
        if (jpgBlob) {
          return await pdfDoc.embedJpg(new Uint8Array(await jpgBlob.arrayBuffer()));
        }
      }
      bitmap.close();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Converts a PowerPoint (.pptx) presentation into a multi-page vector PDF preserving
 * slide aspect ratio (16:9 / 4:3), background colors, positioned text, tables, and embedded images.
 */
export async function pptxToPdf(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ToolResult> {
  onProgress?.(5);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  let slideWidthEmu = 12192000; // 16:9 default (960 pt)
  let slideHeightEmu = 6858000; // 540 pt
  const orderedSlidePaths: string[] = [];

  const presXmlFile = zip.file('ppt/presentation.xml');
  if (presXmlFile) {
    const presXml = await presXmlFile.async('string');
    const szMatch = /<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/i.exec(presXml);
    if (szMatch) {
      const cx = Number.parseInt(szMatch[1], 10);
      const cy = Number.parseInt(szMatch[2], 10);
      if (cx > 1000000 && cy > 1000000) {
        slideWidthEmu = cx;
        slideHeightEmu = cy;
      }
    }

    const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
    if (presRelsFile) {
      const relMap = parseRelationshipMap(await presRelsFile.async('string'));
      const sldIdRe = /<p:sldId\b[^>]*r:id="([^"]+)"/gi;
      let m: RegExpExecArray | null;
      while ((m = sldIdRe.exec(presXml)) !== null) {
        const target = relMap.get(m[1]);
        if (target) {
          const fullPath = resolveZipTargetPath('ppt', target);
          if (zip.file(fullPath)) orderedSlidePaths.push(fullPath);
        }
      }
    }
  }

  // Fallback: discover ppt/slides/slideN.xml numerically
  if (orderedSlidePaths.length === 0) {
    const found: Array<{ num: number; path: string }> = [];
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      const m = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(relPath);
      if (m) found.push({ num: Number.parseInt(m[1], 10), path: relPath });
    });
    found.sort((a, b) => a.num - b.num);
    orderedSlidePaths.push(...found.map((f) => f.path));
  }

  if (orderedSlidePaths.length === 0) {
    throw new Error('No slides found inside this .pptx presentation.');
  }

  const pdfDoc = await PDFDocument.create();
  const baseName = sanitizeBaseName(file.name);
  pdfDoc.setTitle(baseName);
  pdfDoc.setCreator('FolioPDF');

  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let embeddedImagesCount = 0;

  for (let i = 0; i < orderedSlidePaths.length; i++) {
    const slidePath = orderedSlidePaths[i];
    const slideXml = await zip.file(slidePath)!.async('string');
    const parsed = parsePptxSlideXml(slideXml, i + 1, slideWidthEmu, slideHeightEmu);

    const page = pdfDoc.addPage([parsed.widthPt, parsed.heightPt]);
    const pageW = parsed.widthPt;
    const pageH = parsed.heightPt;

    // Background fill
    if (parsed.bgHex) {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageW,
        height: pageH,
        color: hexToRgb(parsed.bgHex),
      });
    } else {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageW,
        height: pageH,
        color: rgb(1, 1, 1),
      });
      // Subtle top accent bar for clean presentation framing
      page.drawRectangle({
        x: 0,
        y: pageH - 5,
        width: pageW,
        height: 5,
        color: rgb(0.88, 0.11, 0.28),
      });
    }

    // Load slide relationships for embedded images
    const slideFileName = slidePath.split('/').pop() ?? '';
    const slideRelsPath = `ppt/slides/_rels/${slideFileName}.rels`;
    const slideRelsFile = zip.file(slideRelsPath);
    const slideRelMap = slideRelsFile
      ? parseRelationshipMap(await slideRelsFile.async('string'))
      : new Map<string, string>();

    // Draw embedded pictures first (underneath text overlays)
    for (const imgSpec of parsed.images) {
      const target = slideRelMap.get(imgSpec.relId);
      if (!target) continue;
      const mediaPath = resolveZipTargetPath('ppt/slides', target);
      const mediaEntry = zip.file(mediaPath);
      if (!mediaEntry) continue;
      const mediaBytes = await mediaEntry.async('uint8array');
      const embedded = await embedZipMediaImage(pdfDoc, mediaBytes, mediaPath);
      if (!embedded) continue;
      embeddedImagesCount++;

      const boxW = Math.max(40, imgSpec.wFrac * pageW);
      const boxH = Math.max(30, imgSpec.hFrac * pageH);
      const boxX = imgSpec.xFrac * pageW;
      const boxYTop = imgSpec.yFrac * pageH;

      // Preserve aspect ratio within shape box
      const scale = Math.min(boxW / embedded.width, boxH / embedded.height);
      const drawW = embedded.width * scale;
      const drawH = embedded.height * scale;
      const drawX = boxX + (boxW - drawW) / 2;
      const drawY = pageH - boxYTop - boxH + (boxH - drawH) / 2;

      page.drawImage(embedded, {
        x: drawX,
        y: Math.max(8, drawY),
        width: drawW,
        height: drawH,
      });
    }

    // Determine whether shapes have explicit positions or need automatic vertical flow
    let flowCursorY = pageH - 56;
    const marginX = Math.max(36, pageW * 0.055);
    const defaultTextWidth = pageW - marginX * 2;

    // Sort unpositioned shapes so title comes first
    const orderedShapes = [...parsed.shapes].sort((a, b) => {
      if (a.isTitle !== b.isTitle) return a.isTitle ? -1 : 1;
      return a.yFrac - b.yFrac;
    });

    for (const shape of orderedShapes) {
      const useExplicit = shape.hasPosition;
      const boxX = useExplicit ? Math.max(18, shape.xFrac * pageW) : marginX;
      const boxW = useExplicit
        ? Math.max(100, Math.min(pageW - boxX - 18, shape.wFrac * pageW))
        : defaultTextWidth;
      let cursorY = useExplicit
        ? pageH - shape.yFrac * pageH - 18
        : flowCursorY;

      for (const para of shape.paragraphs) {
        const fontSize = Math.max(
          9,
          Math.min(34, para.fontSizePt ?? (shape.isTitle ? 24 : 14)),
        );
        const font = para.isBold ? boldFont : regularFont;
        const prefix = para.isBullet ? '* ' : '';
        const textColor = para.colorHex
          ? hexToRgb(para.colorHex)
          : shape.isTitle
            ? rgb(0.06, 0.09, 0.16)
            : rgb(0.15, 0.21, 0.3);

        const wrapped = wrapTextToWidth(`${prefix}${para.text}`, font, fontSize, boxW);
        const lineHeight = fontSize * 1.32;

        for (const line of wrapped) {
          if (cursorY < 24) break;
          page.drawText(line, {
            x: para.isBullet ? boxX + 8 : boxX,
            y: cursorY,
            size: fontSize,
            font,
            color: textColor,
          });
          cursorY -= lineHeight;
        }
        cursorY -= shape.isTitle ? 8 : 5;
      }

      if (!useExplicit) {
        flowCursorY = Math.min(flowCursorY, cursorY - 6);
      }
    }

    // Draw extracted slide tables cleanly
    let tableCursorY = Math.min(flowCursorY, pageH * 0.45);
    for (const table of parsed.tables) {
      if (table.length === 0) continue;
      const colCount = Math.max(1, ...table.map((r) => r.length));
      const tblW = defaultTextWidth;
      const colW = tblW / colCount;
      const rowH = 20;

      for (let rIdx = 0; rIdx < table.length; rIdx++) {
        if (tableCursorY - rowH < 24) break;
        const isHeader = rIdx === 0;
        page.drawRectangle({
          x: marginX,
          y: tableCursorY - rowH,
          width: tblW,
          height: rowH,
          color: isHeader
            ? rgb(0.12, 0.16, 0.23)
            : rIdx % 2 === 1
              ? rgb(0.97, 0.98, 0.99)
              : rgb(1, 1, 1),
          borderColor: rgb(0.82, 0.85, 0.9),
          borderWidth: 0.6,
        });

        const row = table[rIdx];
        for (let cIdx = 0; cIdx < colCount; cIdx++) {
          const cellVal = sanitizeWinAnsi(row[cIdx] ?? '');
          const font = isHeader ? boldFont : regularFont;
          const clipped = clipTextToWidth(cellVal, font, 9, colW - 8);
          page.drawText(clipped, {
            x: marginX + cIdx * colW + 4,
            y: tableCursorY - rowH + 6,
            size: 9,
            font,
            color: isHeader ? rgb(1, 1, 1) : rgb(0.12, 0.16, 0.23),
          });
        }
        tableCursorY -= rowH;
      }
      tableCursorY -= 12;
    }

    // Subtle slide number indicator in bottom-right corner
    const slideBadge = `${i + 1} / ${orderedSlidePaths.length}`;
    const badgeW = regularFont.widthOfTextAtSize(slideBadge, 9);
    page.drawText(slideBadge, {
      x: pageW - badgeW - 18,
      y: 12,
      size: 9,
      font: regularFont,
      color: rgb(0.45, 0.5, 0.58),
    });

    onProgress?.(10 + Math.round(((i + 1) / orderedSlidePaths.length) * 85));
    if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const outBytes = await pdfDoc.save({ useObjectStreams: true });
  onProgress?.(100);
  const blob = new Blob([outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer], {
    type: 'application/pdf',
  });
  return makeResult(blob, `${baseName}.pdf`, {
    originalBytes: file.size,
    pageCount: orderedSlidePaths.length,
    summary: `Converted ${orderedSlidePaths.length} PowerPoint slide(s)${
      embeddedImagesCount > 0 ? ` and ${embeddedImagesCount} embedded image(s)` : ''
    } to PDF.`,
  });
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

  if (ext === 'xlsx') {
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
      throw new Error('No populated worksheets found inside this .xlsx workbook.');
    }
    return sheets;
  }

  throw new Error(`Unsupported spreadsheet format ".${ext}". Use .xlsx, .ods, .csv, or .tsv.`);
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
