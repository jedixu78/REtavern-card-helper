/**
 * ChatPage - Test chat with character cards.
 *
 * 试聊不只是「跟卡聊两句」，而是导出前的验证闭环：
 *   - 世界书按 ST 语义真实扫描，触发检查器当场解释「这条绿灯为什么没亮」；
 *   - 卡内正则脚本应用到显示文本，状态栏 / 直播间面板在沙盒 iframe 里真渲染；
 *   - 流式输出 + 停止 + 重 roll，贴近 ST 的实际手感。
 * 支持 `/chat?cardId=N` 直接打开指定卡片。
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useCardLibrary } from '../hooks/useCardLibrary';
import { useAIChat } from '../hooks/useAIChat';
import { Button } from '../components/shared/Button';
import { useTranslation } from '../i18n/I18nContext';
import {
  applyRegexScripts,
  segmentRenderedMessage,
  buildSandboxSrcDoc,
  parseChatFrameMessage,
  type CardRegexScript,
  type ChatRole,
} from '../services/chat-render';
import type { ActivatedEntry, SkippedEntry, SkipReason, TriggerResult } from '../services/lorebook-trigger';

const borderColor = 'var(--color-border-default)';
const mutedText = 'color-mix(in srgb, var(--text-color) 60%, transparent)';
const faintText = 'color-mix(in srgb, var(--text-color) 40%, transparent)';

/** 条目显示名：name → comment → 关键词 → 占位 */
function entryLabel(entry: { name?: string; comment?: string; keys?: string[] }, fallback: string): string {
  if (entry.name?.trim()) return entry.name;
  if (entry.comment?.trim()) return entry.comment;
  const key = (entry.keys || []).find((k) => k?.trim());
  return key || fallback;
}

/**
 * 沙盒 iframe：卡内 HTML（状态栏 / 直播间面板）在这里跑。
 * sandbox 故意不带 allow-same-origin —— 第三方卡片的脚本不能碰到本站的
 * IndexedDB / localStorage（存着用户 API Key）和父页面 DOM。
 */
function SandboxFrame({ html }: { html: string }) {
  const [frameId] = useState(() => `cf-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);
  // 初值给小一点：iframe 内容高度只能往上撑，起点太高会留下一块空白
  const [height, setHeight] = useState(80);
  const srcDoc = useMemo(() => buildSandboxSrcDoc(html, frameId), [html, frameId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const parsed = parseChatFrameMessage(event.data);
      if (!parsed || parsed.frameId !== frameId) return;
      setHeight(Math.max(48, parsed.height));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameId]);

  return (
    <iframe
      title="卡片界面渲染"
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      className="w-full rounded-lg"
      style={{ height: `${height}px`, border: `1px solid ${borderColor}`, background: 'transparent' }}
    />
  );
}

/** 消息正文：先过显示通道的正则脚本，再把 HTML 段交给沙盒渲染。 */
function MessageBody({
  text,
  role,
  scripts,
  allowHtml,
}: {
  text: string;
  role: ChatRole;
  scripts: CardRegexScript[];
  allowHtml: boolean;
}) {
  const segments = useMemo(() => {
    const rendered = applyRegexScripts(text, scripts, { pass: 'display', role });
    if (!allowHtml) return [{ type: 'text' as const, content: rendered }];
    return segmentRenderedMessage(rendered);
  }, [text, scripts, role, allowHtml]);

  if (segments.length === 0) return <span className="whitespace-pre-wrap">{text}</span>;

  return (
    <div className="space-y-2">
      {segments.map((seg, i) =>
        seg.type === 'html' ? (
          <SandboxFrame key={`h-${i}`} html={seg.content} />
        ) : (
          <div key={`t-${i}`} className="whitespace-pre-wrap">{seg.content}</div>
        ),
      )}
    </div>
  );
}

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { cards, loading } = useCardLibrary();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /** 缺 i18n 键时 t() 返回空串（或原样键名），这里兜底成中文文案 */
  const label = useCallback(
    (key: string, fallback: string) => {
      const value = t(key);
      return !value || value === key ? fallback : value;
    },
    [t],
  );

  const paramCardId = useMemo(() => {
    const raw = searchParams.get('cardId');
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  }, [searchParams]);

  const [selectedCardId, setSelectedCardId] = useState<number | null>(paramCardId);
  const [messageInput, setMessageInput] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // 外部导航进来（如卡片库点「试聊」）时同步 URL 参数
  useEffect(() => {
    if (paramCardId !== null) setSelectedCardId(paramCardId);
  }, [paramCardId]);

  const handleSelectCard = useCallback(
    (id: number | null) => {
      setSelectedCardId(id);
      const next = new URLSearchParams(searchParams);
      if (id === null) next.delete('cardId');
      else next.set('cardId', String(id));
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const selectedCard = selectedCardId
    ? (cards.find((c) => c.id === selectedCardId) as Record<string, unknown> | undefined) || null
    : null;

  const {
    messages,
    sending,
    streamingContent,
    error,
    triggerReport,
    regexScripts,
    canRegenerate,
    sendMessage,
    regenerate,
    stopGeneration,
    previewTriggers,
    resetSession,
  } = useAIChat(selectedCard as Parameters<typeof useAIChat>[0]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleSend = async () => {
    if (!messageInput.trim() || sending) return;
    const msg = messageInput;
    setMessageInput('');
    await sendMessage(msg);
  };

  // 面板展开且输入框有内容时，实时预览「这句发出去会触发什么」；
  // 否则展示上一轮真实 AI 调用的触发结果（还没跑过则预览当前历史）。
  // 折叠时不把 messageInput 纳入依赖，避免每次按键都重扫一遍世界书。
  const pendingInput = inspectorOpen ? messageInput.trim() : '';
  const showPreview = pendingInput.length > 0 || !triggerReport;
  const preview = useMemo(
    () => (showPreview ? previewTriggers(pendingInput) : null),
    [showPreview, pendingInput, previewTriggers],
  );
  const inspectorResult: TriggerResult | null = preview ?? triggerReport;
  const isLivePreview = preview !== null;

  const reasonText = useCallback(
    (reason: SkipReason): string => {
      const map: Record<SkipReason, [string, string]> = {
        disabled: ['chat.inspector.reasonDisabled', '条目已禁用'],
        'no-keys': ['chat.inspector.reasonNoKeys', '绿灯条目没有关键词，永远不会触发'],
        'no-match': ['chat.inspector.reasonNoMatch', '关键词未出现在扫描范围内'],
        'secondary-logic': ['chat.inspector.reasonSecondaryLogic', '主关键词命中，但次要关键词逻辑不满足'],
        probability: ['chat.inspector.reasonProbability', '概率判定未通过'],
      };
      const [key, fallback] = map[reason];
      return label(key, fallback);
    },
    [label],
  );

  const activationText = useCallback(
    (item: ActivatedEntry): string => {
      if (item.reason === 'constant') return label('chat.inspector.byConstant', '蓝灯常驻');
      if (item.reason === 'recursion') return label('chat.inspector.byRecursion', '递归触发');
      return label('chat.inspector.byKeyword', '关键词命中');
    },
    [label],
  );

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100dvh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0 flex-wrap gap-2">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-color)' }}>{t('chat.title')}</h1>
        <div className="flex gap-2 items-center">
          <select
            value={selectedCardId ?? ''}
            onChange={(e) => handleSelectCard(e.target.value ? parseInt(e.target.value) : null)}
            className="rounded-lg border px-3 py-2 text-sm min-w-[200px]"
            style={{ borderColor, backgroundColor: 'var(--input-bg)', color: 'var(--text-color)' }}
          >
            <option value="">{t('chat.selectCard')}</option>
            {cards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name || t('chat.untitled')}
              </option>
            ))}
          </select>
          {selectedCardId && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={regenerate}
                disabled={sending || !canRegenerate}
                title={label('chat.regenerateHint', '丢弃最后一条 AI 回复并重新生成')}
              >
                🎲 {label('chat.regenerate', '重 roll')}
              </Button>
              <Button variant="ghost" size="sm" onClick={resetSession} disabled={sending}>
                🔄 {t('chat.reset')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* No card selected */}
      {!selectedCard && (
        <div className="flex-1 flex items-center justify-center border border-dashed rounded-xl" style={{ borderColor }}>
          <div className="text-center">
            <p className="text-lg mb-2" style={{ color: mutedText }}>
              {selectedCardId && !loading
                ? label('chat.cardNotFound', '找不到这张卡片，可能已被删除')
                : t('chat.noCardTitle')}
            </p>
            <p className="text-sm mb-4" style={{ color: faintText }}>{t('chat.noCardSubtitle')}</p>
            <button
              onClick={() => navigate('/settings')}
              className="text-xs text-primary-muted hover:text-primary-bright underline"
            >
              {t('chat.gotoSettings')}
            </button>
          </div>
        </div>
      )}

      {/* Chat window */}
      {selectedCard && (
        <div
          className="flex-1 flex flex-col min-h-0 rounded-xl border"
          style={{ borderColor, backgroundColor: 'color-mix(in srgb, var(--color-surface-base) 50%, transparent)' }}
        >
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center py-8 text-sm" style={{ color: faintText }}>
                {t('chat.emptyMessages')}
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={`${msg.timestamp}-${msg.role}-${i}`} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
                    msg.role === 'user'
                      ? 'bg-primary text-inverse'
                      : 'border'
                  }`}
                  style={msg.role !== 'user' ? {
                    backgroundColor: 'rgba(var(--card-bg-r), var(--card-bg-g), var(--card-bg-b), 0.8)',
                    borderColor,
                    color: 'var(--text-color)',
                  } : undefined}
                >
                  <MessageBody
                    text={msg.content}
                    role={msg.role}
                    scripts={regexScripts}
                    allowHtml={msg.role === 'assistant'}
                  />
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div
                  className="max-w-[80%] rounded-xl border px-4 py-3 text-sm whitespace-pre-wrap"
                  style={{
                    backgroundColor: 'rgba(var(--card-bg-r), var(--card-bg-g), var(--card-bg-b), 0.8)',
                    borderColor,
                    color: streamingContent ? 'var(--text-color)' : mutedText,
                  }}
                >
                  {streamingContent
                    ? <>{streamingContent}<span className="animate-pulse">▌</span></>
                    : <span className="animate-pulse">{t('chat.thinking')}</span>}
                </div>
              </div>
            )}
            {error && (
              <div className="flex justify-center">
                <div className="rounded-lg px-4 py-2 text-sm" style={{
                  backgroundColor: 'color-mix(in srgb, var(--color-status-danger) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-status-danger) 35%, transparent)',
                  color: 'var(--color-status-danger)',
                }}>
                  {t('chat.error', { message: error })}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* 触发检查器：默认折叠 */}
          <div className="shrink-0 border-t" style={{ borderColor }}>
            <button
              type="button"
              onClick={() => setInspectorOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2 text-xs"
              style={{ color: mutedText }}
            >
              <span className="flex items-center gap-2">
                <span>{inspectorOpen ? '▾' : '▸'}</span>
                <span>🔍 {label('chat.inspector.title', '世界书触发检查器')}</span>
                {inspectorResult && (
                  <span style={{ color: faintText }}>
                    {label('chat.inspector.summary', '激活 {{on}} / 未激活 {{off}}')
                      .replace('{{on}}', String(inspectorResult.activated.length))
                      .replace('{{off}}', String(inspectorResult.skipped.length))}
                  </span>
                )}
              </span>
              {inspectorResult && (
                <span style={{ color: faintText }}>
                  {isLivePreview
                    ? label('chat.inspector.badgePreview', '预览')
                    : label('chat.inspector.badgeActual', '本轮实际')}
                </span>
              )}
            </button>

            {inspectorOpen && (
              <div className="px-4 pb-3 max-h-60 overflow-y-auto text-xs space-y-3" style={{ color: mutedText }}>
                {!inspectorResult || (inspectorResult.activated.length === 0 && inspectorResult.skipped.length === 0) ? (
                  <p style={{ color: faintText }}>{label('chat.inspector.noEntries', '这张卡没有世界书条目。')}</p>
                ) : (
                  <>
                    <div>
                      <p className="font-semibold mb-1" style={{ color: 'var(--text-color)' }}>
                        {label('chat.inspector.activated', '已激活')}（{inspectorResult.activated.length}）
                      </p>
                      {inspectorResult.activated.length === 0 ? (
                        <p style={{ color: faintText }}>{label('chat.inspector.activatedEmpty', '本轮没有条目被激活。')}</p>
                      ) : (
                        <ul className="space-y-1">
                          {inspectorResult.activated.map((item: ActivatedEntry, i: number) => (
                            <li key={`a-${item.entry.id ?? i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span style={{ color: 'var(--color-status-success, #4ade80)' }}>●</span>
                              <span style={{ color: 'var(--text-color)' }}>
                                {entryLabel(item.entry, label('chat.inspector.unnamedEntry', '未命名条目'))}
                              </span>
                              <span
                                className="rounded px-1.5 py-0.5"
                                style={{ backgroundColor: 'color-mix(in srgb, var(--text-color) 10%, transparent)' }}
                              >
                                {activationText(item)}
                                {item.recursionStep > 0 ? ` ${item.recursionStep}` : ''}
                              </span>
                              {item.matchedKeys.length > 0 && (
                                <span style={{ color: faintText }}>
                                  {label('chat.inspector.matchedKeys', '命中')}: {item.matchedKeys.join('、')}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <p className="font-semibold mb-1" style={{ color: 'var(--text-color)' }}>
                        {label('chat.inspector.skipped', '未激活')}（{inspectorResult.skipped.length}）
                      </p>
                      {inspectorResult.skipped.length === 0 ? (
                        <p style={{ color: faintText }}>{label('chat.inspector.skippedEmpty', '所有条目都激活了。')}</p>
                      ) : (
                        <ul className="space-y-1">
                          {inspectorResult.skipped.map((item: SkippedEntry, i: number) => (
                            <li key={`s-${item.entry.id ?? i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span style={{ color: faintText }}>○</span>
                              <span>{entryLabel(item.entry, label('chat.inspector.unnamedEntry', '未命名条目'))}</span>
                              <span style={{ color: faintText }}>— {reasonText(item.reason)}</span>
                              {item.reason === 'no-match' && item.entry.keys.length > 0 && (
                                <span style={{ color: faintText }}>
                                  ({label('chat.inspector.entryKeys', '关键词')}: {item.entry.keys.join('、')})
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <p className="pt-1 border-t" style={{ borderColor, color: faintText }}>
                      {label(
                        'chat.inspector.note',
                        '试聊模拟 ST 的关键词扫描、次要关键词逻辑、正则、递归与概率；sticky / cooldown / delay、token 预算驱逐、分组互斥暂未模拟，条目位置（before_char 等）统一并入系统提示词。',
                      )}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t px-4 py-3" style={{ borderColor }}>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg border px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                style={{
                  borderColor,
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--text-color)',
                }}
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
                placeholder={t('chat.inputPlaceholder')}
                disabled={sending}
              />
              {sending ? (
                <Button variant="danger" onClick={stopGeneration}>
                  ⏹ {label('chat.stop', '停止')}
                </Button>
              ) : (
                <Button onClick={handleSend} disabled={!messageInput.trim()}>
                  {t('chat.send')}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
