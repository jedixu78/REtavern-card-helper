/**
 * AIGeneratePanel - Always-visible panel for AI batch world book generation.
 * Uses CSS variables for consistent theming.
 */
import { TextInput } from '../shared/TextInput';
import { TextArea } from '../shared/TextArea';
import { useTranslation } from '../../i18n/I18nContext';
import { themeAlpha } from '../../constants/theme';

interface AIGeneratePanelProps {
  topic: string;
  worldRules: string;
  generating: boolean;
  skeletonMode: boolean;
  skeletonCount: number;
  batchCount: number;
  onTopicChange: (topic: string) => void;
  onWorldRulesChange: (rules: string) => void;
  onSkeletonModeChange: (skeleton: boolean) => void;
  onSkeletonCountChange: (count: number) => void;
  onBatchCountChange: (count: number) => void;
  onGenerate: () => void;
  /** When true, hides the topic input and skeleton-mode toggle section.
   *  Used in step 4 (detail mode) where only full-mode generation is offered. */
  hideTopicAndSkeleton?: boolean;

}

export function AIGeneratePanel({
  topic,
  worldRules,
  generating,
  skeletonMode,
  skeletonCount,
  batchCount,
  onTopicChange,
  onWorldRulesChange,
  onSkeletonModeChange,
  onSkeletonCountChange,
  onBatchCountChange,
  onGenerate,
  hideTopicAndSkeleton = false,
}: AIGeneratePanelProps) {
  const { t } = useTranslation();

  const faintText = 'color-mix(in srgb, var(--text-color) 40%, transparent)';
  const C = {
    text: 'var(--text-color)',
    secondary: 'var(--color-text-secondary)',
    muted: 'var(--color-text-muted)',
    border: 'var(--color-border-default)',
    surface: 'var(--color-surface-raised)',
    inputBg: 'var(--input-bg)',
    primary: 'var(--color-primary)',
    info: 'var(--color-info)',
    success: 'var(--color-status-success)',
    warning: 'var(--color-status-warning)',
    danger: 'var(--color-status-danger)',
  } as const;

  return (
    <div className="mb-6 rounded-xl border border-primary-tint-light bg-primary-tint-light p-4 space-y-3">
      {!hideTopicAndSkeleton && (
        <div>
          <label className="text-sm font-medium text-primary-bright">{t('aiPanel.topicLabel')}</label>
          <TextInput
            value={topic}
            onChange={(e) => onTopicChange(e.target.value)}
            placeholder={t('aiPanel.topicPlaceholder')}
          />
        </div>
      )}

      {/* Skeleton mode — hidden in detail mode (step 4) */}
      {!hideTopicAndSkeleton && (
        <div className="p-3 rounded-lg border space-y-2" style={{ backgroundColor: themeAlpha('success', 20), borderColor: themeAlpha('success', 30) }}>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium flex items-center gap-2 cursor-pointer select-none" style={{ color: C.success }}>
              <input
                type="checkbox"
                checked={skeletonMode}
                onChange={(e) => onSkeletonModeChange(e.target.checked)}
                className="rounded" style={{ borderColor: C.success, backgroundColor: C.inputBg, color: C.success }}
              />
              &#x1F9B4; {t('aiPanel.skeletonMode')}
            </label>
            <p className="text-[10px] mt-0.5 ml-6" style={{ color: 'color-mix(in srgb, var(--color-status-success) 60%, transparent)' }}>
              {t('aiPanel.skeletonHint')}
            </p>
          </div>
          {skeletonMode && (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs" style={{ color: 'color-mix(in srgb, var(--color-status-success) 70%, transparent)' }}>{t('aiPanel.countLabel')}</span>
              <input
                type="number"
                value={skeletonCount}
                min={1}
                max={30}
                onChange={(e) => onSkeletonCountChange(Math.max(1, parseInt(e.target.value) || 6))}
                className="w-14 text-center rounded border px-2 py-1 text-sm font-semibold" style={{ borderColor: themeAlpha('success', 40), backgroundColor: C.inputBg, color: C.success }}
              />
            </div>
          )}
        </div>
        {skeletonMode && (
          <div className="flex gap-1.5 ml-6">
            {[6, 10, 15, 20].map((n) => (
              <button
                key={n}
                onClick={() => onSkeletonCountChange(n)}
                className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                  skeletonCount === n
                    ? 'border-[var(--color-status-success)] bg-[color-mix(in_srgb,var(--color-status-success)_40%,transparent)] text-[var(--color-status-success)]'
                    : 'border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)] text-[var(--color-text-secondary)] hover:border-[var(--color-status-success)] hover:text-[var(--color-status-success)]'
                }`}
              >
                {n}{t('common.countUnit')}
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {/* Full mode batch count */}
      {!skeletonMode && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-primary-bright shrink-0">{t('aiPanel.batchCountLabel')}</span>
          <input
            type="number"
            value={batchCount}
            min={1}
            max={20}
            onChange={(e) => onBatchCountChange(Math.max(1, Math.min(20, parseInt(e.target.value) || 8)))}
            className="w-14 text-center rounded border border-primary-tint-light px-2 py-1 text-sm font-semibold text-primary-bright"
            style={{ backgroundColor: C.inputBg }}
          />
          <div className="flex gap-1.5">
            {[4, 8, 12, 16].map((n) => (
              <button
                key={n}
                onClick={() => onBatchCountChange(n)}
                className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                  batchCount === n
                    ? 'border-primary-tint bg-primary-tint text-primary-bright'
                    : 'border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-primary-muted'
                }`}
              >
                {n}{t('common.countUnit')}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mobile-stack-header flex items-start justify-between gap-2 mb-1">
          <label className="text-sm font-medium text-primary-bright min-w-0">
            {t('aiPanel.rulesLabel')}
            <span className="text-xs font-normal ml-2" style={{ color: faintText }}>{t('aiPanel.rulesHint')}</span>
          </label>
        </div>
        <TextArea
          value={worldRules}
          onChange={(e) => onWorldRulesChange(e.target.value)}
          placeholder={t('aiPanel.rulesPlaceholder')}
          rows={6}
        />
        <p className="text-[10px] mt-1" style={{ color: faintText }}>
          {t('aiPanel.rulesHelp')}
        </p>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onGenerate}
          disabled={generating}
          className="inline-flex items-center justify-center gap-2 rounded-lg font-medium px-5 py-2 text-sm
            bg-gradient-success
            text-[var(--text-color)] shadow-lg shadow-[0_10px_15px_-3px_color-mix(in_srgb,var(--color-status-success)_25%,transparent),0_4px_6px_-4px_color-mix(in_srgb,var(--color-status-success)_25%,transparent)] hover:shadow-[0_10px_15px_-3px_color-mix(in_srgb,var(--color-status-success)_40%,transparent),0_4px_6px_-4px_color-mix(in_srgb,var(--color-status-success)_40%,transparent)]
            transition-all duration-200 hover:scale-105 active:scale-95
            disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 cursor-pointer"
        >
          {generating ? `\u23F3 ${t('common.generating')}` : `\uD83D\uDE80 ${t('aiPanel.generateButton')}`}
        </button>
        {topic && (
          <span className="text-[10px] ml-auto" style={{ color: faintText }}>
            {`${t('aiPanel.topicSummary')}: ${topic.slice(0, 30) + (topic.length > 30 ? '...' : '')}`}
          </span>
        )}
      </div>
    </div>
  );
}
