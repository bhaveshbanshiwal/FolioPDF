import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Check,
  Crop,
  Loader2,
  RotateCcw,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  cropPdf,
  extractPdfPages,
  rearrangePdfPages,
  removePdfPages,
  rotatePdfPages,
  splitPdf,
} from '../../engine/pdfOperations';
import {
  renderSinglePageDataUrl,
  renderThumbnails,
  type RenderedThumbnail,
} from '../../engine/pdfRenderer';
import type { ToolId, ToolResult } from '../../types/tools';

interface PageGridToolProps {
  toolId: 'split' | 'rotate' | 'remove-pages' | 'extract-pages' | 'rearrange' | 'crop';
  file: File;
  processing: boolean;
  onRunTask: (fn: (setProgress: (pct: number) => void) => Promise<ToolResult>) => Promise<void>;
}

export function PageGridTool({ toolId, file, processing, onRunTask }: PageGridToolProps) {
  const [thumbnails, setThumbnails] = useState<RenderedThumbnail[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [loadingThumbs, setLoadingThumbs] = useState(true);
  const [thumbError, setThumbError] = useState<string | null>(null);

  // Split state
  const [splitMode, setSplitMode] = useState<'ranges' | 'every-n' | 'all-pages'>('ranges');
  const [splitRanges, setSplitRanges] = useState('1-2, 3');
  const [splitEveryN, setSplitEveryN] = useState(1);

  // Rotate state: map 0-based page index -> rotation delta (0, 90, 180, 270)
  const [rotations, setRotations] = useState<Record<number, number>>({});

  // Remove / Extract state: selected 0-based indices
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [extractAsZip, setExtractAsZip] = useState(false);

  // Rearrange state: array of 0-based original page indices
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // Crop state
  const [cropPage, setCropPage] = useState(1);
  const [cropPreview, setCropPreview] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [cropMargins, setCropMargins] = useState({ top: 0.08, right: 0.08, bottom: 0.08, left: 0.08 });
  const [cropScope, setCropScope] = useState<'all' | 'current'>('all');

  useEffect(() => {
    const controller = new AbortController();
    setLoadingThumbs(true);
    setThumbError(null);
    setThumbnails([]);
    setRotations({});
    setSelected(new Set());

    renderThumbnails(file, {
      scale: 0.36,
      maxThumbnails: 60,
      signal: controller.signal,
      onThumbnail: (thumb, total) => {
        setTotalPages(total);
        setThumbnails((prev) => [...prev, thumb]);
      },
    })
      .then(({ totalPages: total }) => {
        if (controller.signal.aborted) return;
        setTotalPages(total);
        setPageOrder(Array.from({ length: total }, (_, i) => i));
        setSplitRanges(total > 1 ? `1-${Math.ceil(total / 2)}, ${Math.ceil(total / 2) + 1}-${total}` : '1');
        setLoadingThumbs(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setThumbError(err instanceof Error ? err.message : 'Could not render page thumbnails.');
        setLoadingThumbs(false);
      });

    return () => controller.abort();
  }, [file]);

  useEffect(() => {
    if (toolId !== 'crop') return;
    let active = true;
    renderSinglePageDataUrl(file, cropPage, 1.2)
      .then((res) => {
        if (!active) return;
        setCropPreview({ dataUrl: res.dataUrl, width: res.width, height: res.height });
        setTotalPages(res.pageCount);
      })
      .catch(() => {
        // Error surfaced by thumbnail loader
      });
    return () => {
      active = false;
    };
  }, [file, cropPage, toolId]);

  const toggleSelect = (zeroIdx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(zeroIdx)) next.delete(zeroIdx);
      else next.add(zeroIdx);
      return next;
    });
  };

  const rotateAll = (delta: number) => {
    const next: Record<number, number> = {};
    for (let i = 0; i < totalPages; i++) {
      next[i] = ((rotations[i] ?? 0) + delta + 360) % 360;
    }
    setRotations(next);
  };

  const rotateOne = (zeroIdx: number, delta: number) => {
    setRotations((prev) => ({
      ...prev,
      [zeroIdx]: ((prev[zeroIdx] ?? 0) + delta + 360) % 360,
    }));
  };

  const moveOrder = (fromPos: number, toPos: number) => {
    if (toPos < 0 || toPos >= pageOrder.length) return;
    setPageOrder((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromPos, 1);
      copy.splice(toPos, 0, moved);
      return copy;
    });
  };

  const handleSubmit = () => {
    if (toolId === 'split') {
      void onRunTask((setProgress) => splitPdf(file, splitMode, splitRanges, splitEveryN, setProgress));
    } else if (toolId === 'rotate') {
      void onRunTask(() => rotatePdfPages(file, rotations));
    } else if (toolId === 'remove-pages') {
      void onRunTask(() => removePdfPages(file, Array.from(selected).sort((a, b) => a - b)));
    } else if (toolId === 'extract-pages') {
      void onRunTask(() =>
        extractPdfPages(
          file,
          Array.from(selected).sort((a, b) => a - b),
          extractAsZip,
        ),
      );
    } else if (toolId === 'rearrange') {
      void onRunTask(() => rearrangePdfPages(file, pageOrder));
    } else if (toolId === 'crop') {
      void onRunTask(() => cropPdf(file, cropMargins, cropScope, cropPage - 1));
    }
  };

  const primaryActionLabel =
    toolId === 'split'
      ? 'Split PDF'
      : toolId === 'rotate'
        ? 'Save Rotated PDF'
        : toolId === 'remove-pages'
          ? `Remove ${selected.size} Page${selected.size === 1 ? '' : 's'}`
          : toolId === 'extract-pages'
            ? `Extract ${selected.size} Page${selected.size === 1 ? '' : 's'}`
            : toolId === 'rearrange'
              ? 'Save Rearranged PDF'
              : 'Apply Crop to PDF';

  const thumbByOriginalIdx = new Map<number, RenderedThumbnail>();
  thumbnails.forEach((t) => thumbByOriginalIdx.set(t.pageNumber - 1, t));

  return (
    <div className="space-y-5">
      {/* Tool-specific controls bar */}
      <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-4 space-y-4">
        {toolId === 'split' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  ['ranges', 'Custom Ranges'],
                  ['every-n', 'Fixed Interval'],
                  ['all-pages', 'Every Page Separate'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSplitMode(mode)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                    splitMode === mode
                      ? 'bg-rose-600 text-white border-rose-600'
                      : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {splitMode === 'ranges' && (
              <div>
                <label htmlFor="split-ranges-input" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Page ranges (comma creates separate output PDFs)
                </label>
                <input
                  id="split-ranges-input"
                  type="text"
                  value={splitRanges}
                  onChange={(e) => setSplitRanges(e.target.value)}
                  placeholder="e.g. 1-2, 3, 4-6"
                  className="mt-1.5 w-full max-w-md h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm font-mono text-slate-900 dark:text-white"
                />
              </div>
            )}

            {splitMode === 'every-n' && (
              <div className="flex items-center gap-3">
                <label htmlFor="split-every-n" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  Pages per split file:
                </label>
                <input
                  id="split-every-n"
                  type="number"
                  min={1}
                  max={Math.max(1, totalPages)}
                  value={splitEveryN}
                  onChange={(e) => setSplitEveryN(Math.max(1, Number(e.target.value) || 1))}
                  className="w-20 h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm font-mono tabular-nums"
                />
              </div>
            )}
          </div>
        )}

        {toolId === 'rotate' && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => rotateAll(-90)}
              className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Rotate All Left
            </button>
            <button
              type="button"
              onClick={() => rotateAll(90)}
              className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" /> Rotate All Right
            </button>
            <button
              type="button"
              onClick={() => rotateAll(180)}
              className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
            >
              Flip All 180°
            </button>
            <button
              type="button"
              onClick={() => setRotations({})}
              className="h-9 px-3 rounded-lg text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            >
              Reset
            </button>
          </div>
        )}

        {(toolId === 'remove-pages' || toolId === 'extract-pages') && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set(Array.from({ length: totalPages }, (_, i) => i)))}
                className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    new Set(Array.from({ length: totalPages }, (_, i) => i).filter((i) => i % 2 === 0)),
                  )
                }
                className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                Odd Pages
              </button>
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    new Set(Array.from({ length: totalPages }, (_, i) => i).filter((i) => i % 2 === 1)),
                  )
                }
                className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                Even Pages
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="h-8 px-3 rounded-lg text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
              >
                Clear
              </button>
            </div>

            {toolId === 'extract-pages' && (
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={extractAsZip}
                  onChange={(e) => setExtractAsZip(e.target.checked)}
                  className="rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                />
                Export each selected page as a separate PDF (ZIP)
              </label>
            )}
          </div>
        )}

        {toolId === 'rearrange' && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPageOrder((prev) => [...prev].reverse())}
              className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowUpDown className="w-3.5 h-3.5" /> Reverse Page Order
            </button>
            <button
              type="button"
              onClick={() => setPageOrder(Array.from({ length: totalPages }, (_, i) => i))}
              className="h-8 px-3 rounded-lg text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            >
              Reset Original Order
            </button>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Drag cards or use arrows to reorder pages.
            </span>
          </div>
        )}

        {toolId === 'crop' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 flex flex-col items-center">
              {cropPreview ? (
                <div className="relative inline-block border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden bg-white shadow-xs max-w-full">
                  <img
                    src={cropPreview.dataUrl}
                    alt={`Page ${cropPage} crop preview`}
                    className="max-h-[440px] w-auto block select-none"
                  />
                  {/* Shaded trimmed regions */}
                  <div
                    className="absolute inset-x-0 top-0 bg-slate-950/45 pointer-events-none"
                    style={{ height: `${cropMargins.top * 100}%` }}
                  />
                  <div
                    className="absolute inset-x-0 bottom-0 bg-slate-950/45 pointer-events-none"
                    style={{ height: `${cropMargins.bottom * 100}%` }}
                  />
                  <div
                    className="absolute left-0 bg-slate-950/45 pointer-events-none"
                    style={{
                      top: `${cropMargins.top * 100}%`,
                      bottom: `${cropMargins.bottom * 100}%`,
                      width: `${cropMargins.left * 100}%`,
                    }}
                  />
                  <div
                    className="absolute right-0 bg-slate-950/45 pointer-events-none"
                    style={{
                      top: `${cropMargins.top * 100}%`,
                      bottom: `${cropMargins.bottom * 100}%`,
                      width: `${cropMargins.right * 100}%`,
                    }}
                  />
                  {/* Active keep box */}
                  <div
                    className="absolute border-2 border-rose-500 pointer-events-none"
                    style={{
                      top: `${cropMargins.top * 100}%`,
                      right: `${cropMargins.right * 100}%`,
                      bottom: `${cropMargins.bottom * 100}%`,
                      left: `${cropMargins.left * 100}%`,
                    }}
                  />
                </div>
              ) : (
                <div className="h-72 w-56 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />
              )}

              {totalPages > 1 && (
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    disabled={cropPage <= 1}
                    onClick={() => setCropPage((p) => Math.max(1, p - 1))}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
                  >
                    Prev
                  </button>
                  <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                    Page {cropPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={cropPage >= totalPages}
                    onClick={() => setCropPage((p) => Math.min(totalPages, p + 1))}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>

            <div className="lg:col-span-5 space-y-4">
              <div className="flex items-center gap-2 text-sm font-display font-semibold text-slate-900 dark:text-white">
                <Crop className="w-4 h-4 text-rose-600" />
                <span>Trim Margins (%)</span>
              </div>

              {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                <div key={side}>
                  <div className="flex justify-between text-xs mb-1">
                    <label htmlFor={`crop-${side}`} className="capitalize text-slate-600 dark:text-slate-300">
                      {side}
                    </label>
                    <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
                      {Math.round(cropMargins[side] * 100)}%
                    </span>
                  </div>
                  <input
                    id={`crop-${side}`}
                    type="range"
                    min={0}
                    max={40}
                    value={Math.round(cropMargins[side] * 100)}
                    onChange={(e) =>
                      setCropMargins((prev) => ({
                        ...prev,
                        [side]: Number(e.target.value) / 100,
                      }))
                    }
                    className="w-full accent-rose-600"
                  />
                </div>
              ))}

              <div className="pt-2 flex items-center gap-4 text-xs">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="cropScope"
                    checked={cropScope === 'all'}
                    onChange={() => setCropScope('all')}
                  />
                  Apply to all pages
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="cropScope"
                    checked={cropScope === 'current'}
                    onChange={() => setCropScope('current')}
                  />
                  Current page only
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Primary Action Row */}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {totalPages > 0 ? `${totalPages} pages detected` : 'Inspecting document…'}
            {totalPages > 60 && ' (showing first 60 thumbnails for speed)'}
          </span>
          <button
            type="button"
            disabled={processing}
            onClick={handleSubmit}
            className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors cursor-pointer"
          >
            {processing && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>{primaryActionLabel}</span>
          </button>
        </div>
      </div>

      {/* Thumbnail Grid (for all non-crop page tools) */}
      {toolId !== 'crop' && (
        <div>
          {thumbError && (
            <p className="text-xs text-red-600 dark:text-red-400 mb-3">
              Thumbnail preview unavailable ({thumbError}). You can still attempt processing.
            </p>
          )}

          {loadingThumbs && thumbnails.length === 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  className="aspect-[3/4] rounded-xl bg-slate-200/70 dark:bg-slate-800/70 animate-pulse"
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-3">
              {(toolId === 'rearrange'
                ? pageOrder.slice(0, 60)
                : thumbnails.map((t) => t.pageNumber - 1)
              ).map((origZeroIdx, displayPos) => {
                const thumb = thumbByOriginalIdx.get(origZeroIdx);
                if (!thumb) return null;
                const isSelected = selected.has(origZeroIdx);
                const rot = rotations[origZeroIdx] ?? 0;

                return (
                  <div
                    key={`${origZeroIdx}-${displayPos}`}
                    draggable={toolId === 'rearrange'}
                    onDragStart={() => setDragIdx(displayPos)}
                    onDragOver={(e) => {
                      if (toolId === 'rearrange') e.preventDefault();
                    }}
                    onDrop={() => {
                      if (toolId === 'rearrange' && dragIdx !== null && dragIdx !== displayPos) {
                        moveOrder(dragIdx, displayPos);
                      }
                      setDragIdx(null);
                    }}
                    className={`rounded-xl border p-2.5 bg-white dark:bg-[#131C31] transition-colors flex flex-col gap-2 ${
                      toolId === 'remove-pages' && isSelected
                        ? 'border-red-500 bg-red-50/50 dark:bg-red-950/20'
                        : toolId === 'extract-pages' && isSelected
                          ? 'border-rose-500 bg-rose-50/50 dark:bg-rose-950/20'
                          : 'border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (toolId === 'remove-pages' || toolId === 'extract-pages') {
                          toggleSelect(origZeroIdx);
                        } else if (toolId === 'rotate') {
                          rotateOne(origZeroIdx, 90);
                        }
                      }}
                      className="relative aspect-[3/4] w-full rounded-lg bg-slate-100 dark:bg-slate-900 overflow-hidden flex items-center justify-center cursor-pointer"
                    >
                      <img
                        src={thumb.dataUrl}
                        alt={`Page ${origZeroIdx + 1}`}
                        className="max-w-full max-h-full object-contain transition-transform duration-150"
                        style={{ transform: `rotate(${rot}deg)` }}
                      />
                      {toolId === 'remove-pages' && isSelected && (
                        <div className="absolute inset-0 bg-red-600/30 flex items-center justify-center">
                          <span className="w-8 h-8 rounded-full bg-red-600 text-white flex items-center justify-center">
                            <Trash2 className="w-4 h-4" />
                          </span>
                        </div>
                      )}
                      {toolId === 'extract-pages' && isSelected && (
                        <div className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center">
                          <Check className="w-3.5 h-3.5" />
                        </div>
                      )}
                    </button>

                    <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400 font-mono tabular-nums">
                      <span>
                        P.{origZeroIdx + 1}
                        {rot !== 0 ? ` (${rot}°)` : ''}
                      </span>

                      {toolId === 'rotate' && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => rotateOne(origZeroIdx, -90)}
                            aria-label={`Rotate page ${origZeroIdx + 1} left`}
                            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => rotateOne(origZeroIdx, 90)}
                            aria-label={`Rotate page ${origZeroIdx + 1} right`}
                            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          >
                            <RotateCw className="w-3 h-3" />
                          </button>
                        </div>
                      )}

                      {toolId === 'rearrange' && (
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            disabled={displayPos === 0}
                            onClick={() => moveOrder(displayPos, displayPos - 1)}
                            aria-label={`Move page ${origZeroIdx + 1} earlier`}
                            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                          >
                            <ArrowLeft className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={displayPos === pageOrder.length - 1}
                            onClick={() => moveOrder(displayPos, displayPos + 1)}
                            aria-label={`Move page ${origZeroIdx + 1} later`}
                            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                          >
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
