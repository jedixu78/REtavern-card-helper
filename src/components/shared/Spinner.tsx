/** Spinner - 统一加载旋转器，替代各处重复的 animate-spin border 模式 */

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  sm: 'w-3.5 h-3.5 border-2',
  md: 'w-8 h-8 border-3',
  lg: 'w-12 h-12 border-4',
} as const;

export function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-current/30 border-t-current ${sizeMap[size]} ${className}`}
      style={{ color: 'var(--color-primary)' }}
    />
  );
}
