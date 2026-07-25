/**
 * CardCover — displays a card cover image from a Blob, with a gradient
 * fallback showing the card name's first letter. Used by LibraryPage and
 * DraftsPage for the new card-grid layout.
 *
 * Object URL lifecycle is handled internally: the URL is created from the
 * blob when it changes and revoked on cleanup to avoid leaks.
 */
import { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';

interface CardCoverProps {
  /** Optional PNG/Blob cover. When absent, a placeholder is shown. */
  blob?: Blob | null;
  /** Card name used for the placeholder letter + title attr. */
  name?: string;
  /** Aspect ratio class. Defaults to 3:4 (SillyTavern card standard). */
  aspectClass?: string;
  /** Optional extra className on the root element. */
  className?: string;
  /** Rounded-corner class. Defaults to top-only rounding for stacked layouts. */
  roundedClass?: string;
}

export function CardCover({
  blob,
  name,
  aspectClass = 'aspect-[3/4]',
  className = '',
  roundedClass = 'rounded-t-xl',
}: CardCoverProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  const initial = useMemo(() => {
    const trimmed = (name || '').trim();
    return trimmed ? trimmed[0]?.toUpperCase() : '';
  }, [name]);

  // Stable gradient derived from the name so different cards get different colors
  // but the same card always gets the same fallback color.
  const gradient = useMemo(() => {
    const palette = [
      'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
      'linear-gradient(135deg, #10b981 0%, #34d399 100%)',
      'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)',
      'linear-gradient(135deg, #ef4444 0%, #f87171 100%)',
      'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)',
      'linear-gradient(135deg, #ec4899 0%, #f472b6 100%)',
      'linear-gradient(135deg, #14b8a6 0%, #2dd4bf 100%)',
    ];
    const trimmed = (name || '').trim();
    if (!trimmed) return palette[0];
    let hash = 0;
    for (let i = 0; i < trimmed.length; i++) {
      hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
    }
    return palette[hash % palette.length];
  }, [name]);

  return (
    <div
      className={`${aspectClass} ${roundedClass} relative overflow-hidden ${className}`}
      style={!url ? { background: gradient } : { backgroundColor: 'var(--color-surface-base)' }}
    >
      {url ? (
        <img
          src={url}
          alt={name || 'cover'}
          className="absolute inset-0 w-full h-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white/90 select-none">
          {initial ? (
            <span className="text-5xl font-bold drop-shadow-md">{initial}</span>
          ) : (
            <ImageIcon size={36} className="opacity-60" />
          )}
        </div>
      )}
    </div>
  );
}
