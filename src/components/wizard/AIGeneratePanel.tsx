/**
 * AIGeneratePanel - Step 4 世界书细节的 AI 批量生成面板.
 *
 * 保留 topic（主题/方向）与 worldRules（世界观约束与运行规则内容）输入，
 * 骨架模式已随「锚定世界观」步骤合并移除。
 */
import { TextInput } from '../shared/TextInput';
import { TextArea } from '../shared/TextArea';
import { useTranslation } from '../../i18n/I18nContext';

interface AIGeneratePanelProps {
  topic: string;
  worldRules: string;
  nsfw?: boolean;
  onNsfwChange?: (nsfw: boolean) => void;
  generating: boolean;
  batchCount: number;
  minBatchCount?: number;
  onTopicChange: (topic: string) => void;
  onWorldRulesChange: (rules: string) => void;
  onBatchCountChange: (count: number) => void;
  onMinBatchCountChange?: (count: number) => void;
  onGenerate: () => void;
}

export function AIGeneratePanel({
  topic,
  worldRules,
  nsfw,
  onNsfwChange,
  generating,
  batchCount,
  minBatchCount = 4,
  onTopicChange,
  onWorldRulesChange,
  onBatchCountChange,
  onMinBatchCountChange,
  onGenerate,
}: AIGeneratePanelProps) {
  const { t } = useTranslation();

  const faintText = 'color-mix(in srgb, var(--text-color) 40%, transparent)';
  const C = {
    text: 'var(--text-color)',
    inputBg: 'var(--input-bg)',
  } as const;

  return (
    <div className="mb-6 rounded-xl border border-primary-tint-light bg-primary-tint-light p-4 space-y-3">
      {/* NSFW toggle */}
      <div className="flex items-center gap-3 pb-2 border-b border-primary-tint-light">
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={nsfw ?? false}
            onChange={(e) => onNsfwChange?.(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-[var(--input-bg)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-[var(--text-color)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--text-color)] after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--color-status-danger)]" />
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-xs" style={{ color: 'color-mix(in srgb, var(--text-color) 80%, transparent)' }}>{t('common.nsfw')}</span>
          <span className="text-[10px]" style={{ color: faintText }}>
            {nsfw ? t('aiPanel.nsfwAllowed') : t('aiPanel.nsfwDisabled')}
          </span>
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-primary-bright">{t('aiPanel.topicLabel')}</label>
        <TextInput
          value={topic}
          onChange={(e) => onTopicChange(e.target.value)}
          placeholder={t('aiPanel.topicPlaceholder')}
        />
      </div>

      {/* Full mode batch count */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-primary-bright shrink-0">{t('aiPanel.batchCountLabel')}</span>
        <input
          type="number"
          value={batchCount}
          min={minBatchCount}
          max={20}
          onChange={(e) => onBatchCountChange(Math.max(minBatchCount, Math.min(20, parseInt(e.target.value) || 8)))}
          className="w-14 text-center rounded border border-primary-tint-light px-2 py-1 text-sm font-semibold text-primary-bright"
          style={{ backgroundColor: C.inputBg }}
        />
        {onMinBatchCountChange && (
          <>
            <span className="text-[11px]" style={{ color: faintText }}>{t('aiPanel.minBatchCountLabel')}</span>
            <input
              type="number"
              value={minBatchCount}
              min={1}
              max={batchCount}
              onChange={(e) => onMinBatchCountChange(Math.max(1, Math.min(batchCount, parseInt(e.target.value) || 4)))}
              className="w-14 text-center rounded border border-primary-tint-light px-2 py-1 text-sm font-semibold text-primary-bright"
              style={{ backgroundColor: C.inputBg }}
            />
          </>
        )}
        <div className="flex gap-1.5">
          {[1, 4, 8, 12, 16].map((n) => (
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

      <div>
        <div className="flex items-start justify-between gap-2 mb-1">
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
        {(topic || worldRules) && (
          <span className="text-[10px] ml-auto" style={{ color: faintText }}>
            {topic && `${t('aiPanel.topicSummary')}: ${topic.slice(0, 30) + (topic.length > 30 ? '...' : '')}`}
            {topic && worldRules && ' · '}
            {worldRules && t('aiPanel.rulesSummary', { count: String(worldRules.length) })}
          </span>
        )}
      </div>
    </div>
  );
}
