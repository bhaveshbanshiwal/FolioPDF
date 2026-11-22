import { useCallback, useEffect, useState } from 'react';
import { TabStrip } from './components/TabStrip';
import { ToolLauncher } from './components/ToolLauncher';
import { ToolWorkspace } from './components/ToolWorkspace';
import { TopBar } from './components/TopBar';
import { isValidToolId, TOOL_BY_ID } from './data/toolsCatalog';
import type { TabStatus, ToolCategory, ToolId, WorkspaceTab } from './types/tools';

const THEME_STORAGE_KEY = 'foliopdf-theme';
const FAVORITES_STORAGE_KEY = 'foliopdf-favorites';

function parseHashToolId(): ToolId | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/^#\/tool\/([a-z0-9-]+)$/i);
  if (match && isValidToolId(match[1])) {
    return match[1];
  }
  return null;
}

function makeTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createInitialTabs(): WorkspaceTab[] {
  const hashTool = parseHashToolId();
  if (hashTool) {
    return [
      {
        id: makeTabId(),
        toolId: hashTool,
        title: TOOL_BY_ID[hashTool].shortName,
        status: 'idle',
        progress: 0,
        loadedBytes: 0,
      },
    ];
  }
  return [
    {
      id: makeTabId(),
      toolId: 'launcher',
      title: 'All Tools',
      status: 'idle',
      progress: 0,
      loadedBytes: 0,
    },
  ];
}

function readInitialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // Ignore storage failures
  }
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
    return 'dark';
  }
  return 'light';
}

function readInitialFavorites(): ToolId[] {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return ['merge', 'split', 'compress', 'sign'];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is ToolId => typeof id === 'string' && isValidToolId(id));
    }
  } catch {
    // Ignore parse errors
  }
  return ['merge', 'split', 'compress', 'sign'];
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(readInitialTheme);
  const [favorites, setFavorites] = useState<ToolId[]>(readInitialFavorites);
  const [launcherCategory, setLauncherCategory] = useState<ToolCategory | 'all' | 'favorites'>('all');

  const [tabs, setTabs] = useState<WorkspaceTab[]>(createInitialTabs);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);

  // Sync Tailwind v4 .dark class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage errors
    }
  }, [theme]);

  // Persist favorites
  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
    } catch {
      // Ignore storage errors
    }
  }, [favorites]);

  // Listen for browser hash changes (so bookmarks & hash navigation work cleanly on GitHub Pages)
  useEffect(() => {
    const handleHashChange = () => {
      const targetTool = parseHashToolId();
      if (!targetTool) return;
      const newTab: WorkspaceTab = {
        id: makeTabId(),
        toolId: targetTool,
        title: TOOL_BY_ID[targetTool].shortName,
        status: 'idle',
        progress: 0,
        loadedBytes: 0,
      };
      setTabs((prev) => {
        // Avoid duplicating if the active tab is already this exact tool with no files
        const cur = prev.find((t) => t.id === activeTabId);
        if (cur && cur.toolId === targetTool) return prev;
        return [...prev, newTab];
      });
      setActiveTabId((curId) => {
        const cur = tabs.find((t) => t.id === curId);
        return cur && cur.toolId === targetTool ? curId : newTab.id;
      });
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [activeTabId, tabs]);

  // Keep document.title synced with active tab
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.toolId === 'launcher') {
      document.title = 'FolioPDF — Client-Side PDF Workstation';
    } else {
      document.title = `${TOOL_BY_ID[activeTab.toolId].name} — FolioPDF`;
    }
  }, [activeTab]);

  const handleToggleFavorite = useCallback((toolId: ToolId) => {
    setFavorites((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId],
    );
  }, []);

  const handleNewTab = useCallback(() => {
    const tab: WorkspaceTab = {
      id: makeTabId(),
      toolId: 'launcher',
      title: 'All Tools',
      status: 'idle',
      progress: 0,
      loadedBytes: 0,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const handleOpenToolInCurrentTab = useCallback(
    (toolId: ToolId) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                toolId,
                title: TOOL_BY_ID[toolId].shortName,
                status: 'idle',
                progress: 0,
                loadedBytes: 0,
              }
            : t,
        ),
      );
      if (window.location.hash !== `#/tool/${toolId}`) {
        window.history.replaceState(null, '', `#/tool/${toolId}`);
      }
    },
    [activeTabId],
  );

  const handleOpenToolInNewTab = useCallback((toolId: ToolId, initialFiles?: File[]) => {
    const tab: WorkspaceTab = {
      id: makeTabId(),
      toolId,
      title: TOOL_BY_ID[toolId].shortName,
      status: 'idle',
      progress: 0,
      loadedBytes: initialFiles ? initialFiles.reduce((s, f) => s + f.size, 0) : 0,
      initialFiles,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    window.history.replaceState(null, '', `#/tool/${toolId}`);
  }, []);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        if (prev.length <= 1) return prev;
        const idx = prev.findIndex((t) => t.id === tabId);
        const next = prev.filter((t) => t.id !== tabId);
        if (tabId === activeTabId) {
          const fallback = next[Math.min(idx, next.length - 1)];
          if (fallback) setActiveTabId(fallback.id);
        }
        return next;
      });
    },
    [activeTabId],
  );

  const handleBackToLauncher = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              toolId: 'launcher',
              title: 'All Tools',
              status: 'idle',
              progress: 0,
              loadedBytes: 0,
              initialFiles: undefined,
            }
          : t,
      ),
    );
    window.history.replaceState(null, '', '#/');
  }, []);

  const handleSelectCategoryNav = useCallback(
    (cat: ToolCategory | 'all') => {
      setLauncherCategory(cat);
      const existingLauncher = tabs.find((t) => t.toolId === 'launcher');
      if (existingLauncher) {
        setActiveTabId(existingLauncher.id);
        window.history.replaceState(null, '', '#/');
      } else {
        handleNewTab();
        window.history.replaceState(null, '', '#/');
      }
    },
    [tabs, handleNewTab],
  );

  const handleTabStateUpdate = useCallback(
    (
      tabId: string,
      patch: { status?: TabStatus; progress?: number; loadedBytes?: number },
    ) => {
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== tabId) return t;
          if (
            (patch.status === undefined || patch.status === t.status) &&
            (patch.progress === undefined || patch.progress === t.progress) &&
            (patch.loadedBytes === undefined || patch.loadedBytes === t.loadedBytes)
          ) {
            return t;
          }
          return {
            ...t,
            status: patch.status ?? t.status,
            progress: patch.progress ?? t.progress,
            loadedBytes: patch.loadedBytes ?? t.loadedBytes,
          };
        }),
      );
    },
    [],
  );

  const totalLoadedBytesAllTabs = tabs.reduce((sum, t) => sum + t.loadedBytes, 0);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-[#0B1120] text-slate-900 dark:text-slate-100">
      <TopBar
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onNewTab={handleNewTab}
        onSelectCategoryNav={handleSelectCategoryNav}
        activeNavCategory={activeTab?.toolId === 'launcher' ? launcherCategory : null}
      />

      <TabStrip
        tabs={tabs}
        activeTabId={activeTab?.id ?? ''}
        onSelectTab={(id) => {
          setActiveTabId(id);
          const target = tabs.find((t) => t.id === id);
          if (target) {
            window.history.replaceState(
              null,
              '',
              target.toolId === 'launcher' ? '#/' : `#/tool/${target.toolId}`,
            );
          }
        }}
        onCloseTab={handleCloseTab}
        onNewTab={handleNewTab}
      />

      {/* Keep ALL open workspace tabs mounted so background tasks truly execute in parallel */}
      <main className="flex-1">
        {tabs.map((tab) => {
          const isVisible = tab.id === activeTab?.id;
          return (
            <div
              key={tab.id}
              role="tabpanel"
              hidden={!isVisible}
              className={isVisible ? 'block' : 'hidden'}
            >
              {tab.toolId === 'launcher' ? (
                <ToolLauncher
                  selectedCategory={launcherCategory}
                  onChangeCategory={setLauncherCategory}
                  favorites={favorites}
                  onToggleFavorite={handleToggleFavorite}
                  onOpenToolInCurrentTab={handleOpenToolInCurrentTab}
                  onOpenToolInNewTab={(id) => handleOpenToolInNewTab(id)}
                />
              ) : (
                <ToolWorkspace
                  tabId={tab.id}
                  toolId={tab.toolId}
                  initialFiles={tab.initialFiles}
                  otherTabsBytes={Math.max(0, totalLoadedBytesAllTabs - tab.loadedBytes)}
                  isFavorite={favorites.includes(tab.toolId)}
                  onToggleFavorite={handleToggleFavorite}
                  onTabStateUpdate={handleTabStateUpdate}
                  onChainToTool={(nextToolId, file) => handleOpenToolInNewTab(nextToolId, [file])}
                  onBackToLauncher={handleBackToLauncher}
                />
              )}
            </div>
          );
        })}
      </main>

      <footer className="mt-12 border-t border-slate-200 dark:border-slate-800 py-5">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <p>FolioPDF — 100% client-side PDF toolkit. Files never leave your device.</p>
          <p>Static build ready for GitHub Pages · No upload size caps</p>
        </div>
      </footer>
    </div>
  );
}
