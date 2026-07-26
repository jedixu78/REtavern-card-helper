/**
 * useAIChat - manages test chat sessions with an AI character.
 * Handles message history, sending messages, and session persistence.
 *
 * 试聊要能验证卡片产出物，因此这里做了三件与「普通聊天」不同的事：
 *   1. 世界书交给 lorebook-trigger 引擎真实扫描（绿灯会触发），并把触发报告
 *      透出给 UI 的触发检查器；
 *   2. 调 AI 时 presetMode: 'none' —— 用户配置的「写卡预设规则」是给写卡任务用的，
 *      强行注入角色扮演对话会扭曲测试结果；
 *   3. 发给 AI 的历史消息先过一遍卡内 promptOnly 正则脚本，
 *      让 `<StatusPlaceHolderImpl/>` 这类占位符像在 ST 里一样对 AI 不可见。
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { db } from '../db/database';
import {
  callAIStreaming,
  cancelActiveAIRequests,
  AIGenerationCancelledError,
  type AIMessage,
} from '../services/ai-service';
import {
  buildSystemPromptWithTriggers,
  buildPostHistoryInstructions,
  evaluateCardLorebook,
  type CardBookEntry,
} from '../services/prompt-builder';
import { applyRegexScripts, extractRegexScripts, type CardRegexScript } from '../services/chat-render';
import { buildVariableTimeline, stripStatusCurrentVariable, type MvuTimeline } from '../services/mvu-sim';
import type { TriggerResult } from '../services/lorebook-trigger';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface CardForChat {
  id?: number;
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    system_prompt: string;
    post_history_instructions: string;
    character_book?: {
      scan_depth?: number;
      recursive_scanning?: boolean;
      entries: CardBookEntry[];
    };
    extensions?: Record<string, unknown>;
  };
}

export function useAIChat(card: CardForChat | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  /** 流式生成中的半截回复（生成结束后并入 messages 并清空） */
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 最近一次真实 AI 调用所依据的世界书触发结果 */
  const [triggerReport, setTriggerReport] = useState<TriggerResult | null>(null);

  // 卡片对象每次库刷新都会换新引用，但只要 id 没变就是同一张卡：
  // 用稳定 key 做 effect 依赖，避免刷新把正在进行的会话重置掉。
  const cardKey = card ? String(card.id ?? `unsaved:${card.data?.name ?? ''}`) : null;
  const cardRef = useRef<CardForChat | null>(card);
  cardRef.current = card;

  /** 卡内 SillyTavern 正则脚本（状态栏 / 直播间 / 变量更新美化等） */
  const regexScripts = useMemo<CardRegexScript[]>(() => extractRegexScripts(card), [card]);

  /**
   * MVU 变量时间线：初始值（[InitVar] 条目 + 开场白 setvar）按消息序列重放。
   * messages 是唯一事实来源——重 roll 截断消息后重算即自动回滚。
   */
  // 纵深防御：模拟器处理的是不可信文本，这个 useMemo 在渲染期同步执行——
  // 任何未预料的异常都会被根 ErrorBoundary 接管掀翻整站，且消息已落 IndexedDB、
  // 刷新会再次崩溃。宁可退化成「没有变量模拟」也不能让页面挂掉。
  const mvuTimeline = useMemo<MvuTimeline>(() => {
    try {
      return buildVariableTimeline(card, messages);
    } catch (err) {
      console.error('MVU 变量模拟失败，本次退化为不模拟：', err);
      return {
        active: false,
        init: { statData: {}, sources: [], warnings: ['变量模拟失败：数据结构异常'] },
        snapshots: [],
        changesByMessage: [],
        warningsByMessage: [],
      };
    }
  }, [card, messages]);
  const mvuActive = mvuTimeline.active;

  // Initialize session when card changes
  useEffect(() => {
    setError(null);
    setStreamingContent('');
    setTriggerReport(null);

    const activeCard = cardRef.current;
    if (!activeCard) {
      setMessages([]);
      setSessionId(null);
      return;
    }

    (async () => {
      try {
        const firstMes = activeCard.data.first_mes;
        if (!activeCard.id) {
          setMessages(firstMes ? [{ role: 'assistant', content: firstMes, timestamp: Date.now() }] : []);
          setSessionId(null);
          return;
        }
        // Try to find existing session for this card
        const existing = await db.chat_sessions
          .where('cardId')
          .equals(activeCard.id)
          .last();

        if (existing) {
          setSessionId(existing.id ?? null);
          setMessages((existing.messages || []) as ChatMessage[]);
        } else {
          // Create new session with first message pre-loaded
          const initialMessages: ChatMessage[] = [];
          if (firstMes) {
            initialMessages.push({ role: 'assistant', content: firstMes, timestamp: Date.now() });
          }
          setMessages(initialMessages);
          setSessionId(null);
        }
      } catch (err) {
        console.error('Failed to load chat session:', err);
        setError('加载对话记录失败');
      }
    })();
  }, [cardKey]);

  // Save session to DB
  const saveSession = useCallback(async (msgs: ChatMessage[]) => {
    const activeCard = cardRef.current;
    if (!activeCard?.id) return;

    try {
      const now = new Date();
      if (sessionId) {
        await db.chat_sessions.update(sessionId, { messages: msgs, updatedAt: now });
      } else {
        const id = await db.chat_sessions.add({
          cardId: activeCard.id,
          messages: msgs,
          createdAt: now,
          updatedAt: now,
        });
        setSessionId(id ?? null);
      }
    } catch {
      // Silently fail session save
    }
  }, [sessionId]);

  /**
   * 跑一轮生成：history 是本轮要发给 AI 的完整可见历史（末尾通常是用户消息）。
   * 重 roll 与首次发送共用这条路径。
   */
  const runTurn = useCallback(async (history: ChatMessage[]) => {
    const activeCard = cardRef.current;
    if (!activeCard) return;

    setError(null);
    setSending(true);
    setStreamingContent('');

    let fullText = '';
    try {
      // MVU 激活时镜像真实运行时的消息改写：<status_current_variable> 块被 MVU 从
      // 消息存储里物理删除，后续轮次的提示词历史与 WI 扫描都看不到它
      const mvuStrip = (role: string, content: string) =>
        mvuActive && role === 'assistant' ? stripStatusCurrentVariable(content) : content;

      // 世界书扫描用「用户看到的原文」，与 ST 的 WI 扫描口径一致
      const scanMessages = history
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: mvuStrip(m.role, m.content) }));

      const { prompt: systemPrompt, triggers } = buildSystemPromptWithTriggers(activeCard, scanMessages);
      setTriggerReport(triggers);

      const apiMessages: AIMessage[] = [{ role: 'system', content: systemPrompt }];
      for (const msg of history) {
        if (msg.role === 'system') continue;
        apiMessages.push({
          role: msg.role,
          // promptOnly 脚本负责把状态栏/直播间占位符从提示词里剔除
          content: applyRegexScripts(mvuStrip(msg.role, msg.content), regexScripts, { pass: 'prompt', role: msg.role }),
        });
      }

      const postHistoryInstructions = buildPostHistoryInstructions(activeCard);
      if (postHistoryInstructions) {
        apiMessages.push({ role: 'system', content: postHistoryInstructions });
      }

      // presetMode: 'none' —— 写卡预设会污染角色扮演测试，必须关掉
      await callAIStreaming({ messages: apiMessages, presetMode: 'none' }, (chunk) => {
        fullText += chunk;
        setStreamingContent(fullText);
      });

      const finalMessages: ChatMessage[] = [
        ...history,
        { role: 'assistant', content: fullText, timestamp: Date.now() },
      ];
      setMessages(finalMessages);
      await saveSession(finalMessages);
    } catch (err: unknown) {
      if (err instanceof AIGenerationCancelledError) {
        // 用户主动停止：保留已经生成的半截回复，不算失败（不弹红色错误）
        if (fullText.trim()) {
          const partial: ChatMessage[] = [
            ...history,
            { role: 'assistant', content: fullText, timestamp: Date.now() },
          ];
          setMessages(partial);
          await saveSession(partial);
        }
        return;
      }
      const msg = err instanceof Error ? err.message : '获取 AI 响应失败';
      setError(msg);
    } finally {
      setSending(false);
      setStreamingContent('');
    }
  }, [regexScripts, saveSession, mvuActive]);

  /** Send a user message and get AI response */
  const sendMessage = useCallback(async (content: string) => {
    if (!cardRef.current || sending) return;
    const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now() };
    const history = [...messages, userMsg];
    setMessages(history);
    await runTurn(history);
  }, [messages, sending, runTurn]);

  /** 尾部的 AI 回复之前是否还有一轮可以重发 */
  const canRegenerate = useMemo(() => {
    let end = messages.length;
    while (end > 0 && messages[end - 1].role === 'assistant') end--;
    return end > 0;
  }, [messages]);

  /** 重 roll：丢掉尾部 AI 回复，用同样的历史重新生成一次 */
  const regenerate = useCallback(async () => {
    if (!cardRef.current || sending) return;
    let end = messages.length;
    while (end > 0 && messages[end - 1].role === 'assistant') end--;
    if (end === 0) return; // 只有开场白，没有可重发的轮次
    const history = messages.slice(0, end);
    setMessages(history);
    await runTurn(history);
  }, [messages, sending, runTurn]);

  /** 停止生成（半截内容会被保留） */
  const stopGeneration = useCallback(() => {
    cancelActiveAIRequests();
  }, []);

  /**
   * 触发预览：按「当前历史 + 正在输入的这句」算一次扫描，供触发检查器实时展示。
   * 概率判定固定按「必中」处理，否则面板会随每次按键闪烁。
   */
  const previewTriggers = useCallback((pendingInput = ''): TriggerResult | null => {
    const activeCard = cardRef.current;
    if (!activeCard) return null;
    const scan = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        // 与 runTurn 同口径：MVU 会从消息存储里删掉 <status_current_variable> 块
        content: mvuActive && m.role === 'assistant' ? stripStatusCurrentVariable(m.content) : m.content,
      }));
    if (pendingInput.trim()) scan.push({ role: 'user', content: pendingInput });
    return evaluateCardLorebook(activeCard, scan, { random: () => 0 });
  }, [messages, mvuActive]);

  /** Reset chat session */
  const resetSession = useCallback(async () => {
    const activeCard = cardRef.current;
    if (sessionId) {
      await db.chat_sessions.delete(sessionId);
    }
    setSessionId(null);
    setError(null);
    setStreamingContent('');
    setTriggerReport(null);

    // Re-initialize with first message
    const initialMessages: ChatMessage[] = [];
    if (activeCard?.data.first_mes) {
      initialMessages.push({
        role: 'assistant',
        content: activeCard.data.first_mes,
        timestamp: Date.now(),
      });
    }
    setMessages(initialMessages);
    if (activeCard?.id && initialMessages.length > 0) {
      const sessionData = {
        cardId: activeCard.id,
        messages: initialMessages,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const id = await db.chat_sessions.put(sessionData);
      setSessionId(id ?? null);
    }
  }, [sessionId]);

  return {
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
  };
}
