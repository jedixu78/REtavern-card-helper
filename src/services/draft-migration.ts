/**
 * 草稿版本迁移 — 纯函数模块（自动草稿与手动草稿共用同一条迁移链）。
 *
 * 与 draft-service 分离的原因：draft-service 依赖 Dexie/IndexedDB，
 * 而迁移是纯数据变换，单独成模块可以被单测直接引用而不触碰数据库层。
 */
import type { WizardDraft, LorebookEntry } from '../constants/defaults';
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

/**
 * V6 → V7：合并「世界观锚定」+「世界书骨架」为「锚定世界观」步骤。
 * - worldAnchor 重构为「从大到小」漏斗字段：type/era/culture/humanity/constraints
 *   旧 V6 字段映射：era → era，hardConstraints → constraints（coreRules/tone 丢弃）
 * - 移除 skeletonTopic / skeletonCount / skeletonModeEnabled 字段（worldRules 保留）
 * - lorebookEntries 内的 fromSkeleton/skeletonExpanded 标记替换为 fromAnchor
 * - 步号不变（仍是 8 步），但 step 2 的语义从「骨架」改为「锚定世界观」
 */
function migrateDataV6ToV7(data: Partial<WizardDraft>): Partial<WizardDraft> {
  const next: Partial<WizardDraft> = { ...data };
  // worldAnchor 字段重构
  const oldAnchor = next.worldAnchor as unknown as
    | { era?: string; coreRules?: string; hardConstraints?: string; tone?: string }
    | undefined;
  if (oldAnchor && (oldAnchor.era || oldAnchor.coreRules || oldAnchor.hardConstraints || oldAnchor.tone)) {
    next.worldAnchor = {
      type: '',
      era: oldAnchor.era ?? '',
      culture: '',
      humanity: '',
      constraints: oldAnchor.hardConstraints ?? '',
    };
  }
  // 移除已删除字段（直接 delete，避免后续 normalizeDraft 把它们当成有效字段透传）
  delete (next as Record<string, unknown>).skeletonTopic;
  delete (next as Record<string, unknown>).skeletonCount;
  delete (next as Record<string, unknown>).skeletonModeEnabled;
  // lorebookEntries 标记替换
  if (Array.isArray(next.lorebookEntries)) {
    next.lorebookEntries = next.lorebookEntries.map((e) => {
      const entry = e as LorebookEntry & { fromSkeleton?: boolean; skeletonExpanded?: boolean };
      if (entry.fromSkeleton) {
        const { fromSkeleton: _fs, skeletonExpanded: _se, ...rest } = entry;
        return { ...rest, fromAnchor: true };
      }
      return entry;
    });
  }
  return next;
}

export interface MigratedDraftPayload {
  data: Partial<WizardDraft>;
  currentStep: number;
  /** 非空表示发生了迁移（供调用方提示用户），值为旧版本号如 'V4'。 */
  migratedFrom?: string;
}

/**
 * 把任意历史版本的草稿记录迁移到当前 WIZARD_DRAFT_VERSION。
 *
 * 降级策略：遇到未知版本（应用降级或极旧版本）时，不再返回 null 丢弃数据，
 * 而是原样透传 data，由调用方的 normalizeDraft() 补齐缺失字段。
 * 仅当 record 本身为空/无 data 字段时才返回 null。
 *
 * 注意：V4 草稿必须**链式**走 V4→V5→V6→V7 多段步号/数据映射。
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
    const v5Step = migrateStepV4ToV5(step);
    const v6Step = migrateStepV5ToV6(v5Step);
    const v7Data = migrateDataV6ToV7(data);
    return { data: v7Data, currentStep: v6Step, migratedFrom: 'V4' };
  }
  if (record.version === 5) {
    const v6Step = migrateStepV5ToV6(step);
    const v7Data = migrateDataV6ToV7(data);
    return { data: v7Data, currentStep: v6Step, migratedFrom: 'V5' };
  }
  if (record.version === 6) {
    const v7Data = migrateDataV6ToV7(data);
    return { data: v7Data, currentStep: step, migratedFrom: 'V6' };
  }
  // 未知版本（应用降级 / 极旧版本）：原样透传，normalizeDraft 补齐缺失字段，
  // 避免直接丢弃用户数据。migratedFrom 标记来源版本供调用方提示。
  if (data && typeof data === 'object') {
    return {
      data,
      currentStep: Math.min(step, 9),
      migratedFrom: `V${record.version}`,
    };
  }
  return null;
}
