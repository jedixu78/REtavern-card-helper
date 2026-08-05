/** Toggle - 主题感知的开关组件，替代重复的 peer-checkbox 模式 */
interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  /** 开启时的颜色（默认 danger，用于 NSFW 等警示场景） */
  colorOn?: 'danger' | 'primary' | 'success';
  disabled?: boolean;
  className?: string;
}

const colorOnMap = {
  danger: 'var(--color-status-danger)',
  primary: 'var(--color-primary)',
  success: 'var(--color-status-success)',
} as const;

export function Toggle({
  checked,
  onChange,
  label,
  description,
  colorOn = 'danger',
  disabled = false,
  className = '',
}: ToggleProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <label className="relative inline-flex items-center cursor-pointer">
        <input
          type="checkbox"
          className="sr-only peer"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          disabled={disabled}
        />
        <div
          className="w-9 h-5 rounded-full peer transition-colors duration-200 peer-focus:outline-none"
          style={{
            backgroundColor: checked ? colorOnMap[colorOn] : 'var(--input-bg)',
          }}
        >
          <span
            className="absolute top-[2px] left-[2px] w-4 h-4 rounded-full transition-transform duration-200"
            style={{
              backgroundColor: 'var(--text-color)',
              transform: checked ? 'translateX(16px)' : 'translateX(0)',
            }}
          />
        </div>
      </label>
      {(label || description) && (
        <div className="flex items-center gap-1.5">
          {label && (
            <span className="text-xs text-themed-secondary">{label}</span>
          )}
          {description && (
            <span className="text-[10px] text-themed-muted">{description}</span>
          )}
        </div>
      )}
    </div>
  );
}
