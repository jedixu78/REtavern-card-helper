/** ChipGroup - 芯片快选组件，替代 WorldAnchorPanel/AIGeneratePanel 中的重复实现 */

interface ChipGroupOption<T extends string | number> {
  value: T;
  label: string;
}

interface ChipGroupProps<T extends string | number> {
  options: ChipGroupOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** 选中时的颜色主题 */
  color?: 'primary' | 'success' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}

const sizeMap = {
  sm: 'px-2 py-1 text-[11px]',
  md: 'px-3 py-1.5 text-xs',
} as const;

export function ChipGroup<T extends string | number>({
  options,
  value,
  onChange,
  color = 'primary',
  size = 'sm',
  className = '',
}: ChipGroupProps<T>) {
  const activeColor = {
    primary: { bg: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', border: 'color-mix(in srgb, var(--color-primary) 50%, transparent)', text: 'var(--color-primary)' },
    success: { bg: 'var(--color-status-success-bg)', border: 'var(--color-status-success-border)', text: 'var(--color-status-success)' },
    danger: { bg: 'var(--color-status-danger-bg)', border: 'var(--color-status-danger-border)', text: 'var(--color-status-danger)' },
  }[color];

  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {options.map(opt => {
        const isActive = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            onClick={() => onChange(opt.value)}
            className={`rounded-lg border transition-all duration-150 cursor-pointer active:scale-95 ${sizeMap[size]}`}
            style={
              isActive
                ? { backgroundColor: activeColor.bg, borderColor: activeColor.border, color: activeColor.text }
                : { backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--color-text-secondary)' }
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
