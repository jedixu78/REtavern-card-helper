import { describe, it, expect } from 'vitest';
import { runQualityCheck, scoreColor, buildQualityGuidance, groupByCategory } from './quality-checker';
import { createEmptyDraft, createEmptyLorebookEntry } from '../constants/defaults';
import type { WizardDraft } from '../constants/defaults';

function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return { ...createEmptyDraft(), ...overrides };
}

describe('runQualityCheck', () => {
  it('空 draft 评分应为低分（多个 critical 失败）', () => {
    const report = runQualityCheck(makeDraft());
    expect(report.score).toBeLessThan(50);
    expect(report.failedCount).toBeGreaterThan(0);
  });

  it('卡片名称太短时 cardName 检查失败', () => {
    const draft = makeDraft({ cardName: 'A' });
    const report = runQualityCheck(draft);
    const cardNameCheck = report.results.find((r) => r.id === 'cardName');
    expect(cardNameCheck?.passed).toBe(false);
  });

  it('卡片名称为默认名时 cardName 检查失败', () => {
    const draft = makeDraft({ cardName: '新卡片' });
    const report = runQualityCheck(draft);
    const cardNameCheck = report.results.find((r) => r.id === 'cardName');
    expect(cardNameCheck?.passed).toBe(false);
  });

  it('卡片名称足够长时 cardName 检查通过', () => {
    const draft = makeDraft({ cardName: '银帷骑士团' });
    const report = runQualityCheck(draft);
    const cardNameCheck = report.results.find((r) => r.id === 'cardName');
    expect(cardNameCheck?.passed).toBe(true);
  });

  it('标签不足 3 个时 tags 检查失败', () => {
    const draft = makeDraft({ tags: ['标签1'] });
    const report = runQualityCheck(draft);
    const tagsCheck = report.results.find((r) => r.id === 'tags');
    expect(tagsCheck?.passed).toBe(false);
  });

  it('开场白字数在 200~3000 范围内通过', () => {
    const msg = '这是一段'.repeat(60); // 240 chars
    const draft = makeDraft({ firstMessage: msg });
    const report = runQualityCheck(draft);
    const check = report.results.find((r) => r.id === 'firstMessage');
    expect(check?.passed).toBe(true);
  });

  it('开场白太短时失败', () => {
    const draft = makeDraft({ firstMessage: '短' });
    const report = runQualityCheck(draft);
    const check = report.results.find((r) => r.id === 'firstMessage');
    expect(check?.passed).toBe(false);
  });

  it('空内容条目导致 lorebookEmpty 检查失败', () => {
    const entry = { ...createEmptyLorebookEntry(), content: '', enabled: true, name: '测试', comment: '测试' };
    const draft = makeDraft({ lorebookEntries: [entry] });
    const report = runQualityCheck(draft);
    const check = report.results.find((r) => r.id === 'lorebookEmpty');
    expect(check?.passed).toBe(false);
  });

  it('非蓝灯条目无触发词时 lorebookKeys 检查失败', () => {
    const entry = {
      ...createEmptyLorebookEntry(),
      content: '内容',
      enabled: true,
      constant: false,
      keys: [],
      name: '测试',
      comment: '测试',
    };
    const draft = makeDraft({ lorebookEntries: [entry] });
    const report = runQualityCheck(draft);
    const check = report.results.find((r) => r.id === 'lorebookKeys');
    expect(check?.passed).toBe(false);
  });

  it('MVU 未启用时 MVU 相关检查不适用', () => {
    const draft = makeDraft();
    const report = runQualityCheck(draft);
    const mvuChecks = report.results.filter((r) => r.category === 'mvu');
    for (const c of mvuChecks) {
      expect(c.applicable).toBe(false);
    }
  });

  it('MVU 启用但无变量时 mvuVars 检查失败', () => {
    const draft = makeDraft({
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: '',
      },
    });
    const report = runQualityCheck(draft);
    const check = report.results.find((r) => r.id === 'mvuVars');
    expect(check?.applicable).toBe(true);
    expect(check?.passed).toBe(false);
  });

  it('applicableCount 应排除不适用的检查', () => {
    const draft = makeDraft();
    const report = runQualityCheck(draft);
    const totalItems = report.results.length;
    expect(report.applicableCount).toBeLessThanOrEqual(totalItems);
    expect(report.applicableCount).toBeGreaterThan(0);
  });

  it('passedCount + failedCount === applicableCount', () => {
    const draft = makeDraft({ cardName: '测试卡片', tags: ['a', 'b', 'c'] });
    const report = runQualityCheck(draft);
    expect(report.passedCount + report.failedCount).toBe(report.applicableCount);
  });

  it('满分卡片应接近 100 分', () => {
    const entry = {
      ...createEmptyLorebookEntry(),
      content: '详细内容',
      enabled: true,
      constant: false,
      keys: ['关键词'],
      name: '条目',
      comment: '条目',
    };
    const draft = makeDraft({
      cardName: '完美卡片',
      tags: ['标签1', '标签2', '标签3'],
      firstMessage: '这是一段足够长的开场白，用于通过质量检查。'.repeat(10),
      characters: [{ id: '1', name: '角色', description: '描述' }],
      lorebookEntries: Array.from({ length: 6 }, (_, i) => ({
        ...entry,
        name: `条目${i}`,
        comment: `条目${i}`,
      })),
    });
    const report = runQualityCheck(draft);
    expect(report.score).toBeGreaterThan(70);
  });
});

describe('runQualityCheck — token 预算维度', () => {
  it('常驻开销在健康线内时 tokenBudget 检查通过', () => {
    const draft = makeDraft({
      lorebookEntries: [
        { ...createEmptyLorebookEntry(), name: '常驻设定', comment: '常驻设定', content: '简短的常驻设定', constant: true },
      ],
    });
    const check = runQualityCheck(draft).results.find((r) => r.id === 'tokenBudget');
    expect(check?.applicable).toBe(true);
    expect(check?.passed).toBe(true);
    expect(check?.fixHint).toBe('');
  });

  it('常驻（蓝灯）条目总量超阈值时 tokenBudget 检查失败，并点名最占空间的条目', () => {
    const draft = makeDraft({
      lorebookEntries: [
        { ...createEmptyLorebookEntry(), name: '巨型常驻设定', comment: '巨型常驻设定', content: '设'.repeat(32000), constant: true },
        { ...createEmptyLorebookEntry(), name: '小常驻设定', comment: '小常驻设定', content: '设'.repeat(20), constant: true },
      ],
    });
    const check = runQualityCheck(draft).results.find((r) => r.id === 'tokenBudget');
    expect(check?.passed).toBe(false);
    expect(check?.actual).toContain('token/轮');
    expect(check?.fixHint).toContain('巨型常驻设定');
    expect(check?.fixHint).toContain('关键词触发');
  });

  it('同样体量的内容放在绿灯条目上不会触发 tokenBudget 失败', () => {
    const draft = makeDraft({
      lorebookEntries: [
        {
          ...createEmptyLorebookEntry(),
          name: '巨型触发设定',
          comment: '巨型触发设定',
          content: '设'.repeat(32000),
          constant: false,
          keys: ['关键词'],
        },
      ],
    });
    const check = runQualityCheck(draft).results.find((r) => r.id === 'tokenBudget');
    expect(check?.passed).toBe(true);
  });

  it('tokenBudget 归入 lorebook 类别，不新增质量检查类别', () => {
    const report = runQualityCheck(makeDraft());
    const check = report.results.find((r) => r.id === 'tokenBudget');
    expect(check?.category).toBe('lorebook');
    const categories = new Set(report.results.map((r) => r.category));
    expect(categories.has('lorebook')).toBe(true);
    expect(categories.size).toBeLessThanOrEqual(7);
  });

  it('token 预算超标只算 suggestion，不会把导出状态卡成 blocked', () => {
    const draft = makeDraft({
      cardName: '完整卡片',
      tags: ['a', 'b', 'c'],
      firstMessage: '这是一段足够长的开场白，用于通过质量检查。'.repeat(10),
      characters: [{ id: '1', name: '角色', description: '描述' }],
      lorebookEntries: [
        { ...createEmptyLorebookEntry(), name: '巨型常驻', comment: '巨型常驻', content: '设'.repeat(32000), constant: true },
      ],
    });
    const check = runQualityCheck(draft).results.find((r) => r.id === 'tokenBudget');
    expect(check?.severity).toBe('suggestion');
    expect(check?.passed).toBe(false);
  });
});

describe('scoreColor', () => {
  it('80+ 返回 success', () => {
    expect(scoreColor(80)).toBe('success');
    expect(scoreColor(100)).toBe('success');
  });

  it('50~79 返回 warning', () => {
    expect(scoreColor(50)).toBe('warning');
    expect(scoreColor(79)).toBe('warning');
  });

  it('<50 返回 danger', () => {
    expect(scoreColor(49)).toBe('danger');
    expect(scoreColor(0)).toBe('danger');
  });
});

describe('buildQualityGuidance', () => {
  it('有 critical 失败时状态为 blocked', () => {
    const report = runQualityCheck(makeDraft()); // 空 draft 有 critical 失败
    const guidance = buildQualityGuidance(report);
    expect(guidance.status).toBe('blocked');
    expect(guidance.criticalCount).toBeGreaterThan(0);
  });

  it('无失败时状态为 ready', () => {
    const report = { results: [], score: 100, passedCount: 0, failedCount: 0, applicableCount: 0 };
    const guidance = buildQualityGuidance(report);
    expect(guidance.status).toBe('ready');
  });

  it('nextActions 最多 3 条', () => {
    const report = runQualityCheck(makeDraft());
    const guidance = buildQualityGuidance(report);
    expect(guidance.nextActions.length).toBeLessThanOrEqual(3);
  });
});

describe('groupByCategory', () => {
  it('按类别分组并过滤空组', () => {
    const report = runQualityCheck(makeDraft());
    const groups = groupByCategory(report.results);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.items.length).toBeGreaterThan(0);
    }
  });

  it('保持类别顺序', () => {
    const report = runQualityCheck(makeDraft());
    const groups = groupByCategory(report.results);
    const order = ['basic', 'character', 'firstMessage', 'lorebook', 'mvu', 'stagedMode', 'spec'];
    let lastIdx = -1;
    for (const g of groups) {
      const idx = order.indexOf(g.category);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});
