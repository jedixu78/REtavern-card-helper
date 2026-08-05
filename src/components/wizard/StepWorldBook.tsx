/**
 * Step World Book / Lorebook entries — Step 4 世界书细节.
 * Full SillyTavern V2 + runtime parameter support (CardForge reference).
 *
 * 重构后只有 detail 模式（骨架模式已与「锚定世界观」步骤合并移除）。
 * worldRules（世界观约束与运行规则内容）保留为生成输入，与 worldAnchor 共同约束 AI。
 */
import { useMemo, useState } from 'react';
import { Button } from '../shared/Button';
import { useToast } from '../shared/Toast';
import { AIProgressPanel, type AIProgressStatus } from '../shared/AIProgressPanel';
import { LorebookEntryEditor, type EntryExpandLevel } from './LorebookEntryEditor';
import { LorebookReviewDialog } from './LorebookReviewDialog';
import { useTranslation } from '../../i18n/I18nContext';
import { AIGeneratePanel } from './AIGeneratePanel';
import { OrganizePreviewTable } from './OrganizePreviewTable';
import { useAIGenerate } from '../../hooks/useAIGenerate';
import { themeAlpha, THEME_TOKENS } from '../../constants/theme';
import type { StatusColor } from '../../constants/theme';
import { createEmptyLorebookEntry, MVU_LOREBOOK_ENTRY_NAMES, formatWorldAnchorForPrompt } from '../../constants/defaults';
import type { LorebookEntry, LorebookPosition, AIOrganizeSuggestion, MvuConfig, WorldAnchor } from '../../constants/defaults';
import { findStagedLorebookEntryIndices } from '../../services/lorebook-predicates';
import {
  analyzeLorebookTokens,
  TOKEN_BUDGET_HEALTHY_MAX,
} from '../../services/token-budget';
import type { TokenBudgetLevel } from '../../services/token-budget';

/**
 * Serialize existing lorebook entries into a compact context string for AI secondary creation.
 * Includes id (for update targeting), name, trigger mode, keys, and content preview.
 */
function serializeEntriesForContext(entries: LorebookEntry[], maxContentChars = 600): string {
  if (entries.length === 0) return '';
  return entries
    .filter((e) => e.content.trim() || e.name.trim())
    .map((e) => {
      const mode = e.constant ? '常驻(constant)' : `关键词触发(keys: ${e.keys.join(', ') || '无'})`;
      const contentPreview = e.content.length > maxContentChars
        ? e.content.slice(0, maxContentChars) + '…(已截断)'
        : e.content;
      return `[id: ${e.id}] ${e.name || '(未命名)'} | ${mode} | position: ${e.position}\n${contentPreview}`;
    })
    .join('\n\n---\n\n');
}

const POSITION_ORDER: Record<LorebookPosition, number> = {
  before_char: 0,
  after_char: 1,
  before_example: 2,
  after_example: 3,
  before_author: 4,
  after_author: 5,
  at_depth: 6,
};

/** Sort lorebook entries by position group first, then insertion_order. */
function sortLorebookEntries(entries: LorebookEntry[]): LorebookEntry[] {
  return [...entries].sort((a, b) => {
    const posA = POSITION_ORDER[a.position ?? 'after_char'];
    const posB = POSITION_ORDER[b.position ?? 'after_char'];
    if (posA !== posB) return posA - posB;
    return (a.insertion_order ?? 100) - (b.insertion_order ?? 100);
  });
}

/** Token 预算分级 → 状态色 / 文案键 */
const BUDGET_TONE: Record<TokenBudgetLevel, StatusColor> = {
  healthy: 'success',
  high: 'warning',
  danger: 'danger',
};
const BUDGET_LEVEL_KEY: Record<TokenBudgetLevel, string> = {
  healthy: 'worldBook.tokenBudget.levelHealthy',
  high: 'worldBook.tokenBudget.levelHigh',
  danger: 'worldBook.tokenBudget.levelDanger',
};

function getProtectedEntryLabel(entry: LorebookEntry, idx: number, stagedIndices: Set<number>): string | null {
  const name = (entry.name || '').trim();
  const comment = (entry.comment || '').trim();
  if (MVU_LOREBOOK_ENTRY_NAMES.includes(name) || MVU_LOREBOOK_ENTRY_NAMES.includes(comment)) return 'MVU 系统';
  if (stagedIndices.has(idx)) return '分阶段';
  return null;
}

interface StepWorldBookProps {
  entries: LorebookEntry[];
  onEntriesChange: (entries: LorebookEntry[]) => void;
  /** 世界观约束与运行规则内容输入（跨步骤持久化，AI 生成时作为硬约束注入） */
  worldRules?: string;
  onWorldRulesChange?: (rules: string) => void;
  /** 主题/方向输入（跨步骤持久化，避免用户重复输入） */
  topicValue?: string;
  onTopicChangePersist?: (topic: string) => void;
  /** 批量生成条数（跨步骤持久化，避免用户重复输入） */
  batchCountValue?: number;
  onBatchCountPersist?: (count: number) => void;
  /** Character context for AI generation (full descriptions) */
  characterContext?: string;
  /** Whether NSFW content generation is allowed for world book entries */
  nsfw?: boolean;
  onNsfwChange?: (nsfw: boolean) => void;
  /** 世界观锚定 — 结构化约束（作为 AI 生成时的硬约束注入） */
  worldAnchor?: WorldAnchor;
  onWorldAnchorChange?: (anchor: WorldAnchor) => void;
  /** MVU config — used to show EJS indicators on entries */
  mvu?: MvuConfig;
  /** Cross-step navigation callback (currently unused in detail-only mode; kept for compat). */
  onJumpToStep?: (step: number) => void;
  // Legacy props kept for backward compat during transition
  cardName?: string;
  characterSummaries?: string;
  existingWorldbookContext?: string;
  onUpdate?: (entries: LorebookEntry[]) => void;
}

export function StepWorldBook({
  entries,
  onEntriesChange,
  worldRules: worldRulesProp = '',
  onWorldRulesChange,
  topicValue: externalTopic,
  onTopicChangePersist,
  batchCountValue: externalBatchCount,
  onBatchCountPersist,
  characterContext,
  nsfw,
  onNsfwChange,
  worldAnchor,
  mvu,
  // Legacy
  cardName: legacyCardName,
  characterSummaries: legacyCharacterSummaries,
  existingWorldbookContext: legacyExistingContext,
  onUpdate: legacyOnUpdate,
}: StepWorldBookProps) {
  const { t } = useTranslation();
  const [generating, setGenerating] = useState(false);
  const [localTopic, setLocalTopic] = useState('');
  const topic = onTopicChangePersist ? (externalTopic ?? '') : localTopic;
  const setTopic = onTopicChangePersist || setLocalTopic;
  const [localWorldRules, setLocalWorldRules] = useState('');
  const worldRules = onWorldRulesChange ? worldRulesProp : localWorldRules;
  const setWorldRules = onWorldRulesChange || setLocalWorldRules;
  const [localBatchCount, setLocalBatchCount] = useState(8);
  const batchCount = onBatchCountPersist ? (externalBatchCount ?? 8) : localBatchCount;
  const setBatchCount = onBatchCountPersist || setLocalBatchCount;
  // AI organize state
  const [organizing, setOrganizing] = useState(false);
  const [organizeResults, setOrganizeResults] = useState<AIOrganizeSuggestion[] | null>(null);
  // AI key generation state
  const [generatingKeys, setGeneratingKeys] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [stagedGroupOpen, setStagedGroupOpen] = useState(false);
  // Streaming progress
  const [aiStatus, setAiStatus] = useState<AIProgressStatus>('idle');
  const [streamText, setStreamText] = useState('');
  // AI expand state
  const [expandingIndex, setExpandingIndex] = useState<number | null>(null);
  /** 草稿态条目：批量生成后进入预览修改模式，导入时才合入主列表 */
  const [pendingEntries, setPendingEntries] = useState<LorebookEntry[] | null>(null);
  /** 生成前的原始快照：重新生成时作为基础，避免基于草稿迭代 */
  const [pendingSnapshot, setPendingSnapshot] = useState<LorebookEntry[] | null>(null);
  // Collapse state: Map of entry ID → expand level
  const [expandLevels, setExpandLevels] = useState<Map<string, EntryExpandLevel>>(new Map());
  const { generateLorebookParsedStreaming, organizeEntries, generateEntryKeys, expandLorebookEntry, generateEntryFromText } = useAIGenerate();
  const { addToast } = useToast();

  // Unified entry update handler (supports both new and legacy APIs)
  const handleUpdateEntries = onEntriesChange || legacyOnUpdate || (() => {});
  // Unified character context (prefer new API)
  const effectiveCharacterContext = characterContext ?? legacyCharacterSummaries ?? '';
  // Effective card name
  const effectiveCardName = legacyCardName ?? '';
  // Effective existing context
  const effectiveExistingContext = legacyExistingContext ?? '';
  const C = {
    text: 'var(--text-color)',
    secondary: 'var(--color-text-secondary)',
    muted: 'var(--color-text-muted)',
    border: 'var(--color-border-default)',
    inputBg: 'var(--input-bg)',
    inputBorder: 'var(--input-border)',
    surface: 'var(--color-surface-raised)',
    primary: 'var(--color-primary)',
    info: 'var(--color-info)',
    success: 'var(--color-status-success)',
    warning: 'var(--color-status-warning)',
  } as const;
  const surfaceA = (n: number) => `color-mix(in srgb, ${C.surface} ${n}%, transparent)`;
  const borderA = (n: number) => `color-mix(in srgb, ${C.border} ${n}%, transparent)`;
  const stagedIndices = useMemo(() => {
    try {
      return findStagedLorebookEntryIndices(entries);
    } catch {
      return new Set<number>();
    }
  }, [entries]);

  // 逐条 token 明细 + 常驻总量（下标与 entries 一一对应）
  const tokenBreakdown = useMemo(
    () => analyzeLorebookTokens(entries, { stagedIndices }),
    [entries, stagedIndices],
  );
  const budgetTone = BUDGET_TONE[tokenBreakdown.constantLevel];
  const budgetOverThreshold = tokenBreakdown.constantLevel !== 'healthy';
  const budgetTopOffenders = tokenBreakdown.topConstantEntries
    .slice(0, 3)
    .map((e) => `「${e.label}」${e.tokens}`)
    .join('、');

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

  const applyEntryView = (level: EntryExpandLevel) => {
    setExpandLevels(level === 'collapsed' ? new Map() : new Map(entries.map(e => [e.id, level])));
  };

  const addEntry = () => {
    handleUpdateEntries([...entries, createEmptyLorebookEntry()]);
  };

  const removeEntry = (index: number) => {
    handleUpdateEntries(entries.filter((_, i) => i !== index));
  };

  const updateEntry = (index: number, updates: Partial<LorebookEntry>) => {
    handleUpdateEntries(entries.map((e, i) => (i === index ? { ...e, ...updates } : e)));
  };

  /**
   * 批量生成核心逻辑：基于 baseEntries 调用 AI，返回 finalEntries（含 update+create
   * 合并后的完整列表）+ newEntries（仅新增条目，供 toast 统计用）。失败返回 null。
   * 不做任何 state 更新（setGenerating / setAiStatus / setPendingEntries），由调用方处理。
   */
  const runBatchGenerate = async (
    baseEntries: LorebookEntry[],
  ): Promise<{ finalEntries: LorebookEntry[]; newCount: number; updateCount: number } | null> => {
    const existingContext = serializeEntriesForContext(baseEntries);
    const result = await generateLorebookParsedStreaming(
      effectiveCardName, effectiveCharacterContext, topic, batchCount,
      (_chunk, fullText) => setStreamText(fullText),
      nsfw,
      formatWorldAnchorForPrompt(worldAnchor) || undefined,
      existingContext || undefined,
      worldRules.trim() || undefined,
    );
    if (!Array.isArray(result) || result.length === 0) return null;

    // Split results into updates (targeting existing entries) and new creates
    const updates = result.filter(
      (item) => item.action === 'update' && item.targetId && baseEntries.some((e) => e.id === item.targetId),
    );
    const creates = result.filter((item) => !updates.includes(item));

    // Apply updates: merge AI content into existing entries
    const updatedEntries = [...baseEntries];
    for (const upd of updates) {
      const idx = updatedEntries.findIndex((e) => e.id === upd.targetId);
      if (idx === -1) continue;
      const existing = updatedEntries[idx];
      const secondaryKeys = upd.secondary_keys || [];
      updatedEntries[idx] = {
        ...existing,
        // AI returns full updated content (original + additions)
        content: upd.content || existing.content,
        name: upd.name || existing.name,
        comment: upd.comment || existing.comment,
        keys: upd.keys?.length ? upd.keys : existing.keys,
        secondary_keys: secondaryKeys.length > 0 ? secondaryKeys : existing.secondary_keys,
        constant: upd.constant ?? existing.constant,
        insertion_order: upd.insertion_order ?? existing.insertion_order,
        position: (upd.position ?? existing.position) as LorebookPosition,
        priority: upd.priority ?? existing.priority,
      };
    }

    // Create new entries
    const newEntries = creates.map((item) => {
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
        position: (item.position ?? 'before_char') as LorebookPosition,
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
      } as LorebookEntry;
    });

    const finalEntries = sortLorebookEntries([...updatedEntries, ...newEntries]);
    return { finalEntries, newCount: newEntries.length, updateCount: updates.length };
  };

  const handleBatchGenerate = async () => {
    setGenerating(true);
    setAiStatus('generating');
    setStreamText('');
    try {
      const result = await runBatchGenerate(entries);
      if (result) {
        // 进入草稿态：保留原始快照（重新生成用），不直接合入主列表
        setPendingSnapshot(entries);
        setPendingEntries(result.finalEntries);
        // 隐藏原始流式预览（草稿条目列表已展示内容）
        setAiStatus('idle');
        setStreamText('');
        const parts: string[] = [];
        if (result.newCount > 0) parts.push(t('worldBook.entriesGeneratedToast', { count: String(result.newCount) }));
        if (result.updateCount > 0) parts.push(`${result.updateCount} 条已有条目已更新`);
        addToast('success', parts.length > 0 ? `${parts.join('，')}（请预览修改后导入）` : t('worldBook.generatedToDraft'));
      } else {
        addToast('error', t('worldBook.parseFailedToast'));
        setAiStatus('error');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setAiStatus('error');
      setStreamText(msg);
      addToast('error', t('worldBook.generateFailedToast', { message: msg }));
    } finally {
      setGenerating(false);
    }
  };

  /** LorebookReviewDialog 的「重新生成」回调：基于原始快照重跑，覆盖草稿 */
  const handleRegenerate = async (): Promise<boolean> => {
    if (!pendingSnapshot) return false;
    setGenerating(true);
    setAiStatus('generating');
    setStreamText('');
    try {
      const result = await runBatchGenerate(pendingSnapshot);
      if (result) {
        setPendingEntries(result.finalEntries);
        setAiStatus('idle');
        setStreamText('');
        addToast('success', t('worldBook.regeneratedToDraft'));
        return true;
      }
      addToast('error', t('worldBook.parseFailedToast'));
      setAiStatus('error');
      return false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setAiStatus('error');
      setStreamText(msg);
      addToast('error', t('worldBook.generateFailedToast', { message: msg }));
      return false;
    } finally {
      setGenerating(false);
    }
  };

  /** LorebookReviewDialog 的「导入」回调：合入主列表，自动折叠新增条目（id 不在原快照中的） */
  const handleImportDraft = (finalEntries: LorebookEntry[]) => {
    handleUpdateEntries(finalEntries);
    // 只折叠"新增"条目（id 不在生成前快照中的）；被 update 的条目保持原展开状态
    const snapshotIds = new Set((pendingSnapshot ?? []).map((e) => e.id));
    setExpandLevels(prev => {
      const next = new Map(prev);
      finalEntries.forEach((e) => {
        if (!snapshotIds.has(e.id)) next.set(e.id, 'collapsed');
      });
      return next;
    });
    setPendingEntries(null);
    setPendingSnapshot(null);
    setAiStatus('idle');
    setStreamText('');
  };

  /** LorebookReviewDialog 的「放弃」回调：清空草稿态，主列表不动 */
  const handleDiscardDraft = () => {
    setPendingEntries(null);
    setPendingSnapshot(null);
    setAiStatus('idle');
    setStreamText('');
  };

  // ── AI Expand single entry ──────────────────────────────────────────
  const handleExpandEntry = async (index: number, instruction?: string) => {
    const entry = entries[index];
    if (!entry) return;

    setExpandingIndex(index);
    try {
      const result = await expandLorebookEntry(
        {
          comment: entry.comment || entry.name || '',
          content: entry.content,
          keys: entry.keys,
          strategy: entry.constant ? 'constant' : 'selective',
          position: entry.insertion_order,
        },
        effectiveExistingContext
          ? `${effectiveCharacterContext}\n\n${t('worldBook.existingWorldbookHeaderBrief')}\n${effectiveExistingContext}`
          : effectiveCharacterContext,
        instruction,
        entry.expandNsfw,
        formatWorldAnchorForPrompt(worldAnchor) || undefined,
      );
      updateEntry(index, {
        comment: result.comment,
        content: result.content,
        keys: result.keys,
        constant: result.strategy === 'constant',
      });
      addToast('success', t('worldBook.expandDone', { name: result.comment || entry.name }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      addToast('error', t('worldBook.expandFailed', { message: msg }));
    } finally {
      setExpandingIndex(null);
    }
  };

  // ── AI Organize handler ────────────────────────────────────────
  const handleOrganize = async () => {
    if (entries.length === 0) return;
    setOrganizing(true);
    try {
      const results = await organizeEntries(entries.map((e, i) => ({
        index: i,
        name: e.name || e.comment || t('lorebook.entryFallback', { index: String(i + 1) }),
        content: e.content,
        keys: e.keys,
        position: e.position,
        insertion_order: e.insertion_order,
        depth: e.depth,
        probability: e.probability,
        constant: e.constant,
      })));
      setOrganizeResults(results.length > 0 ? results : null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      addToast('error', t('worldBook.organizeFailed', { message: msg }));
    } finally {
      setOrganizing(false);
    }
  };

  const applyOrganize = () => {
    if (!organizeResults) return;
    const updated = [...entries];
    for (const r of organizeResults) {
      if (r.index >= 0 && r.index < updated.length) {
        const entry = { ...updated[r.index] };
        if (r.position !== undefined) entry.position = r.position as LorebookPosition;
        if (r.insertion_order !== undefined) entry.insertion_order = r.insertion_order;
        if (r.depth !== undefined) entry.depth = r.depth;
        if (r.probability !== undefined) entry.probability = r.probability;
        if (r.constant !== undefined) entry.constant = r.constant;
        updated[r.index] = entry;
      }
    }
    handleUpdateEntries(sortLorebookEntries(updated));
    setOrganizeResults(null);
  };

  // ── AI Key Generation handler ──────────────────────────────────
  const handleGenerateKeys = async () => {
    const needsKeys = entries
      .map((e, i) => ({ entry: e, index: i }))
      .filter(({ entry }) => entry.content?.trim() && entry.keys.length < 2);
    if (needsKeys.length === 0) return;

    setGeneratingKeys(true);
    try {
      const results = await generateEntryKeys(needsKeys.map(({ entry, index }) => ({
        index,
        name: entry.name || entry.comment || t('lorebook.entryFallback', { index: String(index + 1) }),
        content: entry.content,
        existingKeys: entry.keys,
      })));
      if (results.length > 0) {
        const updated = [...entries];
        for (const r of results) {
          if (r.index >= 0 && r.index < updated.length && Array.isArray(r.keys)) {
            const existing = new Set(updated[r.index].keys);
            const merged = [...updated[r.index].keys, ...r.keys.filter(k => !existing.has(k))];
            updated[r.index] = { ...updated[r.index], keys: merged };
          }
        }
        handleUpdateEntries(updated);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      addToast('error', t('worldBook.keysFailed', { message: msg }));
    } finally {
      setGeneratingKeys(false);
    }
  };

  const cleanupEmptyEntries = () => {
    const updated = entries.filter(e => e.content?.trim() || e.name?.trim() || e.keys.length > 0);
    handleUpdateEntries(updated);
    addToast('success', t('worldBook.cleanupDone', { count: String(entries.length - updated.length) }));
  };

  const sortEntries = () => {
    handleUpdateEntries(sortLorebookEntries(entries));
    addToast('success', t('worldBook.sortDone'));
  };

  const disableEmptyKeyEntries = () => {
    const updated = entries.map(e => (!e.constant && e.keys.length === 0 ? { ...e, enabled: false } : e));
    const count = entries.filter(e => !e.constant && e.keys.length === 0 && e.enabled).length;
    handleUpdateEntries(updated);
    addToast('success', t('worldBook.disabledCount', { count: String(count) }));
  };

  const enableAllEntries = () => {
    handleUpdateEntries(entries.map(e => ({ ...e, enabled: true })));
    addToast('success', t('worldBook.enabledAll'));
  };

  // ── AI Generate single entry from text ──────────────────────────────
  const [generatingEntryFromText, setGeneratingEntryFromText] = useState(false);
  const [entryFromText, setEntryFromText] = useState('');

  const handleGenerateEntryFromText = async () => {
    if (!entryFromText.trim()) {
      addToast('error', t('worldBook.entryFromTextEmpty'));
      return;
    }
    setGeneratingEntryFromText(true);
    try {
      const result = await generateEntryFromText(
        effectiveCardName,
        entryFromText,
        effectiveCharacterContext,
        nsfw,
        formatWorldAnchorForPrompt(worldAnchor) || undefined,
      );
      if (result) {
        const base = createEmptyLorebookEntry();
        const secondaryKeys = result.secondary_keys || [];
        const newEntry: LorebookEntry = {
          ...base,
          name: result.name || '',
          keys: result.keys || [],
          secondary_keys: secondaryKeys,
          content: result.content || '',
          comment: result.comment || result.name || '',
          constant: result.constant ?? false,
          selective: secondaryKeys.length > 0 ? result.selective ?? false : false,
          insertion_order: result.insertion_order ?? 100,
          position: (result.position ?? 'before_char') as LorebookPosition,
          priority: result.priority ?? 50,
          probability: result.probability ?? 100,
          group: result.group || '',
          group_weight: result.group_weight ?? 100,
          selectiveLogic: result.selectiveLogic ?? 0,
          role: result.role ?? 0,
          depth: result.depth ?? 4,
          exclude_recursion: result.exclude_recursion ?? false,
          prevent_recursion: result.prevent_recursion ?? false,
          use_regex: result.use_regex ?? false,
          match_whole_words: result.match_whole_words ?? true,
          sticky: result.sticky ?? 0,
          cooldown: result.cooldown ?? 0,
          delay: result.delay ?? 0,
          ignore_budget: result.ignore_budget ?? false,
        };
        handleUpdateEntries([...entries, newEntry]);
        setEntryFromText('');
        addToast('success', t('worldBook.entryFromTextSuccess', { name: newEntry.name }));
      } else {
        addToast('error', t('worldBook.parseFailedToast'));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      addToast('error', t('worldBook.generateFailedToast', { message: msg }));
    } finally {
      setGeneratingEntryFromText(false);
    }
  };

  const q = searchQuery.trim().toLowerCase();
  const visibleEntries = q
    ? entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => {
      const text = [entry.name, entry.comment, entry.content, entry.keys.join(' '), entry.secondary_keys.join(' ')].join(' ').toLowerCase();
      return text.includes(q);
    })
    : entries.map((entry, index) => ({ entry, index }));
  const regularVisibleEntries = visibleEntries.filter(({ index }) => !stagedIndices.has(index));
  const stagedVisibleEntries = visibleEntries.filter(({ index }) => stagedIndices.has(index));

  const renderEntry = ({ entry, index }: { entry: LorebookEntry; index: number }) => {
    const protectedLabel = getProtectedEntryLabel(entry, index, stagedIndices);
    const ejsConfig = mvu?.enabled ? mvu.ejsConfigs.find(c => c.entryId === entry.id) : undefined;
    const isAnchorEntry = entry.fromAnchor === true;
    const tokenInfo = tokenBreakdown.entries[index];
    const showTokens = !!tokenInfo && tokenInfo.tokens > 0;
    const showBadges = !!(protectedLabel || ejsConfig || isAnchorEntry) || showTokens;
    return (
      <div key={entry.id} className="relative">
        {showBadges && (
          <div className="mb-1 flex items-center gap-1.5 text-[10px]" style={{ color: C.secondary }}>
            {protectedLabel && (
              <span className="rounded border px-1.5 py-0.5" style={{ borderColor: themeAlpha('primary', 30), backgroundColor: themeAlpha('primary', 10), color: C.primary }}>{protectedLabel}</span>
            )}
            {isAnchorEntry && (
              <span
                className="rounded border px-1.5 py-0.5"
                style={{ borderColor: themeAlpha('warning', 40), backgroundColor: themeAlpha('warning', 12), color: C.warning }}
                title={t('worldBook.anchorBadgeTooltip')}
              >
                ⚓ {t('worldBook.anchorBadge')}
              </span>
            )}
            {ejsConfig && (
              <span className="rounded border px-1.5 py-0.5" style={{ borderColor: themeAlpha('info', 30), backgroundColor: themeAlpha('info', 10), color: C.info }}>EJS · {ejsConfig.complexity}</span>
            )}
            {showTokens && tokenInfo && (
              <span
                className="rounded border px-1.5 py-0.5 tabular-nums"
                style={{ borderColor: borderA(60), backgroundColor: surfaceA(45), color: C.secondary }}
                title={t('worldBook.tokenBudget.entryTokensTooltip')}
              >
                {t('worldBook.tokenBudget.entryTokens', { tokens: String(tokenInfo.tokens) })}
              </span>
            )}
            {showTokens && tokenInfo?.alwaysOn && (
              <span
                className="rounded border px-1.5 py-0.5"
                style={{ borderColor: themeAlpha('warning', 35), backgroundColor: themeAlpha('warning', 10), color: C.warning }}
                title={t('worldBook.tokenBudget.perTurnTooltip')}
              >
                🔵 {t('worldBook.tokenBudget.perTurnBadge')}
              </span>
            )}
            {protectedLabel && <span>{t('worldBook.protectedEntryHint')}</span>}
          </div>
        )}
        <LorebookEntryEditor
          entry={entry}
          index={index}
          onUpdate={updateEntry}
          onRemove={removeEntry}
          expandLevel={expandLevels.get(entry.id) ?? 'collapsed'}
          onSetLevel={(level) => setEntryLevel(entry.id, level)}
          expanding={expandingIndex === index}
          onAiExpand={(instruction) => handleExpandEntry(index, instruction)}
        />
      </div>
    );
  };

  return (
    <div>
      {/* Batch tools bar */}
      {entries.length > 0 && (
        <div className="space-y-3 mb-4">
          <div className="flex flex-col gap-2 p-3 rounded-lg border sm:flex-row sm:flex-wrap sm:items-center" style={{ backgroundColor: surfaceA(40), borderColor: borderA(50) }}>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('worldBook.searchPlaceholder')}
              className="w-full min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none sm:min-w-[220px]"
              style={{ borderColor: C.inputBorder, backgroundColor: C.inputBg, color: C.text }}
            />
            <Button variant="ghost" size="sm" onClick={sortEntries}>{t('worldBook.sortByOrder')}</Button>
            <Button variant="ghost" size="sm" onClick={enableAllEntries}>{t('worldBook.enableAll')}</Button>
            <Button variant="ghost" size="sm" onClick={disableEmptyKeyEntries}>{t('worldBook.disableEmptyKeys')}</Button>
            <Button variant="ghost" size="sm" onClick={cleanupEmptyEntries}>{t('worldBook.cleanupEmpty')}</Button>
            <div className="flex items-center gap-1 rounded-lg border p-1" style={{ borderColor: borderA(60), backgroundColor: surfaceA(35) }}>
              <button type="button" onClick={() => applyEntryView('collapsed')} className="rounded px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_80%,transparent)] hover:text-[var(--text-color)]">紧凑</button>
              <button type="button" onClick={() => applyEntryView('preview')} className="rounded px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_80%,transparent)] hover:text-[var(--text-color)]">摘要</button>
              <button type="button" onClick={() => applyEntryView('edit')} className="rounded px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_80%,transparent)] hover:text-[var(--text-color)]">编辑</button>
            </div>
          </div>
          {searchQuery && (
            <p className="text-[11px]" style={{ color: C.muted }}>{t('worldBook.searchResults', { visible: String(visibleEntries.length), total: String(entries.length) })}</p>
          )}
        </div>
      )}

      {/* AI Tools bar */}
      {entries.length > 0 && (
        <div className="flex flex-col gap-2 mb-4 p-3 rounded-lg border sm:flex-row sm:flex-wrap sm:items-center" style={{ backgroundColor: themeAlpha('warning', 10), borderColor: themeAlpha('warning', 30) }}>
          <span className="text-xs font-medium shrink-0" style={{ color: C.warning }}>🧹 {t('worldBook.aiToolsLabel')}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleOrganize}
            disabled={organizing || generatingKeys}
          >
            {organizing ? t('worldBook.organizing') : `⚡ ${t('worldBook.smartOrganize')}`}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleGenerateKeys}
            disabled={generatingKeys || organizing}
          >
            {generatingKeys ? t('worldBook.generatingKeys') : `🗝️ ${t('worldBook.generateKeys')}`}
          </Button>
          <span className="text-[10px] ml-auto" style={{ color: C.muted }}>
            {t('worldBook.aiToolsHint')}
          </span>
        </div>
      )}

      {/* Organize preview table */}
      {organizeResults && organizeResults.length > 0 && (
        <OrganizePreviewTable
          entries={entries}
          suggestions={organizeResults}
          onApply={applyOrganize}
          onDismiss={() => setOrganizeResults(null)}
        />
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-bold" style={{ color: C.text }}>{t('worldBook.title')}</h2>
          <p className="text-sm mt-1" style={{ color: C.secondary }}>
            {t('worldBook.headerCount', { count: String(entries.length) })}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="secondary" onClick={addEntry}>+ {t('worldBook.addEntry')}</Button>
        </div>
      </div>

      {/* AI Generate Panel - always visible */}
      <AIGeneratePanel
        topic={topic}
        worldRules={worldRules}
        nsfw={nsfw}
        onNsfwChange={onNsfwChange}
        generating={generating}
        batchCount={batchCount}
        minBatchCount={4}
        onTopicChange={setTopic}
        onWorldRulesChange={setWorldRules}
        onBatchCountChange={setBatchCount}
        onGenerate={handleBatchGenerate}
      />

      {/* Single entry generation from text */}
      <div className="mb-6 rounded-xl border border-primary-tint-light bg-primary-tint-light p-4 space-y-3">
        <h3 className="text-sm font-medium" style={{ color: 'var(--color-primary)' }}>
          {t('worldBook.entryFromTextTitle')}
        </h3>
        <p className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
          {t('worldBook.entryFromTextHint')}
        </p>
        <textarea
          value={entryFromText}
          onChange={(e) => setEntryFromText(e.target.value)}
          placeholder={t('worldBook.entryFromTextPlaceholder')}
          rows={3}
          className="w-full rounded-lg border px-3 py-2 text-xs focus:border-[var(--color-primary)] focus:outline-none resize-none"
          style={{ borderColor: 'var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--text-color)' }}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleGenerateEntryFromText}
            disabled={generatingEntryFromText || !entryFromText.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-lg font-medium px-4 py-1.5 text-xs
              bg-gradient-success text-[var(--text-color)] shadow-lg transition-all duration-200 hover:scale-105 active:scale-95
              disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 cursor-pointer"
          >
            {generatingEntryFromText ? `⏳ ${t('common.generating')}` : `✨ ${t('worldBook.generateEntryFromText')}`}
          </button>
        </div>
      </div>

      {/* Streaming progress panel */}
      {aiStatus !== 'idle' && (
        <div className="mb-6">
          <AIProgressPanel
            status={aiStatus}
            text={streamText}
            title={t('aiPanel.worldBookGenerationTitle')}
            onClear={() => { setAiStatus('idle'); setStreamText(''); }}
          />
        </div>
      )}

      {/* 草稿态：批量生成后进入预览修改模式，导入时才合入主列表 */}
      {pendingEntries && pendingEntries.length > 0 && (
        <div className="mb-6">
          <LorebookReviewDialog
            draftEntries={pendingEntries}
            onDraftChange={(entries) => setPendingEntries(entries)}
            onImport={handleImportDraft}
            onDiscard={handleDiscardDraft}
            onRegenerate={handleRegenerate}
            cardName={effectiveCardName}
            anchorText={formatWorldAnchorForPrompt(worldAnchor) || ''}
            nsfw={nsfw}
            title={t('worldBook.reviewTitle')}
            canRegenerate={true}
          />
        </div>
      )}

      {entries.length === 0 && (
        <div className="text-center py-12 border border-dashed rounded-xl" style={{ color: C.muted, borderColor: C.border }}>
          <p>{t('worldBook.emptyEntriesTitle')}</p>
          <p className="text-sm mt-1">{t('worldBook.emptyEntriesHint')}</p>
        </div>
      )}

      {/* ── Token 预算摘要 ──────────────────────────────────────────────── */}
      {entries.length > 0 && (
        <div
          className="mb-3 rounded-lg border px-3 py-2.5"
          style={{ borderColor: themeAlpha(budgetTone, 30), backgroundColor: themeAlpha(budgetTone, 8) }}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-xs font-semibold shrink-0" style={{ color: C.text }}>
              {t('worldBook.tokenBudget.summaryTitle')}
            </span>
            <span
              className="rounded border px-2 py-0.5 text-[11px] font-medium tabular-nums"
              style={{
                borderColor: themeAlpha(budgetTone, 40),
                backgroundColor: themeAlpha(budgetTone, 14),
                color: THEME_TOKENS[budgetTone],
              }}
              title={t('worldBook.tokenBudget.constantTooltip')}
            >
              {t('worldBook.tokenBudget.constantTotal', {
                tokens: String(tokenBreakdown.constantTotal),
              })}
              {' · '}
              {t(BUDGET_LEVEL_KEY[tokenBreakdown.constantLevel])}
            </span>
            <span className="text-[11px] tabular-nums" style={{ color: C.secondary }}>
              {t('worldBook.tokenBudget.constantCount', {
                count: String(tokenBreakdown.constantCount),
              })}
            </span>
            <span className="text-[11px] tabular-nums" style={{ color: C.muted }}>
              {t('worldBook.tokenBudget.onDemandTotal', {
                tokens: String(tokenBreakdown.selectiveTotal),
                count: String(tokenBreakdown.selectiveCount),
              })}
            </span>
            {tokenBreakdown.disabledTotal > 0 && (
              <span className="text-[11px] tabular-nums" style={{ color: C.muted }}>
                {t('worldBook.tokenBudget.disabledTotal', {
                  tokens: String(tokenBreakdown.disabledTotal),
                })}
              </span>
            )}
            <span className="text-[10px] sm:ml-auto" style={{ color: C.muted }}>
              {t('worldBook.tokenBudget.estimateHint')}
            </span>
          </div>
          {budgetOverThreshold && (
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: THEME_TOKENS[budgetTone] }}>
              {t('worldBook.tokenBudget.overThresholdHint', { limit: String(TOKEN_BUDGET_HEALTHY_MAX) })}
              {budgetTopOffenders && (
                <>
                  {' '}
                  {t('worldBook.tokenBudget.topOffenders', { list: budgetTopOffenders })}
                </>
              )}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2 sm:space-y-3">
        {regularVisibleEntries.map(renderEntry)}

        {stagedVisibleEntries.length > 0 && (
          <section className="rounded-xl border" style={{ borderColor: themeAlpha('primary', 25), backgroundColor: themeAlpha('primary', 5) }}>
            <button
              type="button"
              onClick={() => setStagedGroupOpen(open => !open)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] transition-transform ${stagedGroupOpen ? 'rotate-90' : ''}`} style={{ color: C.primary }}>&#x25B6;</span>
                  <h3 className="text-sm font-semibold" style={{ color: C.text }}>阶段性世界书</h3>
                  <span className="rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: themeAlpha('primary', 25), backgroundColor: themeAlpha('primary', 10), color: C.primary }}>
                    {stagedVisibleEntries.length} 条
                  </span>
                </div>
                <p className="mt-1 text-[11px]" style={{ color: C.muted }}>分阶段模式生成的世界书条目，默认折叠以减少页面长度</p>
              </div>
              <span className="shrink-0 rounded-lg border px-2 py-1 text-[11px]" style={{ borderColor: themeAlpha('primary', 20), color: C.primary }}>
                {stagedGroupOpen ? '收起' : '展开'}
              </span>
            </button>
            {stagedGroupOpen && (
              <div className="space-y-2 border-t p-3 sm:space-y-3" style={{ borderColor: themeAlpha('primary', 20) }}>
                {stagedVisibleEntries.map(renderEntry)}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
