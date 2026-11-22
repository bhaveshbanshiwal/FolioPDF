import {
  Eraser,
  FileCheck2,
  Highlighter,
  ImagePlus,
  Loader2,
  Pen,
  Replace,
  Search,
  Square,
  TextCursorInput,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  applyCanvasOverlaysToPdf,
  inspectPdfFormFields,
  redactPdf,
} from '../../engine/pdfOperations';
import {
  extractAllPagesEditableTextLines,
  renderSinglePageDataUrl,
  renderSinglePageWithTextLines,
} from '../../engine/pdfRenderer';
import type {
  EditablePdfTextLine,
  OverlayKind,
  PageOverlayItem,
  PdfFontFamilyKey,
  PdfFormFieldSummary,
  ToolResult,
} from '../../types/tools';
import { findMatchingTextLineSlices } from '../../utils/pdfUtils';

interface CanvasOverlayToolProps {
  toolId: 'edit' | 'sign' | 'redact';
  file: File;
  processing: boolean;
  onRunTask: (
    fn: (setProgress: (pct: number, stage?: string) => void) => Promise<ToolResult>,
  ) => Promise<void>;
  onMultiplierChange?: (mult: number) => void;
}

export function CanvasOverlayTool({
  toolId,
  file,
  processing,
  onRunTask,
  onMultiplierChange,
}: CanvasOverlayToolProps) {
  const uid = useId();
  const [pageNumber, setPageNumber] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pageImg, setPageImg] = useState<{ dataUrl: string; width: number; height: number } | null>(
    null,
  );
  const [pageTextLines, setPageTextLines] = useState<EditablePdfTextLine[]>([]);
  const [loadingPage, setLoadingPage] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);

  // Overlays stored in normalized 0..1 coordinates across all pages
  const [overlays, setOverlays] = useState<PageOverlayItem[]>([]);

  // Active mode for Edit / Sign / Redact
  const [mode, setMode] = useState<OverlayKind>(
    toolId === 'redact' ? 'redact' : toolId === 'sign' ? 'image' : 'replace-text',
  );
  const [color, setColor] = useState(toolId === 'edit' ? '#0f172a' : '#0f172a');
  const [fontSize, setFontSize] = useState(14);
  const [strokeWidth, setStrokeWidth] = useState(2.5);
  const [textDraft, setTextDraft] = useState('Approved');
  const [redactDpi, setRedactDpi] = useState(180);

  // Direct Existing Text Editing state (Edit PDF)
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [scrubEditedPages, setScrubEditedPages] = useState(false);

  // Document-wide Find & Replace state (Edit PDF)
  const [findQuery, setFindQuery] = useState('');
  const [replaceValue, setReplaceValue] = useState('');
  const [findBusy, setFindBusy] = useState(false);
  const [findMessage, setFindMessage] = useState<string | null>(null);

  // Document-wide Search & Redact state (Redact PDF)
  const [redactQuery, setRedactQuery] = useState('');
  const [redactSearchBusy, setRedactSearchBusy] = useState(false);
  const [redactSearchMsg, setRedactSearchMsg] = useState<string | null>(null);

  // Native AcroForm fields (Edit PDF)
  const [formFields, setFormFields] = useState<PdfFormFieldSummary[]>([]);
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [formDirty, setFormDirty] = useState(false);
  const [flattenForms, setFlattenForms] = useState(false);

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

  // Reset per-file state
  useEffect(() => {
    setPageNumber(1);
    setOverlays([]);
    setSelectedLineId(null);
    setFindMessage(null);
    setRedactSearchMsg(null);
    setFormDirty(false);
    setFlattenForms(false);
    setMode(toolId === 'redact' ? 'redact' : toolId === 'sign' ? 'image' : 'replace-text');
  }, [file, toolId]);

  // Dynamically report heavy compute/RAM multiplier back to PreflightSign
  useEffect(() => {
    if (toolId === 'redact') {
      onMultiplierChange?.(redactDpi / 180);
    } else if (toolId === 'edit') {
      onMultiplierChange?.(scrubEditedPages ? 1.85 : 1);
    } else {
      onMultiplierChange?.(1);
    }
  }, [toolId, redactDpi, scrubEditedPages, onMultiplierChange]);

  // Inspect AcroForm fields when in Edit PDF
  useEffect(() => {
    if (toolId !== 'edit') {
      setFormFields([]);
      setFormValues({});
      return;
    }
    let active = true;
    inspectPdfFormFields(file)
      .then((fields) => {
        if (!active) return;
        setFormFields(fields);
        const initial: Record<string, string | boolean> = {};
        for (const f of fields) initial[f.name] = f.value;
        setFormValues(initial);
      })
      .catch(() => {
        if (active) setFormFields([]);
      });
    return () => {
      active = false;
    };
  }, [file, toolId]);

  // Render active page preview (and extract clickable text lines for Edit PDF)
  useEffect(() => {
    let active = true;
    setLoadingPage(true);
    setPageError(null);
    setSelectedLineId(null);

    const promise =
      toolId === 'edit'
        ? renderSinglePageWithTextLines(file, pageNumber, 1.35)
        : renderSinglePageDataUrl(file, pageNumber, 1.35).then((res) => ({
            ...res,
            textLines: [] as EditablePdfTextLine[],
          }));

    promise
      .then((res) => {
        if (!active) return;
        setPageImg({ dataUrl: res.dataUrl, width: res.width, height: res.height });
        setTotalPages(res.pageCount);
        setPageTextLines(res.textLines);
        setLoadingPage(false);
      })
      .catch((err) => {
        if (!active) return;
        setPageImg(null);
        setPageTextLines([]);
        setPageError(
          err instanceof Error ? err.message : 'Unable to render this PDF page preview.',
        );
        setLoadingPage(false);
      });

    return () => {
      active = false;
    };
  }, [file, pageNumber, renderNonce, toolId]);

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

  // Map existing replace-text edits by line id (id = `edit-${line.id}`)
  const replaceEditByLineId = useMemo(() => {
    const map = new Map<string, PageOverlayItem>();
    for (const ov of overlays) {
      if (ov.kind === 'replace-text') {
        map.set(ov.id, ov);
      }
    }
    return map;
  }, [overlays]);

  const selectedLine = useMemo(
    () => pageTextLines.find((l) => l.id === selectedLineId) ?? null,
    [pageTextLines, selectedLineId],
  );

  const selectedEditOverlay = useMemo(() => {
    if (!selectedLine) return null;
    return replaceEditByLineId.get(`edit-${selectedLine.id}`) ?? null;
  }, [selectedLine, replaceEditByLineId]);

  const upsertLineEdit = (
    line: EditablePdfTextLine,
    patch: Partial<PageOverlayItem>,
  ) => {
    const editId = `edit-${line.id}`;
    setOverlays((prev) => {
      const idx = prev.findIndex((o) => o.id === editId);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], ...patch };
        return updated;
      }
      return [
        ...prev,
        {
          id: editId,
          pageIndex: line.pageIndex,
          kind: 'replace-text',
          x: line.x,
          y: line.y,
          width: line.width,
          height: line.height,
          text: line.text,
          originalText: line.text,
          fontSize: line.fontSizePt,
          fontFamily: line.fontFamily,
          isBold: line.isBold,
          isItalic: line.isItalic,
          color: '#0f172a',
          bgColor: line.bgColor || '#ffffff',
          ...patch,
        },
      ];
    });
  };

  const removeLineEdit = (lineId: string) => {
    const editId = `edit-${lineId}`;
    setOverlays((prev) => prev.filter((o) => o.id !== editId));
  };

  const handleFindAndReplaceAll = async () => {
    const q = findQuery.trim();
    if (!q) return;
    setFindBusy(true);
    setFindMessage(null);
    try {
      const allLines = await extractAllPagesEditableTextLines(file);
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const currentPageMap = new Map(pageTextLines.map((l) => [l.id, l]));
      const staged: PageOverlayItem[] = [];
      let replacementCount = 0;

      for (const line of allLines) {
        if (!line.text.toLowerCase().includes(q.toLowerCase())) continue;
        const nextText = line.text.replace(regex, replaceValue);
        if (nextText === line.text) continue;
        replacementCount++;
        const sampledLine = currentPageMap.get(line.id);
        staged.push({
          id: `edit-${line.id}`,
          pageIndex: line.pageIndex,
          kind: 'replace-text',
          x: line.x,
          y: line.y,
          width: line.width,
          height: line.height,
          text: nextText,
          originalText: line.text,
          fontSize: line.fontSizePt,
          fontFamily: line.fontFamily,
          isBold: line.isBold,
          isItalic: line.isItalic,
          color: '#0f172a',
          bgColor: sampledLine?.bgColor ?? '#ffffff',
        });
      }

      if (staged.length === 0) {
        setFindMessage(`No occurrences of "${q}" found in document text.`);
      } else {
        setOverlays((prev) => {
          const nextMap = new Map(prev.map((o) => [o.id, o]));
          for (const item of staged) nextMap.set(item.id, item);
          return Array.from(nextMap.values());
        });
        setFindMessage(
          `Staged ${replacementCount} line replacement(s) across the document. Click "Save Edited PDF" to compile.`,
        );
      }
    } catch (err) {
      setFindMessage(err instanceof Error ? err.message : 'Unable to scan PDF text.');
    } finally {
      setFindBusy(false);
    }
  };

  const handleSearchAndRedactAll = async () => {
    const q = redactQuery.trim();
    if (!q) return;
    setRedactSearchBusy(true);
    setRedactSearchMsg(null);
    try {
      const allLines = await extractAllPagesEditableTextLines(file);
      const matches = findMatchingTextLineSlices(allLines, q, false);
      if (matches.length === 0) {
        setRedactSearchMsg(`No matches for "${q}" found in selectable PDF text.`);
      } else {
        const newBoxes: PageOverlayItem[] = matches.map((m, idx) => ({
          id: `redact-search-${Date.now()}-${idx}`,
          pageIndex: m.line.pageIndex,
          kind: 'redact',
          x: m.x,
          y: Math.max(0, m.y - m.height * 0.12),
          width: m.width,
          height: Math.min(1 - m.y, m.height * 1.28),
          color: '#000000',
          opacity: 1,
        }));
        setOverlays((prev) => [...prev, ...newBoxes]);
        const uniquePages = new Set(matches.map((m) => m.line.pageIndex + 1)).size;
        setRedactSearchMsg(
          `Marked ${newBoxes.length} match(es) across ${uniquePages} page(s). Click "Apply Permanent Redactions" to burn in.`,
        );
      }
    } catch (err) {
      setRedactSearchMsg(err instanceof Error ? err.message : 'Unable to scan PDF text.');
    } finally {
      setRedactSearchBusy(false);
    }
  };

  const getNormalizedPoint = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // In Edit Existing Text mode, clicks are handled by the interactive text line buttons
    if (toolId === 'edit' && mode === 'replace-text') {
      return;
    }

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
  const canExport =
    toolId === 'edit'
      ? overlays.length > 0 || formDirty || flattenForms
      : overlays.length > 0;

  const handleExport = () => {
    if (toolId === 'redact') {
      void onRunTask((setProgress) => redactPdf(file, overlays, redactDpi, setProgress));
    } else if (toolId === 'edit') {
      void onRunTask((setProgress) =>
        applyCanvasOverlaysToPdf(file, overlays, 'edited', setProgress, {
          scrubEditedPages,
          scrubDpi: 200,
          formUpdates: formDirty ? formValues : undefined,
          flattenForms,
        }),
      );
    } else {
      void onRunTask((setProgress) =>
        applyCanvasOverlaysToPdf(file, overlays, 'signed', setProgress),
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
                PDF Editing Tool
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setMode('replace-text')}
                  className={`col-span-2 h-9 px-3 rounded-lg border text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                    mode === 'replace-text'
                      ? 'bg-rose-600 text-white border-rose-600'
                      : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  <TextCursorInput className="w-3.5 h-3.5" />
                  <span>Edit Existing Text ({pageTextLines.length} lines on page)</span>
                </button>

                {(
                  [
                    ['text', 'Add Text', Type],
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

            {mode === 'replace-text' && (
              <div className="space-y-3 pt-1">
                {selectedLine ? (
                  <div className="rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/40 dark:bg-rose-950/20 p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                        Editing Selected Line
                      </span>
                      {selectedEditOverlay && (
                        <button
                          type="button"
                          onClick={() => removeLineEdit(selectedLine.id)}
                          className="text-[11px] text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                        >
                          Revert original
                        </button>
                      )}
                    </div>

                    <textarea
                      aria-label="Edited PDF line text"
                      rows={2}
                      value={selectedEditOverlay?.text ?? selectedLine.text}
                      onChange={(e) => upsertLineEdit(selectedLine, { text: e.target.value })}
                      placeholder="Leave blank to erase this line cleanly"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-rose-500/40"
                    />

                    <div className="grid grid-cols-3 gap-1.5 text-xs">
                      <select
                        aria-label="Font family"
                        value={selectedEditOverlay?.fontFamily ?? selectedLine.fontFamily}
                        onChange={(e) =>
                          upsertLineEdit(selectedLine, {
                            fontFamily: e.target.value as PdfFontFamilyKey,
                          })
                        }
                        className="h-8 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                      >
                        <option value="sans">Sans</option>
                        <option value="serif">Serif</option>
                        <option value="mono">Mono</option>
                      </select>

                      <button
                        type="button"
                        onClick={() =>
                          upsertLineEdit(selectedLine, {
                            isBold: !(selectedEditOverlay?.isBold ?? selectedLine.isBold),
                          })
                        }
                        className={`h-8 rounded border text-xs font-bold cursor-pointer ${
                          selectedEditOverlay?.isBold ?? selectedLine.isBold
                            ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-slate-900 dark:border-white'
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                        }`}
                      >
                        B
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          upsertLineEdit(selectedLine, {
                            isItalic: !(selectedEditOverlay?.isItalic ?? selectedLine.isItalic),
                          })
                        }
                        className={`h-8 rounded border text-xs italic cursor-pointer ${
                          selectedEditOverlay?.isItalic ?? selectedLine.isItalic
                            ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-slate-900 dark:border-white'
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                        }`}
                      >
                        I
                      </button>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      <span className="shrink-0 text-slate-600 dark:text-slate-300 font-mono tabular-nums">
                        {Math.round(selectedEditOverlay?.fontSize ?? selectedLine.fontSizePt)}pt
                      </span>
                      <input
                        aria-label="Line font size"
                        type="range"
                        min={6}
                        max={44}
                        value={Math.round(selectedEditOverlay?.fontSize ?? selectedLine.fontSizePt)}
                        onChange={(e) =>
                          upsertLineEdit(selectedLine, { fontSize: Number(e.target.value) })
                        }
                        className="flex-1 accent-rose-600"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2 text-xs">
                      <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                        <span>Ink</span>
                        <input
                          type="color"
                          value={selectedEditOverlay?.color ?? '#0f172a'}
                          onChange={(e) => upsertLineEdit(selectedLine, { color: e.target.value })}
                          className="w-6 h-6 rounded cursor-pointer bg-transparent"
                        />
                      </label>
                      <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                        <span>Cover BG</span>
                        <input
                          type="color"
                          value={selectedEditOverlay?.bgColor ?? selectedLine.bgColor ?? '#ffffff'}
                          onChange={(e) => upsertLineEdit(selectedLine, { bgColor: e.target.value })}
                          className="w-6 h-6 rounded cursor-pointer bg-transparent"
                        />
                      </label>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Click any highlighted text line on the PDF page to edit or erase it in place.
                    Background cover and font style are matched automatically.
                  </p>
                )}

                {/* Document-wide Find & Replace */}
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                    <Replace className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
                    <span>Find & Replace Across All Pages</span>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5">
                    <input
                      type="text"
                      value={findQuery}
                      onChange={(e) => setFindQuery(e.target.value)}
                      placeholder="Find text (e.g. 2025 or Draft)"
                      className="h-8 px-2.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs"
                    />
                    <input
                      type="text"
                      value={replaceValue}
                      onChange={(e) => setReplaceValue(e.target.value)}
                      placeholder="Replace with…"
                      className="h-8 px-2.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={findBusy || !findQuery.trim()}
                    onClick={() => void handleFindAndReplaceAll()}
                    className="w-full h-8 rounded-md bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 text-white dark:text-slate-900 text-xs font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {findBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>Replace All Matches</span>
                  </button>
                  {findMessage && (
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-snug">
                      {findMessage}
                    </p>
                  )}
                </div>

                {/* Deep Scrub Rebuild Toggle */}
                <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={scrubEditedPages}
                    onChange={(e) => setScrubEditedPages(e.target.checked)}
                    className="mt-0.5 accent-rose-600"
                  />
                  <span>
                    <strong className="text-slate-800 dark:text-slate-100">
                      Deep Scrub Old Text Layer (200 DPI)
                    </strong>
                    <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                      Permanently erases replaced original text from edited pages so Ctrl+F cannot
                      find old words (slower compile & higher RAM; untouched pages stay vector).
                    </span>
                  </span>
                </label>
              </div>
            )}

            {mode === 'text' && (
              <div className="space-y-2">
                <label
                  htmlFor={`${uid}-edit-text-input`}
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Text to place (click page to stamp)
                </label>
                <input
                  id={`${uid}-edit-text-input`}
                  type="text"
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                />
                <div className="flex items-center gap-3 text-xs">
                  <label htmlFor={`${uid}-edit-font-size`}>Size ({fontSize}pt)</label>
                  <input
                    id={`${uid}-edit-font-size`}
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

            {mode !== 'replace-text' && (
              <div className="flex items-center justify-between gap-3 pt-1">
                <label
                  htmlFor={`${uid}-edit-color-picker`}
                  className="text-xs font-medium text-slate-700 dark:text-slate-300"
                >
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
                    id={`${uid}-edit-color-picker`}
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer bg-transparent"
                  />
                </div>
              </div>
            )}

            {(mode === 'freehand' || mode === 'rect') && (
              <div className="flex items-center gap-3 text-xs">
                <label htmlFor={`${uid}-edit-stroke`}>Stroke ({strokeWidth}px)</label>
                <input
                  id={`${uid}-edit-stroke`}
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

            {/* Auto-detected AcroForm Fields Panel */}
            {formFields.length > 0 && (
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                    <FileCheck2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    Fillable Form Fields ({formFields.length})
                  </span>
                </div>
                <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
                  {formFields.map((field) => (
                    <div key={field.name} className="space-y-1">
                      {field.kind === 'checkbox' ? (
                        <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer">
                          <input
                            type="checkbox"
                            disabled={field.readOnly}
                            checked={Boolean(formValues[field.name])}
                            onChange={(e) => {
                              setFormValues((prev) => ({ ...prev, [field.name]: e.target.checked }));
                              setFormDirty(true);
                            }}
                            className="accent-rose-600"
                          />
                          <span className="truncate">{field.name}</span>
                        </label>
                      ) : field.kind === 'dropdown' || field.kind === 'radio' || field.kind === 'option-list' ? (
                        <>
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 truncate">
                            {field.name}
                          </label>
                          <select
                            disabled={field.readOnly}
                            value={String(formValues[field.name] ?? '')}
                            onChange={(e) => {
                              setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }));
                              setFormDirty(true);
                            }}
                            className="w-full h-8 px-2 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs"
                          >
                            <option value="">Select…</option>
                            {(field.options ?? []).map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <>
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 truncate">
                            {field.name}
                          </label>
                          <input
                            type="text"
                            disabled={field.readOnly}
                            value={String(formValues[field.name] ?? '')}
                            onChange={(e) => {
                              setFormValues((prev) => ({ ...prev, [field.name]: e.target.value }));
                              setFormDirty(true);
                            }}
                            className="w-full h-8 px-2.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs"
                          />
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={flattenForms}
                    onChange={(e) => setFlattenForms(e.target.checked)}
                    className="accent-rose-600"
                  />
                  <span>Flatten form fields into static PDF on save</span>
                </label>
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
                  <span className="text-slate-500 dark:text-slate-400">
                    Draw above, then click on the PDF page
                  </span>
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
                <label
                  htmlFor={`${uid}-typed-sig-input`}
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Type your signature
                </label>
                <input
                  id={`${uid}-typed-sig-input`}
                  type="text"
                  value={typedSig}
                  onChange={(e) => setTypedSig(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                />
                {sigDataUrl && (
                  <div className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white">
                    <img
                      src={sigDataUrl}
                      alt="Typed signature preview"
                      className="h-12 mx-auto object-contain"
                    />
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
                  <img
                    src={sigDataUrl}
                    alt="Uploaded signature"
                    className="h-14 object-contain bg-white p-1 rounded border"
                  />
                )}
              </div>
            )}

            <div className="flex items-center gap-3 text-xs">
              <label htmlFor={`${uid}-sig-size`}>Placement Size</label>
              <input
                id={`${uid}-sig-size`}
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
          <div className="space-y-3.5">
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              Click and drag on the PDF page to draw solid black redaction boxes, or search any
              word/phrase to mark all occurrences across every page automatically.
            </p>

            {/* Search & Redact across entire PDF */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 p-3 space-y-2">
              <label
                htmlFor={`${uid}-redact-search`}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200"
              >
                <Search className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
                <span>Search & Redact All Pages</span>
              </label>
              <div className="flex gap-1.5">
                <input
                  id={`${uid}-redact-search`}
                  type="text"
                  value={redactQuery}
                  onChange={(e) => setRedactQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && redactQuery.trim() && !redactSearchBusy) {
                      e.preventDefault();
                      void handleSearchAndRedactAll();
                    }
                  }}
                  placeholder="Word, email, SSN, or phrase…"
                  className="flex-1 h-8 px-2.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs"
                />
                <button
                  type="button"
                  disabled={redactSearchBusy || !redactQuery.trim()}
                  onClick={() => void handleSearchAndRedactAll()}
                  className="h-8 px-3 rounded-md bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 text-white dark:text-slate-900 text-xs font-medium inline-flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  {redactSearchBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                  <span>Mark All</span>
                </button>
              </div>
              {redactSearchMsg && (
                <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-snug">
                  {redactSearchMsg}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor={`${uid}-redact-dpi`}
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Burn-in raster resolution (DPI)
              </label>
              <select
                id={`${uid}-redact-dpi`}
                value={redactDpi}
                onChange={(e) => setRedactDpi(Number(e.target.value))}
                className="mt-1 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs"
              >
                <option value={150}>150 DPI (Balanced)</option>
                <option value={180}>180 DPI (Recommended)</option>
                <option value={240}>240 DPI (High clarity)</option>
                <option value={300}>300 DPI (Archival — Heavy RAM)</option>
              </select>
            </div>
          </div>
        )}

        {/* Placed items list & Undo */}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300 font-mono tabular-nums">
              {overlays.length} edit{overlays.length === 1 ? '' : 's'} staged
              {formDirty ? ' + form' : ''}
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
                onClick={() => {
                  setOverlays([]);
                  setSelectedLineId(null);
                }}
                className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 hover:underline disabled:opacity-35 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" /> Clear
              </button>
            </div>
          </div>

          <button
            type="button"
            disabled={processing || !canExport}
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
                ? 'Drag on page to draw redaction box or use Search & Redact'
                : mode === 'replace-text'
                  ? 'Click any highlighted text line on the page to edit it in place'
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

        {loadingPage ? (
          <div className="w-full max-w-lg aspect-[3/4] rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
            Rendering page {pageNumber}…
          </div>
        ) : pageError || !pageImg ? (
          <div
            role="alert"
            className="w-full max-w-lg rounded-xl border border-red-200 dark:border-red-900 bg-red-50/90 dark:bg-red-950/30 p-5 text-center space-y-3"
          >
            <p className="text-sm font-display font-semibold text-red-800 dark:text-red-200">
              Could not load PDF page preview
            </p>
            <p className="text-xs text-red-700 dark:text-red-300 break-words leading-relaxed">
              {pageError ??
                'The file may be encrypted, corrupted, or the PDF worker failed to load.'}
            </p>
            <button
              type="button"
              onClick={() => setRenderNonce((n) => n + 1)}
              className="h-8 px-3.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium cursor-pointer"
            >
              Retry Preview
            </button>
          </div>
        ) : (
          <div
            ref={stageRef}
            data-testid="interactive-pdf-stage"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className={`relative inline-block max-w-full border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden bg-white select-none touch-none shadow-xs ${
              toolId === 'edit' && mode === 'replace-text' ? 'cursor-default' : 'cursor-crosshair'
            }`}
          >
            <img
              src={pageImg.dataUrl}
              alt={`PDF Page ${pageNumber}`}
              draggable={false}
              className="max-h-[640px] w-auto block pointer-events-none"
            />

            {/* Rendered freehand SVG overlays on current page */}
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

            {/* Rendered non-freehand overlays (including replace-text live previews) */}
            {currentPageOverlays.map((item) => {
              if (item.kind === 'freehand') return null;
              if (item.kind === 'replace-text') {
                const fontClass =
                  item.fontFamily === 'serif'
                    ? 'font-serif'
                    : item.fontFamily === 'mono'
                      ? 'font-mono'
                      : 'font-sans';
                return (
                  <div
                    key={item.id}
                    className={`absolute pointer-events-none whitespace-pre leading-none flex items-center ${fontClass} ${
                      item.isBold ? 'font-bold' : ''
                    } ${item.isItalic ? 'italic' : ''}`}
                    style={{
                      left: `${Math.max(0, item.x - 0.004) * 100}%`,
                      top: `${Math.max(0, item.y - item.height * 0.12) * 100}%`,
                      minWidth: `${Math.min(1 - item.x, item.width * 1.04 + 0.014) * 100}%`,
                      minHeight: `${item.height * 1.3 * 100}%`,
                      backgroundColor: item.bgColor ?? '#ffffff',
                      color: item.color ?? '#0f172a',
                      fontSize: `${Math.max(8, (item.fontSize ?? 11) * 0.78)}px`,
                      paddingLeft: '2px',
                      paddingRight: '4px',
                    }}
                  >
                    {item.text}
                  </div>
                );
              }
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

            {/* Interactive Click-to-Edit Existing Text Hitboxes (Edit PDF in replace-text mode) */}
            {toolId === 'edit' &&
              mode === 'replace-text' &&
              pageTextLines.map((line) => {
                const isSelected = selectedLineId === line.id;
                const isEdited = replaceEditByLineId.has(`edit-${line.id}`);
                return (
                  <button
                    key={line.id}
                    type="button"
                    data-testid="editable-pdf-text-line"
                    title={`Click to edit: "${line.text}"`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedLineId(line.id);
                    }}
                    className={`absolute rounded-[2px] transition-colors cursor-text focus:outline-none ${
                      isSelected
                        ? 'ring-2 ring-rose-600 bg-rose-500/10'
                        : isEdited
                          ? 'ring-1 ring-emerald-500/80 hover:ring-rose-500'
                          : 'border border-dashed border-sky-500/35 hover:border-rose-500 hover:bg-rose-500/10'
                    }`}
                    style={{
                      left: `${Math.max(0, line.x - 0.003) * 100}%`,
                      top: `${Math.max(0, line.y - line.height * 0.08) * 100}%`,
                      width: `${Math.min(1, line.width + 0.006) * 100}%`,
                      height: `${Math.min(0.25, line.height * 1.2) * 100}%`,
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
