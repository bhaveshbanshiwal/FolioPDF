import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useId, useState } from 'react';
import type { ToolId, ToolResult } from '../types/tools';
import { computeSavingsPercent, formatBytes } from '../utils/pdfUtils';

interface ResultPanelProps {
  result: ToolResult;
  onChainToTool: (toolId: ToolId, file: File) => void;
}

const CHAIN_TARGETS: Array<{ id: ToolId; label: string }> = [
  { id: 'compress', label: 'Compress PDF' },
  { id: 'watermark', label: 'Add watermark' },
  { id: 'page-numbers', label: 'Add page numbers' },
  { id: 'protect', label: 'Protect PDF' },
  { id: 'sign', label: 'Sign PDF' },
  { id: 'edit', label: 'Edit PDF' },
  { id: 'redact', label: 'Redact PDF' },
  { id: 'rotate', label: 'Rotate pages' },
  { id: 'split', label: 'Split PDF' },
  { id: 'pdf-to-images', label: 'PDF to Images' },
];

export function ResultPanel({ result, onChainToTool }: ResultPanelProps) {
  const chainSelectId = useId();
  const [showPreview, setShowPreview] = useState(false);
  const [chainTarget, setChainTarget] = useState<ToolId>('watermark');
  const [copied, setCopied] = useState(false);

  const isPdf = result.mimeType === 'application/pdf' || result.fileName.toLowerCase().endsWith('.pdf');
  const savings =
    typeof result.originalBytes === 'number' && result.originalBytes > 0
      ? computeSavingsPercent(result.originalBytes, result.outputBytes)
      : null;

  const handleCopyText = async () => {
    if (!result.extraText) return;
    try {
      await navigator.clipboard.writeText(result.extraText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard fallback ignored cleanly
    }
  };

  const handleChain = () => {
    const file = new File([result.blob], result.fileName, { type: result.mimeType });
    onChainToTool(chainTarget, file);
  };

  return (
    <div
      data-testid="tool-result-panel"
      className="rounded-xl bg-white dark:bg-[#131C31] border border-emerald-200 dark:border-emerald-900/60 p-5 space-y-4"
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h3 className="font-display font-semibold text-slate-900 dark:text-white text-sm truncate">
              {result.fileName}
            </h3>
            {result.summary && (
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{result.summary}</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              <span>Output: {formatBytes(result.outputBytes)}</span>
              {typeof result.originalBytes === 'number' && result.originalBytes > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Input: {formatBytes(result.originalBytes)}</span>
                </>
              )}
              {savings !== null && savings !== 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    className={
                      savings > 0
                        ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                        : 'text-slate-500 dark:text-slate-400'
                    }
                  >
                    {savings > 0 ? `-${savings}% smaller` : `+${Math.abs(savings)}%`}
                  </span>
                </>
              )}
              {typeof result.pageCount === 'number' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {result.pageCount} {result.pageCount === 1 ? 'page' : 'pages'}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {isPdf && (
            <button
              type="button"
              onClick={() => setShowPreview((v) => !v)}
              className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span>{showPreview ? 'Hide Preview' : 'Preview'}</span>
            </button>
          )}

          <a
            href={result.url}
            download={result.fileName}
            className="h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </a>
        </div>
      </div>

      {/* Inline PDF preview */}
      {isPdf && showPreview && (
        <div className="rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900">
          <iframe
            src={result.url}
            title={`Preview of ${result.fileName}`}
            className="w-full h-[460px]"
          />
        </div>
      )}

      {/* Extracted image gallery (PDF to Images / Extract PDF images) */}
      {result.extractedImages && result.extractedImages.length > 0 && (
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
          <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2.5">
            Generated Images ({result.extractedImages.length})
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 max-h-80 overflow-y-auto thin-scrollbar pr-1">
            {result.extractedImages.map((img) => (
              <div
                key={img.name}
                className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-2 flex flex-col gap-1.5"
              >
                <img
                  src={img.url}
                  alt={img.name}
                  className="w-full h-28 object-contain rounded bg-white"
                />
                <div className="flex items-center justify-between gap-1 text-[11px]">
                  <span className="truncate text-slate-600 dark:text-slate-400 font-mono">
                    {img.width}×{img.height}
                  </span>
                  <a
                    href={img.url}
                    download={img.name}
                    className="text-rose-600 dark:text-rose-400 hover:underline font-medium shrink-0"
                  >
                    Save
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Extracted OCR / Converter text preview */}
      {result.extraText && (
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Extracted Text Output
            </span>
            <button
              type="button"
              onClick={handleCopyText}
              className="text-xs font-medium text-rose-600 dark:text-rose-400 hover:underline inline-flex items-center gap-1 cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy text'}</span>
            </button>
          </div>
          <textarea
            readOnly
            value={result.extraText}
            rows={7}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 p-3 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none"
          />
        </div>
      )}

      {/* Workflow Chaining: send output PDF straight into another parallel tab */}
      {isPdf && (
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-600 dark:text-slate-400">
            Continue working with this output in a new parallel tab:
          </span>
          <div className="flex items-center gap-2">
            <label htmlFor={chainSelectId} className="sr-only">
              Next tool
            </label>
            <select
              id={chainSelectId}
              value={chainTarget}
              onChange={(e) => setChainTarget(e.target.value as ToolId)}
              className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-200"
            >
              {CHAIN_TARGETS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleChain}
              className="h-8 px-3 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 text-xs font-medium inline-flex items-center gap-1 transition-opacity cursor-pointer whitespace-nowrap"
            >
              <span>Send to New Tab</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
