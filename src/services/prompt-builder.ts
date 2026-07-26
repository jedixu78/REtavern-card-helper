/**
 * Prompt Builder - assembles system prompts for test chat,
 * following SillyTavern's prompt construction conventions.
 *
 * SillyTavern context build order (permanent tokens):
 *   1. Main System Prompt (or character's system_prompt override)
 *   2. Character Description (permanent)
 *   3. Character Personality (permanent)
 *   4. Scenario (permanent)
 *   5. World Book / Character Book entries (dynamic, keyword-triggered)
 *   6. Example Dialogues (pushed out as context fills)
 *   7. Chat History
 *   8. Post-History Instructions (jailbreak)
 *
 * For test chat we approximate this by building a single system prompt
 * that includes all permanent + relevant world book info.
 *
 * 世界书不再是「只塞蓝灯」：传入聊天消息后由 lorebook-trigger 引擎做真正的
 * 关键词扫描（绿灯 / 次要关键词逻辑 / 正则 / 递归 / 概率），并把「谁激活了、
 * 谁没激活及原因」一并返回给 UI 做触发检查器。
 *
 * Placeholders: {{char}} = character name, {{user}} = "You"
 */
import {
  evaluateLorebookTriggers,
  type TriggerableEntry,
  type TriggerMessage,
  type TriggerOptions,
  type TriggerResult,
} from './lorebook-trigger';

/** 导出卡里的世界书条目（字段为 snake_case，ST 运行时字段在 extensions 下） */
export interface CardBookEntry {
  id?: string | number;
  keys?: string[];
  secondary_keys?: string[];
  content?: string;
  name?: string;
  comment?: string;
  enabled?: boolean;
  constant?: boolean;
  /** ST 只在 selective 为真时才启用次要关键词过滤 */
  selective?: boolean;
  insertion_order?: number;
  case_sensitive?: boolean | null;
  use_regex?: boolean;
  position?: string;
  /** 草稿形态的条目会把 UI 索引直接放在顶层（导出卡则放在 extensions 里且是 ST 数值） */
  selectiveLogic?: number;
  extensions?: Record<string, unknown>;
}

interface CardData {
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
  };
}

export interface SystemPromptResult {
  prompt: string;
  /** 本次构建所依据的世界书触发结果（供触发检查器展示） */
  triggers: TriggerResult;
}

/**
 * ST 数值 selectiveLogic → 触发引擎期望的 UI 索引。
 * 与 card-exporter 的 SELECTIVE_LOGIC_REVERSE 保持一致：
 *   0 and_any → 0 AND ANY，3 and_all → 1 AND ALL，
 *   1 not_all → 2 NOT ALL，2 not_any → 3 NOT ANY
 * 少了这层映射，AND ALL 的条目会被当成 NOT ALL 判定，绿灯行为与 ST 完全对不上。
 */
const ST_SELECTIVE_LOGIC_TO_UI: Record<number, number> = { 0: 0, 3: 1, 1: 2, 2: 3 };

/** 卡片没声明 scan_depth 时的兜底扫描深度（消息条数），与 ST 默认量级一致 */
const DEFAULT_CHAT_SCAN_DEPTH = 4;

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** 把导出卡形态的世界书条目翻译成触发引擎的输入结构。 */
export function toTriggerableEntry(entry: CardBookEntry): TriggerableEntry {
  const ext = (entry.extensions ?? {}) as Record<string, unknown>;

  // 导出卡把 selectiveLogic 放在 extensions 且用 ST 数值，必须翻回 UI 索引；
  // 草稿形态的条目顶层就是 UI 索引，原样透传。
  const stLogic = asNumber(ext.selectiveLogic);
  const selectiveLogic =
    stLogic !== undefined ? (ST_SELECTIVE_LOGIC_TO_UI[stLogic] ?? 0) : asNumber(entry.selectiveLogic);

  // ST 的 useProbability=false 表示「不做概率判定」，此时 probability 数值无意义
  const probability = ext.useProbability === false ? undefined : asNumber(ext.probability);

  return {
    id: entry.id !== undefined ? String(entry.id) : undefined,
    name: entry.name,
    comment: entry.comment,
    keys: entry.keys ?? [],
    // ST 只在 selective 为真时才应用次要关键词过滤。取消勾选 selective 并不会清空
    // secondary_keys（编辑器只是隐藏输入框），无条件透传会让残留的次要关键词
    // 在试聊里错误拦截条目，给出与 ST 相反的结论。
    secondary_keys: entry.selective === false ? [] : (entry.secondary_keys ?? []),
    content: entry.content ?? '',
    enabled: entry.enabled !== false,
    constant: entry.constant === true,
    selectiveLogic,
    case_sensitive: asBoolean(ext.case_sensitive) ?? asBoolean(entry.case_sensitive),
    // null 表示「继承全局默认」，必须原样保留（转成 false 会让整词匹配悄悄关掉）
    match_whole_words: ext.match_whole_words === null ? null : asBoolean(ext.match_whole_words),
    use_regex: entry.use_regex === true,
    insertion_order: entry.insertion_order,
    // 条目级「扫描深度」在 ST 里只由 scan_depth 表示；ext.depth 是 position=at_depth
    // 的插入楼层，与扫描无关。此前优先读 ext.depth 会把 @D 插入深度当扫描窗口
    // （ST 对每条条目都写 depth，默认 4），导致书级 scan_depth 恒被覆盖成 4，
    // 检查器还会给出「关键词未出现在扫描范围内」这种与 ST 相反的判词。
    scanDepth: asNumber(ext.scan_depth),
    probability,
    exclude_recursion: asBoolean(ext.exclude_recursion),
    prevent_recursion: asBoolean(ext.prevent_recursion),
  };
}

/**
 * 对一张卡跑一次世界书扫描。纯函数，UI 的「触发检查器」可直接复用做预览。
 * 卡片自身的 character_book.scan_depth / recursive_scanning 优先，options 可再覆盖。
 */
export function evaluateCardLorebook(
  card: CardData,
  messages: TriggerMessage[] = [],
  options: TriggerOptions = {},
): TriggerResult {
  const book = card?.data?.character_book;
  const entries = book?.entries;
  if (!entries || entries.length === 0) return { activated: [], skipped: [] };

  const bookScanDepth = asNumber(book?.scan_depth);
  return evaluateLorebookTriggers(entries.map(toTriggerableEntry), messages, {
    scanDepth: bookScanDepth !== undefined && bookScanDepth > 0 ? bookScanDepth : DEFAULT_CHAT_SCAN_DEPTH,
    recursiveScanning: book?.recursive_scanning ?? false,
    ...options,
  });
}

/**
 * Build a system prompt from card data for test chat, together with the
 * world-book trigger report that produced it.
 *
 * 传 messages 才能触发绿灯；不传等价于「只有蓝灯常驻条目」（旧行为）。
 */
export function buildSystemPromptWithTriggers(
  card: CardData,
  messages: TriggerMessage[] = [],
  options: TriggerOptions = {},
): SystemPromptResult {
  const triggers = evaluateCardLorebook(card, messages, options);
  const data = card.data;

  // If the card has a system_prompt override, use it
  // (with {{original}} placeholder support)
  if (data.system_prompt?.trim()) {
    const defaultPrompt = buildDefaultSystemPrompt(card, triggers);
    return { prompt: data.system_prompt.replace(/\{\{original\}\}/g, defaultPrompt), triggers };
  }

  return { prompt: buildDefaultSystemPrompt(card, triggers), triggers };
}

/**
 * Build a system prompt from card data for test chat.
 * Approximates SillyTavern's prompt construction.
 */
export function buildSystemPrompt(
  card: CardData,
  messages: TriggerMessage[] = [],
  options: TriggerOptions = {},
): string {
  return buildSystemPromptWithTriggers(card, messages, options).prompt;
}

/**
 * Build the default system prompt from card fields.
 * Follows SillyTavern's permanent token structure.
 */
function buildDefaultSystemPrompt(card: CardData, triggers: TriggerResult): string {
  const data = card.data;
  const charName = data.name || 'Character';
  const sections: string[] = [];

  // 1. Character Description (permanent token - always sent)
  if (data.description?.trim()) {
    sections.push(data.description);
  }

  // 2. Personality summary (permanent token)
  if (data.personality?.trim()) {
    sections.push(`Personality: ${data.personality}`);
  }

  // 3. Scenario (permanent token)
  if (data.scenario?.trim()) {
    sections.push(`Scenario: ${data.scenario}`);
  }

  // 4. World Book — 由触发引擎决定哪些条目进入本轮上下文（蓝灯常驻 + 绿灯关键词命中
  //    + 递归触发），activated 已按 insertion_order 升序排好。
  //    注：条目的 position（before_char / at_depth 等）在试聊里统一并成一段注入，
  //    位置精度与 ST 有差距，但「是否命中」是一致的。
  const worldInfo = triggers.activated
    .map((a) => a.entry.content)
    .filter((content) => content && content.trim())
    .join('\n\n');
  if (worldInfo) {
    sections.push(`[World Information]\n${worldInfo}`);
  }

  // 5. Example dialogues (in SillyTavern these are kept until context fills)
  if (data.mes_example?.trim()) {
    // Replace {{char}} and {{user}} placeholders
    const examples = data.mes_example
      .replace(/\{\{char\}\}/gi, charName)
      .replace(/\{\{user\}\}/gi, 'You');
    sections.push(`Example conversations:\n${examples}`);
  }

  // 6. Character instruction (stay in character)
  sections.push(
    `You are ${charName}. Stay in character at all times. ` +
    `Respond using ${charName}'s speech patterns and mannerisms. ` +
    `Use *asterisks* for actions and narration.`
  );

  return sections.join('\n\n');
}

/**
 * Build the post-history instructions (jailbreak).
 * In SillyTavern this is sent after chat history, before the AI generates.
 * For test chat we append it to the system prompt.
 */
export function buildPostHistoryInstructions(card: CardData): string {
  const data = card.data;
  if (!data.post_history_instructions?.trim()) return '';
  return data.post_history_instructions;
}
