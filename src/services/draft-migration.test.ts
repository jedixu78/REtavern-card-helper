import { describe, it, expect } from 'vitest';
import { migrateDraftRecord } from './draft-migration';
import { WIZARD_DRAFT_VERSION } from '../constants/defaults';

describe('migrateDraftRecord', () => {
  it('当前版本原样透传，不标记迁移', () => {
    const result = migrateDraftRecord({
      version: WIZARD_DRAFT_VERSION,
      data: { cardName: 'A' },
      currentStep: 5,
    });
    expect(result).toEqual({ data: { cardName: 'A' }, currentStep: 5 });
  });

  it('V4 步号链式迁移 V4→V5→V6：导出步 7 必须落到 V6 的导出步 9（而非直播包装 8）', () => {
    const result = migrateDraftRecord({ version: 4, data: {}, currentStep: 7 });
    expect(result?.currentStep).toBe(9);
    expect(result?.migratedFrom).toBe('V4');
  });

  it('V4 各步号映射到 V6', () => {
    // V4: 卡名1 角色2 世界书3 MVU4 分阶段5 开场白6 导出7
    // V6: 卡名1 骨架2 角色3 细节4 MVU5 分阶段6 开场白7 直播8 导出9
    const cases: Array<[number, number]> = [
      [1, 1], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 9],
    ];
    for (const [oldStep, expected] of cases) {
      expect(migrateDraftRecord({ version: 4, data: {}, currentStep: oldStep })?.currentStep).toBe(expected);
    }
  });

  it('V4 迁移补默认 worldRules', () => {
    const result = migrateDraftRecord({ version: 4, data: {}, currentStep: 1 });
    expect(result?.data.worldRules).toBe('');
    // 已有值不被覆盖
    const kept = migrateDraftRecord({ version: 4, data: { worldRules: 'x' }, currentStep: 1 });
    expect(kept?.data.worldRules).toBe('x');
  });

  it('V5 步号迁移：导出步 8 → 9，其余不变', () => {
    expect(migrateDraftRecord({ version: 5, data: {}, currentStep: 8 })?.currentStep).toBe(9);
    expect(migrateDraftRecord({ version: 5, data: {}, currentStep: 3 })?.currentStep).toBe(3);
    expect(migrateDraftRecord({ version: 5, data: {}, currentStep: 8 })?.migratedFrom).toBe('V5');
  });

  it('无迁移路径的旧版本返回 null', () => {
    expect(migrateDraftRecord({ version: 3, data: {}, currentStep: 2 })).toBeNull();
    expect(migrateDraftRecord({ version: 0, data: {}, currentStep: 1 })).toBeNull();
  });

  it('currentStep 缺失时回退到 1', () => {
    expect(migrateDraftRecord({ version: WIZARD_DRAFT_VERSION, data: {}, currentStep: 0 })?.currentStep).toBe(1);
  });
});
