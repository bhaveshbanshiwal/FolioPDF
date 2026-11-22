import { AlertTriangle, Cpu, FileWarning, ShieldAlert } from 'lucide-react';
import type { PreflightAssessment } from '../types/tools';
import { formatBytes } from '../utils/pdfUtils';

interface PreflightSignProps {
  assessment: PreflightAssessment | null;
}

/**
 * Displays a clear, non-blocking warning sign when a file looks unprocessable
 * or risks crashing this specific device's browser tab due to RAM pressure.
 * Never enforces a hard file size cap.
 */
export function PreflightSign({ assessment }: PreflightSignProps) {
  if (!assessment || assessment.level === 'ok' || assessment.issues.length === 0) {
    return null;
  }

  const isCritical =
    assessment.level === 'unprocessable' || assessment.level === 'high-risk';

  const containerClasses = isCritical
    ? 'bg-red-50/90 dark:bg-red-950/30 border-red-200 dark:border-red-900/70 text-red-950 dark:text-red-100'
    : 'bg-amber-50/90 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/70 text-amber-950 dark:text-amber-100';

  const headingLabel =
    assessment.level === 'unprocessable'
      ? 'File Compatibility Sign — May Fail to Process'
      : assessment.level === 'high-risk'
        ? 'Device Crash Risk Sign — Heavy Memory Load'
        : 'Device Performance Advisory';

  return (
    <div
      role="alert"
      data-testid="preflight-warning-sign"
      className={`rounded-xl border p-4 text-sm ${containerClasses}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {assessment.level === 'unprocessable' ? (
            <FileWarning className="w-5 h-5 text-red-600 dark:text-red-400" />
          ) : assessment.level === 'high-risk' ? (
            <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display font-semibold text-sm">{headingLabel}</h3>
            <span className="font-mono tabular-nums text-[11px] opacity-80 inline-flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5" />
              {assessment.deviceSummary}
            </span>
          </div>

          <ul className="mt-2 space-y-2">
            {assessment.issues.map((issue) => (
              <li key={issue.id} className="text-xs leading-relaxed">
                <span className="font-semibold">{issue.title}:</span> {issue.detail}
                {issue.actionHint && (
                  <span className="block mt-0.5 opacity-85">Tip: {issue.actionHint}</span>
                )}
              </li>
            ))}
          </ul>

          {assessment.tips.length > 0 && (
            <div className="mt-2 pt-2 border-t border-current/10 text-xs opacity-90 space-y-0.5">
              {assessment.tips.map((tip, i) => (
                <p key={i}>· {tip}</p>
              ))}
            </div>
          )}

          <p className="mt-2.5 text-[11px] font-medium opacity-80">
            No upload cap is enforced ({formatBytes(assessment.totalInputBytes)} loaded · est. peak{' '}
            <span className="font-mono tabular-nums">
              {formatBytes(assessment.estimatedPeakBytes)}
            </span>
            ). Controls remain unlocked so you can still run this task if you choose.
          </p>
        </div>
      </div>
    </div>
  );
}
