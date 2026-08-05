/** Badge - 徽章/计数胶囊，替代重复的 rounded-full border px-2 text-[10px] 模式 */
import type { ReactNode } from 'react';

interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'primary' | 'success' | 'danger' | 'warning' | 'info';
  size?: 'sm' | 'md';
  className?: string;
}

const variantStyleMap: Record<string, { bg: string; border: string; color: string }> = {
  default: { bg: 'transparent', border: 'var(--color-border-default)', color: 'var(--color-text-secondary)' },
  primary: { bg: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', border: 'color-mix(in srgb, var(--color-primary) 40%, transparent)', color: 'var(--color-primary)' },
  success: { bg: 'var(--color-status-success-bg)', border: 'var(--color-status-success-border)', color: 'var(--color-status-success)' },
  danger: { bg: 'var(--color-status-danger-bg)', border: 'var(--color-status-danger-border)', color: 'var(--color-status-danger)' },
  warning: { bg: 'var(--color-status-warning-bg)', border: 'var(--color-status-warning-border)', color: 'var(--color-status-warning)' },
  info: { bg: 'var(--color-status-info-bg)', border: 'var(--color-status-info-border)', color: 'var(--color-status-info)' },
} as const;

const sizeMap = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
} as const;

export function Badge({
  children,
  variant = 'default',
  size = 'sm',
  className = '',
}: BadgeProps) {
  const style = variantStyleMap[variant];
  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium ${sizeMap[size]} ${className}`}
      style={style}
    >
      {children}
    </span>
  );
}
