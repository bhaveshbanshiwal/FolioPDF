import { ExternalLink, Search, Star, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { CATEGORY_LABELS, TOOLS_CATALOG } from '../data/toolsCatalog';
import type { ToolCategory, ToolId } from '../types/tools';
import { ToolIcon } from './ToolIcon';

interface ToolLauncherProps {
  selectedCategory: ToolCategory | 'all' | 'favorites';
  onChangeCategory: (cat: ToolCategory | 'all' | 'favorites') => void;
  favorites: ToolId[];
  onToggleFavorite: (toolId: ToolId) => void;
  onOpenToolInCurrentTab: (toolId: ToolId) => void;
  onOpenToolInNewTab: (toolId: ToolId) => void;
}

const FILTER_ORDER: Array<ToolCategory | 'all' | 'favorites'> = [
  'all',
  'favorites',
  'organize',
  'convert',
  'edit',
  'security',
];

export function ToolLauncher({
  selectedCategory,
  onChangeCategory,
  favorites,
  onToggleFavorite,
  onOpenToolInCurrentTab,
  onOpenToolInNewTab,
}: ToolLauncherProps) {
  const searchId = useId();
  const [query, setQuery] = useState('');

  const filteredTools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TOOLS_CATALOG.filter((tool) => {
      if (selectedCategory === 'favorites' && !favorites.includes(tool.id)) return false;
      if (
        selectedCategory !== 'all' &&
        selectedCategory !== 'favorites' &&
        tool.category !== selectedCategory
      ) {
        return false;
      }
      if (!q) return true;
      return (
        tool.name.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q) ||
        tool.category.toLowerCase().includes(q)
      );
    });
  }, [query, selectedCategory, favorites]);

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-8">
      {/* Compact Hero Header & Search */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6 border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-2xl">
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
            Every PDF tool, running locally in parallel tabs.
          </h1>
          <p className="mt-2 text-sm sm:text-base text-slate-600 dark:text-slate-400">
            Zero uploads, no file size caps, and instant GitHub Pages deployment. Click any tool to
            open it here, or launch multiple tabs side by side.
          </p>
        </div>

        <div className="w-full lg:w-80 shrink-0">
          <label htmlFor={searchId} className="sr-only">
            Search PDF tools
          </label>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id={searchId}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 25 PDF tools…"
              className="w-full h-10 pl-10 pr-9 rounded-lg bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-500/40 focus:border-rose-500 transition-colors"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Category Filter Bar */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800/70 overflow-x-auto max-w-full">
          {FILTER_ORDER.map((cat) => {
            const active = selectedCategory === cat;
            const count =
              cat === 'all'
                ? TOOLS_CATALOG.length
                : cat === 'favorites'
                  ? favorites.length
                  : TOOLS_CATALOG.filter((t) => t.category === cat).length;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => onChangeCategory(cat)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-white dark:bg-[#131C31] text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {CATEGORY_LABELS[cat]}{' '}
                <span className="font-mono tabular-nums text-[11px] opacity-70">{count}</span>
              </button>
            );
          })}
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400">
          Showing <span className="font-mono tabular-nums font-medium">{filteredTools.length}</span>{' '}
          of <span className="font-mono tabular-nums">{TOOLS_CATALOG.length}</span> tools
        </p>
      </div>

      {/* 25-Tool Grid */}
      {filteredTools.length === 0 ? (
        <div className="mt-12 py-14 text-center rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-white/50 dark:bg-[#131C31]/40">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {selectedCategory === 'favorites' && !query
              ? 'No favorite tools pinned yet.'
              : 'No tools match your search.'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {selectedCategory === 'favorites' && !query
              ? 'Click the star icon on any tool card to pin it here for quick access.'
              : 'Try a different keyword or switch back to All Tools.'}
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              onChangeCategory('all');
            }}
            className="mt-4 px-4 py-2 text-xs font-medium rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 transition-opacity cursor-pointer"
          >
            View All Tools
          </button>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
          {filteredTools.map((tool) => {
            const isFav = favorites.includes(tool.id);
            const capabilityLabel =
              tool.capability === 'on-demand-wasm'
                ? 'On-demand OCR'
                : tool.capability === 'workaround'
                  ? 'Client-side note'
                  : 'Native local';

            return (
              <div
                key={tool.id}
                className="group relative flex flex-col justify-between rounded-xl bg-white dark:bg-[#131C31] border border-slate-200 dark:border-slate-800 hover:border-rose-400/70 dark:hover:border-rose-500/60 transition-colors p-4"
              >
                {/* Top row: Icon + Title + Star & Browser-Tab controls */}
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenToolInCurrentTab(tool.id)}
                      className="flex items-center gap-3 text-left min-w-0 flex-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 rounded"
                    >
                      <span className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800/90 text-slate-800 dark:text-slate-100 group-hover:bg-rose-50 dark:group-hover:bg-rose-950/60 group-hover:text-rose-600 dark:group-hover:text-rose-400 flex items-center justify-center shrink-0 transition-colors">
                        <ToolIcon toolId={tool.id} className="w-4 h-4" />
                      </span>
                      <span className="font-display text-sm font-semibold text-slate-900 dark:text-white leading-snug truncate">
                        {tool.name}
                      </span>
                    </button>

                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onToggleFavorite(tool.id)}
                        aria-label={isFav ? `Remove ${tool.name} from favorites` : `Star ${tool.name}`}
                        title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                        className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                          isFav
                            ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/40'
                            : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        <Star className={`w-3.5 h-3.5 ${isFav ? 'fill-current' : ''}`} />
                      </button>

                      <a
                        href={`#/tool/${tool.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${tool.name} in new browser tab`}
                        title="Open in new browser tab"
                        className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenToolInCurrentTab(tool.id)}
                    aria-label={`Open ${tool.name}`}
                    className="mt-2.5 block w-full text-left cursor-pointer focus-visible:outline-none"
                  >
                    <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400 line-clamp-2">
                      {tool.description}
                    </p>
                  </button>
                </div>

                {/* Unboxed quiet metadata + Open in Parallel Tab action */}
                <div className="mt-3.5 pt-2.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2 text-[11px]">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 truncate">
                    <span>{CATEGORY_LABELS[tool.category]}</span>
                    <span aria-hidden="true">·</span>
                    <span
                      className={
                        tool.capability === 'workaround'
                          ? 'text-amber-700 dark:text-amber-400'
                          : tool.capability === 'on-demand-wasm'
                            ? 'text-sky-700 dark:text-sky-400'
                            : ''
                      }
                    >
                      {capabilityLabel}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenToolInNewTab(tool.id)}
                    className="text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400 font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    + New tab
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
