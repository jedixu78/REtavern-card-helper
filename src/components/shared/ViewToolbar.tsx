/**
 * ViewToolbar — compact view-mode (grid | list) and size (sm | md | lg)
 * switcher used by Library and Drafts pages.
 *
 * State is externally controlled via props so the parent can persist it
 * through useViewPrefs. The control is intentionally small and inline
 * so it can sit in the same row as search/sort controls.
 */
import type { ViewMode, ViewSize } from '../../hooks/useViewPrefs';
import { LayoutGrid, List, ChevronDown } from 'lucide-react';

interface ViewToolbarProps {
  mode: ViewMode;
  size: ViewSize;
  onModeChange: (mode: ViewMode) => void;
  onSizeChange: (size: ViewSize) => void;
}

const sizeLabels: Record<ViewSize, string> = {
  sm: '小',
  md: '中',
  lg: '大',
};

const sizeCycle: ViewSize[] = ['sm', 'md', 'lg'];

export function ViewToolbar({ mode, size, onModeChange, onSizeChange }: ViewToolbarProps) {
  const borderColor = 'var(--color-border-default)';
  const muted = 'color-mix(in srgb, var(--text-color) 60%, transparent)';
  const activeBg = 'color-mix(in srgb, var(--color-primary) 14%, transparent)';
  const activeColor = 'var(--color-primary)';

  const cycleSize = () => {
    const idx = sizeCycle.indexOf(size);
    onSizeChange(sizeCycle[(idx + 1) % sizeCycle.length]);
  };

  const btnBase =
    'inline-flex items-center justify-center transition-colors';

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border p-1"
      style={{ borderColor, backgroundColor: 'var(--input-bg)' }}
    >
      {/* Grid / List toggle */}
      <button
        type="button"
        onClick={() => onModeChange('grid')}
        title="卡片视图"
        className={`${btnBase} w-7 h-7 rounded-md ${mode === 'grid' ? '' : 'hover:bg-[color-mix(in_srgb,var(--text-color)_6%,transparent)]'}`}
        style={mode === 'grid' ? { backgroundColor: activeBg, color: activeColor } : { color: muted }}
      >
        <LayoutGrid size={14} />
      </button>
      <button
        type="button"
        onClick={() => onModeChange('list')}
        title="列表视图"
        className={`${btnBase} w-7 h-7 rounded-md ${mode === 'list' ? '' : 'hover:bg-[color-mix(in_srgb,var(--text-color)_6%,transparent)]'}`}
        style={mode === 'list' ? { backgroundColor: activeBg, color: activeColor } : { color: muted }}
      >
        <List size={14} />
      </button>

      {/* Divider */}
      <span className="w-px h-5 mx-0.5" style={{ backgroundColor: borderColor }} />

      {/* Size cycler — only meaningful for grid, but always available */}
      <button
        type="button"
        onClick={cycleSize}
        title={`大小: ${sizeLabels[size]}`}
        className={`${btnBase} px-2 h-7 rounded-md text-xs font-medium hover:bg-[color-mix(in_srgb,var(--text-color)_6%,transparent)]`}
        style={{ color: muted }}
      >
        {sizeLabels[size]}
        <ChevronDown size={12} className="ml-0.5" />
      </button>
    </div>
  );
}
