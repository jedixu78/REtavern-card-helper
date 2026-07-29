/**
 * CardEditorChatPage - AI-assisted character card editor via chat.
 *
 * Workflow:
 *   1. Import a JSON or PNG character card.
 *   2. Chat with AI about changes (e.g. "turn NTR plot into pure love").
 *   3. AI returns structured edit proposals.
 *   4. Review diffs and apply them.
 *   5. Save to library or export PNG/JSON.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Button } from '../components/shared/Button';
import { Modal } from '../components/shared/Modal';
import { useToast } from '../components/shared/Toast';
import { useCardLibrary } from '../hooks/useCardLibrary';
import { callAIStreaming, cancelActiveAIRequests } from '../services/ai-service';
import { importFromPng, exportAsPng, exportAsJson, cardToDraft, assembleCard } from '../services/card-exporter';
import { resizeImageToPngBuffer } from '../services/image-processing';
import {
  buildCardChatPrompt,
  parseCardChatEdits,
  computeCardChatDiffs,
  applySingleChange,
  applyPatchToCardData,
  fieldLabel,
  diffDisplayName,
  type CardChatProposals,
  type ChangeDiff,
  type ProposedChange,
} from '../services/card-chat-optimizer';
import type { WizardDraft } from '../constants/defaults';
import type { AIMessage } from '../services/ai-service';
import {
  saveCardEditorAutoDraft,
  loadCardEditorAutoDraft,
  clearCardEditorAutoDraft,
  saveCardEditorDraft,
  listCardEditorDrafts,
  loadCardEditorDraft,
  deleteCardEditorDraft,
  updateCardEditorDraftCover,
  stripTrailingTime,
  type CardEditorChatMessage,
} from '../services/draft-service';
import type { WizardDraftRecord } from '../db/database';
import { CardCover } from '../components/shared/CardCover';
import { useTranslation } from '../i18n/I18nContext';
import { Upload, Save, FileJson, Image as ImageIcon, Check, X, ChevronDown, ChevronUp, FolderOpen, Trash2, ShieldCheck, ShieldOff } from 'lucide-react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const borderColor = 'var(--color-border-default)';
const mutedText = 'color-mix(in srgb, var(--text-color) 60%, transparent)';
const faintText = 'color-mix(in srgb, var(--text-color) 40%, transparent)';
const surfaceRaisedTransparent = 'color-mix(in srgb, var(--color-surface-raised) 80%, transparent)';
const cardBgSemiTransparent = 'rgba(var(--card-bg-r), var(--card-bg-g), var(--card-bg-b), 0.4)';
const cardBgDarkerSemiTransparent = 'rgba(var(--card-bg-r), var(--card-bg-g), var(--card-bg-b), 0.5)';

// ════════════════════════════════════════════════════════════════════════════
// 无损通道分歧检测
// ────────────────────────────────────────────────────────────────────────────
// 双轨模型：draft 驱动 UI，rawCard 累积补丁供无损导出。applyPatchToCardData
// 按「不新增未涉及依赖」原则会静默跳过部分修改（原卡无 character_book 时的
// 世界书条目、无对应 regex 脚本时的 statusBarHtml/liveStreamChat、characters
// replace 只写 _meta 不同步世界书条目），而 draft 侧照常应用——两轨会静默
// 分歧，导致「UI 显示已改，无损导出没有」。
// 这里在每条补丁应用后做分歧检测；一旦检出分歧就永久置位（随草稿持久化），
// 导出与入库回退 assembleCard(draft) 完整重建，保证「UI 所见 == 导出所得」。
// ════════════════════════════════════════════════════════════════════════════

/** 取原始卡的 data 块（V2/V3 嵌套在 card.data 下，V1 为顶层）。 */
function rawDataOf(raw: Record<string, unknown>): Record<string, unknown> {
  const data = raw.data;
  return (data && typeof data === 'object' && !Array.isArray(data)
    ? data
    : raw) as Record<string, unknown>;
}

/**
 * 统计原始卡 character_book 中会被 comment 匹配命中的条目数。
 * 匹配语义与 applyPatchToCardData 保持一致：comment 优先，回退 name。
 */
function countRawLorebookMatches(raw: Record<string, unknown>, comment: string): number {
  const book = rawDataOf(raw).character_book;
  if (!book || typeof book !== 'object') return 0;
  const entries = (book as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return 0;
  return entries.filter((e) => {
    if (!e || typeof e !== 'object') return false;
    const entry = e as Record<string, unknown>;
    return (entry.comment || entry.name) === comment;
  }).length;
}

/** 判断原始卡 _meta.characters 中是否存在指定 id 的角色。 */
function rawMetaHasCharacter(raw: Record<string, unknown>, id: string): boolean {
  const meta = raw._meta;
  if (!meta || typeof meta !== 'object') return false;
  const characters = (meta as Record<string, unknown>).characters;
  if (!Array.isArray(characters)) return false;
  return characters.some(
    (c) => c && typeof c === 'object' && String((c as Record<string, unknown>).id) === String(id),
  );
}

interface DualTrackApplyResult {
  nextDraft: WizardDraft;
  nextRaw: Record<string, unknown> | null;
  diverged: boolean;
}

/**
 * 把一批已确认的 change 逐条应用到双轨（draft + rawCard），并检测无损通道
 * 是否与 UI 分歧。检出分歧后仍继续累积应用剩余补丁（rawCard 保留尽力而为的
 * 结果，便于用户后续手动排查），只是无损导出被关闭。
 *
 * 分歧的精确触发条件（任一命中即 diverged=true）：
 *  1. 单条 change 使 draft 的 JSON 序列化结果变化与 rawCard 的不一致
 *     （draft 变了 raw 没变 → 补丁被无损轨静默跳过；raw 变了 draft 没变 →
 *     无损轨改了 UI 未展示的内容）。注：修改值与现状恰好相同导致的
 *     「双轨都未变化」不触发；「一轨恰好已是目标值」的罕见情形会误报——
 *     误报只导致回退 assembleCard 重建，不损正确性。
 *  2. characters replace/delete：change.id 在 rawCard 的 _meta.characters 中
 *     无匹配而 draft 侧命中。applyPatchToCardData 的 characters 分支即使未
 *     命中也会回写 meta.characters（可能凭空创建 _meta.characters: []），
 *     整体序列化比较会被这次「空写」掩盖，故需单独校验。
 *  3. characters replace：draft 侧会把新 description 同步进关联的世界书条目
 *     （B5 行为），无损轨只写 _meta.characters。若 draft 的 lorebookEntries
 *     变了而 rawCard 的 character_book 没变，视为分歧。
 *  4. lorebookEntries delete/replace 的匹配语义差异：draft 侧按 comment 修改/
 *     删除全部同名条目，无损轨只处理第一条。应用后若 rawCard 中仍存在会被
 *     draft 侧命中的同 comment 条目（delete 后仍有残留；replace 改名后旧
 *     comment 仍有残留；replace 不改名后同名条目多于 1 条），视为部分应用。
 */
function applyChangesWithDivergenceCheck(
  draft: WizardDraft,
  rawCard: Record<string, unknown> | null,
  changes: ProposedChange[],
): DualTrackApplyResult {
  let nextDraft = draft;
  let nextRaw = rawCard;
  let diverged = false;

  for (const change of changes) {
    const prevDraft = nextDraft;
    // 逐条应用与 applyCardChatPatch 批量应用等价：批量版只是对同一个累积
    // 对象循环执行相同的分支逻辑。
    nextDraft = applySingleChange(prevDraft, change);
    if (!nextRaw) continue;

    const prevRaw = nextRaw;
    nextRaw = applyPatchToCardData(prevRaw, change);
    if (diverged) continue; // 已判定分歧，只需继续累积应用剩余补丁

    // 条件 1：整体序列化前后比较（draft 侧 vs 无损轨，一变一不变即分歧）
    const draftChanged = JSON.stringify(prevDraft) !== JSON.stringify(nextDraft);
    const rawChanged = JSON.stringify(prevRaw) !== JSON.stringify(nextRaw);
    if (draftChanged !== rawChanged) {
      diverged = true;
      continue;
    }

    if (
      change.field === 'characters' &&
      (change.action === 'replace' || change.action === 'delete') &&
      change.id
    ) {
      // 条件 2：draft 侧命中而 rawCard 的 _meta.characters 落空
      if (draftChanged && !rawMetaHasCharacter(prevRaw, change.id)) {
        diverged = true;
        continue;
      }
      // 条件 3：draft 侧同步了关联世界书条目，无损轨的 character_book 未动
      if (change.action === 'replace') {
        const draftLoreChanged =
          JSON.stringify(prevDraft.lorebookEntries ?? []) !==
          JSON.stringify(nextDraft.lorebookEntries ?? []);
        const rawBookChanged =
          JSON.stringify(rawDataOf(prevRaw).character_book ?? null) !==
          JSON.stringify(rawDataOf(nextRaw).character_book ?? null);
        if (draftLoreChanged && !rawBookChanged) {
          diverged = true;
          continue;
        }
      }
    }

    // 条件 4：世界书 delete/replace「第一条 vs 全部」部分应用检测
    if (
      change.field === 'lorebookEntries' &&
      change.comment &&
      (change.action === 'delete' || change.action === 'replace')
    ) {
      const remaining = countRawLorebookMatches(nextRaw, change.comment);
      const renamed = typeof change.newComment === 'string' && change.newComment !== change.comment;
      // delete：draft 删光全部同名条目，raw 中不应再有残留（阈值 0）；
      // replace 改名：旧 comment 不应再有残留（阈值 0）；
      // replace 不改名：唯一命中条目更新后仍在（阈值 1），多于 1 条说明有未更新的同名条目。
      const threshold = change.action === 'delete' || renamed ? 0 : 1;
      if (remaining > threshold) diverged = true;
    }
  }

  return { nextDraft, nextRaw, diverged };
}

export function CardEditorChatPage() {
  const { addToast } = useToast();
  const { saveCard } = useCardLibrary();
  const { t } = useTranslation();

  const [draft, setDraft] = useState<WizardDraft | null>(null);
  /**
   * 无损通道底版：本次会话从外部导入（JSON/PNG）的原始卡 JSON。
   * draft 继续驱动 UI 展示与 diff 计算；用户确认的 ProposedChange 会同步
   * 累积应用到这份原始 JSON（applyPatchToCardData / applyPatchesToCardData），
   * 导出时优先使用它，绕过 cardToDraft → assembleCard 的有损往返。
   */
  const [rawCard, setRawCard] = useState<Record<string, unknown> | null>(null);
  /**
   * 无损通道分歧标记：某条已确认补丁在 rawCard 上被静默跳过或部分应用
   * （详见 applyChangesWithDivergenceCheck 的触发条件）。置位后无损导出
   * 关闭，导出/入库回退 assembleCard(draft)。随草稿持久化。
   */
  const [rawCardDiverged, setRawCardDiverged] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const streamingTextRef = useRef('');
  const lastRenderUpdateRef = useRef(0);
  const [pendingProposals, setPendingProposals] = useState<CardChatProposals | null>(null);
  const [changeDiffs, setChangeDiffs] = useState<ChangeDiff[]>([]);
  const [diffStatuses, setDiffStatuses] = useState<Array<'pending' | 'applied' | 'discarded'>>([]);
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [importedFileName, setImportedFileName] = useState<string | null>(null);
  const [coverImageBuffer, setCoverImageBuffer] = useState<ArrayBuffer | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [coverSource, setCoverSource] = useState<'imported' | 'custom' | 'default'>('default');
  const [expandedDiffs, setExpandedDiffs] = useState<Set<number>>(new Set());

  // ── Draft box state (auto-save / manual save / drafts modal) ──
  const [isDirty, setIsDirty] = useState(false);
  const [showDraftsModal, setShowDraftsModal] = useState(false);
  const [cardEditorDrafts, setCardEditorDrafts] = useState<WizardDraftRecord[]>([]);
  const [isRestoringAutoDraft, setIsRestoringAutoDraft] = useState(false);
  const isInitializedRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Skip the next mark-dirty trigger (set when importing/loading a draft,
   *  so the state replacement itself doesn't flag the editor as unsaved). */
  const skipNextDirtyRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isTouchDevice = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(pointer: coarse)').matches;
  }, []);

  /**
   * 无损导出卡：rawCard 存在、结构完整（非数组对象 + data 为非数组对象 +
   * spec 为字符串）且无损通道未分歧时可用。
   * exportAsJson/exportAsPng 只读取 card.data / spec / spec_version / _meta，
   * 原始 V2/V3 卡与 assembleCard 返回值形状兼容，直接透传。
   * 纯 V1 卡（无 data 块）、结构异常的 JSON、已分歧的通道均回退 assembleCard(draft)。
   */
  const losslessCard = useMemo(() => {
    if (!rawCard || rawCardDiverged) return null;
    if (Array.isArray(rawCard)) return null;
    const data = rawCard.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (typeof rawCard.spec !== 'string') return null;
    return rawCard as unknown as ReturnType<typeof assembleCard>;
  }, [rawCard, rawCardDiverged]);

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
  }, [messages, streamingText, isStreaming]);

  useEffect(() => {
    return () => {
      if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    };
  }, [coverPreviewUrl]);

  // 组件卸载时中止进行中的流式 AI 请求，避免后台继续消耗 token + 对已卸载组件 setState
  useEffect(() => {
    return () => { cancelActiveAIRequests(); };
  }, []);

  const updateCoverImage = useCallback((buffer: ArrayBuffer | null, source: 'imported' | 'custom' | 'default') => {
    setCoverPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return buffer ? URL.createObjectURL(new Blob([buffer], { type: 'image/png' })) : null;
    });
    setCoverImageBuffer(buffer);
    setCoverSource(source);
  }, []);

  // ── Restore auto-draft on mount (crash/reload recovery) ───────────────
  // Reads the fixed 'card-editor-new' record; if present, prompts the user
  // to restore the draft + chat history + cover state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const record = await loadCardEditorAutoDraft();
        if (cancelled || !record || !record.data) {
          isInitializedRef.current = true;
          return;
        }
        const restoredDraft = record.data as WizardDraft;
        const hasContent = (record.messages?.length ?? 0) > 0 || !!restoredDraft.cardName?.trim();
        if (!hasContent) {
          isInitializedRef.current = true;
          return;
        }
        setIsRestoringAutoDraft(true);
        const shouldRestore = window.confirm('检测到未保存的编辑室草稿，是否恢复？\n（取消将清除该自动草稿）');
        if (cancelled) return;
        if (shouldRestore) {
          setDraft(restoredDraft);
          setMessages((record.messages ?? []) as ChatMessage[]);
          // 一并还原无损通道底版（旧草稿无此字段时为 null，导出回退 assembleCard）
          setRawCard(
            record.rawCard && typeof record.rawCard === 'object'
              ? (record.rawCard as Record<string, unknown>)
              : null,
          );
          setRawCardDiverged(record.rawCardDiverged === true);
          const restoredCoverSource = (record.coverSource ?? 'default') as 'imported' | 'custom' | 'default';
          if (record.coverImageBlob) {
            try {
              const buffer = await record.coverImageBlob.arrayBuffer();
              updateCoverImage(buffer, restoredCoverSource);
            } catch {
              updateCoverImage(null, restoredCoverSource);
            }
          } else {
            updateCoverImage(null, restoredCoverSource);
          }
          // Restoring replaces the entire editor state — don't flag it as unsaved.
          // The skip flag is consumed by the mark-dirty effect after isRestoringAutoDraft flips to false.
          skipNextDirtyRef.current = true;
          setIsDirty(false);
          addToast('info', '已恢复上次未保存的编辑');
        } else {
          await clearCardEditorAutoDraft();
        }
      } catch {
        // silent fail — don't block the editor on restore errors
      } finally {
        if (!cancelled) {
          isInitializedRef.current = true;
          setIsRestoringAutoDraft(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mark dirty on changes (after initialization completes) ───────────
  // Any user-driven change to draft/messages/coverSource flags the editor
  // as unsaved, so the "●未保存" indicator shows and beforeunload can warn.
  // skipNextDirtyRef is set by import/load-draft flows to suppress the
  // false-positive dirty trigger caused by state replacement itself.
  useEffect(() => {
    if (!isInitializedRef.current || isRestoringAutoDraft) return;
    if (!draft) return;
    if (skipNextDirtyRef.current) {
      skipNextDirtyRef.current = false;
      return;
    }
    setIsDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, messages, coverSource, coverImageBuffer]);

  // ── Auto-save (debounced 800ms) ──────────────────────────────────────
  // Persists draft + messages + cover to 'card-editor-new' for crash recovery.
  // Clears isDirty on success so the unsaved indicator can disappear.
  useEffect(() => {
    if (!isInitializedRef.current || isRestoringAutoDraft) return;
    if (!draft) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      try {
        const blob = coverImageBuffer ? new Blob([coverImageBuffer], { type: 'image/png' }) : null;
        await saveCardEditorAutoDraft(
          draft,
          messages as CardEditorChatMessage[],
          coverSource,
          blob,
          rawCard ?? undefined,
          rawCardDiverged,
        );
        setIsDirty(false);
      } catch {
        // silent fail — auto-save errors shouldn't disrupt editing
      }
    }, 800);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, messages, coverSource, coverImageBuffer, rawCard, rawCardDiverged]);

  // ── beforeunload: warn when unsaved or streaming ─────────────────────
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty || isStreaming) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty, isStreaming]);

  // ── Manual save to drafts box ────────────────────────────────────────
  const handleSaveDraft = useCallback(async () => {
    if (!draft) return;
    try {
      const blob = coverImageBuffer ? new Blob([coverImageBuffer], { type: 'image/png' }) : null;
      await saveCardEditorDraft(draft, messages as CardEditorChatMessage[], coverSource, blob, undefined, rawCard ?? undefined, rawCardDiverged);
      setIsDirty(false);
      addToast('success', '已存入草稿箱');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败';
      addToast('error', msg);
    }
  }, [draft, messages, coverSource, coverImageBuffer, rawCard, rawCardDiverged, addToast]);

  // ── Open drafts modal ────────────────────────────────────────────────
  const handleOpenDrafts = useCallback(async () => {
    try {
      const drafts = await listCardEditorDrafts();
      setCardEditorDrafts(drafts);
      setShowDraftsModal(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载草稿箱失败';
      addToast('error', msg);
    }
  }, [addToast]);

  // ── Load a draft from drafts box ─────────────────────────────────────
  const handleLoadDraft = useCallback(async (id: string) => {
    try {
      const record = await loadCardEditorDraft(id);
      if (!record || !record.data) {
        addToast('error', '草稿不存在');
        return;
      }
      setDraft(record.data as WizardDraft);
      setMessages((record.messages ?? []) as ChatMessage[]);
      // 一并还原无损通道底版（无此字段的旧草稿置 null，避免残留上一张卡的底版）
      setRawCard(
        record.rawCard && typeof record.rawCard === 'object'
          ? (record.rawCard as Record<string, unknown>)
          : null,
      );
      setRawCardDiverged(record.rawCardDiverged === true);
      const restoredCoverSource = (record.coverSource ?? 'default') as 'imported' | 'custom' | 'default';
      if (record.coverImageBlob) {
        try {
          const buffer = await record.coverImageBlob.arrayBuffer();
          updateCoverImage(buffer, restoredCoverSource);
        } catch {
          updateCoverImage(null, restoredCoverSource);
        }
      } else {
        updateCoverImage(null, restoredCoverSource);
      }
      setShowDraftsModal(false);
      // Loading a draft replaces the entire editor state — don't flag it as unsaved.
      skipNextDirtyRef.current = true;
      setIsDirty(false);
      addToast('success', '草稿已加载');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败';
      addToast('error', msg);
    }
  }, [updateCoverImage, addToast]);

  // ── Delete a draft ───────────────────────────────────────────────────
  const handleDeleteDraft = useCallback(async (id: string) => {
    try {
      await deleteCardEditorDraft(id);
      setCardEditorDrafts((prev) => prev.filter((d) => d.id !== id));
      addToast('info', '草稿已删除');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '删除失败';
      addToast('error', msg);
    }
  }, [addToast]);

  // ── Change/remove a draft cover ──────────────────────────────────────
  const handleChangeDraftCover = useCallback(async (id: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const buffer = await resizeImageToPngBuffer(file, { maxDimension: 600 });
        const blob = new Blob([buffer], { type: 'image/png' });
        await updateCardEditorDraftCover(id, blob);
        setCardEditorDrafts((prev) => prev.map((d) => d.id === id ? { ...d, coverImageBlob: blob } : d));
        addToast('success', '封面已更换');
      } catch (err) {
        const msg = err instanceof Error ? err.message : '封面更换失败';
        addToast('error', msg);
      }
    };
    input.click();
  }, [addToast]);

  const handleRemoveDraftCover = useCallback(async (id: string) => {
    try {
      await updateCardEditorDraftCover(id, null);
      setCardEditorDrafts((prev) => prev.map((d) => {
        if (d.id !== id) return d;
        const next = { ...d } as Partial<WizardDraftRecord>;
        delete next.coverImageBlob;
        return next as WizardDraftRecord;
      }));
      addToast('info', '已恢复为默认封面');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '封面更换失败';
      addToast('error', msg);
    }
  }, [addToast]);

  // ── Load from drafts on empty state ──────────────────────────────────
  const handleLoadFromDraftsOnEmpty = useCallback(async () => {
    try {
      const drafts = await listCardEditorDrafts();
      if (drafts.length === 0) {
        addToast('info', '草稿箱为空');
        return;
      }
      setCardEditorDrafts(drafts);
      setShowDraftsModal(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载草稿箱失败';
      addToast('error', msg);
    }
  }, [addToast]);

  // ── Reset editor (clears auto-draft so next visit won't re-prompt) ──
  const handleResetEditor = useCallback(() => {
    setDraft(null);
    setRawCard(null);
    setRawCardDiverged(false);
    setMessages([]);
    setImportedFileName(null);
    setIsDirty(false);
    setPendingProposals(null);
    setChangeDiffs([]);
    setDiffStatuses([]);
    setShowDiffModal(false);
    void clearCardEditorAutoDraft();
  }, []);

  const handleImport = useCallback(async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.png,image/png,application/json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        let cardData: Record<string, unknown>;
        if (file.name.endsWith('.png') || file.type === 'image/png') {
          const buffer = await file.arrayBuffer();
          const extracted = await importFromPng(buffer);
          if (!extracted) {
            addToast('error', '无法从 PNG 中读取角色卡数据');
            return;
          }
          cardData = extracted;
          updateCoverImage(buffer, 'imported');
        } else {
          const text = await file.text();
          cardData = JSON.parse(text);
          updateCoverImage(null, 'default');
        }
        const parsedDraft = cardToDraft(cardData);
        setDraft(parsedDraft);
        // 保留原始卡 JSON 作为无损通道底版（JSON/PNG 两条导入路径共用）
        setRawCard(cardData);
        setRawCardDiverged(false);
        setImportedFileName(file.name);
        setMessages([]);
        setInputValue('');
        setPendingProposals(null);
        setChangeDiffs([]);
        setDiffStatuses([]);
        setShowDiffModal(false);
        // Import replaces the entire editor state — don't flag it as unsaved.
        skipNextDirtyRef.current = true;
        setIsDirty(false);
        addToast('success', '卡片导入成功，开始和 AI 对话修改吧');
      } catch (err) {
        const msg = err instanceof Error ? err.message : '导入失败';
        addToast('error', msg);
      }
    };
    input.click();
  }, [addToast, updateCoverImage]);

  const handleSend = useCallback(async () => {
    if (!draft || !inputValue.trim() || isStreaming) return;

    const userMsg: ChatMessage = { role: 'user', content: inputValue.trim() };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInputValue('');
    setIsStreaming(true);
    setStreamingText('');
    streamingTextRef.current = '';
    lastRenderUpdateRef.current = 0;

    try {
      const prompt = buildCardChatPrompt(draft, userMsg.content, updatedMessages);
      const apiMessages: AIMessage[] = [
        { role: 'system', content: prompt.system },
        ...updatedMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt.user },
      ];

      let fullText = '';
      await callAIStreaming({ messages: apiMessages }, (chunk) => {
        fullText += chunk;
        streamingTextRef.current = fullText;
        const now = Date.now();
        if (now - lastRenderUpdateRef.current >= 120) {
          lastRenderUpdateRef.current = now;
          setStreamingText(fullText);
        }
      });
      // 流结束：flush 最终文本确保完整显示
      setStreamingText(fullText);

      const assistantMsg: ChatMessage = { role: 'assistant', content: fullText };
      const finalMessages = [...updatedMessages, assistantMsg];
      setMessages(finalMessages);
      setStreamingText('');

      // Check if AI returned structured edits
      const proposals = parseCardChatEdits(fullText);
      if (proposals) {
        setPendingProposals(proposals);
        const diffs = computeCardChatDiffs(draft, proposals);
        setChangeDiffs(diffs);
        setDiffStatuses(diffs.map(() => 'pending' as const));
        setExpandedDiffs(new Set(diffs.map((_, i) => i)));
        setShowDiffModal(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI 响应失败';
      addToast('error', msg);
    } finally {
      setIsStreaming(false);
      setStreamingText('');
    }
  }, [draft, inputValue, isStreaming, messages, addToast]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isTouchDevice) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, isTouchDevice]);

  const textareaResizeRef = useCallback((el: HTMLTextAreaElement | null) => {
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }
  }, []);

  const closeDiffModal = useCallback(() => {
    setPendingProposals(null);
    setChangeDiffs([]);
    setDiffStatuses([]);
    setShowDiffModal(false);
  }, []);

  const applySingleDiff = useCallback((idx: number) => {
    if (!draft) return;
    const diff = changeDiffs[idx];
    if (!diff) return;
    // 双轨应用：draft 驱动 UI，rawCard 累积无损补丁；同时检测两轨是否分歧
    const { nextDraft, nextRaw, diverged } = applyChangesWithDivergenceCheck(draft, rawCard, [diff.change]);
    setDraft(nextDraft);
    setRawCard(nextRaw);
    if (diverged) setRawCardDiverged(true);
    setDiffStatuses((prev) => {
      const next = [...prev];
      next[idx] = 'applied';
      // Auto-close when no pending diffs remain
      if (!next.some((s) => s === 'pending')) {
        setTimeout(() => {
          setPendingProposals(null);
          setChangeDiffs([]);
          setDiffStatuses([]);
          setShowDiffModal(false);
        }, 0);
      }
      return next;
    });
    const name = diffDisplayName(diff);
    addToast('success', `已应用：${name}`);
  }, [draft, rawCard, changeDiffs, addToast]);

  const discardSingleDiff = useCallback((idx: number) => {
    setDiffStatuses((prev) => {
      const next = [...prev];
      next[idx] = 'discarded';
      // Auto-close when no pending diffs remain
      if (!next.some((s) => s === 'pending')) {
        setTimeout(() => {
          setPendingProposals(null);
          setChangeDiffs([]);
          setDiffStatuses([]);
          setShowDiffModal(false);
        }, 0);
      }
      return next;
    });
    const diff = changeDiffs[idx];
    const name = diff ? diffDisplayName(diff) : '';
    addToast('info', `已舍弃：${name}`);
  }, [changeDiffs, addToast]);

  const applyAllPending = useCallback(() => {
    if (!draft || !pendingProposals) return;
    const pendingDiffs = changeDiffs
      .map((d, i) => ({ diff: d, idx: i }))
      .filter(({ idx }) => diffStatuses[idx] === 'pending');
    if (pendingDiffs.length === 0) return;
    // 逐条双轨应用（与 applyCardChatPatch 批量应用等价，见 helper 注释），
    // 顺带对每条补丁做无损通道分歧检测。
    const pendingChanges = pendingDiffs.map(({ diff }) => diff.change);
    const { nextDraft, nextRaw, diverged } = applyChangesWithDivergenceCheck(draft, rawCard, pendingChanges);
    setDraft(nextDraft);
    setRawCard(nextRaw);
    if (diverged) setRawCardDiverged(true);
    setDiffStatuses(changeDiffs.map(() => 'applied' as const));
    addToast('success', `已应用 ${pendingDiffs.length} 项修改`);
    setTimeout(() => {
      setPendingProposals(null);
      setChangeDiffs([]);
      setDiffStatuses([]);
      setShowDiffModal(false);
    }, 0);
  }, [draft, rawCard, pendingProposals, changeDiffs, diffStatuses, addToast]);

  const discardAllPending = useCallback(() => {
    const cnt = diffStatuses.filter((s) => s === 'pending').length;
    setDiffStatuses((prev) => prev.map((s) => s === 'pending' ? 'discarded' as const : s));
    if (cnt > 0) {
      addToast('info', `已舍弃 ${cnt} 项修改`);
    }
    setTimeout(() => {
      setPendingProposals(null);
      setChangeDiffs([]);
      setDiffStatuses([]);
      setShowDiffModal(false);
    }, 0);
  }, [diffStatuses, addToast]);

  const pendingCount = diffStatuses.filter((s) => s === 'pending').length;
  const appliedCount = diffStatuses.filter((s) => s === 'applied').length;

  const handleSaveToLibrary = useCallback(async () => {
    if (!draft) return;
    try {
      // 与导出一致：无损通道可用（未分歧）时，入库记录直接使用
      // 「原始 JSON + 已确认补丁」；name/时间戳等库级元数据仍由 saveCard 生成。
      const id = await saveCard(draft, undefined, losslessCard ?? undefined, 'editor');
      addToast('success', `已保存到卡库（ID: ${id}）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败';
      addToast('error', msg);
    }
  }, [draft, losslessCard, saveCard, addToast]);

  const openExportModal = useCallback(() => {
    if (!draft) return;
    setShowExportModal(true);
  }, [draft]);

  const handleChooseCoverImage = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const buffer = await resizeImageToPngBuffer(file, { maxDimension: 1536 });
        updateCoverImage(buffer, 'custom');
        addToast('success', '封面图片已更换');
      } catch (err) {
        const msg = err instanceof Error ? err.message : '图片处理失败';
        addToast('error', msg);
      }
    };
    input.click();
  }, [addToast, updateCoverImage]);

  const handleUseDefaultCover = useCallback(() => {
    updateCoverImage(null, 'default');
    addToast('info', '已改为默认白图封装');
  }, [addToast, updateCoverImage]);

  const handleExportPng = useCallback(async () => {
    if (!draft) return;
    try {
      // 无损通道：外部导入的卡直接导出「原始 JSON + 已确认补丁」；否则走 assembleCard
      const card = losslessCard ?? assembleCard(draft);
      await exportAsPng(card, coverImageBuffer || undefined);
      setShowExportModal(false);
      addToast('success', 'PNG 导出成功');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '导出失败';
      addToast('error', msg);
    }
  }, [draft, losslessCard, coverImageBuffer, addToast]);

  const handleExportJson = useCallback(async () => {
    if (!draft) return;
    try {
      // 无损通道：外部导入的卡直接导出「原始 JSON + 已确认补丁」；否则走 assembleCard
      const card = losslessCard ?? assembleCard(draft);
      exportAsJson(card);
      setShowExportModal(false);
      addToast('success', 'JSON 导出成功');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '导出失败';
      addToast('error', msg);
    }
  }, [draft, losslessCard, addToast]);

  const toggleDiff = useCallback((idx: number) => {
    setExpandedDiffs((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const quickPrompts = [
    '把剧情从 NTR 改成纯爱',
    '让角色性格更温柔一些',
    '改一下开场白，让主角更主动',
    '增加一条关于身世的世界书条目',
  ];

  if (!draft) {
    return (
      <div className="animate-fade-in flex flex-col items-center justify-center h-[calc(100dvh-4rem)] px-4">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-color)' }}>AI 卡片编辑室</h1>
          <p className="text-sm mb-6" style={{ color: mutedText }}>
            导入 JSON 或 PNG 角色卡，通过对话让 AI 帮你修改剧情、人设、世界书等内容。
          </p>
          <Button variant="primary" size="lg" onClick={handleImport} className="gap-2">
            <Upload size={18} />
            导入角色卡
          </Button>
          <button
            onClick={handleLoadFromDraftsOnEmpty}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg border transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)] inline-flex items-center gap-1.5"
            style={{ borderColor, color: mutedText }}
          >
            <FolderOpen size={14} />
            从草稿箱加载
          </button>
          <p className="text-xs mt-4" style={{ color: faintText }}>
            支持 .json 文件和 SillyTavern 格式的 .png 卡片
          </p>
        </div>
        <DraftsModal
          isOpen={showDraftsModal}
          onClose={() => setShowDraftsModal(false)}
          drafts={cardEditorDrafts}
          onLoad={handleLoadDraft}
          onDelete={handleDeleteDraft}
          onChangeCover={handleChangeDraftCover}
          onRemoveCover={handleRemoveDraftCover}
        />
      </div>
    );
  }

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100dvh-7rem)] md:h-[calc(100dvh-4rem)]">
      {/* Header */}
      <div className="shrink-0 px-4 sm:px-6 py-3 border-b flex flex-wrap items-center justify-between gap-3" style={{ borderColor }}>
        <div className="min-w-0 flex items-center gap-3">
          <button
            onClick={handleResetEditor}
            className="text-xs px-2 py-1 rounded border transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
            style={{ borderColor, color: mutedText }}
          >
            重新导入
          </button>
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-semibold truncate flex items-center gap-1.5" style={{ color: 'var(--text-color)' }}>
              <span className="truncate">{draft.cardName || '未命名卡片'}</span>
              {isDirty && (
                <span
                  title="有未保存的修改"
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ background: 'var(--color-warning, #e0a020)' }}
                />
              )}
            </h1>
            <p className="text-xs truncate" style={{ color: faintText }}>
              {importedFileName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="ghost" size="sm" onClick={handleSaveDraft} className="gap-1" title="保存到草稿箱">
            <Save size={14} />
            存草稿
          </Button>
          <Button variant="ghost" size="sm" onClick={handleOpenDrafts} className="gap-1" title="打开草稿箱">
            <FolderOpen size={14} />
            草稿箱
          </Button>
          <Button variant="secondary" size="sm" onClick={handleSaveToLibrary} className="gap-1">
            <Save size={14} />
            保存到卡库
          </Button>
          {losslessCard && (
            <span
              title={t('cardEditorChat.losslessHint')}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-status-success) 45%, transparent)',
                color: 'var(--color-status-success)',
              }}
            >
              <ShieldCheck size={11} />
              {t('cardEditorChat.losslessBadge')}
            </span>
          )}
          {!losslessCard && rawCard && rawCardDiverged && (
            <span
              title={t('cardEditorChat.losslessDivergedHint')}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-text-muted) 45%, transparent)',
                color: 'var(--color-text-muted)',
              }}
            >
              <ShieldOff size={11} />
              {t('cardEditorChat.losslessDisabledBadge')}
            </span>
          )}
          <Button variant="primary" size="sm" onClick={openExportModal} className="gap-1">
            <ImageIcon size={14} />
            导出
          </Button>
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4">
          {messages.length === 0 && !isStreaming && (
            <div className="text-center py-12 sm:py-16">
              <p className="text-sm mb-4 sm:mb-6" style={{ color: mutedText }}>
                描述你想做的修改，例如“把剧情从 NTR 改成纯爱”。
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg mx-auto px-2">
                {quickPrompts.map((hint) => (
                  <button
                    key={hint}
                    onClick={() => { setInputValue(hint); textareaRef.current?.focus(); }}
                    className="text-left text-sm px-3 py-2 rounded-lg border transition-colors cursor-pointer"
                    style={{
                      borderColor: 'var(--color-border-default)',
                      backgroundColor: 'color-mix(in srgb, var(--color-surface-raised) 50%, transparent)',
                      color: 'var(--color-text-muted)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--text-color)';
                      e.currentTarget.style.borderColor = 'var(--color-text-secondary)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--color-text-muted)';
                      e.currentTarget.style.borderColor = 'var(--color-border-default)';
                    }}
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[90%] sm:max-w-[85%] rounded-xl px-3 sm:px-4 py-2.5 sm:py-3 text-sm whitespace-pre-wrap leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-primary text-inverse'
                  : 'border'
              }`}
              style={msg.role === 'user' ? {} : {
                backgroundColor: surfaceRaisedTransparent,
                borderColor,
              }}>
                {msg.content}
              </div>
            </div>
          ))}

          {isStreaming && (
            <div className="flex justify-start">
              <div className="max-w-[90%] sm:max-w-[85%] rounded-xl px-3 sm:px-4 py-2.5 sm:py-3 text-sm border whitespace-pre-wrap leading-relaxed"
                style={{ backgroundColor: surfaceRaisedTransparent, borderColor }}>
                {streamingText || <span className="animate-pulse" style={{ color: mutedText }}>思考中...</span>}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 border-t px-3 sm:px-4 py-2.5 sm:py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" style={{ borderColor }}>
          <div className="flex gap-2 items-end">
            <textarea
              ref={(el) => { textareaResizeRef(el); (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el; }}
              className="flex-1 rounded-lg border px-3 sm:px-4 py-2 sm:py-2.5 text-sm
                focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]
                resize-none min-h-[38px] sm:min-h-[42px] max-h-[160px]"
              style={{ borderColor: 'var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--text-color)' }}
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                textareaResizeRef(e.currentTarget);
              }}
              onKeyDown={handleKeyDown}
              placeholder={isTouchDevice ? '输入修改需求...' : '输入修改需求，按 Enter 发送，Shift+Enter 换行'}
              disabled={isStreaming}
              rows={1}
            />
            <Button onClick={handleSend} disabled={!inputValue.trim() || isStreaming}>
              {isStreaming ? '...' : '发送'}
            </Button>
          </div>
        </div>
      </div>

      {/* Export Modal */}
      {showExportModal && (
        <Modal isOpen={showExportModal} onClose={() => setShowExportModal(false)} title="导出角色卡" maxWidth="max-w-3xl">
          <div className="space-y-4">
            <div className="text-xs" style={{ color: mutedText }}>
              可更换封装封面图片。导入自 PNG 的角色卡默认保留原图；导入自 JSON 的角色卡可上传新图，或直接使用默认白图。
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              <div className="shrink-0 mx-auto sm:mx-0">
                <div
                  className="w-40 h-56 rounded-lg border flex items-center justify-center overflow-hidden"
                  style={{ borderColor, backgroundColor: 'var(--color-surface-base)' }}
                >
                  {coverPreviewUrl ? (
                    <img src={coverPreviewUrl} alt="cover preview" className="w-full h-full object-cover" />
                  ) : (
                    <div className="text-center px-3">
                      <ImageIcon size={32} style={{ color: faintText }} className="mx-auto mb-2" />
                      <span className="text-xs" style={{ color: faintText }}>默认白图</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex-1 space-y-3">
                <div className="text-sm font-medium" style={{ color: 'var(--text-color)' }}>封面图片</div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={handleChooseCoverImage} className="gap-1">
                    <Upload size={14} />
                    更换图片
                  </Button>
                  {coverSource !== 'default' && (
                    <Button variant="ghost" size="sm" onClick={handleUseDefaultCover}>
                      使用默认白图
                    </Button>
                  )}
                </div>
                <div className="text-xs" style={{ color: faintText }}>
                  {coverSource === 'imported' && '当前使用原 PNG 的封面，可继续保留或更换。'}
                  {coverSource === 'custom' && '当前使用你上传的封面图片。'}
                  {coverSource === 'default' && '当前使用默认白图作为导出占位图。'}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t" style={{ borderColor }}>
              {losslessCard ? (
                <div
                  className="flex items-center gap-1.5 text-xs"
                  style={{ color: 'var(--color-status-success)' }}
                >
                  <ShieldCheck size={13} className="shrink-0" />
                  <span>{t('cardEditorChat.losslessHint')}</span>
                </div>
              ) : rawCard && rawCardDiverged ? (
                <div
                  className="flex items-center gap-1.5 text-xs"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <ShieldOff size={13} className="shrink-0" />
                  <span>{t('cardEditorChat.losslessDivergedHint')}</span>
                </div>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowExportModal(false)}>
                  取消
                </Button>
                <Button variant="secondary" size="sm" onClick={handleExportJson} className="gap-1">
                  <FileJson size={14} />
                  导出 JSON
                </Button>
                <Button variant="primary" size="sm" onClick={handleExportPng} className="gap-1">
                  <ImageIcon size={14} />
                  导出 PNG
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Diff Modal */}
      {showDiffModal && (
        <Modal isOpen={showDiffModal} onClose={closeDiffModal} title="AI 修改建议" maxWidth="max-w-4xl">
          <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            <p className="text-xs" style={{ color: mutedText }}>
              AI 提出了 {changeDiffs.length} 项修改，可逐条应用或舍弃。已应用 {appliedCount} 项，待处理 {pendingCount} 项。
            </p>
            {changeDiffs.length === 0 ? (
              <p className="text-sm" style={{ color: mutedText }}>没有检测到有效改动。</p>
            ) : (
              changeDiffs.map((diff, idx) => {
                const status = diffStatuses[idx] || 'pending';
                const isPending = status === 'pending';
                return (
                  <div key={idx} className="rounded-lg border" style={{
                    borderColor,
                    backgroundColor: status === 'discarded' ? 'color-mix(in srgb, var(--color-surface-base) 60%, transparent)' : cardBgSemiTransparent,
                    opacity: status === 'discarded' ? 0.55 : 1,
                  }}>
                    <div
                      className="flex items-center justify-between px-3 py-2 cursor-pointer select-none"
                      onClick={() => toggleDiff(idx)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {expandedDiffs.has(idx) ? <ChevronUp size={14} style={{ color: faintText }} /> : <ChevronDown size={14} style={{ color: faintText }} />}
                        <span className="text-sm font-medium truncate" style={{ color: 'var(--text-color)' }}>
                          {diffDisplayName(diff)}
                        </span>
                        <span className="text-[10px] shrink-0" style={{ color: faintText }}>{fieldLabel(diff.change.field)}</span>
                        {diff.hasChange ? (
                          <span className="text-[10px] shrink-0" style={{ color: 'var(--color-status-warning)' }}>有改动</span>
                        ) : (
                          <span className="text-[10px] shrink-0" style={{ color: faintText }}>无变化</span>
                        )}
                        {status === 'applied' && (
                          <span className="text-[10px] shrink-0 rounded px-1.5 py-0.5" style={{ backgroundColor: 'color-mix(in srgb, var(--color-status-success) 20%, transparent)', color: 'var(--color-status-success)' }}>已应用</span>
                        )}
                        {status === 'discarded' && (
                          <span className="text-[10px] shrink-0 rounded px-1.5 py-0.5" style={{ backgroundColor: 'color-mix(in srgb, var(--color-text-muted) 20%, transparent)', color: 'var(--color-text-muted)' }}>已舍弃</span>
                        )}
                      </div>
                      {isPending && (
                        <div className="flex items-center gap-1 shrink-0 ml-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => discardSingleDiff(idx)}
                            className="text-[11px] px-2 py-1 rounded border transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_8%,transparent)]"
                            style={{ borderColor: 'color-mix(in srgb, var(--color-border-default) 70%, transparent)', color: mutedText }}
                          >
                            舍弃
                          </button>
                          <button
                            onClick={() => applySingleDiff(idx)}
                            disabled={!diff.hasChange}
                            className="text-[11px] px-2 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{ backgroundColor: 'var(--color-primary)', color: 'var(--color-text-inverse)' }}
                          >
                            应用
                          </button>
                        </div>
                      )}
                    </div>
                    {expandedDiffs.has(idx) && (
                      <div className="px-3 pb-3 border-t space-y-2" style={{ borderColor: 'color-mix(in srgb, var(--color-border-default) 50%, transparent)' }}>
                        <DiffValue label="修改前" value={diff.before} />
                        <DiffValue label="修改后" value={diff.after} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="flex justify-between items-center mt-4 pt-3 border-t" style={{ borderColor }}>
            <Button variant="ghost" size="sm" onClick={closeDiffModal} className="gap-1">
              <X size={14} />
              关闭
            </Button>
            <div className="flex gap-2">
              {pendingCount > 0 && (
                <>
                  <Button variant="ghost" size="sm" onClick={discardAllPending}>
                    全部舍弃
                  </Button>
                  <Button variant="primary" size="sm" onClick={applyAllPending} className="gap-1">
                    <Check size={14} />
                    全部应用（{pendingCount}）
                  </Button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Drafts Modal */}
      <DraftsModal
        isOpen={showDraftsModal}
        onClose={() => setShowDraftsModal(false)}
        drafts={cardEditorDrafts}
        onLoad={handleLoadDraft}
        onDelete={handleDeleteDraft}
        onChangeCover={handleChangeDraftCover}
        onRemoveCover={handleRemoveDraftCover}
      />
    </div>
  );
}

function DiffValue({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <div>
        <div className="text-[10px] mb-1" style={{ color: faintText }}>{label}</div>
        <div className="text-xs italic" style={{ color: faintText }}>（无）</div>
      </div>
    );
  }

  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    text = JSON.stringify(value, null, 2);
  }

  return (
    <div>
      <div className="text-[10px] mb-1" style={{ color: faintText }}>{label}</div>
      <pre className="text-xs whitespace-pre-wrap break-words rounded p-2 border max-h-[200px] overflow-y-auto"
        style={{ backgroundColor: cardBgDarkerSemiTransparent, borderColor, color: 'var(--text-color)' }}>
        {text}
      </pre>
    </div>
  );
}

// ── Drafts Modal — lists card-editor drafts with load/delete/cover actions ──
interface DraftsModalProps {
  isOpen: boolean;
  onClose: () => void;
  drafts: WizardDraftRecord[];
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onChangeCover: (id: string) => void;
  onRemoveCover: (id: string) => void;
}

function DraftsModal({ isOpen, onClose, drafts, onLoad, onDelete, onChangeCover, onRemoveCover }: DraftsModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="草稿箱" maxWidth="max-w-3xl">
      <div className="max-h-[70vh] overflow-y-auto pr-1">
        {drafts.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: 'var(--color-text-muted)' }}>
            草稿箱为空
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {drafts.map((d) => {
              const draftData = d.data as WizardDraft;
              // Strip the auto-generated time suffix from the title; the small
              // subtitle below already shows the save time.
              const displayName = stripTrailingTime(d.name || '') || draftData.cardName || '未命名草稿';
              const msgCount = d.messages?.length ?? 0;
              const timeStr = d.updatedAt.toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              });
              const hasCustomCover = !!d.coverImageBlob;
              return (
                <div
                  key={d.id}
                  className="group rounded-lg border overflow-hidden flex flex-col"
                  style={{ borderColor, backgroundColor: cardBgSemiTransparent }}
                >
                  <div className="relative">
                    <CardCover blob={d.coverImageBlob ?? null} name={displayName} />
                    <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => {
                          if (window.confirm(`删除草稿「${displayName}」？`)) onDelete(d.id);
                        }}
                        title="删除草稿"
                        className="w-6 h-6 rounded-md backdrop-blur-sm bg-black/55 text-white flex items-center justify-center hover:bg-red-600/80 transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="absolute bottom-1.5 left-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => onChangeCover(d.id)}
                        title="更换封面"
                        className="flex-1 h-6 rounded-md backdrop-blur-sm bg-black/55 text-white text-[10px] flex items-center justify-center gap-1 hover:bg-black/75 transition-colors"
                      >
                        <ImageIcon size={10} />
                        更换封面
                      </button>
                      {hasCustomCover && (
                        <button
                          onClick={() => onRemoveCover(d.id)}
                          title="移除封面"
                          className="w-6 h-6 rounded-md backdrop-blur-sm bg-black/55 text-white flex items-center justify-center hover:bg-black/75 transition-colors"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="p-2 flex-1 flex flex-col">
                    <div className="text-xs font-medium truncate" style={{ color: 'var(--text-color)' }} title={displayName}>
                      {displayName}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: faintText }}>
                      {timeStr}{msgCount > 0 ? ` · ${msgCount} 条对话` : ''}
                    </div>
                    <button
                      onClick={() => onLoad(d.id)}
                      className="mt-auto pt-2 text-[11px] px-2 py-1 rounded border transition-colors hover:bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]"
                      style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
                    >
                      加载
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
