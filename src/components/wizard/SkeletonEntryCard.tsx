/**
 * SkeletonEntryCard — lightweight OUTLINE card for Step 2 (world book skeleton).
 *
 * It is deliberately NOT LorebookEntryEditor (Step 4). A skeleton entry is a
 * structural blueprint: a topic title, a brief outline, and trigger words —
 * not a fully-specified lorebook entry. So this card hides every SillyTavern
 * runtime parameter (position / depth / probability / group / sticky / ...) and
 * instead foregrounds the skeleton's one job: AI-expand it into a real entry.
 */
import { TagInput } from '../shared/TagInput';
import { useTranslation } from '../../i18n/I18nContext';
import { themeAlpha } from '../../constants/theme';
import type { LorebookEntry } from '../../constants/defaults';

interface SkeletonEntryCardProps {
  entry: LorebookEntry;
  index: number;
  onUpdate: (index: number, updates: Partial<LorebookEntry>) => void;
  onRemove: (index: number) => void;
  expanding?: boolean;
  onAiExpand?: () => void;
}

function estimateTokens(text: string): number {
  return Math.round((text || '').length * 1.3);
}

export function SkeletonEntryCard({ entry, index, onUpdate, onRemove, expanding, onAiExpand }: SkeletonEntryCardProps) {
  const { t } = useTranslation();
  const isExpanded = entry.skeletonExpanded === true;
  const hasContent = !!entry.content?.trim();
  const title = entry.name || entry.comment || '';

  const C = {
    text: 'var(--text-color)',
    secondary: 'var(--color-text-secondary)',
    muted: 'var(--color-text-muted)',
    inputBg: 'var(--input-bg)',
    inputBorder: 'var(--input-border)',
    info: 'var(--color-info)',
    success: 'var(--color-status-success)',
    warning: 'var(--color-status-warning)',
  } as const;

  return (
    <div
      className="rounded-xl border border-dashed overflow-hidden"
      style={{
        borderColor: themeAlpha('info', 45),
        backgroundColor: themeAlpha('info', 5),
        opacity: entry.enabled === false ? 0.55 : 1,
      }}
    >
      <div className="px-3 sm:px-4 py-3 flex flex-col gap-2.5">
        {/* Row 1: blueprint emblem + inline title + remove */}
        <div className="flex items-center gap-2">
          <span className="text-sm shrink-0" aria-hidden>{isExpanded ? '✅' : '🦴'}</span>
          <input
            value={title}
            onChange={(e) => onUpdate(index, { name: e.target.value })}
            placeholder={t('lorebook.titlePlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none border-b border-dashed border-b-[color-mix(in_srgb,var(--color-info)_40%,transparent)] focus:border-b-[var(--color-info)] transition-colors"
            style={{ color: C.text }}
          />
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="shrink-0 w-6 h-6 rounded-md leading-none text-base transition-colors hover:bg-[color-mix(in_srgb,var(--color-status-danger)_15%,transparent)]"
            style={{ color: 'var(--color-status-danger)' }}
            title={t('common.delete')}
          >
            &times;
          </button>
        </div>

        {/* Brief outline content — compact, not the full editor */}
        <textarea
          value={entry.content}
          onChange={(e) => onUpdate(index, { content: e.target.value })}
          placeholder={t('lorebook.contentPlaceholder')}
          rows={3}
          className="w-full rounded-lg border px-2.5 py-2 text-xs leading-relaxed resize-y outline-none focus:ring-1 focus:ring-[var(--color-info)]"
          style={{ borderColor: C.inputBorder, backgroundColor: C.inputBg, color: C.text }}
        />

        {/* Trigger words — kept editable so outlines can be shaped early */}
        <TagInput
          label={t('lorebook.keysLabel')}
          tags={entry.keys}
          onChange={(keys) => onUpdate(index, { keys })}
          placeholder={t('lorebook.keysPlaceholder')}
        />

        {/* Footer: status + NSFW toggle + the skeleton's core action */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <div className="flex items-center gap-1.5 text-[10px]" style={{ color: C.muted }}>
            {isExpanded ? (
              <span className="rounded border px-1.5 py-0.5" style={{ borderColor: themeAlpha('success', 35), backgroundColor: themeAlpha('success', 10), color: C.success }}>
                {t('worldBook.expandedBadge')}
              </span>
            ) : (
              <span className="rounded border px-1.5 py-0.5" style={{ borderColor: themeAlpha('warning', 40), backgroundColor: themeAlpha('warning', 12), color: C.warning }}>
                {t('worldBook.skeletonBadge')}
              </span>
            )}
            {hasContent && (
              <span>{entry.content.length}{t('common.words')} · {estimateTokens(entry.content)} tokens</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onUpdate(index, { expandNsfw: !entry.expandNsfw })}
              className="text-[10px] px-1.5 py-0.5 rounded shrink-0 transition-colors"
              style={entry.expandNsfw ? {
                backgroundColor: themeAlpha('danger', 12),
                color: 'var(--color-status-danger)',
                border: `1px solid ${themeAlpha('danger', 40)}`,
              } : {
                backgroundColor: 'color-mix(in srgb, var(--color-surface-raised) 70%, transparent)',
                color: C.muted,
                border: '1px solid color-mix(in srgb, var(--color-border-default) 50%, transparent)',
              }}
              title={entry.expandNsfw ? t('lorebook.nsfwToggleOn') : t('lorebook.nsfwToggleOff')}
            >
              {entry.expandNsfw ? `🔞 ${t('common.nsfw')}` : `🛡️ ${t('common.safe')}`}
            </button>
            <button
              type="button"
              onClick={onAiExpand}
              disabled={expanding || !hasContent}
              className="text-[11px] px-2.5 py-1 rounded-md font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: C.info }}
            >
              {expanding ? '⏳' : `✨ ${t('worldBook.expandToDetail')}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
