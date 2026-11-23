import JSZip from 'jszip';
import type { MergedPdfTextLine } from './pdfUtils';

export interface ParsedSheet {
  name: string;
  rows: string[][];
}

export interface PptxTextShape {
  xFrac: number; // 0..1
  yFrac: number; // 0..1
  wFrac: number; // 0..1
  hFrac: number; // 0..1
  hasPosition: boolean;
  isTitle: boolean;
  paragraphs: Array<{
    text: string;
    fontSizePt?: number;
    isBold?: boolean;
    isBullet?: boolean;
    colorHex?: string;
  }>;
}

export interface PptxImagePlacement {
  relId: string;
  xFrac: number;
  yFrac: number;
  wFrac: number;
  hFrac: number;
  hasPosition: boolean;
}

export interface ParsedPptxSlide {
  slideNumber: number;
  widthPt: number;
  heightPt: number;
  bgHex?: string;
  shapes: PptxTextShape[];
  tables: string[][][];
  images: PptxImagePlacement[];
}

export interface EditablePptxSlideInput {
  widthPt: number;
  heightPt: number;
  lines: Array<{
    text: string;
    x: number; // 0..1
    y: number; // 0..1
    width: number; // 0..1
    height: number; // 0..1
    fontSizePt: number;
    isBold?: boolean;
    isItalic?: boolean;
  }>;
}

export interface VisualPptxSlideInput {
  widthPt: number;
  heightPt: number;
  jpegBytes: Uint8Array;
}

const EMU_PER_PT = 12700;

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function decodeXmlEntities(str: string): string {
  return str.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/g, (full, ent: string) => {
    if (ent === 'amp') return '&';
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    if (ent === 'nbsp') return ' ';
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const cp = Number.parseInt(ent.slice(2), 16);
      return Number.isFinite(cp) && cp >= 9 ? String.fromCodePoint(cp) : ' ';
    }
    if (ent.startsWith('#')) {
      const cp = Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp >= 9 ? String.fromCodePoint(cp) : ' ';
    }
    return full;
  });
}

/** Converts 0-based column index to Excel column letters (0 -> A, 25 -> Z, 26 -> AA). */
export function columnIndexToExcelRef(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  while (true) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}

/** Parses an Excel cell reference like "AB14" into a 0-based column index. */
export function excelColRefToIndex(cellRef: string): number {
  const letters = cellRef.toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return 0;
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, col - 1);
}

/** Sanitizes a worksheet tab name to meet Excel's 31-char and forbidden-character rules. */
export function sanitizeSheetName(raw: string, fallbackIndex: number): string {
  const cleaned = raw
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || `Sheet ${fallbackIndex}`;
}

/** Extracts shared string entries from xl/sharedStrings.xml. */
export function parseXlsxSharedStringsXml(xml: string): string[] {
  const strings: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml)) !== null) {
    const inner = siMatch[1];
    const parts: string[] = [];
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(inner)) !== null) {
      parts.push(decodeXmlEntities(tMatch[1]));
    }
    strings.push(parts.join(''));
  }
  return strings;
}

/** Parses an OOXML worksheet XML (xl/worksheets/sheetN.xml) into a clean 2D string grid. */
export function parseXlsxWorksheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowContent = rowMatch[1];
    const rowCells: string[] = [];
    let autoCol = 0;

    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const refMatch = /\br="([A-Za-z]+\d+)"/.exec(attrs);
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const cellType = typeMatch ? typeMatch[1] : '';
      const colIdx = refMatch ? excelColRefToIndex(refMatch[1]) : autoCol;
      autoCol = colIdx + 1;

      // Guard against runaway sparse columns
      if (colIdx > 200) continue;

      let value = '';
      if (cellType === 'inlineStr') {
        const tParts: string[] = [];
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
        let tm: RegExpExecArray | null;
        while ((tm = tRe.exec(body)) !== null) {
          tParts.push(decodeXmlEntities(tm[1]));
        }
        value = tParts.join('');
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body);
        const rawVal = vMatch ? decodeXmlEntities(vMatch[1]) : '';
        if (cellType === 's') {
          const idx = Number.parseInt(rawVal, 10);
          value = Number.isFinite(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        } else if (cellType === 'b') {
          value = rawVal === '1' ? 'TRUE' : 'FALSE';
        } else {
          value = rawVal;
        }
      }

      while (rowCells.length <= colIdx) rowCells.push('');
      rowCells[colIdx] = value.trim();
    }

    // Trim trailing empty cells
    while (rowCells.length > 0 && rowCells[rowCells.length - 1] === '') {
      rowCells.pop();
    }
    if (rowCells.some((c) => c.length > 0)) {
      rows.push(rowCells);
    }
  }

  return rows;
}

/** Parses an OpenDocument Spreadsheet (.ods) content.xml into named sheets. */
export function parseOdsContentXml(xml: string): ParsedSheet[] {
  const sheets: ParsedSheet[] = [];
  const tableRegex = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/gi;
  let tMatch: RegExpExecArray | null;
  let sheetCounter = 0;

  while ((tMatch = tableRegex.exec(xml)) !== null) {
    sheetCounter++;
    const attrs = tMatch[1] ?? '';
    const body = tMatch[2] ?? '';
    const nameMatch = /table:name="([^"]+)"/.exec(attrs);
    const name = nameMatch ? decodeXmlEntities(nameMatch[1]) : `Sheet ${sheetCounter}`;
    const rows: string[][] = [];

    const rowRegex = /<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/gi;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rowRegex.exec(body)) !== null) {
      const rBody = rMatch[2] ?? '';
      const rowCells: string[] = [];
      const cellRegex = /<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/gi;
      let cMatch: RegExpExecArray | null;

      while ((cMatch = cellRegex.exec(rBody)) !== null) {
        const cAttrs = cMatch[1] ?? '';
        const cBody = cMatch[2] ?? '';
        const repeatMatch = /table:number-columns-repeated="(\d+)"/.exec(cAttrs);
        const repeat = Math.min(50, repeatMatch ? Number.parseInt(repeatMatch[1], 10) : 1);

        const pTexts: string[] = [];
        const pRegex = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/gi;
        let pMatch: RegExpExecArray | null;
        while ((pMatch = pRegex.exec(cBody)) !== null) {
          pTexts.push(decodeXmlEntities(pMatch[1].replace(/<[^>]+>/g, '')).trim());
        }
        const val = pTexts.filter(Boolean).join(' ');

        // Avoid exploding trailing empty repeated columns
        if (!val && repeat > 10 && rowCells.length > 0) {
          break;
        }
        for (let r = 0; r < repeat; r++) {
          if (rowCells.length >= 120) break;
          rowCells.push(val);
        }
      }

      while (rowCells.length > 0 && rowCells[rowCells.length - 1] === '') {
        rowCells.pop();
      }
      if (rowCells.some((c) => c.length > 0)) {
        rows.push(rowCells);
      }
    }

    if (rows.length > 0) {
      sheets.push({ name, rows });
    }
  }

  return sheets;
}

/** Parses tab-separated values (TSV) into rows. */
export function parseTsvRows(tsv: string): string[][] {
  return tsv
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.split('\t').map((c) => c.trim()))
    .filter((row) => row.some((c) => c.length > 0));
}

/** Parses a single PowerPoint slide XML (ppt/slides/slideN.xml) into positioned shapes, tables, and image placements. */
export function parsePptxSlideXml(
  xml: string,
  slideNumber: number,
  slideWidthEmu = 12192000, // 16:9 widescreen (960 pt)
  slideHeightEmu = 6858000, // 540 pt
): ParsedPptxSlide {
  const widthPt = Math.max(240, Math.round((slideWidthEmu / EMU_PER_PT) * 10) / 10);
  const heightPt = Math.max(180, Math.round((slideHeightEmu / EMU_PER_PT) * 10) / 10);

  // Slide background solid fill
  let bgHex: string | undefined;
  const bgMatch = /<p:bg\b[^>]*>([\s\S]*?)<\/p:bg>/i.exec(xml);
  if (bgMatch) {
    const clrMatch = /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/i.exec(bgMatch[1]);
    if (clrMatch) bgHex = `#${clrMatch[1]}`;
  }

  const shapes: PptxTextShape[] = [];
  const spRegex = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi;
  let spMatch: RegExpExecArray | null;

  while ((spMatch = spRegex.exec(xml)) !== null) {
    const spXml = spMatch[1];
    const txBodyMatch = /<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/i.exec(spXml);
    if (!txBodyMatch) continue;

    const isTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle|subTitle)"/i.test(spXml);
    const xfrm = extractXfrmNormalized(spXml, slideWidthEmu, slideHeightEmu);

    const paragraphs: PptxTextShape['paragraphs'] = [];
    const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pRegex.exec(txBodyMatch[1])) !== null) {
      const pXml = pMatch[1];
      const textParts: string[] = [];
      let fontSizePt: number | undefined;
      let isBold = false;
      let colorHex: string | undefined;

      const isBullet =
        /<a:buChar\b/i.test(pXml) ||
        /<a:buAutoNum\b/i.test(pXml) ||
        (/\blvl="[1-9]"/.test(pXml) && !/<a:buNone\b/i.test(pXml));

      const rRegex = /<a:r\b[^>]*>([\s\S]*?)<\/a:r>/gi;
      let rMatch: RegExpExecArray | null;
      while ((rMatch = rRegex.exec(pXml)) !== null) {
        const rXml = rMatch[1];
        const tMatch = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/i.exec(rXml);
        if (tMatch) {
          textParts.push(decodeXmlEntities(tMatch[1]));
        }
        const rPrMatch = /<a:rPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:rPr>)/i.exec(rXml);
        if (rPrMatch) {
          const rAttrs = rPrMatch[1] ?? '';
          const rInner = rPrMatch[2] ?? '';
          if (!fontSizePt) {
            const szMatch = /\bsz="(\d+)"/.exec(rAttrs);
            if (szMatch) fontSizePt = Number.parseInt(szMatch[1], 10) / 100;
          }
          if (/\bb="1"/.test(rAttrs)) isBold = true;
          if (!colorHex) {
            const clr = /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/i.exec(rInner);
            if (clr) colorHex = `#${clr[1]}`;
          }
        }
      }

      const combined = textParts.join('').replace(/\s+/g, ' ').trim();
      if (combined) {
        paragraphs.push({
          text: combined,
          fontSizePt,
          isBold: isBold || isTitle,
          isBullet: isBullet && !isTitle,
          colorHex,
        });
      }
    }

    if (paragraphs.length > 0) {
      shapes.push({
        xFrac: xfrm.xFrac,
        yFrac: xfrm.yFrac,
        wFrac: xfrm.wFrac,
        hFrac: xfrm.hFrac,
        hasPosition: xfrm.hasPosition,
        isTitle,
        paragraphs,
      });
    }
  }

  // Extract slide tables (<a:tbl>)
  const tables: string[][][] = [];
  const tblRegex = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/gi;
  let tblMatch: RegExpExecArray | null;
  while ((tblMatch = tblRegex.exec(xml)) !== null) {
    const tblRows: string[][] = [];
    const trRegex = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gi;
    let trMatch: RegExpExecArray | null;
    while ((trMatch = trRegex.exec(tblMatch[1])) !== null) {
      const cells: string[] = [];
      const tcRegex = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/gi;
      let tcMatch: RegExpExecArray | null;
      while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
        const texts: string[] = [];
        const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
        let tm: RegExpExecArray | null;
        while ((tm = tRe.exec(tcMatch[1])) !== null) {
          texts.push(decodeXmlEntities(tm[1]));
        }
        cells.push(texts.join(' ').replace(/\s+/g, ' ').trim());
      }
      if (cells.some((c) => c.length > 0)) tblRows.push(cells);
    }
    if (tblRows.length > 0) tables.push(tblRows);
  }

  // Extract positioned pictures (<p:pic>)
  const images: PptxImagePlacement[] = [];
  const picRegex = /<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/gi;
  let picMatch: RegExpExecArray | null;
  while ((picMatch = picRegex.exec(xml)) !== null) {
    const picXml = picMatch[1];
    const blipMatch = /<a:blip\b[^>]*r:embed="([^"]+)"/i.exec(picXml);
    if (!blipMatch) continue;
    const xfrm = extractXfrmNormalized(picXml, slideWidthEmu, slideHeightEmu);
    images.push({
      relId: blipMatch[1],
      xFrac: xfrm.xFrac,
      yFrac: xfrm.yFrac,
      wFrac: xfrm.wFrac,
      hFrac: xfrm.hFrac,
      hasPosition: xfrm.hasPosition,
    });
  }

  return {
    slideNumber,
    widthPt,
    heightPt,
    bgHex,
    shapes,
    tables,
    images,
  };
}

function extractXfrmNormalized(
  fragmentXml: string,
  slideWidthEmu: number,
  slideHeightEmu: number,
): { xFrac: number; yFrac: number; wFrac: number; hFrac: number; hasPosition: boolean } {
  const xfrmMatch = /<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/i.exec(fragmentXml);
  if (!xfrmMatch) {
    return { xFrac: 0.06, yFrac: 0.08, wFrac: 0.88, hFrac: 0.2, hasPosition: false };
  }
  const offMatch = /<a:off\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/i.exec(xfrmMatch[1]);
  const extMatch = /<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/i.exec(xfrmMatch[1]);
  if (!offMatch || !extMatch) {
    return { xFrac: 0.06, yFrac: 0.08, wFrac: 0.88, hFrac: 0.2, hasPosition: false };
  }
  const x = Number.parseInt(offMatch[1], 10);
  const y = Number.parseInt(offMatch[2], 10);
  const cx = Number.parseInt(extMatch[1], 10);
  const cy = Number.parseInt(extMatch[2], 10);
  if (cx <= 0 || cy <= 0) {
    return { xFrac: 0.06, yFrac: 0.08, wFrac: 0.88, hFrac: 0.2, hasPosition: false };
  }
  return {
    xFrac: Math.max(0, Math.min(0.95, x / slideWidthEmu)),
    yFrac: Math.max(0, Math.min(0.95, y / slideHeightEmu)),
    wFrac: Math.max(0.04, Math.min(1, cx / slideWidthEmu)),
    hFrac: Math.max(0.03, Math.min(1, cy / slideHeightEmu)),
    hasPosition: true,
  };
}

/**
 * Reconstructs spreadsheet rows & aligned columns from positioned PDF text lines.
 * Text items on the same horizontal baseline become cells in a row; consistent x-stops
 * across rows map into aligned Excel/CSV columns.
 */
export function groupPdfLinesIntoSheetRows(lines: MergedPdfTextLine[]): string[][] {
  if (lines.length === 0) return [];

  const sorted = [...lines].sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > Math.max(a.height, b.height) * 0.5) return yDiff;
    return a.x - b.x;
  });

  // Group into visual rows by vertical midpoint proximity
  const rawRows: MergedPdfTextLine[][] = [];
  for (const item of sorted) {
    const midY = item.y + item.height * 0.5;
    const prevRow = rawRows[rawRows.length - 1];
    if (prevRow) {
      const ref = prevRow[0];
      const refMidY = ref.y + ref.height * 0.5;
      if (Math.abs(midY - refMidY) <= Math.max(ref.height, item.height) * 0.65) {
        prevRow.push(item);
        continue;
      }
    }
    rawRows.push([item]);
  }

  for (const row of rawRows) {
    row.sort((a, b) => a.x - b.x);
  }

  // Check if the document has multi-column rows; if so, cluster column x-stops
  const hasMultiColumn = rawRows.some((r) => r.length > 1);
  if (!hasMultiColumn) {
    // Also detect tab / pipe / multi-space delimited lines inside single-column text
    return rawRows.map((row) => {
      const text = row[0].text.trim();
      if (text.includes(' | ')) {
        return text.split(/\s*\|\s*/).map((s) => s.trim());
      }
      if (/\s{3,}/.test(text)) {
        return text.split(/\s{3,}/).map((s) => s.trim());
      }
      return [text];
    });
  }

  // Cluster column left-edges across all rows (tolerance 4.5% of page width)
  const colAnchors: number[] = [];
  const allX = rawRows
    .flatMap((r) => r.map((c) => c.x))
    .sort((a, b) => a - b);

  for (const x of allX) {
    const existingIdx = colAnchors.findIndex((anchor) => Math.abs(anchor - x) <= 0.045);
    if (existingIdx === -1) {
      colAnchors.push(x);
    }
  }
  colAnchors.sort((a, b) => a - b);

  return rawRows.map((row) => {
    const cells = new Array<string>(colAnchors.length).fill('');
    for (const item of row) {
      let bestCol = 0;
      let bestDist = Infinity;
      for (let c = 0; c < colAnchors.length; c++) {
        const d = Math.abs(colAnchors[c] - item.x);
        if (d < bestDist) {
          bestDist = d;
          bestCol = c;
        }
      }
      cells[bestCol] = cells[bestCol] ? `${cells[bestCol]} ${item.text.trim()}` : item.text.trim();
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') {
      cells.pop();
    }
    return cells;
  });
}

/** Formats a 2D cell grid into RFC-4180 CSV text. */
export function rowsToCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const val = cell ?? '';
          if (/[",\r\n]/.test(val)) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        })
        .join(','),
    )
    .join('\r\n');
}

/**
 * Generates a valid OOXML Excel workbook (.xlsx) readable by Microsoft Excel,
 * Google Sheets, Apple Numbers, and LibreOffice Calc.
 */
export async function buildXlsxBlob(sheets: ParsedSheet[]): Promise<Blob> {
  const safeSheets: ParsedSheet[] =
    sheets.length > 0
      ? sheets.map((s, idx) => ({
          name: sanitizeSheetName(s.name, idx + 1),
          rows: s.rows.length > 0 ? s.rows : [['(Empty sheet)']],
        }))
      : [{ name: 'Sheet 1', rows: [['(No text extracted)']] }];

  // Ensure unique worksheet names
  const usedNames = new Set<string>();
  for (let i = 0; i < safeSheets.length; i++) {
    let candidate = safeSheets[i].name;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = sanitizeSheetName(`${safeSheets[i].name.slice(0, 27)} ${suffix}`, i + 1);
      suffix++;
    }
    usedNames.add(candidate.toLowerCase());
    safeSheets[i].name = candidate;
  }

  const zip = new JSZip();

  const sheetOverrides = safeSheets
    .map(
      (_, i) =>
        `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('\n');

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetOverrides}
</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );

  const sheetsListXml = safeSheets
    .map(
      (s, i) =>
        `    <sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join('\n');

  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${sheetsListXml}
  </sheets>
</workbook>`,
  );

  const workbookRels = [
    ...safeSheets.map(
      (_, i) =>
        `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    ),
    `  <Relationship Id="rId${safeSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  ].join('\n');

  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${workbookRels}
</Relationships>`,
  );

  // Minimal valid SpreadsheetML styles (s="0" normal, s="1" bold subtle header fill)
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
</styleSheet>`,
  );

  for (let sIdx = 0; sIdx < safeSheets.length; sIdx++) {
    const sheet = safeSheets[sIdx];
    const maxCols = Math.max(1, ...sheet.rows.map((r) => r.length));
    const colWidths = new Array<number>(maxCols).fill(12);

    for (const row of sheet.rows) {
      for (let c = 0; c < row.length; c++) {
        colWidths[c] = Math.min(58, Math.max(colWidths[c], (row[c]?.length ?? 0) + 3));
      }
    }

    const colsXml = colWidths
      .map((w, c) => `    <col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`)
      .join('\n');

    const rowsXml = sheet.rows
      .map((row, rIdx) => {
        const rowNum = rIdx + 1;
        const styleAttr = rIdx === 0 && sheet.rows.length > 1 ? ' s="1"' : '';
        const cellsXml = row
          .map((rawVal, cIdx) => {
            const val = (rawVal ?? '').trim();
            if (!val) return '';
            const ref = `${columnIndexToExcelRef(cIdx)}${rowNum}`;
            // Detect clean plain numbers (not leading-zero IDs like "00123")
            if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(val) && val.length <= 15) {
              return `<c r="${ref}"${styleAttr}><v>${val}</v></c>`;
            }
            return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${escapeXml(val)}</t></is></c>`;
          })
          .filter(Boolean)
          .join('');
        return `    <row r="${rowNum}">${cellsXml}</row>`;
      })
      .join('\n');

    zip.file(
      `xl/worksheets/sheet${sIdx + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
${colsXml}
  </cols>
  <sheetData>
${rowsXml}
  </sheetData>
</worksheet>`,
    );
  }

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function addMinimalPptxScaffold(
  zip: JSZip,
  slideCount: number,
  slideWidthPt: number,
  slideHeightPt: number,
  includeJpegContentType: boolean,
): void {
  const cx = Math.round(slideWidthPt * EMU_PER_PT);
  const cy = Math.round(slideHeightPt * EMU_PER_PT);

  const slideOverrides = Array.from(
    { length: slideCount },
    (_, i) =>
      `  <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join('\n');

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${includeJpegContentType ? '  <Default Extension="jpg" ContentType="image/jpeg"/>\n' : ''}  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slideOverrides}
</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
  );

  const sldIdLst = Array.from(
    { length: slideCount },
    (_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`,
  ).join('\n');

  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
${sldIdLst}
  </p:sldIdLst>
  <p:sldSz cx="${cx}" cy="${cy}"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );

  const presRels = [
    `  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    ...Array.from(
      { length: slideCount },
      (_, i) =>
        `  <Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    ),
  ].join('\n');

  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${presRels}
</Relationships>`,
  );

  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
</p:sldMaster>`,
  );

  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
  );

  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`,
  );

  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
  );

  zip.file(
    'ppt/theme/theme1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="FolioPDF Theme">
  <a:themeElements>
    <a:clrScheme name="FolioPDF">
      <a:dk1><a:srgbClr val="0F172A"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="334155"/></a:dk2>
      <a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="E11D48"/></a:accent1>
      <a:accent2><a:srgbClr val="2563EB"/></a:accent2>
      <a:accent3><a:srgbClr val="059669"/></a:accent3>
      <a:accent4><a:srgbClr val="D97706"/></a:accent4>
      <a:accent5><a:srgbClr val="7C3AED"/></a:accent5>
      <a:accent6><a:srgbClr val="0891B2"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="FolioPDF">
      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="FolioPDF">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`,
  );
}

/**
 * Generates a valid PowerPoint (.pptx) presentation with editable vector text boxes
 * placed at each PDF line's proportional coordinates.
 */
export async function buildEditablePptxBlob(slides: EditablePptxSlideInput[]): Promise<Blob> {
  const safeSlides: EditablePptxSlideInput[] =
    slides.length > 0 ? slides : [{ widthPt: 720, heightPt: 540, lines: [] }];

  const baseW = safeSlides[0].widthPt || 720;
  const baseH = safeSlides[0].heightPt || 540;
  const slideW = Math.round(baseW * EMU_PER_PT);
  const slideH = Math.round(baseH * EMU_PER_PT);

  const zip = new JSZip();
  addMinimalPptxScaffold(zip, safeSlides.length, baseW, baseH, false);

  for (let i = 0; i < safeSlides.length; i++) {
    const slide = safeSlides[i];
    const shapesXml = slide.lines
      .map((line, idx) => {
        const x = Math.max(0, Math.round(line.x * slideW));
        const y = Math.max(0, Math.round(line.y * slideH));
        const w = Math.max(450000, Math.min(slideW - x, Math.round((line.width + 0.05) * slideW)));
        const h = Math.max(220000, Math.min(slideH - y, Math.round((line.height * 1.45) * slideH)));
        const sz = Math.max(800, Math.min(6400, Math.round(line.fontSizePt * 100)));
        const boldAttr = line.isBold ? ' b="1"' : '';
        const italicAttr = line.isItalic ? ' i="1"' : '';
        const shapeId = idx + 2;
        return `      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="${shapeId}" name="TextBox ${shapeId}"/>
          <p:cNvSpPr txBox="1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>
          <a:lstStyle/>
          <a:p>
            <a:r>
              <a:rPr lang="en-US" sz="${sz}"${boldAttr}${italicAttr}><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill></a:rPr>
              <a:t>${escapeXml(line.text)}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>`;
      })
      .join('\n');

    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${shapesXml}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`,
    );

    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    );
  }

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

/**
 * Generates a valid PowerPoint (.pptx) presentation where each PDF page is embedded
 * as a crisp full-bleed slide image preserving 100% of charts, fonts, and visual layout.
 */
export async function buildVisualPptxBlob(slides: VisualPptxSlideInput[]): Promise<Blob> {
  if (slides.length === 0) {
    throw new Error('No pages available to export into PowerPoint.');
  }
  const baseW = slides[0].widthPt || 720;
  const baseH = slides[0].heightPt || 540;
  const slideW = Math.round(baseW * EMU_PER_PT);
  const slideH = Math.round(baseH * EMU_PER_PT);

  const zip = new JSZip();
  addMinimalPptxScaffold(zip, slides.length, baseW, baseH, true);

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const mediaName = `slide${i + 1}.jpg`;
    zip.file(`ppt/media/${mediaName}`, slide.jpegBytes);

    // Fit page aspect ratio cleanly centered inside the presentation slide canvas
    const pageAspect = (slide.widthPt || baseW) / (slide.heightPt || baseH);
    const deckAspect = baseW / baseH;
    let drawW = slideW;
    let drawH = slideH;
    let offX = 0;
    let offY = 0;
    if (Math.abs(pageAspect - deckAspect) > 0.01) {
      if (pageAspect > deckAspect) {
        drawW = slideW;
        drawH = Math.round(slideW / pageAspect);
        offY = Math.round((slideH - drawH) / 2);
      } else {
        drawH = slideH;
        drawW = Math.round(slideH * pageAspect);
        offX = Math.round((slideW - drawW) / 2);
      }
    }

    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="2" name="Page ${i + 1}"/>
          <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rId2"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${drawW}" cy="${drawH}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`,
    );

    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>
</Relationships>`,
    );
  }

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}
