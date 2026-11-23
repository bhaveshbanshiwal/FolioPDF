import {
  decodeXmlEntities,
  type ParsedPptxSlide,
  type ParsedSheet,
  type PptxImagePlacement,
  type PptxTextShape,
} from './officeUtils';
import {
  parseMarkdownToBlocks,
  stripHtmlToBlocks,
  type StructuredTextBlock,
} from './pdfUtils';

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

export function isOle2Signature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== OLE2_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Pure TypeScript Microsoft Compound Binary File Format (OLE2 / CFBF) stream reader.
 * Supports 512-byte and 4096-byte sectors, DIFAT, FAT, and MiniFAT streams
 * for legacy .ppt, .doc, and .xls files 100% locally in the browser.
 */
export function parseOle2Streams(bytes: Uint8Array): Map<string, Uint8Array> {
  const streams = new Map<string, Uint8Array>();
  if (!isOle2Signature(bytes) || bytes.length < 512) {
    return streams;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorShift = view.getUint16(30, true);
  const miniSectorShift = view.getUint16(32, true);
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  if (sectorSize < 512 || sectorSize > 4096 || miniSectorSize < 32 || miniSectorSize > 512) {
    return streams;
  }

  const firstDirSector = view.getUint32(48, true);
  const miniCutoffSize = view.getUint32(56, true);
  const firstMiniFatSector = view.getUint32(60, true);
  const firstDifatSector = view.getUint32(68, true);
  const numDifatSectors = view.getUint32(72, true);

  const sectorOffset = (secId: number): number => 512 + secId * sectorSize;

  // 1. Collect FAT sector IDs from header DIFAT (109 entries) + chained DIFAT sectors
  const fatSectorIds: number[] = [];
  for (let i = 0; i < 109; i++) {
    const id = view.getUint32(76 + i * 4, true);
    if (id !== FREESECT && id !== ENDOFCHAIN) fatSectorIds.push(id);
  }

  let difatSec = firstDifatSector;
  let difatGuard = 0;
  while (
    difatSec !== ENDOFCHAIN &&
    difatSec !== FREESECT &&
    difatGuard < numDifatSectors + 2 &&
    difatGuard < 1024
  ) {
    difatGuard++;
    const off = sectorOffset(difatSec);
    if (off + sectorSize > bytes.length) break;
    const entries = sectorSize / 4 - 1;
    for (let i = 0; i < entries; i++) {
      const id = view.getUint32(off + i * 4, true);
      if (id !== FREESECT && id !== ENDOFCHAIN) fatSectorIds.push(id);
    }
    difatSec = view.getUint32(off + entries * 4, true);
  }

  // 2. Build flat FAT table
  const fatEntriesPerSector = sectorSize / 4;
  const fat = new Uint32Array(fatSectorIds.length * fatEntriesPerSector);
  for (let i = 0; i < fatSectorIds.length; i++) {
    const off = sectorOffset(fatSectorIds[i]);
    if (off + sectorSize > bytes.length) continue;
    for (let j = 0; j < fatEntriesPerSector; j++) {
      fat[i * fatEntriesPerSector + j] = view.getUint32(off + j * 4, true);
    }
  }

  const readRegularChain = (startSec: number, expectedSize?: number): Uint8Array => {
    const chunks: Uint8Array[] = [];
    const visited = new Set<number>();
    let sec = startSec;
    let total = 0;
    while (sec !== ENDOFCHAIN && sec !== FREESECT && sec < fat.length && !visited.has(sec)) {
      visited.add(sec);
      const off = sectorOffset(sec);
      if (off >= bytes.length) break;
      const end = Math.min(bytes.length, off + sectorSize);
      chunks.push(bytes.subarray(off, end));
      total += end - off;
      if (expectedSize !== undefined && total >= expectedSize) break;
      sec = fat[sec];
    }
    const finalLen = expectedSize !== undefined ? Math.min(expectedSize, total) : total;
    const out = new Uint8Array(finalLen);
    let pos = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, finalLen - pos);
      if (take <= 0) break;
      out.set(c.subarray(0, take), pos);
      pos += take;
    }
    return out;
  };

  // 3. Read Directory stream
  const dirBytes = readRegularChain(firstDirSector);
  if (dirBytes.length < 128) return streams;
  const dirView = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);

  // Build MiniFAT & Root MiniStream
  const miniFatBytes =
    firstMiniFatSector !== ENDOFCHAIN && firstMiniFatSector !== FREESECT
      ? readRegularChain(firstMiniFatSector)
      : new Uint8Array(0);
  const miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
  const mfView = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  for (let i = 0; i < miniFat.length; i++) {
    miniFat[i] = mfView.getUint32(i * 4, true);
  }

  // Directory entry 0 is always Root Entry containing the MiniStream container
  const rootStartSec = dirView.getUint32(116, true);
  const rootSize = dirView.getUint32(120, true);
  const miniStream =
    rootStartSec !== ENDOFCHAIN && rootStartSec !== FREESECT && rootSize > 0
      ? readRegularChain(rootStartSec, rootSize)
      : new Uint8Array(0);

  const readMiniChain = (startSec: number, expectedSize: number): Uint8Array => {
    const out = new Uint8Array(expectedSize);
    const visited = new Set<number>();
    let sec = startSec;
    let pos = 0;
    while (
      sec !== ENDOFCHAIN &&
      sec !== FREESECT &&
      sec < miniFat.length &&
      !visited.has(sec) &&
      pos < expectedSize
    ) {
      visited.add(sec);
      const off = sec * miniSectorSize;
      if (off >= miniStream.length) break;
      const take = Math.min(miniSectorSize, miniStream.length - off, expectedSize - pos);
      out.set(miniStream.subarray(off, off + take), pos);
      pos += take;
      sec = miniFat[sec];
    }
    return out;
  };

  // 4. Enumerate all stream entries (entryType === 2)
  const entryCount = Math.floor(dirBytes.length / 128);
  for (let idx = 1; idx < entryCount; idx++) {
    const base = idx * 128;
    const entryType = dirBytes[base + 66];
    if (entryType !== 2) continue; // 2 = Stream object

    const nameByteLen = Math.min(64, dirView.getUint16(base + 64, true));
    let name = '';
    for (let c = 0; c + 1 < nameByteLen; c += 2) {
      const code = dirView.getUint16(base + c, true);
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    if (!name) continue;

    const startSec = dirView.getUint32(base + 116, true);
    const sizeLow = dirView.getUint32(base + 120, true);
    if (sizeLow === 0 || sizeLow > 200 * 1024 * 1024) continue;

    const data =
      sizeLow < miniCutoffSize && miniStream.length > 0
        ? readMiniChain(startSec, sizeLow)
        : readRegularChain(startSec, sizeLow);
    streams.set(name, data);
  }

  return streams;
}

function decodeUtf16Le(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) continue;
    out += String.fromCharCode(code);
  }
  return out;
}

function decodeLatin1Bytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) continue;
    out += String.fromCharCode(b);
  }
  return out;
}

/**
 * Extracts slides from a legacy PowerPoint 97–2003 binary (.ppt) file.
 * Walks the OLE2 "PowerPoint Document" binary record tree (Slide 0x03EE,
 * TextCharsAtom 0x0FA0 UTF-16LE, TextBytesAtom 0x0FA8 Latin-1).
 */
export function extractSlidesFromLegacyPpt(bytes: Uint8Array): ParsedPptxSlide[] {
  const streams = parseOle2Streams(bytes);
  const pptStream =
    streams.get('PowerPoint Document') ??
    Array.from(streams.entries()).find(([k]) => k.toLowerCase() === 'powerpoint document')?.[1];

  const slideTexts: string[][] = [];

  if (pptStream && pptStream.length >= 8) {
    const view = new DataView(pptStream.buffer, pptStream.byteOffset, pptStream.byteLength);
    let currentSlideLines: string[] = [];

    const flushSlide = () => {
      const cleaned = currentSlideLines.map((l) => l.trim()).filter(Boolean);
      if (cleaned.length > 0) {
        slideTexts.push(cleaned);
      }
      currentSlideLines = [];
    };

    const walkRecords = (start: number, end: number, depth: number) => {
      if (depth > 16) return;
      let pos = start;
      while (pos + 8 <= end) {
        const verInst = view.getUint16(pos, true);
        const recVer = verInst & 0x0f;
        const recType = view.getUint16(pos + 2, true);
        const recLen = view.getUint32(pos + 4, true);
        const bodyStart = pos + 8;
        const bodyEnd = bodyStart + recLen;
        if (bodyEnd > end || recLen > pptStream.length) break;

        if (recType === 0x03ee) {
          // RT_Slide container: start a new slide
          flushSlide();
          walkRecords(bodyStart, bodyEnd, depth + 1);
          flushSlide();
        } else if (recType === 0x0fa0 && recLen > 0) {
          // RT_TextCharsAtom (UTF-16LE)
          const raw = decodeUtf16Le(pptStream.subarray(bodyStart, bodyEnd));
          for (const line of raw.split(/[\r\n\x0b]+/)) {
            const trimmed = line.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
            if (trimmed) currentSlideLines.push(trimmed);
          }
        } else if (recType === 0x0fa8 && recLen > 0) {
          // RT_TextBytesAtom (CP1252 / Latin-1)
          const raw = decodeLatin1Bytes(pptStream.subarray(bodyStart, bodyEnd));
          for (const line of raw.split(/[\r\n\x0b]+/)) {
            const trimmed = line.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
            if (trimmed) currentSlideLines.push(trimmed);
          }
        } else if (recVer === 0x0f && recType !== 0x03f8 && recType !== 0x0ff0) {
          // Container record (skip Notes/MainMaster duplicates when possible)
          walkRecords(bodyStart, bodyEnd, depth + 1);
        }

        pos = bodyEnd;
      }
    };

    walkRecords(0, pptStream.length, 0);
    flushSlide();
  }

  if (slideTexts.length === 0) {
    // Fallback: extract printable ASCII/UTF-16 text runs from raw bytes
    const fallbackLines = extractPrintableRunsFallback(pptStream ?? bytes);
    if (fallbackLines.length > 0) {
      slideTexts.push(fallbackLines.slice(0, 40));
    }
  }

  return slideTexts.map((lines, idx): ParsedPptxSlide => {
    const title = lines[0] ?? `Slide ${idx + 1}`;
    const body = lines.slice(1);
    const shapes: PptxTextShape[] = [
      {
        xFrac: 0.06,
        yFrac: 0.08,
        wFrac: 0.88,
        hFrac: 0.16,
        hasPosition: false,
        isTitle: true,
        paragraphs: [{ text: title, fontSizePt: 24, isBold: true }],
      },
    ];
    if (body.length > 0) {
      shapes.push({
        xFrac: 0.06,
        yFrac: 0.26,
        wFrac: 0.88,
        hFrac: 0.64,
        hasPosition: false,
        isTitle: false,
        paragraphs: body.map((b) => ({
          text: b,
          fontSizePt: 14,
          isBullet: body.length > 1,
        })),
      });
    }
    return {
      slideNumber: idx + 1,
      widthPt: 720,
      heightPt: 540,
      shapes,
      tables: [],
      images: [],
    };
  });
}

function decodeRkNumber(rk: number): number {
  const isMultiplied = (rk & 0x01) !== 0;
  const isInt = (rk & 0x02) !== 0;
  let value: number;
  if (isInt) {
    value = rk >> 2;
  } else {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, rk & 0xfffffffc, true);
    value = dv.getFloat64(0, true);
  }
  if (isMultiplied) value /= 100;
  return Math.round(value * 1e10) / 1e10;
}

function readBiff8String(
  buf: Uint8Array,
  offset: number,
  twoByteLen: boolean,
): { text: string; nextOffset: number } {
  if (offset + (twoByteLen ? 3 : 2) > buf.length) {
    return { text: '', nextOffset: buf.length };
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const charCount = twoByteLen ? dv.getUint16(offset, true) : buf[offset];
  let pos = offset + (twoByteLen ? 2 : 1);
  const flags = buf[pos++];
  const isUtf16 = (flags & 0x01) !== 0;
  const hasExtended = (flags & 0x04) !== 0;
  const hasRichText = (flags & 0x08) !== 0;

  let rtRuns = 0;
  let extSize = 0;
  if (hasRichText && pos + 2 <= buf.length) {
    rtRuns = dv.getUint16(pos, true);
    pos += 2;
  }
  if (hasExtended && pos + 4 <= buf.length) {
    extSize = dv.getUint32(pos, true);
    pos += 4;
  }

  let text = '';
  if (isUtf16) {
    const byteLen = Math.min(charCount * 2, buf.length - pos);
    text = decodeUtf16Le(buf.subarray(pos, pos + byteLen));
    pos += byteLen;
  } else {
    const byteLen = Math.min(charCount, buf.length - pos);
    text = decodeLatin1Bytes(buf.subarray(pos, pos + byteLen));
    pos += byteLen;
  }

  pos += rtRuns * 4 + extSize;
  return { text, nextOffset: Math.min(buf.length, pos) };
}

/**
 * Extracts worksheets from a legacy Excel 97–2003 (.xls) file.
 * Handles true BIFF8 OLE2 binary workbooks AND HTML/SpreadsheetML XML files saved as .xls.
 */
export function extractSheetsFromLegacyXls(bytes: Uint8Array, fallbackName: string): ParsedSheet[] {
  // Check for HTML or SpreadsheetML 2003 XML disguised as .xls (very common from ERP/bank exports)
  const headText = decodeLatin1Bytes(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (headText.startsWith('<')) {
    const fullText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // SpreadsheetML 2003 XML (<Worksheet ss:Name="..."><Table><Row><Cell><Data>)
    if (/<Worksheet\b/i.test(fullText) && /<Row\b/i.test(fullText)) {
      const sheets: ParsedSheet[] = [];
      const wsRe = /<Worksheet\b([^>]*)>([\s\S]*?)<\/Worksheet>/gi;
      let wm: RegExpExecArray | null;
      while ((wm = wsRe.exec(fullText)) !== null) {
        const nameMatch = /ss:Name="([^"]+)"/i.exec(wm[1] ?? '');
        const rows: string[][] = [];
        const rowRe = /<Row\b[^>]*>([\s\S]*?)<\/Row>/gi;
        let rm: RegExpExecArray | null;
        while ((rm = rowRe.exec(wm[2])) !== null) {
          const cells: string[] = [];
          const cellRe = /<Cell\b[^>]*>([\s\S]*?)<\/Cell>/gi;
          let cm: RegExpExecArray | null;
          while ((cm = cellRe.exec(rm[1])) !== null) {
            const dataMatch = /<Data\b[^>]*>([\s\S]*?)<\/Data>/i.exec(cm[1]);
            cells.push(dataMatch ? decodeXmlEntities(dataMatch[1]).trim() : '');
          }
          if (cells.some((c) => c.length > 0)) rows.push(cells);
        }
        if (rows.length > 0) {
          sheets.push({
            name: nameMatch ? decodeXmlEntities(nameMatch[1]) : `Sheet ${sheets.length + 1}`,
            rows,
          });
        }
      }
      if (sheets.length > 0) return sheets;
    }

    // HTML <table> saved with .xls extension
    if (/<tr\b/i.test(fullText)) {
      const rows: string[][] = [];
      const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let trm: RegExpExecArray | null;
      while ((trm = trRe.exec(fullText)) !== null) {
        const cells: string[] = [];
        const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let tdm: RegExpExecArray | null;
        while ((tdm = tdRe.exec(trm[1])) !== null) {
          cells.push(decodeXmlEntities(tdm[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
        }
        if (cells.some((c) => c.length > 0)) rows.push(cells);
      }
      if (rows.length > 0) return [{ name: fallbackName || 'Sheet 1', rows }];
    }
  }

  // True OLE2 BIFF8 Excel binary (.xls)
  const streams = parseOle2Streams(bytes);
  const wb =
    streams.get('Workbook') ??
    streams.get('Book') ??
    Array.from(streams.entries()).find(([k]) => /^work?book$/i.test(k))?.[1];

  if (!wb || wb.length < 16) {
    return [];
  }

  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const sheetMeta: Array<{ name: string; bofOffset: number }> = [];
  const sharedStrings: string[] = [];

  // Pass 1: Read workbook globals (BOUNDSHEET 0x0085 & SST 0x00FC + CONTINUE 0x003C)
  let pos = 0;
  while (pos + 4 <= wb.length) {
    const recType = dv.getUint16(pos, true);
    const recLen = dv.getUint16(pos + 2, true);
    const dataStart = pos + 4;
    const dataEnd = dataStart + recLen;
    if (dataEnd > wb.length) break;

    if (recType === 0x0085 && recLen >= 8) {
      // BOUNDSHEET
      const bofOffset = dv.getUint32(dataStart, true);
      const { text } = readBiff8String(wb.subarray(dataStart, dataEnd), 6, false);
      sheetMeta.push({ name: text || `Sheet ${sheetMeta.length + 1}`, bofOffset });
    } else if (recType === 0x00fc && recLen >= 8) {
      // SST (collect immediate CONTINUE 0x003C payloads cleanly)
      const uniqueCount = dv.getUint32(dataStart + 4, true);
      const chunks: Uint8Array[] = [wb.subarray(dataStart + 8, dataEnd)];
      let nextPos = dataEnd;
      while (nextPos + 4 <= wb.length && dv.getUint16(nextPos, true) === 0x003c) {
        const contLen = dv.getUint16(nextPos + 2, true);
        if (nextPos + 4 + contLen > wb.length) break;
        // Skip 1-byte continuation encoding flag only when parsing across string boundaries;
        // simple concat handles standard non-split strings cleanly.
        chunks.push(wb.subarray(nextPos + 4, nextPos + 4 + contLen));
        nextPos += 4 + contLen;
      }
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const merged = new Uint8Array(totalLen);
      let cursor = 0;
      for (const c of chunks) {
        merged.set(c, cursor);
        cursor += c.length;
      }
      let sOff = 0;
      for (let i = 0; i < uniqueCount && sOff < merged.length && i < 100000; i++) {
        const parsed = readBiff8String(merged, sOff, true);
        sharedStrings.push(parsed.text);
        if (parsed.nextOffset <= sOff) break;
        sOff = parsed.nextOffset;
      }
      pos = nextPos;
      continue;
    } else if (recType === 0x000a) {
      // EOF of workbook globals
      break;
    }

    pos = dataEnd;
  }

  // Pass 2: Parse each worksheet starting at its BOF offset
  const sheets: ParsedSheet[] = [];
  for (const meta of sheetMeta) {
    if (meta.bofOffset >= wb.length) continue;
    const grid = new Map<number, Map<number, string>>();
    let maxRow = -1;

    const setCell = (r: number, c: number, val: string) => {
      if (r < 0 || c < 0 || c > 200 || r > 50000) return;
      let rowMap = grid.get(r);
      if (!rowMap) {
        rowMap = new Map<number, string>();
        grid.set(r, rowMap);
      }
      rowMap.set(c, val.trim());
      if (r > maxRow) maxRow = r;
    };

    let sPos = meta.bofOffset;
    let lastFormulaCell: { r: number; c: number } | null = null;
    while (sPos + 4 <= wb.length) {
      const recType = dv.getUint16(sPos, true);
      const recLen = dv.getUint16(sPos + 2, true);
      const dStart = sPos + 4;
      const dEnd = dStart + recLen;
      if (dEnd > wb.length) break;

      if (recType === 0x000a) {
        break; // Worksheet EOF
      } else if (recType === 0x00fd && recLen >= 10) {
        // LABELSST
        const r = dv.getUint16(dStart, true);
        const c = dv.getUint16(dStart + 2, true);
        const sstIdx = dv.getUint32(dStart + 6, true);
        setCell(r, c, sharedStrings[sstIdx] ?? '');
      } else if (recType === 0x0204 && recLen >= 8) {
        // LABEL
        const r = dv.getUint16(dStart, true);
        const c = dv.getUint16(dStart + 2, true);
        const { text } = readBiff8String(wb.subarray(dStart, dEnd), 6, true);
        setCell(r, c, text);
      } else if (recType === 0x0203 && recLen >= 14) {
        // NUMBER
        const r = dv.getUint16(dStart, true);
        const c = dv.getUint16(dStart + 2, true);
        const num = dv.getFloat64(dStart + 6, true);
        if (Number.isFinite(num)) setCell(r, c, String(Math.round(num * 1e10) / 1e10));
      } else if (recType === 0x027e && recLen >= 10) {
        // RK
        const r = dv.getUint16(dStart, true);
        const c = dv.getUint16(dStart + 2, true);
        const rk = dv.getInt32(dStart + 6, true);
        setCell(r, c, String(decodeRkNumber(rk)));
      } else if (recType === 0x00bd && recLen >= 10) {
        // MULRK
        const r = dv.getUint16(dStart, true);
        const firstCol = dv.getUint16(dStart + 2, true);
        const count = Math.floor((recLen - 6) / 6);
        for (let k = 0; k < count; k++) {
          const rk = dv.getInt32(dStart + 4 + k * 6 + 2, true);
          setCell(r, firstCol + k, String(decodeRkNumber(rk)));
        }
      } else if (recType === 0x0205 && recLen >= 8) {
        // BOOLERR
        const r = dv.getUint16(dStart, true);
        const c = dv.getUint16(dStart + 2, true);
        const val = wb[dStart + 6];
        const isErr = wb[dStart + 7] !== 0;
        if (!isErr) setCell(r, c, val ? 'TRUE' : 'FALSE');
      } else if (recType === 0x0006 && recLen >= 14) {
        // FORMULA cached result
        const r = dv.getUint16(dStart, true);
        const c = dv.getUint16(dStart + 2, true);
        const isSpecial = wb[dStart + 12] === 0xff && wb[dStart + 13] === 0xff;
        if (isSpecial) {
          const kind = wb[dStart + 6];
          if (kind === 0) lastFormulaCell = { r, c };
          else if (kind === 1) setCell(r, c, wb[dStart + 8] ? 'TRUE' : 'FALSE');
        } else {
          const num = dv.getFloat64(dStart + 6, true);
          if (Number.isFinite(num)) setCell(r, c, String(Math.round(num * 1e10) / 1e10));
        }
      } else if (recType === 0x0207 && lastFormulaCell) {
        // STRING cached value following FORMULA
        const { text } = readBiff8String(wb.subarray(dStart, dEnd), 0, true);
        setCell(lastFormulaCell.r, lastFormulaCell.c, text);
        lastFormulaCell = null;
      }

      if (recType !== 0x0006) lastFormulaCell = null;
      sPos = dEnd;
    }

    const rows: string[][] = [];
    const sortedRowNums = Array.from(grid.keys()).sort((a, b) => a - b);
    for (const rNum of sortedRowNums) {
      const rowMap = grid.get(rNum)!;
      const maxCol = Math.max(...Array.from(rowMap.keys()));
      const arr = new Array<string>(maxCol + 1).fill('');
      for (const [c, val] of rowMap.entries()) {
        arr[c] = val;
      }
      if (arr.some((x) => x.length > 0)) rows.push(arr);
    }

    if (rows.length > 0) {
      sheets.push({ name: meta.name, rows });
    }
  }

  return sheets;
}

/**
 * Parses Rich Text Format (.rtf) into clean structured text blocks.
 */
export function parseRtfToBlocks(rtf: string): StructuredTextBlock[] {
  const skipDestinations = new Set([
    'fonttbl',
    'colortbl',
    'stylesheet',
    'info',
    'pict',
    'object',
    'header',
    'footer',
    'headerl',
    'headerr',
    'footerl',
    'footerr',
    'listtable',
    'listoverridetable',
    'rsidtbl',
    'themedata',
    'colorschememapping',
    'latentstyles',
    'datastore',
    'xmlnstbl',
  ]);

  let out = '';
  const skipStack: boolean[] = [];
  let skipCurrent = false;
  let i = 0;

  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') {
      skipStack.push(skipCurrent);
      i++;
      continue;
    }
    if (ch === '}') {
      skipCurrent = skipStack.pop() ?? false;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '\\') {
      i++;
      if (i >= rtf.length) break;
      const next = rtf[i];
      if (next === '*' && !skipCurrent) {
        skipCurrent = true;
        i++;
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') {
        if (!skipCurrent) out += next;
        i++;
        continue;
      }
      if (next === '~') {
        if (!skipCurrent) out += ' ';
        i++;
        continue;
      }
      if (next === "'") {
        const hex = rtf.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          if (!skipCurrent) out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 3;
          continue;
        }
      }

      // Control word
      const wordMatch = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i));
      if (wordMatch) {
        const word = wordMatch[1].toLowerCase();
        const param = wordMatch[2] ? Number.parseInt(wordMatch[2], 10) : null;
        i += wordMatch[0].length;

        if (skipDestinations.has(word)) {
          skipCurrent = true;
        } else if (!skipCurrent) {
          if (word === 'par' || word === 'line' || word === 'row') {
            out += '\n\n';
          } else if (word === 'tab' || word === 'cell') {
            out += '  ';
          } else if (word === 'u' && param !== null) {
            const cp = param < 0 ? param + 65536 : param;
            out += String.fromCharCode(cp);
            // Skip single fallback character after \uN if present
            if (rtf[i] === '?') i++;
          } else if (word === 'emdash' || word === 'endash') {
            out += ' - ';
          } else if (word === 'bullet') {
            out += '\n- ';
          }
        }
      } else {
        i++;
      }
      continue;
    }

    if (!skipCurrent) {
      out += ch;
    }
    i++;
  }

  return parseMarkdownToBlocks(out);
}

/**
 * Extracts readable paragraphs from a legacy Word 97–2003 (.doc) file.
 * Handles OLE2 WordDocument binary files plus RTF or HTML files saved with a .doc extension.
 */
export function extractBlocksFromLegacyDoc(bytes: Uint8Array): StructuredTextBlock[] {
  const head = decodeLatin1Bytes(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (head.startsWith('{\\rtf')) {
    return parseRtfToBlocks(new TextDecoder('latin1').decode(bytes));
  }
  if (head.startsWith('<') || /<html\b/i.test(head)) {
    return stripHtmlToBlocks(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  }

  const streams = parseOle2Streams(bytes);
  const wordStream =
    streams.get('WordDocument') ??
    Array.from(streams.entries()).find(([k]) => k.toLowerCase() === 'worddocument')?.[1];

  if (wordStream && wordStream.length >= 64) {
    const dv = new DataView(wordStream.buffer, wordStream.byteOffset, wordStream.byteLength);
    // Word FIB: wIdent = 0xA5EC; fcMin at offset 24, fcMac at offset 28
    const wIdent = dv.getUint16(0, true);
    const fcMin = dv.getUint32(24, true);
    const fcMac = dv.getUint32(28, true);

    if (wIdent === 0xa5ec && fcMin >= 64 && fcMac > fcMin && fcMac <= wordStream.length) {
      const textSlice = wordStream.subarray(fcMin, fcMac);
      // Detect whether text slice is predominantly UTF-16LE (many alternating 0x00 high bytes)
      let zeroOdd = 0;
      const probePairs = Math.min(200, Math.floor(textSlice.length / 2));
      for (let i = 0; i < probePairs; i++) {
        if (textSlice[i * 2 + 1] === 0 && textSlice[i * 2] >= 0x20 && textSlice[i * 2] <= 0x7e) {
          zeroOdd++;
        }
      }
      const raw =
        probePairs > 0 && zeroOdd / probePairs > 0.35
          ? decodeUtf16Le(textSlice)
          : decodeLatin1Bytes(textSlice);

      const cleaned = raw
        .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
        .replace(/\r/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      const blocks = parseMarkdownToBlocks(cleaned);
      if (blocks.length > 0) return blocks;
    }
  }

  // Fallback printable run extraction
  const runs = extractPrintableRunsFallback(wordStream ?? bytes);
  return parseMarkdownToBlocks(runs.join('\n\n'));
}

function extractPrintableRunsFallback(bytes: Uint8Array): string[] {
  const runs: string[] = [];
  // Scan ASCII printable chunks >= 5 chars
  let current = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b === 9) {
      current += String.fromCharCode(b);
    } else {
      const trimmed = current.replace(/\s+/g, ' ').trim();
      if (trimmed.length >= 6 && /[a-zA-Z]{2,}/.test(trimmed) && !/^(Root Entry|WordDocument|PowerPoint|Current User|SummaryInformation|Microsoft|Times New Roman|Calibri|Arial)$/.test(trimmed)) {
        runs.push(trimmed);
      }
      current = '';
    }
  }
  const tail = current.replace(/\s+/g, ' ').trim();
  if (tail.length >= 6 && /[a-zA-Z]{2,}/.test(tail)) runs.push(tail);
  return runs.slice(0, 300);
}

/**
 * Parses OpenDocument Text (.odt) content.xml into structured headings, paragraphs, bullets, and tables.
 */
export function parseOdtContentXml(xml: string): {
  blocks: StructuredTextBlock[];
  tables: string[][][];
} {
  const blocks: StructuredTextBlock[] = [];
  const tables: string[][][] = [];

  // Extract tables first and replace with placeholders
  let body = xml;
  const bodyMatch = /<office:text\b[^>]*>([\s\S]*?)<\/office:text>/i.exec(xml);
  if (bodyMatch) body = bodyMatch[1];

  body = body.replace(/<table:table\b[^>]*>([\s\S]*?)<\/table:table>/gi, (_, tblInner: string) => {
    const rows: string[][] = [];
    const rowRe = /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(tblInner)) !== null) {
      const cells: string[] = [];
      const cellRe = /<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const text = decodeXmlEntities(cm[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        cells.push(text);
      }
      if (cells.some((c) => c.length > 0)) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
    return '';
  });

  const elemRe = /<(text:h|text:p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = elemRe.exec(body)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const inner = decodeXmlEntities(
      m[3]
        .replace(/<text:tab\s*\/>/gi, '  ')
        .replace(/<text:line-break\s*\/>/gi, ' ')
        .replace(/<[^>]+>/g, ''),
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!inner) continue;

    if (tag === 'text:h') {
      const lvlMatch = /text:outline-level="(\d+)"/.exec(attrs);
      const lvl = lvlMatch ? Number.parseInt(lvlMatch[1], 10) : 1;
      blocks.push({ type: lvl <= 1 ? 'heading' : 'subheading', text: inner });
    } else {
      blocks.push({ type: 'paragraph', text: inner });
    }
  }

  return { blocks, tables };
}

/**
 * Parses OpenDocument Presentation (.odp) content.xml into slides compatible with the PPTX PDF renderer.
 */
export function parseOdpContentXml(xml: string): ParsedPptxSlide[] {
  const slides: ParsedPptxSlide[] = [];
  const pageRe = /<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/gi;
  let pm: RegExpExecArray | null;

  while ((pm = pageRe.exec(xml)) !== null) {
    const pageXml = pm[1];
    const shapes: PptxTextShape[] = [];
    const tables: string[][][] = [];
    const images: PptxImagePlacement[] = [];

    // Extract frames with text boxes or images
    const frameRe = /<draw:frame\b([^>]*)>([\s\S]*?)<\/draw:frame>/gi;
    let fm: RegExpExecArray | null;
    while ((fm = frameRe.exec(pageXml)) !== null) {
      const fAttrs = fm[1] ?? '';
      const fBody = fm[2] ?? '';
      const isTitle = /presentation:class="(?:title|subtitle)"/i.test(fAttrs);

      const imgMatch = /<draw:image\b[^>]*xlink:href="([^"]+)"/i.exec(fBody);
      if (imgMatch) {
        images.push({
          relId: imgMatch[1],
          xFrac: 0.55,
          yFrac: 0.24,
          wFrac: 0.38,
          hFrac: 0.52,
          hasPosition: false,
        });
      }

      const paragraphs: PptxTextShape['paragraphs'] = [];
      const pRe = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/gi;
      let tpm: RegExpExecArray | null;
      while ((tpm = pRe.exec(fBody)) !== null) {
        const txt = decodeXmlEntities(tpm[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (txt) {
          paragraphs.push({
            text: txt,
            fontSizePt: isTitle ? 24 : 14,
            isBold: isTitle,
            isBullet: !isTitle && /<text:list-item\b/i.test(fBody),
          });
        }
      }
      if (paragraphs.length > 0) {
        shapes.push({
          xFrac: 0.06,
          yFrac: isTitle ? 0.08 : 0.26,
          wFrac: 0.88,
          hFrac: isTitle ? 0.16 : 0.62,
          hasPosition: false,
          isTitle,
          paragraphs,
        });
      }
    }

    // Extract slide tables
    const tblRe = /<table:table\b[^>]*>([\s\S]*?)<\/table:table>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tblRe.exec(pageXml)) !== null) {
      const rows: string[][] = [];
      const rowRe = /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/gi;
      let rm: RegExpExecArray | null;
      while ((rm = rowRe.exec(tm[1])) !== null) {
        const cells: string[] = [];
        const cellRe = /<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/gi;
        let cm: RegExpExecArray | null;
        while ((cm = cellRe.exec(rm[1])) !== null) {
          cells.push(decodeXmlEntities(cm[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
        }
        if (cells.some((c) => c.length > 0)) rows.push(cells);
      }
      if (rows.length > 0) tables.push(rows);
    }

    slides.push({
      slideNumber: slides.length + 1,
      widthPt: 720,
      heightPt: 540,
      shapes,
      tables,
      images,
    });
  }

  return slides;
}

/**
 * Enhanced Word (.docx / .docm / .dotx) XML parser preserving headings, bullets, paragraphs, and tables.
 */
export function parseEnhancedDocxXml(xml: string): {
  blocks: StructuredTextBlock[];
  tables: string[][][];
} {
  const blocks: StructuredTextBlock[] = [];
  const tables: string[][][] = [];

  // Pull tables cleanly and avoid duplicating their paragraph text in main flow
  const withoutTables = xml.replace(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/gi, (_, tblXml: string) => {
    const rows: string[][] = [];
    const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi;
    let trm: RegExpExecArray | null;
    while ((trm = trRe.exec(tblXml)) !== null) {
      const cells: string[] = [];
      const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi;
      let tcm: RegExpExecArray | null;
      while ((tcm = tcRe.exec(trm[1])) !== null) {
        const parts: string[] = [];
        const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
        let tm: RegExpExecArray | null;
        while ((tm = tRe.exec(tcm[1])) !== null) {
          parts.push(decodeXmlEntities(tm[1]));
        }
        cells.push(parts.join('').replace(/\s+/g, ' ').trim());
      }
      if (cells.some((c) => c.length > 0)) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
    return '';
  });

  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(withoutTables)) !== null) {
    const pXml = pm[1];
    const parts: string[] = [];
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(pXml)) !== null) {
      parts.push(decodeXmlEntities(tm[1]));
    }
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/i.exec(pXml);
    const styleVal = (styleMatch?.[1] ?? '').toLowerCase();
    const isBullet = /<w:numPr\b/i.test(pXml);

    if (styleVal === 'title' || styleVal === 'heading1' || styleVal === 'heading 1') {
      blocks.push({ type: 'heading', text });
    } else if (/^heading\s*[2-6]$/.test(styleVal) || styleVal === 'subtitle') {
      blocks.push({ type: 'subheading', text });
    } else if (isBullet) {
      blocks.push({ type: 'bullet', text });
    } else {
      blocks.push({ type: 'paragraph', text });
    }
  }

  return { blocks, tables };
}
