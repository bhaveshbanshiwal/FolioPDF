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
import type {
  RichParsedSlide,
  SlideElement,
  SlideGeometry,
  SlideImageElement,
  SlideImageSource,
  SlideParagraph,
  SlideShapeElement,
  SlideTableCell,
  SlideTableElement,
} from './presentationTypes';
import {
  collectText,
  findChild,
  findChildren,
  findDescendant,
  getAttr,
  parseXml,
  type XmlNode,
} from './xmlMiniDom';

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

function byteToHex(b: number): string {
  return Math.max(0, Math.min(255, b & 0xff))
    .toString(16)
    .padStart(2, '0');
}

function rgbBytesToHex(r: number, g: number, b: number): string {
  return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
}

/** Wraps a raw Windows DIB (BITMAPINFOHEADER + pixels) in a 14-byte BM file header. */
function wrapDibAsBmp(dib: Uint8Array): Uint8Array {
  if (dib.length < 40) return dib;
  const dv = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const headerSize = dv.getUint32(0, true);
  const bpp = dv.getUint16(14, true);
  const clrUsed = dv.getUint32(32, true);
  const paletteEntries = clrUsed > 0 ? clrUsed : bpp <= 8 ? 1 << bpp : 0;
  const pixelOffset = 14 + headerSize + paletteEntries * 4;
  const bmp = new Uint8Array(14 + dib.length);
  const bdv = new DataView(bmp.buffer);
  bmp[0] = 0x42; // 'B'
  bmp[1] = 0x4d; // 'M'
  bdv.setUint32(2, bmp.length, true);
  bdv.setUint32(10, Math.min(bmp.length, pixelOffset), true);
  bmp.set(dib, 14);
  return bmp;
}

/** Extracts a single PNG, JPEG, or DIB->BMP image from an OfficeArt Blip record body. */
function decodeOfficeArtBlip(
  recType: number,
  body: Uint8Array,
): { bytes: Uint8Array; mime: string } | null {
  if (body.length < 20) return null;

  // JPEG Blip (0xF01D / 0xF02A)
  if (recType === 0xf01d || recType === 0xf02a) {
    const maxScan = Math.min(body.length - 3, 64);
    for (let off = 16; off <= maxScan; off++) {
      if (body[off] === 0xff && body[off + 1] === 0xd8 && body[off + 2] === 0xff) {
        return { bytes: body.slice(off), mime: 'image/jpeg' };
      }
    }
    return null;
  }

  // PNG Blip (0xF01E / 0xF029)
  if (recType === 0xf01e || recType === 0xf029) {
    const maxScan = Math.min(body.length - 8, 64);
    for (let off = 16; off <= maxScan; off++) {
      if (
        body[off] === 0x89 &&
        body[off + 1] === 0x50 &&
        body[off + 2] === 0x4e &&
        body[off + 3] === 0x47
      ) {
        return { bytes: body.slice(off), mime: 'image/png' };
      }
    }
    return null;
  }

  // DIB Blip (0xF01F) -> wrap as standard BMP
  if (recType === 0xf01f) {
    for (const off of [17, 33]) {
      if (off + 40 <= body.length) {
        const dv = new DataView(body.buffer, body.byteOffset + off, body.length - off);
        const biSize = dv.getUint32(0, true);
        if (biSize === 40 || biSize === 12 || biSize === 108 || biSize === 124) {
          return { bytes: wrapDibAsBmp(body.subarray(off)), mime: 'image/bmp' };
        }
      }
    }
    return null;
  }

  return null;
}

/**
 * Extracts indexed OfficeArt picture blips from a legacy .ppt OLE2 archive.
 * Uses OfficeArtBStoreContainer (0xF001 -> FBSE 0xF007 foDelay) when present so 1-based `pib`
 * references match PowerPoint's exact blip table, falling back to sequential Pictures stream order.
 */
function extractLegacyPptBlips(
  pptStream: Uint8Array | undefined,
  picturesStream: Uint8Array | undefined,
): Array<{ bytes: Uint8Array; mime: string } | null> {
  const byOffset = new Map<number, { bytes: Uint8Array; mime: string } | null>();
  const sequential: Array<{ bytes: Uint8Array; mime: string } | null> = [];

  if (picturesStream && picturesStream.length >= 8) {
    const pv = new DataView(
      picturesStream.buffer,
      picturesStream.byteOffset,
      picturesStream.byteLength,
    );
    let pos = 0;
    while (pos + 8 <= picturesStream.length) {
      const recType = pv.getUint16(pos + 2, true);
      const recLen = pv.getUint32(pos + 4, true);
      const bodyStart = pos + 8;
      const bodyEnd = bodyStart + recLen;
      if (recType < 0xf000 || bodyEnd > picturesStream.length || recLen > picturesStream.length) {
        break;
      }
      const decoded = decodeOfficeArtBlip(recType, picturesStream.subarray(bodyStart, bodyEnd));
      byOffset.set(pos, decoded);
      sequential.push(decoded);
      pos = bodyEnd;
    }
  }

  // Read OfficeArtBStoreContainer (0xF001) inside PowerPoint Document for exact 1-based pib order
  const bStoreList: Array<{ bytes: Uint8Array; mime: string } | null> = [];
  if (pptStream && pptStream.length >= 16) {
    const view = new DataView(pptStream.buffer, pptStream.byteOffset, pptStream.byteLength);
    const findBStore = (start: number, end: number, depth: number) => {
      if (depth > 8 || bStoreList.length > 0) return;
      let pos = start;
      while (pos + 8 <= end) {
        const verInst = view.getUint16(pos, true);
        const recVer = verInst & 0x0f;
        const recType = view.getUint16(pos + 2, true);
        const recLen = view.getUint32(pos + 4, true);
        const bodyStart = pos + 8;
        const bodyEnd = bodyStart + recLen;
        if (bodyEnd > end || recLen > pptStream.length) break;

        if (recType === 0xf001) {
          let fPos = bodyStart;
          while (fPos + 8 <= bodyEnd) {
            const fType = view.getUint16(fPos + 2, true);
            const fLen = view.getUint32(fPos + 4, true);
            const fBody = fPos + 8;
            const fEnd = fBody + fLen;
            if (fEnd > bodyEnd) break;

            if (fType === 0xf007 && fLen >= 36) {
              // OfficeArtFBSE: foDelay at +28 (uint32), cbName at +33 (uint8)
              const foDelay = view.getUint32(fBody + 28, true);
              const cbName = pptStream[fBody + 33];
              let img = byOffset.get(foDelay) ?? null;

              // Some .ppt files embed the Blip directly inside FBSE after the 36-byte header + name
              const inlineStart = fBody + 36 + cbName;
              if (!img && inlineStart + 8 <= fEnd) {
                const iType = view.getUint16(inlineStart + 2, true);
                const iLen = view.getUint32(inlineStart + 4, true);
                if (inlineStart + 8 + iLen <= fEnd) {
                  img = decodeOfficeArtBlip(
                    iType,
                    pptStream.subarray(inlineStart + 8, inlineStart + 8 + iLen),
                  );
                }
              }
              bStoreList.push(img);
            }
            fPos = fEnd;
          }
          return;
        } else if (recVer === 0x0f) {
          findBStore(bodyStart, bodyEnd, depth + 1);
        }
        pos = bodyEnd;
      }
    };
    findBStore(0, pptStream.length, 0);
  }

  return bStoreList.length > 0 ? bStoreList : sequential;
}

function resolvePptColor(raw: number, scheme: string[]): string | undefined {
  const flag = (raw >>> 24) & 0xff;
  if (flag === 0x08) {
    const idx = raw & 0xff;
    return scheme[idx] ?? '#1e293b';
  }
  // Ignore special system/modifier colors (0x10..0xFE) unless standard RGB (0x00 / 0x02 / 0x04)
  if (flag !== 0x00 && flag !== 0x02 && flag !== 0x04) {
    return undefined;
  }
  const r = raw & 0xff;
  const g = (raw >>> 8) & 0xff;
  const b = (raw >>> 16) & 0xff;
  return rgbBytesToHex(r, g, b);
}

function parseColorSchemeAtom(slice: Uint8Array): string[] {
  const colors: string[] = [];
  for (let i = 0; i < 8 && i * 4 + 3 <= slice.length; i++) {
    colors.push(rgbBytesToHex(slice[i * 4], slice[i * 4 + 1], slice[i * 4 + 2]));
  }
  return colors;
}

function mapEscherShapeType(shapeType: number): { geometry: SlideGeometry; cornerRadiusFrac?: number } {
  if (shapeType === 2 || shapeType === 5) return { geometry: 'roundRect', cornerRadiusFrac: 0.14 };
  if (shapeType === 3) return { geometry: 'ellipse' };
  if (shapeType === 20 || (shapeType >= 32 && shapeType <= 40)) return { geometry: 'line' };
  if (shapeType === 6 || shapeType === 7) return { geometry: 'triangle' };
  return { geometry: 'rect' };
}

interface EscherParsedDrawing {
  bgHex?: string;
  bgImage?: SlideImageSource;
  elements: SlideElement[];
}

interface LegacyTextStyle {
  fontSizePt?: number;
  isBold?: boolean;
  isItalic?: boolean;
  colorHex?: string;
  align?: 'left' | 'center' | 'right';
}

/** Parses basic StyleTextPropAtom (0x0FA1) paragraph/character formatting for a legacy PPT textbox. */
function parseStyleTextPropAtom(
  buf: Uint8Array,
  textLen: number,
  scheme: string[],
): LegacyTextStyle {
  const style: LegacyTextStyle = {};
  if (buf.length < 8 || textLen <= 0) return style;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;

  // Walk paragraph runs covering textLen + 1 characters
  let coveredP = 0;
  let safety = 0;
  while (coveredP < textLen + 1 && pos + 10 <= buf.length && safety++ < 64) {
    const count = dv.getUint32(pos, true);
    pos += 4;
    pos += 2; // indentLevel
    const mask = dv.getUint32(pos, true);
    pos += 4;

    if (mask & 0x0000000f) pos += 2; // bulletFlags
    if (mask & 0x00000080) pos += 2; // bulletChar
    if (mask & 0x00000010) pos += 2; // bulletFontRef
    if (mask & 0x00000040) pos += 2; // bulletSize
    if (mask & 0x00000020) pos += 4; // bulletColor
    if (mask & 0x00000800) {
      if (pos + 2 <= buf.length && !style.align) {
        const alignVal = dv.getUint16(pos, true) & 0x03;
        style.align = alignVal === 1 ? 'center' : alignVal === 2 ? 'right' : 'left';
      }
      pos += 2;
    }
    if (mask & 0x00001000) pos += 2; // lineSpacing
    if (mask & 0x00002000) pos += 2; // spaceBefore
    if (mask & 0x00004000) pos += 2; // spaceAfter
    if (mask & 0x00000100) pos += 2; // leftMargin
    if (mask & 0x00000400) pos += 2; // indent
    if (mask & 0x00008000) pos += 2; // defaultTabSize
    if (mask & 0x00100000 && pos + 2 <= buf.length) {
      const tabCount = dv.getUint16(pos, true);
      pos += 2 + tabCount * 4;
    }
    if (mask & 0x00010000) pos += 2; // fontAlign
    if (mask & 0x000e0000) pos += 2; // wrapFlags
    if (mask & 0x00200000) pos += 2; // textDirection

    coveredP += Math.max(1, count);
  }

  // First character run properties
  if (pos + 8 <= buf.length) {
    pos += 4; // char count
    const cfMask = dv.getUint32(pos, true);
    pos += 4;
    if (cfMask & 0x0000ffff) {
      if (pos + 2 <= buf.length) {
        const flags = dv.getUint16(pos, true);
        if (cfMask & 0x0001) style.isBold = (flags & 0x0001) !== 0;
        if (cfMask & 0x0002) style.isItalic = (flags & 0x0002) !== 0;
      }
      pos += 2;
    }
    if (cfMask & 0x00010000) pos += 2; // typeface
    if (cfMask & 0x00200000) pos += 2; // oldEATypeface
    if (cfMask & 0x00400000) pos += 2; // ansiTypeface
    if (cfMask & 0x00800000) pos += 2; // symbolTypeface
    if (cfMask & 0x00020000) {
      if (pos + 2 <= buf.length) {
        const sz = dv.getUint16(pos, true);
        if (sz >= 6 && sz <= 96) style.fontSizePt = sz;
      }
      pos += 2;
    }
    if (cfMask & 0x00040000) {
      if (pos + 4 <= buf.length) {
        const rawClr = dv.getUint32(pos, true);
        style.colorHex = resolvePptColor(rawClr, scheme);
      }
      pos += 4;
    }
  }

  return style;
}

interface EscherRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function parseEscherDrawing(
  pptStream: Uint8Array,
  start: number,
  end: number,
  slideMasterW: number,
  slideMasterH: number,
  blips: Array<{ bytes: Uint8Array; mime: string } | null>,
  scheme: string[],
  isMaster: boolean,
): EscherParsedDrawing {
  const view = new DataView(pptStream.buffer, pptStream.byteOffset, pptStream.byteLength);
  let bgHex: string | undefined;
  let bgImage: SlideImageSource | undefined;
  const elements: SlideElement[] = [];

  interface GroupMap {
    outer: EscherRect;
    inner: EscherRect;
  }

  const mapRect = (r: EscherRect, groups: GroupMap[]): EscherRect => {
    let { left, top, right, bottom } = r;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      const inW = g.inner.right - g.inner.left;
      const inH = g.inner.bottom - g.inner.top;
      const outW = g.outer.right - g.outer.left;
      const outH = g.outer.bottom - g.outer.top;
      if (inW > 0 && inH > 0 && outW > 0 && outH > 0) {
        const sx = outW / inW;
        const sy = outH / inH;
        left = g.outer.left + (left - g.inner.left) * sx;
        right = g.outer.left + (right - g.inner.left) * sx;
        top = g.outer.top + (top - g.inner.top) * sy;
        bottom = g.outer.top + (bottom - g.inner.top) * sy;
      }
    }
    return { left, top, right, bottom };
  };

  const parseAnchor = (recType: number, bodyStart: number, recLen: number): EscherRect | undefined => {
    if (recType === 0xf010) {
      // MS-PPT ClientAnchor: SmallRectStruct (8 bytes: top, left, right, bottom) or RectStruct (16 bytes)
      if (recLen === 8) {
        const top = view.getInt16(bodyStart, true);
        const left = view.getInt16(bodyStart + 2, true);
        const right = view.getInt16(bodyStart + 4, true);
        const bottom = view.getInt16(bodyStart + 6, true);
        return { left, top, right, bottom };
      }
      if (recLen >= 16) {
        const top = view.getInt32(bodyStart, true);
        const left = view.getInt32(bodyStart + 4, true);
        const right = view.getInt32(bodyStart + 8, true);
        const bottom = view.getInt32(bodyStart + 12, true);
        return { left, top, right, bottom };
      }
    } else if (recType === 0xf00f && recLen >= 16) {
      // OfficeArtChildAnchor: int32 left, top, right, bottom
      const left = view.getInt32(bodyStart, true);
      const top = view.getInt32(bodyStart + 4, true);
      const right = view.getInt32(bodyStart + 8, true);
      const bottom = view.getInt32(bodyStart + 12, true);
      return { left, top, right, bottom };
    }
    return undefined;
  };

  const parseSpContainer = (sStart: number, sEnd: number, groups: GroupMap[]) => {
    let shapeType = 1;
    let spFlags = 0;
    let anchor: EscherRect | undefined;
    let isGroupHeader = false;
    let groupInnerRect: EscherRect | undefined;
    let isPlaceholder = false;

    let pib: number | undefined;
    let fillType = 0;
    let fillColorRaw: number | undefined;
    let fillBackColorRaw: number | undefined;
    let fillOpacity = 1;
    let fillBlip: number | undefined;
    let hasFilledFlag: boolean | undefined;
    let lineColorRaw: number | undefined;
    let lineWidthPt: number | undefined;
    let hasLineFlag: boolean | undefined;

    let textType = 4;
    const textChunks: string[] = [];
    let styleAtomBuf: Uint8Array | undefined;

    let pos = sStart;
    while (pos + 8 <= sEnd) {
      const verInst = view.getUint16(pos, true);
      const recType = view.getUint16(pos + 2, true);
      const recLen = view.getUint32(pos + 4, true);
      const bStart = pos + 8;
      const bEnd = bStart + recLen;
      if (bEnd > sEnd) break;

      if (recType === 0xf009 && recLen >= 16) {
        // OfficeArtFSPGR (group coordinate space)
        isGroupHeader = true;
        groupInnerRect = {
          left: view.getInt32(bStart, true),
          top: view.getInt32(bStart + 4, true),
          right: view.getInt32(bStart + 8, true),
          bottom: view.getInt32(bStart + 12, true),
        };
      } else if (recType === 0xf00a && recLen >= 8) {
        shapeType = verInst >>> 4;
        spFlags = view.getUint32(bStart + 4, true);
      } else if (recType === 0xf00b || recType === 0xf122) {
        const propCount = verInst >>> 4;
        for (let p = 0; p < propCount && bStart + (p + 1) * 6 <= bEnd; p++) {
          const propIdFull = view.getUint16(bStart + p * 6, true);
          const propId = propIdFull & 0x3fff;
          const propVal = view.getUint32(bStart + p * 6 + 2, true);

          if (propId === 0x0104) pib = propVal;
          else if (propId === 0x0180) fillType = propVal;
          else if (propId === 0x0181) fillColorRaw = propVal;
          else if (propId === 0x0182) fillOpacity = Math.max(0.05, Math.min(1, propVal / 65536));
          else if (propId === 0x0183) fillBackColorRaw = propVal;
          else if (propId === 0x0186) fillBlip = propVal;
          else if (propId === 0x01bf) {
            if (propVal & 0x00100000) hasFilledFlag = (propVal & 0x00000010) !== 0;
          } else if (propId === 0x01c0) lineColorRaw = propVal;
          else if (propId === 0x01cb) lineWidthPt = Math.max(0.5, propVal / 12700);
          else if (propId === 0x01ff) {
            if (propVal & 0x00080000) hasLineFlag = (propVal & 0x00000008) !== 0;
          }
        }
      } else if (recType === 0xf010 || recType === 0xf00f) {
        anchor = parseAnchor(recType, bStart, recLen);
      } else if (recType === 0xf011) {
        // OfficeArtClientData — check for OEPlaceHolderAtom (0x0BC3)
        let cPos = bStart;
        while (cPos + 8 <= bEnd) {
          const cType = view.getUint16(cPos + 2, true);
          const cLen = view.getUint32(cPos + 4, true);
          if (cType === 0x0bc3) isPlaceholder = true;
          cPos += 8 + cLen;
        }
      } else if (recType === 0xf00d) {
        // OfficeArtClientTextbox
        let tPos = bStart;
        while (tPos + 8 <= bEnd) {
          const tType = view.getUint16(tPos + 2, true);
          const tLen = view.getUint32(tPos + 4, true);
          const tBody = tPos + 8;
          const tEnd = tBody + tLen;
          if (tEnd > bEnd) break;

          if (tType === 0x0f9f && tLen >= 4) {
            textType = view.getUint32(tBody, true);
          } else if (tType === 0x0fa0 && tLen > 0) {
            textChunks.push(decodeUtf16Le(pptStream.subarray(tBody, tEnd)));
          } else if (tType === 0x0fa8 && tLen > 0) {
            textChunks.push(decodeLatin1Bytes(pptStream.subarray(tBody, tEnd)));
          } else if (tType === 0x0fa1 && tLen >= 8 && !styleAtomBuf) {
            styleAtomBuf = pptStream.subarray(tBody, tEnd);
          }
          tPos = tEnd;
        }
      }

      pos = bEnd;
    }

    // Group header container defines coordinate frame for its sibling shapes
    if (isGroupHeader && groupInnerRect && anchor) {
      return { groupMap: { outer: anchor, inner: groupInnerRect } };
    }

    const isBackground = (spFlags & 0x0400) !== 0;
    const isDeleted = (spFlags & 0x0008) !== 0;
    if (isDeleted) return {};

    // Background shape on slide or master
    if (isBackground) {
      if (fillBlip && fillBlip >= 1 && blips[fillBlip - 1]) {
        const b = blips[fillBlip - 1]!;
        bgImage = { kind: 'bytes', bytes: b.bytes, mime: b.mime };
      }
      if (fillColorRaw !== undefined && hasFilledFlag !== false) {
        bgHex = resolvePptColor(fillColorRaw, scheme);
      } else if (scheme[0]) {
        bgHex = scheme[0];
      }
      return {};
    }

    // Skip master placeholder prompt boxes ("Click to edit Master title")
    if (isMaster && isPlaceholder) return {};

    if (!anchor) return {};
    const mapped = mapRect(anchor, groups);
    const boxW = Math.abs(mapped.right - mapped.left);
    const boxH = Math.abs(mapped.bottom - mapped.top);
    const boxLeft = Math.min(mapped.left, mapped.right);
    const boxTop = Math.min(mapped.top, mapped.bottom);

    if (boxW < 2 && boxH < 2) return {};

    const xFrac = Math.max(-0.05, Math.min(0.98, boxLeft / slideMasterW));
    const yFrac = Math.max(-0.05, Math.min(0.98, boxTop / slideMasterH));
    const wFrac = Math.max(0.002, Math.min(1.1, boxW / slideMasterW));
    const hFrac = Math.max(0.002, Math.min(1.1, boxH / slideMasterH));

    // Picture frame (shapeType 75 or valid pib)
    if (pib !== undefined && pib >= 1 && blips[pib - 1]) {
      const blipData = blips[pib - 1]!;
      const borderHex =
        hasLineFlag === true && lineColorRaw !== undefined
          ? resolvePptColor(lineColorRaw, scheme)
          : undefined;
      const imgEl: SlideImageElement = {
        kind: 'image',
        xFrac,
        yFrac,
        wFrac,
        hFrac,
        hasPosition: true,
        source: { kind: 'bytes', bytes: blipData.bytes, mime: blipData.mime },
        geometry: shapeType === 3 ? 'ellipse' : shapeType === 2 ? 'roundRect' : 'rect',
        borderHex,
        borderWidthPt: borderHex ? lineWidthPt ?? 1 : undefined,
        fitMode: 'stretch',
      };
      elements.push(imgEl);
      return {};
    }

    const rawText = textChunks.join('\n');
    const lines = rawText
      .split(/[\r\n\x0b]+/)
      .map((l) => l.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (isMaster && lines.length > 0 && /^click to (edit|add)/i.test(lines[0])) {
      return {};
    }

    const isTitle = textType === 0 || textType === 6;
    const isLine = shapeType === 20 || (shapeType >= 32 && shapeType <= 40);
    const isTextBox = shapeType === 202;

    const effectiveFilled =
      hasFilledFlag !== undefined
        ? hasFilledFlag
        : !isTextBox && !isLine && !isPlaceholder && fillColorRaw !== undefined;

    const effectiveStroked =
      hasLineFlag !== undefined ? hasLineFlag : isLine || (!isTextBox && !isPlaceholder && lineColorRaw !== undefined);

    const fillHex = effectiveFilled
      ? resolvePptColor(fillColorRaw ?? 0x08000004, scheme)
      : undefined;
    const fillBackHex =
      effectiveFilled && fillType >= 4 && fillBackColorRaw !== undefined
        ? resolvePptColor(fillBackColorRaw, scheme)
        : undefined;
    const fillImage =
      effectiveFilled && fillBlip && fillBlip >= 1 && blips[fillBlip - 1]
        ? ({
            kind: 'bytes',
            bytes: blips[fillBlip - 1]!.bytes,
            mime: blips[fillBlip - 1]!.mime,
          } satisfies SlideImageSource)
        : undefined;
    const borderHex = effectiveStroked
      ? resolvePptColor(lineColorRaw ?? 0x08000001, scheme) ?? '#334155'
      : undefined;

    if (!fillHex && !fillImage && !borderHex && lines.length === 0) {
      return {};
    }

    const parsedStyle = styleAtomBuf
      ? parseStyleTextPropAtom(styleAtomBuf, rawText.length, scheme)
      : {};
    const isTopBanner =
      !isTitle && yFrac < 0.22 && hFrac > 0.06 && hFrac < 0.26 && wFrac > 0.5 && lines.length === 1;
    const defaultTextColor =
      parsedStyle.colorHex ??
      (fillHex || fillImage ? undefined : isTitle ? scheme[3] : scheme[1]);
    const defaultFontSize = parsedStyle.fontSizePt ?? (isTitle || isTopBanner ? 24 : 15);

    const paragraphs: SlideParagraph[] = lines.map((line) => ({
      text: line,
      fontSizePt: defaultFontSize,
      isBold: parsedStyle.isBold ?? (isTitle || isTopBanner),
      isItalic: parsedStyle.isItalic ?? false,
      colorHex: defaultTextColor,
      align: parsedStyle.align ?? (textType === 6 || textType === 5 ? 'center' : 'left'),
      isBullet: !isTitle && !isTopBanner && textType === 1 && lines.length > 1,
    }));

    const { geometry, cornerRadiusFrac } = mapEscherShapeType(shapeType);
    const shapeEl: SlideShapeElement = {
      kind: 'shape',
      xFrac,
      yFrac,
      wFrac,
      hFrac,
      hasPosition: true,
      geometry,
      cornerRadiusFrac,
      fillHex,
      fillOpacity,
      gradient: fillHex && fillBackHex ? { fromHex: fillHex, toHex: fillBackHex, angleDeg: 90 } : undefined,
      fillImage,
      borderHex,
      borderWidthPt: borderHex ? lineWidthPt ?? 1 : undefined,
      flipH: (spFlags & 0x0040) !== 0,
      flipV: (spFlags & 0x0080) !== 0,
      isTitle: isTitle || isTopBanner,
      verticalAlign: isTitle || isTopBanner ? 'middle' : 'top',
      paddingPt: isTopBanner ? { l: 18, t: 6, r: 18, b: 6 } : undefined,
      paragraphs,
    };
    elements.push(shapeEl);
    return {};
  };

  const walkSpgr = (gStart: number, gEnd: number, groups: GroupMap[], depth: number) => {
    if (depth > 12) return;
    const localGroups = [...groups];
    let pos = gStart;
    let firstSpSeen = false;

    while (pos + 8 <= gEnd) {
      const recType = view.getUint16(pos + 2, true);
      const recLen = view.getUint32(pos + 4, true);
      const bStart = pos + 8;
      const bEnd = bStart + recLen;
      if (bEnd > gEnd) break;

      if (recType === 0xf004) {
        const res = parseSpContainer(bStart, bEnd, localGroups);
        if (!firstSpSeen && res.groupMap) {
          // Only push group transform for nested sub-groups (root spgr has full slide coords)
          if (depth > 0) {
            localGroups.push(res.groupMap);
          }
        }
        firstSpSeen = true;
      } else if (recType === 0xf003) {
        walkSpgr(bStart, bEnd, localGroups, depth + 1);
      }

      pos = bEnd;
    }
  };

  const walkDg = (dStart: number, dEnd: number) => {
    let pos = dStart;
    while (pos + 8 <= dEnd) {
      const verInst = view.getUint16(pos, true);
      const recVer = verInst & 0x0f;
      const recType = view.getUint16(pos + 2, true);
      const recLen = view.getUint32(pos + 4, true);
      const bStart = pos + 8;
      const bEnd = bStart + recLen;
      if (bEnd > dEnd) break;

      if (recType === 0xf003) {
        walkSpgr(bStart, bEnd, [], 0);
      } else if (recType === 0xf004) {
        // Standalone shape directly inside OfficeArtDgContainer (usually the slide background shape!)
        parseSpContainer(bStart, bEnd, []);
      } else if (recVer === 0x0f) {
        walkDg(bStart, bEnd);
      }

      pos = bEnd;
    }
  };

  walkDg(start, end);
  return { bgHex, bgImage, elements };
}

/**
 * Extracts rich, positioned slides from a legacy PowerPoint 97–2003 binary (.ppt) file:
 * - Real slide dimensions from RT_DocumentAtom (0x03E9)
 * - Embedded PNG / JPEG / DIB(BMP) images from OLE2 "Pictures" stream + BStoreContainer (0xF001)
 * - Slide Master background & decorative frames from RT_MainMaster (0x03F8)
 * - Exact positioned frames, fills, borders, pictures (pib), and styled text from Escher OfficeArt (0x040C)
 * - Clean fallback to raw TextCharsAtom/TextBytesAtom when Escher anchors are absent.
 */
export function extractRichSlidesFromLegacyPpt(bytes: Uint8Array): RichParsedSlide[] {
  const streams = parseOle2Streams(bytes);
  const pptStream =
    streams.get('PowerPoint Document') ??
    Array.from(streams.entries()).find(([k]) => k.toLowerCase() === 'powerpoint document')?.[1];
  const picturesStream =
    streams.get('Pictures') ??
    Array.from(streams.entries()).find(([k]) => k.toLowerCase() === 'pictures')?.[1];

  const blips = extractLegacyPptBlips(pptStream, picturesStream);

  let slideMasterW = 5760; // 720 pt (4:3 default)
  let slideMasterH = 4320; // 540 pt
  let masterScheme: string[] = [
    '#ffffff',
    '#0f172a',
    '#cbd5e1',
    '#0f172a',
    '#e2e8f0',
    '#2563eb',
    '#2563eb',
    '#7c3aed',
  ];
  let masterDrawing: EscherParsedDrawing | null = null;
  const richSlides: RichParsedSlide[] = [];

  if (pptStream && pptStream.length >= 8) {
    const view = new DataView(pptStream.buffer, pptStream.byteOffset, pptStream.byteLength);

    // Pass 1: Read RT_DocumentAtom (0x03E9) slide dimensions & RT_MainMaster (0x03F8)
    const scanHeaderAndMaster = (start: number, end: number, depth: number) => {
      if (depth > 8) return;
      let pos = start;
      while (pos + 8 <= end) {
        const verInst = view.getUint16(pos, true);
        const recVer = verInst & 0x0f;
        const recType = view.getUint16(pos + 2, true);
        const recLen = view.getUint32(pos + 4, true);
        const bStart = pos + 8;
        const bEnd = bStart + recLen;
        if (bEnd > end || recLen > pptStream.length) break;

        if (recType === 0x03e9 && recLen >= 8) {
          const sx = view.getInt32(bStart, true);
          const sy = view.getInt32(bStart + 4, true);
          if (sx >= 1440 && sx <= 20000 && sy >= 1440 && sy <= 20000) {
            slideMasterW = sx;
            slideMasterH = sy;
          }
        } else if (recType === 0x03f8 && !masterDrawing) {
          // RT_MainMaster: extract color scheme + background + decorative frames
          let mPos = bStart;
          let drawStart = -1;
          let drawEnd = -1;
          while (mPos + 8 <= bEnd) {
            const mType = view.getUint16(mPos + 2, true);
            const mLen = view.getUint32(mPos + 4, true);
            const mbStart = mPos + 8;
            const mbEnd = mbStart + mLen;
            if (mbEnd > bEnd) break;
            if (mType === 0x07d0 && mLen >= 32) {
              masterScheme = parseColorSchemeAtom(pptStream.subarray(mbStart, mbEnd));
            } else if (mType === 0x040c) {
              drawStart = mbStart;
              drawEnd = mbEnd;
            }
            mPos = mbEnd;
          }
          if (drawStart >= 0 && drawEnd > drawStart) {
            masterDrawing = parseEscherDrawing(
              pptStream,
              drawStart,
              drawEnd,
              slideMasterW,
              slideMasterH,
              blips,
              masterScheme,
              true,
            );
          }
        } else if (recVer === 0x0f && recType !== 0x03ee && recType !== 0x03f0) {
          scanHeaderAndMaster(bStart, bEnd, depth + 1);
        }
        pos = bEnd;
      }
    };

    scanHeaderAndMaster(0, pptStream.length, 0);

    const widthPt = Math.max(240, Math.round((slideMasterW / 8) * 10) / 10);
    const heightPt = Math.max(180, Math.round((slideMasterH / 8) * 10) / 10);

    // Pass 2: Parse every RT_Slide (0x03EE)
    const parseSlideContainer = (sStart: number, sEnd: number) => {
      let slideScheme = masterScheme;
      let drawStart = -1;
      let drawEnd = -1;
      const looseLines: string[] = [];

      const collectLooseText = (aStart: number, aEnd: number, depth: number) => {
        if (depth > 12) return;
        let p = aStart;
        while (p + 8 <= aEnd) {
          const vi = view.getUint16(p, true);
          const rv = vi & 0x0f;
          const rt = view.getUint16(p + 2, true);
          const rl = view.getUint32(p + 4, true);
          const bs = p + 8;
          const be = bs + rl;
          if (be > aEnd) break;
          if (rt === 0x0fa0 && rl > 0) {
            const raw = decodeUtf16Le(pptStream.subarray(bs, be));
            for (const line of raw.split(/[\r\n\x0b]+/)) {
              const t = line.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
              if (t) looseLines.push(t);
            }
          } else if (rt === 0x0fa8 && rl > 0) {
            const raw = decodeLatin1Bytes(pptStream.subarray(bs, be));
            for (const line of raw.split(/[\r\n\x0b]+/)) {
              const t = line.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
              if (t) looseLines.push(t);
            }
          } else if (rv === 0x0f) {
            collectLooseText(bs, be, depth + 1);
          }
          p = be;
        }
      };

      let pos = sStart;
      while (pos + 8 <= sEnd) {
        const recType = view.getUint16(pos + 2, true);
        const recLen = view.getUint32(pos + 4, true);
        const bStart = pos + 8;
        const bEnd = bStart + recLen;
        if (bEnd > sEnd) break;

        if (recType === 0x07d0 && recLen >= 32) {
          slideScheme = parseColorSchemeAtom(pptStream.subarray(bStart, bEnd));
        } else if (recType === 0x040c) {
          drawStart = bStart;
          drawEnd = bEnd;
        }
        pos = bEnd;
      }

      if (drawStart >= 0 && drawEnd > drawStart) {
        const parsed = parseEscherDrawing(
          pptStream,
          drawStart,
          drawEnd,
          slideMasterW,
          slideMasterH,
          blips,
          slideScheme,
          false,
        );
        const elements: SlideElement[] = [
          ...(masterDrawing?.elements ?? []),
          ...parsed.elements,
        ];
        if (elements.length > 0 || parsed.bgHex || parsed.bgImage) {
          richSlides.push({
            slideNumber: richSlides.length + 1,
            widthPt,
            heightPt,
            bgHex: parsed.bgHex ?? masterDrawing?.bgHex,
            bgImage: parsed.bgImage ?? masterDrawing?.bgImage,
            elements,
          });
          return;
        }
      }

      // Fallback for minimal / non-Escher RT_Slide records
      collectLooseText(sStart, sEnd, 0);
      if (looseLines.length > 0) {
        const title = looseLines[0];
        const body = looseLines.slice(1);
        const elements: SlideElement[] = [
          {
            kind: 'shape',
            xFrac: 0.06,
            yFrac: 0.08,
            wFrac: 0.88,
            hFrac: 0.16,
            hasPosition: false,
            geometry: 'rect',
            isTitle: true,
            paragraphs: [{ text: title, fontSizePt: 24, isBold: true }],
          },
        ];
        if (body.length > 0) {
          elements.push({
            kind: 'shape',
            xFrac: 0.06,
            yFrac: 0.26,
            wFrac: 0.88,
            hFrac: 0.64,
            hasPosition: false,
            geometry: 'rect',
            isTitle: false,
            paragraphs: body.map((b) => ({
              text: b,
              fontSizePt: 14,
              isBullet: body.length > 1,
            })),
          });
        }
        richSlides.push({
          slideNumber: richSlides.length + 1,
          widthPt,
          heightPt,
          bgHex: masterDrawing?.bgHex,
          bgImage: masterDrawing?.bgImage,
          elements,
        });
      }
    };

    const walkForSlides = (start: number, end: number, depth: number) => {
      if (depth > 8) return;
      let pos = start;
      while (pos + 8 <= end) {
        const verInst = view.getUint16(pos, true);
        const recVer = verInst & 0x0f;
        const recType = view.getUint16(pos + 2, true);
        const recLen = view.getUint32(pos + 4, true);
        const bStart = pos + 8;
        const bEnd = bStart + recLen;
        if (bEnd > end || recLen > pptStream.length) break;

        if (recType === 0x03ee) {
          parseSlideContainer(bStart, bEnd);
        } else if (recVer === 0x0f && recType !== 0x03f8 && recType !== 0x03f0) {
          walkForSlides(bStart, bEnd, depth + 1);
        }
        pos = bEnd;
      }
    };

    walkForSlides(0, pptStream.length, 0);
  }

  // Fallback if no RT_Slide containers were found at all
  if (richSlides.length === 0) {
    const fallbackLines = extractPrintableRunsFallback(pptStream ?? bytes);
    const elements: SlideElement[] = [];
    if (fallbackLines.length > 0) {
      elements.push({
        kind: 'shape',
        xFrac: 0.06,
        yFrac: 0.08,
        wFrac: 0.88,
        hFrac: 0.16,
        hasPosition: false,
        geometry: 'rect',
        isTitle: true,
        paragraphs: [{ text: fallbackLines[0], fontSizePt: 24, isBold: true }],
      });
      if (fallbackLines.length > 1) {
        elements.push({
          kind: 'shape',
          xFrac: 0.06,
          yFrac: 0.26,
          wFrac: 0.88,
          hFrac: 0.64,
          hasPosition: false,
          geometry: 'rect',
          isTitle: false,
          paragraphs: fallbackLines.slice(1, 40).map((b) => ({
            text: b,
            fontSizePt: 14,
            isBullet: true,
          })),
        });
      }
    }
    // Also include any images discovered in the Pictures stream
    const validBlips = blips.filter((b): b is { bytes: Uint8Array; mime: string } => Boolean(b));
    if (elements.length > 0 || validBlips.length > 0) {
      richSlides.push({
        slideNumber: 1,
        widthPt: 720,
        heightPt: 540,
        elements,
      });
      for (const blip of validBlips) {
        richSlides.push({
          slideNumber: richSlides.length + 1,
          widthPt: 720,
          heightPt: 540,
          elements: [
            {
              kind: 'image',
              xFrac: 0.08,
              yFrac: 0.08,
              wFrac: 0.84,
              hFrac: 0.84,
              hasPosition: true,
              source: { kind: 'bytes', bytes: blip.bytes, mime: blip.mime },
              fitMode: 'contain',
            },
          ],
        });
      }
    }
  }

  return richSlides;
}

/** Backwards-compatible legacy .ppt slide summary helper. */
export function extractSlidesFromLegacyPpt(bytes: Uint8Array): ParsedPptxSlide[] {
  return extractRichSlidesFromLegacyPpt(bytes).map((s) => {
    const shapes: PptxTextShape[] = [];
    const images: PptxImagePlacement[] = [];
    for (const el of s.elements) {
      if (el.kind === 'shape' && el.paragraphs.length > 0) {
        shapes.push({
          xFrac: el.xFrac,
          yFrac: el.yFrac,
          wFrac: el.wFrac,
          hFrac: el.hFrac,
          hasPosition: el.hasPosition,
          isTitle: Boolean(el.isTitle),
          paragraphs: el.paragraphs.map((p) => ({
            text: p.text,
            fontSizePt: p.fontSizePt,
            isBold: p.isBold,
            isBullet: p.isBullet,
            colorHex: p.colorHex,
          })),
        });
      } else if (el.kind === 'image') {
        images.push({
          relId: el.source.kind === 'zip' ? el.source.path : 'embedded-blip',
          xFrac: el.xFrac,
          yFrac: el.yFrac,
          wFrac: el.wFrac,
          hFrac: el.hFrac,
          hasPosition: el.hasPosition,
        });
      }
    }
    return {
      slideNumber: s.slideNumber,
      widthPt: s.widthPt,
      heightPt: s.heightPt,
      bgHex: s.bgHex,
      shapes,
      tables: [],
      images,
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

function parseOdfLengthToPt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|px)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const val = Number.parseFloat(m[1]);
  if (!Number.isFinite(val)) return undefined;
  const unit = (m[2] ?? 'pt').toLowerCase();
  if (unit === 'cm') return val * (72 / 2.54);
  if (unit === 'mm') return val * (72 / 25.4);
  if (unit === 'in') return val * 72;
  if (unit === 'px') return val * 0.75;
  return val;
}

interface OdpStyleInfo {
  fillHex?: string;
  noFill?: boolean;
  strokeHex?: string;
  strokeWidthPt?: number;
  noStroke?: boolean;
  fontSizePt?: number;
  isBold?: boolean;
  isItalic?: boolean;
  colorHex?: string;
  align?: 'left' | 'center' | 'right';
}

function collectOdpStyles(xmlDoc: XmlNode, target: Map<string, OdpStyleInfo>): void {
  const walk = (node: XmlNode) => {
    if (node.localName === 'style') {
      const name = getAttr(node, 'name');
      if (name) {
        const info: OdpStyleInfo = target.get(name) ?? {};
        const gp = findChild(node, 'graphic-properties') ?? findChild(node, 'drawing-page-properties');
        if (gp) {
          const fill = (getAttr(gp, 'fill') ?? '').toLowerCase();
          if (fill === 'none') info.noFill = true;
          const fillColor = getAttr(gp, 'fill-color');
          if (fillColor && /^#[0-9a-f]{6}$/i.test(fillColor)) info.fillHex = fillColor;
          const stroke = (getAttr(gp, 'stroke') ?? '').toLowerCase();
          if (stroke === 'none') info.noStroke = true;
          const strokeColor = getAttr(gp, 'stroke-color');
          if (strokeColor && /^#[0-9a-f]{6}$/i.test(strokeColor)) info.strokeHex = strokeColor;
          const sw = parseOdfLengthToPt(getAttr(gp, 'stroke-width'));
          if (sw !== undefined) info.strokeWidthPt = Math.max(0.5, sw);
        }
        const tp = findChild(node, 'text-properties');
        if (tp) {
          const fs = parseOdfLengthToPt(getAttr(tp, 'font-size'));
          if (fs !== undefined) info.fontSizePt = fs;
          if ((getAttr(tp, 'font-weight') ?? '').toLowerCase() === 'bold') info.isBold = true;
          if ((getAttr(tp, 'font-style') ?? '').toLowerCase() === 'italic') info.isItalic = true;
          const clr = getAttr(tp, 'color');
          if (clr && /^#[0-9a-f]{6}$/i.test(clr)) info.colorHex = clr;
        }
        const pp = findChild(node, 'paragraph-properties');
        if (pp) {
          const ta = (getAttr(pp, 'text-align') ?? '').toLowerCase();
          if (ta === 'center') info.align = 'center';
          else if (ta === 'end' || ta === 'right') info.align = 'right';
          else if (ta === 'start' || ta === 'left') info.align = 'left';
        }
        target.set(name, info);
      }
    }
    for (const c of node.children) walk(c);
  };
  walk(xmlDoc);
}

/**
 * Parses OpenDocument Presentation (.odp) content.xml (+ optional styles.xml) into rich positioned
 * slides preserving exact svg:x/y/width/height frame coordinates, fills, borders, images, and tables.
 */
export function parseRichOdpXml(contentXml: string, stylesXml?: string): RichParsedSlide[] {
  const styles = new Map<string, OdpStyleInfo>();
  let pageW = 793.7; // 28 cm (standard LibreOffice Impress 4:3)
  let pageH = 595.3; // 21 cm

  if (stylesXml) {
    const sDoc = parseXml(stylesXml);
    collectOdpStyles(sDoc, styles);
    const plp = findDescendant(sDoc, 'page-layout-properties');
    const pw = parseOdfLengthToPt(getAttr(plp, 'page-width'));
    const ph = parseOdfLengthToPt(getAttr(plp, 'page-height'));
    if (pw && pw >= 200 && ph && ph >= 150) {
      pageW = Math.round(pw * 10) / 10;
      pageH = Math.round(ph * 10) / 10;
    }
  }

  const cDoc = parseXml(contentXml);
  collectOdpStyles(cDoc, styles);

  const slides: RichParsedSlide[] = [];
  const presNode = findDescendant(cDoc, 'presentation') ?? cDoc;

  for (const pageNode of findChildren(presNode, 'page')) {
    const pageStyleName = getAttr(pageNode, 'style-name');
    const pageStyle = pageStyleName ? styles.get(pageStyleName) : undefined;
    const elements: SlideElement[] = [];

    const walkChildren = (parent: XmlNode) => {
      for (const child of parent.children) {
        const lname = child.localName;
        if (lname === 'g') {
          walkChildren(child);
          continue;
        }
        if (
          lname !== 'frame' &&
          lname !== 'custom-shape' &&
          lname !== 'rect' &&
          lname !== 'ellipse' &&
          lname !== 'circle' &&
          lname !== 'line'
        ) {
          continue;
        }

        const xPt = parseOdfLengthToPt(getAttr(child, 'x') ?? getAttr(child, 'x1'));
        const yPt = parseOdfLengthToPt(getAttr(child, 'y') ?? getAttr(child, 'y1'));
        let wPt = parseOdfLengthToPt(getAttr(child, 'width'));
        let hPt = parseOdfLengthToPt(getAttr(child, 'height'));
        if (lname === 'line') {
          const x2 = parseOdfLengthToPt(getAttr(child, 'x2')) ?? (xPt ?? 0);
          const y2 = parseOdfLengthToPt(getAttr(child, 'y2')) ?? (yPt ?? 0);
          wPt = Math.abs(x2 - (xPt ?? 0));
          hPt = Math.abs(y2 - (yPt ?? 0));
        }

        const hasPosition =
          xPt !== undefined && yPt !== undefined && wPt !== undefined && hPt !== undefined && (wPt > 0 || hPt > 0);
        const xFrac = hasPosition ? Math.max(-0.05, Math.min(0.98, xPt! / pageW)) : 0.06;
        const yFrac = hasPosition ? Math.max(-0.05, Math.min(0.98, yPt! / pageH)) : 0.08;
        const wFrac = hasPosition ? Math.max(0.005, Math.min(1.1, wPt! / pageW)) : 0.88;
        const hFrac = hasPosition ? Math.max(0.005, Math.min(1.1, hPt! / pageH)) : 0.2;

        const styleName = getAttr(child, 'style-name') ?? getAttr(child, 'text-style-name');
        const st = styleName ? styles.get(styleName) : undefined;
        const presClass = (getAttr(child, 'class') ?? '').toLowerCase();
        const isTitle = presClass === 'title' || presClass === 'subtitle';

        // Image inside <draw:frame>
        const imgNode = findChild(child, 'image');
        const href = getAttr(imgNode, 'href');
        if (href) {
          elements.push({
            kind: 'image',
            xFrac,
            yFrac,
            wFrac,
            hFrac,
            hasPosition,
            source: { kind: 'zip', path: href.replace(/^\/+/, '') },
            borderHex: st?.noStroke ? undefined : st?.strokeHex,
            borderWidthPt: st?.strokeWidthPt,
            fitMode: 'stretch',
          });
          continue;
        }

        // Table inside <draw:frame>
        const tblNode = findChild(child, 'table');
        if (tblNode) {
          const rows: SlideTableCell[][] = [];
          for (const tr of findChildren(tblNode, 'table-row')) {
            const cells: SlideTableCell[] = [];
            for (const tc of findChildren(tr, 'table-cell')) {
              const tcStyle = styles.get(getAttr(tc, 'style-name') ?? '');
              const txt = collectText(tc).replace(/\s+/g, ' ').trim();
              cells.push({
                text: txt,
                fillHex: tcStyle?.fillHex,
                textColorHex: tcStyle?.colorHex,
                isBold: tcStyle?.isBold,
                align: tcStyle?.align,
              });
            }
            if (cells.some((c) => c.text.length > 0)) rows.push(cells);
          }
          if (rows.length > 0) {
            const tblEl: SlideTableElement = {
              kind: 'table',
              xFrac,
              yFrac,
              wFrac,
              hFrac,
              hasPosition,
              rows,
            };
            elements.push(tblEl);
          }
          continue;
        }

        // Collect paragraphs from <draw:text-box> or directly inside shape
        const paragraphs: SlideParagraph[] = [];
        const collectParas = (n: XmlNode, inList: boolean) => {
          for (const c of n.children) {
            if (c.localName === 'list' || c.localName === 'list-item') {
              collectParas(c, true);
            } else if (c.localName === 'p' || c.localName === 'h') {
              const pStyle = styles.get(getAttr(c, 'style-name') ?? '');
              const firstSpan = findChild(c, 'span');
              const spanStyle = firstSpan ? styles.get(getAttr(firstSpan, 'style-name') ?? '') : undefined;
              const txt = collectText(c).replace(/\s+/g, ' ').trim();
              if (txt) {
                paragraphs.push({
                  text: txt,
                  fontSizePt: spanStyle?.fontSizePt ?? pStyle?.fontSizePt ?? st?.fontSizePt ?? (isTitle ? 24 : 14),
                  isBold: spanStyle?.isBold ?? pStyle?.isBold ?? st?.isBold ?? isTitle,
                  isItalic: spanStyle?.isItalic ?? pStyle?.isItalic ?? st?.isItalic,
                  colorHex: spanStyle?.colorHex ?? pStyle?.colorHex ?? st?.colorHex,
                  align: pStyle?.align ?? st?.align,
                  isBullet: inList && !isTitle,
                });
              }
            } else if (c.localName === 'text-box') {
              collectParas(c, inList);
            }
          }
        };
        collectParas(child, false);

        const geometry: SlideGeometry =
          lname === 'ellipse' || lname === 'circle'
            ? 'ellipse'
            : lname === 'line'
              ? 'line'
              : 'rect';
        const fillHex = st?.noFill ? undefined : st?.fillHex;
        const borderHex = st?.noStroke ? undefined : st?.strokeHex;

        if (!fillHex && !borderHex && geometry !== 'line' && paragraphs.length === 0) continue;

        elements.push({
          kind: 'shape',
          xFrac,
          yFrac,
          wFrac,
          hFrac,
          hasPosition,
          geometry,
          fillHex,
          borderHex: borderHex ?? (geometry === 'line' ? '#334155' : undefined),
          borderWidthPt: st?.strokeWidthPt ?? (borderHex || geometry === 'line' ? 1 : undefined),
          isTitle,
          paragraphs,
        });
      }
    };

    walkChildren(pageNode);

    slides.push({
      slideNumber: slides.length + 1,
      widthPt: pageW,
      heightPt: pageH,
      bgHex: pageStyle?.noFill ? undefined : pageStyle?.fillHex,
      elements,
    });
  }

  return slides;
}

/** Backwards-compatible ODP slide summary helper. */
export function parseOdpContentXml(xml: string, stylesXml?: string): ParsedPptxSlide[] {
  return parseRichOdpXml(xml, stylesXml).map((s) => ({
    slideNumber: s.slideNumber,
    widthPt: s.widthPt,
    heightPt: s.heightPt,
    bgHex: s.bgHex,
    shapes: s.elements
      .filter((e): e is SlideShapeElement => e.kind === 'shape' && e.paragraphs.length > 0)
      .map((e) => ({
        xFrac: e.xFrac,
        yFrac: e.yFrac,
        wFrac: e.wFrac,
        hFrac: e.hFrac,
        hasPosition: e.hasPosition,
        isTitle: Boolean(e.isTitle),
        paragraphs: e.paragraphs.map((p) => ({
          text: p.text,
          fontSizePt: p.fontSizePt,
          isBold: p.isBold,
          isBullet: p.isBullet,
          colorHex: p.colorHex,
        })),
      })),
    tables: s.elements
      .filter((e): e is SlideTableElement => e.kind === 'table')
      .map((t) => t.rows.map((r) => r.map((c) => c.text))),
    images: s.elements
      .filter((e): e is SlideImageElement => e.kind === 'image')
      .map((img) => ({
        relId: img.source.kind === 'zip' ? img.source.path : 'embedded',
        xFrac: img.xFrac,
        yFrac: img.yFrac,
        wFrac: img.wFrac,
        hFrac: img.hFrac,
        hasPosition: img.hasPosition,
      })),
  }));
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
