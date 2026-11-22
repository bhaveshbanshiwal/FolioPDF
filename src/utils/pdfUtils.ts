export interface PageRangeResult {
  pages: number[]; // 1-indexed
  error?: string;
}

/**
 * Parses a human page range string such as "1-3, 5, 8-10" into 1-indexed page numbers.
 * Preserves user order; deduplicates when deduplicate=true.
 */
export function parsePageRanges(
  input: string,
  totalPages: number,
  options: { deduplicate?: boolean } = {},
): PageRangeResult {
  const { deduplicate = true } = options;
  if (totalPages <= 0) {
    return { pages: [], error: 'Document has no pages.' };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      pages: Array.from({ length: totalPages }, (_, i) => i + 1),
    };
  }

  const result: number[] = [];
  const seen = new Set<number>();
  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);

  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const page = Number(part);
      if (page < 1 || page > totalPages) {
        return {
          pages: [],
          error: `Page ${page} is out of bounds (document has ${totalPages} pages).`,
        };
      }
      if (!deduplicate || !seen.has(page)) {
        result.push(page);
        seen.add(page);
      }
    } else if (/^\d+\s*-\s*\d+$/.test(part)) {
      const [startStr, endStr] = part.split('-').map((s) => s.trim());
      const start = Number(startStr);
      const end = Number(endStr);
      if (start < 1 || end < 1 || start > totalPages || end > totalPages) {
        return {
          pages: [],
          error: `Range "${part}" exceeds document length (1–${totalPages}).`,
        };
      }
      const step = start <= end ? 1 : -1;
      for (let p = start; step > 0 ? p <= end : p >= end; p += step) {
        if (!deduplicate || !seen.has(p)) {
          result.push(p);
          seen.add(p);
        }
      }
    } else {
      return {
        pages: [],
        error: `Invalid page syntax "${part}". Use formats like "1-3, 5, 7-9".`,
      };
    }
  }

  if (result.length === 0) {
    return { pages: [], error: 'No pages selected.' };
  }
  return { pages: result };
}

/**
 * Splits a comma-separated range expression into separate output groups (one PDF per group).
 * Example: "1-2, 3-5" -> [[1, 2], [3, 4, 5]]
 */
export function splitRangesIntoGroups(
  input: string,
  totalPages: number,
): { groups: number[][]; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { groups: [], error: 'Enter at least one range (e.g. 1-2, 3-4).' };
  }
  const tokens = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
  const groups: number[][] = [];
  for (const token of tokens) {
    const parsed = parsePageRanges(token, totalPages, { deduplicate: true });
    if (parsed.error) {
      return { groups: [], error: parsed.error };
    }
    groups.push(parsed.pages);
  }
  return { groups };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIdx]}`;
}

export function computeSavingsPercent(originalBytes: number, outputBytes: number): number {
  if (originalBytes <= 0) return 0;
  return Math.round(((originalBytes - outputBytes) / originalBytes) * 1000) / 10;
}

export interface DiffLine {
  type: 'same' | 'added' | 'removed';
  text: string;
}

/**
 * Computes a clean line-by-line LCS diff for Compare PDFs text comparison.
 */
export function computeTextDiff(textA: string, textB: string): {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
} {
  const a = textA.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const b = textB.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);

  // Cap LCS table size for very large documents to keep UI responsive
  const maxLines = 400;
  const sliceA = a.slice(0, maxLines);
  const sliceB = b.slice(0, maxLines);
  const m = sliceA.length;
  const n = sliceB.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (sliceA[i] === sliceB[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;

  while (i < m && j < n) {
    if (sliceA[i] === sliceB[j]) {
      lines.push({ type: 'same', text: sliceA[i] });
      unchangedCount++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'removed', text: sliceA[i] });
      removedCount++;
      i++;
    } else {
      lines.push({ type: 'added', text: sliceB[j] });
      addedCount++;
      j++;
    }
  }
  while (i < m) {
    lines.push({ type: 'removed', text: sliceA[i++] });
    removedCount++;
  }
  while (j < n) {
    lines.push({ type: 'added', text: sliceB[j++] });
    addedCount++;
  }

  return { lines, addedCount, removedCount, unchangedCount };
}

export interface StructuredTextBlock {
  type: 'heading' | 'subheading' | 'paragraph' | 'bullet' | 'divider';
  text: string;
}

export interface NormalizedWebpageUrl {
  url?: string;
  hostname?: string;
  isPrivateHost?: boolean;
  error?: string;
}

/**
 * Checks whether a hostname resolves to a private, loopback, or link-local address.
 * Used to ensure local/internal URLs are never forwarded to third-party public CORS readers.
 */
export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return true;
  }
  // IPv6 loopback / link-local / unique-local
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
      return true;
    }
    return false;
  }
  // IPv4 private / loopback / link-local ranges
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

/**
 * Validates and normalizes a user-provided webpage URL.
 * Allows only http: and https: protocols and rejects unsafe schemes or malformed hosts.
 */
export function normalizeWebpageUrl(rawInput: string): NormalizedWebpageUrl {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { error: 'Enter a webpage link (for example, https://example.com).' };
  }
  if (/\s/.test(trimmed)) {
    return { error: 'Webpage URL cannot contain spaces.' };
  }

  // If a scheme is explicitly present, validate it before attempting URL normalization
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  let candidate = trimmed;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return {
        error: `Unsupported URL protocol "${scheme}:". Only http:// and https:// links are allowed.`,
      };
    }
  } else {
    candidate = `https://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: 'Please enter a valid webpage URL (for example, https://example.com).' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http:// and https:// webpage links are supported.' };
  }

  const host = parsed.hostname.toLowerCase();
  const isPrivateHost = isPrivateOrLocalHostname(host);
  const hasDot = host.includes('.');
  if (!host || (!hasDot && !isPrivateHost)) {
    return { error: 'Enter a complete domain name (for example, https://example.com).' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'URLs with embedded username/password credentials are not supported.' };
  }

  return {
    url: parsed.toString(),
    hostname: host,
    isPrivateHost,
  };
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    mdash: ' - ',
    ndash: ' - ',
    hellip: '...',
    lsquo: "'",
    rsquo: "'",
    ldquo: '"',
    rdquo: '"',
    bull: '-',
    copy: '(c)',
    reg: '(R)',
    trade: '(TM)',
  };

  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (Number.isFinite(code) && code >= 32 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return ' ';
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code >= 32 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return ' ';
    }
    const lower = entity.toLowerCase();
    return named[lower] ?? full;
  });
}

function cleanMarkdownInline(text: string): string {
  return text
    // Strip linked images like [![alt](imgUrl)](linkUrl)
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    // Strip standalone images ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Convert markdown links [label](url) -> label
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/|#)[^)]*\)/g, '$1')
    // Strip bold / italic / inline code markers
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts a clean <title> value from raw HTML without touching the DOM.
 */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const cleaned = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

/**
 * Parses the text payload returned by the r.jina.ai reader into title + clean Markdown body.
 */
export function parseJinaReaderResponse(
  rawText: string,
  fallbackUrl: string,
): { title: string | null; markdown: string } {
  const normalized = rawText.replace(/\r\n/g, '\n');
  const titleMatch = /^Title:\s*(.+)$/m.exec(normalized);
  const title = titleMatch ? titleMatch[1].trim() : null;

  const marker = 'Markdown Content:';
  const markerIdx = normalized.indexOf(marker);
  let body = markerIdx >= 0 ? normalized.slice(markerIdx + marker.length) : normalized;
  body = body.trim();

  // If the body does not start with a top-level heading and we have a page title, prepend it
  if (title && body && !body.startsWith('# ')) {
    body = `# ${title}\n\n${body}`;
  } else if (!body && title) {
    body = `# ${title}\n\nSource: ${fallbackUrl}`;
  }

  return { title, markdown: body };
}

/**
 * Converts Markdown prose into structured blocks for crisp PDF vector layout.
 */
export function parseMarkdownToBlocks(markdown: string): StructuredTextBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: StructuredTextBlock[] = [];
  let paragraphBuf: string[] = [];
  let inCodeFence = false;

  const flushParagraph = () => {
    if (paragraphBuf.length > 0) {
      const joined = paragraphBuf.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) {
        blocks.push({ type: 'paragraph', text: joined });
      }
      paragraphBuf = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      flushParagraph();
      inCodeFence = !inCodeFence;
      continue;
    }
    if (!line) {
      flushParagraph();
      continue;
    }
    if (inCodeFence) {
      blocks.push({ type: 'paragraph', text: line });
      continue;
    }
    // Skip markdown table divider rows like | --- | --- |
    if (/^\|?[\s:-]+(?:\|[\s:-]+)+\|?$/.test(line)) {
      continue;
    }
    // Skip underline-style setext headings handled as divider if standalone
    if (/^===+$/.test(line)) {
      if (paragraphBuf.length > 0) {
        const headingText = paragraphBuf.join(' ').trim();
        paragraphBuf = [];
        if (headingText) blocks.push({ type: 'heading', text: headingText });
      }
      continue;
    }
    if (/^---+$/.test(line) || /^\*\*\*+$/.test(line)) {
      if (paragraphBuf.length === 1 && line.startsWith('---')) {
        const subText = paragraphBuf.pop()!.trim();
        if (subText) blocks.push({ type: 'subheading', text: subText });
        continue;
      }
      flushParagraph();
      blocks.push({ type: 'divider', text: '' });
      continue;
    }
    if (line.startsWith('# ')) {
      flushParagraph();
      const text = cleanMarkdownInline(line.slice(2));
      if (text) blocks.push({ type: 'heading', text });
    } else if (/^#{2,6}\s+/.test(line)) {
      flushParagraph();
      const text = cleanMarkdownInline(line.replace(/^#+\s+/, ''));
      if (text) blocks.push({ type: 'subheading', text });
    } else if (/^[-*+]\s+/.test(line)) {
      flushParagraph();
      const text = cleanMarkdownInline(line.replace(/^[-*+]\s+/, ''));
      if (text) blocks.push({ type: 'bullet', text });
    } else if (/^\d+\.\s+/.test(line)) {
      flushParagraph();
      const text = cleanMarkdownInline(line);
      if (text) blocks.push({ type: 'bullet', text });
    } else if (line.startsWith('> ')) {
      flushParagraph();
      const text = cleanMarkdownInline(line.replace(/^>+\s*/, ''));
      if (text) blocks.push({ type: 'paragraph', text });
    } else if (line.startsWith('|') && line.endsWith('|')) {
      flushParagraph();
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => cleanMarkdownInline(c))
        .filter(Boolean);
      if (cells.length > 0) {
        blocks.push({ type: 'paragraph', text: cells.join('  |  ') });
      }
    } else {
      const cleaned = cleanMarkdownInline(line);
      if (cleaned) {
        paragraphBuf.push(cleaned);
      }
    }
  }
  flushParagraph();
  return blocks;
}

/**
 * Strips raw HTML safely into structured text blocks (pure JS, no DOM injection).
 */
export function stripHtmlToBlocks(html: string): StructuredTextBlock[] {
  const title = extractHtmlTitle(html);

  // Remove non-content / executable blocks first
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

  // If this looks like a full webpage with <main> or <article>, strip site chrome (<nav>/<footer>)
  const mainMatch = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (mainMatch && mainMatch[2].replace(/<[^>]+>/g, '').trim().length > 120) {
    body = mainMatch[2];
  } else {
    body = body
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');
  }

  const cleaned = decodeHtmlEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<hr\s*\/?>/gi, '\n---\n')
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
      .replace(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/gi, '\n## $1\n')
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1\n')
      .replace(/<\/(p|div|section|article|tr|blockquote|header)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  );

  const blocks = parseMarkdownToBlocks(cleaned);
  if (title && (blocks.length === 0 || blocks[0].type !== 'heading')) {
    blocks.unshift({ type: 'heading', text: title });
  }
  return blocks;
}

/**
 * Parses CSV text handling quoted fields cleanly.
 */
export function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const text = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some((c) => c.length > 0)) {
    rows.push(row);
  }
  return rows;
}

export function sanitizeBaseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_') || 'document';
}

export interface RawPdfTextRun {
  str: string;
  x: number; // normalized 0..1 from left
  y: number; // normalized 0..1 from top
  width: number; // normalized 0..1
  height: number; // normalized 0..1
  fontSizePt: number;
  fontName: string;
}

export interface MergedPdfTextLine {
  id: string;
  pageIndex: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizePt: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  isBold: boolean;
  isItalic: boolean;
}

export function classifyPdfFontStyle(fontName: string): {
  fontFamily: 'sans' | 'serif' | 'mono';
  isBold: boolean;
  isItalic: boolean;
} {
  const lower = (fontName || '').toLowerCase();
  const isMono = /courier|mono|consolas|menlo|code|fixed/.test(lower);
  const isSerif = !isMono && /times|serif|georgia|garamond|cambria|palatino|baskerville/.test(lower);
  const isBold = /bold|black|heavy|semibold|demi|medi/.test(lower);
  const isItalic = /italic|oblique|slant/.test(lower);
  return {
    fontFamily: isMono ? 'mono' : isSerif ? 'serif' : 'sans',
    isBold,
    isItalic,
  };
}

/**
 * Groups individual PDF.js glyph/word runs sitting on the same horizontal baseline
 * into clean, clickable editable text lines while keeping distinct columns separate.
 */
export function mergeRawTextRunsIntoEditableLines(
  runs: RawPdfTextRun[],
  pageIndex: number,
): MergedPdfTextLine[] {
  const valid = runs
    .filter((r) => r.str.trim().length > 0 && r.width > 0 && r.height > 0)
    .sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > Math.max(a.height, b.height) * 0.45) return yDiff;
      return a.x - b.x;
    });

  const lines: MergedPdfTextLine[] = [];

  for (const run of valid) {
    const prev = lines[lines.length - 1];
    const sameBaseline =
      prev &&
      Math.abs(prev.y + prev.height * 0.5 - (run.y + run.height * 0.5)) <=
        Math.max(prev.height, run.height) * 0.52;
    const prevRight = prev ? prev.x + prev.width : 0;
    const gap = prev ? run.x - prevRight : Infinity;
    // Merge adjacent words on the same line, but keep distant table columns separate
    const maxInlineGap = prev ? Math.max(0.032, prev.height * 1.9) : 0;

    if (prev && sameBaseline && gap >= -0.012 && gap <= maxInlineGap) {
      const needsSpace =
        gap > prev.height * 0.14 &&
        !prev.text.endsWith(' ') &&
        !run.str.startsWith(' ');
      prev.text = `${prev.text}${needsSpace ? ' ' : ''}${run.str}`;
      const newLeft = Math.min(prev.x, run.x);
      const newTop = Math.min(prev.y, run.y);
      const newRight = Math.max(prevRight, run.x + run.width);
      const newBottom = Math.max(prev.y + prev.height, run.y + run.height);
      prev.x = newLeft;
      prev.y = newTop;
      prev.width = Math.min(1 - newLeft, newRight - newLeft);
      prev.height = Math.min(1 - newTop, newBottom - newTop);
      prev.fontSizePt = Math.round(((prev.fontSizePt + run.fontSizePt) / 2) * 10) / 10;
    } else {
      const style = classifyPdfFontStyle(run.fontName);
      lines.push({
        id: `txt-p${pageIndex}-${lines.length}`,
        pageIndex,
        text: run.str,
        x: Math.max(0, Math.min(0.99, run.x)),
        y: Math.max(0, Math.min(0.99, run.y)),
        width: Math.max(0.008, Math.min(1 - run.x, run.width)),
        height: Math.max(0.008, Math.min(1 - run.y, run.height)),
        fontSizePt: Math.max(6, Math.min(72, Math.round(run.fontSizePt * 10) / 10)),
        fontFamily: style.fontFamily,
        isBold: style.isBold,
        isItalic: style.isItalic,
      });
    }
  }

  return lines;
}

export interface TextMatchRect {
  line: MergedPdfTextLine;
  matchText: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Finds all occurrences of a query string within extracted PDF text lines and estimates
 * proportional bounding boxes for exact sub-line redaction or full-line replacement.
 */
export function findMatchingTextLineSlices(
  lines: MergedPdfTextLine[],
  query: string,
  caseSensitive = false,
): TextMatchRect[] {
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle.trim()) return [];

  const matches: TextMatchRect[] = [];
  for (const line of lines) {
    const hay = caseSensitive ? line.text : line.text.toLowerCase();
    const totalLen = Math.max(1, line.text.length);
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      const startFrac = idx / totalLen;
      const lenFrac = needle.length / totalLen;
      const padX = Math.min(0.004, line.width * 0.04);
      const x = Math.max(0, line.x + line.width * startFrac - padX);
      const width = Math.min(1 - x, line.width * lenFrac + padX * 2);
      matches.push({
        line,
        matchText: line.text.slice(idx, idx + needle.length),
        x,
        y: line.y,
        width: Math.max(0.01, width),
        height: line.height,
      });
      idx = hay.indexOf(needle, idx + needle.length);
    }
  }
  return matches;
}
