import { decodeXmlEntities } from './officeUtils';

export interface XmlNode {
  tag: string;
  localName: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/**
 * Lightweight, zero-dependency pure-TypeScript XML tree parser.
 * Preserves exact element z-order, nested groups, attributes regardless of order,
 * self-closing tags, and text content identically in browsers and Node tests.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = {
    tag: '#root',
    localName: '#root',
    attrs: {},
    children: [],
    text: '',
  };

  const stack: XmlNode[] = [root];
  const len = xml.length;
  let i = 0;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const tail = xml.slice(i);
      if (tail) stack[stack.length - 1].text += decodeXmlEntities(tail);
      break;
    }

    if (lt > i) {
      const chunk = xml.slice(i, lt);
      if (chunk) stack[stack.length - 1].text += decodeXmlEntities(chunk);
    }

    // Comment <!-- ... -->
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const content = end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end);
      stack[stack.length - 1].text += content;
      i = end === -1 ? len : end + 3;
      continue;
    }

    // Processing instruction <? ... ?> or DOCTYPE <! ... >
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const end = xml.indexOf('>', lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // Find closing '>' outside quoted attribute values
    let gt = lt + 1;
    let quote: string | null = null;
    while (gt < len) {
      const ch = xml[gt];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      gt++;
    }
    if (gt >= len) break;

    const rawTag = xml.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!rawTag) continue;

    // Closing tag </...>
    if (rawTag[0] === '/') {
      const closeName = rawTag.slice(1).trim();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === closeName) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const header = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;

    // Extract tag name
    let nameEnd = 0;
    while (nameEnd < header.length && !/\s/.test(header[nameEnd])) {
      nameEnd++;
    }
    const tag = header.slice(0, nameEnd);
    if (!tag) continue;

    const colonIdx = tag.indexOf(':');
    const localName = colonIdx >= 0 ? tag.slice(colonIdx + 1) : tag;
    const attrs: Record<string, string> = {};

    // Parse attributes
    let p = nameEnd;
    while (p < header.length) {
      while (p < header.length && /\s/.test(header[p])) p++;
      if (p >= header.length) break;
      const keyStart = p;
      while (p < header.length && header[p] !== '=' && !/\s/.test(header[p])) p++;
      const attrName = header.slice(keyStart, p);
      while (p < header.length && /\s/.test(header[p])) p++;
      if (p < header.length && header[p] === '=') {
        p++;
        while (p < header.length && /\s/.test(header[p])) p++;
        let val = '';
        if (p < header.length && (header[p] === '"' || header[p] === "'")) {
          const q = header[p++];
          const valStart = p;
          while (p < header.length && header[p] !== q) p++;
          val = decodeXmlEntities(header.slice(valStart, p));
          if (p < header.length) p++;
        } else {
          const valStart = p;
          while (p < header.length && !/\s/.test(header[p])) p++;
          val = decodeXmlEntities(header.slice(valStart, p));
        }
        if (attrName) attrs[attrName] = val;
      } else if (attrName) {
        attrs[attrName] = '';
      }
    }

    const node: XmlNode = {
      tag,
      localName,
      attrs,
      children: [],
      text: '',
    };

    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  return root;
}

export function findChild(node: XmlNode | undefined, localName: string): XmlNode | undefined {
  if (!node) return undefined;
  return node.children.find((c) => c.localName === localName || c.tag === localName);
}

export function findChildren(node: XmlNode | undefined, localName: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((c) => c.localName === localName || c.tag === localName);
}

export function findDescendant(node: XmlNode | undefined, localName: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (child.localName === localName || child.tag === localName) return child;
    const nested = findDescendant(child, localName);
    if (nested) return nested;
  }
  return undefined;
}

export function findDescendants(node: XmlNode | undefined, localName: string): XmlNode[] {
  const out: XmlNode[] = [];
  if (!node) return out;
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.localName === localName || c.tag === localName) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function getAttr(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) return undefined;
  if (node.attrs[name] !== undefined) return node.attrs[name];
  // Match by local attribute name when prefixed (e.g. r:embed -> embed, xlink:href -> href)
  for (const [k, v] of Object.entries(node.attrs)) {
    const idx = k.indexOf(':');
    if (idx >= 0 && k.slice(idx + 1) === name) return v;
  }
  return undefined;
}

export function collectText(node: XmlNode | undefined): string {
  if (!node) return '';
  let out = node.text;
  for (const c of node.children) {
    out += collectText(c);
  }
  return out;
}
