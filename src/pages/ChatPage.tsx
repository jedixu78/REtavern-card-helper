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
import {
  applyMvuDisplayPostProcess,
  substituteVariableMacros,
  yamlStringify,
  omitDollarKeysDeep,
  getAtPath,
  type MvuChange,
  type StatData,
} from '../services/mvu-sim';
import type { ActivatedEntry, SkippedEntry, SkipReason, TriggerResult } from '../services/lorebook-trigger';
import { parseDispatcherContent } from '../services/staged-lorebook-builder';
import type { CardBookEntry } from '../services/prompt-builder';

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

/**
 * 消息正文：MVU 激活时先做显示预处理（补状态栏占位符 / 删变量块，对齐真实
 * MagVarUpdate 行为），过显示通道的正则脚本，替换变量宏，再把 HTML 段交给沙盒渲染。
 */
function MessageBody({
  text,
  role,
  scripts,
  allowHtml,
  mvuActive,
  statData,
  appendPlaceholder,
}: {
  text: string;
  role: ChatRole;
  scripts: CardRegexScript[];
  allowHtml: boolean;
  mvuActive: boolean;
  statData: StatData | null;
  appendPlaceholder: boolean;
}) {
  const segments = useMemo(() => {
    // 纵深防御：MVU 处理链吃的是不可信文本，异常在渲染期抛出会被根 ErrorBoundary
    // 接管掀翻整站。出错就退回原文显示。
    let processed = text;
    try {
      let source = text;
      if (mvuActive && role === 'assistant') {
        source = applyMvuDisplayPostProcess(source, { appendPlaceholder });
      }
      const rendered = applyRegexScripts(source, scripts, { pass: 'display', role });
      processed = mvuActive && statData ? substituteVariableMacros(rendered, statData).html : rendered;
    } catch (err) {
      console.error('消息渲染管线失败，退回原文显示：', err);
      processed = text;
    }
    if (!allowHtml) return [{ type: 'text' as const, content: processed }];
    return segmentRenderedMessage(processed);
  }, [text, scripts, role, allowHtml, mvuActive, statData, appendPlaceholder]);

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
    mvuTimeline,
    canRegenerate,
    sendMessage,
    regenerate,
    stopGeneration,
    previewTriggers,
    resetSession,
  } = useAIChat(selectedCard as Parameters<typeof useAIChat>[0]);

  const [mvuPanelOpen, setMvuPanelOpen] = useState(false);
  const [stagedPanelOpen, setStagedPanelOpen] = useState(false);

  /** 只有卡里带状态栏占位符替换脚本时，才模拟真实 MVU 的「缺占位符自动补」行为 */
  const appendPlaceholder = useMemo(
    () => regexScripts.some((s) => (s.findRegex ?? '').includes('StatusPlaceHolder')),
    [regexScripts],
  );

  /** 变量状态面板数据：最新快照 + 最近一轮变更 + 未解析宏 + 警告 */
  const mvuPanel = useMemo(() => {
    if (!mvuTimeline.active) return null;
    const lastSnapshot =
      mvuTimeline.snapshots.length > 0
        ? mvuTimeline.snapshots[mvuTimeline.snapshots.length - 1]
        : mvuTimeline.init.statData;
    const baseWarnings = [...mvuTimeline.init.warnings, ...mvuTimeline.warningsByMessage.flat()];
    // 「本轮变更」= 最后一条 AI 消息产生的命令（不能倒序找「最近非空」——
    // 无命令的轮次会把上一轮的旧记录当成本轮展示）
    let lastChanges: MvuChange[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue;
      lastChanges = mvuTimeline.changesByMessage[i] ?? [];
      break;
    }
    try {
      // 未解析宏：对最后一条 AI 消息按与 MessageBody 相同的管线复算一遍
      let unresolved: string[] = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue;
        const processed = applyMvuDisplayPostProcess(messages[i].content, { appendPlaceholder });
        const rendered = applyRegexScripts(processed, regexScripts, { pass: 'display', role: 'assistant' });
        unresolved = substituteVariableMacros(rendered, mvuTimeline.snapshots[i] ?? lastSnapshot).unresolved;
        break;
      }
      return {
        stateYaml: yamlStringify(omitDollarKeysDeep(lastSnapshot)),
        topLevelCount: Object.keys(lastSnapshot).length,
        lastChanges,
        unresolved,
        warnings: baseWarnings,
        sources: mvuTimeline.init.sources,
      };
    } catch (err) {
      // 纵深防御：面板在渲染期同步计算，异常会掀翻整站（见 useAIChat 的同类保护）
      console.error('变量状态面板渲染失败：', err);
      return {
        stateYaml: '',
        topLevelCount: Object.keys(lastSnapshot).length,
        lastChanges,
        unresolved: [],
        warnings: [...baseWarnings, '变量状态渲染失败：数据结构异常'],
        sources: mvuTimeline.init.sources,
      };
    }
  }, [mvuTimeline, messages, regexScripts, appendPlaceholder]);

  /**
   * 阶段追踪面板数据：从卡内世界书调度条目解析出阶段轴定义，
   * 结合 MVU 时间线快照算出「当前阶段」与「历史轨迹」。
   * 仅在检测到至少一个调度条目时返回非空数组。
   */
  const stagedTrack = useMemo(() => {
    const card = selectedCard as { data?: { character_book?: { entries?: CardBookEntry[] } } } | null;
    const entries = card?.data?.character_book?.entries;
    if (!entries || entries.length === 0) return [];

    type StageHistory = { messageIndex: number; role: string; value: unknown };
    type StageInfo = {
      dispatcherName: string;
      axisPath: string;
      bookName: string;
      /** 调度条目里出现的阶段名列表（按 if/else if 顺序） */
      stages: string[];
      /** 当前阶段值（最后一条消息后的快照；enum 轴取数组首元素） */
      currentValue: unknown;
      /** 当前匹配的阶段名（enum 轴直接比对；数值轴按调度条目条件互斥匹配） */
      currentStage: string | null;
      /** 阶段值变化轨迹（仅记录发生变化的轮次） */
      history: StageHistory[];
    };

    const snapshots = mvuTimeline.snapshots;
    const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : mvuTimeline.init.statData;

    const result: StageInfo[] = [];
    for (const entry of entries) {
      const content = entry?.content || '';
      let parsed;
      try {
        parsed = parseDispatcherContent(content);
      } catch {
        continue;
      }
      if (!parsed) continue;

      const { axisPath, bookName, childComments } = parsed;
      // enum 轴调度条目读 `stat_data.XXX[0]`，statData 里存的是数组；数值轴直接是标量
      const rawValue = getAtPath(lastSnapshot, axisPath);
      const currentValue = Array.isArray(rawValue) ? rawValue[0] : rawValue;

      // 匹配当前阶段：enum 轴按字符串相等，数值轴暂用「条件表达式命中」
      let currentStage: string | null = null;
      if (childComments.length > 0) {
        // childComments 形如 "调度名：阶段名"，取冒号后部分做展示与匹配
        const stageNames = childComments.map((c) => {
          const idx = c.indexOf('：');
          return idx >= 0 ? c.slice(idx + 1) : c;
        });
        if (typeof currentValue === 'string') {
          currentStage = stageNames.find((n) => n === currentValue) ?? null;
        } else if (typeof currentValue === 'number' && Number.isFinite(currentValue)) {
          // 数值轴：扫描调度条目 content 里的条件，找到第一个命中的
          const condRegex = new RegExp(
            String(axisPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
              '\\[0\\]\\s*(>=|<=)\\s*(-?\\d+(?:\\.\\d+)?)',
            'g',
          );
          const conds: { op: string; threshold: number; stage: string }[] = [];
          let m: RegExpExecArray | null;
          while ((m = condRegex.exec(content)) !== null) {
            // 条件之后紧跟着 getWorldInfo(..., "阶段名")，用最近的一个阶段名匹配
            const tail = content.slice(m.index, m.index + 400);
            const stageMatch = tail.match(/getWorldInfo\(\s*"(?:[^"\\]|\\.)*"\s*,\s*"((?:[^"\\]|\\.)*)"/);
            if (stageMatch) {
              const sn = stageMatch[1].replace(/\\(.)/g, '$1');
              const idx2 = sn.indexOf('：');
              const stageName = idx2 >= 0 ? sn.slice(idx2 + 1) : sn;
              conds.push({ op: m[1]!, threshold: Number(m[2]), stage: stageName });
            }
          }
          for (const c of conds) {
            if (c.op === '>=' && currentValue >= c.threshold) { currentStage = c.stage; break; }
            if (c.op === '<=' && currentValue <= c.threshold) { currentStage = c.stage; break; }
          }
        }
      }

      // 历史轨迹：遍历快照，记录每次值变化（含初始值）
      const history: StageHistory[] = [];
      let prevRaw: unknown = undefined;
      let prevDisplay: string | undefined;
      // 初始值（开场白前）
      const initRaw = getAtPath(mvuTimeline.init.statData, axisPath);
      const initValue = Array.isArray(initRaw) ? initRaw[0] : initRaw;
      history.push({ messageIndex: -1, role: 'init', value: initValue });
      prevRaw = initRaw;
      prevDisplay = String(initValue ?? '');
      for (let i = 0; i < messages.length; i++) {
        const snap = snapshots[i] ?? lastSnapshot;
        const r = getAtPath(snap, axisPath);
        if (r === prevRaw) continue;
        const v = Array.isArray(r) ? r[0] : r;
        const display = String(v ?? '');
        if (display === prevDisplay) continue;
        history.push({ messageIndex: i, role: messages[i].role, value: v });
        prevRaw = r;
        prevDisplay = display;
      }

      result.push({
        dispatcherName: entry?.name || entry?.comment || axisPath,
        axisPath,
        bookName,
        stages: childComments.map((c) => {
          const idx = c.indexOf('：');
          return idx >= 0 ? c.slice(idx + 1) : c;
        }),
        currentValue,
        currentStage,
        history,
      });
    }
    return result;
  }, [selectedCard, mvuTimeline, messages]);

  /** 变更值的紧凑显示（长值截断，避免面板被撑爆） */
  const formatChangeValue = useCallback((value: unknown): string => {
    if (value === undefined) return 'undefined';
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > 48 ? `${s.slice(0, 48)}…` : s;
  }, []);

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
                    mvuActive={mvuTimeline.active}
                    statData={mvuTimeline.snapshots[i] ?? null}
                    appendPlaceholder={appendPlaceholder}
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

          {/* MVU 变量状态面板：仅在检测到 MVU 结构时出现，默认折叠 */}
          {mvuPanel && (
            <div className="shrink-0 border-t" style={{ borderColor }}>
              <button
                type="button"
                onClick={() => setMvuPanelOpen((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-2 text-xs"
                style={{ color: mutedText }}
              >
                <span className="flex items-center gap-2">
                  <span>{mvuPanelOpen ? '▾' : '▸'}</span>
                  <span>📊 {label('chat.mvu.title', '变量状态（MVU 模拟）')}</span>
                  <span style={{ color: faintText }}>
                    {label('chat.mvu.summary', '{{count}} 个顶层变量').replace('{{count}}', String(mvuPanel.topLevelCount))}
                  </span>
                </span>
                {mvuPanel.warnings.length > 0 && (
                  <span style={{ color: 'var(--color-status-warning, #fbbf24)' }}>⚠ {mvuPanel.warnings.length}</span>
                )}
              </button>

              {mvuPanelOpen && (
                <div className="px-4 pb-3 max-h-72 overflow-y-auto text-xs space-y-3" style={{ color: mutedText }}>
                  {mvuPanel.sources.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span style={{ color: faintText }}>{label('chat.mvu.initSources', '初始值来源')}:</span>
                      {mvuPanel.sources.map((source, i) => (
                        <span
                          key={`src-${i}`}
                          className="rounded px-1.5 py-0.5"
                          style={{ backgroundColor: 'color-mix(in srgb, var(--text-color) 10%, transparent)' }}
                        >
                          {source}
                        </span>
                      ))}
                    </div>
                  )}

                  <div>
                    <p className="font-semibold mb-1" style={{ color: 'var(--text-color)' }}>
                      {label('chat.mvu.currentState', '当前 stat_data')}
                    </p>
                    <pre
                      className="rounded-lg border p-2 overflow-x-auto whitespace-pre"
                      style={{ borderColor, backgroundColor: 'color-mix(in srgb, var(--text-color) 4%, transparent)' }}
                    >
                      {mvuPanel.stateYaml}
                    </pre>
                  </div>

                  <div>
                    <p className="font-semibold mb-1" style={{ color: 'var(--text-color)' }}>
                      {label('chat.mvu.lastChanges', '本轮变更')}（{mvuPanel.lastChanges.length}）
                    </p>
                    {mvuPanel.lastChanges.length === 0 ? (
                      <p style={{ color: faintText }}>{label('chat.mvu.lastChangesEmpty', '本轮没有变量命令。')}</p>
                    ) : (
                      <ul className="space-y-1">
                        {mvuPanel.lastChanges.map((change, i) => (
                          <li key={`chg-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span style={{ color: change.ok ? 'var(--color-status-success, #4ade80)' : 'var(--color-status-danger, #f87171)' }}>
                              {change.ok ? '✓' : '✗'}
                            </span>
                            <span
                              className="rounded px-1.5 py-0.5"
                              style={{ backgroundColor: 'color-mix(in srgb, var(--text-color) 10%, transparent)' }}
                            >
                              {change.op}
                            </span>
                            <span style={{ color: 'var(--text-color)' }}>{change.path}</span>
                            {change.ok ? (
                              <span style={{ color: faintText }}>
                                {formatChangeValue(change.from)} → {formatChangeValue(change.to)}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--color-status-danger, #f87171)' }}>{change.error}</span>
                            )}
                            {change.reason && change.reason !== 'json_patch' && (
                              <span style={{ color: faintText }}>（{change.reason}）</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {mvuPanel.unresolved.length > 0 && (
                    <div>
                      <p className="font-semibold mb-1" style={{ color: 'var(--text-color)' }}>
                        {label('chat.mvu.unresolvedMacros', '未解析宏')}（{mvuPanel.unresolved.length}）
                      </p>
                      <ul className="space-y-0.5">
                        {mvuPanel.unresolved.map((macro, i) => (
                          <li key={`unr-${i}`} className="font-mono break-all" style={{ color: faintText }}>
                            {macro}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {mvuPanel.warnings.length > 0 && (
                    <div>
                      <p className="font-semibold mb-1" style={{ color: 'var(--text-color)' }}>
                        {label('chat.mvu.warnings', '警告')}（{mvuPanel.warnings.length}）
                      </p>
                      <ul className="space-y-0.5">
                        {mvuPanel.warnings.map((warning, i) => (
                          <li key={`warn-${i}`} style={{ color: 'var(--color-status-warning, #fbbf24)' }}>
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <p className="pt-1 border-t" style={{ borderColor, color: faintText }}>
                    {label(
                      'chat.mvu.note',
                      '模拟 MagVarUpdate 的 _.set/insert/delete/add 命令与 JSONPatch 块、[InitVar] 初始值、get/format_message_variable 宏。未模拟：schema 扩展性校验（真实 MVU 可能拒绝向未标记 extensible 的集合插入）、mathjs 函数求值、命令内 ST 宏替换；路径不存在的宏保留原样（真实运行时渲染 null）。',
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 阶段追踪面板：检测到分阶段调度条目时才出现，默认折叠 */}
          {stagedTrack.length > 0 && (
            <div className="shrink-0 border-t" style={{ borderColor }}>
              <button
                type="button"
                onClick={() => setStagedPanelOpen((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-2 text-xs"
                style={{ color: mutedText }}
              >
                <span className="flex items-center gap-2">
                  <span>{stagedPanelOpen ? '▾' : '▸'}</span>
                  <span>🎭 {label('chat.staged.title', '阶段追踪（分阶段世界书）')}</span>
                  <span style={{ color: faintText }}>
                    {label('chat.staged.summary', '{{count}} 条阶段轴').replace('{{count}}', String(stagedTrack.length))}
                  </span>
                </span>
              </button>

              {stagedPanelOpen && (
                <div className="px-4 pb-3 max-h-72 overflow-y-auto text-xs space-y-4" style={{ color: mutedText }}>
                  {stagedTrack.map((track, ti) => (
                    <div key={`track-${ti}`} className="space-y-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-semibold" style={{ color: 'var(--text-color)' }}>
                          {track.dispatcherName}
                        </span>
                        <span
                          className="rounded px-1.5 py-0.5 font-mono"
                          style={{ backgroundColor: 'color-mix(in srgb, var(--text-color) 10%, transparent)' }}
                        >
                          {track.axisPath}
                        </span>
                        <span style={{ color: faintText }}>→</span>
                        {track.currentStage ? (
                          <span
                            className="rounded px-1.5 py-0.5"
                            style={{
                              backgroundColor: 'color-mix(in srgb, var(--color-status-success, #4ade80) 22%, transparent)',
                              color: 'var(--text-color)',
                            }}
                          >
                            {track.currentStage}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--color-status-warning, #fbbf24)' }}>
                            ⚠ {label('chat.staged.noMatch', '未匹配到任何阶段')}
                          </span>
                        )}
                        {track.currentValue !== undefined && (
                          <span style={{ color: faintText }}>
                            （{label('chat.staged.rawValue', '当前值')}:{' '}
                            <span className="font-mono">{formatChangeValue(track.currentValue)}</span>）
                          </span>
                        )}
                      </div>

                      {track.stages.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {track.stages.map((stage, si) => {
                            const isCurrent = stage === track.currentStage;
                            return (
                              <span
                                key={`s-${ti}-${si}`}
                                className="rounded px-1.5 py-0.5"
                                style={{
                                  backgroundColor: isCurrent
                                    ? 'color-mix(in srgb, var(--color-status-success, #4ade80) 30%, transparent)'
                                    : 'color-mix(in srgb, var(--text-color) 6%, transparent)',
                                  color: isCurrent ? 'var(--text-color)' : faintText,
                                  border: isCurrent
                                    ? '1px solid color-mix(in srgb, var(--color-status-success, #4ade80) 50%, transparent)'
                                    : '1px solid transparent',
                                }}
                              >
                                {isCurrent ? '● ' : ''}{stage}
                              </span>
                            );
                          })}
                        </div>
                      )}

                      {track.history.length > 1 && (
                        <div>
                          <p className="mb-1" style={{ color: faintText }}>
                            {label('chat.staged.history', '变化轨迹')}（{track.history.length}）
                          </p>
                          <ul className="space-y-0.5">
                            {track.history.map((h, hi) => (
                              <li key={`h-${ti}-${hi}`} className="flex items-center gap-2 font-mono" style={{ color: faintText }}>
                                <span style={{ color: 'var(--color-status-success, #4ade80)' }}>
                                  {hi === 0 ? 'init' : `#${h.messageIndex + 1}`}
                                </span>
                                <span>{h.role === 'assistant' ? '🤖' : h.role === 'user' ? '👤' : '·'}</span>
                                <span style={{ color: 'var(--text-color)' }}>{formatChangeValue(h.value)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <p style={{ color: faintText }}>
                        {label('chat.staged.bookName', '世界书')}:{' '}
                        <span className="font-mono">{track.bookName}</span>
                      </p>
                    </div>
                  ))}

                  <p className="pt-1 border-t" style={{ borderColor, color: faintText }}>
                    {label(
                      'chat.staged.note',
                      '解析卡内分阶段调度条目（constant + getvar/getWorldInfo），结合 MVU 快照追踪阶段轴变量的实际取值。enum 轴按字符串相等匹配，数值轴按调度条目内的 >= / <= 条件互斥匹配。若显示「未匹配」，可能是阶段变量尚未初始化或调度条目条件未覆盖当前值。',
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

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
