import { ArrowDown, ArrowUp, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createSamplePdf, mergePdfs, overlayPdfs } from '../../engine/pdfOperations';
import type { ToolResult } from '../../types/tools';
import { formatBytes } from '../../utils/pdfUtils';
import { FileDropzone } from '../FileDropzone';

interface MergeAndOverlayToolProps {
  toolId: 'merge' | 'overlay';
  files: File[];
  onFilesChange: (files: File[]) => void;
  processing: boolean;
  onRunTask: (fn: (setProgress: (pct: number) => void) => Promise<ToolResult>) => Promise<void>;
}

export function MergeAndOverlayTool({
  toolId,
  files,
  onFilesChange,
  processing,
  onRunTask,
}: MergeAndOverlayToolProps) {
  // Per-file optional page range for Merge PDF
  const [ranges, setRanges] = useState<Record<number, string>>({});

  // Overlay PDF options
  const [placement, setPlacement] = useState<'over' | 'under'>('over');
  const [opacity, setOpacity] = useState(0.85);
  const [repeatFirstPage, setRepeatFirstPage] = useState(true);

  useEffect(() => {
    setRanges({});
  }, [files.length, toolId]);

  if (toolId === 'merge') {
    const moveFile = (from: number, to: number) => {
      if (to < 0 || to >= files.length) return;
      const next = [...files];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      onFilesChange(next);
    };

    const removeFile = (idx: number) => {
      onFilesChange(files.filter((_, i) => i !== idx));
    };

    const handleAddSample = async () => {
      const sample = await createSamplePdf(files.length % 2 === 0 ? 'v1' : 'v2');
      onFilesChange([...files, sample]);
    };

    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          {files.map((file, idx) => (
            <div key={`${file.name}-${idx}`} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-6 h-6 rounded-md bg-slate-100 dark:bg-slate-800 text-xs font-mono tabular-nums font-semibold text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0">
                  {idx + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
                    {file.name}
                  </p>
                  <p className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    {formatBytes(file.size)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="text"
                  aria-label={`Page range for ${file.name}`}
                  value={ranges[idx] ?? ''}
                  onChange={(e) => setRanges((prev) => ({ ...prev, [idx]: e.target.value }))}
                  placeholder="Pages (e.g. 1-2)"
                  className="w-44 h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs font-mono"
                />
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => moveFile(idx, idx - 1)}
                  aria-label={`Move ${file.name} up`}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  disabled={idx === files.length - 1}
                  onClick={() => moveFile(idx, idx + 1)}
                  aria-label={`Move ${file.name} down`}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeFile(idx)}
                  aria-label={`Remove ${file.name}`}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="h-9 px-3.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131C31] hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer">
              <Plus className="w-3.5 h-3.5" />
              <span>Add More PDFs</span>
              <input
                type="file"
                accept=".pdf,application/pdf"
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
              onClick={handleAddSample}
              className="h-9 px-3.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-rose-600" />
              <span>Add Sample PDF</span>
            </button>
          </div>

          <button
            type="button"
            disabled={processing || files.length < 2}
            onClick={() =>
              void onRunTask((setProgress) =>
                mergePdfs(
                  files.map((f, idx) => ({ file: f, range: ranges[idx] })),
                  setProgress,
                ),
              )
            }
            className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors cursor-pointer"
          >
            {processing && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>Merge {files.length} PDF{files.length === 1 ? '' : 's'}</span>
          </button>
        </div>

        {files.length === 1 && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Add at least one more PDF file (or click “Add Sample PDF”) to merge documents together.
          </p>
        )}
      </div>
    );
  }

  // PDF Overlay UI
  const baseFile = files[0] ?? null;
  const stampFile = files[1] ?? null;

  const loadSampleOverlayPair = async () => {
    const [b, s] = await Promise.all([createSamplePdf('v1'), createSamplePdf('stamp')]);
    onFilesChange([b, s]);
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
            <span>Base PDF</span>
            {baseFile && <span className="font-mono text-slate-500">{baseFile.name}</span>}
          </div>
          <FileDropzone
            accept=".pdf,application/pdf"
            multiple={false}
            compact
            label={baseFile ? 'Replace Base PDF' : 'Drop Base PDF'}
            helperText="Main document pages"
            onFilesSelected={(picked) => onFilesChange(stampFile ? [picked[0], stampFile] : [picked[0]])}
          />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
            <span>Overlay / Letterhead PDF</span>
            {stampFile && <span className="font-mono text-slate-500">{stampFile.name}</span>}
          </div>
          <FileDropzone
            accept=".pdf,application/pdf"
            multiple={false}
            compact
            label={stampFile ? 'Replace Overlay PDF' : 'Drop Overlay / Stamp PDF'}
            helperText="Stamped above or behind base pages"
            onFilesSelected={(picked) => onFilesChange(baseFile ? [baseFile, picked[0]] : [picked[0]])}
            onLoadSample={async () => {
              const stamp = await createSamplePdf('stamp');
              if (baseFile) onFilesChange([baseFile, stamp]);
              else await loadSampleOverlayPair();
            }}
            sampleLabel="Load Sample Letterhead"
          />
        </div>
      </div>

      <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Layer Position
            </label>
            <div className="flex gap-2">
              {(['over', 'under'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlacement(p)}
                  className={`flex-1 h-9 rounded-lg border text-xs font-medium capitalize cursor-pointer ${
                    placement === p
                      ? 'bg-rose-600 text-white border-rose-600'
                      : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {p === 'over' ? 'On Top' : 'Behind'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              <label htmlFor="overlay-opacity">Overlay Opacity</label>
              <span className="font-mono tabular-nums">{Math.round(opacity * 100)}%</span>
            </div>
            <input
              id="overlay-opacity"
              type="range"
              min={10}
              max={100}
              value={Math.round(opacity * 100)}
              onChange={(e) => setOpacity(Number(e.target.value) / 100)}
              className="w-full accent-rose-600 mt-1"
            />
          </div>

          <div className="flex items-end pb-1">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={repeatFirstPage}
                onChange={(e) => setRepeatFirstPage(e.target.checked)}
                className="rounded border-slate-300 text-rose-600"
              />
              Repeat page 1 of overlay on all base pages
            </label>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
          <button
            type="button"
            disabled={processing || !baseFile || !stampFile}
            onClick={() => {
              if (!baseFile || !stampFile) return;
              void onRunTask(() =>
                overlayPdfs(baseFile, stampFile, { placement, opacity, repeatFirstPage }),
              );
            }}
            className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 cursor-pointer"
          >
            {processing && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>Apply PDF Overlay</span>
          </button>
        </div>
      </div>
    </div>
  );
}
