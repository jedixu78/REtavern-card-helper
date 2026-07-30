import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  classifyTokenBudget,
  analyzeLorebookTokens,
  analyzeCardTokenBudget,
  describeTokenBudgetAdvice,
  TOKEN_BUDGET_HEALTHY_MAX,
  TOKEN_BUDGET_HIGH_MAX,
} from './token-budget';
import { estimateTokenCount } from '../components/novel-workshop/utils';
import { createEmptyDraft, createEmptyLorebookEntry } from '../constants/defaults';
import type { LorebookEntry, MvuConfig, WizardDraft } from '../constants/defaults';

function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return { ...createEmptyDraft(), ...overrides };
}

function makeEntry(overrides: Partial<LorebookEntry> = {}): LorebookEntry {
  return { ...createEmptyLorebookEntry(), ...overrides };
}

function makeMvu(overrides: Partial<MvuConfig> = {}): MvuConfig {
  return {
    enabled: true,
    mode: 'expert',
    schemaSections: [
      {
        name: '角色',
        variables: [
          { path: '角色.好感度', zodType: 'z.coerce.number()', description: '对主角的好感', prefix: '', initialValue: 0 },
        ],
      },
    ],
    updateRules: [],
    ejsConfigs: [],
    ejsPreprocessContent: '',
    schemaTsContent: '',
    initvarYamlContent: '',
    updateRulesYamlContent: '',
    statusBarHtml: '',
    statusBarStyle: 'compact-panel',
    ...overrides,
  };
}

describe('estimateTokens', () => {
  it('空值一律返回 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('中文按 1 字 ≈ 1.35 token 向上取整', () => {
    // 4 个 CJK 字符 → ceil(4 * 1.35) = 6
    expect(estimateTokens('中文测试')).toBe(6);
  });

  it('英文按 4 字符 ≈ 1 token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('与既有 estimateTokenCount（estimatePromptTokens 的口径）完全一致', () => {
    const samples = ['', '纯中文内容测试', 'pure english content', '混排 mixed 内容 123', '标点，。！?!'];
    for (const s of samples) {
      expect(estimateTokens(s)).toBe(estimateTokenCount(s));
    }
  });
});

describe('classifyTokenBudget', () => {
  it('阈值边界：≤40000 健康，40000~80000 偏高，>80000 危险', () => {
    expect(classifyTokenBudget(0)).toBe('healthy');
    expect(classifyTokenBudget(TOKEN_BUDGET_HEALTHY_MAX)).toBe('healthy');
    expect(classifyTokenBudget(TOKEN_BUDGET_HEALTHY_MAX + 1)).toBe('high');
    expect(classifyTokenBudget(TOKEN_BUDGET_HIGH_MAX)).toBe('high');
    expect(classifyTokenBudget(TOKEN_BUDGET_HIGH_MAX + 1)).toBe('danger');
  });

  it('非有限数按 0 处理', () => {
    expect(classifyTokenBudget(Number.NaN)).toBe('healthy');
  });
});

describe('analyzeLorebookTokens', () => {
  it('空数组返回全 0', () => {
    const r = analyzeLorebookTokens([]);
    expect(r.entries).toEqual([]);
    expect(r.constantTotal).toBe(0);
    expect(r.selectiveTotal).toBe(0);
    expect(r.constantLevel).toBe('healthy');
  });

  it('逐条明细带 index / token 数 / 是否常驻', () => {
    const entries = [
      makeEntry({ name: '蓝灯', content: '常驻内容', constant: true }),
      makeEntry({ name: '绿灯', content: '触发内容', constant: false, keys: ['触发'] }),
    ];
    const r = analyzeLorebookTokens(entries);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toMatchObject({ index: 0, label: '蓝灯', constant: true, alwaysOn: true, system: false });
    expect(r.entries[0].tokens).toBe(estimateTokens('常驻内容'));
    expect(r.entries[1]).toMatchObject({ index: 1, label: '绿灯', constant: false, alwaysOn: false });
    expect(r.constantTotal).toBe(estimateTokens('常驻内容'));
    expect(r.selectiveTotal).toBe(estimateTokens('触发内容'));
    expect(r.constantCount).toBe(1);
    expect(r.selectiveCount).toBe(1);
  });

  it('label 回退顺序：name → comment → 条目 N', () => {
    const r = analyzeLorebookTokens([
      makeEntry({ name: '有名字', comment: '备注' }),
      makeEntry({ name: '', comment: '只有备注' }),
      makeEntry({ name: '', comment: '' }),
    ]);
    expect(r.entries.map((e) => e.label)).toEqual(['有名字', '只有备注', '条目 3']);
  });

  it('禁用条目不进常驻/按需总量，只进 disabledTotal', () => {
    const r = analyzeLorebookTokens([
      makeEntry({ content: '被禁用的常驻内容', constant: true, enabled: false }),
    ]);
    expect(r.constantTotal).toBe(0);
    expect(r.disabledTotal).toBe(estimateTokens('被禁用的常驻内容'));
    expect(r.entries[0].alwaysOn).toBe(false);
  });

  it('topConstantEntries 按 token 降序，且排除禁用与系统条目', () => {
    const r = analyzeLorebookTokens([
      makeEntry({ name: '小', content: '短', constant: true }),
      makeEntry({ name: '大', content: '很长很长很长很长很长的常驻设定内容'.repeat(3), constant: true }),
      makeEntry({ name: '禁用', content: '不算数的内容', constant: true, enabled: false }),
      makeEntry({ name: '[InitVar]请勿打开', content: '系统条目内容', constant: true }),
    ]);
    expect(r.topConstantEntries.map((e) => e.label)).toEqual(['大', '小']);
    expect(r.entries[3].system).toBe(true);
  });

  it('MVU 系统条目按 system 标记，但仍计入 constantTotal（它确实每轮进上下文）', () => {
    const r = analyzeLorebookTokens([
      makeEntry({ name: 'MVU 变量列表', content: '变量清单内容', constant: true }),
    ]);
    expect(r.entries[0].system).toBe(true);
    expect(r.constantTotal).toBe(estimateTokens('变量清单内容'));
  });

  it('可以显式传入 stagedIndices 覆盖自动探测', () => {
    const r = analyzeLorebookTokens([makeEntry({ name: '普通', content: '内容' })], {
      stagedIndices: new Set([0]),
    });
    expect(r.entries[0].system).toBe(true);
  });
});

describe('analyzeCardTokenBudget', () => {
  it('空 draft：全部为 0 且分级健康', () => {
    const b = analyzeCardTokenBudget(makeDraft());
    expect(b.perTurnFixed).toBe(0);
    expect(b.onDemand).toBe(0);
    expect(b.oneTime).toBe(0);
    expect(b.total).toBe(0);
    expect(b.level).toBe('healthy');
  });

  it('各段互不重叠：total === 所有段之和', () => {
    const draft = makeDraft({
      firstMessage: '开场白内容'.repeat(20),
      scenario: '故事场景',
      system_prompt: '系统提示词',
      characters: [{ id: 'c1', name: '角色', description: '角色描述内容', entryIds: ['role-1'] }],
      lorebookEntries: [
        makeEntry({ id: 'role-1', name: '角色设定', content: '角色描述内容', constant: true }),
        makeEntry({ name: '蓝灯设定', content: '世界常驻内容', constant: true }),
        makeEntry({ name: '绿灯设定', content: '触发内容', constant: false, keys: ['关键词'] }),
      ],
    });
    const b = analyzeCardTokenBudget(draft);
    const sum = b.segments.reduce((s, seg) => s + seg.tokens, 0);
    expect(sum).toBe(b.total);
    expect(b.total).toBe(b.perTurnFixed + b.onDemand + b.oneTime);
  });

  it('通过 entryIds 关联的角色设定条目只算进「角色描述」，不重复计入常驻世界书', () => {
    const draft = makeDraft({
      characters: [{ id: 'c1', name: '角色', description: '角色描述内容', entryIds: ['role-1'] }],
      lorebookEntries: [
        makeEntry({ id: 'role-1', name: '角色设定', content: '角色描述内容', constant: true }),
        makeEntry({ name: '蓝灯设定', content: '世界常驻内容', constant: true }),
      ],
    });
    const b = analyzeCardTokenBudget(draft);
    const character = b.segments.find((s) => s.id === 'characterDefinition');
    const constant = b.segments.find((s) => s.id === 'constantEntries');
    expect(character?.tokens).toBe(estimateTokens('角色描述内容'));
    expect(constant?.tokens).toBe(estimateTokens('世界常驻内容'));
    expect(b.perTurnFixed).toBe(estimateTokens('角色描述内容') + estimateTokens('世界常驻内容'));
  });

  it('尚未同步进世界书的角色描述仍按常驻计入', () => {
    const draft = makeDraft({
      characters: [{ id: 'c1', name: '角色', description: '还没同步的角色描述' }],
      lorebookEntries: [],
    });
    const b = analyzeCardTokenBudget(draft);
    const character = b.segments.find((s) => s.id === 'characterDefinition');
    expect(character?.tokens).toBe(estimateTokens('还没同步的角色描述'));
    expect(b.perTurnFixed).toBe(character?.tokens);
  });

  it('绿灯条目算按需，不进每轮固定开销', () => {
    const draft = makeDraft({
      lorebookEntries: [makeEntry({ name: '绿灯', content: '触发内容'.repeat(50), constant: false, keys: ['k'] })],
    });
    const b = analyzeCardTokenBudget(draft);
    expect(b.perTurnFixed).toBe(0);
    expect(b.onDemand).toBeGreaterThan(0);
    expect(b.segments.find((s) => s.id === 'selectiveEntries')?.kind).toBe('onDemand');
  });

  it('开场白算 oneTime，不进每轮固定开销', () => {
    const draft = makeDraft({ firstMessage: '开场白正文'.repeat(100) });
    const b = analyzeCardTokenBudget(draft);
    expect(b.perTurnFixed).toBe(0);
    expect(b.oneTime).toBe(estimateTokens('开场白正文'.repeat(100)));
  });

  it('常驻字段包含 scenario / system_prompt / 历史后指令', () => {
    const draft = makeDraft({
      scenario: '场景',
      system_prompt: '系统',
      post_history_instructions: '后置',
    });
    const b = analyzeCardTokenBudget(draft);
    const staticSeg = b.segments.find((s) => s.id === 'staticFields');
    // 重构后「锚定世界观」总纲条目已并入常驻世界书段，staticFields 仅含 scenario/system_prompt/post_history_instructions
    expect(staticSeg?.tokens).toBe(
      estimateTokens('场景') + estimateTokens('系统') + estimateTokens('后置'),
    );
    expect(staticSeg?.kind).toBe('fixed');
  });

  it('MVU 启用时 MVU 段大于 0（草稿里没有 MVU 条目也能估出来）', () => {
    const draft = makeDraft({ mvu: makeMvu() });
    const b = analyzeCardTokenBudget(draft);
    expect(b.segments.find((s) => s.id === 'mvuSystem')?.tokens).toBeGreaterThan(0);
    // MVU 未启用时应为 0
    expect(analyzeCardTokenBudget(makeDraft()).segments.find((s) => s.id === 'mvuSystem')?.tokens).toBe(0);
  });

  it('MVU 系统条目已存在于草稿时计入 MVU 段而非常驻世界书段', () => {
    const draft = makeDraft({
      lorebookEntries: [makeEntry({ name: 'MVU 变量列表', content: '变量清单内容', constant: true })],
    });
    const b = analyzeCardTokenBudget(draft);
    expect(b.segments.find((s) => s.id === 'mvuSystem')?.tokens).toBe(estimateTokens('变量清单内容'));
    expect(b.segments.find((s) => s.id === 'constantEntries')?.tokens).toBe(0);
  });

  it('禁用的蓝灯条目不计入每轮固定开销', () => {
    const draft = makeDraft({
      lorebookEntries: [makeEntry({ name: '关掉的', content: '很多内容'.repeat(200), constant: true, enabled: false })],
    });
    expect(analyzeCardTokenBudget(draft).perTurnFixed).toBe(0);
  });

  it('常驻量超过危险阈值时分级为 danger', () => {
    const draft = makeDraft({
      lorebookEntries: [makeEntry({ name: '巨型常驻', content: '设'.repeat(60000), constant: true })],
    });
    const b = analyzeCardTokenBudget(draft);
    expect(b.perTurnFixed).toBeGreaterThan(TOKEN_BUDGET_HIGH_MAX);
    expect(b.level).toBe('danger');
  });

  it('常驻量落在 40000~80000 之间时分级为 high', () => {
    const draft = makeDraft({
      lorebookEntries: [makeEntry({ name: '偏大常驻', content: '设'.repeat(32000), constant: true })],
    });
    const b = analyzeCardTokenBudget(draft);
    expect(b.perTurnFixed).toBeGreaterThan(TOKEN_BUDGET_HEALTHY_MAX);
    expect(b.perTurnFixed).toBeLessThanOrEqual(TOKEN_BUDGET_HIGH_MAX);
    expect(b.level).toBe('high');
  });

  it('lorebook 明细与 draft.lorebookEntries 下标对齐', () => {
    const draft = makeDraft({
      lorebookEntries: [makeEntry({ name: 'A' }), makeEntry({ name: 'B' }), makeEntry({ name: 'C' })],
    });
    const b = analyzeCardTokenBudget(draft);
    expect(b.lorebook.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(b.lorebook.entries.map((e) => e.label)).toEqual(['A', 'B', 'C']);
  });
});

describe('describeTokenBudgetAdvice', () => {
  it('健康时不产出建议', () => {
    expect(describeTokenBudgetAdvice(analyzeCardTokenBudget(makeDraft()))).toBe('');
  });

  it('超阈值时点名最占空间的常驻条目并给出改法', () => {
    const draft = makeDraft({
      lorebookEntries: [
        makeEntry({ name: '超大设定', content: '设'.repeat(32000), constant: true }),
        makeEntry({ name: '小设定', content: '设'.repeat(10), constant: true }),
      ],
    });
    const advice = describeTokenBudgetAdvice(analyzeCardTokenBudget(draft));
    expect(advice).toContain('超大设定');
    expect(advice).toContain('关键词触发');
    // 最占空间的排在前面
    expect(advice.indexOf('超大设定')).toBeLessThan(advice.indexOf('小设定'));
  });
});
