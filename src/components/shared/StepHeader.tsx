/** StepHeader - 向导步骤标题头，替代重复的「标题 + 副标题 + 右侧操作」模式 */
import type { ReactNode } from 'react';

interface StepHeaderProps {
  title: string;
  subtitle?: string;
  /** 右侧操作区 */
  actions?: ReactNode;
  /** 步骤编号（显示为圆形徽章） */
  step?: number;
  className?: string;
}

export function StepHeader({
  title,
  subtitle,
  actions,
  step,
  className = '',
}: StepHeaderProps) {
  return (
    <div className={`flex items-start justify-between gap-3 mb-4 step-header-responsive ${className}`}>
      <div className="flex items-center gap-3 min-w-0">
        {step !== undefined && (
          <span
            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)',
              color: 'var(--color-primary)',
            }}
          >
            {step}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-themed truncate">{title}</h2>
          {subtitle && (
            <p className="text-xs text-themed-muted mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="shrink-0 flex items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
