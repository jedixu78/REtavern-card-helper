/**
 * AIGeneratePanel - Step 4 世界书细节的 AI 批量生成面板.
 *
 * 保留 topic（主题/方向）与 worldRules（世界观约束与运行规则内容）输入，
 * 骨架模式已随「锚定世界观」步骤合并移除。
 */
import { TextInput } from '../shared/TextInput';
import { TextArea } from '../shared/TextArea';
import { Toggle } from '../shared/Toggle';
import { Button } from '../shared/Button';
import { ChipGroup } from '../shared/ChipGroup';
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

  return (
    <div className="mb-6 rounded-xl border border-primary-tint-light bg-primary-tint-light p-4 space-y-3">
      {/* NSFW toggle */}
      <div className="flex items-center gap-3 pb-2 border-b border-primary-tint-light">
        <Toggle
          checked={nsfw ?? false}
          onChange={(checked) => onNsfwChange?.(checked)}
          label={t('common.nsfw')}
          description={nsfw ? t('aiPanel.nsfwAllowed') : t('aiPanel.nsfwDisabled')}
          colorOn="danger"
        />
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
          style={{ backgroundColor: 'var(--input-bg)' }}
        />
        {onMinBatchCountChange && (
          <>
            <span className="text-[11px] text-themed-faint">{t('aiPanel.minBatchCountLabel')}</span>
            <input
              type="number"
              value={minBatchCount}
              min={1}
              max={batchCount}
              onChange={(e) => onMinBatchCountChange(Math.max(1, Math.min(batchCount, parseInt(e.target.value) || 4)))}
              className="w-14 text-center rounded border border-primary-tint-light px-2 py-1 text-sm font-semibold text-primary-bright"
              style={{ backgroundColor: 'var(--input-bg)' }}
            />
        </>
      )}
        <ChipGroup
          options={[1, 4, 8, 12, 16].map(n => ({ value: n, label: `${n}${t('common.countUnit')}` }))}
          value={batchCount}
          onChange={onBatchCountChange}
          color="primary"
          size="sm"
        />
      </div>

      <div>
        <div className="flex items-start justify-between gap-2 mb-1">
          <label className="text-sm font-medium text-primary-bright min-w-0">
            {t('aiPanel.rulesLabel')}
            <span className="text-xs font-normal ml-2 text-themed-faint">{t('aiPanel.rulesHint')}</span>
          </label>
        </div>
        <TextArea
          value={worldRules}
          onChange={(e) => onWorldRulesChange(e.target.value)}
          placeholder={t('aiPanel.rulesPlaceholder')}
          rows={6}
        />
        <p className="text-[10px] mt-1 text-themed-faint">
          {t('aiPanel.rulesHelp')}
        </p>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="success"
          onClick={onGenerate}
          disabled={generating}
        >
          {generating ? `\u23F3 ${t('common.generating')}` : `\uD83D\uDE80 ${t('aiPanel.generateButton')}`}
        </Button>
        {(topic || worldRules) && (
          <span className="text-[10px] ml-auto text-themed-faint">
            {topic && `${t('aiPanel.topicSummary')}: ${topic.slice(0, 30) + (topic.length > 30 ? '...' : '')}`}
            {topic && worldRules && ' · '}
            {worldRules && t('aiPanel.rulesSummary', { count: String(worldRules.length) })}
          </span>
        )}
      </div>
    </div>
  );
}
