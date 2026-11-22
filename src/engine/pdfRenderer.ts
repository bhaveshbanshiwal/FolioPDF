import * as pdfjsLib from 'pdfjs-dist';

// Use standard .js extension (emitted to dist/pdf.worker.min.js by Vite) so static hosts
// such as GitHub Pages always serve it with application/javascript MIME type.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  typeof document !== 'undefined'
    ? new URL('pdf.worker.min.js', document.baseURI).href
    : './pdf.worker.min.js';

const docBlobUrls = new WeakMap<pdfjsLib.PDFDocumentProxy, string>();

export interface PdfDocumentMeta {
  pageCount: number;
  pages: Array<{
    pageNumber: number;
    width: number;
    height: number;
    rotation: number;
  }>;
}

export interface RenderedThumbnail {
  pageNumber: number; // 1-based
  dataUrl: string;
  width: number;
  height: number;
}

export async function openPdfJsDocument(
  file: File | Uint8Array,
  password?: string,
): Promise<pdfjsLib.PDFDocumentProxy> {
  if (file instanceof Uint8Array) {
    const task = pdfjsLib.getDocument({
      data: file.slice(),
      password,
      useSystemFonts: true,
    });
    return task.promise;
  }

  // Stream local File via Blob URL so large 200+ MB PDFs are not duplicated in main-thread RAM.
  const blobUrl = URL.createObjectURL(file);
  try {
    const task = pdfjsLib.getDocument({
      url: blobUrl,
      password,
      useSystemFonts: true,
    });
    const doc = await task.promise;
    docBlobUrls.set(doc, blobUrl);
    return doc;
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw err;
  }
}

export async function closePdfJsDocument(doc: pdfjsLib.PDFDocumentProxy): Promise<void> {
  try {
    await doc.cleanup();
  } catch {
    // Ignore cleanup errors
  }
  const maybeDestroy = (doc as unknown as { destroy?: () => Promise<void> }).destroy;
  if (typeof maybeDestroy === 'function') {
    try {
      await maybeDestroy.call(doc);
    } catch {
      // Ignore destroy errors
    }
  }
  const blobUrl = docBlobUrls.get(doc);
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    docBlobUrls.delete(doc);
  }
}

export async function getPdfDocumentMeta(
  file: File,
  password?: string,
): Promise<PdfDocumentMeta> {
  const doc = await openPdfJsDocument(file, password);
  try {
    const pages: PdfDocumentMeta['pages'] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      pages.push({
        pageNumber: i,
        width: vp.width,
        height: vp.height,
        rotation: page.rotate || 0,
      });
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await closePdfJsDocument(doc);
  }
}

export async function renderPdfPageToCanvas(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  rotationDelta = 0,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const page = await doc.getPage(pageNumber);
  const effectiveRotation = ((page.rotate || 0) + rotationDelta + 360) % 360;
  const viewport = page.getViewport({ scale, rotation: effectiveRotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Could not initialize 2D canvas context.');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvas,
    canvasContext: ctx,
    viewport,
  }).promise;

  return { canvas, width: canvas.width, height: canvas.height };
}

export async function renderSinglePageDataUrl(
  file: File,
  pageNumber: number,
  scale = 1.4,
  password?: string,
): Promise<{ dataUrl: string; width: number; height: number; pageCount: number }> {
  const doc = await openPdfJsDocument(file, password);
  try {
    const safePage = Math.max(1, Math.min(pageNumber, doc.numPages));
    const { canvas, width, height } = await renderPdfPageToCanvas(doc, safePage, scale);
    return {
      dataUrl: canvas.toDataURL('image/png'),
      width,
      height,
      pageCount: doc.numPages,
    };
  } finally {
    await closePdfJsDocument(doc);
  }
}

export async function renderThumbnails(
  file: File,
  options: {
    scale?: number;
    maxThumbnails?: number;
    signal?: AbortSignal;
    onThumbnail?: (thumb: RenderedThumbnail, total: number) => void;
  } = {},
): Promise<{ thumbnails: RenderedThumbnail[]; totalPages: number }> {
  const { scale = 0.38, maxThumbnails = 80, signal, onThumbnail } = options;
  const doc = await openPdfJsDocument(file);
  const thumbnails: RenderedThumbnail[] = [];
  const totalPages = doc.numPages;
  const renderLimit = Math.min(totalPages, maxThumbnails);

  try {
    for (let i = 1; i <= renderLimit; i++) {
      if (signal?.aborted) break;
      const { canvas, width, height } = await renderPdfPageToCanvas(doc, i, scale);
      const thumb: RenderedThumbnail = {
        pageNumber: i,
        dataUrl: canvas.toDataURL('image/jpeg', 0.8),
        width,
        height,
      };
      thumbnails.push(thumb);
      onThumbnail?.(thumb, totalPages);
    }
    return { thumbnails, totalPages };
  } finally {
    await closePdfJsDocument(doc);
  }
}

export async function extractPdfTextByPage(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<Array<{ pageNumber: number; text: string }>> {
  const doc = await openPdfJsDocument(file);
  const results: Array<{ pageNumber: number; text: string }> = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let lastY: number | null = null;
      let pageText = '';
      for (const item of content.items) {
        if ('str' in item) {
          const y = item.transform ? Math.round(item.transform[5]) : null;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
            pageText += '\n';
          } else if (pageText.length > 0 && !pageText.endsWith(' ') && !pageText.endsWith('\n')) {
            pageText += ' ';
          }
          pageText += item.str;
          lastY = y;
        }
      }
      results.push({ pageNumber: i, text: pageText.trim() });
      onProgress?.(Math.round((i / doc.numPages) * 100));
    }
    return results;
  } finally {
    await closePdfJsDocument(doc);
  }
}

export interface VisualComparisonResult {
  pageNumber: number;
  totalPagesA: number;
  totalPagesB: number;
  imageAUrl: string | null;
  imageBUrl: string | null;
  diffUrl: string;
  changedPercent: number;
}

export async function comparePdfPagesVisually(
  fileA: File,
  fileB: File,
  pageNumber: number,
  scale = 1.25,
): Promise<VisualComparisonResult> {
  const [docA, docB] = await Promise.all([openPdfJsDocument(fileA), openPdfJsDocument(fileB)]);
  try {
    const totalPagesA = docA.numPages;
    const totalPagesB = docB.numPages;

    const renderedA =
      pageNumber <= totalPagesA ? await renderPdfPageToCanvas(docA, pageNumber, scale) : null;
    const renderedB =
      pageNumber <= totalPagesB ? await renderPdfPageToCanvas(docB, pageNumber, scale) : null;

    const width = Math.max(renderedA?.width ?? 1, renderedB?.width ?? 1);
    const height = Math.max(renderedA?.height ?? 1, renderedB?.height ?? 1);

    const normA = document.createElement('canvas');
    normA.width = width;
    normA.height = height;
    const ctxA = normA.getContext('2d', { willReadFrequently: true })!;
    ctxA.fillStyle = '#ffffff';
    ctxA.fillRect(0, 0, width, height);
    if (renderedA) ctxA.drawImage(renderedA.canvas, 0, 0);

    const normB = document.createElement('canvas');
    normB.width = width;
    normB.height = height;
    const ctxB = normB.getContext('2d', { willReadFrequently: true })!;
    ctxB.fillStyle = '#ffffff';
    ctxB.fillRect(0, 0, width, height);
    if (renderedB) ctxB.drawImage(renderedB.canvas, 0, 0);

    const imgA = ctxA.getImageData(0, 0, width, height);
    const imgB = ctxB.getImageData(0, 0, width, height);

    const diffCanvas = document.createElement('canvas');
    diffCanvas.width = width;
    diffCanvas.height = height;
    const diffCtx = diffCanvas.getContext('2d')!;
    const diffImg = diffCtx.createImageData(width, height);

    const dataA = imgA.data;
    const dataB = imgB.data;
    const out = diffImg.data;
    let changedPixels = 0;
    const totalPixels = width * height;

    for (let i = 0; i < dataA.length; i += 4) {
      const dr = Math.abs(dataA[i] - dataB[i]);
      const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);
      const db = Math.abs(dataA[i + 2] - dataB[i + 2]);
      if (dr + dg + db > 36) {
        changedPixels++;
        const lumA = (dataA[i] + dataA[i + 1] + dataA[i + 2]) / 3;
        const lumB = (dataB[i] + dataB[i + 1] + dataB[i + 2]) / 3;
        if (lumB < lumA) {
          // Darker in B -> added ink (crimson highlight)
          out[i] = 225;
          out[i + 1] = 29;
          out[i + 2] = 72;
          out[i + 3] = 235;
        } else {
          // Darker in A -> removed ink (teal/emerald highlight)
          out[i] = 14;
          out[i + 1] = 165;
          out[i + 2] = 233;
          out[i + 3] = 235;
        }
      } else {
        // Subtle grayscale backdrop of unchanged content
        const gray = Math.round(dataB[i] * 0.25 + 255 * 0.75);
        out[i] = gray;
        out[i + 1] = gray;
        out[i + 2] = gray;
        out[i + 3] = 255;
      }
    }

    diffCtx.putImageData(diffImg, 0, 0);

    return {
      pageNumber,
      totalPagesA,
      totalPagesB,
      imageAUrl: renderedA ? renderedA.canvas.toDataURL('image/png') : null,
      imageBUrl: renderedB ? renderedB.canvas.toDataURL('image/png') : null,
      diffUrl: diffCanvas.toDataURL('image/png'),
      changedPercent: Math.round((changedPixels / Math.max(1, totalPixels)) * 10000) / 100,
    };
  } finally {
    await Promise.all([closePdfJsDocument(docA), closePdfJsDocument(docB)]);
  }
}
