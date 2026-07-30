/**
 * AIGeneratePanel - Step 4 世界书细节的 AI 批量生成面板.
 *
 * 重构后只剩 topic 输入 + batchCount 选择 + 生成按钮。
 * 骨架模式与 worldRules 已随「锚定世界观」步骤合并移除。
 */
import { TextInput } from '../shared/TextInput';
import { useTranslation } from '../../i18n/I18nContext';

interface AIGeneratePanelProps {
  topic: string;
  generating: boolean;
  batchCount: number;
  onTopicChange: (topic: string) => void;
  onBatchCountChange: (count: number) => void;
  onGenerate: () => void;
}

export function AIGeneratePanel({
  topic,
  generating,
  batchCount,
  onTopicChange,
  onBatchCountChange,
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
