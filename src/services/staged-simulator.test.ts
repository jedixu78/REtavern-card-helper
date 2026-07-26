import { describe, it, expect } from 'vitest';
import { simulateStageDispatch, evaluateStageCondition, deriveNumericAxisRange } from './staged-simulator';
import type { StageDefinition } from './staged-lorebook-builder';

const enumStages: StageDefinition[] = [
  { name: '陌生' },
  { name: '朋友' },
  { name: '恋人' },
];

/** 好感度型：条件按 >= 从高到低排列（与 sortStagesByDirection 的产物一致） */
const numStages: StageDefinition[] = [
  { name: '热恋', condition: '>= 80' },
  { name: '暧昧', condition: '>= 50' },
  { name: '普通', condition: '>= 0' },
];

describe('evaluateStageCondition', () => {
  it('枚举相等/不等', () => {
    expect(evaluateStageCondition('朋友', "=== '朋友'")).toBe(true);
    expect(evaluateStageCondition('陌生', "=== '朋友'")).toBe(false);
    expect(evaluateStageCondition('陌生', "!== '朋友'")).toBe(true);
  });

  it('还原 EJS 转义后的字面量（撇号/反斜杠/换行）', () => {
    expect(evaluateStageCondition("It's", "=== 'It\\'s'")).toBe(true);
    expect(evaluateStageCondition('a\\b', "=== 'a\\\\b'")).toBe(true);
    expect(evaluateStageCondition('a\nb', "=== 'a\\nb'")).toBe(true);
  });

  it('数值比较四则方向', () => {
    expect(evaluateStageCondition(80, '>= 80')).toBe(true);
    expect(evaluateStageCondition(79, '>= 80')).toBe(false);
    expect(evaluateStageCondition(-80, '<= -80')).toBe(true);
    expect(evaluateStageCondition(-79, '<= -80')).toBe(false);
    expect(evaluateStageCondition(5, '> 5')).toBe(false);
    expect(evaluateStageCondition(6, '> 5')).toBe(true);
  });

  it('字符串数字可参与数值比较（MVU 变量常以字符串存）', () => {
    expect(evaluateStageCondition('85', '>= 80')).toBe(true);
  });

  it('非数值轴值参与数值比较时判定不通过，而不是 NaN 静默为假', () => {
    expect(evaluateStageCondition('朋友', '>= 80')).toBe(false);
  });

  it('无法解析的条件返回 null', () => {
    expect(evaluateStageCondition(1, 'includes("x")')).toBeNull();
    expect(evaluateStageCondition(1, '')).toBeNull();
  });

  it('不执行任意代码：函数调用形式的条件只会解析失败，不会求值', () => {
    // 若用 eval/new Function 实现，下面这条会抛错或产生副作用
    expect(evaluateStageCondition(1, '=== (()=>{throw new Error("boom")})()')).toBeNull();
  });
});

describe('simulateStageDispatch — 枚举轴', () => {
  it('命中对应阶段', () => {
    const r = simulateStageDispatch({ stages: enumStages, axisType: 'enum', axisValue: '朋友' });
    expect(r.outcome).toBe('matched');
    expect(r.matchedStage?.name).toBe('朋友');
    expect(r.matchedIndex).toBe(1);
    expect(r.evaluations.filter((e) => e.winner)).toHaveLength(1);
  });

  it('值不在任何阶段中 → no-match（对应 ST 的兜底警告分支）', () => {
    const r = simulateStageDispatch({ stages: enumStages, axisType: 'enum', axisValue: '仇敌' });
    expect(r.outcome).toBe('no-match');
    expect(r.matchedStage).toBeNull();
    expect(r.evaluations.every((e) => !e.passed)).toBe(true);
  });

  it('轴变量未定义 → undefined-axis，且不对任何阶段求值', () => {
    const r = simulateStageDispatch({ stages: enumStages, axisType: 'enum', axisValue: undefined });
    expect(r.outcome).toBe('undefined-axis');
    expect(r.evaluations.every((e) => !e.passed && !e.winner)).toBe(true);
    // 条件仍然回填，便于 UI 展示
    expect(r.evaluations[0].condition).toBe("=== '陌生'");
  });

  it('未写 condition 时按阶段名自动生成条件', () => {
    const r = simulateStageDispatch({ stages: enumStages, axisType: 'enum', axisValue: '恋人' });
    expect(r.evaluations[2].condition).toBe("=== '恋人'");
    expect(r.matchedStage?.name).toBe('恋人');
  });
});

describe('simulateStageDispatch — 数值轴', () => {
  it('首个为真者胜出（else-if 链语义）', () => {
    const r = simulateStageDispatch({ stages: numStages, axisType: 'number', numericDirection: '>=', axisValue: 90 });
    expect(r.matchedStage?.name).toBe('热恋');
    // 90 同时满足 >=50 与 >=0，但它们不是 winner
    expect(r.evaluations.filter((e) => e.passed).map((e) => e.stage.name)).toEqual(['热恋', '暧昧', '普通']);
    expect(r.evaluations.filter((e) => e.winner).map((e) => e.stage.name)).toEqual(['热恋']);
  });

  it('边界值取等号', () => {
    expect(simulateStageDispatch({ stages: numStages, axisType: 'number', axisValue: 80 }).matchedStage?.name).toBe('热恋');
    expect(simulateStageDispatch({ stages: numStages, axisType: 'number', axisValue: 79 }).matchedStage?.name).toBe('暧昧');
  });

  it('低于全部阈值 → no-match', () => {
    const r = simulateStageDispatch({ stages: numStages, axisType: 'number', axisValue: -5 });
    expect(r.outcome).toBe('no-match');
  });

  it('轴值为 0 不被当成「未定义」', () => {
    const r = simulateStageDispatch({ stages: numStages, axisType: 'number', axisValue: 0 });
    expect(r.outcome).toBe('matched');
    expect(r.matchedStage?.name).toBe('普通');
  });

  it('乱序阶段按导出前的排序求值，与实际卡片一致', () => {
    // 用户在 UI 里手动调乱了顺序；handleApply 导出前会 sortStagesByDirection 重排成
    // 80 → 50 → 0。若模拟器按原始数组顺序（0 在最前）求值，轴值 90 会命中「普通」，
    // 与实际卡片的「热恋」相反。
    const shuffled: StageDefinition[] = [
      { name: '普通', condition: '>= 0' },
      { name: '热恋', condition: '>= 80' },
      { name: '暧昧', condition: '>= 50' },
    ];
    const r = simulateStageDispatch({ stages: shuffled, axisType: 'number', numericDirection: '>=', axisValue: 90 });
    expect(r.matchedStage?.name).toBe('热恋');
    expect(r.evaluations.map((e) => e.stage.name)).toEqual(['热恋', '暧昧', '普通']);
  });

  it('<= 方向的乱序阶段同样按导出顺序求值', () => {
    const shuffled: StageDefinition[] = [
      { name: '轻度', condition: '<= -20' },
      { name: '重度', condition: '<= -80' },
    ];
    const r = simulateStageDispatch({ stages: shuffled, axisType: 'number', numericDirection: '<=', axisValue: -90 });
    // 排序后 -80 在前，-90 命中「重度」
    expect(r.matchedStage?.name).toBe('重度');
  });

  it('无法解析的条件标记 parseError 且不通过', () => {
    const bad: StageDefinition[] = [{ name: '坏', condition: 'somethingWeird()' }];
    const r = simulateStageDispatch({ stages: bad, axisType: 'number', axisValue: 10 });
    expect(r.outcome).toBe('no-match');
    expect(r.evaluations[0].parseError).toBeTruthy();
  });
});

describe('deriveNumericAxisRange', () => {
  it('覆盖全部阈值并留余量', () => {
    const { min, max, step } = deriveNumericAxisRange(numStages, '>=');
    expect(min).toBeLessThanOrEqual(0);
    expect(max).toBeGreaterThanOrEqual(80);
    expect(step).toBe(1);
  });

  it('负向阈值（倒计时/黑化型）同样覆盖', () => {
    const stages: StageDefinition[] = [
      { name: 'A', condition: '<= -80' },
      { name: 'B', condition: '<= -20' },
    ];
    const { min, max } = deriveNumericAxisRange(stages, '<=');
    expect(min).toBeLessThanOrEqual(-80);
    expect(max).toBeGreaterThanOrEqual(-20);
  });

  it('无数值阈值时回退 0-100（枚举阶段不合成假的 0 阈值）', () => {
    expect(deriveNumericAxisRange(enumStages)).toEqual({ min: 0, max: 100, step: 1 });
  });

  it('单个阈值时给出可用行程，而不是退化成 ±1', () => {
    const { min, max } = deriveNumericAxisRange([{ name: 'A', condition: '>= 60' }], '>=');
    expect(min).toBeLessThan(50);
    expect(max).toBeGreaterThan(70);
  });

  it('含小数阈值时用更细步长', () => {
    const stages: StageDefinition[] = [{ name: 'A', condition: '>= 0.5' }];
    expect(deriveNumericAxisRange(stages).step).toBe(0.1);
  });
});
