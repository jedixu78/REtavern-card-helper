/**
 * 草稿版本迁移 — 纯函数模块（自动草稿与手动草稿共用同一条迁移链）。
 *
 * 与 draft-service 分离的原因：draft-service 依赖 Dexie/IndexedDB，
 * 而迁移是纯数据变换，单独成模块可以被单测直接引用而不触碰数据库层。
 */
import type { WizardDraft } from '../constants/defaults';
import { WIZARD_DRAFT_VERSION } from '../constants/defaults';
import type { WizardDraftRecord } from '../db/database';

/**
 * V4 → V5 步号迁移。
 * V4（7 步）：卡名(1) → 角色(2) → 世界书(3) → MVU(4) → 分阶段(5) → 开场白(6) → 导出(7)
 * V5（8 步）：卡名(1) → 骨架(2) → 角色(3) → 细节(4) → MVU(5) → 分阶段(6) → 开场白(7) → 导出(8)
 */
function migrateStepV4ToV5(oldStep: number): number {
  const stepMap: Record<number, number> = { 1: 1, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8 };
  return stepMap[oldStep] ?? Math.min(oldStep, 1);
}

/** V5 → V6：新增「直播包装」步骤（step 8），原「美化导出」从 step 8 移到 step 9。 */
function migrateStepV5ToV6(oldStep: number): number {
  if (oldStep >= 8) return oldStep + 1;
  return oldStep;
}

export interface MigratedDraftPayload {
  data: Partial<WizardDraft>;
  currentStep: number;
  /** 非空表示发生了迁移（供调用方提示用户），值为旧版本号如 'V4'。 */
  migratedFrom?: string;
}

/**
 * 把任意历史版本的草稿记录迁移到当前 WIZARD_DRAFT_VERSION。
 * 返回 null 表示版本过旧无迁移路径（调用方自行决定丢弃或报错）。
 *
 * 注意：V4 草稿必须**链式**走 V4→V5→V6 两段步号映射——旧实现只做了 V4→V5，
 * 导致 V4 的导出步(7)映射到 8 后落在 V6 的「直播包装」而非「导出」(9)。
 */
export function migrateDraftRecord(
  record: Pick<WizardDraftRecord, 'version' | 'data' | 'currentStep'>,
): MigratedDraftPayload | null {
  const step = record.currentStep || 1;
  const data = record.data as Partial<WizardDraft>;

  if (record.version === WIZARD_DRAFT_VERSION) {
    return { data, currentStep: step };
  }
  if (record.version === 4) {
    return {
      data: { ...data, worldRules: data.worldRules ?? '' },
      currentStep: migrateStepV5ToV6(migrateStepV4ToV5(step)),
      migratedFrom: 'V4',
    };
  }
  if (record.version === 5) {
    return { data, currentStep: migrateStepV5ToV6(step), migratedFrom: 'V5' };
  }
  return null;
}
