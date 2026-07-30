/**
 * WorldAnchorPanel — 锚定世界观步骤的核心面板（Step 2）.
 *
 * 用户按从大到小提供 5 个结构化字段（类型 / 时代·年份 / 文化背景 / 人文细节 / 硬性约束），
 * 点击「AI 锚定生成」后调用 generateWorldAnchorEntriesStreaming，
 * 流式预览 AI 输出，完成后通过 onEntriesGenerated 把结果交给父组件
 * 加入 lorebookEntries（标记 fromAnchor: true）。
 *
 * 第一条总纲条目 AI 已按 prompt 输出 name=`{cardName}世界书` / constant=true / before_char，
 * 调用方直接 map 即可，无需额外处理。
 */
import { useState } from 'react';
import { useTranslation } from '../../i18n/I18nContext';
import { useToast } from '../shared/Toast';
import { AIProgressPanel, type AIProgressStatus } from '../shared/AIProgressPanel';
import { LorebookReviewDialog } from './LorebookReviewDialog';
import { useAIGenerate } from '../../hooks/useAIGenerate';
import { themeAlpha } from '../../constants/theme';
import { formatWorldAnchorForPrompt, createEmptyLorebookEntry, resolveBookName } from '../../constants/defaults';
import type { WorldAnchor, LorebookEntry, LorebookPosition, AIGeneratedLorebookEntry } from '../../constants/defaults';

const TYPE_CHIPS = ['异世界', '平行世界', '赛博朋克', '奇幻', '末日生存', '校园日常', '现代都市', '日式轻小说'] as const;
const ERA_CHIPS = ['上古', '古代', '中世纪', '近现代', '现代', '近未来', '未来科幻', '架空'] as const;
const CULTURE_CHIPS = ['中国', '欧洲', '日本', '韩国', '美国', '中东', '古中国', '架空'] as const;

interface WorldAnchorPanelProps {
  anchor: WorldAnchor;
  onChange: (anchor: WorldAnchor) => void;
  /** 卡名（用于 AI prompt 与总纲条目名） */
  cardName: string;
  /** 已有条目（用于 AI 去重提示） */
  existingEntries: LorebookEntry[];
  /** AI 生成完成后回调，父组件把新条目加入 lorebookEntries */
  onEntriesGenerated: (entries: LorebookEntry[]) => void;
  /** 是否允许 NSFW 内容生成 */
  nsfw?: boolean;
  /** 默认展开 */
  defaultExpanded?: boolean;
}

export function WorldAnchorPanel({
  anchor: rawAnchor,
  onChange,
  cardName,
  existingEntries,
  onEntriesGenerated,
  nsfw,
  defaultExpanded = true,
}: WorldAnchorPanelProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { generateWorldAnchorEntriesStreaming } = useAIGenerate();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [generating, setGenerating] = useState(false);
  const [aiStatus, setAiStatus] = useState<AIProgressStatus>('idle');
  const [streamText, setStreamText] = useState('');
  /** 草稿态条目：生成后不直接合入主列表，由 LorebookReviewDialog 接管，导入时才合入 */
  const [pendingEntries, setPendingEntries] = useState<LorebookEntry[] | null>(null);

  // 防御性归一化：旧草稿/导入卡片可能只填了部分字段，缺失字段以 '' 兜底，
  // 避免后续 .trim() 抛出 "Cannot read properties of undefined".
  const anchor: WorldAnchor = {
    type: rawAnchor?.type ?? '',
    era: rawAnchor?.era ?? '',
    culture: rawAnchor?.culture ?? '',
    humanity: rawAnchor?.humanity ?? '',
    constraints: rawAnchor?.constraints ?? '',
  };

  const C = {
    text: 'var(--text-color)',
    secondary: 'var(--color-text-secondary)',
    muted: 'var(--color-text-muted)',
    border: 'var(--color-border-default)',
    inputBg: 'var(--input-bg)',
    inputBorder: 'var(--input-border)',
    primary: 'var(--color-primary)',
    warning: 'var(--color-status-warning)',
  } as const;

  const update = (field: keyof WorldAnchor, value: string) => {
    onChange({ ...anchor, [field]: value });
  };

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '60px',
    padding: '8px 10px',
    borderRadius: '8px',
    border: `1px solid ${C.inputBorder}`,
    background: C.inputBg,
    color: C.text,
    fontSize: '13px',
    lineHeight: '1.5',
    resize: 'vertical',
    outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '12px',
    fontWeight: 600,
    color: C.secondary,
    marginBottom: '4px',
  };

  // 字段序号徽章：强化「从大到小细化」的漏斗阅读顺序
  const stepBadge: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '15px',
    height: '15px',
    marginRight: '6px',
    borderRadius: '50%',
    fontSize: '10px',
    fontWeight: 700,
    color: C.primary,
    border: `1px solid ${themeAlpha('primary', 45)}`,
    background: themeAlpha('primary', 12),
    verticalAlign: 'middle',
  };

  /** 渲染芯片快选 + 自定义输入 */
  const renderChipsAndInput = (
    field: keyof WorldAnchor,
    chips: readonly string[],
    placeholder: string,
  ) => (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {chips.map((chip) => {
          const active = anchor[field] === chip;
          return (
            <button
              key={chip}
              type="button"
              onClick={() => update(field, chip)}
              className="px-2.5 py-1 rounded-full text-xs cursor-pointer transition-colors"
              style={{
                border: `1px solid ${active ? C.primary : C.border}`,
                background: active ? themeAlpha('primary', 15) : 'transparent',
                color: active ? C.primary : C.secondary,
                fontWeight: active ? 600 : 400,
              }}
            >
              {chip}
            </button>
          );
        })}
      </div>
      <input
        type="text"
        value={anchor[field]}
        onChange={(e) => update(field, e.target.value)}
        placeholder={placeholder}
        className="w-full px-2.5 py-1.5 rounded-lg text-sm"
        style={{
          border: `1px solid ${C.inputBorder}`,
          background: C.inputBg,
          color: C.text,
          outline: 'none',
        }}
      />
    </div>
  );

  const canGenerate = !!cardName.trim() && !generating && (
    anchor.type.trim() || anchor.era.trim() || anchor.culture.trim() || anchor.humanity.trim() || anchor.constraints.trim()
  );

  /** 核心生成逻辑：返回映射后的 LorebookEntry[]（带 fromAnchor 标记），失败返回 null。 */
  const runGenerate = async (): Promise<LorebookEntry[] | null> => {
    const anchorText = formatWorldAnchorForPrompt(anchor);
    if (!anchorText.trim()) return null;
    const existingTitles = existingEntries
      .map((e) => e.name || e.comment)
      .filter(Boolean)
      .join('、');

    const result = await generateWorldAnchorEntriesStreaming(
      cardName,
      anchorText,
      existingTitles,
      (_chunk, fullText) => setStreamText(fullText),
      nsfw,
    );
    if (!Array.isArray(result) || result.length === 0) return null;
    return result.map((item: AIGeneratedLorebookEntry) => {
      const base = createEmptyLorebookEntry();
      const secondaryKeys = item.secondary_keys || [];
      return {
        ...base,
        name: item.name || '',
        keys: item.keys || [],
        secondary_keys: secondaryKeys,
        content: item.content || '',
        comment: item.comment || item.name || '',
        constant: item.constant ?? false,
        selective: secondaryKeys.length > 0 ? item.selective ?? false : false,
        insertion_order: item.insertion_order ?? 100,
        position: (item.position ?? 'after_char') as LorebookPosition,
        priority: item.priority ?? 50,
        probability: item.probability ?? 100,
        group: item.group || '',
        group_weight: item.group_weight ?? 100,
        selectiveLogic: item.selectiveLogic ?? 0,
        role: item.role ?? 0,
        depth: item.depth ?? 4,
        exclude_recursion: item.exclude_recursion ?? false,
        prevent_recursion: item.prevent_recursion ?? false,
        use_regex: item.use_regex ?? false,
        match_whole_words: item.match_whole_words ?? true,
        sticky: item.sticky ?? 0,
        cooldown: item.cooldown ?? 0,
        delay: item.delay ?? 0,
        ignore_budget: item.ignore_budget ?? false,
        // 标记为锚定世界观产物，Step 4 渲染 ⚓ 徽章
        fromAnchor: true,
      } as LorebookEntry;
    });
  };

  const handleGenerate = async () => {
    if (!cardName.trim()) {
      addToast('error', t('worldAnchor.cardNameRequired'));
      return;
    }
    const anchorText = formatWorldAnchorForPrompt(anchor);
    if (!anchorText.trim()) {
      addToast('error', t('worldAnchor.emptyAnchor'));
      return;
    }

    setGenerating(true);
    setAiStatus('generating');
    setStreamText('');
    try {
      const newEntries = await runGenerate();
      if (newEntries && newEntries.length > 0) {
        // 进入草稿态：由 LorebookReviewDialog 接管，不直接合入主列表
        setPendingEntries(newEntries);
        // 隐藏原始流式预览（草稿条目列表已展示内容）
        setAiStatus('idle');
        setStreamText('');
        addToast('success', t('worldAnchor.generatedToDraft', { count: String(newEntries.length) }));
      } else {
        addToast('error', t('worldAnchor.parseFailed'));
        setAiStatus('error');
        setStreamText(t('worldAnchor.parseFailed'));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setAiStatus('error');
      setStreamText(msg);
      addToast('error', t('worldAnchor.generateFailed', { message: msg }));
    } finally {
      setGenerating(false);
    }
  };

  /** LorebookReviewDialog 的「重新生成」回调：覆盖当前草稿 */
  const handleRegenerate = async (): Promise<boolean> => {
    if (!cardName.trim()) {
      addToast('error', t('worldAnchor.cardNameRequired'));
      return false;
    }
    const anchorText = formatWorldAnchorForPrompt(anchor);
    if (!anchorText.trim()) {
      addToast('error', t('worldAnchor.emptyAnchor'));
      return false;
    }
    setGenerating(true);
    setAiStatus('generating');
    setStreamText('');
    try {
      const newEntries = await runGenerate();
      if (newEntries && newEntries.length > 0) {
        setPendingEntries(newEntries);
        setAiStatus('idle');
        setStreamText('');
        addToast('success', t('worldAnchor.generatedToDraft', { count: String(newEntries.length) }));
        return true;
      }
      addToast('error', t('worldAnchor.parseFailed'));
      setAiStatus('error');
      return false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setAiStatus('error');
      setStreamText(msg);
      addToast('error', t('worldAnchor.generateFailed', { message: msg }));
      return false;
    } finally {
      setGenerating(false);
    }
  };

  /** LorebookReviewDialog 的「导入」回调：合入主列表，清空草稿态 */
  const handleImport = (entries: LorebookEntry[]) => {
    onEntriesGenerated(entries);
    setPendingEntries(null);
    setAiStatus('idle');
    setStreamText('');
    addToast('success', t('worldAnchor.generatedToast', { count: String(entries.length) }));
  };

  /** LorebookReviewDialog 的「放弃」回调：清空草稿态 */
  const handleDiscard = () => {
    setPendingEntries(null);
    setAiStatus('idle');
    setStreamText('');
  };

  // 已生成的锚定条目（fromAnchor）数量提示
  const anchorEntryCount = existingEntries.filter((e) => e.fromAnchor === true).length;
  const bookName = resolveBookName({ cardName, bookName: '' });

  return (
    <div
      className="rounded-xl mb-4"
      style={{
        border: `1.5px solid ${themeAlpha('warning', 40)}`,
        background: themeAlpha('warning', 6),
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 cursor-pointer"
        style={{ background: 'transparent', border: 'none', textAlign: 'left' }}
      >
        <span style={{ fontSize: '16px' }}>⚓</span>
        <span style={{ fontSize: '14px', fontWeight: 700, color: C.text }}>{t('worldAnchor.title')}</span>
        <span style={{ fontSize: '11px', color: C.muted, marginLeft: '4px' }}>
          {t('worldAnchor.subtitle')}
        </span>
        {anchorEntryCount > 0 && (
          <span
            className="rounded-full border px-2 py-0.5 text-[10px] ml-1"
            style={{ borderColor: themeAlpha('warning', 35), backgroundColor: themeAlpha('warning', 10), color: C.warning }}
          >
            {t('worldAnchor.entriesCount', { count: String(anchorEntryCount) })}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: C.muted }}>
          {expanded ? '▼' : '▶'}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* ① 类型（最宏观） */}
          <div>
            <label style={labelStyle}><span style={stepBadge}>1</span>{t('worldAnchor.typeLabel')}</label>
            {renderChipsAndInput('type', TYPE_CHIPS, t('worldAnchor.typePlaceholder'))}
          </div>

          {/* ② 时代/年份 */}
          <div>
            <label style={labelStyle}><span style={stepBadge}>2</span>{t('worldAnchor.eraLabel')}</label>
            {renderChipsAndInput('era', ERA_CHIPS, t('worldAnchor.eraPlaceholder'))}
          </div>

          {/* ③ 文化背景 */}
          <div>
            <label style={labelStyle}><span style={stepBadge}>3</span>{t('worldAnchor.cultureLabel')}</label>
            {renderChipsAndInput('culture', CULTURE_CHIPS, t('worldAnchor.culturePlaceholder'))}
          </div>

          {/* ④ 人文细节 */}
          <div>
            <label style={labelStyle}><span style={stepBadge}>4</span>{t('worldAnchor.humanityLabel')}</label>
            <textarea
              value={anchor.humanity}
              onChange={(e) => update('humanity', e.target.value)}
              placeholder={t('worldAnchor.humanityPlaceholder')}
              style={textareaStyle}
              rows={2}
            />
          </div>

          {/* ⑤ 硬性约束 */}
          <div>
            <label style={labelStyle}><span style={stepBadge}>5</span>{t('worldAnchor.constraintsLabel')}</label>
            <textarea
              value={anchor.constraints}
              onChange={(e) => update('constraints', e.target.value)}
              placeholder={t('worldAnchor.constraintsPlaceholder')}
              style={{
                ...textareaStyle,
                borderColor: themeAlpha('warning', 50),
              }}
              rows={2}
            />
          </div>

          {/* AI 锚定生成按钮 */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="inline-flex items-center justify-center gap-2 rounded-lg font-medium px-5 py-2 text-sm
                bg-gradient-success
                text-[var(--text-color)] shadow-lg shadow-[0_10px_15px_-3px_color-mix(in_srgb,var(--color-status-success)_25%,transparent),0_4px_6px_-4px_color-mix(in_srgb,var(--color-status-success)_25%,transparent)]
                hover:shadow-[0_10px_15px_-3px_color-mix(in_srgb,var(--color-status-success)_40%,transparent),0_4px_6px_-4px_color-mix(in_srgb,var(--color-status-success)_40%,transparent)]
                transition-all duration-200 hover:scale-105 active:scale-95
                disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 cursor-pointer"
            >
              {generating ? `⏳ ${t('worldAnchor.generating')}` : `🚀 ${t('worldAnchor.generateButton')}`}
            </button>
            <span className="text-[10px]" style={{ color: C.muted }}>
              {t('worldAnchor.generateHint', { bookName })}
            </span>
          </div>

          {/* 流式预览（生成中或失败时显示，进入草稿态后隐藏） */}
          {aiStatus !== 'idle' && (
            <AIProgressPanel
              status={aiStatus}
              text={streamText}
              title={t('worldAnchor.progressTitle')}
              onClear={() => { setAiStatus('idle'); setStreamText(''); }}
            />
          )}

          {/* 草稿态：预览 + 对话式修改 + 导入 */}
          {pendingEntries && pendingEntries.length > 0 && (
            <LorebookReviewDialog
              draftEntries={pendingEntries}
              onDraftChange={(entries) => setPendingEntries(entries)}
              onImport={handleImport}
              onDiscard={handleDiscard}
              onRegenerate={handleRegenerate}
              cardName={cardName}
              anchorText={formatWorldAnchorForPrompt(anchor)}
              nsfw={nsfw}
              title={t('worldAnchor.reviewTitle')}
              canRegenerate={true}
            />
          )}

          {/* Hint text */}
          <p style={{ fontSize: '11px', color: C.muted, margin: 0, lineHeight: '1.4' }}>
            {t('worldAnchor.hint')}
          </p>
        </div>
      )}
    </div>
  );
}
