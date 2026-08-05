/** Card - 主题感知的卡片容器，替代重复的 rounded-xl border + inline style 模式 */
import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  /** 卡片变体 */
  variant?: 'default' | 'raised' | 'elevated' | 'primary-tint' | 'overlay';
  /** 内边距 */
  padding?: 'sm' | 'md' | 'lg' | 'none';
  /** 是否启用交互效果（hover 上浮 + active 缩放） */
  interactive?: boolean;
  className?: string;
  onClick?: () => void;
}

const paddingMap = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
} as const;

const variantClassMap = {
  default: 'card-themed',
  raised: 'card-themed surface-themed-raised',
  elevated: 'card-themed surface-themed-elevated',
  'primary-tint': 'rounded-xl border border-primary-tint-light bg-primary-tint-light',
  overlay: 'card-themed surface-themed-overlay',
} as const;

export function Card({
  children,
  variant = 'default',
  padding = 'md',
  interactive = false,
  className = '',
  onClick,
}: CardProps) {
  return (
    <div
      className={`${variantClassMap[variant]} ${paddingMap[padding]} ${interactive ? 'card-themed-interactive cursor-pointer' : ''} ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
