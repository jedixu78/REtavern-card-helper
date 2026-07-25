/**
 * useViewPrefs — persisted view preferences for grid-style pages
 * (Library, Drafts). Stores the view mode (grid | list) and the item
 * size (sm | md | lg) per page key in localStorage.
 *
 * Preferences are global per page key so they survive navigation and
 * page reloads. Each page passes a unique `pageKey` (e.g. 'library',
 * 'drafts') to keep its prefs isolated.
 */
import { useCallback, useEffect, useState } from 'react';

export type ViewMode = 'grid' | 'list';
export type ViewSize = 'sm' | 'md' | 'lg';

interface ViewPrefs {
  mode: ViewMode;
  size: ViewSize;
}

const DEFAULTS: ViewPrefs = { mode: 'grid', size: 'md' };

function storageKey(pageKey: string) {
  return `viewPrefs:${pageKey}`;
}

function readPrefs(pageKey: string): ViewPrefs {
  try {
    const raw = localStorage.getItem(storageKey(pageKey));
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      mode: parsed.mode === 'list' ? 'list' : 'grid',
      size: parsed.size === 'sm' || parsed.size === 'lg' ? parsed.size : 'md',
    };
  } catch {
    return DEFAULTS;
  }
}

export function useViewPrefs(pageKey: string) {
  const [prefs, setPrefs] = useState<ViewPrefs>(() => readPrefs(pageKey));

  // Re-sync if the page key changes (rare, but keeps the hook correct).
  useEffect(() => {
    setPrefs(readPrefs(pageKey));
  }, [pageKey]);

  const update = useCallback((patch: Partial<ViewPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(storageKey(pageKey), JSON.stringify(next));
      } catch {
        // Ignore write errors (quota / private mode).
      }
      return next;
    });
  }, [pageKey]);

  const setMode = useCallback((mode: ViewMode) => update({ mode }), [update]);
  const setSize = useCallback((size: ViewSize) => update({ size }), [update]);

  return { mode: prefs.mode, size: prefs.size, setMode, setSize };
}
