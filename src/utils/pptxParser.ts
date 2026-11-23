import type JSZip from 'jszip';
import type {
  RichParsedSlide,
  SlideElement,
  SlideGeometry,
  SlideGradient,
  SlideImageCrop,
  SlideImageElement,
  SlideImageSource,
  SlideParagraph,
  SlideShapeElement,
  SlideTableCell,
  SlideTableElement,
  SlideTextRun,
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

const EMU_PER_PT = 12700;

interface ThemeContext {
  colors: Record<string, string>; // scheme key -> 6-char hex without '#'
  clrMap: Record<string, string>; // e.g. bg1 -> lt1, tx1 -> dk1
}

interface BoxEmu {
  x: number;
  y: number;
  cx: number;
  cy: number;
  rotDeg?: number;
  flipH?: boolean;
  flipV?: boolean;
}

interface GroupTransform {
  offX: number;
  offY: number;
  extX: number;
  extY: number;
  chOffX: number;
  chOffY: number;
  chExtX: number;
  chExtY: number;
}

interface PlaceholderTemplate {
  key: string; // e.g. "type:title" or "idx:1"
  box?: BoxEmu;
  fillHex?: string;
  fillOpacity?: number;
  gradient?: SlideGradient;
  borderHex?: string;
  borderWidthPt?: number;
  defaultFontSizePt?: number;
  defaultColorHex?: string;
  defaultAlign?: 'left' | 'center' | 'right';
  defaultBold?: boolean;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  geometry?: SlideGeometry;
}

interface LayerData {
  bgHex?: string;
  bgGradient?: SlideGradient;
  bgImage?: SlideImageSource;
  decorativeElements: SlideElement[];
  placeholders: Map<string, PlaceholderTemplate>;
  clrMap?: Record<string, string>;
  showMasterSp?: boolean;
  titleStyle?: { fontSizePt?: number; colorHex?: string; isBold?: boolean };
  bodyStyle?: { fontSizePt?: number; colorHex?: string; isBold?: boolean };
}

function parseRelationshipMap(relsXml: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  const doc = parseXml(relsXml);
  for (const rel of findChildren(findChild(doc, 'Relationships') ?? doc, 'Relationship')) {
    const id = getAttr(rel, 'Id');
    const target = getAttr(rel, 'Target');
    const type = getAttr(rel, 'Type') ?? '';
    if (id && target) {
      map.set(id, { target, type });
    }
  }
  return map;
}

function resolveZipPath(baseDir: string, target: string): string {
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

function getDirOf(zipPath: string): string {
  const idx = zipPath.lastIndexOf('/');
  return idx >= 0 ? zipPath.slice(0, idx) : '';
}

function getRelsPathFor(zipPath: string): string {
  const idx = zipPath.lastIndexOf('/');
  if (idx < 0) return `_rels/${zipPath}.rels`;
  return `${zipPath.slice(0, idx)}/_rels/${zipPath.slice(idx + 1)}.rels`;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [clampByte(r), clampByte(g), clampByte(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const c = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(c, 16);
  if (!Number.isFinite(n)) return [15, 23, 42];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, tRaw: number) => {
    let t = tRaw;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/** Resolves any OOXML color node (<a:srgbClr>, <a:schemeClr>, <a:sysClr>, <a:prstClr>) with modifiers. */
function resolveColorNode(
  containerNode: XmlNode | undefined,
  theme: ThemeContext,
): { hex: string; opacity: number } | undefined {
  if (!containerNode) return undefined;

  let colorNode: XmlNode | undefined;
  let baseHex: string | undefined;

  const srgb = findChild(containerNode, 'srgbClr');
  const scheme = findChild(containerNode, 'schemeClr');
  const sys = findChild(containerNode, 'sysClr');
  const prst = findChild(containerNode, 'prstClr');

  if (srgb) {
    colorNode = srgb;
    const val = getAttr(srgb, 'val');
    if (val && /^[0-9A-Fa-f]{6}$/.test(val)) baseHex = val;
  } else if (scheme) {
    colorNode = scheme;
    const rawKey = getAttr(scheme, 'val') ?? '';
    const mappedKey = theme.clrMap[rawKey] ?? rawKey;
    baseHex = theme.colors[mappedKey] ?? theme.colors[rawKey];
  } else if (sys) {
    colorNode = sys;
    const lastClr = getAttr(sys, 'lastClr');
    if (lastClr && /^[0-9A-Fa-f]{6}$/.test(lastClr)) {
      baseHex = lastClr;
    } else {
      const val = (getAttr(sys, 'val') ?? '').toLowerCase();
      baseHex = val.includes('windowtext') ? '0F172A' : val.includes('window') ? 'FFFFFF' : '1E293B';
    }
  } else if (prst) {
    colorNode = prst;
    const presetMap: Record<string, string> = {
      black: '000000',
      white: 'FFFFFF',
      red: 'DC2626',
      blue: '2563EB',
      green: '16A34A',
      yellow: 'EAB308',
      gray: '64748B',
      grey: '64748B',
      silver: 'CBD5E1',
      navy: '1E3A8A',
      orange: 'EA580C',
      purple: '7C3AED',
    };
    baseHex = presetMap[(getAttr(prst, 'val') ?? '').toLowerCase()];
  }

  if (!baseHex || !colorNode) return undefined;

  let [r, g, b] = hexToRgbTuple(baseHex);
  let opacity = 1;

  for (const mod of colorNode.children) {
    const valNum = Number.parseInt(getAttr(mod, 'val') ?? '', 10);
    if (!Number.isFinite(valNum)) continue;
    const frac = valNum / 100000;

    if (mod.localName === 'alpha') {
      opacity = Math.max(0, Math.min(1, frac));
    } else if (mod.localName === 'tint') {
      r = r * frac + 255 * (1 - frac);
      g = g * frac + 255 * (1 - frac);
      b = b * frac + 255 * (1 - frac);
    } else if (mod.localName === 'shade') {
      r *= frac;
      g *= frac;
      b *= frac;
    } else if (mod.localName === 'lumMod' || mod.localName === 'lumOff') {
      const [h, s, l] = rgbToHsl(r, g, b);
      const nextL =
        mod.localName === 'lumMod'
          ? Math.max(0, Math.min(1, l * frac))
          : Math.max(0, Math.min(1, l + frac));
      [r, g, b] = hslToRgb(h, s, nextL);
    }
  }

  return { hex: rgbToHex(r, g, b), opacity };
}

function parseThemeXml(xml: string): ThemeContext {
  const colors: Record<string, string> = {
    dk1: '0F172A',
    lt1: 'FFFFFF',
    dk2: '334155',
    lt2: 'F1F5F9',
    accent1: '2563EB',
    accent2: 'E11D48',
    accent3: '059669',
    accent4: 'D97706',
    accent5: '7C3AED',
    accent6: '0891B2',
    hlink: '2563EB',
    folHlink: '7C3AED',
  };

  const doc = parseXml(xml);
  const clrScheme = findDescendant(doc, 'clrScheme');
  if (clrScheme) {
    for (const entry of clrScheme.children) {
      const srgb = findChild(entry, 'srgbClr');
      const sys = findChild(entry, 'sysClr');
      const val = getAttr(srgb, 'val') ?? getAttr(sys, 'lastClr');
      if (val && /^[0-9A-Fa-f]{6}$/.test(val)) {
        colors[entry.localName] = val;
      }
    }
  }

  return {
    colors,
    clrMap: {
      bg1: 'lt1',
      tx1: 'dk1',
      bg2: 'lt2',
      tx2: 'dk2',
      accent1: 'accent1',
      accent2: 'accent2',
      accent3: 'accent3',
      accent4: 'accent4',
      accent5: 'accent5',
      accent6: 'accent6',
      hlink: 'hlink',
      folHlink: 'folHlink',
    },
  };
}

function parseClrMapAttrs(node: XmlNode | undefined, base: Record<string, string>): Record<string, string> {
  if (!node) return { ...base };
  const next = { ...base };
  for (const key of ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
    const v = getAttr(node, key);
    if (v) next[key] = v;
  }
  return next;
}

function parseGeometry(prst: string | undefined): { geometry: SlideGeometry; cornerRadiusFrac?: number } {
  const p = (prst ?? 'rect').toLowerCase();
  if (p === 'ellipse' || p === 'oval' || p === 'arc' || p === 'pie' || p === 'donut') {
    return { geometry: 'ellipse' };
  }
  if (p.includes('round') || p === 'snip2samerect' || p === 'plaque') {
    return { geometry: 'roundRect', cornerRadiusFrac: 0.14 };
  }
  if (p === 'line' || p.includes('connector')) {
    return { geometry: 'line' };
  }
  if (p === 'triangle' || p === 'rttriangle' || p === 'isoscelestriangle') {
    return { geometry: 'triangle' };
  }
  return { geometry: 'rect' };
}

function parseXfrmNode(xfrm: XmlNode | undefined): BoxEmu | undefined {
  if (!xfrm) return undefined;
  const off = findChild(xfrm, 'off');
  const ext = findChild(xfrm, 'ext');
  if (!off || !ext) return undefined;
  const x = Number.parseInt(getAttr(off, 'x') ?? '', 10);
  const y = Number.parseInt(getAttr(off, 'y') ?? '', 10);
  const cx = Number.parseInt(getAttr(ext, 'cx') ?? '', 10);
  const cy = Number.parseInt(getAttr(ext, 'cy') ?? '', 10);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return undefined;
  }
  const rotRaw = Number.parseInt(getAttr(xfrm, 'rot') ?? '', 10);
  const rotDeg = Number.isFinite(rotRaw) ? rotRaw / 60000 : undefined;
  const flipH = getAttr(xfrm, 'flipH') === '1';
  const flipV = getAttr(xfrm, 'flipV') === '1';
  return { x, y, cx, cy, rotDeg, flipH, flipV };
}

function mapBoxThroughGroups(box: BoxEmu, groups: GroupTransform[]): BoxEmu {
  let { x, y, cx, cy } = box;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.chExtX > 0 && g.chExtY > 0 && g.extX > 0 && g.extY > 0) {
      const sx = g.extX / g.chExtX;
      const sy = g.extY / g.chExtY;
      x = g.offX + (x - g.chOffX) * sx;
      y = g.offY + (y - g.chOffY) * sy;
      cx = cx * sx;
      cy = cy * sy;
    }
  }
  return { ...box, x, y, cx, cy };
}

function parseSrcRect(blipFill: XmlNode | undefined): SlideImageCrop | undefined {
  const srcRect = findChild(blipFill, 'srcRect');
  if (!srcRect) return undefined;
  const l = Math.max(0, Number.parseInt(getAttr(srcRect, 'l') ?? '0', 10) / 100000);
  const t = Math.max(0, Number.parseInt(getAttr(srcRect, 't') ?? '0', 10) / 100000);
  const r = Math.max(0, Number.parseInt(getAttr(srcRect, 'r') ?? '0', 10) / 100000);
  const b = Math.max(0, Number.parseInt(getAttr(srcRect, 'b') ?? '0', 10) / 100000);
  if (l === 0 && t === 0 && r === 0 && b === 0) return undefined;
  if (l + r >= 0.95 || t + b >= 0.95) return undefined;
  return { l, t, r, b };
}

function extractFillAndBorder(
  spPr: XmlNode | undefined,
  styleNode: XmlNode | undefined,
  theme: ThemeContext,
  rels: Map<string, { target: string; type: string }>,
  baseDir: string,
): {
  fillHex?: string;
  fillOpacity?: number;
  gradient?: SlideGradient;
  fillImage?: SlideImageSource;
  fillImageCrop?: SlideImageCrop;
  borderHex?: string;
  borderWidthPt?: number;
  borderOpacity?: number;
  borderDash?: boolean;
  explicitNoFill: boolean;
} {
  let fillHex: string | undefined;
  let fillOpacity: number | undefined;
  let gradient: SlideGradient | undefined;
  let fillImage: SlideImageSource | undefined;
  let fillImageCrop: SlideImageCrop | undefined;
  let explicitNoFill = false;

  if (spPr) {
    if (findChild(spPr, 'noFill')) {
      explicitNoFill = true;
    } else {
      const solidFill = findChild(spPr, 'solidFill');
      if (solidFill) {
        const resolved = resolveColorNode(solidFill, theme);
        if (resolved) {
          fillHex = resolved.hex;
          fillOpacity = resolved.opacity;
        }
      }

      const gradFill = findChild(spPr, 'gradFill');
      if (gradFill && !fillHex) {
        const gsLst = findChild(gradFill, 'gsLst');
        const stops = findChildren(gsLst, 'gs');
        if (stops.length >= 2) {
          const c1 = resolveColorNode(stops[0], theme);
          const c2 = resolveColorNode(stops[stops.length - 1], theme);
          const lin = findChild(gradFill, 'lin');
          const angRaw = Number.parseInt(getAttr(lin, 'ang') ?? '5400000', 10);
          if (c1 && c2) {
            gradient = {
              fromHex: c1.hex,
              toHex: c2.hex,
              angleDeg: Number.isFinite(angRaw) ? angRaw / 60000 : 90,
            };
            fillHex = c1.hex;
            fillOpacity = c1.opacity;
          }
        }
      }

      const blipFill = findChild(spPr, 'blipFill');
      if (blipFill) {
        const blip = findChild(blipFill, 'blip');
        const rId = getAttr(blip, 'embed') ?? getAttr(blip, 'link');
        if (rId) {
          const rel = rels.get(rId);
          if (rel && !rel.target.startsWith('http')) {
            fillImage = { kind: 'zip', path: resolveZipPath(baseDir, rel.target) };
            fillImageCrop = parseSrcRect(blipFill);
          }
        }
      }
    }
  }

  // Fallback to <p:style><a:fillRef idx="1+"> when no explicit fill or noFill was given
  if (!explicitNoFill && !fillHex && !gradient && !fillImage && styleNode) {
    const fillRef = findChild(styleNode, 'fillRef');
    const idx = Number.parseInt(getAttr(fillRef, 'idx') ?? '0', 10);
    if (fillRef && idx > 0) {
      const resolved = resolveColorNode(fillRef, theme);
      if (resolved) {
        fillHex = resolved.hex;
        fillOpacity = resolved.opacity;
      }
    }
  }

  // Border / stroke (<a:ln>)
  let borderHex: string | undefined;
  let borderWidthPt: number | undefined;
  let borderOpacity: number | undefined;
  let borderDash = false;
  const ln = findChild(spPr, 'ln');
  const explicitNoLine = Boolean(findChild(ln, 'noFill'));

  if (ln && !explicitNoLine) {
    const lnSolid = findChild(ln, 'solidFill');
    const resolved = resolveColorNode(lnSolid, theme);
    if (resolved) {
      borderHex = resolved.hex;
      borderOpacity = resolved.opacity;
      const wEmu = Number.parseInt(getAttr(ln, 'w') ?? '12700', 10);
      borderWidthPt = Math.max(0.5, (Number.isFinite(wEmu) ? wEmu : 12700) / EMU_PER_PT);
    }
    const prstDash = findChild(ln, 'prstDash');
    const dashVal = (getAttr(prstDash, 'val') ?? '').toLowerCase();
    if (dashVal && dashVal !== 'solid') borderDash = true;
  } else if (!explicitNoLine && styleNode) {
    const lnRef = findChild(styleNode, 'lnRef');
    const idx = Number.parseInt(getAttr(lnRef, 'idx') ?? '0', 10);
    if (lnRef && idx > 0) {
      const resolved = resolveColorNode(lnRef, theme);
      if (resolved) {
        borderHex = resolved.hex;
        borderOpacity = resolved.opacity;
        borderWidthPt = 1;
      }
    }
  }

  return {
    fillHex,
    fillOpacity,
    gradient,
    fillImage,
    fillImageCrop,
    borderHex,
    borderWidthPt,
    borderOpacity,
    borderDash,
    explicitNoFill,
  };
}

function parseBackground(
  cSld: XmlNode | undefined,
  theme: ThemeContext,
  rels: Map<string, { target: string; type: string }>,
  baseDir: string,
): { bgHex?: string; bgGradient?: SlideGradient; bgImage?: SlideImageSource } {
  const bg = findChild(cSld, 'bg');
  if (!bg) return {};

  const bgPr = findChild(bg, 'bgPr');
  if (bgPr) {
    const solidFill = findChild(bgPr, 'solidFill');
    const solid = resolveColorNode(solidFill, theme);
    if (solid) return { bgHex: solid.hex };

    const gradFill = findChild(bgPr, 'gradFill');
    if (gradFill) {
      const stops = findChildren(findChild(gradFill, 'gsLst'), 'gs');
      if (stops.length >= 2) {
        const c1 = resolveColorNode(stops[0], theme);
        const c2 = resolveColorNode(stops[stops.length - 1], theme);
        const lin = findChild(gradFill, 'lin');
        const angRaw = Number.parseInt(getAttr(lin, 'ang') ?? '5400000', 10);
        if (c1 && c2) {
          return {
            bgHex: c1.hex,
            bgGradient: {
              fromHex: c1.hex,
              toHex: c2.hex,
              angleDeg: Number.isFinite(angRaw) ? angRaw / 60000 : 90,
            },
          };
        }
      }
    }

    const blipFill = findChild(bgPr, 'blipFill');
    if (blipFill) {
      const blip = findChild(blipFill, 'blip');
      const rId = getAttr(blip, 'embed') ?? getAttr(blip, 'link');
      if (rId) {
        const rel = rels.get(rId);
        if (rel && !rel.target.startsWith('http')) {
          return { bgImage: { kind: 'zip', path: resolveZipPath(baseDir, rel.target) } };
        }
      }
    }
  }

  const bgRef = findChild(bg, 'bgRef');
  if (bgRef) {
    const resolved = resolveColorNode(bgRef, theme);
    if (resolved) return { bgHex: resolved.hex };
  }

  return {};
}

function parseAlign(algn: string | undefined): 'left' | 'center' | 'right' | undefined {
  if (algn === 'ctr') return 'center';
  if (algn === 'r') return 'right';
  if (algn === 'l' || algn === 'just') return 'left';
  return undefined;
}

function parseVertAnchor(anchor: string | undefined): 'top' | 'middle' | 'bottom' | undefined {
  if (anchor === 'ctr') return 'middle';
  if (anchor === 'b') return 'bottom';
  if (anchor === 't') return 'top';
  return undefined;
}

function parseTxBodyParagraphs(
  txBody: XmlNode | undefined,
  theme: ThemeContext,
  defaults: {
    isTitle: boolean;
    fontSizePt?: number;
    colorHex?: string;
    isBold?: boolean;
    align?: 'left' | 'center' | 'right';
  },
): {
  paragraphs: SlideParagraph[];
  verticalAlign?: 'top' | 'middle' | 'bottom';
  paddingPt?: { l: number; t: number; r: number; b: number };
} {
  if (!txBody) return { paragraphs: [] };

  const bodyPr = findChild(txBody, 'bodyPr');
  const verticalAlign = parseVertAnchor(getAttr(bodyPr, 'anchor'));
  const toPt = (raw: string | undefined, fallback: number) => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(36, n / EMU_PER_PT)) : fallback;
  };
  const paddingPt = bodyPr
    ? {
        l: toPt(getAttr(bodyPr, 'lIns'), 5),
        t: toPt(getAttr(bodyPr, 'tIns'), 3),
        r: toPt(getAttr(bodyPr, 'rIns'), 5),
        b: toPt(getAttr(bodyPr, 'bIns'), 3),
      }
    : { l: 5, t: 3, r: 5, b: 3 };

  // Extract shape-local list style defaults (<a:lstStyle><a:lvl1pPr><a:defRPr>)
  const lstStyle = findChild(txBody, 'lstStyle');
  const lvl1 = findChild(lstStyle, 'lvl1pPr');
  const lvl1DefRPr = findChild(lvl1, 'defRPr');
  const lstFontSzRaw = Number.parseInt(getAttr(lvl1DefRPr, 'sz') ?? '', 10);
  const lstFontSz = Number.isFinite(lstFontSzRaw) ? lstFontSzRaw / 100 : undefined;
  const lstColor = resolveColorNode(findChild(lvl1DefRPr, 'solidFill'), theme)?.hex;
  const lstAlign = parseAlign(getAttr(lvl1, 'algn'));

  const paragraphs: SlideParagraph[] = [];
  for (const pNode of findChildren(txBody, 'p')) {
    const pPr = findChild(pNode, 'pPr');
    const level = Number.parseInt(getAttr(pPr, 'lvl') ?? '0', 10) || 0;
    const align = parseAlign(getAttr(pPr, 'algn')) ?? lstAlign ?? defaults.align;
    const buNone = Boolean(findChild(pPr, 'buNone'));
    const buCharNode = findChild(pPr, 'buChar');
    const buAutoNum = findChild(pPr, 'buAutoNum');
    const isBullet = !buNone && (Boolean(buCharNode) || Boolean(buAutoNum) || level > 0);
    const bulletChar = getAttr(buCharNode, 'char') ?? (buAutoNum ? '•' : undefined);

    const defRPr = findChild(pPr, 'defRPr');
    const defSzRaw = Number.parseInt(getAttr(defRPr, 'sz') ?? '', 10);
    const pDefSize = Number.isFinite(defSzRaw) ? defSzRaw / 100 : undefined;
    const pDefColor = resolveColorNode(findChild(defRPr, 'solidFill'), theme)?.hex;
    const pDefBold = getAttr(defRPr, 'b') === '1';

    const runs: SlideTextRun[] = [];
    for (const child of pNode.children) {
      if (child.localName === 'r' || child.localName === 'fld') {
        const tNode = findChild(child, 't');
        const txt = collectText(tNode);
        if (!txt) continue;
        const rPr = findChild(child, 'rPr');
        const szRaw = Number.parseInt(getAttr(rPr, 'sz') ?? '', 10);
        const fontSizePt = Number.isFinite(szRaw)
          ? szRaw / 100
          : pDefSize ?? lstFontSz ?? defaults.fontSizePt;
        const bAttr = getAttr(rPr, 'b');
        const isBold =
          bAttr !== undefined
            ? bAttr === '1'
            : pDefBold || defaults.isBold || defaults.isTitle;
        const isItalic = getAttr(rPr, 'i') === '1';
        const isUnderline = Boolean(getAttr(rPr, 'u') && getAttr(rPr, 'u') !== 'none');
        const runColor =
          resolveColorNode(findChild(rPr, 'solidFill'), theme)?.hex ??
          pDefColor ??
          lstColor ??
          defaults.colorHex;

        runs.push({
          text: txt,
          fontSizePt,
          isBold,
          isItalic,
          isUnderline,
          colorHex: runColor,
        });
      } else if (child.localName === 'br') {
        runs.push({ text: '\n' });
      }
    }

    const combined = runs
      .map((r) => r.text)
      .join('')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!combined) continue;

    const firstStyled = runs.find((r) => r.text.trim().length > 0);
    paragraphs.push({
      text: combined,
      runs,
      fontSizePt: firstStyled?.fontSizePt ?? pDefSize ?? lstFontSz ?? defaults.fontSizePt,
      isBold: firstStyled?.isBold ?? defaults.isBold ?? defaults.isTitle,
      isItalic: firstStyled?.isItalic ?? false,
      colorHex: firstStyled?.colorHex ?? pDefColor ?? lstColor ?? defaults.colorHex,
      align,
      isBullet: isBullet && !defaults.isTitle,
      bulletChar,
      level,
    });
  }

  return { paragraphs, verticalAlign, paddingPt };
}

function getPlaceholderKeys(nvNode: XmlNode | undefined): {
  isPlaceholder: boolean;
  isTitle: boolean;
  keys: string[];
} {
  const nvPr = findChild(nvNode, 'nvPr');
  const ph = findChild(nvPr, 'ph');
  if (!ph) return { isPlaceholder: false, isTitle: false, keys: [] };

  const type = (getAttr(ph, 'type') ?? '').toLowerCase();
  const idx = getAttr(ph, 'idx');
  const keys: string[] = [];
  if (type && idx !== undefined) keys.push(`${type}:${idx}`);
  if (idx !== undefined) keys.push(`idx:${idx}`);
  if (type) keys.push(`type:${type}`);
  if (keys.length === 0) keys.push('type:body');

  const isTitle = type === 'title' || type === 'ctrtitle' || type === 'subtitle';
  return { isPlaceholder: true, isTitle, keys };
}

function extractElementsFromSpTree(
  spTree: XmlNode | undefined,
  opts: {
    slideWidthEmu: number;
    slideHeightEmu: number;
    theme: ThemeContext;
    rels: Map<string, { target: string; type: string }>;
    baseDir: string;
    isMasterOrLayout: boolean;
    inheritedPlaceholders?: Map<string, PlaceholderTemplate>;
    titleStyle?: { fontSizePt?: number; colorHex?: string; isBold?: boolean };
    bodyStyle?: { fontSizePt?: number; colorHex?: string; isBold?: boolean };
  },
): { elements: SlideElement[]; placeholders: Map<string, PlaceholderTemplate> } {
  const elements: SlideElement[] = [];
  const placeholders = new Map<string, PlaceholderTemplate>();
  if (!spTree) return { elements, placeholders };

  const { slideWidthEmu, slideHeightEmu, theme, rels, baseDir } = opts;

  const toFracs = (box: BoxEmu | undefined) => {
    if (!box || (box.cx <= 0 && box.cy <= 0)) {
      return { xFrac: 0.06, yFrac: 0.08, wFrac: 0.88, hFrac: 0.2, hasPosition: false };
    }
    return {
      xFrac: Math.max(-0.05, Math.min(0.98, box.x / slideWidthEmu)),
      yFrac: Math.max(-0.05, Math.min(0.98, box.y / slideHeightEmu)),
      wFrac: Math.max(0.002, Math.min(1.1, box.cx / slideWidthEmu)),
      hFrac: Math.max(0.002, Math.min(1.1, box.cy / slideHeightEmu)),
      hasPosition: true,
    };
  };

  const walkTree = (container: XmlNode, groups: GroupTransform[]) => {
    for (const child of container.children) {
      const name = child.localName;

      // 1. Grouped shapes (<p:grpSp>) — compose transform & recurse in exact z-order
      if (name === 'grpSp') {
        const grpSpPr = findChild(child, 'grpSpPr');
        const xfrm = findChild(grpSpPr, 'xfrm');
        const off = findChild(xfrm, 'off');
        const ext = findChild(xfrm, 'ext');
        const chOff = findChild(xfrm, 'chOff');
        const chExt = findChild(xfrm, 'chExt');
        const nextGroups = [...groups];
        if (off && ext && chOff && chExt) {
          nextGroups.push({
            offX: Number.parseInt(getAttr(off, 'x') ?? '0', 10) || 0,
            offY: Number.parseInt(getAttr(off, 'y') ?? '0', 10) || 0,
            extX: Number.parseInt(getAttr(ext, 'cx') ?? '0', 10) || 0,
            extY: Number.parseInt(getAttr(ext, 'cy') ?? '0', 10) || 0,
            chOffX: Number.parseInt(getAttr(chOff, 'x') ?? '0', 10) || 0,
            chOffY: Number.parseInt(getAttr(chOff, 'y') ?? '0', 10) || 0,
            chExtX: Number.parseInt(getAttr(chExt, 'cx') ?? '0', 10) || 0,
            chExtY: Number.parseInt(getAttr(chExt, 'cy') ?? '0', 10) || 0,
          });
        }
        walkTree(child, nextGroups);
        continue;
      }

      // 2. Picture (<p:pic>)
      if (name === 'pic') {
        const nvPicPr = findChild(child, 'nvPicPr');
        const phInfo = getPlaceholderKeys(nvPicPr);
        const blipFill = findChild(child, 'blipFill');
        const blip = findChild(blipFill, 'blip');
        const rId = getAttr(blip, 'embed') ?? getAttr(blip, 'link');
        const spPr = findChild(child, 'spPr');
        const rawBox = parseXfrmNode(findChild(spPr, 'xfrm'));
        const mappedBox = rawBox ? mapBoxThroughGroups(rawBox, groups) : undefined;

        if (opts.isMasterOrLayout && phInfo.isPlaceholder) {
          if (mappedBox) {
            for (const key of phInfo.keys) {
              placeholders.set(key, { key, box: mappedBox });
            }
          }
          continue;
        }

        if (!rId) continue;
        const rel = rels.get(rId);
        if (!rel || rel.target.startsWith('http')) continue;
        const mediaPath = resolveZipPath(baseDir, rel.target);

        let finalBox = mappedBox;
        if (!finalBox && phInfo.isPlaceholder && opts.inheritedPlaceholders) {
          for (const key of phInfo.keys) {
            const tpl = opts.inheritedPlaceholders.get(key);
            if (tpl?.box) {
              finalBox = tpl.box;
              break;
            }
          }
        }

        const fracs = toFracs(finalBox);
        const prstGeom = findChild(spPr, 'prstGeom');
        const { geometry, cornerRadiusFrac } = parseGeometry(getAttr(prstGeom, 'prst'));
        const { borderHex, borderWidthPt } = extractFillAndBorder(spPr, undefined, theme, rels, baseDir);

        const imgEl: SlideImageElement = {
          kind: 'image',
          ...fracs,
          rotationDeg: finalBox?.rotDeg,
          source: { kind: 'zip', path: mediaPath },
          crop: parseSrcRect(blipFill),
          geometry: geometry === 'ellipse' || geometry === 'roundRect' ? geometry : 'rect',
          cornerRadiusFrac,
          borderHex,
          borderWidthPt,
          fitMode: 'stretch',
        };
        elements.push(imgEl);
        continue;
      }

      // 3. Shapes & Text Boxes & Connectors (<p:sp>, <p:cxnSp>)
      if (name === 'sp' || name === 'cxnSp') {
        const nvPrContainer = findChild(child, name === 'sp' ? 'nvSpPr' : 'nvCxnSpPr');
        const phInfo = getPlaceholderKeys(nvPrContainer);
        const spPr = findChild(child, 'spPr');
        const styleNode = findChild(child, 'style');
        const txBody = findChild(child, 'txBody');

        const rawBox = parseXfrmNode(findChild(spPr, 'xfrm'));
        const mappedBox = rawBox ? mapBoxThroughGroups(rawBox, groups) : undefined;
        const prstGeom = findChild(spPr, 'prstGeom');
        const geomParsed =
          name === 'cxnSp'
            ? { geometry: 'line' as SlideGeometry }
            : parseGeometry(getAttr(prstGeom, 'prst'));

        const visual = extractFillAndBorder(spPr, styleNode, theme, rels, baseDir);

        // If we are parsing a slideMaster or slideLayout and this is a placeholder template:
        // record its geometry & styling for slide inheritance, do NOT draw its sample prompt text ("Click to edit Master title")!
        if (opts.isMasterOrLayout && phInfo.isPlaceholder) {
          const lstStyle = findChild(txBody, 'lstStyle');
          const lvl1 = findChild(lstStyle, 'lvl1pPr');
          const defRPr = findChild(lvl1, 'defRPr');
          const szRaw = Number.parseInt(getAttr(defRPr, 'sz') ?? '', 10);
          const tpl: PlaceholderTemplate = {
            key: phInfo.keys[0] ?? 'type:body',
            box: mappedBox,
            fillHex: visual.fillHex,
            fillOpacity: visual.fillOpacity,
            gradient: visual.gradient,
            borderHex: visual.borderHex,
            borderWidthPt: visual.borderWidthPt,
            defaultFontSizePt: Number.isFinite(szRaw) ? szRaw / 100 : undefined,
            defaultColorHex: resolveColorNode(findChild(defRPr, 'solidFill'), theme)?.hex,
            defaultAlign: parseAlign(getAttr(lvl1, 'algn')),
            defaultBold: getAttr(defRPr, 'b') === '1',
            verticalAlign: parseVertAnchor(getAttr(findChild(txBody, 'bodyPr'), 'anchor')),
            geometry: geomParsed.geometry,
          };
          for (const key of phInfo.keys) {
            if (!placeholders.has(key)) placeholders.set(key, tpl);
          }
          continue;
        }

        // Look up inherited placeholder geometry & styles from slideLayout / slideMaster
        let inherited: PlaceholderTemplate | undefined;
        if (phInfo.isPlaceholder && opts.inheritedPlaceholders) {
          for (const key of phInfo.keys) {
            const found = opts.inheritedPlaceholders.get(key);
            if (found) {
              inherited = found;
              break;
            }
          }
        }

        const finalBox = mappedBox ?? inherited?.box;
        const fracs = toFracs(finalBox);

        // Font color fallback from <p:style><a:fontRef>
        const fontRefColor = resolveColorNode(findChild(styleNode, 'fontRef'), theme)?.hex;
        const stylePool = phInfo.isTitle ? opts.titleStyle : opts.bodyStyle;

        const { paragraphs, verticalAlign, paddingPt } = parseTxBodyParagraphs(txBody, theme, {
          isTitle: phInfo.isTitle,
          fontSizePt: inherited?.defaultFontSizePt ?? stylePool?.fontSizePt,
          colorHex: inherited?.defaultColorHex ?? fontRefColor ?? stylePool?.colorHex,
          isBold: inherited?.defaultBold ?? stylePool?.isBold,
          align: inherited?.defaultAlign,
        });

        // Skip master/layout empty footer/date/slide-number placeholders
        if (
          opts.isMasterOrLayout &&
          paragraphs.length > 0 &&
          /^(click to (edit|add)|‹#›)$/i.test(paragraphs[0].text.trim())
        ) {
          continue;
        }

        const effectiveFillHex = visual.explicitNoFill
          ? undefined
          : visual.fillHex ?? inherited?.fillHex;
        const effectiveGradient = visual.explicitNoFill
          ? undefined
          : visual.gradient ?? inherited?.gradient;
        const effectiveBorderHex = visual.borderHex ?? inherited?.borderHex;
        const effectiveBorderWidth = visual.borderWidthPt ?? inherited?.borderWidthPt;

        const hasVisualBody = Boolean(
          effectiveFillHex ||
            effectiveGradient ||
            visual.fillImage ||
            effectiveBorderHex ||
            geomParsed.geometry === 'line',
        );

        if (!hasVisualBody && paragraphs.length === 0) continue;

        const shapeEl: SlideShapeElement = {
          kind: 'shape',
          ...fracs,
          rotationDeg: finalBox?.rotDeg,
          flipH: finalBox?.flipH,
          flipV: finalBox?.flipV,
          geometry: prstGeom ? geomParsed.geometry : inherited?.geometry ?? geomParsed.geometry,
          cornerRadiusFrac: geomParsed.cornerRadiusFrac,
          fillHex: effectiveFillHex,
          fillOpacity: visual.fillOpacity ?? inherited?.fillOpacity ?? 1,
          gradient: effectiveGradient,
          fillImage: visual.fillImage,
          fillImageCrop: visual.fillImageCrop,
          borderHex: effectiveBorderHex,
          borderWidthPt: effectiveBorderWidth,
          borderOpacity: visual.borderOpacity ?? 1,
          borderDash: visual.borderDash,
          isTitle: phInfo.isTitle,
          verticalAlign: verticalAlign ?? inherited?.verticalAlign ?? 'top',
          paddingPt,
          paragraphs,
        };
        elements.push(shapeEl);
        continue;
      }

      // 4. Graphic Frame (<p:graphicFrame>) — Tables (<a:tbl>) at exact positioned bounds!
      if (name === 'graphicFrame') {
        const tbl = findDescendant(child, 'tbl');
        if (!tbl) continue;

        const rawBox = parseXfrmNode(findChild(child, 'xfrm'));
        const mappedBox = rawBox ? mapBoxThroughGroups(rawBox, groups) : undefined;
        const fracs = toFracs(mappedBox);

        const tblGrid = findChild(tbl, 'tblGrid');
        const gridCols = findChildren(tblGrid, 'gridCol');
        const colWs = gridCols.map((gc) => Math.max(1, Number.parseInt(getAttr(gc, 'w') ?? '1', 10) || 1));
        const totalGridW = colWs.reduce((s, w) => s + w, 0);
        const colWidthFracs = totalGridW > 0 ? colWs.map((w) => w / totalGridW) : undefined;

        const rows: SlideTableCell[][] = [];
        for (const tr of findChildren(tbl, 'tr')) {
          const rowCells: SlideTableCell[] = [];
          for (const tc of findChildren(tr, 'tc')) {
            const tcPr = findChild(tc, 'tcPr');
            const fillHex = resolveColorNode(findChild(tcPr, 'solidFill'), theme)?.hex;
            const txBody = findChild(tc, 'txBody');
            const { paragraphs } = parseTxBodyParagraphs(txBody, theme, { isTitle: false });
            const text = paragraphs.map((p) => p.text).join(' ').trim();
            const firstP = paragraphs[0];
            rowCells.push({
              text,
              fillHex,
              textColorHex: firstP?.colorHex,
              isBold: firstP?.isBold,
              fontSizePt: firstP?.fontSizePt,
              align: firstP?.align,
            });
          }
          if (rowCells.length > 0) rows.push(rowCells);
        }

        if (rows.length > 0) {
          const tableEl: SlideTableElement = {
            kind: 'table',
            ...fracs,
            colWidthFracs,
            rows,
          };
          elements.push(tableEl);
        }
      }
    }
  };

  walkTree(spTree, []);
  return { elements, placeholders };
}

function parseMasterTxStyles(
  masterDoc: XmlNode,
  theme: ThemeContext,
): {
  titleStyle?: { fontSizePt?: number; colorHex?: string; isBold?: boolean };
  bodyStyle?: { fontSizePt?: number; colorHex?: string; isBold?: boolean };
} {
  const txStyles = findDescendant(masterDoc, 'txStyles');
  if (!txStyles) return {};

  const readStyle = (styleName: string) => {
    const sNode = findChild(txStyles, styleName);
    const lvl1 = findChild(sNode, 'lvl1pPr');
    const defRPr = findChild(lvl1, 'defRPr');
    if (!defRPr) return undefined;
    const szRaw = Number.parseInt(getAttr(defRPr, 'sz') ?? '', 10);
    return {
      fontSizePt: Number.isFinite(szRaw) ? szRaw / 100 : undefined,
      colorHex: resolveColorNode(findChild(defRPr, 'solidFill'), theme)?.hex,
      isBold: getAttr(defRPr, 'b') === '1',
    };
  };

  return {
    titleStyle: readStyle('titleStyle'),
    bodyStyle: readStyle('bodyStyle'),
  };
}

/**
 * Parses an entire .pptx / .pptm / .ppsx / .potx ZIP archive with full theme colors,
 * Slide Master + Slide Layout inheritance (backgrounds, decorative frames, placeholder
 * bounding boxes), recursive grouped-shape transforms, images, and positioned tables.
 */
export async function parsePptxArchive(zip: JSZip): Promise<RichParsedSlide[]> {
  let slideWidthEmu = 12192000; // 16:9 default (960 pt)
  let slideHeightEmu = 6858000; // 540 pt
  const orderedSlidePaths: string[] = [];

  const presXmlFile = zip.file('ppt/presentation.xml');
  if (presXmlFile) {
    const presXml = await presXmlFile.async('string');
    const presDoc = parseXml(presXml);
    const sldSz = findDescendant(presDoc, 'sldSz');
    if (sldSz) {
      const cx = Number.parseInt(getAttr(sldSz, 'cx') ?? '', 10);
      const cy = Number.parseInt(getAttr(sldSz, 'cy') ?? '', 10);
      if (cx > 1000000 && cy > 1000000) {
        slideWidthEmu = cx;
        slideHeightEmu = cy;
      }
    }

    const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels');
    if (presRelsFile) {
      const relMap = parseRelationshipMap(await presRelsFile.async('string'));
      const sldIdLst = findDescendant(presDoc, 'sldIdLst');
      for (const sldId of findChildren(sldIdLst, 'sldId')) {
        const relKey =
          sldId.attrs['r:id'] ??
          Object.entries(sldId.attrs).find(([k]) => k.endsWith(':id'))?.[1];
        if (!relKey) continue;
        const rel = relMap.get(relKey);
        if (rel) {
          const fullPath = resolveZipPath('ppt', rel.target);
          if (zip.file(fullPath)) orderedSlidePaths.push(fullPath);
        }
      }
    }
  }

  // Fallback discovery if presentation.xml didn't enumerate slides
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
    return [];
  }

  // Parse default theme (ppt/theme/theme1.xml or first theme found)
  let baseTheme: ThemeContext = parseThemeXml('');
  const themeEntry =
    zip.file('ppt/theme/theme1.xml') ??
    Object.values(zip.files).find((f) => !f.dir && /^ppt\/theme\/theme\d+\.xml$/i.test(f.name));
  if (themeEntry) {
    baseTheme = parseThemeXml(await themeEntry.async('string'));
  }

  // Cache parsed masters & layouts
  const masterCache = new Map<string, LayerData>();
  const layoutCache = new Map<string, { layer: LayerData; masterPath?: string }>();

  const loadMaster = async (masterPath: string): Promise<LayerData> => {
    const cached = masterCache.get(masterPath);
    if (cached) return cached;

    const entry = zip.file(masterPath);
    if (!entry) {
      const empty: LayerData = { decorativeElements: [], placeholders: new Map() };
      masterCache.set(masterPath, empty);
      return empty;
    }

    const xml = await entry.async('string');
    const doc = parseXml(xml);
    const relsFile = zip.file(getRelsPathFor(masterPath));
    const rels = relsFile ? parseRelationshipMap(await relsFile.async('string')) : new Map();

    // Load master-specific theme if linked
    let masterTheme = baseTheme;
    for (const rel of rels.values()) {
      if (rel.type.toLowerCase().includes('theme')) {
        const themePath = resolveZipPath(getDirOf(masterPath), rel.target);
        const tf = zip.file(themePath);
        if (tf) {
          masterTheme = parseThemeXml(await tf.async('string'));
          break;
        }
      }
    }

    const clrMapNode = findDescendant(doc, 'clrMap');
    const clrMap = parseClrMapAttrs(clrMapNode, masterTheme.clrMap);
    const themed: ThemeContext = { colors: masterTheme.colors, clrMap };

    const cSld = findDescendant(doc, 'cSld');
    const bg = parseBackground(cSld, themed, rels, getDirOf(masterPath));
    const spTree = findChild(cSld, 'spTree');
    const { titleStyle, bodyStyle } = parseMasterTxStyles(doc, themed);
    const { elements, placeholders } = extractElementsFromSpTree(spTree, {
      slideWidthEmu,
      slideHeightEmu,
      theme: themed,
      rels,
      baseDir: getDirOf(masterPath),
      isMasterOrLayout: true,
      titleStyle,
      bodyStyle,
    });

    const data: LayerData = {
      ...bg,
      decorativeElements: elements,
      placeholders,
      clrMap,
      titleStyle,
      bodyStyle,
    };
    masterCache.set(masterPath, data);
    return data;
  };

  const loadLayout = async (layoutPath: string): Promise<{ layer: LayerData; master?: LayerData }> => {
    const cached = layoutCache.get(layoutPath);
    if (cached) {
      return {
        layer: cached.layer,
        master: cached.masterPath ? await loadMaster(cached.masterPath) : undefined,
      };
    }

    const entry = zip.file(layoutPath);
    if (!entry) {
      const empty: LayerData = { decorativeElements: [], placeholders: new Map() };
      layoutCache.set(layoutPath, { layer: empty });
      return { layer: empty };
    }

    const xml = await entry.async('string');
    const doc = parseXml(xml);
    const sldLayout = findChild(doc, 'sldLayout');
    const showMasterSp = getAttr(sldLayout, 'showMasterSp') !== '0';

    const relsFile = zip.file(getRelsPathFor(layoutPath));
    const rels = relsFile ? parseRelationshipMap(await relsFile.async('string')) : new Map();

    let masterPath: string | undefined;
    for (const rel of rels.values()) {
      if (rel.type.toLowerCase().includes('slidemaster')) {
        masterPath = resolveZipPath(getDirOf(layoutPath), rel.target);
        break;
      }
    }
    const master = masterPath ? await loadMaster(masterPath) : undefined;
    const themed: ThemeContext = {
      colors: baseTheme.colors,
      clrMap: master?.clrMap ?? baseTheme.clrMap,
    };

    const cSld = findDescendant(doc, 'cSld');
    const bg = parseBackground(cSld, themed, rels, getDirOf(layoutPath));
    const spTree = findChild(cSld, 'spTree');
    const { elements, placeholders } = extractElementsFromSpTree(spTree, {
      slideWidthEmu,
      slideHeightEmu,
      theme: themed,
      rels,
      baseDir: getDirOf(layoutPath),
      isMasterOrLayout: true,
      inheritedPlaceholders: master?.placeholders,
      titleStyle: master?.titleStyle,
      bodyStyle: master?.bodyStyle,
    });

    // Merge master placeholders under layout placeholders so layout wins on collision
    const mergedPh = new Map<string, PlaceholderTemplate>(master?.placeholders ?? []);
    for (const [k, v] of placeholders.entries()) {
      const m = mergedPh.get(k);
      mergedPh.set(k, {
        ...m,
        ...v,
        box: v.box ?? m?.box,
        defaultFontSizePt: v.defaultFontSizePt ?? m?.defaultFontSizePt,
        defaultColorHex: v.defaultColorHex ?? m?.defaultColorHex,
      });
    }

    const layer: LayerData = {
      ...bg,
      decorativeElements: elements,
      placeholders: mergedPh,
      showMasterSp,
    };
    layoutCache.set(layoutPath, { layer, masterPath });
    return { layer, master };
  };

  const widthPt = Math.max(240, Math.round((slideWidthEmu / EMU_PER_PT) * 10) / 10);
  const heightPt = Math.max(180, Math.round((slideHeightEmu / EMU_PER_PT) * 10) / 10);
  const slides: RichParsedSlide[] = [];

  for (let i = 0; i < orderedSlidePaths.length; i++) {
    const slidePath = orderedSlidePaths[i];
    const slideXml = await zip.file(slidePath)!.async('string');
    const doc = parseXml(slideXml);
    const sldNode = findChild(doc, 'sld');
    const showMasterSpOnSlide = getAttr(sldNode, 'showMasterSp') !== '0';

    const relsFile = zip.file(getRelsPathFor(slidePath));
    const rels = relsFile ? parseRelationshipMap(await relsFile.async('string')) : new Map();

    // Find linked slideLayout
    let layoutData: { layer: LayerData; master?: LayerData } | undefined;
    for (const rel of rels.values()) {
      if (rel.type.toLowerCase().includes('slidelayout')) {
        const lp = resolveZipPath(getDirOf(slidePath), rel.target);
        layoutData = await loadLayout(lp);
        break;
      }
    }

    const master = layoutData?.master;
    const layout = layoutData?.layer;
    const themed: ThemeContext = {
      colors: baseTheme.colors,
      clrMap: master?.clrMap ?? baseTheme.clrMap,
    };

    const cSld = findDescendant(doc, 'cSld');
    const slideBg = parseBackground(cSld, themed, rels, getDirOf(slidePath));
    const bgHex = slideBg.bgHex ?? layout?.bgHex ?? master?.bgHex;
    const bgGradient = slideBg.bgGradient ?? (!slideBg.bgHex && !slideBg.bgImage ? layout?.bgGradient ?? master?.bgGradient : undefined);
    const bgImage = slideBg.bgImage ?? (!slideBg.bgHex && !slideBg.bgGradient ? layout?.bgImage ?? master?.bgImage : undefined);

    const spTree = findChild(cSld, 'spTree');
    const { elements: slideElements } = extractElementsFromSpTree(spTree, {
      slideWidthEmu,
      slideHeightEmu,
      theme: themed,
      rels,
      baseDir: getDirOf(slidePath),
      isMasterOrLayout: false,
      inheritedPlaceholders: layout?.placeholders ?? master?.placeholders,
      titleStyle: master?.titleStyle,
      bodyStyle: master?.bodyStyle,
    });

    // Compose painter's z-order: Master decorative frames -> Layout decorative frames -> Slide elements
    const composedElements: SlideElement[] = [];
    if (showMasterSpOnSlide) {
      if (layout?.showMasterSp !== false && master?.decorativeElements.length) {
        composedElements.push(...master.decorativeElements);
      }
      if (layout?.decorativeElements.length) {
        composedElements.push(...layout.decorativeElements);
      }
    }
    composedElements.push(...slideElements);

    slides.push({
      slideNumber: i + 1,
      widthPt,
      heightPt,
      bgHex,
      bgGradient,
      bgImage,
      elements: composedElements,
    });
  }

  return slides;
}
