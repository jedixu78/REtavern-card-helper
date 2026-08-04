/**
 * version-service — 卡片版本历史管理。
 *
 * 每张卡片最多保留 MAX_VERSIONS_PER_CARD 条版本快照，超出按时间淘汰最旧的。
 * 快照只保存卡片内容字段（spec/data/_meta/name 等），不保存库级元数据
 *（id/createdAt/updatedAt/deletedAt/coverImageBlob），回滚时这些字段保持不变。
 */
import { db, type CardVersion } from '../db/database';

/** 每张卡片最多保留的版本数 */
const MAX_VERSIONS_PER_CARD = 20;

/**
 * 需要从卡片记录中快照的内容字段（其余库级元数据由回滚逻辑保留当前值）。
 */
const SNAPSHOT_KEYS = [
  'spec',
  'spec_version',
  'data',
  '_meta',
  'name',
] as const;

/** 从卡片记录提取快照（只保留内容字段） */
function extractSnapshot(card: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) {
    if (key in card) {
      snapshot[key] = card[key];
    }
  }
  return snapshot;
}

/**
 * 保存一条版本快照。超出上限时自动淘汰最旧的版本。
 *
 * 整个「添加 + 淘汰」放在一个事务里：避免快速连续保存时两次并发各自读到
 * N 条、各自添加 1 条、各自删除超出部分——结果多删了旧版本。
 *
 * @param cardId 卡片 ID
 * @param card 完整卡片记录（从中提取内容字段）
 * @param source 版本来源
 * @returns 新建的版本 ID
 */
export async function saveVersion(
  cardId: number,
  card: Record<string, unknown>,
  source: CardVersion['source'],
): Promise<number> {
  const snapshot = extractSnapshot(card);
  const name = String(card.name ?? '');
  const now = new Date();

  return db.transaction('rw', db.card_versions, async () => {
    const versionId = await db.card_versions.add({
      cardId,
      name,
      snapshot,
      source,
      createdAt: now,
    });

    const all = await db.card_versions
      .where('cardId')
      .equals(cardId)
      .toArray();
    if (all.length > MAX_VERSIONS_PER_CARD) {
      const sorted = all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const toDelete = sorted.slice(MAX_VERSIONS_PER_CARD).map((v) => v.id!).filter(Boolean);
      if (toDelete.length > 0) {
        await db.card_versions.bulkDelete(toDelete);
      }
    }

    return versionId ?? 0;
  });
}

/** 列出卡片的版本历史（ newest first ） */
export async function listVersions(cardId: number): Promise<CardVersion[]> {
  const versions = await db.card_versions
    .where('cardId')
    .equals(cardId)
    .toArray();
  return versions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** 获取单条版本 */
export async function getVersion(versionId: number): Promise<CardVersion | undefined> {
  return db.card_versions.get(versionId);
}

/** 删除单条版本 */
export async function deleteVersion(versionId: number): Promise<void> {
  await db.card_versions.delete(versionId);
}

/** 删除卡片的全部版本（永久删除卡片时调用） */
export async function deleteAllVersions(cardId: number): Promise<void> {
  await db.card_versions.where('cardId').equals(cardId).delete();
}

/**
 * 回滚到指定版本。
 *
 * 流程：
 *   1. 读取目标版本快照
 *   2. 读取当前卡片记录
 *   3. 为当前状态创建一条 source='rollback' 的版本（保底，防止误操作）
 *   4. 将快照内容写回卡片（保留 id/createdAt/coverImageBlob/deletedAt）
 *
 * @returns 更新后的卡片记录
 */
export async function rollbackToVersion(versionId: number): Promise<Record<string, unknown> | null> {
  const version = await db.card_versions.get(versionId);
  if (!version) return null;

  const card = (await db.cards.get(version.cardId)) as Record<string, unknown> | undefined;
  if (!card) return null;

  const restored: Record<string, unknown> = {
    ...card,           // 保留 id / createdAt / coverImageBlob / deletedAt 等
    ...version.snapshot, // 覆盖 spec / data / _meta / name
    updatedAt: new Date(),
  };

  // Transaction: 保底版本 + 卡片回滚 原子执行，任一失败则全部回滚
  await db.transaction('rw', db.cards, db.card_versions, async () => {
    // 1. 为当前状态保底存一条版本
    await saveVersion(version.cardId, card, 'rollback');
    // 2. 用快照覆盖内容字段
    await db.cards.put(restored);
  });

  return restored;
}
