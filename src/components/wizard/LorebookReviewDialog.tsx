/**
 * LorebookReviewDialog — 内联展开式的「预览与修改」面板.
 *
 * Step 2（锚定世界观）和 Step 4（世界书细节）共享：AI 生成条目后不直接合入主世界书，
 * 而是进入这个草稿态。用户可以：
 *   - 浏览当前草稿条目（折叠展示 name / keys / 常驻标记 / content 预览）
 *   - 在对话框里输入修改需求，点「AI 修改」→ 调用 reviseLorebookEntriesStreaming
 *     流式预览 AI 输出 → 完成后整体替换草稿
 *   - 「重新生成」→ 调用父组件注入的 onRegenerate（基于原始输入重跑一次）
 *   - 「导入」→ onImport(draftEntries) 一次性合入主列表
 *   - 「放弃」→ onDiscard() 丢弃草稿，主列表不动
 *
 * 替换式（非 patch）语义：每次 AI 修改返回完整新版数组，调用方重新分配 id。
 */
import { useState } from 'react';
import { useTranslation } from '../../i18n/I18nContext';
import { useToast } from '../shared/Toast';
import { AIProgressPanel, type AIProgressStatus } from '../shared/AIProgressPanel';
import { useAIGenerate } from '../../hooks/useAIGenerate';
import { themeAlpha } from '../../constants/theme';
import { mapAiEntriesToLorebookEntries } from '../../services/lorebook-revise';
import type { LorebookEntry } from '../../constants/defaults';

interface LorebookReviewDialogProps {
  /** 当前草稿条目（由父组件持有，本组件只读 + 整体替换） */
  draftEntries: LorebookEntry[];
  /** 父组件更新草稿（AI 修改/重新生成后调用） */
  onDraftChange: (entries: LorebookEntry[]) => void;
  /** 导入到主世界书列表 */
  onImport: (entries: LorebookEntry[]) => void;
  /** 放弃草稿 */
  onDiscard: () => void;
  /** 重新生成（父组件实现，覆盖当前草稿）。返回是否成功（false=失败或未实现） */
  onRegenerate: () => Promise<boolean>;
  cardName: string;
  /** formatWorldAnchorForPrompt(...) 的输出，作为 AI 修改的硬约束 */
  anchorText: string;
  nsfw?: boolean;
  /** 标题（默认用 i18n lorebookReview.title） */
  title?: string;
  /** 是否允许「重新生成」。Step 4 的批量生成可同时 update+create，重新生成语义复杂，可禁用 */
  canRegenerate?: boolean;
}

export function LorebookReviewDialog({
  draftEntries,
  onDraftChange,
  onImport,
  onDiscard,
  onRegenerate,
  cardName,
  anchorText,
  nsfw,
  title,
  canRegenerate = true,
}: LorebookReviewDialogProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { reviseLorebookEntriesStreaming } = useAIGenerate();
  const [requestText, setRequestText] = useState('');
  const [reviseStatus, setReviseStatus] = useState<AIProgressStatus>('idle');
  const [reviseStream, setReviseStream] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const C = {
    text: 'var(--text-color)',
    secondary: 'var(--color-text-secondary)',
    muted: 'var(--color-text-muted)',
    border: 'var(--color-border-default)',
    surface: 'var(--color-surface-raised)',
    inputBg: 'var(--input-bg)',
    inputBorder: 'var(--input-border)',
    primary: 'var(--color-primary)',
    warning: 'var(--color-status-warning)',
    success: 'var(--color-status-success)',
  } as const;

  const busy = reviseStatus === 'generating' || regenerating;

  const handleRevise = async () => {
    const req = requestText.trim();
    if (!req) {
      addToast('error', t('lorebookReview.requestEmpty'));
      return;
    }
    if (draftEntries.length === 0) {
      addToast('error', t('lorebookReview.draftEmpty'));
      return;
    }
    setReviseStatus('generating');
    setReviseStream('');
    try {
      const result = await reviseLorebookEntriesStreaming(
        cardName,
        anchorText,
        draftEntries,
        req,
        (_chunk, fullText) => setReviseStream(fullText),
        nsfw,
      );
      if (Array.isArray(result) && result.length > 0) {
        const mapped = mapAiEntriesToLorebookEntries(result);
        // 保留原草稿里 fromAnchor 等运行时标记（仅 Step 2 锚定条目场景）
        // 简单策略：如果原草稿全部 fromAnchor=true，新条目也标记 fromAnchor
        const allFromAnchor = draftEntries.length > 0 && draftEntries.every((e) => e.fromAnchor === true);
        const finalEntries = allFromAnchor
          ? mapped.map((e) => ({ ...e, fromAnchor: true }))
          : mapped;
        onDraftChange(finalEntries);
        addToast('success', t('lorebookReview.reviseDone', { count: String(finalEntries.length) }));
        setReviseStatus('done');
        setRequestText('');
      } else {
        addToast('error', t('lorebookReview.reviseParseFailed'));
        setReviseStatus('error');
        setReviseStream(t('lorebookReview.reviseParseFailed'));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setReviseStatus('error');
      setReviseStream(msg);
      addToast('error', t('lorebookReview.reviseFailed', { message: msg }));
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const ok = await onRegenerate();
      if (ok) {
        setReviseStatus('idle');
        setReviseStream('');
      }
    } finally {
      setRegenerating(false);
    }
  };

  const handleImport = () => {
    if (draftEntries.length === 0) return;
    onImport(draftEntries);
  };

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const surfaceA = (n: number) => `color-mix(in srgb, ${C.surface} ${n}%, transparent)`;

  return (
    <div
      className="rounded-xl mt-3"
      style={{
        border: `1.5px solid ${themeAlpha('primary', 50)}`,
        background: themeAlpha('primary', 6),
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-3"
        style={{ borderBottom: `1px solid ${themeAlpha('primary', 25)}` }}
      >
        <span style={{ fontSize: '14px' }}>📝</span>
        <span style={{ fontSize: '14px', fontWeight: 700, color: C.text }}>
          {title || t('lorebookReview.title')}
        </span>
        <span
          className="rounded-full border px-2 py-0.5 text-[10px]"
          style={{
            borderColor: themeAlpha('primary', 35),
            backgroundColor: themeAlpha('primary', 10),
            color: C.primary,
          }}
        >
          {t('lorebookReview.draftCount', { count: String(draftEntries.length) })}
        </span>
        <span style={{ fontSize: '11px', color: C.muted, marginLeft: 'auto' }}>
          {t('lorebookReview.hint')}
        </span>
      </div>

      <div className="px-4 pb-4 pt-3" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* 草稿条目列表（精简展示） */}
        <div className="space-y-2">
          {draftEntries.map((entry, idx) => {
            const isMaster = entry.constant === true && /世界书$/.test(entry.name || '');
            const expanded = expandedId === entry.id;
            const contentPreview = (entry.content || '').slice(0, 120);
            const contentRest = (entry.content || '').slice(120);
            return (
              <div
                key={entry.id}
                className="rounded-lg border p-2.5"
                style={{
                  borderColor: isMaster ? themeAlpha('warning', 45) : C.border,
                  backgroundColor: surfaceA(40),
                }}
              >
                <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                  <span className="text-xs font-semibold" style={{ color: C.text }}>
                    {idx + 1}. {entry.name || entry.comment || t('lorebookReview.untitledEntry')}
                  </span>
                  {entry.constant ? (
                    <span
                      className="rounded border px-1.5 py-0.5 text-[10px]"
                      style={{ borderColor: themeAlpha('primary', 50), backgroundColor: themeAlpha('primary', 15), color: C.primary }}
                    >
                      🔵 {t('lorebookReview.constantBadge')}
                    </span>
                  ) : (
                    <span
                      className="rounded border px-1.5 py-0.5 text-[10px]"
                      style={{ borderColor: themeAlpha('success', 50), backgroundColor: themeAlpha('success', 15), color: C.success }}
                    >
                      🟢 {t('lorebookReview.selectiveBadge')}
                    </span>
                  )}
                  {isMaster && (
                    <span
                      className="rounded border px-1.5 py-0.5 text-[10px]"
                      style={{ borderColor: themeAlpha('warning', 50), backgroundColor: themeAlpha('warning', 15), color: C.warning }}
                    >
                      ⚓ {t('lorebookReview.masterBadge')}
                    </span>
                  )}
                  {entry.keys && entry.keys.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap ml-1">
                      {entry.keys.slice(0, 4).map((k, i) => (
                        <span
                          key={i}
                          className="rounded px-1.5 py-0.5 text-[10px]"
                          style={{ background: surfaceA(80), color: C.secondary }}
                        >
                          {k}
                        </span>
                      ))}
                      {entry.keys.length > 4 && (
                        <span className="text-[10px]" style={{ color: C.muted }}>
                          +{entry.keys.length - 4}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div
                  className="text-xs leading-relaxed cursor-pointer"
                  style={{ color: C.secondary, whiteSpace: 'pre-wrap' }}
                  onClick={() => toggleExpand(entry.id)}
                >
                  {contentPreview}
                  {!expanded && contentRest && (
                    <span style={{ color: C.muted }}> …{t('lorebookReview.clickToExpand')}</span>
                  )}
                  {expanded && contentRest && <span>{contentRest}</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* 修改对话框 */}
        <div>
          <label
            className="block mb-1.5"
            style={{ fontSize: '12px', fontWeight: 600, color: C.secondary }}
          >
            {t('lorebookReview.requestLabel')}
          </label>
          <textarea
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            placeholder={t('lorebookReview.requestPlaceholder')}
            style={{
              width: '100%',
              minHeight: '70px',
              padding: '8px 10px',
              borderRadius: '8px',
              border: `1px solid ${C.inputBorder}`,
              background: C.inputBg,
              color: C.text,
              fontSize: '13px',
              lineHeight: '1.5',
              resize: 'vertical',
              outline: 'none',
            }}
            rows={3}
            disabled={busy}
          />
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleRevise}
            disabled={busy || !requestText.trim() || draftEntries.length === 0}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg font-medium px-4 py-2 text-sm
              bg-gradient-success text-[var(--text-color)] shadow
              hover:scale-105 active:scale-95 transition-all
              disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 cursor-pointer"
          >
            {reviseStatus === 'generating' ? `⏳ ${t('lorebookReview.revising')}` : `✏️ ${t('lorebookReview.reviseButton')}`}
          </button>
          {canRegenerate && (
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg font-medium px-4 py-2 text-sm
                cursor-pointer transition-all hover:scale-105 active:scale-95
                disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{
                border: `1px solid ${C.inputBorder}`,
                background: 'transparent',
                color: C.text,
              }}
            >
              {regenerating ? `⏳ ${t('lorebookReview.regenerating')}` : `🔄 ${t('lorebookReview.regenerateButton')}`}
            </button>
          )}
          <button
            type="button"
            onClick={handleImport}
            disabled={busy || draftEntries.length === 0}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg font-medium px-4 py-2 text-sm
              cursor-pointer transition-all hover:scale-105 active:scale-95
              disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            style={{
              border: `1px solid ${themeAlpha('success', 50)}`,
              background: themeAlpha('success', 12),
              color: C.success,
            }}
          >
            ⬇️ {t('lorebookReview.importButton', { count: String(draftEntries.length) })}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg font-medium px-4 py-2 text-sm
              cursor-pointer transition-all hover:scale-105 active:scale-95
              disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            style={{
              border: `1px solid ${C.inputBorder}`,
              background: 'transparent',
              color: C.muted,
            }}
          >
            ✕ {t('lorebookReview.discardButton')}
          </button>
        </div>

        {/* 流式预览 */}
        {reviseStatus !== 'idle' && (
          <AIProgressPanel
            status={reviseStatus}
            text={reviseStream}
            title={t('lorebookReview.progressTitle')}
            onClear={() => { setReviseStatus('idle'); setReviseStream(''); }}
          />
        )}
      </div>
    </div>
  );
}
