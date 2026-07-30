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

  it('V4 迁移补默认 worldAnchor（新字段）', () => {
    const result = migrateDraftRecord({ version: 4, data: {}, currentStep: 1 });
    // V7：worldAnchor 默认值由 normalizeDraft 在加载时填充，迁移函数本身不补默认
    // 这里只验证旧字段（era/hardConstraints/worldRules）不会残留
    expect((result?.data as Record<string, unknown>).worldRules).toBeUndefined();
    // 旧字段 hardConstraints 作为键名不应残留（已重命名为 constraints）
    expect((result?.data.worldAnchor as Record<string, unknown> | undefined)?.hardConstraints).toBeUndefined();
    // 已有 worldAnchor.era 时迁移到新结构的 era 字段
    const withEra = migrateDraftRecord({
      version: 4,
      data: { worldAnchor: { era: '近未来', hardConstraints: '无魔法' } },
      currentStep: 1,
    });
    expect(withEra?.data.worldAnchor).toEqual({ type: '', era: '近未来', culture: '', humanity: '', constraints: '无魔法' });
  });

  it('V6 迁移到 V7：worldAnchor 字段重命名 + worldRules/skeleton* 移除', () => {
    const v6Data = {
      worldAnchor: { era: '近未来', coreRules: 'r', hardConstraints: 'hc', tone: 't' },
      worldRules: 'legacy rules',
      skeletonTopic: 'topic',
      skeletonCount: 10,
      skeletonModeEnabled: false,
      lorebookEntries: [
        { id: 'a', fromSkeleton: true, skeletonExpanded: false, content: 'c' },
        { id: 'b', fromSkeleton: false, skeletonExpanded: false, content: 'c2' },
      ],
    };
    const result = migrateDraftRecord({ version: 6, data: v6Data, currentStep: 1 });
    expect(result?.migratedFrom).toBe('V6');
    // era → era, hardConstraints → constraints; coreRules/tone 丢弃; type/culture/humanity 补空
    expect(result?.data.worldAnchor).toEqual({ type: '', era: '近未来', culture: '', humanity: '', constraints: 'hc' });
    // worldRules / skeleton* 字段被删除
    const dataAsRecord = result?.data as Record<string, unknown>;
    expect(dataAsRecord.worldRules).toBeUndefined();
    expect(dataAsRecord.skeletonTopic).toBeUndefined();
    expect(dataAsRecord.skeletonCount).toBeUndefined();
    expect(dataAsRecord.skeletonModeEnabled).toBeUndefined();
    // lorebookEntries fromSkeleton/skeletonExpanded → fromAnchor
    expect(result?.data.lorebookEntries?.[0].fromAnchor).toBe(true);
    expect((result?.data.lorebookEntries?.[0] as unknown as Record<string, unknown>).fromSkeleton).toBeUndefined();
    expect((result?.data.lorebookEntries?.[0] as unknown as Record<string, unknown>).skeletonExpanded).toBeUndefined();
    // 非 skeleton 条目不会被错误标记 fromAnchor
    expect(result?.data.lorebookEntries?.[1].fromAnchor).toBeUndefined();
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
