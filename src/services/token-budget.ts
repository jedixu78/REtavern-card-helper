/**
 * token-budget — 卡片 token 预算分析（纯函数、无副作用、可单测）。
 *
 * 解决的问题：世界书「蓝灯（常驻）」条目每一轮对话都会被塞进提示词，但编辑器
 * 只显示条目数量与字数，用户对「这张卡每轮固定烧掉多少 token」毫无感知。
 * 本模块把一张卡拆成若干 token 段落，按「是否每轮都进上下文」分三类：
 *   - fixed    每轮固定开销：蓝灯条目、角色设定条目、MVU 常驻系统条目、常驻字段、示例对话
 *   - onDemand 绿灯条目：只有被关键词命中时才计入（标注为「按需」）
 *   - oneTime  开场白：只在开场时进入上下文（随对话推进会被历史挤出）
 *
 * ── 估算口径 ────────────────────────────────────────────────────────────────
 * 直接复用 `estimateTokenCount`（src/components/novel-workshop/utils.ts），
 * 也就是 `estimatePromptTokens` 背后的同一个函数：
 *     CJK 字符 × 1.35 + 其余字符 ÷ 4，向上取整。
 * 项目里此前有两套口径：novel-workshop 的 1.35/4，以及若干组件内联的
 * `length * 1.3`（LorebookEntryEditor / StepPolishExport
 * 的展示用粗算）。这里统一到前者，不新造第三套。
 *
 * 依赖方向说明：`services/` 反向 import 了 `components/novel-workshop/utils`。
 * 该文件是零 React、只依赖同目录 `types.ts`（纯类型 + 常量）的纯函数模块，
 * 复用它比在 services 里复制一份系数更符合「单一事实来源」。
 */
import type { LorebookEntry, MvuConfig, WizardDraft } from '../constants/defaults';
import { estimateTokenCount } from '../components/novel-workshop/utils';
import { findStagedLorebookEntryIndices, isProtectedLorebookEntry, isCharacterDescriptionSynced } from './lorebook-predicates';
import { buildMvuScriptBundle } from './mvu-builder';

// ── 阈值 ────────────────────────────────────────────────────────────────────

/**
 * 「健康」上限：常驻开销 ≤ 40000 token/轮。
 *
 * 依据：主流模型上下文窗口已普遍 128K-1M（Claude 200K / GPT-4 128K / Gemini 1M / GLM 128K）。
 * 40000 token 在 128K 上下文里占约 31%，在 1M 里仅占 4%，留给聊天历史的空间仍然充裕。
 * 复杂卡的蓝灯条目（角色设定 + 世界书常驻 + MVU 系统 + 分阶段调度）轻松到 2-3 万，
 * 40000 的阈值符合社区实际写卡习惯，避免正常卡频繁触发警告。
 * `WizardDraft.bookTokenBudget` 的默认值也是 40000（constants/defaults.ts），
 * 它会原样写进导出卡的 `character_book.token_budget` —— 即这张卡自己向
 * SillyTavern 声明的世界书预算。ST 在世界信息预算耗尽后会按 priority 静默丢弃
 * 条目，所以常驻量一旦越过卡自己声明的预算，卡就开始「不可预期地缺内容」。
 */
export const TOKEN_BUDGET_HEALTHY_MAX = 40000;

/**
 * 「危险」下限：常驻开销 > 80000 token/轮。
 *
 * 依据：80000 token 的固定开销在 128K 上下文里约占 63%，在 1M 里占 8%。
 * 超过此值意味着蓝灯条目极多（整本世界书都设成了常驻），
 * 即便用 1M 模型，注意力机制也会被大量固定内容稀释，角色表现变平淡。
 * 40000～80000 之间记为「偏高」：仍能跑，但应考虑把部分蓝灯改为关键词触发。
 */
export const TOKEN_BUDGET_HIGH_MAX = 80000;

export type TokenBudgetLevel = 'healthy' | 'high' | 'danger';

/** 分级中文标签（质量检查提示与 UI 共用，避免两处各写一份） */
export const TOKEN_BUDGET_LEVEL_LABEL: Record<TokenBudgetLevel, string> = {
  healthy: '健康',
  high: '偏高',
  danger: '危险',
};

/** 按「每轮固定开销」给出分级。边界取闭区间下沿：40000 仍算健康，80000 仍算偏高。 */
export function classifyTokenBudget(perTurnFixed: number): TokenBudgetLevel {
  const value = Number.isFinite(perTurnFixed) ? perTurnFixed : 0;
  if (value > TOKEN_BUDGET_HIGH_MAX) return 'danger';
  if (value > TOKEN_BUDGET_HEALTHY_MAX) return 'high';
  return 'healthy';
}

// ── 基础估算 ────────────────────────────────────────────────────────────────

/**
 * 中英混排 token 估算。口径见文件头注释（复用 novel-workshop 的 estimateTokenCount）。
 * 传 null/undefined/空串一律返回 0。
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return estimateTokenCount(text);
}

// ── 世界书逐条明细 ──────────────────────────────────────────────────────────

export interface LorebookEntryTokenInfo {
  /** 在传入数组中的下标（与 draft.lorebookEntries 对齐，UI 可直接按下标取用） */
  index: number;
  id: string;
  /** 展示名：name → comment → 「条目 N」 */
  label: string;
  tokens: number;
  /** 蓝灯（constant） */
  constant: boolean;
  enabled: boolean;
  /** 每轮固定进入上下文 = enabled && constant */
  alwaysOn: boolean;
  /** MVU / 分阶段系统条目（用户不应直接删改，不作为「可优化」建议对象） */
  system: boolean;
}

export interface LorebookTokenBreakdown {
  /** 逐条明细，顺序与入参一致 */
  entries: LorebookEntryTokenInfo[];
  /** 启用的蓝灯条目 token 之和（含系统条目）—— 世界书部分的每轮固定开销 */
  constantTotal: number;
  /** 启用的绿灯条目 token 之和 —— 按需，仅命中关键词时计入 */
  selectiveTotal: number;
  /** 已禁用条目 token 之和（不进上下文，仅供参考） */
  disabledTotal: number;
  constantCount: number;
  selectiveCount: number;
  /**
   * 仅按世界书 constantTotal 得到的分级。
   * 整卡分级（含角色设定/MVU/常驻字段）见 `analyzeCardTokenBudget().level`。
   */
  constantLevel: TokenBudgetLevel;
  /** 可优化的常驻条目（启用 + 蓝灯 + 非系统条目），按 token 降序 */
  topConstantEntries: LorebookEntryTokenInfo[];
}

export interface LorebookTokenOptions {
  /** 分阶段系统条目下标集合；不传则自动探测（探测失败按「无」处理） */
  stagedIndices?: Set<number>;
}

/**
 * 只看世界书条目的 token 明细。StepWorldBook 用它渲染 per-entry 标注与顶部摘要，
 * `analyzeCardTokenBudget` 也复用它，保证两处数字一致。
 */
export function analyzeLorebookTokens(
  entries: LorebookEntry[] | null | undefined,
  options: LorebookTokenOptions = {},
): LorebookTokenBreakdown {
  const list = entries || [];
  let stagedIndices = options.stagedIndices;
  if (!stagedIndices) {
    try {
      stagedIndices = findStagedLorebookEntryIndices(list);
    } catch {
      stagedIndices = new Set<number>();
    }
  }

  const infos: LorebookEntryTokenInfo[] = list.map((entry, index) => {
    const tokens = estimateTokens(entry.content);
    const constant = Boolean(entry.constant);
    const enabled = Boolean(entry.enabled);
    return {
      index,
      id: entry.id,
      label: (entry.name || '').trim() || (entry.comment || '').trim() || `条目 ${index + 1}`,
      tokens,
      constant,
      enabled,
      alwaysOn: enabled && constant,
      system: isProtectedLorebookEntry(entry, index, stagedIndices),
    };
  });

  let constantTotal = 0;
  let selectiveTotal = 0;
  let disabledTotal = 0;
  let constantCount = 0;
  let selectiveCount = 0;
  for (const info of infos) {
    if (!info.enabled) {
      disabledTotal += info.tokens;
      continue;
    }
    if (info.constant) {
      constantTotal += info.tokens;
      constantCount++;
    } else {
      selectiveTotal += info.tokens;
      selectiveCount++;
    }
  }

  const topConstantEntries = infos
    .filter((i) => i.alwaysOn && !i.system && i.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  return {
    entries: infos,
    constantTotal,
    selectiveTotal,
    disabledTotal,
    constantCount,
    selectiveCount,
    constantLevel: classifyTokenBudget(constantTotal),
    topConstantEntries,
  };
}

// ── 整卡预算 ────────────────────────────────────────────────────────────────

export type TokenSegmentId =
  | 'characterDefinition'
  | 'constantEntries'
  | 'mvuSystem'
  | 'staticFields'
  | 'exampleDialogue'
  | 'selectiveEntries'
  | 'firstMessage';

/**
 * - `fixed`    每轮对话都进上下文，计入 perTurnFixed
 * - `onDemand` 触发时才进上下文（绿灯）
 * - `oneTime`  只在开场时进上下文（开场白）
 */
export type TokenSegmentKind = 'fixed' | 'onDemand' | 'oneTime';

export interface TokenBudgetSegment {
  id: TokenSegmentId;
  label: string;
  kind: TokenSegmentKind;
  tokens: number;
  /** 该段包含/不包含什么，UI 直接当 tooltip 用 */
  note: string;
}

export interface CardTokenBudget {
  /** 各段落明细，互不重叠（total 即各段之和） */
  segments: TokenBudgetSegment[];
  /** 世界书逐条明细 */
  lorebook: LorebookTokenBreakdown;
  /** 每轮对话固定开销 = 所有 kind==='fixed' 段之和 */
  perTurnFixed: number;
  /** 按需：全部绿灯条目同时命中时的追加量 */
  onDemand: number;
  /** 仅开场：开场白 */
  oneTime: number;
  /** 最坏情况总量 = perTurnFixed + onDemand + oneTime */
  total: number;
  /** 按 perTurnFixed 分级 */
  level: TokenBudgetLevel;
}

/**
 * `WizardDraft` 目前没有 `mes_example` 字段（本工具的导出流程不产出示例对话，
 * 示例内容由世界书条目承载）。但导入的外部卡片 / 未来扩展可能带上它，
 * 这里按可选字段防御式读取：字段缺失时该段恒为 0。
 */
function readExampleDialogue(draft: WizardDraft): string {
  const value = (draft as WizardDraft & { mes_example?: unknown }).mes_example;
  return typeof value === 'string' ? value : '';
}

/**
 * MVU 每轮真正进入提示词的部分。
 *
 * card-exporter 在导出时才把 MVU 内容生成为常驻世界书条目，草稿里通常不存在
 * （cardToDraft 也会把它们过滤掉），所以这里按同样的入口条件重跑一次
 * buildMvuScriptBundle 来估算。刻意排除三类不进提示词的内容：
 *   - `[InitVar]请勿打开`：导出时 enabled:false
 *   - `脚本/Zod.txt`：写进 extensions.tavern_helper.scripts，不是世界书
 *   - 状态栏 HTML：走 regex_scripts（markdownOnly），只在前端渲染
 */
function estimateMvuPromptTokens(mvu: MvuConfig | undefined): number {
  const enabled = Boolean(mvu?.enabled && (mvu.schemaTsContent || mvu.schemaSections.length > 0));
  if (!enabled || !mvu) return 0;
  try {
    const bundle = buildMvuScriptBundle(mvu);
    return (
      estimateTokens(bundle.ejsPreprocess) +
      estimateTokens(bundle.updateRulesYaml) +
      estimateTokens(bundle.variableList) +
      estimateTokens(bundle.variableOutputFormat)
    );
  } catch {
    return 0;
  }
}

/** 每轮固定进入上下文、但不属于世界书条目的字段。
 *  注：「锚定世界观」步骤生成的总纲条目已经是 lorebookEntries 中的一条常驻条目，
 *  会被 analyzeLorebookTokens 计入常驻段，这里不重复计算。 */
function estimateStaticFieldTokens(draft: WizardDraft): number {
  return (
    estimateTokens(draft.scenario) +
    estimateTokens(draft.system_prompt) +
    estimateTokens(draft.post_history_instructions)
  );
}

/**
 * 整卡 token 预算分析。
 *
 * 段落之间互不重叠：角色设定条目从「常驻世界书」里单独拆出来单列，
 * MVU/分阶段系统条目也单列，所以 `total` 等于各段直接相加，不会重复计数。
 */
export function analyzeCardTokenBudget(draft: WizardDraft): CardTokenBudget {
  const entries = draft.lorebookEntries || [];
  // 始终让 analyzeLorebookTokens 按条目内容自行识别分阶段调度条目：
  // cardToDraft 从不还原 stagedMode，重新打开的分阶段卡里该标记恒为假，
  // 若据此传空集合就会关掉识别，把调度条目当成普通蓝灯条目并写进整改建议。
  const lorebook = analyzeLorebookTokens(entries);

  // 角色设定条目：WizardPage.syncCharacterEntries 会把 characters[].description
  // 同步成蓝灯世界书条目，并把条目 id 记在 characters[].entryIds 上。
  // 按 entryIds 关联识别，避免「角色描述」与「常驻世界书」重复计数。
  const existingIds = new Set(entries.map((e) => e.id));
  const characterEntryIds = new Set<string>();
  let unsyncedCharacterTokens = 0;
  // entryIds 只是快路径：历史卡里存的是草稿 id，与重排后的条目 id 对不上，
  // 只靠它会把角色描述同时算进「角色描述」段和「常驻世界书」段，perTurnFixed 直接翻倍。
  // 兜底判定用 isCharacterDescriptionSynced（与 card-exporter 决定是否写
  // data.description 是同一个谓词，单一来源在 lorebook-predicates）。
  for (const character of draft.characters || []) {
    const linked = (character.entryIds || []).filter((id) => existingIds.has(id));
    linked.forEach((id) => characterEntryIds.add(id));
    // 尚未同步进世界书的角色描述：导出前会被同步成常驻条目，先按常驻计入。
    if (linked.length === 0
      && (character.description || '').trim()
      && !isCharacterDescriptionSynced(character.name, character.description || '', entries)) {
      unsyncedCharacterTokens += estimateTokens(character.description);
    }
  }

  let characterTokens = unsyncedCharacterTokens;
  let constantTokens = 0;
  let selectiveTokens = 0;
  let systemEntryTokens = 0;
  for (const info of lorebook.entries) {
    if (!info.enabled) continue;
    if (!info.constant) {
      selectiveTokens += info.tokens;
      continue;
    }
    if (info.system) systemEntryTokens += info.tokens;
    else if (characterEntryIds.has(info.id)) characterTokens += info.tokens;
    else constantTokens += info.tokens;
  }

  const mvuTokens = systemEntryTokens + estimateMvuPromptTokens(draft.mvu);
  const staticTokens = estimateStaticFieldTokens(draft);
  const exampleTokens = estimateTokens(readExampleDialogue(draft));
  const firstMessageTokens = estimateTokens(draft.firstMessage);

  const segments: TokenBudgetSegment[] = [
    {
      id: 'characterDefinition',
      label: '角色描述',
      kind: 'fixed',
      tokens: characterTokens,
      note: '角色设定已同步为蓝灯世界书条目（卡片的 description/personality 在本工具中恒为空），每轮固定注入。',
    },
    {
      id: 'constantEntries',
      label: '常驻世界书（蓝灯）',
      kind: 'fixed',
      tokens: constantTokens,
      note: '启用的蓝灯条目，每轮对话都会被写进提示词（不含角色设定条目与系统条目）。',
    },
    {
      id: 'mvuSystem',
      label: 'MVU / 系统条目',
      kind: 'fixed',
      tokens: mvuTokens,
      note: '变量列表、变量输出格式、更新规则、EJS 预处理等常驻系统条目。状态栏 HTML 与 Zod 脚本不进提示词，未计入。',
    },
    {
      id: 'staticFields',
      label: '常驻字段',
      kind: 'fixed',
      tokens: staticTokens,
      note: '场景（scenario）、系统提示、历史后指令。「锚定世界观」总纲条目已作为常驻世界书条目计入「常驻世界书」段。',
    },
    {
      id: 'exampleDialogue',
      label: '示例对话',
      kind: 'fixed',
      tokens: exampleTokens,
      note: '示例对话（mes_example）。本工具不生成该字段，仅在导入的外部卡片带有时才非 0。',
    },
    {
      id: 'selectiveEntries',
      label: '触发式世界书（绿灯）',
      kind: 'onDemand',
      tokens: selectiveTokens,
      note: '按需：只有关键词命中时才进入上下文，这里给的是全部同时命中的上限。',
    },
    {
      id: 'firstMessage',
      label: '开场白',
      kind: 'oneTime',
      tokens: firstMessageTokens,
      note: '开场白作为第一条消息进入上下文，随对话推进会被聊天记录挤出，不算每轮固定开销。',
    },
  ];

  const sumBy = (kind: TokenSegmentKind) =>
    segments.filter((s) => s.kind === kind).reduce((sum, s) => sum + s.tokens, 0);
  const perTurnFixed = sumBy('fixed');
  const onDemand = sumBy('onDemand');
  const oneTime = sumBy('oneTime');

  return {
    segments,
    lorebook,
    perTurnFixed,
    onDemand,
    oneTime,
    total: perTurnFixed + onDemand + oneTime,
    level: classifyTokenBudget(perTurnFixed),
  };
}

/**
 * 把预算结果转成一句可操作的整改建议（质量检查的 fixHint 与 UI 提示共用）。
 * 健康时返回空串。
 */
export function describeTokenBudgetAdvice(budget: CardTokenBudget, topN = 3): string {
  if (budget.level === 'healthy') return '';
  const top = budget.lorebook.topConstantEntries.slice(0, topN);
  const offenders = top.length > 0
    ? `占用最大的常驻条目：${top.map((e) => `「${e.label}」${e.tokens} token`).join('、')}。`
    : '';
  return (
    `常驻内容每轮固定消耗约 ${budget.perTurnFixed} token（${TOKEN_BUDGET_LEVEL_LABEL[budget.level]}，健康线 ${TOKEN_BUDGET_HEALTHY_MAX}）。` +
    offenders +
    '建议把不必每轮在场的蓝灯条目改为关键词触发（绿灯），或把散文改写成键值对压缩篇幅。'
  );
}
