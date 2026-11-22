import { FileUp, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';

interface FileDropzoneProps {
  accept: string;
  multiple: boolean;
  label?: string;
  helperText?: string;
  onFilesSelected: (files: File[]) => void;
  onLoadSample?: () => void;
  sampleLabel?: string;
  compact?: boolean;
}

export function FileDropzone({
  accept,
  multiple,
  label = 'Drop files here or browse your device',
  helperText = 'No file size limit · Processed 100% locally in your browser',
  onFilesSelected,
  onLoadSample,
  sampleLabel = 'Try with sample PDF',
  compact = false,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const arr = Array.from(list);
    onFilesSelected(multiple ? arr : [arr[0]]);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={`rounded-xl border border-dashed transition-colors ${
        dragging
          ? 'border-rose-500 bg-rose-50/60 dark:bg-rose-950/20'
          : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131C31]'
      } ${compact ? 'p-4' : 'p-8 sm:p-10'}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => handleFiles(e.target.files)}
        className="sr-only"
        aria-label={label}
      />

      <div className="flex flex-col items-center text-center">
        <div
          className={`rounded-xl bg-slate-100 dark:bg-slate-800 text-rose-600 dark:text-rose-400 flex items-center justify-center ${
            compact ? 'w-9 h-9' : 'w-12 h-12'
          }`}
        >
          <FileUp className={compact ? 'w-4 h-4' : 'w-5 h-5'} />
        </div>

        <p
          className={`font-display font-semibold text-slate-900 dark:text-white ${
            compact ? 'mt-2 text-sm' : 'mt-3.5 text-base'
          }`}
        >
          {label}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-md">{helperText}</p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
          >
            {multiple ? 'Choose Files' : 'Choose File'}
          </button>

          {onLoadSample && (
            <button
              type="button"
              onClick={onLoadSample}
              className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
              <span>{sampleLabel}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
