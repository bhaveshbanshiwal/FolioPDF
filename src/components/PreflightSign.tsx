import { AlertTriangle, Cpu, FileWarning, Gauge, OctagonAlert, ShieldAlert } from 'lucide-react';
import type { PreflightAssessment } from '../types/tools';
import { formatBytes } from '../utils/pdfUtils';

interface PreflightSignProps {
  assessment: PreflightAssessment | null;
}

/**
 * Displays per-task estimated RAM & compute usage for every loaded workload,
 * escalating to Amber (heavy), Orange-Red (high risk), and bold Red (near-guaranteed crash)
 * while NEVER blocking the user from running the task.
 */
export function PreflightSign({ assessment }: PreflightSignProps) {
  if (!assessment || assessment.totalInputBytes <= 0) {
    return null;
  }

  // Normal / Safe workload: show a compact, clean per-task RAM & Compute estimate strip
  if (assessment.level === 'ok' || assessment.issues.length === 0) {
    return (
      <div
        data-testid="preflight-resource-strip"
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-[#131C31]/80 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
            <Gauge className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            Task Estimate:
          </span>
          <span className="font-mono tabular-nums">
            RAM ~{formatBytes(assessment.estimatedPeakBytes)}
            <span className="opacity-65"> / {formatBytes(assessment.deviceBudgetBytes)} safe</span>
          </span>
          <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
            {assessment.computeLabel}
          </span>
        </div>
        <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
          <Cpu className="w-3.5 h-3.5" />
          {assessment.deviceSummary}
        </span>
      </div>
    );
  }

  const isCrashImminent = assessment.level === 'crash-imminent';
  const isCritical =
    isCrashImminent ||
    assessment.level === 'unprocessable' ||
    assessment.level === 'high-risk';

  const containerClasses = isCrashImminent
    ? 'bg-red-100/95 dark:bg-red-950/60 border-red-500 dark:border-red-600 text-red-950 dark:text-red-50 ring-1 ring-red-500/30'
    : isCritical
      ? 'bg-red-50/90 dark:bg-red-950/30 border-red-200 dark:border-red-900/70 text-red-950 dark:text-red-100'
      : 'bg-amber-50/90 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/70 text-amber-950 dark:text-amber-100';

  const headingLabel =
    assessment.level === 'unprocessable'
      ? 'File Compatibility Sign — May Fail to Process'
      : isCrashImminent
        ? 'Near-Guaranteed Tab Crash — Extreme Memory & Compute Load'
        : assessment.level === 'high-risk'
          ? 'Device Crash Risk Sign — Heavy Memory Load'
          : 'Heavy Workload Advisory — Slower Local Compilation';

  return (
    <div
      role="alert"
      data-testid="preflight-warning-sign"
      data-severity={assessment.level}
      className={`rounded-xl border p-4 text-sm ${containerClasses}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {assessment.level === 'unprocessable' ? (
            <FileWarning className="w-5 h-5 text-red-600 dark:text-red-400" />
          ) : isCrashImminent ? (
            <OctagonAlert className="w-5 h-5 text-red-600 dark:text-red-400" />
          ) : assessment.level === 'high-risk' ? (
            <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display font-semibold text-sm">{headingLabel}</h3>
            <span className="font-mono tabular-nums text-[11px] opacity-85 inline-flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5" />
              {assessment.deviceSummary}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums">
            <span className="px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">
              Est. Peak RAM: {formatBytes(assessment.estimatedPeakBytes)} / {formatBytes(assessment.deviceBudgetBytes)}
            </span>
            <span className="px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">
              Compute: {assessment.computeLabel}
            </span>
            <span className="px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">
              Input: {formatBytes(assessment.totalInputBytes)}
            </span>
          </div>

          <ul className="mt-2.5 space-y-2">
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

          <p className="mt-2.5 text-[11px] font-semibold opacity-90">
            {isCrashImminent
              ? 'Warning only — no upload or execution cap is enforced. Controls stay unlocked so you can still run this task if you choose.'
              : 'No upload cap is enforced. Controls remain unlocked so you can still run this task if you choose.'}
          </p>
        </div>
      </div>
    </div>
  );
}
