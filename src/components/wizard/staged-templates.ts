/**
 * staged-templates - 分阶段世界书专用的 MVU 参数模板。
 *
 * 模板按「大类（TemplateCategory）→ 子模板（BeginnerTemplate）」两层组织：
 *   - 恋爱型（romance）：甜宠纯爱 / 虐恋NTR / 可纯爱可NTR
 *   - 成长突破型（growth）：修仙境界
 *   - 冒险剧情型（adventure）：主线推进
 *   - 黑化堕落型（darkness）：心智污染
 *   - 悬疑推理型（mystery）：案件调查
 *
 * 每个模板自带阶段轴变量、阈值方向、AI 剖析方向等完整定义，
 * prompts.ts 通过模板元信息字段动态构造 AI 提示词，不再硬编码分支。
 *
 * 通过 STAGED_COMPATIBLE_TEMPLATE_IDS 白名单与 MvuConfig.beginnerTemplateId 关联：
 * 只有选用这些模板（或大神模式）时，分阶段世界书步骤才允许启用。
 */
import type {
  MvuConfig,
  MvuSchemaSection,
  MvuUpdateRule,
  MvuVariable,
} from '../../constants/defaults';
import {
  buildSchemaTs,
  buildInitvarYaml,
  buildUpdateRulesYaml,
  buildEjsPreprocess,
} from '../../services/mvu-builder';
import { deepClone } from '../../utils/deep-clone';

// ── 模板结构定义 ────────────────────────────────────────────────────────────

export interface BeginnerTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** 所属大类 id */
  categoryId: string;
  /** 阶段轴变量路径（单角色模式，如 '关系.情感天平'） */
  axisPathHint: string;
  /** 阶段轴变量名（不含分区前缀，如 '情感天平'，多角色模式用作默认轴名） */
  axisVariableName: string;
  /** 默认分区名（单角色模式用，如 '关系'） */
  defaultSectionName: string;
  /** 阶段轴范围描述（如 '0~100' 或 '-100~100'） */
  axisRange: string;
  /** 阈值方向 */
  axisDirection: '>=' | '<=';
  /** UI 配色 token：'success' | 'danger' | 'warning' | 'info' */
  colorToken: 'success' | 'danger' | 'warning' | 'info';
  /** 角色适合性描述（用于 AI 识别角色时的适合性判断） */
  characterSuitabilityHint: string;
  /** AI 剖析方向描述（用于 STAGED_ANALYZE_PROMPT 的「根据模板选阶段轴」部分） */
  analyzeHint: string;
  /** 阶段内容写作方向（用于 STAGE_ENTRY_GENERATE_PROMPT，描述每个阶段的内容应该怎么写） */
  stageContentHint: string;
  /** 特殊规则提示（可选，如双路线的「女主没有被攻略过」默认设定） */
  specialRulesHint?: string;
  sections: MvuSchemaSection[];
  updateRules: MvuUpdateRule[];
  statusBarTitle: string;
  statusBarVars: string[];
}

export interface TemplateCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
}

/** 模板大类 */
export const STAGED_TEMPLATE_CATEGORIES: TemplateCategory[] = [
  { id: 'romance', name: '恋爱型', icon: '💕', description: '围绕角色间情感关系推进，含纯爱/NTR/双路线' },
  { id: 'growth', name: '成长突破型', icon: '🌱', description: '围绕主角能力/境界单向递增' },
  { id: 'adventure', name: '冒险剧情型', icon: '🗺️', description: '围绕主线进度/探索度推进' },
  { id: 'darkness', name: '黑化堕落型', icon: '🌑', description: '围绕心智/精神单向堕落' },
  { id: 'mystery', name: '悬疑推理型', icon: '🔍', description: '围绕真相揭露度推进' },
];

/** 分阶段世界书配套的参数模板 */
export const STAGED_TEMPLATES: BeginnerTemplate[] = [
  // ── 恋爱型 ──────────────────────────────────────────────────
  {
    id: 'pure-love',
    name: '甜宠纯爱',
    icon: '💕',
    description: '单一情感天平 0~100 单向递增，适合纯甜向剧情',
    categoryId: 'romance',
    axisPathHint: '关系.情感天平',
    axisVariableName: '情感天平',
    defaultSectionName: '关系',
    axisRange: '0~100',
    axisDirection: '>=',
    colorToken: 'success',
    characterSuitabilityHint: '需要可发展感情的角色',
    analyzeHint: '阶段轴必须是「关系.情感天平」（0~100），方向为递增（>=）。阶段覆盖从初识到深爱的完整纯爱路径。',
    stageContentHint: '纯爱模板使用单一 0~100「情感天平」作为阶段轴（单向递增）：阶段内容要写女主与主角之间的情感推进，天平值越高（阶段越靠后）关系越亲密、越专一。\n- 不要预设女主有 NTR 历史、曾是敌方玩物或“公交车”等背景，除非用户引导词明确要求。',
    sections: [
      {
        name: '关系',
        variables: [
          {
            path: '关系.情感天平',
            zodType: 'z.coerce.number()',
            description: '对主角的情感倾向：0=初识，100=深爱，单调递增（只升不降）',
            prefix: '',
            initialValue: 0,
            range: { min: 0, max: 100 },
            categories: [
              { range: '>= 90', label: '深爱' },
              { range: '>= 75', label: '恋人' },
              { range: '>= 60', label: '暧昧' },
              { range: '>= 40', label: '朋友' },
              { range: '>= 20', label: '认识' },
              { range: '>= 0', label: '陌生人' },
            ],
          },
        ],
      },
    ],
    updateRules: [
      { path: '关系.情感天平', type: 'number', range: '0~100', check: ['正面互动 +(3~8)，特殊事件（送礼/告白） +(10~20)', '只增不减，单调递增，达到阈值自动推进阶段'] },
    ],
    statusBarTitle: '纯爱情感',
    statusBarVars: ['关系.情感天平'],
  },
  {
    id: 'ntr',
    name: '虐恋NTR',
    icon: '🖤',
    description: '单一情感天平 0~100 单向递增，适合纯虐向剧情',
    categoryId: 'romance',
    axisPathHint: '关系.情感天平',
    axisVariableName: '情感天平',
    defaultSectionName: '关系',
    axisRange: '0~100',
    axisDirection: '>=',
    colorToken: 'danger',
    characterSuitabilityHint: '需要可堕落/可被介入的角色',
    analyzeHint: '阶段轴必须是「关系.情感天平」（0~100），方向为递增（>=）。阶段覆盖从压抑到毁灭的完整堕落路径。',
    stageContentHint: 'NTR 模板使用单一 0~100「情感天平」作为阶段轴（单向递增）：阶段内容要写女主心理防线逐步崩塌、与第三者关系逐渐加深的过程，天平值越高堕落越深。\n- 可以从当前阶段开始写对手试图介入、女主逐渐动摇或被攻陷，但不要默认女主过去就已经是玩物（除非用户引导词明确要求）。',
    sections: [
      {
        name: '关系',
        variables: [
          {
            path: '关系.情感天平',
            zodType: 'z.coerce.number()',
            description: '情感堕落程度：0=纯洁，100=沉沦，单调递增（只增不减）',
            prefix: '',
            initialValue: 0,
            range: { min: 0, max: 100 },
            categories: [
              { range: '>= 95', label: '毁灭' },
              { range: '>= 70', label: '沉沦' },
              { range: '>= 40', label: '沦陷' },
              { range: '>= 20', label: '动摇' },
              { range: '>= 0', label: '压抑' },
            ],
          },
        ],
      },
    ],
    updateRules: [
      { path: '关系.情感天平', type: 'number', range: '0~100', check: ['被动事件/胁迫 +(5~15)，主动堕落 +(3~8)', '只增不减，单调递增，达到阈值自动推进阶段'] },
    ],
    statusBarTitle: '堕落情感',
    statusBarVars: ['关系.情感天平'],
  },
  {
    id: 'dual-route',
    name: '可纯爱可NTR',
    icon: '🔀',
    description: '单一情感天平 -100~100，0附近为缓冲带，支持一次性特殊事件',
    categoryId: 'romance',
    axisPathHint: '关系.情感天平',
    axisVariableName: '情感天平',
    defaultSectionName: '关系',
    axisRange: '-100~100',
    axisDirection: '>=',
    colorToken: 'warning',
    characterSuitabilityHint: '需要可发展剧情的角色',
    analyzeHint: '阶段轴必须是单一 -100~100 的「关系.情感天平」（或多角色模式下的「角色名.情感天平」），0 附近 -20~20 为缓冲带/中立，正值方向触发纯爱阶段，负值方向触发 NTR 阶段。',
    stageContentHint: '双路线模板使用单一 -100~100「情感天平」作为阶段轴：阶段条件为 ">=" 时写纯爱侧（对主角好感递增），阶段条件为 ">=" 且阈值在负区时写 NTR 侧（向第三者/堕落滑落）。\n- -20~20 为缓冲带/中立阶段：情感未定，日常互动不会大幅摆动，只有明确指向纯爱或NTR的情节才会跨区。\n- 纯爱侧：主角真诚关心、保护、尊重、亲密、共同回忆，或女主主动靠近 → 天平正向增长。\n- NTR侧（敌人受益的"正面"互动）：主角帮情敌还债/向威胁屈服/牺牲女主利益/让女主单独面对威胁/敌人 → 天平负向滑落。\n- NTR侧（主角负面行为）：主角欺骗/背叛/冷落/主动伤害/暴力 → 天平负向滑落。\n- 特殊事件：当剧情出现「玩家方触发恶堕事件（背叛/伤害/主动推向他人）」或「女主被胁迫/强制发生恶堕事件」时，天平会一次性大幅下跌（-30~-50）。"NTR·沦陷"及以后阶段可视为已发生重大转折，但要从当前阶段开始写，不要默认过去已经发生。',
    specialRulesHint: '双路线默认设定（重要）：\n- 默认状态下，女主**没有被对手攻略过**，也没有与对方发生过亲密关系。\n- 正向（纯爱）阶段只写女主与主角之间的情感推进，**不要预设女主是“公交车”、曾是敌方玩物、有过NTR历史等背景**。\n- 负向（NTR）阶段可以写对手试图介入、女主逐渐动摇或被攻陷的过程，但要从当前阶段开始写，不要默认过去已经发生。\n- 只有用户引导词明确要求时，才允许给女主加上“曾被攻略”“曾是玩物”等历史设定。',
    sections: [
      {
        name: '关系',
        variables: [
          {
            path: '关系.情感天平',
            zodType: 'z.coerce.number()',
            description: '情感倾向核心变量：>0 偏向纯爱主角，<0 偏向 NTR 第三者，0 附近为缓冲带',
            prefix: '',
            initialValue: 0,
            range: { min: -100, max: 100 },
            categories: [
              { range: '>= 100', label: '纯爱·至死不渝' },
              { range: '>= 80', label: '纯爱·深爱' },
              { range: '>= 50', label: '纯爱·恋人' },
              { range: '>= 20', label: '纯爱·暧昧' },
              { range: '>= -20', label: '中立·缓冲带' },
              { range: '>= -50', label: 'NTR·动摇' },
              { range: '>= -80', label: 'NTR·沦陷' },
              { range: '>= -100', label: 'NTR·沉沦' },
            ],
          },
          { path: '关系.恶堕事件玩家方', zodType: 'z.boolean()', description: '隐藏标记：玩家方触发恶堕事件（如主角背叛/伤害女主/主动把她推向他人等），一次性大幅拉低情感天平后锁定，防止重复触发', prefix: '$', initialValue: false },
          { path: '关系.被强制恶堕', zodType: 'z.boolean()', description: '隐藏标记：女主被胁迫/强制发生恶堕事件（如被下药、被威胁、被强迫等），一次性大幅拉低情感天平后锁定，防止重复触发', prefix: '$', initialValue: false },
        ],
      },
    ],
    updateRules: [
      {
        path: '关系.情感天平',
        type: 'number',
        range: '-100~100',
        check: [
          '纯爱侧：主角真诚关心/保护/尊重/亲密/共同回忆，或女主主动靠近 → +3~15',
          'NTR侧（敌人受益的"正面"互动）：主角帮情敌/向威胁屈服/牺牲女主利益/让女主单独面对威胁/敌人 → -5~20',
          'NTR侧（主角负面行为）：主角欺骗/背叛/冷落/主动伤害/暴力 → -5~20',
          '缓冲带：当前值在 -20~20 时，日常互动只 ±1~3；只有明确指向纯爱或NTR的情节才允许 ±5~15 跨区',
          '特殊事件：若「玩家方触发恶堕事件（背叛/伤害/主动推向他人）」且 关系.恶堕事件玩家方=false，则一次性 -30~-50 并将 关系.恶堕事件玩家方 设为 true',
          '特殊事件：若「女主被胁迫/强制发生恶堕事件」且 关系.被强制恶堕=false，则一次性 -30~-50 并将 关系.被强制恶堕 设为 true',
        ],
      },
      { path: '关系.恶堕事件玩家方', check: ['初始 false', '仅在「玩家方触发恶堕事件」时设为 true，一次性事件不可恢复'] },
      { path: '关系.被强制恶堕', check: ['初始 false', '仅在「女主被强制恶堕」时设为 true，一次性事件不可恢复'] },
    ],
    statusBarTitle: '情感天平',
    statusBarVars: ['关系.情感天平'],
  },

  // ── 成长突破型 ──────────────────────────────────────────────
  {
    id: 'cultivation',
    name: '修仙境界',
    icon: '🏔️',
    description: '单一修为值 0~100 单向递增，适合修真/玄幻成长剧情',
    categoryId: 'growth',
    axisPathHint: '境界.修为',
    axisVariableName: '修为',
    defaultSectionName: '境界',
    axisRange: '0~100',
    axisDirection: '>=',
    colorToken: 'success',
    characterSuitabilityHint: '需要可成长/可突破境界的修仙或玄幻角色',
    analyzeHint: '阶段轴必须是「境界.修为」（0~100），方向为递增（>=）。阶段覆盖从炼气到大乘的完整修仙路径，每个阶段对应不同的境界层次。',
    stageContentHint: '修仙境界模板使用单一 0~100「修为」作为阶段轴（单向递增）：阶段内容要写角色在该境界的修炼状态、能力边界、心性变化、对天道/大道的感悟，修为值越高（阶段越靠后）境界越高、能力越强、越接近飞升。每个阶段要写出该境界独有的能力特征、修炼瓶颈、心境变化。',
    sections: [
      {
        name: '境界',
        variables: [
          {
            path: '境界.修为',
            zodType: 'z.coerce.number()',
            description: '修为境界：0=炼气入门，100=大乘圆满，单调递增（只升不降）',
            prefix: '',
            initialValue: 0,
            range: { min: 0, max: 100 },
            categories: [
              { range: '>= 100', label: '大乘' },
              { range: '>= 90', label: '炼虚' },
              { range: '>= 75', label: '化神' },
              { range: '>= 55', label: '元婴' },
              { range: '>= 35', label: '金丹' },
              { range: '>= 15', label: '筑基' },
              { range: '>= 0', label: '炼气' },
            ],
          },
        ],
      },
    ],
    updateRules: [
      { path: '境界.修为', type: 'number', range: '0~100', check: ['修炼/打坐/参悟 +(3~8)，突破瓶颈 +(10~25)', '服用灵药/得到传承 +(15~30)', '走火入魔/重伤 -(10~30)，但不会跌破上一大境界底线', '只增不减（大境界内），突破后自动推进阶段'] },
    ],
    statusBarTitle: '修为境界',
    statusBarVars: ['境界.修为'],
  },

  // ── 冒险剧情型 ──────────────────────────────────────────────
  {
    id: 'main-plot',
    name: '主线推进',
    icon: '🗺️',
    description: '单一进度值 0~100 单向递增，适合冒险/剧情推进',
    categoryId: 'adventure',
    axisPathHint: '剧情.进度',
    axisVariableName: '进度',
    defaultSectionName: '剧情',
    axisRange: '0~100',
    axisDirection: '>=',
    colorToken: 'info',
    characterSuitabilityHint: '需要参与主线剧情、推动故事发展的角色',
    analyzeHint: '阶段轴必须是「剧情.进度」（0~100），方向为递增（>=）。阶段覆盖从序章到结局的完整剧情脉络，每个阶段对应一个剧情节点。',
    stageContentHint: '主线推进模板使用单一 0~100「进度」作为阶段轴（单向递增）：阶段内容要写该剧情节点下角色的处境、可推进的事件、与世界的互动方式、可选的分支走向，进度值越高（阶段越靠后）剧情越接近高潮与结局。每个阶段要写出该节点独有的场景、关键人物、冲突焦点。',
    sections: [
      {
        name: '剧情',
        variables: [
          {
            path: '剧情.进度',
            zodType: 'z.coerce.number()',
            description: '主线进度：0=序章，100=结局，单调递增（只升不降）',
            prefix: '',
            initialValue: 0,
            range: { min: 0, max: 100 },
            categories: [
              { range: '>= 100', label: '终章' },
              { range: '>= 85', label: '高潮' },
              { range: '>= 65', label: '转折' },
              { range: '>= 40', label: '发展' },
              { range: '>= 20', label: '起步' },
              { range: '>= 0', label: '序章' },
            ],
          },
        ],
      },
    ],
    updateRules: [
      { path: '剧情.进度', type: 'number', range: '0~100', check: ['主线关键事件 +(10~25)，支线完成 +(3~8)', '日常互动 +(0~2)，探索/询问 +(1~5)', '只增不减，达到阈值自动推进阶段'] },
    ],
    statusBarTitle: '主线进度',
    statusBarVars: ['剧情.进度'],
  },

  // ── 黑化堕落型 ──────────────────────────────────────────────
  {
    id: 'corruption',
    name: '心智污染',
    icon: '🌑',
    description: '单一污染度 0~100 单向递增，适合黑化/堕落/精神崩坏剧情',
    categoryId: 'darkness',
    axisPathHint: '心智.污染度',
    axisVariableName: '污染度',
    defaultSectionName: '心智',
    axisRange: '0~100',
    axisDirection: '>=',
    colorToken: 'danger',
    characterSuitabilityHint: '需要可被腐化/可黑化/精神可崩坏的角色',
    analyzeHint: '阶段轴必须是「心智.污染度」（0~100），方向为递增（>=）。阶段覆盖从正常到毁灭的完整堕落路径，每个阶段对应不同的心智状态。',
    stageContentHint: '心智污染模板使用单一 0~100「污染度」作为阶段轴（单向递增）：阶段内容要写角色在该污染程度下的心理变化、行为异常、认知扭曲、感官变异，污染度越高（阶段越靠后）精神越崩坏、行为越失控、越难以挽回。每个阶段要写出该污染程度特有的异常表现、触发刺激、自我认知偏差。',
    sections: [
      {
        name: '心智',
        variables: [
          {
            path: '心智.污染度',
            zodType: 'z.coerce.number()',
            description: '心智污染程度：0=正常，100=毁灭，单调递增（只增不减）',
            prefix: '',
            initialValue: 0,
            range: { min: 0, max: 100 },
            categories: [
              { range: '>= 100', label: '毁灭' },
              { range: '>= 85', label: '崩溃' },
              { range: '>= 65', label: '黑化' },
              { range: '>= 40', label: '异常' },
              { range: '>= 20', label: '动摇' },
              { range: '>= 0', label: '正常' },
            ],
          },
        ],
      },
    ],
    updateRules: [
      { path: '心智.污染度', type: 'number', range: '0~100', check: ['刺激/创伤/诱惑 +(5~15)，被动腐化/侵蚀 +(3~8)', '重大打击 +(15~30)，持续暴露 +(1~3)', '只增不减，达到阈值自动推进阶段'] },
    ],
    statusBarTitle: '心智污染',
    statusBarVars: ['心智.污染度'],
  },

  // ── 悬疑推理型 ──────────────────────────────────────────────
  {
    id: 'investigation',
    name: '案件调查',
    icon: '🔍',
    description: '单一真相度 0~100 单向递增，适合悬疑/推理/探案剧情',
    categoryId: 'mystery',
    axisPathHint: '调查.真相度',
    axisVariableName: '真相度',
    defaultSectionName: '调查',
    axisRange: '0~100',
    axisDirection: '>=',
    colorToken: 'info',
    characterSuitabilityHint: '需要参与调查/推理/探案的角色',
    analyzeHint: '阶段轴必须是「调查.真相度」（0~100），方向为递增（>=）。阶段覆盖从迷雾到真相的完整推理路径，每个阶段对应不同的真相揭露程度。',
    stageContentHint: '案件调查模板使用单一 0~100「真相度」作为阶段轴（单向递增）：阶段内容要写角色在该真相揭露程度下的已知信息、推理方向、可获取线索、怀疑对象，真相度越高（阶段越靠后）越接近案件全貌。每个阶段要写出该阶段独有的已知证据、未知谜团、推理突破口。',
    sections: [
      {
        name: '调查',
        variables: [
          {
            path: '调查.真相度',
            zodType: 'z.coerce.number()',
            description: '真相揭露程度：0=迷雾，100=真相大白，单调递增（只升不降）',
            prefix: '',
            initialValue: 0,
            range: { min: 0, max: 100 },
            categories: [
              { range: '>= 100', label: '反转/终局' },
              { range: '>= 90', label: '破案' },
              { range: '>= 75', label: '真相浮现' },
              { range: '>= 55', label: '锁定嫌疑人' },
              { range: '>= 35', label: '线索串联' },
              { range: '>= 15', label: '初步调查' },
              { range: '>= 0', label: '迷雾' },
            ],
          },
        ],
      },
    ],
    updateRules: [
      { path: '调查.真相度', type: 'number', range: '0~100', check: ['关键线索/证据 +(10~20)，询问/勘察 +(3~8)', '误导线索 -(3~8)，但不会跌破上一阶段底线', '只增不减（阶段内），达到阈值自动推进阶段'] },
    ],
    statusBarTitle: '调查真相度',
    statusBarVars: ['调查.真相度'],
  },
];

/** 与分阶段世界书调度系统兼容的模板 id 白名单（由 STAGED_TEMPLATES 派生） */
export const STAGED_COMPATIBLE_TEMPLATE_IDS: readonly string[] = STAGED_TEMPLATES.map(t => t.id);

/** 按 id 查找分阶段模板 */
export function getStagedTemplateById(id: string): BeginnerTemplate | undefined {
  return STAGED_TEMPLATES.find(t => t.id === id);
}

/** 按大类 id 过滤模板 */
export function getTemplatesByCategory(categoryId: string): BeginnerTemplate[] {
  return STAGED_TEMPLATES.filter(t => t.categoryId === categoryId);
}

/** 生成模板的语义化标签（供 AI prompt 使用），如「甜宠纯爱（关系.情感天平 0~100）」 */
export function getTemplateLabel(id: string): string {
  const t = getStagedTemplateById(id);
  if (!t) return id;
  return `${t.name}（${t.axisPathHint} ${t.axisRange}）`;
}

/**
 * 通用：为多角色模式构建以 charName 为前缀的变量分区。
 * 取模板第一个 section，把 section.name 和变量路径前缀替换为 charName。
 */
export function buildSectionForChar(template: BeginnerTemplate, charName: string): MvuSchemaSection {
  const source = template.sections[0];
  if (!source) return { name: charName, variables: [] };
  const oldPrefix = `${source.name}.`;
  return {
    name: charName,
    variables: source.variables.map(v => ({
      ...v,
      path: v.path.startsWith(oldPrefix)
        ? `${charName}.${v.path.slice(oldPrefix.length)}`
        : v.path,
    })),
  };
}

/**
 * 通用：为多角色模式构建以 charName 为前缀的更新规则。
 * 把 path 和 check 文本中的「分区名.」前缀替换为「charName.」。
 */
export function buildRulesForChar(template: BeginnerTemplate, charName: string): MvuUpdateRule[] {
  const source = template.sections[0];
  if (!source) return [];
  const oldPrefix = `${source.name}.`;
  const newPrefix = `${charName}.`;
  return template.updateRules.map(r => ({
    ...r,
    path: r.path.startsWith(oldPrefix) ? `${newPrefix}${r.path.slice(oldPrefix.length)}` : r.path,
    check: r.check?.map(c => c.split(oldPrefix).join(newPrefix)),
  }));
}

/**
 * 生成模板蓝图（供 AI 多角色变量生成参考）。
 * 动态读取模板的 sections，描述阶段轴变量、categories 分段、隐藏标记等。
 */
export function buildTemplateBlueprint(template: BeginnerTemplate): string {
  const section = template.sections[0];
  if (!section) return '';
  const axisVar = section.variables.find(v => v.path === template.axisPathHint) || section.variables[0];
  const hiddenFlags = section.variables.filter(v => v.prefix === '$');
  const cats = axisVar?.categories;

  const lines: string[] = [];
  lines.push(`变量结构（只允许单一「${template.axisVariableName}」变量作为阶段轴，数值阈值型）：`);
  lines.push(`- ${section.name}.${template.axisVariableName} (number ${template.axisRange}, 初始${axisVar?.initialValue ?? 0})：${axisVar?.description ?? ''}。这是【阶段轴变量】，通过 categories 阈值分段实现 ${cats?.length || 0} 个阶段：`);
  if (cats && cats.length > 0) {
    lines.push(`  - categories: ${JSON.stringify(cats)}`);
  }
  if (hiddenFlags.length > 0) {
    lines.push(`- 隐藏标记（$ 前缀，初始 false，仅用于一次性事件防重复）：`);
    for (const flag of hiddenFlags) {
      lines.push(`  - ${section.name}.${flag.path.split('.').slice(1).join('.')} (boolean)：${flag.description}`);
    }
  }
  lines.push('更新规则要点：');
  for (const rule of template.updateRules) {
    if (rule.check) {
      for (const c of rule.check) lines.push(`  - ${c}`);
    }
  }
  lines.push(`禁止生成 ${template.axisVariableName} 之外的其他可见变量。`);
  return lines.join('\n');
}

/** 将分阶段模板组装为完整的 MvuConfig（立即生成 schema.ts / initvar.yaml / 更新规则.yaml / EJS 预处理）。
 * 分阶段步骤选中模板时调用，使变量定义自包含于分阶段功能内部，无需独立的 MVU 变量步骤。 */
export function applyStagedTemplate(template: BeginnerTemplate): MvuConfig {
  const sections = deepClone(template.sections);
  const updateRules = deepClone(template.updateRules);
  return {
    enabled: true,
    mode: 'beginner',
    beginnerTemplateId: template.id,
    schemaSections: sections,
    updateRules: updateRules,
    ejsConfigs: [],
    ejsPreprocessContent: buildEjsPreprocess([], sections),
    schemaTsContent: buildSchemaTs(sections),
    initvarYamlContent: buildInitvarYaml(sections),
    updateRulesYamlContent: buildUpdateRulesYaml(updateRules),
    statusBarHtml: '',
    statusBarStyle: 'ai-custom',
  };
}

/** 将分阶段模板的变量/规则合并进已有 MvuConfig（保留 MVU 步骤定义的变量，不覆盖）。
 * 用于「MVU 步骤」与「分阶段模式」并存时：用户在第5步定义的变量得以保留，
 * 分阶段模板仅补充其阶段轴变量（如 关系.情感天平）。 */
export function mergeStagedTemplate(base: MvuConfig, template: BeginnerTemplate): MvuConfig {
  const sections: MvuSchemaSection[] = deepClone(base.schemaSections);
  const tplSections = deepClone(template.sections);

  for (const tplSection of tplSections) {
    let target = sections.find(s => s.name === tplSection.name);
    if (!target) {
      target = { name: tplSection.name, variables: [] };
      sections.push(target);
    }
    for (const tplVar of tplSection.variables) {
      const idx = target.variables.findIndex(v => v.path === tplVar.path);
      if (idx >= 0) target.variables[idx] = tplVar;
      else target.variables.push(tplVar);
    }
  }

  // 合并更新规则（按 path 去重，模板规则补充缺失项）
  const rules: MvuUpdateRule[] = deepClone(base.updateRules);
  const existingPaths = new Set(rules.map(r => r.path));
  for (const tplRule of template.updateRules) {
    if (!existingPaths.has(tplRule.path)) rules.push(deepClone(tplRule));
  }

  return {
    ...base,
    enabled: true,
    beginnerTemplateId: template.id,
    schemaSections: sections,
    updateRules: rules,
    ejsPreprocessContent: buildEjsPreprocess(base.ejsConfigs ?? [], sections),
    schemaTsContent: buildSchemaTs(sections),
    initvarYamlContent: buildInitvarYaml(sections),
    updateRulesYamlContent: buildUpdateRulesYaml(rules),
  };
}

// ── DIY / AI 自选阶段轴 ─────────────────────────────────────────────────────

/** AI 自选阶段轴的产物形状（useAIGenerate.autoGenerateStagedLorebook 的返回结构） */
export interface DiyStagedAxis {
  axisPath: string;
  axisType: 'enum' | 'number';
  numericDirection: '>=' | '<=';
  stages: Array<{ name: string; condition?: string }>;
}

/** 从阶段条件里提取数字阈值（'>= 70' → 70；无数字返回 null） */
function parseStageThreshold(condition: string | undefined): number | null {
  const match = (condition || '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/**
 * 把 DIY / AI 自选的阶段轴变量合并进 MVU 配置（合并语义对齐 mergeStagedTemplate：
 * 不覆盖已有变量、按 path 去重、重生成派生产物）。
 * 没有这一步，导出卡在真实运行时会因轴变量未在 stat_data 中初始化，
 * 调度条目永远走「变量未定义」分支——DIY 轴必须像模板轴一样自包含。
 */
export function mergeDiyStagedAxis(base: MvuConfig, axis: DiyStagedAxis): MvuConfig {
  const sectionName = axis.axisPath.split('.')[0] || '剧情';
  const stageNames = axis.stages.map(s => s.name).filter(Boolean);
  const thresholds = axis.stages
    .map(s => parseStageThreshold(s.condition))
    .filter((n): n is number => n !== null);

  let variable: MvuVariable;
  let rule: MvuUpdateRule;
  if (axis.axisType === 'number') {
    const min = thresholds.length ? Math.min(...thresholds) : 0;
    const max = thresholds.length ? Math.max(...thresholds) : 100;
    // 初始值 = 最不极端的一端：'>=' 轴从最低阈值起步，'<=' 轴从最高阈值起步
    const initial = axis.numericDirection === '<=' ? max : min;
    variable = {
      path: axis.axisPath,
      zodType: 'z.coerce.number()',
      description: `阶段轴变量（AI 自选）：${axis.numericDirection === '<=' ? '阈值以下触发' : '阈值以上触发'}，范围 ${min}~${max}，达到阈值进入对应阶段`,
      prefix: '',
      initialValue: initial,
      range: { min, max },
      categories: axis.stages
        .filter(s => (s.condition || '').trim())
        .map(s => ({ range: (s.condition || '').trim(), label: s.name })),
    };
    rule = {
      path: axis.axisPath,
      type: 'number',
      range: `${min}~${max}`,
      check: [
        '按剧情推进调整，达到阈值自动进入对应阶段',
        axis.numericDirection === '<=' ? '朝阈值方向单向递减' : '朝阈值方向单向递增',
      ],
    };
  } else {
    // enum 轴：AUTO_STAGED_LOREBOOK_PROMPT 的示例输出按「初始 → 最终」排序，首个即初始阶段
    const initial = stageNames[0] ?? '';
    variable = {
      path: axis.axisPath,
      zodType: `z.enum([${stageNames.map(n => JSON.stringify(n)).join(', ')}])`,
      description: `阶段轴变量（AI 自选）：离散阶段 ${stageNames.join(' / ')}`,
      prefix: '',
      initialValue: initial,
      enumValues: [...stageNames],
    };
    rule = {
      path: axis.axisPath,
      type: stageNames.map(n => `'${n}'`).join(' | '),
      check: ['剧情满足对应阶段条件时切换到该阶段值，不要跳阶段'],
    };
  }

  const sections: MvuSchemaSection[] = deepClone(base.schemaSections);
  let target = sections.find(s => s.name === sectionName);
  if (!target) {
    target = { name: sectionName, variables: [] };
    sections.push(target);
  }
  const idx = target.variables.findIndex(v => v.path === variable.path);
  if (idx >= 0) target.variables[idx] = variable;
  else target.variables.push(variable);

  const rules: MvuUpdateRule[] = deepClone(base.updateRules);
  if (!rules.some(r => r.path === rule.path)) rules.push(rule);

  return {
    ...base,
    enabled: true,
    beginnerTemplateId: 'diy',
    schemaSections: sections,
    updateRules: rules,
    ejsPreprocessContent: buildEjsPreprocess(base.ejsConfigs ?? [], sections),
    schemaTsContent: buildSchemaTs(sections),
    initvarYamlContent: buildInitvarYaml(sections),
    updateRulesYamlContent: buildUpdateRulesYaml(rules),
  };
}
