import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createSamplePdf } from '../../engine/pdfOperations';
import {
  comparePdfPagesVisually,
  extractPdfTextByPage,
  type VisualComparisonResult,
} from '../../engine/pdfRenderer';
import { computeTextDiff, formatBytes, type DiffLine } from '../../utils/pdfUtils';
import { FileDropzone } from '../FileDropzone';

interface CompareToolProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
}

export function CompareTool({ files, onFilesChange }: CompareToolProps) {
  const fileA = files[0] ?? null;
  const fileB = files[1] ?? null;

  const [viewMode, setViewMode] = useState<'side-by-side' | 'pixel-diff' | 'text-diff'>('pixel-diff');
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visual, setVisual] = useState<VisualComparisonResult | null>(null);
  const [textDiff, setTextDiff] = useState<{
    lines: DiffLine[];
    addedCount: number;
    removedCount: number;
    unchangedCount: number;
  } | null>(null);

  useEffect(() => {
    if (!fileA || !fileB) {
      setVisual(null);
      setTextDiff(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);

    Promise.all([
      comparePdfPagesVisually(fileA, fileB, pageNumber, 1.2),
      extractPdfTextByPage(fileA),
      extractPdfTextByPage(fileB),
    ])
      .then(([vis, pagesA, pagesB]) => {
        if (!active) return;
        setVisual(vis);
        const textA = pagesA.find((p) => p.pageNumber === pageNumber)?.text ?? '';
        const textB = pagesB.find((p) => p.pageNumber === pageNumber)?.text ?? '';
        setTextDiff(computeTextDiff(textA, textB));
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to compare PDFs.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [fileA, fileB, pageNumber]);

  const handleLoadSamples = async () => {
    const [v1, v2] = await Promise.all([createSamplePdf('v1'), createSamplePdf('v2')]);
    setPageNumber(1);
    onFilesChange([v1, v2]);
  };

  const maxPages = Math.max(visual?.totalPagesA ?? 1, visual?.totalPagesB ?? 1);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Original PDF (A)
          </span>
          {fileA ? (
            <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 px-3.5 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-900 dark:text-white truncate">{fileA.name}</p>
                <p className="text-[11px] font-mono tabular-nums text-slate-500">{formatBytes(fileA.size)}</p>
              </div>
              <label className="text-xs font-medium text-rose-600 dark:text-rose-400 hover:underline shrink-0 cursor-pointer">
                Replace
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  className="sr-only"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    if (picked) onFilesChange(fileB ? [picked, fileB] : [picked]);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          ) : (
            <FileDropzone
              accept=".pdf,application/pdf"
              multiple={false}
              compact
              label="Drop Original PDF (A)"
              helperText="No size limit · Local comparison"
              onFilesSelected={(picked) => onFilesChange(fileB ? [picked[0], fileB] : [picked[0]])}
            />
          )}
        </div>

        <div className="space-y-2">
          <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Revised PDF (B)
          </span>
          {fileB ? (
            <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 px-3.5 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-900 dark:text-white truncate">{fileB.name}</p>
                <p className="text-[11px] font-mono tabular-nums text-slate-500">{formatBytes(fileB.size)}</p>
              </div>
              <label className="text-xs font-medium text-rose-600 dark:text-rose-400 hover:underline shrink-0 cursor-pointer">
                Replace
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  className="sr-only"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    if (picked) onFilesChange(fileA ? [fileA, picked] : [picked]);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          ) : (
            <FileDropzone
              accept=".pdf,application/pdf"
              multiple={false}
              compact
              label="Drop Revised PDF (B)"
              helperText="No size limit · Local comparison"
              onFilesSelected={(picked) => onFilesChange(fileA ? [fileA, picked[0]] : [picked[0]])}
            />
          )}
        </div>
      </div>

      {(!fileA || !fileB) && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={handleLoadSamples}
            className="h-9 px-4 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-rose-600" />
            <span>Load Sample v1 & v2 PDFs to Compare</span>
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-3 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {fileA && fileB && (
        <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {(
                [
                  ['pixel-diff', 'Pixel Diff Overlay'],
                  ['side-by-side', 'Side by Side'],
                  ['text-diff', 'Text Diff'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    viewMode === m
                      ? 'bg-white dark:bg-[#131C31] text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 text-xs">
              {visual && (
                <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  Pixel diff: <strong>{visual.changedPercent}%</strong>
                </span>
              )}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={pageNumber <= 1}
                  onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
                >
                  Prev
                </button>
                <span className="font-mono tabular-nums">
                  Page {pageNumber} / {maxPages}
                </span>
                <button
                  type="button"
                  disabled={pageNumber >= maxPages}
                  onClick={() => setPageNumber((p) => Math.min(maxPages, p + 1))}
                  className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
                >
                  Next
                </button>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="py-16 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin text-rose-600" />
              <span>Comparing page {pageNumber}…</span>
            </div>
          ) : viewMode === 'pixel-diff' && visual ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-400">
                <span>Legend:</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-xs bg-rose-600 inline-block" /> Added / changed in B
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-xs bg-sky-500 inline-block" /> Removed from A
                </span>
              </div>
              <div className="flex justify-center bg-slate-100 dark:bg-slate-900 rounded-lg p-3">
                <img
                  src={visual.diffUrl}
                  alt={`Visual diff page ${pageNumber}`}
                  className="max-h-[580px] w-auto border border-slate-300 dark:border-slate-700 bg-white rounded"
                />
              </div>
            </div>
          ) : viewMode === 'side-by-side' && visual ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-400">Original (A)</p>
                <div className="bg-slate-100 dark:bg-slate-900 rounded-lg p-2 flex justify-center">
                  {visual.imageAUrl ? (
                    <img src={visual.imageAUrl} alt="Document A" className="max-h-[540px] w-auto bg-white rounded border" />
                  ) : (
                    <p className="py-20 text-xs text-slate-500">Page not present in Original</p>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-400">Revised (B)</p>
                <div className="bg-slate-100 dark:bg-slate-900 rounded-lg p-2 flex justify-center">
                  {visual.imageBUrl ? (
                    <img src={visual.imageBUrl} alt="Document B" className="max-h-[540px] w-auto bg-white rounded border" />
                  ) : (
                    <p className="py-20 text-xs text-slate-500">Page not present in Revised</p>
                  )}
                </div>
              </div>
            </div>
          ) : textDiff ? (
            <div className="space-y-3">
              <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{textDiff.addedCount} added</span>
                <span className="text-red-600 dark:text-red-400">-{textDiff.removedCount} removed</span>
                <span className="text-slate-500">{textDiff.unchangedCount} unchanged</span>
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800/80 max-h-[440px] overflow-y-auto font-mono text-xs">
                {textDiff.lines.length === 0 ? (
                  <p className="p-4 text-slate-500">No selectable text detected on this page.</p>
                ) : (
                  textDiff.lines.map((line, i) => (
                    <div
                      key={i}
                      className={`px-3 py-1.5 whitespace-pre-wrap ${
                        line.type === 'added'
                          ? 'bg-emerald-50/80 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200'
                          : line.type === 'removed'
                            ? 'bg-red-50/80 dark:bg-red-950/30 text-red-900 dark:text-red-200 line-through'
                            : 'text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      <span className="inline-block w-4 select-none opacity-60">
                        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                      </span>
                      {line.text}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
