/**
 * lorebook-trigger — 世界书触发引擎（模拟 SillyTavern 的 World Info 扫描）。
 *
 * 试聊此前只注入蓝灯（constant）条目，绿灯条目的关键词触发完全不生效
 * ——prompt-builder 里那句「we don't have a full WI engine」就是这个缺口。
 * 本模块补上扫描逻辑，让试聊能真正验证世界书是否按预期命中。
 *
 * 实现的 ST 语义：
 *   - 蓝灯 constant：始终激活
 *   - 绿灯：主关键词命中扫描窗口即激活
 *   - 次要关键词 + selectiveLogic：AND ANY / AND ALL / NOT ALL / NOT ANY
 *   - case_sensitive、match_whole_words、use_regex（/pattern/flags）
 *   - 扫描深度（条目级 scanDepth 优先，否则用全局 scanDepth）
 *   - probability 概率判定（随机源可注入，便于测试与复现）
 *   - insertion_order 排序
 *   - 递归扫描：已激活条目的内容可再触发其它条目，
 *     受 exclude_recursion（不被递归触发）/ prevent_recursion（不触发他人）约束
 *
 * 刻意不实现（与 ST 有差距，UI 应如实说明）：
 *   sticky / cooldown / delay 这类跨消息的时序状态、
 *   token 预算驱逐、group / group_weight 的分组互斥。
 */

/** 触发引擎关心的条目字段（LorebookEntry 的结构性子集，便于服务层复用与测试） */
export interface TriggerableEntry {
  id?: string;
  name?: string;
  comment?: string;
  keys: string[];
  secondary_keys?: string[];
  content: string;
  enabled?: boolean;
  constant?: boolean;
  /** UI 索引：0=AND ANY, 1=AND ALL, 2=NOT ALL, 3=NOT ANY */
  selectiveLogic?: number;
  case_sensitive?: boolean;
  /** null = 继承全局默认 */
  match_whole_words?: boolean | null;
  use_regex?: boolean;
  insertion_order?: number;
  /** 条目级关键词扫描深度（消息条数）。对应 ST 的 entry.extensions.scan_depth，
   *  与 at_depth 的插入楼层 depth 是不同概念。 */
  scanDepth?: number;
  /** 0-100 */
  probability?: number;
  exclude_recursion?: boolean;
  prevent_recursion?: boolean;
}

export interface TriggerMessage {
  role: string;
  content: string;
}

export interface TriggerOptions {
  /** 全局扫描深度（条目未指定 scanDepth 时使用），默认 4 条消息 */
  scanDepth?: number;
  /** 是否启用递归扫描，默认 true */
  recursiveScanning?: boolean;
  /** 递归最大轮数，默认 3（ST 默认亦为有限轮次） */
  maxRecursionSteps?: number;
  /** 全局整词匹配默认值（条目 match_whole_words 为 null/undefined 时继承），默认 true */
  matchWholeWordsDefault?: boolean;
  /** 概率判定随机源，注入以便测试与复现；返回 [0,1) */
  random?: () => number;
}

export type ActivationReason = 'constant' | 'keyword' | 'recursion';

export interface ActivatedEntry {
  entry: TriggerableEntry;
  reason: ActivationReason;
  /** 命中的主关键词（constant 为空） */
  matchedKeys: string[];
  /** 递归轮次：0 = 直接由聊天文本触发 */
  recursionStep: number;
}

export type SkipReason =
  | 'disabled'
  | 'no-keys'
  | 'no-match'
  | 'secondary-logic'
  | 'probability';

export interface SkippedEntry {
  entry: TriggerableEntry;
  reason: SkipReason;
}

export interface TriggerResult {
  /** 已激活条目，按 insertion_order 升序 */
  activated: ActivatedEntry[];
  /** 未激活条目及原因（供 UI 解释「为什么这条没生效」） */
  skipped: SkippedEntry[];
}

const DEFAULT_SCAN_DEPTH = 4;
const DEFAULT_MAX_RECURSION = 3;

/** 是否含 CJK 字符--中文/日文/韩文没有词边界，\b 对其无效，必须退化为子串匹配。 */
function hasCJK(text: string): boolean {
  return /[㐀-鿿豈-﫿぀-ヿ\u3130-\u318F\uAC00-\uD7AF]/.test(text);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 ST 的 `/pattern/flags` 写法解析为 RegExp；不是该写法则返回 null。
 * 非法正则同样返回 null（调用方回退为字面量匹配，避免整条条目失效）。
 */
function parseRegexKey(key: string): RegExp | null {
  const m = key.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!m) return null;
  try {
    // 去掉 g：本模块只判断「是否命中」，g 会让 lastIndex 在复用时产生副作用
    return new RegExp(m[1], m[2].replace(/g/g, ''));
  } catch {
    return null;
  }
}

/** 单个关键词是否命中文本。 */
export function keyMatches(
  text: string,
  key: string,
  opts: { caseSensitive?: boolean; wholeWords?: boolean; useRegex?: boolean } = {},
): boolean {
  const trimmed = (key ?? '').trim();
  if (!trimmed || !text) return false;

  if (opts.useRegex) {
    const re = parseRegexKey(trimmed);
    if (re) return re.test(text);
    // 不是 /.../ 写法或正则非法：退回字面量匹配，不让整条条目哑火
  }

  const flags = opts.caseSensitive ? '' : 'i';
  // 整词匹配对 CJK 无意义（无词边界），含 CJK 时退化为子串匹配
  const useWholeWords = opts.wholeWords && !hasCJK(trimmed);
  const pattern = useWholeWords
    ? `\\b${escapeRegExp(trimmed)}\\b`
    : escapeRegExp(trimmed);
  try {
    return new RegExp(pattern, flags).test(text);
  } catch {
    return false;
  }
}

/** 返回命中的主关键词列表（空数组表示未命中）。 */
function matchedPrimaryKeys(
  text: string,
  entry: TriggerableEntry,
  matchWholeWordsDefault: boolean,
): string[] {
  const wholeWords = entry.match_whole_words ?? matchWholeWordsDefault;
  const o = { caseSensitive: entry.case_sensitive, wholeWords, useRegex: entry.use_regex };
  return (entry.keys || []).filter((k) => keyMatches(text, k, o));
}

/**
 * 次要关键词逻辑判定。无次要关键词时直接放行。
 * 0=AND ANY（至少一个命中）1=AND ALL（全部命中）
 * 2=NOT ALL（不是全部命中）3=NOT ANY（一个都没命中）
 */
function secondaryLogicPasses(
  text: string,
  entry: TriggerableEntry,
  matchWholeWordsDefault: boolean,
): boolean {
  const secondary = (entry.secondary_keys || []).filter((k) => (k ?? '').trim());
  if (secondary.length === 0) return true;

  const wholeWords = entry.match_whole_words ?? matchWholeWordsDefault;
  const o = { caseSensitive: entry.case_sensitive, wholeWords, useRegex: entry.use_regex };
  const hits = secondary.filter((k) => keyMatches(text, k, o)).length;

  switch (entry.selectiveLogic ?? 0) {
    case 1: return hits === secondary.length; // AND ALL
    case 2: return hits < secondary.length;   // NOT ALL
    case 3: return hits === 0;                // NOT ANY
    case 0:
    default: return hits > 0;                 // AND ANY
  }
}

/** 取最近 depth 条消息拼成扫描文本。depth <= 0 视为不限制。 */
function buildScanText(messages: TriggerMessage[], depth: number): string {
  const list = depth > 0 ? messages.slice(-depth) : messages;
  return list.map((m) => m.content || '').join('\n');
}

/**
 * 执行一次世界书扫描，返回激活与未激活条目。
 *
 * 纯函数（随机源可注入），不依赖 DOM/网络，便于单测与「触发预览」UI 复用。
 */
export function evaluateLorebookTriggers(
  entries: TriggerableEntry[],
  messages: TriggerMessage[],
  options: TriggerOptions = {},
): TriggerResult {
  const {
    scanDepth = DEFAULT_SCAN_DEPTH,
    recursiveScanning = true,
    maxRecursionSteps = DEFAULT_MAX_RECURSION,
    matchWholeWordsDefault = true,
    random = Math.random,
  } = options;

  const activated: ActivatedEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const decided = new Set<TriggerableEntry>();

  /** 概率判定：未设置或 >=100 视为必中。 */
  const passesProbability = (entry: TriggerableEntry): boolean => {
    const p = entry.probability;
    if (p === undefined || p === null || p >= 100) return true;
    if (p <= 0) return false;
    return random() * 100 < p;
  };

  // ── 第 0 轮：蓝灯常驻 + 聊天文本关键词扫描 ──
  for (const entry of entries) {
    if (entry.enabled === false) {
      skipped.push({ entry, reason: 'disabled' });
      decided.add(entry);
      continue;
    }
    if (entry.constant) {
      if (!passesProbability(entry)) {
        skipped.push({ entry, reason: 'probability' });
      } else {
        activated.push({ entry, reason: 'constant', matchedKeys: [], recursionStep: 0 });
      }
      decided.add(entry);
    }
  }

  // 主键命中但次要逻辑不满足时暂存原因：**不**锁定该条目。
  // 递归缓冲区在后续轮次会变大，次要关键词可能随之出现——ST 也只记忆概率失败，
  // 不记忆次要关键词失败。锁定会让这类条目永远丧失机会并给出错误诊断。
  const pendingReason = new Map<TriggerableEntry, SkipReason>();

  const scanEntry = (entry: TriggerableEntry, step: number, text: string): boolean => {
    const keys = (entry.keys || []).filter((k) => (k ?? '').trim());
    if (keys.length === 0) {
      skipped.push({ entry, reason: 'no-keys' });
      decided.add(entry);
      return false;
    }
    const matched = matchedPrimaryKeys(text, entry, matchWholeWordsDefault);
    if (matched.length === 0) return false; // 本轮未命中，后续轮次仍有机会
    if (!secondaryLogicPasses(text, entry, matchWholeWordsDefault)) {
      pendingReason.set(entry, 'secondary-logic');
      return false;
    }
    if (!passesProbability(entry)) {
      skipped.push({ entry, reason: 'probability' });
      decided.add(entry);
      return false;
    }
    activated.push({
      entry,
      reason: step === 0 ? 'keyword' : 'recursion',
      matchedKeys: matched,
      recursionStep: step,
    });
    decided.add(entry);
    return true;
  };

  const globalScanText = buildScanText(messages, scanDepth);
  for (const entry of entries) {
    if (decided.has(entry)) continue;
    // 条目级 depth 覆盖全局扫描深度
    const text = entry.scanDepth && entry.scanDepth > 0
      ? buildScanText(messages, entry.scanDepth)
      : globalScanText;
    scanEntry(entry, 0, text);
  }

  // ── 递归轮次 ──
  // 扫描文本是「聊天原文 + 迄今为止所有已激活条目的内容」的累积缓冲，
  // 对齐 ST 的 WorldInfoBuffer（depthBuffer + recurseBuffer）。
  //
  // 早期实现只用「上一轮新激活条目的 content」，会漏掉两类命中：
  //   ① 次要关键词在聊天原文里、主关键词由递归带出的条目——次要逻辑会误判为不满足，
  //      检查器还会给出「主关键词命中但次要逻辑不满足」这种与事实相反的诊断；
  //   ② 第 2 轮起需要第 0 轮条目正文才能命中的条目。
  if (recursiveScanning) {
    // 注意 prevent_recursion 的语义是「自身内容不参与触发他人」，
    // 所以它只影响加入缓冲，不影响自己被触发。
    const recurseParts = activated
      .filter((a) => !a.entry.prevent_recursion)
      .map((a) => a.entry.content || '')
      .filter((c) => c.trim());

    for (let step = 1; step <= maxRecursionSteps; step++) {
      if (recurseParts.length === 0) break;
      const scanText = [globalScanText, ...recurseParts].join('\n');

      const before = activated.length;
      for (const entry of entries) {
        if (decided.has(entry)) continue;
        if (entry.exclude_recursion) continue; // 只接受真实聊天文本的触发
        scanEntry(entry, step, scanText);
      }
      if (activated.length === before) break; // 收敛

      for (const a of activated.slice(before)) {
        if (!a.entry.prevent_recursion && (a.entry.content || '').trim()) {
          recurseParts.push(a.entry.content || '');
        }
      }
    }
  }

  // 剩下未激活的条目：优先用暂存的具体原因（次要逻辑），否则记为 no-match
  for (const entry of entries) {
    if (!decided.has(entry)) {
      skipped.push({ entry, reason: pendingReason.get(entry) ?? 'no-match' });
    }
  }

  activated.sort((a, b) => (a.entry.insertion_order ?? 0) - (b.entry.insertion_order ?? 0));
  return { activated, skipped };
}
