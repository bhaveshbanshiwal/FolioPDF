import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  LayoutGrid,
  Loader2,
  Plus,
  X,
} from 'lucide-react';
import type { WorkspaceTab } from '../types/tools';
import { ToolIcon } from './ToolIcon';

interface TabStripProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

export function TabStrip({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: TabStripProps) {
  return (
    <div className="bg-slate-100/90 dark:bg-[#0F172A] border-b border-slate-200 dark:border-slate-800">
      <div
        role="tablist"
        aria-label="Parallel workspace tabs"
        className="max-w-[1440px] mx-auto px-3 sm:px-6 flex items-center gap-1 overflow-x-auto thin-scrollbar pt-1.5"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isTool = tab.toolId !== 'launcher';
          return (
            <div
              key={tab.id}
              className={`group flex items-center gap-1.5 h-9 px-2.5 rounded-t-lg border border-b-0 text-xs font-medium transition-colors shrink-0 ${
                isActive
                  ? 'bg-slate-50 dark:bg-[#0B1120] border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white -mb-px pb-px'
                  : 'bg-transparent border-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelectTab(tab.id)}
                className="flex items-center gap-2 min-w-0 max-w-[165px] h-full cursor-pointer focus-visible:outline-none"
              >
                {tab.status === 'processing' ? (
                  <Loader2 className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 animate-spin shrink-0" />
                ) : tab.status === 'done' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                ) : tab.status === 'error' ? (
                  <AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" />
                ) : tab.toolId !== 'launcher' ? (
                  <ToolIcon
                    toolId={tab.toolId}
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isActive ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'
                    }`}
                  />
                ) : (
                  <LayoutGrid className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
                )}

                <span className="truncate whitespace-nowrap">{tab.title}</span>

                {tab.status === 'processing' && (
                  <span className="font-mono tabular-nums text-[11px] text-rose-600 dark:text-rose-400 shrink-0">
                    {tab.progress}%
                  </span>
                )}
              </button>

              {isTool && (
                <a
                  href={`#/tool/${tab.toolId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${tab.title} in a separate browser tab`}
                  aria-label={`Open ${tab.title} in a separate browser tab`}
                  className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}

              {tabs.length > 1 && (
                <button
                  type="button"
                  onClick={() => onCloseTab(tab.id)}
                  aria-label={`Close ${tab.title} tab`}
                  title={`Close ${tab.title}`}
                  className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-800 dark:hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={onNewTab}
          aria-label="Open new parallel workspace tab"
          title="Open new parallel tab"
          className="h-8 w-8 mb-1 ml-1 inline-flex items-center justify-center rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-200/80 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
