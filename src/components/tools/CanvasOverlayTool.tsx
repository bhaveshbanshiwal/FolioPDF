import {
  Eraser,
  Highlighter,
  ImagePlus,
  Loader2,
  Pen,
  Square,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { applyCanvasOverlaysToPdf, redactPdf } from '../../engine/pdfOperations';
import { renderSinglePageDataUrl } from '../../engine/pdfRenderer';
import type { OverlayKind, PageOverlayItem, ToolResult } from '../../types/tools';

interface CanvasOverlayToolProps {
  toolId: 'edit' | 'sign' | 'redact';
  file: File;
  processing: boolean;
  onRunTask: (fn: (setProgress: (pct: number) => void) => Promise<ToolResult>) => Promise<void>;
}

export function CanvasOverlayTool({
  toolId,
  file,
  processing,
  onRunTask,
}: CanvasOverlayToolProps) {
  const [pageNumber, setPageNumber] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pageImg, setPageImg] = useState<{ dataUrl: string; width: number; height: number } | null>(
    null,
  );
  const [loadingPage, setLoadingPage] = useState(true);

  // Overlays stored in normalized 0..1 coordinates across all pages
  const [overlays, setOverlays] = useState<PageOverlayItem[]>([]);

  // Active mode for Edit / Sign / Redact
  const [mode, setMode] = useState<OverlayKind>(
    toolId === 'redact' ? 'redact' : toolId === 'sign' ? 'image' : 'text',
  );
  const [color, setColor] = useState(toolId === 'edit' ? '#e11d48' : '#0f172a');
  const [fontSize, setFontSize] = useState(15);
  const [strokeWidth, setStrokeWidth] = useState(2.5);
  const [textDraft, setTextDraft] = useState('Approved');
  const [redactDpi, setRedactDpi] = useState(180);

  // Signature builder state (for Sign PDF)
  const [sigTab, setSigTab] = useState<'draw' | 'type' | 'upload'>('draw');
  const [typedSig, setTypedSig] = useState('Alex Rivera');
  const [sigDataUrl, setSigDataUrl] = useState<string | null>(null);
  const [sigScale, setSigScale] = useState(0.26); // normalized width
  const sigCanvasRef = useRef<HTMLCanvasElement>(null);
  const sigDrawingRef = useRef(false);

  // Interactive page drawing state
  const stageRef = useRef<HTMLDivElement>(null);
  const [draftBox, setDraftBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const [draftPoints, setDraftPoints] = useState<Array<{ x: number; y: number }> | null>(null);

  useEffect(() => {
    setPageNumber(1);
    setOverlays([]);
  }, [file, toolId]);

  useEffect(() => {
    let active = true;
    setLoadingPage(true);
    renderSinglePageDataUrl(file, pageNumber, 1.35)
      .then((res) => {
        if (!active) return;
        setPageImg({ dataUrl: res.dataUrl, width: res.width, height: res.height });
        setTotalPages(res.pageCount);
        setLoadingPage(false);
      })
      .catch(() => {
        if (active) setLoadingPage(false);
      });
    return () => {
      active = false;
    };
  }, [file, pageNumber]);

  // Generate typed signature PNG whenever typedSig changes in Sign mode
  useEffect(() => {
    if (toolId !== 'sign' || sigTab !== 'type') return;
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 140;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.font = 'italic 54px Georgia, "Times New Roman", serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(typedSig || 'Signature', 20, 72);
    setSigDataUrl(canvas.toDataURL('image/png'));
  }, [typedSig, color, sigTab, toolId]);

  const getNormalizedPoint = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getNormalizedPoint(e);

    if (toolId === 'sign' || mode === 'image') {
      if (!sigDataUrl) return;
      const w = sigScale;
      const h = w * 0.34;
      setOverlays((prev) => [
        ...prev,
        {
          id: `ov-${Date.now()}-${Math.random()}`,
          pageIndex: pageNumber - 1,
          kind: 'image',
          x: Math.max(0, Math.min(1 - w, pt.x - w / 2)),
          y: Math.max(0, Math.min(1 - h, pt.y - h / 2)),
          width: w,
          height: h,
          imageDataUrl: sigDataUrl,
        },
      ]);
      return;
    }

    if (mode === 'text') {
      const content = textDraft.trim() || 'Text annotation';
      setOverlays((prev) => [
        ...prev,
        {
          id: `ov-${Date.now()}-${Math.random()}`,
          pageIndex: pageNumber - 1,
          kind: 'text',
          x: pt.x,
          y: pt.y,
          width: 0.3,
          height: 0.05,
          color,
          fontSize,
          text: content,
        },
      ]);
      return;
    }

    if (mode === 'freehand') {
      setDraftPoints([pt]);
      return;
    }

    // Box drawing: redact, rect, highlight, whiteout
    setDraftBox({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draftBox && !draftPoints) return;
    const pt = getNormalizedPoint(e);
    if (draftBox) {
      setDraftBox((prev) => (prev ? { ...prev, x1: pt.x, y1: pt.y } : null));
    } else if (draftPoints) {
      setDraftPoints((prev) => (prev ? [...prev, pt] : null));
    }
  };

  const handlePointerUp = () => {
    if (draftBox) {
      const x = Math.min(draftBox.x0, draftBox.x1);
      const y = Math.min(draftBox.y0, draftBox.y1);
      const width = Math.abs(draftBox.x1 - draftBox.x0);
      const height = Math.abs(draftBox.y1 - draftBox.y0);
      if (width > 0.01 && height > 0.01) {
        setOverlays((prev) => [
          ...prev,
          {
            id: `ov-${Date.now()}-${Math.random()}`,
            pageIndex: pageNumber - 1,
            kind: toolId === 'redact' ? 'redact' : mode,
            x,
            y,
            width,
            height,
            color: mode === 'highlight' ? '#facc15' : color,
            strokeWidth,
            opacity: mode === 'highlight' ? 0.38 : 1,
          },
        ]);
      }
      setDraftBox(null);
    } else if (draftPoints && draftPoints.length > 1) {
      setOverlays((prev) => [
        ...prev,
        {
          id: `ov-${Date.now()}-${Math.random()}`,
          pageIndex: pageNumber - 1,
          kind: 'freehand',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          color,
          strokeWidth,
          points: draftPoints,
        },
      ]);
      setDraftPoints(null);
    }
  };

  // Signature draw pad helpers
  const startSigDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    sigDrawingRef.current = true;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const moveSigDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!sigDrawingRef.current) return;
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const endSigDraw = () => {
    if (!sigDrawingRef.current) return;
    sigDrawingRef.current = false;
    const canvas = sigCanvasRef.current;
    if (canvas) setSigDataUrl(canvas.toDataURL('image/png'));
  };

  const clearSigPad = () => {
    const canvas = sigCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    setSigDataUrl(null);
  };

  const handleImageUpload = (fileList: FileList | null) => {
    const f = fileList?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setSigDataUrl(reader.result);
        setMode('image');
      }
    };
    reader.readAsDataURL(f);
  };

  const currentPageOverlays = overlays.filter((o) => o.pageIndex === pageNumber - 1);

  const handleExport = () => {
    if (toolId === 'redact') {
      void onRunTask((setProgress) => redactPdf(file, overlays, redactDpi, setProgress));
    } else {
      void onRunTask((setProgress) =>
        applyCanvasOverlaysToPdf(file, overlays, toolId === 'sign' ? 'signed' : 'edited', setProgress),
      );
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* Left Sidebar Controls */}
      <div className="lg:col-span-4 rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-4 space-y-4">
        {toolId === 'edit' && (
          <>
            <div>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
                Annotation Tool
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    ['text', 'Text', Type],
                    ['highlight', 'Highlight', Highlighter],
                    ['rect', 'Box', Square],
                    ['whiteout', 'White-out', Eraser],
                    ['freehand', 'Draw', Pen],
                    ['image', 'Stamp Img', ImagePlus],
                  ] as const
                ).map(([k, label, Icon]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMode(k)}
                    className={`h-9 px-2 rounded-lg border text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                      mode === k
                        ? 'bg-rose-600 text-white border-rose-600'
                        : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {mode === 'text' && (
              <div className="space-y-2">
                <label htmlFor="edit-text-input" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Text to place (click page to stamp)
                </label>
                <input
                  id="edit-text-input"
                  type="text"
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                />
                <div className="flex items-center gap-3 text-xs">
                  <label htmlFor="edit-font-size">Size ({fontSize}pt)</label>
                  <input
                    id="edit-font-size"
                    type="range"
                    min={9}
                    max={36}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="flex-1 accent-rose-600"
                  />
                </div>
              </div>
            )}

            {mode === 'image' && (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Upload stamp image (PNG/JPG), then click page
                </label>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => handleImageUpload(e.target.files)}
                  className="block w-full text-xs text-slate-600 dark:text-slate-300"
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <label htmlFor="edit-color-picker" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Ink Color
              </label>
              <div className="flex items-center gap-2">
                {['#0f172a', '#e11d48', '#2563eb', '#16a34a'].map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${c}`}
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full border-2 cursor-pointer ${
                      color === c ? 'border-slate-900 dark:border-white scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <input
                  id="edit-color-picker"
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-7 h-7 rounded cursor-pointer bg-transparent"
                />
              </div>
            </div>

            {(mode === 'freehand' || mode === 'rect') && (
              <div className="flex items-center gap-3 text-xs">
                <label htmlFor="edit-stroke">Stroke ({strokeWidth}px)</label>
                <input
                  id="edit-stroke"
                  type="range"
                  min={1}
                  max={8}
                  step={0.5}
                  value={strokeWidth}
                  onChange={(e) => setStrokeWidth(Number(e.target.value))}
                  className="flex-1 accent-rose-600"
                />
              </div>
            )}
          </>
        )}

        {toolId === 'sign' && (
          <div className="space-y-3">
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {(['draw', 'type', 'upload'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSigTab(t)}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md capitalize cursor-pointer ${
                    sigTab === t
                      ? 'bg-white dark:bg-[#131C31] text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {sigTab === 'draw' && (
              <div className="space-y-2">
                <canvas
                  ref={sigCanvasRef}
                  width={360}
                  height={120}
                  onPointerDown={startSigDraw}
                  onPointerMove={moveSigDraw}
                  onPointerUp={endSigDraw}
                  onPointerLeave={endSigDraw}
                  className="w-full h-28 rounded-lg border border-slate-300 dark:border-slate-700 bg-white touch-none cursor-crosshair"
                />
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Draw above, then click on the PDF page</span>
                  <button
                    type="button"
                    onClick={clearSigPad}
                    className="text-rose-600 hover:underline cursor-pointer"
                  >
                    Clear pad
                  </button>
                </div>
              </div>
            )}

            {sigTab === 'type' && (
              <div className="space-y-2">
                <label htmlFor="typed-sig-input" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Type your signature
                </label>
                <input
                  id="typed-sig-input"
                  type="text"
                  value={typedSig}
                  onChange={(e) => setTypedSig(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                />
                {sigDataUrl && (
                  <div className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white">
                    <img src={sigDataUrl} alt="Typed signature preview" className="h-12 mx-auto object-contain" />
                  </div>
                )}
              </div>
            )}

            {sigTab === 'upload' && (
              <div className="space-y-2">
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => handleImageUpload(e.target.files)}
                  className="block w-full text-xs"
                />
                {sigDataUrl && (
                  <img src={sigDataUrl} alt="Uploaded signature" className="h-14 object-contain bg-white p-1 rounded border" />
                )}
              </div>
            )}

            <div className="flex items-center gap-3 text-xs">
              <label htmlFor="sig-size">Placement Size</label>
              <input
                id="sig-size"
                type="range"
                min={12}
                max={50}
                value={Math.round(sigScale * 100)}
                onChange={(e) => setSigScale(Number(e.target.value) / 100)}
                className="flex-1 accent-rose-600"
              />
              <span className="font-mono tabular-nums">{Math.round(sigScale * 100)}%</span>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              Click anywhere on the PDF page preview to stamp your signature.
            </p>
          </div>
        )}

        {toolId === 'redact' && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              Click and drag on the PDF page to draw solid black redaction boxes over sensitive
              names, numbers, or paragraphs.
            </p>
            <div>
              <label htmlFor="redact-dpi" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Burn-in raster resolution (DPI)
              </label>
              <select
                id="redact-dpi"
                value={redactDpi}
                onChange={(e) => setRedactDpi(Number(e.target.value))}
                className="mt-1 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs"
              >
                <option value={150}>150 DPI (Balanced)</option>
                <option value={180}>180 DPI (Recommended)</option>
                <option value={240}>240 DPI (High clarity)</option>
              </select>
            </div>
          </div>
        )}

        {/* Placed items list & Undo */}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300 font-mono tabular-nums">
              {overlays.length} element{overlays.length === 1 ? '' : 's'} placed
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={overlays.length === 0}
                onClick={() => setOverlays((prev) => prev.slice(0, -1))}
                className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white disabled:opacity-35 cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" /> Undo
              </button>
              <button
                type="button"
                disabled={overlays.length === 0}
                onClick={() => setOverlays([])}
                className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 hover:underline disabled:opacity-35 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" /> Clear
              </button>
            </div>
          </div>

          <button
            type="button"
            disabled={processing || overlays.length === 0}
            onClick={handleExport}
            className="w-full h-10 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            {processing && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>
              {toolId === 'redact'
                ? 'Apply Permanent Redactions'
                : toolId === 'sign'
                  ? 'Save Signed PDF'
                  : 'Save Edited PDF'}
            </span>
          </button>
        </div>
      </div>

      {/* Right Interactive Page Canvas Stage */}
      <div className="lg:col-span-8 rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-4 flex flex-col items-center">
        <div className="w-full flex items-center justify-between mb-3 text-xs">
          <span className="text-slate-500 dark:text-slate-400">
            {toolId === 'sign'
              ? 'Click page to place signature'
              : toolId === 'redact'
                ? 'Drag on page to draw redaction box'
                : mode === 'text' || mode === 'image'
                  ? 'Click page to place element'
                  : 'Click and drag on page to draw'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pageNumber <= 1}
              onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
            >
              Prev
            </button>
            <span className="font-mono tabular-nums">
              Page {pageNumber} / {totalPages}
            </span>
            <button
              type="button"
              disabled={pageNumber >= totalPages}
              onClick={() => setPageNumber((p) => Math.min(totalPages, p + 1))}
              className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>

        {loadingPage || !pageImg ? (
          <div className="w-full max-w-lg aspect-[3/4] rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ) : (
          <div
            ref={stageRef}
            data-testid="interactive-pdf-stage"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="relative inline-block max-w-full border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden bg-white select-none touch-none cursor-crosshair shadow-xs"
          >
            <img
              src={pageImg.dataUrl}
              alt={`PDF Page ${pageNumber}`}
              draggable={false}
              className="max-h-[600px] w-auto block pointer-events-none"
            />

            {/* Rendered overlays on current page */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
            >
              {currentPageOverlays.map((item) => {
                if (item.kind === 'freehand' && item.points && item.points.length > 1) {
                  const d = item.points
                    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x * 1000} ${p.y * 1000}`)
                    .join(' ');
                  return (
                    <path
                      key={item.id}
                      d={d}
                      fill="none"
                      stroke={item.color ?? '#0f172a'}
                      strokeWidth={(item.strokeWidth ?? 2.5) * 1.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                }
                return null;
              })}
              {draftPoints && draftPoints.length > 1 && (
                <path
                  d={draftPoints
                    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x * 1000} ${p.y * 1000}`)
                    .join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth * 1.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>

            {currentPageOverlays.map((item) => {
              if (item.kind === 'freehand') return null;
              if (item.kind === 'text') {
                return (
                  <div
                    key={item.id}
                    className="absolute pointer-events-none whitespace-pre-wrap font-sans leading-tight"
                    style={{
                      left: `${item.x * 100}%`,
                      top: `${item.y * 100}%`,
                      color: item.color,
                      fontSize: `${Math.max(10, (item.fontSize ?? 14) * 0.9)}px`,
                    }}
                  >
                    {item.text}
                  </div>
                );
              }
              if (item.kind === 'image' && item.imageDataUrl) {
                return (
                  <img
                    key={item.id}
                    src={item.imageDataUrl}
                    alt="Placed stamp"
                    className="absolute pointer-events-none object-contain"
                    style={{
                      left: `${item.x * 100}%`,
                      top: `${item.y * 100}%`,
                      width: `${item.width * 100}%`,
                      height: `${item.height * 100}%`,
                    }}
                  />
                );
              }
              return (
                <div
                  key={item.id}
                  className="absolute pointer-events-none"
                  style={{
                    left: `${item.x * 100}%`,
                    top: `${item.y * 100}%`,
                    width: `${item.width * 100}%`,
                    height: `${item.height * 100}%`,
                    backgroundColor:
                      item.kind === 'redact'
                        ? '#000000'
                        : item.kind === 'whiteout'
                          ? '#ffffff'
                          : item.kind === 'highlight'
                            ? item.color
                            : 'transparent',
                    opacity: item.kind === 'highlight' ? 0.38 : 1,
                    border:
                      item.kind === 'rect'
                        ? `${item.strokeWidth ?? 2}px solid ${item.color ?? '#e11d48'}`
                        : item.kind === 'whiteout'
                          ? '1px dashed #94a3b8'
                          : 'none',
                  }}
                />
              );
            })}

            {/* Live draft box */}
            {draftBox && (
              <div
                className="absolute pointer-events-none border-2 border-rose-500"
                style={{
                  left: `${Math.min(draftBox.x0, draftBox.x1) * 100}%`,
                  top: `${Math.min(draftBox.y0, draftBox.y1) * 100}%`,
                  width: `${Math.abs(draftBox.x1 - draftBox.x0) * 100}%`,
                  height: `${Math.abs(draftBox.y1 - draftBox.y0) * 100}%`,
                  backgroundColor:
                    toolId === 'redact'
                      ? 'rgba(0,0,0,0.75)'
                      : mode === 'highlight'
                        ? 'rgba(250,204,21,0.35)'
                        : mode === 'whiteout'
                          ? 'rgba(255,255,255,0.85)'
                          : 'rgba(225,29,72,0.1)',
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
