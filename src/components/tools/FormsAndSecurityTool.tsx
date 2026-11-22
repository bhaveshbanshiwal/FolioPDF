import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import {
  addPageNumbersToPdf,
  addWatermarkToPdf,
  compressPdf,
  protectPdf,
  unlockPdf,
  webOptimizePdf,
} from '../../engine/pdfOperations';
import type { ToolResult } from '../../types/tools';

interface FormsAndSecurityToolProps {
  toolId: 'compress' | 'protect' | 'unlock' | 'watermark' | 'page-numbers' | 'web-optimize';
  file: File;
  processing: boolean;
  onRunTask: (fn: (setProgress: (pct: number) => void) => Promise<ToolResult>) => Promise<void>;
  onMultiplierChange?: (mult: number) => void;
}

export function FormsAndSecurityTool({
  toolId,
  file,
  processing,
  onRunTask,
  onMultiplierChange,
}: FormsAndSecurityToolProps) {
  const uid = useId();
  // Compress state
  const [compressMode, setCompressMode] = useState<'structural' | 'hybrid-images' | 'raster'>('hybrid-images');
  const [compressDpi, setCompressDpi] = useState(110);
  const [jpegQuality, setJpegQuality] = useState(0.68);

  // Protect state
  const [userPassword, setUserPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [allowPrinting, setAllowPrinting] = useState(true);
  const [allowCopying, setAllowCopying] = useState(false);
  const [allowModifying, setAllowModifying] = useState(false);

  // Unlock state
  const [unlockPassword, setUnlockPassword] = useState('');

  // Watermark state
  const [wmKind, setWmKind] = useState<'text' | 'image'>('text');
  const [wmText, setWmText] = useState('CONFIDENTIAL');
  const [wmImage, setWmImage] = useState<File | null>(null);
  const [wmFontSize, setWmFontSize] = useState(40);
  const [wmOpacity, setWmOpacity] = useState(0.28);
  const [wmRotation, setWmRotation] = useState(35);
  const [wmColor, setWmColor] = useState('#e11d48');
  const [wmPosition, setWmPosition] = useState<
    'center' | 'tiled' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  >('center');
  const [wmRange, setWmRange] = useState('');

  // Page numbers state
  const [pnFormat, setPnFormat] = useState<'number' | 'x-of-y' | 'slash'>('x-of-y');
  const [pnPosition, setPnPosition] = useState<
    'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left'
  >('bottom-center');
  const [pnStart, setPnStart] = useState(1);
  const [pnSize, setPnSize] = useState(11);
  const [pnMargin, setPnMargin] = useState(28);

  // Web optimize state
  const [stripMeta, setStripMeta] = useState(true);

  useEffect(() => {
    if (toolId === 'compress') {
      if (compressMode === 'raster') {
        onMultiplierChange?.((compressDpi / 110) * 1.2);
      } else if (compressMode === 'hybrid-images') {
        onMultiplierChange?.((compressDpi / 110) * 0.85);
      } else {
        onMultiplierChange?.(0.45);
      }
    } else {
      onMultiplierChange?.(1);
    }
  }, [toolId, compressMode, compressDpi, onMultiplierChange]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (toolId === 'compress') {
      void onRunTask((setProgress) =>
        compressPdf(file, compressMode, compressDpi, jpegQuality, setProgress),
      );
    } else if (toolId === 'protect') {
      void onRunTask(() =>
        protectPdf(file, {
          userPassword,
          ownerPassword,
          allowPrinting,
          allowCopying,
          allowModifying,
        }),
      );
    } else if (toolId === 'unlock') {
      void onRunTask(() => unlockPdf(file, unlockPassword));
    } else if (toolId === 'watermark') {
      void onRunTask(() =>
        addWatermarkToPdf(file, {
          kind: wmKind,
          text: wmText,
          imageFile: wmImage,
          fontSize: wmFontSize,
          opacity: wmOpacity,
          rotation: wmRotation,
          color: wmColor,
          position: wmPosition,
          pageRange: wmRange,
        }),
      );
    } else if (toolId === 'page-numbers') {
      void onRunTask(() =>
        addPageNumbersToPdf(file, {
          format: pnFormat,
          position: pnPosition,
          startNumber: pnStart,
          fontSize: pnSize,
          marginPt: pnMargin,
        }),
      );
    } else if (toolId === 'web-optimize') {
      void onRunTask(() => webOptimizePdf(file, stripMeta));
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 p-5 space-y-5"
    >
      {toolId === 'compress' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => setCompressMode('structural')}
              className={`p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                compressMode === 'structural'
                  ? 'border-rose-500 bg-rose-50/50 dark:bg-rose-950/20'
                  : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
              }`}
            >
              <p className="font-display font-semibold text-sm text-slate-900 dark:text-white">
                Lossless Cleanup
              </p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Fastest. Compacts object streams and strips metadata while leaving every image and vector untouched.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setCompressMode('hybrid-images')}
              className={`p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                compressMode === 'hybrid-images'
                  ? 'border-rose-500 bg-rose-50/50 dark:bg-rose-950/20'
                  : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
              }`}
            >
              <p className="font-display font-semibold text-sm text-slate-900 dark:text-white">
                Smart Hybrid (Keeps Text)
              </p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Re-encodes oversized embedded photos in place while preserving 100% crisp selectable vector text and links.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setCompressMode('raster')}
              className={`p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                compressMode === 'raster'
                  ? 'border-rose-500 bg-rose-50/50 dark:bg-rose-950/20'
                  : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
              }`}
            >
              <p className="font-display font-semibold text-sm text-slate-900 dark:text-white">
                Strong Full-Page DPI
              </p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Maximum shrinkage for scanned PDFs. Re-renders entire pages as JPEGs (higher RAM; text becomes image).
              </p>
            </button>
          </div>

          {(compressMode === 'hybrid-images' || compressMode === 'raster') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div>
                <label htmlFor={`${uid}-compress-dpi`} className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {compressMode === 'hybrid-images'
                    ? 'Embedded Image Cap (Target DPI)'
                    : 'Target Page Resolution (DPI)'}
                </label>
                <select
                  id={`${uid}-compress-dpi`}
                  value={compressDpi}
                  onChange={(e) => setCompressDpi(Number(e.target.value))}
                  className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                >
                  <option value={72}>72 DPI (Smallest size — screen only)</option>
                  <option value={110}>110 DPI (Balanced — recommended)</option>
                  <option value={150}>150 DPI (High clarity)</option>
                  {compressMode === 'raster' && (
                    <option value={220}>220 DPI (Print grade — heavy RAM)</option>
                  )}
                </select>
              </div>
              <div>
                <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                  <label htmlFor={`${uid}-compress-quality`}>JPEG Quality</label>
                  <span className="font-mono tabular-nums">{Math.round(jpegQuality * 100)}%</span>
                </div>
                <input
                  id={`${uid}-compress-quality`}
                  type="range"
                  min={25}
                  max={92}
                  value={Math.round(jpegQuality * 100)}
                  onChange={(e) => setJpegQuality(Number(e.target.value) / 100)}
                  className="w-full mt-3 accent-rose-600"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {toolId === 'protect' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${uid}-protect-user-pw`} className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Open Password (required to view PDF)
              </label>
              <div className="relative mt-1.5">
                <input
                  id={`${uid}-protect-user-pw`}
                  type={showPasswords ? 'text' : 'password'}
                  value={userPassword}
                  onChange={(e) => setUserPassword(e.target.value)}
                  placeholder="Enter strong password"
                  className="w-full h-9 pl-3 pr-9 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords((v) => !v)}
                  aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  {showPasswords ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor={`${uid}-protect-owner-pw`} className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Owner Password (optional permissions key)
              </label>
              <input
                id={`${uid}-protect-owner-pw`}
                type={showPasswords ? 'text' : 'password'}
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                placeholder="Defaults to Open Password"
                className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-5 pt-1 text-xs text-slate-700 dark:text-slate-300">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowPrinting}
                onChange={(e) => setAllowPrinting(e.target.checked)}
                className="rounded border-slate-300 text-rose-600"
              />
              Allow printing
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowCopying}
                onChange={(e) => setAllowCopying(e.target.checked)}
                className="rounded border-slate-300 text-rose-600"
              />
              Allow copying text & graphics
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowModifying}
                onChange={(e) => setAllowModifying(e.target.checked)}
                className="rounded border-slate-300 text-rose-600"
              />
              Allow editing & annotations
            </label>
          </div>
        </div>
      )}

      {toolId === 'unlock' && (
        <div className="max-w-md space-y-2">
          <label htmlFor={`${uid}-unlock-pw`} className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            PDF Password (leave blank to strip owner-only print/copy locks)
          </label>
          <div className="relative">
            <input
              id={`${uid}-unlock-pw`}
              type={showPasswords ? 'text' : 'password'}
              value={unlockPassword}
              onChange={(e) => setUnlockPassword(e.target.value)}
              placeholder="Enter known password"
              className="w-full h-10 pl-3 pr-10 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
            />
            <button
              type="button"
              onClick={() => setShowPasswords((v) => !v)}
              aria-label={showPasswords ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
            >
              {showPasswords ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}

      {toolId === 'watermark' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            {(['text', 'image'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setWmKind(k)}
                className={`px-3.5 py-1.5 rounded-lg border text-xs font-medium capitalize cursor-pointer ${
                  wmKind === k
                    ? 'bg-rose-600 text-white border-rose-600'
                    : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700'
                }`}
              >
                {k} Watermark
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {wmKind === 'text' ? (
              <>
                <div>
                  <label htmlFor="wm-text" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Watermark Text
                  </label>
                  <input
                    id="wm-text"
                    type="text"
                    value={wmText}
                    onChange={(e) => setWmText(e.target.value)}
                    className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                    <label htmlFor="wm-size">Font Size</label>
                    <span className="font-mono tabular-nums">{wmFontSize} pt</span>
                  </div>
                  <input
                    id="wm-size"
                    type="range"
                    min={14}
                    max={96}
                    value={wmFontSize}
                    onChange={(e) => setWmFontSize(Number(e.target.value))}
                    className="w-full mt-3 accent-rose-600"
                  />
                </div>
                <div>
                  <label htmlFor="wm-color" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Color
                  </label>
                  <input
                    id="wm-color"
                    type="color"
                    value={wmColor}
                    onChange={(e) => setWmColor(e.target.value)}
                    className="mt-1.5 h-9 w-20 rounded border border-slate-200 dark:border-slate-700 cursor-pointer"
                  />
                </div>
              </>
            ) : (
              <div className="sm:col-span-2">
                <label htmlFor="wm-image" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Watermark Logo Image (PNG / JPG / WebP)
                </label>
                <input
                  id="wm-image"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => setWmImage(e.target.files?.[0] ?? null)}
                  className="mt-1.5 block w-full text-xs text-slate-600 dark:text-slate-300"
                />
              </div>
            )}

            <div>
              <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                <label htmlFor="wm-opacity">Opacity</label>
                <span className="font-mono tabular-nums">{Math.round(wmOpacity * 100)}%</span>
              </div>
              <input
                id="wm-opacity"
                type="range"
                min={5}
                max={100}
                value={Math.round(wmOpacity * 100)}
                onChange={(e) => setWmOpacity(Number(e.target.value) / 100)}
                className="w-full mt-3 accent-rose-600"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                <label htmlFor="wm-rot">Rotation</label>
                <span className="font-mono tabular-nums">{wmRotation}°</span>
              </div>
              <input
                id="wm-rot"
                type="range"
                min={-90}
                max={90}
                value={wmRotation}
                onChange={(e) => setWmRotation(Number(e.target.value))}
                className="w-full mt-3 accent-rose-600"
              />
            </div>

            <div>
              <label htmlFor="wm-pos" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Placement
              </label>
              <select
                id="wm-pos"
                value={wmPosition}
                onChange={(e) => setWmPosition(e.target.value as typeof wmPosition)}
                className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
              >
                <option value="center">Center</option>
                <option value="tiled">Tiled Diagonal Grid</option>
                <option value="top-left">Top Left</option>
                <option value="top-right">Top Right</option>
                <option value="bottom-left">Bottom Left</option>
                <option value="bottom-right">Bottom Right</option>
              </select>
            </div>

            <div>
              <label htmlFor="wm-range" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Page Range (blank = all pages)
              </label>
              <input
                id="wm-range"
                type="text"
                value={wmRange}
                onChange={(e) => setWmRange(e.target.value)}
                placeholder="e.g. 1-3, 5"
                className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm font-mono"
              />
            </div>
          </div>
        </div>
      )}

      {toolId === 'page-numbers' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label htmlFor="pn-format" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Number Format
            </label>
            <select
              id="pn-format"
              value={pnFormat}
              onChange={(e) => setPnFormat(e.target.value as typeof pnFormat)}
              className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
            >
              <option value="x-of-y">Page 1 of 10</option>
              <option value="slash">1 / 10</option>
              <option value="number">1</option>
            </select>
          </div>

          <div>
            <label htmlFor="pn-pos" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Position
            </label>
            <select
              id="pn-pos"
              value={pnPosition}
              onChange={(e) => setPnPosition(e.target.value as typeof pnPosition)}
              className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
            >
              <option value="bottom-center">Bottom Center</option>
              <option value="bottom-right">Bottom Right</option>
              <option value="bottom-left">Bottom Left</option>
              <option value="top-center">Top Center</option>
              <option value="top-right">Top Right</option>
              <option value="top-left">Top Left</option>
            </select>
          </div>

          <div>
            <label htmlFor="pn-start" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Starting Number
            </label>
            <input
              id="pn-start"
              type="number"
              min={1}
              value={pnStart}
              onChange={(e) => setPnStart(Math.max(1, Number(e.target.value) || 1))}
              className="mt-1.5 w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm font-mono tabular-nums"
            />
          </div>

          <div>
            <label htmlFor="pn-size" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Font Size ({pnSize} pt)
            </label>
            <input
              id="pn-size"
              type="range"
              min={8}
              max={20}
              value={pnSize}
              onChange={(e) => setPnSize(Number(e.target.value))}
              className="w-full mt-3 accent-rose-600"
            />
          </div>

          <div>
            <label htmlFor="pn-margin" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Edge Margin ({pnMargin} pt)
            </label>
            <input
              id="pn-margin"
              type="range"
              min={14}
              max={64}
              value={pnMargin}
              onChange={(e) => setPnMargin(Number(e.target.value))}
              className="w-full mt-3 accent-rose-600"
            />
          </div>
        </div>
      )}

      {toolId === 'web-optimize' && (
        <div className="space-y-2">
          <label className="inline-flex items-center gap-2.5 text-sm text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={stripMeta}
              onChange={(e) => setStripMeta(e.target.checked)}
              className="rounded border-slate-300 text-rose-600"
            />
            Strip author, creator, and document metadata fields to reduce overhead
          </label>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Rebuilds cross-reference tables with compressed object streams for cleaner web delivery.
          </p>
        </div>
      )}

      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
        <button
          type="submit"
          disabled={processing}
          className="h-10 px-5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors cursor-pointer"
        >
          {processing && <Loader2 className="w-4 h-4 animate-spin" />}
          <span>
            {toolId === 'compress'
              ? 'Compress PDF'
              : toolId === 'protect'
                ? 'Encrypt & Protect PDF'
                : toolId === 'unlock'
                  ? 'Unlock PDF'
                  : toolId === 'watermark'
                    ? 'Apply Watermark'
                    : toolId === 'page-numbers'
                      ? 'Add Page Numbers'
                      : 'Optimize PDF for Web'}
          </span>
        </button>
      </div>
    </form>
  );
}
