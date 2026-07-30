/**
 * StepWorldAnchor — 第 2 步「锚定世界观」.
 *
 * 取代原骨架步骤。本步只做两件事：
 *  1. 用户按从大到小填 5 个结构化字段（类型 / 时代·年份 / 文化背景 / 人文细节 / 硬性约束）
 *     → 字段持久化在 draft.worldAnchor，并作为后续 AI 生成（角色/世界书细节/
 *     开场白）的硬约束注入。
 *  2. 点「AI 锚定生成」→ AI 输出 1 条总纲条目 + N 条子条目，追加进
 *     draft.lorebookEntries（标记 fromAnchor: true）。条目本身的编辑/删除
 *     在第 4 步「世界书细节」完成，本步只显示只读列表便于回顾。
 */
import { useTranslation } from '../../i18n/I18nContext';
import { themeAlpha } from '../../constants/theme';
import { WorldAnchorPanel } from './WorldAnchorPanel';
import { LorebookEntryEditor, type EntryExpandLevel } from './LorebookEntryEditor';
import { useState } from 'react';
import type { LorebookEntry, WorldAnchor } from '../../constants/defaults';

interface StepWorldAnchorProps {
  /** 卡片名（必填，用于 AI prompt 与总纲条目名） */
  cardName: string;
  /** 世界观锚定字段 */
  worldAnchor: WorldAnchor;
  onWorldAnchorChange: (anchor: WorldAnchor) => void;
  /** 当前所有世界书条目（用于显示已生成的锚定条目列表 + AI 去重） */
  entries: LorebookEntry[];
  onEntriesChange: (entries: LorebookEntry[]) => void;
  /** NSFW 开关 */
  nsfw?: boolean;
}

export function StepWorldAnchor({
  cardName,
  worldAnchor,
  onWorldAnchorChange,
  entries,
  onEntriesChange,
  nsfw,
}: StepWorldAnchorProps) {
  const { t } = useTranslation();
  const [expandLevels, setExpandLevels] = useState<Map<string, EntryExpandLevel>>(new Map());

  const C = {
    text: 'var(--text-color)',
    secondary: 'var(--color-text-secondary)',
    muted: 'var(--color-text-muted)',
    border: 'var(--color-border-default)',
    surface: 'var(--color-surface-raised)',
    warning: 'var(--color-status-warning)',
  } as const;
  const surfaceA = (n: number) => `color-mix(in srgb, ${C.surface} ${n}%, transparent)`;

  const setEntryLevel = (id: string, level: EntryExpandLevel) => {
    setExpandLevels(prev => {
      const next = new Map(prev);
      if (level === 'collapsed') {
        next.delete(id);
      } else {
        next.set(id, level);
      }
      return next;
    });
  };

  const handleEntriesGenerated = (newEntries: LorebookEntry[]) => {
    onEntriesChange([...entries, ...newEntries]);
    // Auto-collapse newly generated entries
    setExpandLevels(prev => {
      const next = new Map(prev);
      newEntries.forEach(e => next.set(e.id, 'collapsed'));
      return next;
    });
  };

  // 只读列表：仅显示 fromAnchor 标记的条目
  const anchorEntries = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.fromAnchor === true);

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-bold" style={{ color: C.text }}>{t('worldAnchor.title')}</h2>
          <p className="text-sm mt-1" style={{ color: C.secondary }}>
            {t('worldAnchor.intro')}
          </p>
        </div>
      </div>

      {/* World Anchor Panel（含 AI 生成按钮） */}
      <WorldAnchorPanel
        anchor={worldAnchor}
        onChange={onWorldAnchorChange}
        cardName={cardName}
        existingEntries={entries}
        onEntriesGenerated={handleEntriesGenerated}
        nsfw={nsfw}
        defaultExpanded={true}
      />

      {/* 已生成的锚定条目（只读列表，编辑请去第 4 步） */}
      {anchorEntries.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold" style={{ color: C.text }}>
              {t('worldAnchor.generatedEntriesTitle')}
            </h3>
            <span
              className="rounded-full border px-2 py-0.5 text-[10px]"
              style={{ borderColor: themeAlpha('warning', 30), backgroundColor: themeAlpha('warning', 10), color: C.warning }}
            >
              {t('worldAnchor.entriesCount', { count: String(anchorEntries.length) })}
            </span>
            <span className="text-[11px]" style={{ color: C.muted }}>
              {t('worldAnchor.editHint')}
            </span>
          </div>
          <div className="space-y-2 sm:space-y-3">
            {anchorEntries.map(({ entry, index }) => (
              <div
                key={entry.id}
                className="relative rounded-lg border p-1"
                style={{ borderColor: themeAlpha('warning', 25), backgroundColor: surfaceA(30) }}
              >
                <div className="mb-1 flex items-center gap-1.5 text-[10px] px-2 pt-1" style={{ color: C.secondary }}>
                  <span
                    className="rounded border px-1.5 py-0.5"
                    style={{ borderColor: themeAlpha('warning', 40), backgroundColor: themeAlpha('warning', 12), color: C.warning }}
                  >
                    ⚓ {t('worldAnchor.anchorBadge')}
                  </span>
                </div>
                <LorebookEntryEditor
                  entry={entry}
                  index={index}
                  onUpdate={(idx, updates) => {
                    onEntriesChange(entries.map((e, i) => (i === idx ? { ...e, ...updates } : e)));
                  }}
                  onRemove={(idx) => {
                    onEntriesChange(entries.filter((_, i) => i !== idx));
                  }}
                  expandLevel={expandLevels.get(entry.id) ?? 'collapsed'}
                  onSetLevel={(level) => setEntryLevel(entry.id, level)}
                  expanding={false}
                  onAiExpand={() => {/* 编辑入口在第 4 步 */}}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {anchorEntries.length === 0 && (
        <div
          className="text-center py-10 border border-dashed rounded-xl"
          style={{ color: C.muted, borderColor: C.border }}
        >
          <p>{t('worldAnchor.emptyTitle')}</p>
          <p className="text-sm mt-1">{t('worldAnchor.emptyHint')}</p>
        </div>
      )}
    </div>
  );
}
