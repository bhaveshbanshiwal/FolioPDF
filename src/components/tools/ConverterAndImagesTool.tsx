import { AlertCircle, ArrowDown, ArrowUp, Download, Globe, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { runPdfOcr } from '../../engine/ocrEngine';
import {
  convertWithPdfConverter,
  createPdfFromComposerBlocks,
  extractEmbeddedImages,
  fetchWebpageFromUrl,
  imagesToPdf,
  pdfToImages,
  webpageHtmlToPdf,
  webpageUrlToPdf,
  type PdfConverterTarget,
} from '../../engine/pdfOperations';
import type { CreatePdfBlock, ToolResult } from '../../types/tools';
import { formatBytes, sanitizeBaseName } from '../../utils/pdfUtils';

interface ConverterAndImagesToolProps {
  toolId:
    | 'converter'
    | 'images-to-pdf'
    | 'pdf-to-images'
    | 'extract-images'
    | 'webpage-to-pdf'
    | 'create-pdf'
    | 'ocr';
  files: File[];
  onFilesChange: (files: File[]) => void;
  processing: boolean;
  onRunTask: (
    fn: (setProgress: (pct: number, stage?: string) => void) => Promise<ToolResult>,
  ) => Promise<void>;
  onMultiplierChange?: (mult: number) => void;
}

const DEFAULT_HTML_SAMPLE = `<h1>Project Proposal — Client-Side PDF Suite</h1>
<p>This document was converted from clean HTML directly inside your browser without uploading data to any remote server.</p>
<h2>Key Highlights</h2>
<ul>
  <li>Zero file size caps — runs directly on local hardware.</li>
  <li>Parallel workspace tabs keep multiple tasks active simultaneously.</li>
  <li>Deployable as a static site on GitHub Pages.</li>
</ul>
<hr />
<p>Replace this markup or upload any saved .html file to generate a vector PDF.</p>`;

const DEFAULT_COMPOSER_BLOCKS: CreatePdfBlock[] = [
  { id: 'b1', type: 'heading', content: 'Monthly Project Summary' },
  {
    id: 'b2',
    type: 'paragraph',
    content:
      'Use this document composer to build clean multi-page PDFs locally. Add headings, paragraphs, bullet lists, tables, dividers, or embedded images below.',
  },
  {
    id: 'b3',
    type: 'bullets',
    content: 'All processing runs offline in JavaScript\nExport crisp vector text and structured tables\nChain the finished PDF straight into Watermark or Protect',
  },
  {
    id: 'b4',
    type: 'table',
    content: 'Deliverable,Owner,Status\nAPI Audit,Elena,Complete\nRelease Notes,Marcus,In Review\nSecurity Sign-off,Priya,Ready',
  },
];

export function ConverterAndImagesTool({
  toolId,
  files,
  onFilesChange,
  processing,
  onRunTask,
  onMultiplierChange,
}: ConverterAndImagesToolProps) {
  // PDF Converter state
  const firstIsPdf = files[0]?.name.toLowerCase().endsWith('.pdf') || files[0]?.type === 'application/pdf';
  const [convertTarget, setConvertTarget] = useState<PdfConverterTarget>('docx');
  const [pptxExportMode, setPptxExportMode] = useState<'editable' | 'visual'>('editable');
  const [sheetOrientation, setSheetOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const sheetOrientationId = useId();

  useEffect(() => {
    if (toolId === 'converter' && files.length > 0) {
      setConvertTarget(firstIsPdf ? 'docx' : 'pdf');
    }
  }, [toolId, files, firstIsPdf]);

  // Images to PDF state
  const [imgPageSize, setImgPageSize] = useState<'a4' | 'letter' | 'fit'>('a4');
  const [imgOrientation, setImgOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [imgMargin, setImgMargin] = useState(24);
  const [imgPreviews, setImgPreviews] = useState<string[]>([]);

  useEffect(() => {
    if (toolId !== 'images-to-pdf') return;
    const urls = files.map((f) => URL.createObjectURL(f));
    setImgPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [toolId, files]);

  // PDF to Images state
  const [exportFormat, setExportFormat] = useState<'png' | 'jpeg' | 'webp'>('png');
  const [exportDpi, setExportDpi] = useState(150);
  const [exportRange, setExportRange] = useState('');

  useEffect(() => {
    if (toolId === 'pdf-to-images') {
      onMultiplierChange?.(exportDpi / 150);
    } else if (toolId === 'converter' && firstIsPdf) {
      if (convertTarget === 'png-zip' || (convertTarget === 'pptx' && pptxExportMode === 'visual')) {
        onMultiplierChange?.(1.65);
      } else {
        onMultiplierChange?.(1);
      }
    } else {
      onMultiplierChange?.(1);
    }
  }, [toolId, exportDpi, firstIsPdf, convertTarget, pptxExportMode, onMultiplierChange]);

  // Webpage / HTML to PDF state
  const webUrlInputId = useId();
  const webPageSizeId = useId();
  const webTextareaId = useId();
  const [webpageUrl, setWebpageUrl] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [fetchUrlError, setFetchUrlError] = useState<string | null>(null);
  const [fetchedMeta, setFetchedMeta] = useState<{ title: string; sourceUrl: string } | null>(null);
  const [markupMode, setMarkupMode] = useState<'html' | 'markdown'>('html');
  const [markupSource, setMarkupSource] = useState(DEFAULT_HTML_SAMPLE);
  const [webPageSize, setWebPageSize] = useState<'a4' | 'letter'>('a4');

  // If user dropped an .html / .md file into webpage-to-pdf, load its text automatically
  useEffect(() => {
    if (toolId !== 'webpage-to-pdf' || files.length === 0) return;
    const f = files[0];
    const isMd = f.name.toLowerCase().endsWith('.md');
    setMarkupMode(isMd ? 'markdown' : 'html');
    setFetchedMeta(null);
    setFetchUrlError(null);
    f.text().then((txt) => setMarkupSource(txt)).catch(() => {});
  }, [toolId, files]);

  // Create PDF composer state
  const [docTitle, setDocTitle] = useState('Monthly Project Summary');
  const [createPageSize, setCreatePageSize] = useState<'a4' | 'letter'>('a4');
  const [blocks, setBlocks] = useState<CreatePdfBlock[]>(DEFAULT_COMPOSER_BLOCKS);

  // OCR state
  const [ocrLang, setOcrLang] = useState('eng');
  const [ocrOutputMode, setOcrOutputMode] = useState<'searchable-pdf' | 'text'>('searchable-pdf');
  const [ocrRange, setOcrRange] = useState('');
  const [ocrDpi, setOcrDpi] = useState(150);

  if (toolId === 'converter') {
    const file = files[0];
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    const isSpreadsheetInput = ['xlsx', 'ods', 'csv', 'tsv'].includes(ext);
    const isPptxInput = ext === 'pptx';

    const effectiveTarget: PdfConverterTarget = firstIsPdf
      ? convertTarget === 'pptx' && pptxExportMode === 'visual'
        ? 'pptx-visual'
        : convertTarget
      : 'pdf';

    return (
      <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {firstIsPdf
                ? 'Convert PDF to another format'
                : isPptxInput
                  ? 'Convert PowerPoint (.pptx) to PDF'
                  : isSpreadsheetInput
                    ? `Convert Spreadsheet (.${ext}) to PDF`
                    : 'Convert file to PDF'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Input: <span className="font-mono">{file.name}</span> ({formatBytes(file.size)})
            </p>
          </div>
        </div>

        {firstIsPdf ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(
                [
                  ['docx', 'Word (.docx)'],
                  ['pptx', 'PowerPoint (.pptx)'],
                  ['xlsx', 'Excel / Sheets (.xlsx)'],
                  ['csv', 'Spreadsheet (.csv)'],
                  ['txt', 'Plain Text (.txt)'],
                  ['md', 'Markdown (.md)'],
                  ['html', 'Web HTML (.html)'],
                  ['png-zip', 'PNG Images (.zip)'],
                ] as const
              ).map(([fmt, label]) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => setConvertTarget(fmt)}
                  className={`h-10 px-3 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                    convertTarget === fmt
                      ? 'bg-rose-600 text-white border-rose-600'
                      : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {convertTarget === 'pptx' && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3 space-y-2">
                <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  PowerPoint Slide Mode
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPptxExportMode('editable')}
                    className={`text-left p-2.5 rounded-lg border transition-colors cursor-pointer ${
                      pptxExportMode === 'editable'
                        ? 'border-rose-500 bg-rose-50/70 dark:bg-rose-950/30'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'
                    }`}
                  >
                    <p className="text-xs font-semibold text-slate-900 dark:text-white">
                      Editable Text Slides
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Creates real editable text boxes at exact PDF positions for PowerPoint & Google Slides.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPptxExportMode('visual')}
                    className={`text-left p-2.5 rounded-lg border transition-colors cursor-pointer ${
                      pptxExportMode === 'visual'
                        ? 'border-rose-500 bg-rose-50/70 dark:bg-rose-950/30'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'
                    }`}
                  >
                    <p className="text-xs font-semibold text-slate-900 dark:text-white">
                      Exact Visual Slides (150 DPI)
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Preserves charts, diagrams, and custom graphics identically on each slide.
                    </p>
                  </button>
                </div>
              </div>
            )}

            {(convertTarget === 'xlsx' || convertTarget === 'csv') && (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Uses coordinate-aware row & column detection to reconstruct tables into{' '}
                {convertTarget === 'xlsx'
                  ? 'an Excel / Google Sheets workbook (.xlsx) with one sheet per page plus a combined summary.'
                  : 'a clean RFC-4180 CSV spreadsheet.'}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {isPptxInput
                ? 'Preserves slide aspect ratio (16:9 / 4:3), backgrounds, positioned text, slide tables, and embedded PNG/JPEG images in a vector PDF.'
                : isSpreadsheetInput
                  ? 'Parses every worksheet into styled multi-page PDF tables with proportional column widths and repeating headers.'
                  : `Will convert ${files.length} file(s) cleanly into a standard PDF document.`}
            </p>

            {isSpreadsheetInput && (
              <div className="flex flex-wrap items-center gap-2.5">
                <label
                  htmlFor={sheetOrientationId}
                  className="text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Sheet Page Orientation:
                </label>
                <select
                  id={sheetOrientationId}
                  value={sheetOrientation}
                  onChange={(e) =>
                    setSheetOrientation(e.target.value as 'auto' | 'portrait' | 'landscape')
                  }
                  className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-200"
                >
                  <option value="auto">Auto (Landscape for &gt; 5 columns)</option>
                  <option value="landscape">Landscape (Wide sheets)</option>
                  <option value="portrait">Portrait (Compact tables)</option>
                </select>
              </div>
            )}
          </div>
        )}

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
          <button
            type="button"
            disabled={processing}
            onClick={() =>
              void onRunTask((setProgress) =>
                convertWithPdfConverter(files, effectiveTarget, setProgress, {
                  sheetOrientation,
                }),
              )
            }
            className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
          >
            {processing && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>Convert Now</span>
          </button>
        </div>
      </div>
    );
  }

  if (toolId === 'images-to-pdf') {
    const moveImg = (from: number, to: number) => {
      if (to < 0 || to >= files.length) return;
      const next = [...files];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      onFilesChange(next);
    };

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {files.map((f, idx) => (
            <div
              key={`${f.name}-${idx}`}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C31] p-2.5 flex flex-col gap-2"
            >
              <div className="aspect-[4/3] rounded-lg bg-slate-100 dark:bg-slate-900 overflow-hidden flex items-center justify-center">
                {imgPreviews[idx] && (
                  <img src={imgPreviews[idx]} alt={f.name} className="max-w-full max-h-full object-contain" />
                )}
              </div>
              <p className="text-[11px] truncate text-slate-700 dark:text-slate-300 font-medium">{f.name}</p>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => moveImg(idx, idx - 1)}
                    aria-label={`Move ${f.name} earlier`}
                    className="p-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === files.length - 1}
                    onClick={() => moveImg(idx, idx + 1)}
                    aria-label={`Move ${f.name} later`}
                    className="p-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onFilesChange(files.filter((_, i) => i !== idx))}
                  aria-label={`Remove ${f.name}`}
                  className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="img-page-size" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Page Size
              </label>
              <select
                id="img-page-size"
                value={imgPageSize}
                onChange={(e) => setImgPageSize(e.target.value as typeof imgPageSize)}
                className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
              >
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
                <option value="fit">Fit to Image Size</option>
              </select>
            </div>

            <div>
              <label htmlFor="img-orient" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Orientation
              </label>
              <select
                id="img-orient"
                disabled={imgPageSize === 'fit'}
                value={imgOrientation}
                onChange={(e) => setImgOrientation(e.target.value as typeof imgOrientation)}
                className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm disabled:opacity-50"
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </div>

            <div>
              <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                <label htmlFor="img-margin">Margin</label>
                <span className="font-mono tabular-nums">{imgMargin} pt</span>
              </div>
              <input
                id="img-margin"
                type="range"
                min={0}
                max={60}
                value={imgMargin}
                onChange={(e) => setImgMargin(Number(e.target.value))}
                className="w-full mt-3 accent-rose-600"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <label className="h-9 px-3.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
              <Plus className="w-3.5 h-3.5" /> Add More Images
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    onFilesChange([...files, ...Array.from(e.target.files)]);
                    e.target.value = '';
                  }
                }}
              />
            </label>

            <button
              type="button"
              disabled={processing || files.length === 0}
              onClick={() =>
                void onRunTask((setProgress) =>
                  imagesToPdf(files, imgPageSize, imgOrientation, imgMargin, setProgress),
                )
              }
              className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
            >
              {processing && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Create PDF from {files.length} Image{files.length === 1 ? '' : 's'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (toolId === 'pdf-to-images') {
    return (
      <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="p2i-fmt" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Image Format
            </label>
            <select
              id="p2i-fmt"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)}
              className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
            >
              <option value="png">PNG (Lossless)</option>
              <option value="jpeg">JPEG (Compact)</option>
              <option value="webp">WebP (Modern web)</option>
            </select>
          </div>

          <div>
            <label htmlFor="p2i-dpi" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Resolution (DPI)
            </label>
            <select
              id="p2i-dpi"
              value={exportDpi}
              onChange={(e) => setExportDpi(Number(e.target.value))}
              className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
            >
              <option value={72}>72 DPI (Fast / Web)</option>
              <option value={150}>150 DPI (Standard — recommended)</option>
              <option value={300}>300 DPI (Print quality — higher RAM)</option>
            </select>
          </div>

          <div>
            <label htmlFor="p2i-range" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Page Range (blank = all pages)
            </label>
            <input
              id="p2i-range"
              type="text"
              value={exportRange}
              onChange={(e) => setExportRange(e.target.value)}
              placeholder="e.g. 1-3, 5"
              className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm font-mono"
            />
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
          <button
            type="button"
            disabled={processing}
            onClick={() =>
              void onRunTask((setProgress) =>
                pdfToImages(files[0], exportFormat, exportDpi, exportRange, setProgress),
              )
            }
            className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
          >
            {processing && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>Render Pages to {exportFormat.toUpperCase()}</span>
          </button>
        </div>
      </div>
    );
  }

  if (toolId === 'extract-images') {
    return (
      <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-sm font-display font-semibold text-slate-900 dark:text-white">
            Scan embedded PDF image streams
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
            Pulls embedded JPEG and Flate raster XObjects directly out of <span className="font-mono">{files[0].name}</span> without re-rendering pages.
          </p>
        </div>
        <button
          type="button"
          disabled={processing}
          onClick={() => void onRunTask((setProgress) => extractEmbeddedImages(files[0], setProgress))}
          className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 shrink-0 cursor-pointer"
        >
          {processing && <Loader2 className="w-4 h-4 animate-spin" />}
          <span>Extract Embedded Images</span>
        </button>
      </div>
    );
  }

  if (toolId === 'webpage-to-pdf') {
    const handleConvertLink = () => {
      setFetchUrlError(null);
      void onRunTask((setProgress) => webpageUrlToPdf(webpageUrl, webPageSize, setProgress));
    };

    const handleFetchIntoEditor = async () => {
      setFetchUrlError(null);
      setFetchingUrl(true);
      try {
        const fetched = await fetchWebpageFromUrl(webpageUrl);
        onFilesChange([]);
        setMarkupMode(fetched.mode);
        setMarkupSource(fetched.content);
        setFetchedMeta({ title: fetched.title, sourceUrl: fetched.sourceUrl });
      } catch (err) {
        setFetchUrlError(err instanceof Error ? err.message : 'Unable to fetch webpage.');
      } finally {
        setFetchingUrl(false);
      }
    };

    const activeUploadedFile = files[0] ?? null;

    return (
      <div className="space-y-4">
        {/* Section 1: Convert directly from a live Webpage Link (URL) */}
        <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
                <Globe className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Convert from Webpage Link
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Paste any public webpage URL to extract readable content and export a vector PDF.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor={webPageSizeId} className="text-xs text-slate-600 dark:text-slate-400">
                Page size:
              </label>
              <select
                id={webPageSizeId}
                value={webPageSize}
                onChange={(e) => setWebPageSize(e.target.value as 'a4' | 'letter')}
                className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-200"
              >
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
              </select>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!processing && !fetchingUrl && webpageUrl.trim()) {
                handleConvertLink();
              }
            }}
            className="flex flex-col sm:flex-row gap-2.5"
          >
            <label htmlFor={webUrlInputId} className="sr-only">
              Webpage URL
            </label>
            <input
              id={webUrlInputId}
              type="text"
              inputMode="url"
              value={webpageUrl}
              onChange={(e) => {
                setWebpageUrl(e.target.value);
                if (fetchUrlError) setFetchUrlError(null);
              }}
              placeholder="https://example.com or en.wikipedia.org/wiki/PDF"
              className="flex-1 h-10 px-3.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-500/40"
            />
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={processing || fetchingUrl || !webpageUrl.trim()}
                onClick={() => void handleFetchIntoEditor()}
                className="h-10 px-3.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 cursor-pointer"
                title="Fetch page content into the editor below so you can review or edit before exporting"
              >
                {fetchingUrl ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                <span>Fetch to Editor</span>
              </button>
              <button
                type="submit"
                disabled={processing || fetchingUrl || !webpageUrl.trim()}
                className="h-10 px-4 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
              >
                {processing && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Convert Link to PDF</span>
              </button>
            </div>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>Try a sample link:</span>
            {[
              { label: 'example.com', url: 'https://example.com' },
              { label: 'Wikipedia: PDF', url: 'https://en.wikipedia.org/wiki/PDF' },
            ].map((sample) => (
              <button
                key={sample.url}
                type="button"
                onClick={() => {
                  setWebpageUrl(sample.url);
                  setFetchUrlError(null);
                }}
                className="px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 hover:border-rose-400 dark:hover:border-rose-500/60 hover:text-rose-600 dark:hover:text-rose-400 transition-colors cursor-pointer"
              >
                {sample.label}
              </button>
            ))}
          </div>

          {fetchUrlError && (
            <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/70 px-3.5 py-2.5 flex items-start gap-2.5 text-xs text-rose-700 dark:text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="flex-1">{fetchUrlError}</span>
            </div>
          )}
        </div>

        {/* Section 2: Convert from Uploaded File or Edited HTML/Markdown Markup */}
        <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {(['html', 'markdown'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMarkupMode(m)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium uppercase cursor-pointer ${
                    markupMode === m
                      ? 'bg-white dark:bg-[#131C31] text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {activeUploadedFile && (
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs text-slate-700 dark:text-slate-300">
                <span className="truncate max-w-[220px]">Loaded file: {activeUploadedFile.name}</span>
                <button
                  type="button"
                  onClick={() => onFilesChange([])}
                  className="text-slate-400 hover:text-rose-600 cursor-pointer"
                  aria-label="Clear uploaded file"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {!activeUploadedFile && fetchedMeta && (
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-700 dark:text-emerald-300">
                <span className="truncate max-w-[280px]">Fetched: {fetchedMeta.title}</span>
                <button
                  type="button"
                  onClick={() => setFetchedMeta(null)}
                  className="text-emerald-600/70 hover:text-emerald-800 dark:hover:text-emerald-200 cursor-pointer"
                  aria-label="Clear fetched URL label"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          <div>
            <label htmlFor={webTextareaId} className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Or paste / edit {markupMode === 'html' ? 'HTML' : 'Markdown'} markup (or upload a saved .html / .md file above)
            </label>
            <textarea
              id={webTextareaId}
              rows={9}
              value={markupSource}
              onChange={(e) => setMarkupSource(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-3 font-mono text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-rose-500/40"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={processing || fetchingUrl || !markupSource.trim()}
              onClick={() =>
                void onRunTask(() =>
                  webpageHtmlToPdf(markupSource, markupMode, webPageSize, {
                    title: fetchedMeta?.title,
                    sourceUrl: fetchedMeta?.sourceUrl,
                    fileName: activeUploadedFile
                      ? sanitizeBaseName(activeUploadedFile.name)
                      : fetchedMeta
                        ? sanitizeBaseName(fetchedMeta.title.slice(0, 48))
                        : undefined,
                  }),
                )
              }
              className="h-10 px-5 rounded-lg bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 text-white dark:text-slate-900 text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
            >
              {processing && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Convert Markup / File to PDF</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (toolId === 'create-pdf') {
    const addBlock = (type: CreatePdfBlock['type']) => {
      const defaults: Record<CreatePdfBlock['type'], string> = {
        heading: 'New Section Heading',
        paragraph: 'Write your paragraph content here.',
        bullets: 'First bullet point\nSecond bullet point',
        table: 'Column A,Column B,Column C\nValue 1,Value 2,Value 3',
        divider: '',
        image: '',
      };
      setBlocks((prev) => [
        ...prev,
        { id: `blk-${Date.now()}-${Math.random()}`, type, content: defaults[type] },
      ]);
    };

    const handleAddImageBlock = (fileList: FileList | null) => {
      const f = fileList?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setBlocks((prev) => [
            ...prev,
            {
              id: `blk-${Date.now()}`,
              type: 'image',
              content: '',
              imageDataUrl: reader.result as string,
              imageName: f.name,
            },
          ]);
        }
      };
      reader.readAsDataURL(f);
    };

    return (
      <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <label htmlFor="create-doc-title" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Document File Name / Title
            </label>
            <input
              id="create-doc-title"
              type="text"
              value={docTitle}
              onChange={(e) => setDocTitle(e.target.value)}
              className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
            />
          </div>
          <div>
            <label htmlFor="create-page-size" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Page Size
            </label>
            <select
              id="create-page-size"
              value={createPageSize}
              onChange={(e) => setCreatePageSize(e.target.value as 'a4' | 'letter')}
              className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
            >
              <option value="a4">A4</option>
              <option value="letter">US Letter</option>
            </select>
          </div>
        </div>

        <div className="space-y-3">
          {blocks.map((blk, idx) => (
            <div
              key={blk.id}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3 space-y-2"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono uppercase text-[11px] font-semibold text-slate-500">
                  {blk.type}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => {
                      const copy = [...blocks];
                      [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
                      setBlocks(copy);
                    }}
                    aria-label="Move block up"
                    className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === blocks.length - 1}
                    onClick={() => {
                      const copy = [...blocks];
                      [copy[idx + 1], copy[idx]] = [copy[idx], copy[idx + 1]];
                      setBlocks(copy);
                    }}
                    aria-label="Move block down"
                    className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setBlocks((prev) => prev.filter((b) => b.id !== blk.id))}
                    aria-label="Delete block"
                    className="p-1 rounded text-slate-400 hover:text-red-600 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {blk.type === 'divider' ? (
                <hr className="border-slate-300 dark:border-slate-700" />
              ) : blk.type === 'image' ? (
                blk.imageDataUrl && (
                  <div className="flex items-center gap-3">
                    <img src={blk.imageDataUrl} alt={blk.imageName ?? 'Embedded'} className="h-20 rounded border bg-white object-contain" />
                    <span className="text-xs font-mono text-slate-500">{blk.imageName}</span>
                  </div>
                )
              ) : blk.type === 'heading' ? (
                <input
                  type="text"
                  value={blk.content}
                  onChange={(e) =>
                    setBlocks((prev) =>
                      prev.map((b) => (b.id === blk.id ? { ...b, content: e.target.value } : b)),
                    )
                  }
                  className="w-full h-9 px-3 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-display font-semibold text-sm"
                />
              ) : (
                <textarea
                  rows={blk.type === 'table' ? 4 : 3}
                  value={blk.content}
                  onChange={(e) =>
                    setBlocks((prev) =>
                      prev.map((b) => (b.id === blk.id ? { ...b, content: e.target.value } : b)),
                    )
                  }
                  placeholder={blk.type === 'table' ? 'CSV rows: Col1,Col2' : 'One item per line'}
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-xs font-mono"
                />
              )}
            </div>
          ))}
        </div>

        <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-1.5">
            {(['heading', 'paragraph', 'bullets', 'table', 'divider'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => addBlock(t)}
                className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium capitalize inline-flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <Plus className="w-3 h-3" /> {t}
              </button>
            ))}
            <label className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium inline-flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
              <Plus className="w-3 h-3" /> Image
              <input
                type="file"
                accept="image/png,image/jpeg"
                className="sr-only"
                onChange={(e) => {
                  handleAddImageBlock(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          <button
            type="button"
            disabled={processing || blocks.length === 0}
            onClick={() =>
              void onRunTask(() =>
                createPdfFromComposerBlocks(blocks, {
                  pageSize: createPageSize,
                  marginPt: 48,
                  title: docTitle,
                }),
              )
            }
            className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
          >
            {processing && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>Build PDF</span>
          </button>
        </div>
      </div>
    );
  }

  // PDF OCR (On-Demand WebAssembly Tesseract.js)
  return (
    <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label htmlFor="ocr-lang" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Document Language
          </label>
          <select
            id="ocr-lang"
            value={ocrLang}
            onChange={(e) => setOcrLang(e.target.value)}
            className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
          >
            <option value="eng">English</option>
            <option value="spa">Spanish</option>
            <option value="fra">French</option>
            <option value="deu">German</option>
            <option value="hin">Hindi</option>
            <option value="por">Portuguese</option>
            <option value="ita">Italian</option>
          </select>
        </div>

        <div>
          <label htmlFor="ocr-output" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Output Type
          </label>
          <select
            id="ocr-output"
            value={ocrOutputMode}
            onChange={(e) => setOcrOutputMode(e.target.value as typeof ocrOutputMode)}
            className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
          >
            <option value="searchable-pdf">Searchable PDF + Text</option>
            <option value="text">Plain Text (.txt) only</option>
          </select>
        </div>

        <div>
          <label htmlFor="ocr-dpi" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Scan Resolution
          </label>
          <select
            id="ocr-dpi"
            value={ocrDpi}
            onChange={(e) => setOcrDpi(Number(e.target.value))}
            className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
          >
            <option value={120}>120 DPI (Faster)</option>
            <option value={150}>150 DPI (Balanced)</option>
            <option value={220}>220 DPI (Small text accuracy)</option>
          </select>
        </div>

        <div>
          <label htmlFor="ocr-range" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Pages (blank = all)
          </label>
          <input
            id="ocr-range"
            type="text"
            value={ocrRange}
            onChange={(e) => setOcrRange(e.target.value)}
            placeholder="e.g. 1-2"
            className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm font-mono"
          />
        </div>
      </div>

      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          You can switch to another parallel tab while OCR runs in the background.
        </span>
        <button
          type="button"
          disabled={processing}
          onClick={() =>
            void onRunTask((setProgress) =>
              runPdfOcr(
                files[0],
                { language: ocrLang, pageRange: ocrRange, outputMode: ocrOutputMode, dpi: ocrDpi },
                (u) => setProgress(u.percent, u.stage),
              ),
            )
          }
          className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
        >
          {processing && <Loader2 className="w-4 h-4 animate-spin" />}
          <span>Start Local OCR</span>
        </button>
      </div>
    </div>
  );
}
