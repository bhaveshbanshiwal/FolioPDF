import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { ToolResult } from '../types/tools';
import { parsePageRanges, sanitizeBaseName } from '../utils/pdfUtils';
import { buildResultFromBlob, buildResultFromBytes, dataUrlToUint8Array } from './pdfOperations';
import { closePdfJsDocument, openPdfJsDocument, renderPdfPageToCanvas } from './pdfRenderer';

export interface OcrProgressUpdate {
  stage: string;
  percent: number;
}

/**
 * Lazy-loads Tesseract.js WebAssembly ONLY when the user runs OCR,
 * keeping the main static app bundle small and fast on GitHub Pages.
 */
export async function runPdfOcr(
  file: File,
  options: {
    language: string;
    pageRange: string;
    outputMode: 'searchable-pdf' | 'text';
    dpi?: number;
  },
  onProgress?: (update: OcrProgressUpdate) => void,
): Promise<ToolResult> {
  onProgress?.({ stage: 'Loading OCR WebAssembly engine…', percent: 5 });
  const Tesseract = await import('tesseract.js');

  const pdfJsDoc = await openPdfJsDocument(file);
  const parsed = parsePageRanges(options.pageRange, pdfJsDoc.numPages);
  if (parsed.error) {
    await closePdfJsDocument(pdfJsDoc);
    throw new Error(parsed.error);
  }

  const dpi = options.dpi ?? 150;
  const scale = dpi / 72;
  const targetPages = parsed.pages;
  const extractedTexts: string[] = [];

  onProgress?.({ stage: `Initializing "${options.language}" OCR model…`, percent: 12 });
  const worker = await Tesseract.createWorker(options.language, 1, {
    logger: (m) => {
      if (m.status === 'loading language traineddata' && typeof m.progress === 'number') {
        onProgress?.({
          stage: `Downloading language data (${Math.round(m.progress * 100)}%)…`,
          percent: Math.min(25, 12 + Math.round(m.progress * 13)),
        });
      }
    },
  });

  const searchableDoc = options.outputMode === 'searchable-pdf' ? await PDFDocument.create() : null;
  const font = searchableDoc ? await searchableDoc.embedFont(StandardFonts.Helvetica) : null;

  try {
    for (let i = 0; i < targetPages.length; i++) {
      const pageNum = targetPages[i];
      const basePct = 25 + Math.round((i / targetPages.length) * 70);
      onProgress?.({
        stage: `Recognizing text on page ${pageNum} (${i + 1} of ${targetPages.length})…`,
        percent: basePct,
      });

      const page = await pdfJsDoc.getPage(pageNum);
      const vp1 = page.getViewport({ scale: 1 });
      const { canvas, width: cw, height: ch } = await renderPdfPageToCanvas(pdfJsDoc, pageNum, scale);

      const { data } = await worker.recognize(canvas);
      const pageText = (data.text || '').trim();
      extractedTexts.push(`--- Page ${pageNum} ---\n${pageText}`);

      if (searchableDoc && font) {
        const jpgBytes = dataUrlToUint8Array(canvas.toDataURL('image/jpeg', 0.88));
        const img = await searchableDoc.embedJpg(jpgBytes);
        const pdfPage = searchableDoc.addPage([vp1.width, vp1.height]);

        // Place invisible OCR text layer behind the scanned page image so text is selectable & searchable
        const lines = pageText.split('\n').filter(Boolean);
        const lineStep = vp1.height / Math.max(lines.length + 2, 12);
        lines.forEach((line, idx) => {
          const clean = line.replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ').trim();
          if (!clean) return;
          pdfPage.drawText(clean, {
            x: 24,
            y: Math.max(12, vp1.height - (idx + 2) * lineStep),
            size: Math.max(7, Math.min(12, lineStep * 0.7)),
            font,
            color: rgb(0, 0, 0),
            opacity: 0.01,
          });
        });

        // Draw original scanned page cleanly on top (with transparent-selectable text underneath)
        pdfPage.drawImage(img, {
          x: 0,
          y: 0,
          width: vp1.width,
          height: vp1.height,
        });
        // Unused vars guard
        void cw;
        void ch;
      }
    }
  } finally {
    await worker.terminate();
    await closePdfJsDocument(pdfJsDoc);
  }

  const fullText = extractedTexts.join('\n\n');
  const base = sanitizeBaseName(file.name);
  onProgress?.({ stage: 'Finalizing output…', percent: 100 });

  if (options.outputMode === 'searchable-pdf' && searchableDoc) {
    const outBytes = await searchableDoc.save({ useObjectStreams: true });
    return buildResultFromBytes(outBytes, `${base}-ocr-searchable.pdf`, 'application/pdf', {
      originalBytes: file.size,
      pageCount: targetPages.length,
      extraText: fullText,
      summary: `OCR completed across ${targetPages.length} page(s) and built a searchable PDF.`,
    });
  }

  const txtBlob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
  return buildResultFromBlob(txtBlob, `${base}-ocr.txt`, {
    originalBytes: file.size,
    pageCount: targetPages.length,
    extraText: fullText,
    summary: `Recognized text from ${targetPages.length} page(s) using local Tesseract WebAssembly.`,
  });
}
