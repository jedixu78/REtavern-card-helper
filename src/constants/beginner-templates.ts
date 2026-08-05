/**
 * beginner-templates.ts — MVU 新手模式主题模板定义
 *
 * 每个模板提供：
 *   - 风格化的变量分区（schemaSections）
 *   - 对应的更新规则（updateRules）
 *   - 模板元数据（名称、图标、描述、主题色）
 *   - AI 生成蓝图（blueprint）：告诉 AI 如何为每个变量类别填充内容
 *
 * 架构设计：模板是"壳"（Shell），提供结构框架；
 * 玩家通过 API 调用来填充和增强内容（如生成秘籍名称、轶事故事等）。
 */
import type { MvuSchemaSection, MvuUpdateRule, MvuConfig } from './defaults';
import { createEmptyMvuConfig } from './defaults';

// ════════════════════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════════════════════

/** 模板中单个变量类别的 AI 生成蓝图 */
export interface TemplateVarBlueprint {
  /** 变量路径（点分） */
  path: string;
  /** 类别显示名 */
  label: string;
  /** AI 生成提示：告诉 AI 这个变量应该填什么内容 */
  generationHint: string;
  /** 是否支持 AI 一键生成内容 */
  aiGeneratable: boolean;
  /** 生成类型：'single' 单次生成 | 'list' 列表生成 | 'record' 记录生成 */
  generationType: 'single' | 'list' | 'record';
}

/** 模板分区蓝图（对应一个 schemaSection） */
export interface TemplateSectionBlueprint {
  /** 分区名 */
  name: string;
  /** 分区图标 */
  icon: string;
  /** 分区描述 */
  description: string;
  /** 该分区下的变量蓝图 */
  variables: TemplateVarBlueprint[];
}

/** 完整的主题模板定义 */
export interface BeginnerTemplate {
  /** 唯一标识 */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板图标（emoji） */
  icon: string;
  /** 一句话描述 */
  description: string;
  /** 主题色（CSS 色值，用于 UI 高亮） */
  themeColor: string;
  /** 主题渐变（用于卡片背景） */
  themeGradient: string;
  /** 标签（用于筛选） */
  tags: string[];
  /** 变量分区蓝图 */
  sections: TemplateSectionBlueprint[];
  /** 预定义的 schema sections（应用模板时直接使用） */
  buildSections: () => MvuSchemaSection[];
  /** 预定义的更新规则 */
  buildRules: () => MvuUpdateRule[];
  /** 状态栏标题 */
  statusBarTitle: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 武侠风格模板
// ════════════════════════════════════════════════════════════════════════════

const WUXIA_TEMPLATE: BeginnerTemplate = {
  id: 'wuxia',
  name: '江湖武侠',
  icon: '⚔️',
  description: '刀光剑影的武侠世界，包含秘籍、武功、江湖轶事、行囊等经典元素',
  themeColor: '#d4a574',
  themeGradient: 'linear-gradient(135deg, rgba(212,165,116,0.15), rgba(139,90,43,0.08))',
  tags: ['武侠', '古风', '江湖'],
  statusBarTitle: '江湖录',
  sections: [
    {
      name: '个人简介',
      icon: '🧑',
      description: '角色的江湖身份与背景',
      variables: [
        { path: '简介.姓名', label: '姓名', generationHint: '生成一个符合武侠风格的角色姓名，可含字号', generationType: 'single', aiGeneratable: true },
        { path: '简介.称号', label: '江湖称号', generationHint: '生成一个霸气的江湖绰号，如"剑胆琴心"、"血手人屠"', generationType: 'single', aiGeneratable: true },
        { path: '简介.门派', label: '所属门派', generationHint: '生成一个武侠门派名称及简介', generationType: 'single', aiGeneratable: true },
        { path: '简介.身份', label: '江湖身份', generationHint: '描述角色在江湖中的地位与身份', generationType: 'single', aiGeneratable: true },
        { path: '简介.性格', label: '性格特征', generationHint: '用性格调色盘结构描述：底色(核心1-2特质)+主色调(主导1-2特质)+点缀(反差0-2特质)，每个特质写3条具体行为衍生(日常/压力/隐藏场景)，而非抽象标签', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '武功秘籍',
      icon: '📜',
      description: '角色掌握的武功与秘籍',
      variables: [
        { path: '秘籍.列表', label: '秘籍列表', generationHint: '生成3-5本武功秘籍，每本包含名称、品阶（凡/灵/天/神）、修炼进度、效果描述', generationType: 'record', aiGeneratable: true },
        { path: '秘籍.当前修炼', label: '当前修炼', generationHint: '从秘籍列表中选择一本正在修炼的，描述修炼进度与瓶颈', generationType: 'single', aiGeneratable: true },
        { path: '秘籍.内力', label: '内力值', generationHint: '设定初始内力值（0-100），描述内力属性（纯阳/纯阴/混元）', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '武林轶事',
      icon: '📖',
      description: '江湖中流传的故事与传闻',
      variables: [
        { path: '轶事.列表', label: '轶事列表', generationHint: '生成3-5条江湖轶事/传闻，每条包含标题、内容摘要、可信度（确凿/存疑/传闻）', generationType: 'record', aiGeneratable: true },
        { path: '轶事.当前线索', label: '当前线索', generationHint: '生成一条正在追踪的江湖线索，描述来龙去脉', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '背包行囊',
      icon: '🎒',
      description: '角色携带的物品与装备',
      variables: [
        { path: '背包.列表', label: '物品列表', generationHint: '生成5-8件武侠风格物品，每件包含名称、类型（武器/防具/丹药/杂物）、品质、描述', generationType: 'record', aiGeneratable: true },
        { path: '背包.银两', label: '银两', generationHint: '设定初始银两数量', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '江湖属性',
      icon: '📊',
      description: '角色的核心数值属性',
      variables: [
        { path: '属性.武力', label: '武力', generationHint: '设定初始武力值（0-100）', generationType: 'single', aiGeneratable: true },
        { path: '属性.轻功', label: '轻功', generationHint: '设定初始轻功值（0-100）', generationType: 'single', aiGeneratable: true },
        { path: '属性.声望', label: '声望', generationHint: '设定初始江湖声望（-100~100，正为侠名，负为恶名）', generationType: 'single', aiGeneratable: true },
        { path: '属性.体力', label: '体力', generationHint: '设定初始体力值（0-100）', generationType: 'single', aiGeneratable: true },
      ],
    },
  ],
  buildSections: () => [
    {
      name: '个人简介',
      variables: [
        { path: '简介.姓名', zodType: 'z.string()', description: '角色姓名（含字号）', prefix: '_', initialValue: '' },
        { path: '简介.称号', zodType: 'z.string()', description: '江湖绰号', prefix: '', initialValue: '' },
        { path: '简介.门派', zodType: 'z.string()', description: '所属门派', prefix: '_', initialValue: '' },
        { path: '简介.身份', zodType: 'z.string()', description: '江湖身份地位', prefix: '_', initialValue: '' },
        { path: '简介.性格', zodType: 'z.string()', description: '性格特征描述', prefix: '_', initialValue: '' },
      ],
    },
    {
      name: '武功秘籍',
      variables: [
        { path: '秘籍.列表', zodType: 'z.record(z.string(), z.object({品阶: z.string(), 进度: z.string(), 效果: z.string()}))', description: '已习得秘籍（名称→品阶/进度/效果）', prefix: '', initialValue: {} },
        { path: '秘籍.当前修炼', zodType: 'z.string()', description: '正在修炼的秘籍名', prefix: '', initialValue: '' },
        { path: '秘籍.内力', zodType: 'z.coerce.number()', description: '内力值', prefix: '', initialValue: 50, range: { min: 0, max: 100 } },
      ],
    },
    {
      name: '武林轶事',
      variables: [
        { path: '轶事.列表', zodType: 'z.record(z.string(), z.object({摘要: z.string(), 可信度: z.enum(["确凿","存疑","传闻"])}))', description: '江湖传闻（标题→摘要/可信度）', prefix: '', initialValue: {} },
        { path: '轶事.当前线索', zodType: 'z.string()', description: '正在追踪的线索', prefix: '', initialValue: '' },
      ],
    },
    {
      name: '背包行囊',
      variables: [
        { path: '背包.列表', zodType: 'z.record(z.string(), z.object({类型: z.string(), 品质: z.string(), 描述: z.string()}))', description: '携带物品（名称→类型/品质/描述）', prefix: '', initialValue: {} },
        { path: '背包.银两', zodType: 'z.coerce.number()', description: '银两数量', prefix: '', initialValue: 100, range: { min: 0, max: 99999 } },
      ],
    },
    {
      name: '江湖属性',
      variables: [
        { path: '属性.武力', zodType: 'z.coerce.number()', description: '武力值', prefix: '', initialValue: 30, range: { min: 0, max: 100 } },
        { path: '属性.轻功', zodType: 'z.coerce.number()', description: '轻功值', prefix: '', initialValue: 20, range: { min: 0, max: 100 } },
        { path: '属性.声望', zodType: 'z.coerce.number()', description: '江湖声望（正侠负恶）', prefix: '', initialValue: 0, range: { min: -100, max: 100 } },
        { path: '属性.体力', zodType: 'z.coerce.number()', description: '体力值', prefix: '', initialValue: 100, range: { min: 0, max: 100 } },
      ],
    },
  ],
  buildRules: () => [
    { path: '秘籍.内力', type: 'number', range: '0~100', check: ['修炼武功时增加', '受伤或强行运功时减少', '单次变化 ±(2~10)'] },
    { path: '属性.武力', type: 'number', range: '0~100', check: ['战斗胜利或领悟新招式时增加', '长期不练或受重伤时可能减少', '单次变化 ±(1~5)'] },
    { path: '属性.轻功', type: 'number', range: '0~100', check: ['练习轻功或获得轻功秘籍时增加', '单次变化 ±(1~5)'] },
    { path: '属性.声望', type: 'number', range: '-100~100', check: ['行侠仗义、帮助他人时增加', '作恶多端、背信弃义时减少', '单次变化 ±(3~10)'] },
    { path: '属性.体力', type: 'number', range: '0~100', check: ['休息、进食、服药时恢复', '战斗、赶路、受伤时消耗', '单次变化 ±(5~20)'] },
    { path: '背包.银两', type: 'number', range: '0~99999', check: ['完成任务、出售物品时增加', '购买物品、打赏时减少'] },
    { path: '背包.列表', check: ['获得新物品时添加条目', '使用消耗品或丢弃时移除条目'] },
    { path: '秘籍.列表', check: ['获得新秘籍时添加条目', '修炼进度在突破时更新'] },
    { path: '轶事.列表', check: ['听闻新传闻时添加条目', '线索证实后更新可信度为"确凿"'] },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 修仙风格模板
// ════════════════════════════════════════════════════════════════════════════

const XIANXIA_TEMPLATE: BeginnerTemplate = {
  id: 'xianxia',
  name: '修仙问道',
  icon: '🏔️',
  description: '御剑飞行的修仙世界，包含境界、功法、灵石、丹药、宗门等要素',
  themeColor: '#7c9ed4',
  themeGradient: 'linear-gradient(135deg, rgba(124,158,212,0.15), rgba(80,120,180,0.08))',
  tags: ['修仙', '玄幻', '仙侠'],
  statusBarTitle: '道途录',
  sections: [
    {
      name: '道侣档案',
      icon: '🧙',
      description: '修仙者的基本身份信息',
      variables: [
        { path: '档案.道号', label: '道号', generationHint: '生成一个仙风道骨的道号，如"清虚子"、"玄冰仙子"', generationType: 'single', aiGeneratable: true },
        { path: '档案.宗门', label: '所属宗门', generationHint: '生成一个修仙宗门名称及简介', generationType: 'single', aiGeneratable: true },
        { path: '档案.灵根', label: '灵根属性', generationHint: '生成灵根属性（金木水火土/变异灵根），描述修炼天赋', generationType: 'single', aiGeneratable: true },
        { path: '档案.道心', label: '道心描述', generationHint: '描述角色的修道信念与心境', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '功法境界',
      icon: '☯️',
      description: '修炼功法与当前境界',
      variables: [
        { path: '功法.列表', label: '功法列表', generationHint: '生成3-5个功法/术法，每个包含名称、品阶（凡/灵/仙/道）、修炼层数、效果', generationType: 'record', aiGeneratable: true },
        { path: '功法.主修', label: '主修功法', generationHint: '选择主修功法并描述当前修炼状态', generationType: 'single', aiGeneratable: true },
        { path: '境界.当前', label: '当前境界', generationHint: '设定当前境界（练气/筑基/金丹/元婴/化神/渡劫/大乘）及层数', generationType: 'single', aiGeneratable: true },
        { path: '境界.灵力', label: '灵力值', generationHint: '设定当前灵力值（0-100）', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '洞天福地',
      icon: '🏠',
      description: '修炼资源与居所',
      variables: [
        { path: '资源.灵石', label: '灵石', generationHint: '设定灵石数量（下品/中品/上品）', generationType: 'single', aiGeneratable: true },
        { path: '资源.丹药', label: '丹药储备', generationHint: '生成2-4种丹药，每种包含名称、品阶、数量、功效', generationType: 'record', aiGeneratable: true },
        { path: '资源.法器', label: '法器', generationHint: '生成1-3件法器，包含名称、品阶、能力描述', generationType: 'record', aiGeneratable: true },
      ],
    },
    {
      name: '仙途属性',
      icon: '✨',
      description: '修仙核心数值',
      variables: [
        { path: '属性.悟性', label: '悟性', generationHint: '设定悟性值（0-100），影响修炼速度', generationType: 'single', aiGeneratable: true },
        { path: '属性.气运', label: '气运', generationHint: '设定气运值（0-100），影响奇遇概率', generationType: 'single', aiGeneratable: true },
        { path: '属性.寿元', label: '寿元', generationHint: '设定剩余寿元（年），与境界挂钩', generationType: 'single', aiGeneratable: true },
        { path: '属性.心境', label: '心境', generationHint: '设定心境值（0-100），影响突破成功率', generationType: 'single', aiGeneratable: true },
      ],
    },
  ],
  buildSections: () => [
    {
      name: '道侣档案',
      variables: [
        { path: '档案.道号', zodType: 'z.string()', description: '道号', prefix: '_', initialValue: '' },
        { path: '档案.宗门', zodType: 'z.string()', description: '所属宗门', prefix: '_', initialValue: '' },
        { path: '档案.灵根', zodType: 'z.string()', description: '灵根属性', prefix: '_', initialValue: '' },
        { path: '档案.道心', zodType: 'z.string()', description: '修道信念', prefix: '_', initialValue: '' },
      ],
    },
    {
      name: '功法境界',
      variables: [
        { path: '功法.列表', zodType: 'z.record(z.string(), z.object({品阶: z.string(), 层数: z.string(), 效果: z.string()}))', description: '已修功法（名称→品阶/层数/效果）', prefix: '', initialValue: {} },
        { path: '功法.主修', zodType: 'z.string()', description: '主修功法名', prefix: '', initialValue: '' },
        { path: '境界.当前', zodType: 'z.enum(["练气","筑基","金丹","元婴","化神","渡劫","大乘"])', description: '当前境界', prefix: '', initialValue: '练气', enumValues: ['练气', '筑基', '金丹', '元婴', '化神', '渡劫', '大乘'] },
        { path: '境界.灵力', zodType: 'z.coerce.number()', description: '灵力值', prefix: '', initialValue: 30, range: { min: 0, max: 100 } },
      ],
    },
    {
      name: '洞天福地',
      variables: [
        { path: '资源.灵石', zodType: 'z.coerce.number()', description: '灵石数量（下品）', prefix: '', initialValue: 50, range: { min: 0, max: 999999 } },
        { path: '资源.丹药', zodType: 'z.record(z.string(), z.object({品阶: z.string(), 数量: z.coerce.number(), 功效: z.string()}))', description: '丹药储备（名称→品阶/数量/功效）', prefix: '', initialValue: {} },
        { path: '资源.法器', zodType: 'z.record(z.string(), z.object({品阶: z.string(), 能力: z.string()}))', description: '法器（名称→品阶/能力）', prefix: '', initialValue: {} },
      ],
    },
    {
      name: '仙途属性',
      variables: [
        { path: '属性.悟性', zodType: 'z.coerce.number()', description: '悟性（影响修炼速度）', prefix: '', initialValue: 50, range: { min: 0, max: 100 } },
        { path: '属性.气运', zodType: 'z.coerce.number()', description: '气运（影响奇遇）', prefix: '', initialValue: 50, range: { min: 0, max: 100 } },
        { path: '属性.寿元', zodType: 'z.coerce.number()', description: '剩余寿元（年）', prefix: '', initialValue: 100, range: { min: 0, max: 99999 } },
        { path: '属性.心境', zodType: 'z.coerce.number()', description: '心境（影响突破）', prefix: '', initialValue: 40, range: { min: 0, max: 100 } },
      ],
    },
  ],
  buildRules: () => [
    { path: '境界.灵力', type: 'number', range: '0~100', check: ['打坐修炼、服用丹药时增加', '施展术法、战斗时消耗', '单次变化 ±(5~15)'] },
    { path: '境界.当前', check: ['灵力满溢且心境达标时可尝试突破', '突破失败可能跌落或受伤'] },
    { path: '属性.悟性', type: 'number', range: '0~100', check: ['顿悟、阅读古籍时增加', '单次变化 ±(1~3)'] },
    { path: '属性.气运', type: 'number', range: '0~100', check: ['行善积德、完成因果时增加', '作恶、违背道心时减少', '单次变化 ±(2~8)'] },
    { path: '属性.寿元', type: 'number', range: '0~99999', check: ['突破境界时大幅增加', '使用禁术、强行续命时消耗', '每年自然减少1'] },
    { path: '属性.心境', type: 'number', range: '0~100', check: ['历练感悟、化解心魔时增加', '遭遇心魔、执念加深时减少', '单次变化 ±(3~10)'] },
    { path: '资源.灵石', type: 'number', range: '0~999999', check: ['完成任务、出售材料时增加', '购买物品、布置阵法时消耗'] },
    { path: '资源.丹药', check: ['炼丹成功时添加', '服用时减少数量'] },
    { path: '功法.列表', check: ['获得新功法时添加', '修炼突破时更新层数'] },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 末日生存模板
// ════════════════════════════════════════════════════════════════════════════

const APOCALYPSE_TEMPLATE: BeginnerTemplate = {
  id: 'apocalypse',
  name: '末日求生',
  icon: '☢️',
  description: '废墟中的生存挑战，包含物资、据点、威胁、幸存者关系等要素',
  themeColor: '#8b9e6b',
  themeGradient: 'linear-gradient(135deg, rgba(139,158,107,0.15), rgba(90,110,60,0.08))',
  tags: ['末日', '生存', '废土'],
  statusBarTitle: '生存日志',
  sections: [
    {
      name: '幸存者档案',
      icon: '🪪',
      description: '幸存者的基本信息',
      variables: [
        { path: '档案.代号', label: '代号', generationHint: '生成一个末日风格的代号，如"铁鸦"、"灰烬行者"', generationType: 'single', aiGeneratable: true },
        { path: '档案.职业', label: '灾前职业', generationHint: '生成灾前职业及其对生存的影响', generationType: 'single', aiGeneratable: true },
        { path: '档案.特长', label: '生存特长', generationHint: '生成1-2项生存特长，如"机械维修"、"草药识别"', generationType: 'single', aiGeneratable: true },
        { path: '档案.创伤', label: '心理创伤', generationHint: '生成一个心理创伤/阴影，影响角色行为', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '物资储备',
      icon: '📦',
      description: '生存物资与装备',
      variables: [
        { path: '物资.列表', label: '物资清单', generationHint: '生成5-8件末日物资，每件包含名称、类型（食物/水/医疗/武器/工具）、数量、状态', generationType: 'record', aiGeneratable: true },
        { path: '物资.食物', label: '食物储备', generationHint: '设定食物可维持天数', generationType: 'single', aiGeneratable: true },
        { path: '物资.净水', label: '净水储备', generationHint: '设定净水可维持天数', generationType: 'single', aiGeneratable: true },
        { path: '物资.弹药', label: '弹药', generationHint: '设定弹药数量', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '据点情报',
      icon: '🗺️',
      description: '据点与周边情报',
      variables: [
        { path: '据点.名称', label: '据点名称', generationHint: '生成据点名称及简介，如"第七区地下避难所"', generationType: 'single', aiGeneratable: true },
        { path: '据点.防御', label: '防御等级', generationHint: '设定据点防御等级（1-10）', generationType: 'single', aiGeneratable: true },
        { path: '据点.威胁', label: '当前威胁', generationHint: '生成当前面临的主要威胁，如"变异兽群迁徙"、"掠夺者侦察"', generationType: 'single', aiGeneratable: true },
        { path: '情报.列表', label: '情报列表', generationHint: '生成2-4条周边情报，每条包含来源、内容、紧急度', generationType: 'record', aiGeneratable: true },
      ],
    },
    {
      name: '生存指标',
      icon: '❤️',
      description: '核心生存数值',
      variables: [
        { path: '指标.健康', label: '健康', generationHint: '设定健康值（0-100）', generationType: 'single', aiGeneratable: true },
        { path: '指标.精神', label: '精神状态', generationHint: '设定精神状态值（0-100），低于30可能出现幻觉', generationType: 'single', aiGeneratable: true },
        { path: '指标.生存天数', label: '生存天数', generationHint: '设定已生存天数', generationType: 'single', aiGeneratable: true },
        { path: '指标.信任', label: '团队信任', generationHint: '设定团队信任度（0-100）', generationType: 'single', aiGeneratable: true },
      ],
    },
  ],
  buildSections: () => [
    {
      name: '幸存者档案',
      variables: [
        { path: '档案.代号', zodType: 'z.string()', description: '幸存者代号', prefix: '_', initialValue: '' },
        { path: '档案.职业', zodType: 'z.string()', description: '灾前职业', prefix: '_', initialValue: '' },
        { path: '档案.特长', zodType: 'z.string()', description: '生存特长', prefix: '_', initialValue: '' },
        { path: '档案.创伤', zodType: 'z.string()', description: '心理创伤', prefix: '_', initialValue: '' },
      ],
    },
    {
      name: '物资储备',
      variables: [
        { path: '物资.列表', zodType: 'z.record(z.string(), z.object({类型: z.string(), 数量: z.coerce.number(), 状态: z.string()}))', description: '物资清单（名称→类型/数量/状态）', prefix: '', initialValue: {} },
        { path: '物资.食物', zodType: 'z.coerce.number()', description: '食物可维持天数', prefix: '', initialValue: 7, range: { min: 0, max: 365 } },
        { path: '物资.净水', zodType: 'z.coerce.number()', description: '净水可维持天数', prefix: '', initialValue: 5, range: { min: 0, max: 365 } },
        { path: '物资.弹药', zodType: 'z.coerce.number()', description: '弹药数量', prefix: '', initialValue: 24, range: { min: 0, max: 9999 } },
      ],
    },
    {
      name: '据点情报',
      variables: [
        { path: '据点.名称', zodType: 'z.string()', description: '据点名称', prefix: '_', initialValue: '' },
        { path: '据点.防御', zodType: 'z.coerce.number()', description: '防御等级', prefix: '', initialValue: 3, range: { min: 1, max: 10 } },
        { path: '据点.威胁', zodType: 'z.string()', description: '当前主要威胁', prefix: '', initialValue: '' },
        { path: '情报.列表', zodType: 'z.record(z.string(), z.object({来源: z.string(), 内容: z.string(), 紧急度: z.enum(["低","中","高","危急"])}))', description: '周边情报（标题→来源/内容/紧急度）', prefix: '', initialValue: {} },
      ],
    },
    {
      name: '生存指标',
      variables: [
        { path: '指标.健康', zodType: 'z.coerce.number()', description: '健康值', prefix: '', initialValue: 80, range: { min: 0, max: 100 } },
        { path: '指标.精神', zodType: 'z.coerce.number()', description: '精神状态', prefix: '', initialValue: 70, range: { min: 0, max: 100 } },
        { path: '指标.生存天数', zodType: 'z.coerce.number()', description: '已生存天数', prefix: '', initialValue: 1, range: { min: 0, max: 99999 } },
        { path: '指标.信任', zodType: 'z.coerce.number()', description: '团队信任度', prefix: '', initialValue: 50, range: { min: 0, max: 100 } },
      ],
    },
  ],
  buildRules: () => [
    { path: '物资.食物', type: 'number', range: '0~365', check: ['搜刮到食物时增加', '每日消耗1天份', '分享或交易时减少'] },
    { path: '物资.净水', type: 'number', range: '0~365', check: ['找到水源或净化时增加', '每日消耗1天份'] },
    { path: '物资.弹药', type: 'number', range: '0~9999', check: ['搜刮或交易时增加', '战斗射击时消耗'] },
    { path: '指标.健康', type: 'number', range: '0~100', check: ['治疗、休息、营养充足时恢复', '受伤、感染、饥饿时下降', '单次变化 ±(5~20)'] },
    { path: '指标.精神', type: 'number', range: '0~100', check: ['社交、安全感、完成任务时恢复', '目睹死亡、孤立、恐惧时下降', '低于30出现幻觉/偏执'] },
    { path: '指标.生存天数', type: 'number', check: ['每过一个游戏日自动+1'] },
    { path: '指标.信任', type: 'number', range: '0~100', check: ['帮助队友、分享物资时增加', '隐瞒、背叛、自私行为时减少', '单次变化 ±(3~10)'] },
    { path: '据点.防御', type: 'number', range: '1~10', check: ['加固设施时增加', '遭受攻击破坏时减少'] },
    { path: '物资.列表', check: ['搜刮到新物资时添加', '使用或交易时移除/减少'] },
    { path: '情报.列表', check: ['侦察或获得消息时添加', '情报过时或已处理时移除'] },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 现代都市模板
// ════════════════════════════════════════════════════════════════════════════

const MODERN_TEMPLATE: BeginnerTemplate = {
  id: 'modern',
  name: '都市日常',
  icon: '🌆',
  description: '现代都市背景，包含社交、日程、物品、好感度等日常互动要素',
  themeColor: '#c47db5',
  themeGradient: 'linear-gradient(135deg, rgba(196,125,181,0.15), rgba(150,80,135,0.08))',
  tags: ['现代', '都市', '日常'],
  statusBarTitle: '生活手账',
  sections: [
    {
      name: '人物档案',
      icon: '👤',
      description: '角色的基本信息',
      variables: [
        { path: '档案.姓名', label: '姓名', generationHint: '生成一个现代风格的角色姓名', generationType: 'single', aiGeneratable: true },
        { path: '档案.职业', label: '职业', generationHint: '生成职业及工作描述', generationType: 'single', aiGeneratable: true },
        { path: '档案.性格', label: '性格', generationHint: '用性格调色盘结构描述：底色(核心1-2特质)+主色调(主导1-2特质)+点缀(反差0-2特质)，每个特质写3条具体行为衍生(日常/压力/隐藏场景)，而非抽象标签', generationType: 'single', aiGeneratable: true },
        { path: '档案.秘密', label: '隐藏秘密', generationHint: '生成一个角色隐藏的秘密，增加剧情张力', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '社交关系',
      icon: '💬',
      description: '与他人的关系网络',
      variables: [
        { path: '社交.好感度', label: '好感度', generationHint: '设定初始好感度（0-100）', generationType: 'single', aiGeneratable: true },
        { path: '社交.关系', label: '当前关系', generationHint: '设定初始关系状态（陌生人/点头之交/朋友/暧昧/恋人）', generationType: 'single', aiGeneratable: true },
        { path: '社交.印象', label: '第一印象', generationHint: '描述角色对对方的第一印象', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '日程安排',
      icon: '📅',
      description: '日常行程与计划',
      variables: [
        { path: '日程.当前', label: '当前活动', generationHint: '描述角色当前正在做什么', generationType: 'single', aiGeneratable: true },
        { path: '日程.计划', label: '近期计划', generationHint: '生成2-3条近期计划/待办事项', generationType: 'list', aiGeneratable: true },
        { path: '日程.地点', label: '当前地点', generationHint: '设定角色当前所在地点', generationType: 'single', aiGeneratable: true },
      ],
    },
    {
      name: '生活指标',
      icon: '📈',
      description: '日常生活数值',
      variables: [
        { path: '指标.心情', label: '心情', generationHint: '设定初始心情值（0-100）', generationType: 'single', aiGeneratable: true },
        { path: '指标.精力', label: '精力', generationHint: '设定初始精力值（0-100）', generationType: 'single', aiGeneratable: true },
        { path: '指标.钱包', label: '余额', generationHint: '设定初始余额', generationType: 'single', aiGeneratable: true },
      ],
    },
  ],
  buildSections: () => [
    {
      name: '人物档案',
      variables: [
        { path: '档案.姓名', zodType: 'z.string()', description: '角色姓名', prefix: '_', initialValue: '' },
        { path: '档案.职业', zodType: 'z.string()', description: '职业', prefix: '_', initialValue: '' },
        { path: '档案.性格', zodType: 'z.string()', description: '性格特征', prefix: '_', initialValue: '' },
        { path: '档案.秘密', zodType: 'z.string()', description: '隐藏秘密', prefix: '$', initialValue: '' },
      ],
    },
    {
      name: '社交关系',
      variables: [
        { path: '社交.好感度', zodType: 'z.coerce.number()', description: '好感度', prefix: '', initialValue: 20, range: { min: 0, max: 100 } },
        { path: '社交.关系', zodType: 'z.enum(["陌生人","点头之交","朋友","暧昧","恋人"])', description: '关系状态', prefix: '', initialValue: '陌生人', enumValues: ['陌生人', '点头之交', '朋友', '暧昧', '恋人'] },
        { path: '社交.印象', zodType: 'z.string()', description: '第一印象', prefix: '_', initialValue: '' },
      ],
    },
    {
      name: '日程安排',
      variables: [
        { path: '日程.当前', zodType: 'z.string()', description: '当前活动', prefix: '', initialValue: '' },
        { path: '日程.计划', zodType: 'z.array(z.string())', description: '近期计划列表', prefix: '', initialValue: [] },
        { path: '日程.地点', zodType: 'z.string()', description: '当前地点', prefix: '', initialValue: '' },
      ],
    },
    {
      name: '生活指标',
      variables: [
        { path: '指标.心情', zodType: 'z.coerce.number()', description: '心情值', prefix: '', initialValue: 60, range: { min: 0, max: 100 } },
        { path: '指标.精力', zodType: 'z.coerce.number()', description: '精力值', prefix: '', initialValue: 80, range: { min: 0, max: 100 } },
        { path: '指标.钱包', zodType: 'z.coerce.number()', description: '余额', prefix: '', initialValue: 3000, range: { min: 0, max: 9999999 } },
      ],
    },
  ],
  buildRules: () => [
    { path: '社交.好感度', type: 'number', range: '0~100', check: ['关心、帮助、共同经历时增加', '忽视、冲突、失信时减少', '单次变化 ±(2~8)'] },
    { path: '社交.关系', check: ['好感度达到阈值时关系升级', '严重冲突可能导致关系降级'] },
    { path: '指标.心情', type: 'number', range: '0~100', check: ['愉快互动、达成目标时增加', '争吵、失望、压力时减少', '单次变化 ±(3~10)'] },
    { path: '指标.精力', type: 'number', range: '0~100', check: ['休息、睡眠时恢复', '工作、运动、熬夜时消耗', '单次变化 ±(5~20)'] },
    { path: '指标.钱包', type: 'number', range: '0~9999999', check: ['工作收入、兼职时增加', '购物、请客、缴费时减少'] },
    { path: '日程.当前', check: ['场景切换时更新为当前活动'] },
    { path: '日程.地点', check: ['角色移动时更新'] },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 模板注册表
// ════════════════════════════════════════════════════════════════════════════

export const BEGINNER_TEMPLATES: BeginnerTemplate[] = [
  WUXIA_TEMPLATE,
  XIANXIA_TEMPLATE,
  APOCALYPSE_TEMPLATE,
  MODERN_TEMPLATE,
];

export function getBeginnerTemplateById(id: string): BeginnerTemplate | undefined {
  return BEGINNER_TEMPLATES.find(t => t.id === id);
}

/**
 * 应用新手模板 → 生成完整 MvuConfig
 * 保留已有配置中的分阶段相关字段（statusBar 等），仅替换变量部分
 */
export function applyBeginnerTemplate(template: BeginnerTemplate, existing?: MvuConfig): MvuConfig {
  const base = existing ?? createEmptyMvuConfig();
  const sections = template.buildSections();
  const rules = template.buildRules();
  return {
    ...base,
    enabled: true,
    mode: 'beginner',
    beginnerTemplateId: template.id,
    schemaSections: sections,
    updateRules: rules,
    // 重新生成派生内容（由组件防抖触发，此处清空让组件重算）
    schemaTsContent: '',
    initvarYamlContent: '',
    updateRulesYamlContent: '',
    ejsPreprocessContent: '',
  };
}

/**
 * 获取模板的 AI 生成蓝图（用于 API 调用）
 * 返回所有支持 AI 生成的变量及其提示
 */
export function getTemplateBlueprint(template: BeginnerTemplate): TemplateSectionBlueprint[] {
  return template.sections;
}

/**
 * 构建 AI 生成提示词上下文
 * 将模板蓝图转化为结构化的 AI 指令
 */
export function buildTemplateAIBlueprint(template: BeginnerTemplate): string {
  const lines: string[] = [];
  lines.push(`模板：${template.name}（${template.description}）`);
  lines.push('');
  for (const section of template.sections) {
    lines.push(`## ${section.icon} ${section.name}`);
    lines.push(section.description);
    for (const v of section.variables) {
      if (v.aiGeneratable) {
        lines.push(`  - ${v.label}（${v.path}）[${v.generationType}]：${v.generationHint}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
