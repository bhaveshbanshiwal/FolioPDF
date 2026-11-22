import { Moon, Plus, Sun } from 'lucide-react';
import type { ToolCategory } from '../types/tools';

interface TopBarProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onNewTab: () => void;
  onSelectCategoryNav: (category: ToolCategory | 'all') => void;
  activeNavCategory: ToolCategory | 'all' | 'favorites' | null;
}

const NAV_ITEMS: Array<{ key: ToolCategory | 'all'; label: string }> = [
  { key: 'all', label: 'All Tools' },
  { key: 'organize', label: 'Organize' },
  { key: 'convert', label: 'Convert' },
  { key: 'edit', label: 'Edit & Sign' },
  { key: 'security', label: 'Security' },
];

export function TopBar({
  theme,
  onToggleTheme,
  onNewTab,
  onSelectCategoryNav,
  activeNavCategory,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-white/95 dark:bg-[#0B1120]/95 backdrop-blur-sm border-b border-slate-200 dark:border-slate-800">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-8">
        {/* Zone 1: Clean single-element wordmark */}
        <a
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            onSelectCategoryNav('all');
          }}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 rounded"
        >
          Folio<span className="text-rose-600 dark:text-rose-400">PDF</span>
        </a>

        {/* Zone 2: Concise single-line navigation links */}
        <nav aria-label="Tool categories" className="hidden md:flex items-center gap-6 text-sm font-medium">
          {NAV_ITEMS.map((item) => {
            const isActive = activeNavCategory === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onSelectCategoryNav(item.key)}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
                  isActive
                    ? 'border-rose-600 text-slate-900 dark:text-white dark:border-rose-400'
                    : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Theme toggle + Primary New Tab action */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={onNewTab}
            className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0B1120]"
          >
            <Plus className="w-4 h-4" />
            <span>New Tab</span>
          </button>
        </div>
      </div>
    </header>
  );
}
