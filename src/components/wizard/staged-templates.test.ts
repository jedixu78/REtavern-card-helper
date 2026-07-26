/**
 * staged-templates 测试 — 聚焦 S3 新增的 DIY / AI 自选阶段轴合并逻辑。
 * （模板本体是静态数据；mergeStagedTemplate 的行为由向导流程间接覆盖）
 */
import { describe, it, expect } from 'vitest';
import { mergeDiyStagedAxis, type DiyStagedAxis } from './staged-templates';
import { createEmptyMvuConfig } from '../../constants/defaults';

const numberAxis: DiyStagedAxis = {
  axisPath: '堕落.阶段值',
  axisType: 'number',
  numericDirection: '>=',
  stages: [
    { name: '沉沦', condition: '>= 90' },
    { name: '动摇', condition: '>= 40' },
    { name: '纯洁', condition: '>= 0' },
  ],
};

const enumAxis: DiyStagedAxis = {
  axisPath: '关系.阶段',
  axisType: 'enum',
  numericDirection: '>=',
  stages: [
    { name: '陌生人', condition: "=== '陌生人'" },
    { name: '朋友', condition: "=== '朋友'" },
    { name: '恋人', condition: "=== '恋人'" },
  ],
};

describe('mergeDiyStagedAxis', () => {
  it('number 轴：变量带范围/分段，初始值取最不极端一端（>= 取最低阈值）', () => {
    const merged = mergeDiyStagedAxis(createEmptyMvuConfig(), numberAxis);
    const section = merged.schemaSections.find((s) => s.name === '堕落');
    expect(section).toBeDefined();
    const variable = section!.variables.find((v) => v.path === '堕落.阶段值');
    expect(variable).toMatchObject({
      zodType: 'z.coerce.number()',
      initialValue: 0,
      range: { min: 0, max: 90 },
    });
    expect(variable!.categories).toEqual([
      { range: '>= 90', label: '沉沦' },
      { range: '>= 40', label: '动摇' },
      { range: '>= 0', label: '纯洁' },
    ]);
    expect(merged.updateRules.some((r) => r.path === '堕落.阶段值')).toBe(true);
    expect(merged.enabled).toBe(true);
    expect(merged.beginnerTemplateId).toBe('diy');
  });

  it('number 轴 <= 方向：初始值取最高阈值', () => {
    const axis: DiyStagedAxis = {
      ...numberAxis,
      numericDirection: '<=',
      stages: [
        { name: '崩坏', condition: '<= -80' },
        { name: '压抑', condition: '<= -30' },
        { name: '平静', condition: '<= 0' },
      ],
    };
    const merged = mergeDiyStagedAxis(createEmptyMvuConfig(), axis);
    const variable = merged.schemaSections[0].variables[0];
    expect(variable.initialValue).toBe(0);
    expect(variable.range).toEqual({ min: -80, max: 0 });
  });

  it('enum 轴：z.enum + enumValues，初始值取第一个阶段', () => {
    const merged = mergeDiyStagedAxis(createEmptyMvuConfig(), enumAxis);
    const variable = merged.schemaSections.find((s) => s.name === '关系')!.variables[0];
    expect(variable.zodType).toBe('z.enum(["陌生人", "朋友", "恋人"])');
    expect(variable.enumValues).toEqual(['陌生人', '朋友', '恋人']);
    expect(variable.initialValue).toBe('陌生人');
  });

  it('不覆盖已有变量与规则（合并语义对齐 mergeStagedTemplate）', () => {
    const base = createEmptyMvuConfig();
    base.schemaSections = [{
      name: '关系',
      variables: [{ path: '关系.好感度', zodType: 'z.coerce.number()', description: '已有变量', prefix: '', initialValue: 5 }],
    }];
    base.updateRules = [{ path: '关系.好感度', type: 'number' }];
    const merged = mergeDiyStagedAxis(base, enumAxis);
    const section = merged.schemaSections.find((s) => s.name === '关系')!;
    expect(section.variables.map((v) => v.path)).toEqual(['关系.好感度', '关系.阶段']);
    expect(merged.updateRules.map((r) => r.path)).toEqual(['关系.好感度', '关系.阶段']);
  });

  it('派生产物（schema.ts / initvar.yaml / 更新规则.yaml）同步重生成', () => {
    const merged = mergeDiyStagedAxis(createEmptyMvuConfig(), numberAxis);
    expect(merged.schemaTsContent).toContain('堕落');
    expect(merged.initvarYamlContent).toContain('阶段值');
    // 更新规则 YAML 按分区嵌套输出（堕落: → 阶段值:），不是点分路径
    expect(merged.updateRulesYamlContent).toContain('堕落:');
    expect(merged.updateRulesYamlContent).toContain('阶段值:');
  });
});
