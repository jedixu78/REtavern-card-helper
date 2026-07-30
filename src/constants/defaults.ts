/**
 * Default structures and factory functions for the Tavern Card Helper.
 * Aligned with SillyTavern Character Card V2 specification.
 *
 * V2 Spec reference: https://github.com/malfoyslastname/character-card-spec-v2
 *
 * Key design principle:
 *   - `description` holds core character info (always in context = "Permanent Tokens")
 *   - `character_book` (World Book / Lorebook) holds detailed character info
 *     as keyword-triggered entries, dynamically inserted when relevant
 *   - `personality` is a brief summary (also permanent)
 *   - `scenario` is the dialogue context/circumstances (also permanent)
 */

/** Generate a unique ID for in-memory objects */
export function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Full lorebook entry interface (shared across components, hooks, services) */
export interface LorebookEntry {
  id: string;
  name: string;
  keys: string[];
  secondary_keys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  insertion_order: number;
  position: LorebookPosition;
  priority: number;
  case_sensitive: boolean;
  comment: string;
  /** Per-entry NSFW toggle for AI expansion feature */
  expandNsfw?: boolean;
  /** UI-only flag: 条目由「锚定世界观」步骤的 AI 总纲生成器创建。
   *  用于在 Step 4 渲染"⚓ 锚定"徽章，便于识别世界观锚定产物。
   *  Not exported to the SillyTavern card format. */
  fromAnchor?: boolean;
  // ST runtime
  probability: number;
  group: string;
  group_weight: number;
  selectiveLogic: number;
  role: number;
  depth: number;
  exclude_recursion: boolean;
  prevent_recursion: boolean;
  use_regex: boolean;
  /** null 表示「继承 SillyTavern 全局设置」，用于忠实回写外部卡片的 inherit 语义 */
  match_whole_words: boolean | null;
  sticky: number;
  cooldown: number;
  delay: number;
  ignore_budget: boolean;
  /** Optional SillyTavern runtime extensions (display_index, depth, etc.) */
  extensions?: Record<string, unknown>;
  /** 导入第三方卡时暂存的、本工具不认识的条目级字段（见 DraftPassthrough） */
  _passthrough?: LorebookEntryPassthrough;
}

/**
 * 单个世界书条目的「导入字段直通层」。
 * 由 card-exporter 的 cardToDraft 填充、assembleCard 消费；UI 不编辑它。
 */
export interface LorebookEntryPassthrough {
  /** 条目根层级的未知字段（V2/V3 规范之外的第三方扩展字段） */
  root?: Record<string, unknown>;
  /** entry.extensions 中本工具不生成、或本工具写死常量且无配置入口的 ST 运行时字段
   *  （automation_id / vectorized / use_probability / delay_until_recursion 等） */
  extensions?: Record<string, unknown>;
}

/**
 * 「导入字段直通层」——导入第三方 SillyTavern 卡时，把本工具不认识的字段原样存下来，
 * 导出时先铺底再由本工具生成的字段覆盖，从而避免「导入即破坏」。
 *
 * 关键约束：**已知字段永远以本工具的值为准**。直通层只填补空缺，
 * 绝不改变本工具对自家字段的正常导出行为。
 */
export interface DraftPassthrough {
  /** data 层未知字段（如 V3 的 assets / nickname / group_only_greetings / source 等） */
  data?: Record<string, unknown>;
  /** data.extensions 中非本工具生成的键（第三方扩展、depth_prompt 实际内容等） */
  extensions?: Record<string, unknown>;
  /** data.extensions.regex_scripts 中非本工具生成的正则脚本（第三方美化脚本等） */
  regexScripts?: unknown[];
  /** character_book 层未知字段（含其自身的 extensions） */
  characterBook?: Record<string, unknown>;
}

/** Wizard character (Step 3) — simplified: name + description + optional alignment */
export interface WizardCharacter {
  id: string;
  name: string;
  description: string;
  /** Optional D&D-style moral alignment constraint for AI generation */
  alignment?: string;
  /** Whether NSFW content generation is allowed for this character */
  nsfw?: boolean;
  /** IDs of world book entries auto-generated from this character */
  entryIds?: string[];
  /**
   * 角色设定世界书条目是否常驻（蓝灯 constant=true）。
   * undefined / true → 蓝灯：始终注入上下文（主角、重要配角）
   * false → 绿灯：关键词触发才注入（次要配角，省 token）
   * AI 生成时自动判断；用户可在角色卡片上手动切换。
   */
  constant?: boolean;
}

/** D&D nine-grid alignment options (optional personality constraint) */
export const CHARACTER_ALIGNMENTS = [
  { value: '守序善良', label: '守序善良', desc: '恪守正义与秩序，为公义而行' },
  { value: '中立善良', label: '中立善良', desc: '心存善念，不拘泥于规则' },
  { value: '混乱善良', label: '混乱善良', desc: '以良知行事，蔑视不义的秩序' },
  { value: '守序中立', label: '守序中立', desc: '信奉秩序与纪律，不偏善恶' },
  { value: '绝对中立', label: '绝对中立', desc: '不偏不倚，顺其自然' },
  { value: '混乱中立', label: '混乱中立', desc: '追求自由，随心所欲' },
  { value: '守序邪恶', label: '守序邪恶', desc: '利用规则与体制谋取私利' },
  { value: '中立邪恶', label: '中立邪恶', desc: '不择手段，唯利是图' },
  { value: '混乱邪恶', label: '混乱邪恶', desc: '以破坏和混乱为乐' },
] as const;

/** AI parsed result for character generation (simplified) */
export interface AIGeneratedCharacter {
  name?: string;
  description?: string;
  /** AI 判断：主角/重要配角 → true（蓝灯常驻），次要配角 → false（绿灯触发） */
  constant?: boolean;
}

/** AI parsed result for lorebook entry generation */
export interface AIGeneratedLorebookEntry {
  /** "create" = new entry, "update" = enrich existing entry (merge content) */
  action?: 'create' | 'update';
  /** When action="update", the id of the existing entry to update */
  targetId?: string;
  name?: string;
  keys?: string[];
  secondary_keys?: string[];
  content?: string;
  comment?: string;
  constant?: boolean;
  selective?: boolean;
  selectiveLogic?: number;
  insertion_order?: number;
  position?: string;
  priority?: number;
  probability?: number;
  group?: string;
  group_weight?: number;
  role?: number;
  depth?: number;
  exclude_recursion?: boolean;
  prevent_recursion?: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  use_regex?: boolean;
  match_whole_words?: boolean;
  ignore_budget?: boolean;
}

/** AI organize suggestion for a lorebook entry */
export interface AIOrganizeSuggestion {
  index: number;
  position?: string;
  insertion_order?: number;
  depth?: number;
  probability?: number;
  constant?: boolean;
  reason?: string;
}

/** AI key generation result */
export interface AIGeneratedKeys {
  index: number;
  keys: string[];
}

/** MVU variable visibility prefix */
export type MvuPrefix = '' | '_' | '$';

/** MVU variable definition (derived from schema.ts) */
export interface MvuVariable {
  /** Variable path in dot notation (e.g. "角色.好感度") */
  path: string;
  /** Zod type: "z.string()", "z.coerce.number()", "z.enum([...])", "z.object({...})", "z.record(...)" */
  zodType: string;
  /** Human-readable description */
  description: string;
  /** Visibility prefix: '' = visible+updatable, '_' = visible+readonly, '$' = hidden */
  prefix: MvuPrefix;
  /** Initial value (from initvar) */
  initialValue: unknown;
  /** For enum types: allowed values */
  enumValues?: string[];
  /** For number types: range [min, max] */
  range?: { min: number; max: number };
  /** For number types: category segments */
  categories?: Array<{ range: string; label: string }>;
  /** For complex types: format hint */
  format?: string;
}

/** MVU variable update rule */
export interface MvuUpdateRule {
  /** Variable path in dot notation */
  path: string;
  /** Type hint for AI: "number", "string", or union of string literals */
  type?: string;
  /** Numeric range: "0~100" */
  range?: string;
  /** Numeric range categories */
  category?: Record<string, string>;
  /** Format hint */
  format?: string;
  /** Natural language check rules */
  check?: string[];
  /** Value description */
  value?: string;
}

/** MVU schema section */
export interface MvuSchemaSection {
  /** Section name (e.g. "角色", "世界", "主角") */
  name: string;
  /** Variables in this section */
  variables: MvuVariable[];
}

/** EJS entry configuration */
export interface EjsEntryConfig {
  /** Entry ID in lorebookEntries */
  entryId: string;
  /** EJS complexity level */
  complexity: '显隐' | '段落控制' | '动态文本' | '分阶段调度';
  /** Condition expression (for @@if or if/else) */
  condition: string;
  /** Variable names used in this entry */
  usedVariables: string[];
}

/** MVU + EJS configuration for the card */
export interface MvuConfig {
  /** Whether MVU is enabled */
  enabled: boolean;
  /** Editor mode: 'expert' = full manual control, 'beginner' = AI-assisted simplified */
  mode: 'expert' | 'beginner';
  /** Currently selected beginner template id (when mode === 'beginner') */
  beginnerTemplateId?: string;
  /** Schema sections */
  schemaSections: MvuSchemaSection[];
  /** Update rules */
  updateRules: MvuUpdateRule[];
  /** EJS configurations */
  ejsConfigs: EjsEntryConfig[];
  /** EJS preprocess entry content (define() statements) */
  ejsPreprocessContent: string;
  /** Raw schema.ts content */
  schemaTsContent: string;
  /** Raw initvar.yaml content */
  initvarYamlContent: string;
  /** Raw 变量更新规则.yaml content */
  updateRulesYamlContent: string;
  /** Status bar HTML template (for SillyTavern render_after) */
  statusBarHtml: string;
  /** Status bar style preset id */
  statusBarStyle: string;
  /** Whether to show decorative emoji/symbols in the status bar (default false = clean Chinese-friendly display) */
  statusBarShowIcons?: boolean;
  /** Status bar customization options (theme, title, avatar, collapse) */
  statusBarOptions?: StatusBarOptions;
}

/** Status bar customization options used by StepStagedMode and status-bar-templates */
export interface StatusBarOptions {
  /** Theme id (terminal/parchment/glass/paper) */
  themeId?: string;
  /** Status bar header title */
  title?: string;
  /** Whether to show avatar in header (default true for parchment, false for terminal) */
  showAvatar?: boolean;
  /** Whether to collapse all sections by default */
  collapseAll?: boolean;
  /** Overall opacity (0.7~1) */
  opacity?: number;
  /** Information density */
  density?: 'compact' | 'comfortable';
  /** Enable value transition animations */
  animated?: boolean;
  /** Show decorative section icons */
  showIcons?: boolean;
}

/** 分阶段模式：单个角色一个阶段轴的剖析结果 */
export interface StagedModeCharacter {
  /** 角色名 */
  name: string;
  /** 来源世界书条目 comment（便于追溯） */
  sourceComment?: string;
  /** 一句话身份概括 */
  summary: string;
  /** 阶段轴变量路径（点分，必须已在 MVU 中定义，如 "林雅宁.情感天平"） */
  axisPath: string;
  /** 阶段轴变量类型：'number'（数值阈值型）| 'enum'（离散型） */
  axisType: 'number' | 'enum';
  /** 数值轴比较方向（仅 number）：'>=' 阈值以上触发 | '<=' 阈值以下触发 */
  numericDirection?: '>=' | '<=';
  /** 阶段列表（顺序即 if/else if 顺序，从最极端到初始，或从初始到极端） */
  stages: StagedModeStage[];
}

/** 分阶段模式：单个阶段定义 */
export interface StagedModeStage {
  /** 阶段名（用作子条目 comment 后缀与展示） */
  name: string;
  /** 触发条件表达式（不含外层括号），如 ">= 90" / "<= -80" / "=== '朋友'" */
  condition: string;
  /** AI 给出的简单人设/剧情注解（可重 roll） */
  annotation: string;
  /** 该阶段的子条目内容（AI 生成的人设/剧情详细文本，键值对或自然段） */
  content?: string;
}

/** 分阶段模式配置（新步骤 StepStagedMode 的状态） */
export interface StagedModeConfig {
  /** 是否启用分阶段模式 */
  enabled: boolean;
  /** 剧情模板 id（见 staged-templates.ts 的 STAGED_TEMPLATES，如 'pure-love'/'ntr'/'dual-route'/'cultivation' 等） */
  templateId: string;
  /** 调度条目命名前缀（如 "林雅宁分阶段人设"），默认 "分阶段人设" */
  dispatcherPrefix: string;
  /** AI 剖析出的角色阶段框架列表 */
  characters: StagedModeCharacter[];
}

/**
 * 直播间评论面板配置（独立于 MVU，纯正则驱动）。
 *
 * 架构：
 *   - 注入层：占位符 `<LiveStreamChatImpl/>` 由 card-exporter 追加到 first_mes
 *   - 渲染层：运行时 JS 立即渲染内置初始评论（无需任何外部依赖）
 *   - 增强层（可选）：若 MVU 运行时可用，订阅 VARIABLE_UPDATE_ENDED 事件
 *             读取 `stat_data.直播间.评论` 实现动态更新
 *
 * 通过 regex_scripts 替换占位符为面板 HTML（markdownOnly），
 * 并从 AI prompt 中移除占位符（promptOnly）。
 */
export interface LiveStreamChatConfig {
  /** 是否启用直播间评论面板 */
  enabled: boolean;
  /** 面板 HTML 文档（由 generateLiveChatHtml 生成，含 <style> + <script> + <body>） */
  html: string;
  /** 跟随状态栏主题 id（terminal/parchment/glass/paper） */
  themeId?: string;
  /** 面板标题（默认 "直播间"） */
  title?: string;
  /** 初始评论数显示上限（超出滚动，默认 10） */
  maxVisible?: number;
  /** 内置初始评论（每条一行，开播时立即渲染，无需 MVU） */
  initialComments?: string[];
}

/**
 * World book entry names that belong to the MVU system.
 * When MVU is disabled these entries should not be exported or edited.
 */
export const MVU_LOREBOOK_ENTRY_NAMES: readonly string[] = [
  '[InitVar]请勿打开',
  '[mvu_update]变量更新规则',
  'EJS预处理',
  '变量列表',
  '变量列表.txt',
  '变量输出格式',
  '变量输出格式.txt',
  'MVU 变量列表',
  'MVU 变量输出格式',
  '[mvu_update]变量输出格式',
];

/**
 * SillyTavern regex_scripts 中由本工具生成的界面脚本名。
 * 这些字符串同时用于「写入」(导出时设置 scriptName) 与「匹配」(导入/校验/补丁时按名查找)，
 * 任一处拼写不一致都会静默断开状态栏 / 直播间界面的接线，故集中定义为唯一来源。
 */
export const REGEX_SCRIPT_NAMES = {
  statusBar: '状态栏界面',
  liveChat: '直播间界面',
} as const;

/** 世界观锚定 — 按「从大到小细化」的漏斗顺序锚定创作方向，防止 AI 生成偏离设定。
 *  用户填入后既作为 AI 生成时的硬约束注入，也作为「锚定世界观」步骤的输入：
 *  AI 据此扩写出 1 条总纲条目 + N 条子条目（地点/规则/组织等）直接加入世界书。
 *  字段顺序即思考路径：类型 → 时代/年份 → 文化背景 → 人文细节 → 硬性约束。 */
export interface WorldAnchor {
  /** 类型：最宏观的世界观类型（异世界/平行世界/赛博朋克/奇幻/末日/校园/都市…） */
  type: string;
  /** 时代/年份：时代或具体年份（古代/中世纪/近现代/近未来/2024年/唐朝…） */
  era: string;
  /** 文化背景：国家/文化圈（中国/欧洲/日本/韩国/美国/架空…） */
  culture: string;
  /** 人文细节：宗教/礼仪/饮食/习俗 等创作方向，自由文本 */
  humanity: string;
  /** 硬性约束：AI 绝对不能违反的（如"无魔法"、"科技不超过2024年"） */
  constraints: string;
}

/** 将 WorldAnchor 格式化为 prompt 注入文本（按从大到小顺序） */
export function formatWorldAnchorForPrompt(anchor: WorldAnchor | undefined): string {
  if (!anchor) return '';
  const parts: string[] = [];
  if (anchor.type) parts.push(`世界观类型: ${anchor.type}`);
  if (anchor.era) parts.push(`时代/年份: ${anchor.era}`);
  if (anchor.culture) parts.push(`文化背景: ${anchor.culture}`);
  if (anchor.humanity) parts.push(`人文细节: ${anchor.humanity}`);
  if (anchor.constraints) parts.push(`硬性约束: ${anchor.constraints}`);
  return parts.join('\n');
}

/** Wizard draft state shape (shared across pages, hooks, services) */
export interface WizardDraft {
  cardName: string;
  characters: WizardCharacter[];
  lorebookEntries: LorebookEntry[];
  firstMessage: string;
  /** 对话示例（V2/V3 `mes_example`，`<START>` 分隔的示例对话）。
   *  可选是为了兼容不带该字段的历史草稿与既有 WizardDraft 字面量；
   *  createEmptyDraft 会给出 '' 默认值，消费侧一律按 `draft.mes_example || ''` 读取。 */
  mes_example?: string;
  /** 性格摘要（V2/V3 `personality`）。本工具的向导不产出它（worldbook-first），
   *  但第三方导入卡会带——往返直通防止丢失。可选性与默认值约定同 mes_example。
   *  暂无 UI 入口（后续可挂在步骤 7 高级区）。 */
  personality?: string;
  /** 世界书名（`character_book.name`）。空串 = 按卡名派生默认值（resolveBookName）。
   *  第三方导入卡的自定义书名靠它保真；cardToDraft 读到「派生默认形态」的书名时
   *  会存空串，让书名继续跟随卡名。 */
  bookName?: string;
  /** 世界书描述（`character_book.description`）——第三方卡往返直通，无 UI 入口 */
  bookDescription?: string;
  // V2 advanced fields
  scenario: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  creator_notes: string;
  creator: string;
  character_version: string;
  tags: string[];
  bookScanDepth: number;
  bookTokenBudget: number;
  bookRecursiveScanning: boolean;
  /** Whether NSFW content generation is allowed for world book entries */
  worldbookNsfw?: boolean;
  /** 世界观锚定 — 锚定创作方向的风格/地点/约束。既作 AI 生成约束注入，
   *  也是「锚定世界观」步骤的输入，AI 据此扩写出总纲+子条目加入世界书。 */
  worldAnchor?: WorldAnchor;
  /** Shared UI state — Step 4 世界书细节的批量生成数量，跨步骤保留以免用户重复输入。 */
  worldbookBatchCount?: number;
  /** MVU + EJS configuration */
  mvu?: MvuConfig;
  /** Whether to use MVU-aware export (embeds scripts, Zod.txt, regex) */
  useMvuExport?: boolean;
  /** 分阶段模式配置（步骤6，可选启用） */
  stagedMode?: StagedModeConfig;
  /** 直播间评论面板配置（步骤8，独立于 MVU，纯正则驱动） */
  liveStreamChat?: LiveStreamChatConfig;
  /** 导入字段直通层（内部字段，非 UI 编辑项）：保存导入卡中本工具不认识的字段，
   *  导出时原样回写。详见 DraftPassthrough。 */
  _passthrough?: DraftPassthrough;
}

/** Empty character template for Step 3 of the wizard */
export function createEmptyCharacter(): WizardCharacter {
  return {
    id: generateId(),
    name: '',
    description: '',
  };
}

/**
 * Empty lorebook entry template for Step 2/4 (World Book skeleton + detail).
 * Aligned with SillyTavern runtime format (CardForge reference).
 *
 * V2 Spec fields (embedded in PNG):
 *   keys, content, enabled, insertion_order, case_sensitive,
 *   name, priority, id, comment, selective, secondary_keys, constant, position
 *
 * SillyTavern runtime fields (stored in extensions, used by ST engine):
 *   probability, group, group_weight, selectiveLogic, role,
 *   sticky, cooldown, delay, depth, scan_depth,
 *   exclude_recursion, prevent_recursion, use_regex,
 *   match_whole_words, ignore_budget
 *
 * Reference: https://github.com/Anastasia2372/sillytavern-cardforge
 */
export function createEmptyLorebookEntry(): LorebookEntry {
  return {
    // ── Core fields (V2 spec) ───────────────────────────────────────────────
    id: generateId(),
    name: '',                         // Entry title / memo (human reference only)
    keys: [] as string[],             // Primary trigger keywords
    secondary_keys: [] as string[],   // Filter keywords (used with selective)
    content: '',                      // Text inserted into AI prompt when triggered
    enabled: true,
    constant: false,                  // If true, always inserted (within budget)
    selective: false,                 // If true, use secondary_keys with selectiveLogic
    insertion_order: 100,             // Lower = inserted first, higher = closer to end
    position: 'after_char' as LorebookPosition,
    priority: 50,                     // Token budget: lower = discarded first
    case_sensitive: false,
    comment: '',                      // Optional memo/comment

    // ── SillyTavern runtime fields (extensions) ─────────────────────────────
    probability: 100,                 // Trigger % (100 = always, 50 = 50%, 0 = never)
    group: '',                        // Inclusion group name (only one entry per group fires)
    group_weight: 100,                // Weight for random selection within group
    selectiveLogic: 0,                // Secondary key logic: 0=AND ANY, 1=AND ALL, 2=NOT ALL, 3=NOT ANY
    role: 0,                          // Message role: 0=System, 1=User, 2=Assistant
    depth: 4,                         // Scan depth (how many messages back to scan for keys)
    exclude_recursion: false,         // Cannot be activated by other entries
    prevent_recursion: false,         // Cannot trigger other entries
    use_regex: false,                 // Keys use regex matching
    match_whole_words: true,          // Only match whole words
    sticky: 0,                        // Stays active for N messages after trigger
    cooldown: 0,                      // Cannot re-trigger for N messages after deactivation
    delay: 0,                         // Cannot trigger until N messages exist in chat
    ignore_budget: false,             // Ignore token budget (always insert if triggered)
  };
}

/** Lorebook entry position values (SillyTavern V2 + runtime, 7 options) */
export type LorebookPosition =
  | 'before_char'      // Before character definitions (moderate impact)
  | 'after_char'       // After character definitions (greater impact)
  | 'before_example'   // Before example messages
  | 'after_example'    // After example messages
  | 'before_author'    // Before author's note
  | 'after_author'     // After author's note
  | 'at_depth';        // At specific depth (ST runtime extension)

/** Position display options for UI dropdown */
export const LOREBOOK_POSITION_OPTIONS = [
  { value: 'before_char', label: '角色定义之前', desc: '适中影响力' },
  { value: 'after_char', label: '角色定义之后', desc: '较大影响力（推荐）' },
  { value: 'before_example', label: '示例消息之前', desc: '解析为对话块' },
  { value: 'after_example', label: '示例消息之后', desc: '解析为对话块' },
  { value: 'before_author', label: '作者注释之前', desc: '取决于AN位置' },
  { value: 'after_author', label: '作者注释之后', desc: '取决于AN位置' },
  { value: 'at_depth', label: '指定深度', desc: '在指定消息深度处插入' },
] as const;

/** Secondary key logic modes (selectiveLogic) */
export const SELECTIVE_LOGIC_OPTIONS = [
  { value: 0, label: '与任意 (AND ANY)', desc: '任一过滤词匹配即触发' },
  { value: 1, label: '与所有 (AND ALL)', desc: '全部过滤词匹配才触发' },
  { value: 2, label: '非所有 (NOT ALL)', desc: '至少一个不匹配时触发' },
  { value: 3, label: '非任何 (NOT ANY)', desc: '全部不匹配时触发' },
] as const;

/** Message role options */
export const LOREBOOK_ROLE_OPTIONS = [
  { value: 0, label: 'System', desc: '系统消息（默认）' },
  { value: 1, label: 'User', desc: '用户消息' },
  { value: 2, label: 'Assistant', desc: 'AI消息' },
] as const;

/**
 * Version number for persisted wizard drafts.
 * Bump this whenever the draft shape changes incompatibly so that old cached
 * drafts are discarded on app restart.
 *
 * V6 → V7：合并「世界观锚定」+「世界书骨架」为「锚定世界观」步骤。
 * - worldAnchor 重构为从大到小漏斗字段（type/era/culture/humanity/constraints），
 *   旧字段映射 era→era、hardConstraints→constraints（coreRules/tone 丢弃）
 * - 移除 worldRules / skeletonTopic / skeletonCount / skeletonModeEnabled
 * - lorebookEntries 内 fromSkeleton/skeletonExpanded → fromAnchor
 */
export const WIZARD_DRAFT_VERSION = 7;

/**
 * 世界书名的唯一推导来源。导出的 `character_book.name`、`extensions.world` 与
 * 分阶段调度条目里 `getWorldInfo("书名", ...)` 的第一个参数**必须**都经由这里，
 * 三者不一致时 ST 里 `loadWorldInfo(书名)` 精确匹配失败、调度条目拉不到子条目，
 * 表现为「阶段不切换」。draft.bookName 非空 = 用户/导入卡的自定义书名；
 * 空串 = 按卡名派生默认值。
 */
export function resolveBookName(draft: Pick<WizardDraft, 'cardName' | 'bookName'>): string {
  // cardName 必须 trim：cardToDraft 侧比对导入书名时做了 trim，两侧不对称会把
  // 「 阿绫的世界书」（卡名带前导空格）误判成用户自定义书名，此后改卡名书名不再跟随
  return draft.bookName?.trim() || `${(draft.cardName ?? '').trim()}的世界书`;
}

/**
 * Empty wizard draft state.
 * Includes all SillyTavern V2 spec fields.
 */
export function createEmptyDraft(): WizardDraft {
  return {
    cardName: '',

    // Step 3: Characters → auto-injected into world book entries
    characters: [createEmptyCharacter()],

    // Step 2/4: World Book (skeleton + detail) / Character Book entries
    lorebookEntries: [],

    // Step 5: MVU Variables (optional)
    mvu: {
      enabled: false,
      mode: 'beginner',
      beginnerTemplateId: undefined,
      schemaSections: [],
      updateRules: [],
      ejsConfigs: [],
      ejsPreprocessContent: '',
      schemaTsContent: '',
      initvarYamlContent: '',
      updateRulesYamlContent: '',
      statusBarHtml: '',
      statusBarStyle: 'compact-panel',
      statusBarShowIcons: false,
      statusBarOptions: {},
    },
    useMvuExport: false,

    // Step 6: Staged Mode (optional, off by default)
    stagedMode: {
      enabled: false,
      templateId: 'pure-love',
      dispatcherPrefix: '分阶段人设',
      characters: [],
    },

    // Step 8: Live Stream Chat Panel (optional, off by default, independent of MVU)
    liveStreamChat: {
      enabled: false,
      html: '',
      themeId: 'terminal',
      title: '直播间',
      maxVisible: 10,
      initialComments: [],
    },

    // Step 7: First message
    firstMessage: '',

    // ── V2 Advanced Fields ──────────────────────────────────────────────────
    /** 对话示例（V2/V3 mes_example）——导入的 ST 卡会带回来，导出时原样写入 data.mes_example */
    mes_example: '',
    /** 性格摘要（V2/V3 personality）——同 mes_example 的往返直通，无 UI 入口 */
    personality: '',
    /** 世界书名/描述——空串 = 按卡名派生（见 resolveBookName） */
    bookName: '',
    bookDescription: '',
    scenario: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [] as string[],
    creator_notes: '',
    creator: '',
    character_version: '',
    tags: [] as string[],
    bookScanDepth: 200,
    bookTokenBudget: 40000,
    bookRecursiveScanning: false,
    worldbookNsfw: false,
    worldAnchor: { type: '', era: '', culture: '', humanity: '', constraints: '' },
    worldbookBatchCount: 8,
  };
}

/** Create an empty MVU config (returns non-optional MvuConfig for type safety) */
export function createEmptyMvuConfig(): MvuConfig {
  return {
    enabled: false,
    mode: 'beginner',
    beginnerTemplateId: undefined,
    schemaSections: [],
    updateRules: [],
    ejsConfigs: [],
    ejsPreprocessContent: '',
    schemaTsContent: '',
    initvarYamlContent: '',
    updateRulesYamlContent: '',
    statusBarHtml: '',
    statusBarStyle: 'compact-panel',
    statusBarShowIcons: false,
  };
}

/** Wizard step definitions with labels and validation flags */
export const WIZARD_STEPS = [
  { id: 1, label: '卡片名称', required: true },
  { id: 2, label: '锚定世界观', required: false },
  { id: 3, label: '角色配置', required: true },
  { id: 4, label: '世界书细节', required: false },
  { id: 5, label: 'MVU变量', required: false },
  { id: 6, label: '分阶段模式', required: false },
  { id: 7, label: '开场白', required: true },
  { id: 8, label: '直播包装', required: false },
  { id: 9, label: '美化导出', required: false },
] as const;
