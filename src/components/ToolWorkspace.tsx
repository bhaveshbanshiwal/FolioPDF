import {
  AlertCircle,
  ExternalLink,
  FileText,
  Info,
  RotateCcw,
  Star,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TOOL_BY_ID } from '../data/toolsCatalog';
import { createSamplePdf } from '../engine/pdfOperations';
import type {
  PreflightAssessment,
  TabStatus,
  ToolId,
  ToolResult,
} from '../types/tools';
import { formatBytes } from '../utils/pdfUtils';
import {
  assessWorkloadRisk,
  detectDeviceProfile,
  probeBrowserFile,
  type FileHeaderProbe,
} from '../utils/preflight';
import { FileDropzone } from './FileDropzone';
import { PreflightSign } from './PreflightSign';
import { ResultPanel } from './ResultPanel';
import { ToolIcon } from './ToolIcon';
import { CanvasOverlayTool } from './tools/CanvasOverlayTool';
import { CompareTool } from './tools/CompareTool';
import { ConverterAndImagesTool } from './tools/ConverterAndImagesTool';
import { FormsAndSecurityTool } from './tools/FormsAndSecurityTool';
import { MergeAndOverlayTool } from './tools/MergeAndOverlayTool';
import { PageGridTool } from './tools/PageGridTool';

interface ToolWorkspaceProps {
  tabId: string;
  toolId: ToolId;
  initialFiles?: File[];
  otherTabsBytes: number;
  isFavorite: boolean;
  onToggleFavorite: (toolId: ToolId) => void;
  onTabStateUpdate: (
    tabId: string,
    patch: { status?: TabStatus; progress?: number; loadedBytes?: number },
  ) => void;
  onChainToTool: (toolId: ToolId, file: File) => void;
  onBackToLauncher: (tabId: string) => void;
}

async function createSampleImageFiles(): Promise<File[]> {
  const makeImg = (title: string, accent: string, fileName: string): Promise<File> =>
    new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 540;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 800, 540);
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, 800, 72);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText(title, 36, 46);
      ctx.fillStyle = '#334155';
      ctx.font = '20px sans-serif';
      ctx.fillText('Generated locally in your browser for FolioPDF testing.', 36, 140);
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 2;
      ctx.strokeRect(36, 180, 728, 300);
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(38, 182, 724, 296);
      ctx.fillStyle = accent;
      ctx.fillRect(88, 250, 140, 180);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(268, 290, 140, 140);
      ctx.fillStyle = '#64748b';
      ctx.fillRect(448, 220, 140, 210);
      canvas.toBlob((blob) => {
        resolve(new File([blob ?? new Blob()], fileName, { type: 'image/png' }));
      }, 'image/png');
    });

  return Promise.all([
    makeImg('Sample Slide 01 — Architecture', '#e11d48', 'sample-slide-01.png'),
    makeImg('Sample Slide 02 — Benchmarks', '#0f172a', 'sample-slide-02.png'),
  ]);
}

export function ToolWorkspace({
  tabId,
  toolId,
  initialFiles,
  otherTabsBytes,
  isFavorite,
  onToggleFavorite,
  onTabStateUpdate,
  onChainToTool,
  onBackToLauncher,
}: ToolWorkspaceProps) {
  const tool = TOOL_BY_ID[toolId];
  const device = useMemo(() => detectDeviceProfile(), []);

  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [probes, setProbes] = useState<FileHeaderProbe[]>([]);
  const [extraMultiplier, setExtraMultiplier] = useState(1);

  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageText, setStageText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);

  const resultRef = useRef<ToolResult | null>(null);

  // Clean up object URLs on replacement or tab close
  const replaceResult = useCallback((next: ToolResult | null) => {
    const prev = resultRef.current;
    if (prev) {
      URL.revokeObjectURL(prev.url);
      prev.extractedImages?.forEach((img) => {
        if (img.url !== prev.url) URL.revokeObjectURL(img.url);
      });
    }
    resultRef.current = next;
    setResult(next);
  }, []);

  useEffect(() => {
    return () => {
      const cur = resultRef.current;
      if (cur) {
        URL.revokeObjectURL(cur.url);
        cur.extractedImages?.forEach((img) => {
          if (img.url !== cur.url) URL.revokeObjectURL(img.url);
        });
      }
    };
  }, []);

  // Probe file headers (first & last 64 KB only) and report loadedBytes up to App shell
  useEffect(() => {
    let active = true;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    onTabStateUpdate(tabId, { loadedBytes: totalBytes });

    if (files.length === 0) {
      setProbes([]);
      return;
    }

    Promise.all(files.map((f) => probeBrowserFile(f)))
      .then((res) => {
        if (active) setProbes(res);
      })
      .catch(() => {
        if (active) setProbes([]);
      });

    return () => {
      active = false;
    };
  }, [files, tabId, onTabStateUpdate]);

  const preflight: PreflightAssessment | null = useMemo(() => {
    if (probes.length === 0) return null;
    return assessWorkloadRisk({
      probes,
      toolId,
      otherTabsBytes,
      device,
      extraMultiplier,
    });
  }, [probes, toolId, otherTabsBytes, device, extraMultiplier]);

  const handleFilesSelected = (incoming: File[]) => {
    setError(null);
    replaceResult(null);
    if (tool.multiple && (toolId === 'merge' || toolId === 'images-to-pdf')) {
      setFiles((prev) => [...prev, ...incoming]);
    } else {
      setFiles(incoming);
    }
    onTabStateUpdate(tabId, { status: 'idle', progress: 0 });
  };

  const handleClear = () => {
    setFiles([]);
    setError(null);
    replaceResult(null);
    setProgress(0);
    setStageText(null);
    onTabStateUpdate(tabId, { status: 'idle', progress: 0, loadedBytes: 0 });
  };

  const handleLoadSample = async () => {
    setError(null);
    replaceResult(null);
    if (toolId === 'images-to-pdf') {
      const imgs = await createSampleImageFiles();
      setFiles(imgs);
      return;
    }
    if (toolId === 'merge') {
      const [s1, s2] = await Promise.all([createSamplePdf('v1'), createSamplePdf('v2')]);
      setFiles([s1, s2]);
      return;
    }
    if (toolId === 'overlay') {
      const [base, stamp] = await Promise.all([createSamplePdf('v1'), createSamplePdf('stamp')]);
      setFiles([base, stamp]);
      return;
    }
    const sample = await createSamplePdf('v1');
    setFiles([sample]);
  };

  const handleRunTask = useCallback(
    async (
      taskFn: (setProg: (pct: number, stage?: string) => void) => Promise<ToolResult>,
    ) => {
      setProcessing(true);
      setError(null);
      setProgress(5);
      setStageText('Processing locally…');
      onTabStateUpdate(tabId, { status: 'processing', progress: 5 });

      try {
        const res = await taskFn((pct, stage) => {
          const clamped = Math.max(0, Math.min(100, Math.round(pct)));
          setProgress(clamped);
          if (stage) setStageText(stage);
          onTabStateUpdate(tabId, { status: 'processing', progress: clamped });
        });
        replaceResult(res);
        setProgress(100);
        setStageText(null);
        onTabStateUpdate(tabId, { status: 'done', progress: 100 });
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Processing failed. The file may be corrupted, encrypted, or unsupported.';
        setError(msg);
        setStageText(null);
        onTabStateUpdate(tabId, { status: 'error', progress: 0 });
      } finally {
        setProcessing(false);
      }
    },
    [tabId, onTabStateUpdate, replaceResult],
  );

  const showInitialDropzone =
    !tool.noUploadRequired && toolId !== 'compare' && toolId !== 'overlay' && files.length === 0;

  return (
    <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Tool Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-start gap-3.5 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border border-rose-200/70 dark:border-rose-900/50 flex items-center justify-center shrink-0">
            <ToolIcon toolId={toolId} className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                {tool.name}
              </h1>
              <button
                type="button"
                onClick={() => onToggleFavorite(toolId)}
                aria-label={isFavorite ? `Remove ${tool.name} from favorites` : `Star ${tool.name}`}
                className={`p-1 rounded-md transition-colors cursor-pointer ${
                  isFavorite
                    ? 'text-amber-500'
                    : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
              >
                <Star className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
              </button>
            </div>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              {tool.description}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {files.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          )}
          <a
            href={`#/tool/${toolId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Pop Out</span>
          </a>
          <button
            type="button"
            onClick={() => onBackToLauncher(tabId)}
            className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            All Tools
          </button>
        </div>
      </div>

      {/* Honest Client-Side Capability Note (when applicable) */}
      {tool.capabilityNote && (
        <div className="rounded-xl bg-slate-100/80 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 px-4 py-3 flex items-start gap-2.5 text-xs text-slate-700 dark:text-slate-300">
          <Info className="w-4 h-4 text-slate-500 dark:text-slate-400 mt-0.5 shrink-0" />
          <p className="leading-relaxed">{tool.capabilityNote}</p>
        </div>
      )}

      {/* Non-Blocking Device Crash Risk & Compatibility Sign */}
      <PreflightSign assessment={preflight} />

      {/* Active single-file summary strip when a file is loaded */}
      {files.length === 1 &&
        toolId !== 'merge' &&
        toolId !== 'compare' &&
        toolId !== 'overlay' &&
        toolId !== 'images-to-pdf' &&
        toolId !== 'webpage-to-pdf' && (
          <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <FileText className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
              <span className="text-sm font-medium text-slate-900 dark:text-white truncate">
                {files[0].name}
              </span>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                {formatBytes(files[0].size)}
              </span>
            </div>
            <label className="text-xs font-medium text-rose-600 dark:text-rose-400 hover:underline cursor-pointer">
              Replace file
              <input
                type="file"
                accept={tool.accept}
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    handleFilesSelected([e.target.files[0]]);
                    e.target.value = '';
                  }
                }}
              />
            </label>
          </div>
        )}

      {/* Optional file dropzone for Webpage to PDF (.html / .md upload) */}
      {toolId === 'webpage-to-pdf' && (
        <FileDropzone
          accept={tool.accept}
          multiple={false}
          compact
          label="Drop a saved .html or .md file (optional — or edit markup below)"
          helperText="No size limit · Converts markup directly to vector PDF locally"
          onFilesSelected={handleFilesSelected}
        />
      )}

      {/* Primary Dropzone when waiting for input files */}
      {showInitialDropzone ? (
        <FileDropzone
          accept={tool.accept}
          multiple={tool.multiple}
          onFilesSelected={handleFilesSelected}
          onLoadSample={handleLoadSample}
          sampleLabel={
            toolId === 'images-to-pdf'
              ? 'Try with sample images'
              : toolId === 'merge'
                ? 'Try with 2 sample PDFs'
                : 'Try with sample PDF'
          }
        />
      ) : (
        <>
          {/* Route to Specialized Tool Stage */}
          {toolId === 'compare' && <CompareTool files={files} onFilesChange={setFiles} />}

          {(toolId === 'merge' || toolId === 'overlay') && (
            <MergeAndOverlayTool
              toolId={toolId}
              files={files}
              onFilesChange={setFiles}
              processing={processing}
              onRunTask={handleRunTask}
            />
          )}

          {(toolId === 'split' ||
            toolId === 'rotate' ||
            toolId === 'remove-pages' ||
            toolId === 'extract-pages' ||
            toolId === 'rearrange' ||
            toolId === 'crop') &&
            files[0] && (
              <PageGridTool
                toolId={toolId}
                file={files[0]}
                processing={processing}
                onRunTask={handleRunTask}
              />
            )}

          {(toolId === 'edit' || toolId === 'sign' || toolId === 'redact') && files[0] && (
            <CanvasOverlayTool
              toolId={toolId}
              file={files[0]}
              processing={processing}
              onRunTask={handleRunTask}
            />
          )}

          {(toolId === 'compress' ||
            toolId === 'protect' ||
            toolId === 'unlock' ||
            toolId === 'watermark' ||
            toolId === 'page-numbers' ||
            toolId === 'web-optimize') &&
            files[0] && (
              <FormsAndSecurityTool
                toolId={toolId}
                file={files[0]}
                processing={processing}
                onRunTask={handleRunTask}
                onMultiplierChange={setExtraMultiplier}
              />
            )}

          {(toolId === 'converter' ||
            toolId === 'images-to-pdf' ||
            toolId === 'pdf-to-images' ||
            toolId === 'extract-images' ||
            toolId === 'webpage-to-pdf' ||
            toolId === 'create-pdf' ||
            toolId === 'ocr') && (
            <ConverterAndImagesTool
              toolId={toolId}
              files={files}
              onFilesChange={setFiles}
              processing={processing}
              onRunTask={handleRunTask}
              onMultiplierChange={setExtraMultiplier}
            />
          )}
        </>
      )}

      {/* Determinate Progress Bar */}
      {processing && (
        <div className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {stageText ?? 'Processing locally…'}
            </span>
            <span className="font-mono tabular-nums text-rose-600 dark:text-rose-400 font-semibold">
              {progress}%
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-rose-600 transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-4 flex items-start gap-3 text-xs text-red-800 dark:text-red-200"
        >
          <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Unable to complete operation</p>
            <p className="mt-0.5 leading-relaxed">{error}</p>
          </div>
        </div>
      )}

      {/* Output Result & Cross-Tab Tool Chaining */}
      {result && <ResultPanel result={result} onChainToTool={onChainToTool} />}
    </div>
  );
}
