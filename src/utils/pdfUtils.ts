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

/**
 * Converts Markdown prose into structured blocks for crisp PDF vector layout.
 */
export function parseMarkdownToBlocks(markdown: string): StructuredTextBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: StructuredTextBlock[] = [];
  let paragraphBuf: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuf.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraphBuf.join(' ').trim() });
      paragraphBuf = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    if (/^---+$/.test(line) || /^\*\*\*+$/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'divider', text: '' });
    } else if (line.startsWith('# ')) {
      flushParagraph();
      blocks.push({ type: 'heading', text: line.slice(2).trim() });
    } else if (line.startsWith('## ') || line.startsWith('### ')) {
      flushParagraph();
      blocks.push({ type: 'subheading', text: line.replace(/^#+\s+/, '').trim() });
    } else if (/^[-*+]\s+/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'bullet', text: line.replace(/^[-*+]\s+/, '').trim() });
    } else {
      paragraphBuf.push(line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'));
    }
  }
  flushParagraph();
  return blocks;
}

/**
 * Strips raw HTML safely into structured text blocks (pure JS, no DOM injection).
 */
export function stripHtmlToBlocks(html: string): StructuredTextBlock[] {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/gi, '\n## $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1\n')
    .replace(/<\/(p|div|section|article|tr|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return parseMarkdownToBlocks(cleaned);
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
