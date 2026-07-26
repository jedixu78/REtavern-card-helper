/**
 * backup-service — 全库备份与恢复。
 *
 * 用户全部创作数据分散在两个存储里，备份必须同时覆盖：
 *   - IndexedDB（Dexie：cards / chat_sessions / ai_settings / creator_chats / wizard_drafts）
 *   - localStorage（小说工坊状态与检查点、预设、主题、背景等）
 *
 * 记录中含 JSON 无法直接表达的两类值，用类型标记编码：
 *   - Date → { __tch: 'date', v: ISO 字符串 }（cards/drafts 的 createdAt 等，恢复后代码会调 .getTime()）
 *   - Blob → { __tch: 'blob', mime, v: base64 }（卡片/草稿封面图）
 *
 * 恢复语义：整库替换（清空后写入），调用方需先向用户二次确认，成功后应刷新页面。
 */
import { db } from '../db/database';
import { logger } from './logger';

export const BACKUP_FORMAT = 'tavern-card-helper-backup';
export const BACKUP_VERSION = 1;

interface EncodedDate { __tch: 'date'; v: string }
interface EncodedBlob { __tch: 'blob'; mime: string; v: string }

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** 表名 → 编码后的记录数组 */
  db: Record<string, unknown[]>;
  /** localStorage 全量键值 */
  localStorage: Record<string, string>;
}

// ── 编码 / 解码 ─────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  // 分块避免大封面图触发 String.fromCharCode 参数上限
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 深度遍历一条记录，把 Date/Blob 编码为带标记的普通对象。（导出仅供测试） */
export async function encodeValue(value: unknown): Promise<unknown> {
  if (value instanceof Date) {
    return { __tch: 'date', v: value.toISOString() } satisfies EncodedDate;
  }
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    return { __tch: 'blob', mime: value.type || 'application/octet-stream', v: bytesToBase64(bytes) } satisfies EncodedBlob;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(encodeValue));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await encodeValue(v);
    }
    return out;
  }
  return value;
}

function isEncodedDate(v: unknown): v is EncodedDate {
  return !!v && typeof v === 'object' && (v as EncodedDate).__tch === 'date';
}

function isEncodedBlob(v: unknown): v is EncodedBlob {
  return !!v && typeof v === 'object' && (v as EncodedBlob).__tch === 'blob';
}

/** encodeValue 的逆操作。（导出仅供测试） */
export function decodeValue(value: unknown): unknown {
  if (isEncodedDate(value)) return new Date(value.v);
  if (isEncodedBlob(value)) return new Blob([base64ToBytes(value.v).buffer as ArrayBuffer], { type: value.mime });
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = decodeValue(v);
    }
    return out;
  }
  return value;
}

// ── 导出 ────────────────────────────────────────────────────────────────────

/**
 * 汇出全部数据为一个可下载的备份对象。表清单动态取自 Dexie，未来加表自动纳入。
 *
 * 已知限制：全量数据（含封面 Blob 的 base64）会同时存在于内存中的编码对象与
 * JSON 字符串里，峰值约为封面总字节的数倍。数百张带高清封面的超大库在移动端
 * 可能吃紧；如成为实际问题，改为流式/分片导出（roadmap S2 已记录）。
 */
export async function createBackup(): Promise<BackupFile> {
  const tables: Record<string, unknown[]> = {};
  for (const table of db.tables) {
    const rows = await table.toArray();
    tables[table.name] = (await Promise.all(rows.map(encodeValue))) as unknown[];
  }

  const ls: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) {
      const v = localStorage.getItem(key);
      if (v !== null) ls[key] = v;
    }
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    db: tables,
    localStorage: ls,
  };
}

/** 触发浏览器下载备份 JSON 文件。 */
export async function downloadBackup(): Promise<void> {
  const backup = await createBackup();
  const stamp = backup.exportedAt.slice(0, 19).replace(/[T:]/g, '-');
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `吟游手册备份-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 延迟释放，避免部分浏览器在下载启动前回收 URL
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

// ── 恢复 ────────────────────────────────────────────────────────────────────

/** 校验文件形状，返回错误信息或 null（合法）。 */
export function validateBackup(data: unknown): string | null {
  if (!data || typeof data !== 'object') return '文件不是有效的备份 JSON';
  const b = data as Partial<BackupFile>;
  if (b.format !== BACKUP_FORMAT) return '不是本应用的备份文件（format 不匹配）';
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) {
    return `备份版本 ${String(b.version)} 高于当前应用支持的 ${BACKUP_VERSION}，请先升级应用`;
  }
  if (!b.db || typeof b.db !== 'object' || Array.isArray(b.db)) return '备份缺少数据库内容';
  // 各表内容必须是数组——畸形文件要在用户确认之前拒绝，而不是恢复到一半抛裸 TypeError
  for (const [name, rows] of Object.entries(b.db)) {
    if (!Array.isArray(rows)) return `备份中表 ${name} 的内容不是数组，文件可能已损坏`;
  }
  if (b.localStorage !== undefined) {
    if (!b.localStorage || typeof b.localStorage !== 'object' || Array.isArray(b.localStorage)) {
      return '备份中 localStorage 字段格式无效，文件可能已损坏';
    }
    for (const v of Object.values(b.localStorage)) {
      if (typeof v !== 'string') return '备份中 localStorage 含非字符串值，文件可能已损坏';
    }
  }
  return null;
}

/**
 * 整库恢复：清空现有数据后写入备份内容。成功后调用方应刷新页面。
 *
 * 语义与失败处理：
 *   - IndexedDB：清空**全部**当前表（包括备份里没有的表——「整库替换」必须名副其实，
 *     否则残留表与恢复表的 id 世代会错位），再写入备份内容；整体在一个 rw 事务里，
 *     失败自动回滚，DB 无损。
 *   - localStorage：无事务可用，采取「快照 → 清空 → 写入；任一键失败 → 回滚快照 → 抛错」。
 *     绝不吞掉失败——半恢复状态必须以错误形式暴露给用户，而不是弹「恢复成功」。
 *     （典型失败：备份来自配额更大的浏览器，目标端 QuotaExceededError。）
 */
export async function restoreBackup(backup: BackupFile): Promise<void> {
  const knownTables = new Map(db.tables.map((t) => [t.name, t]));

  await db.transaction('rw', db.tables, async () => {
    // 先清空全部表——备份中缺失的表也要清，保证恢复结果与备份时点一致
    for (const table of db.tables) {
      await table.clear();
    }
    for (const [name, rows] of Object.entries(backup.db)) {
      const table = knownTables.get(name);
      if (!table) {
        logger.warn(`[backup] 跳过未知表 ${name}（${rows.length} 条）`);
        continue;
      }
      const decoded = rows.map(decodeValue) as Record<string, unknown>[];
      await table.bulkPut(decoded);
    }
  });

  // ── localStorage 整体替换（快照回滚保护）──
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) {
      const v = localStorage.getItem(key);
      if (v !== null) snapshot[key] = v;
    }
  }

  localStorage.clear();
  const failedKeys: string[] = [];
  for (const [k, v] of Object.entries(backup.localStorage || {})) {
    try {
      localStorage.setItem(k, v);
    } catch {
      failedKeys.push(k);
      break; // 配额类失败继续写只会连环失败，直接进入回滚
    }
  }

  if (failedKeys.length > 0) {
    // 回滚到恢复前的本地设置。快照内容此前就装得下，重写理应成功；
    // 若连回滚都失败（极端），至少错误里说清了两侧状态。
    localStorage.clear();
    let rollbackOk = true;
    for (const [k, v] of Object.entries(snapshot)) {
      try {
        localStorage.setItem(k, v);
      } catch {
        rollbackOk = false;
      }
    }
    throw new Error(
      rollbackOk
        ? `本地设置（localStorage）恢复失败于键「${failedKeys[0]}」（可能是目标浏览器存储配额较小），已还原为恢复前的本地设置。注意：数据库部分已恢复为备份内容。`
        : `本地设置（localStorage）恢复失败且回滚未完全成功，本地设置可能不完整。数据库部分已恢复为备份内容。`,
    );
  }
}

/**
 * 请求持久化存储，降低浏览器在磁盘压力下整体回收 IndexedDB 的概率。
 * 应用启动时调用一次即可；被拒绝也无副作用。
 */
export function requestPersistentStorage(): void {
  try {
    if (navigator.storage?.persist) {
      navigator.storage.persisted().then((already) => {
        if (already) return;
        navigator.storage.persist().then((granted) => {
          logger.info(`[backup] 持久化存储请求${granted ? '已授予' : '被拒绝'}`);
        });
      }).catch(() => { /* 忽略 */ });
    }
  } catch {
    // 旧浏览器无此 API
  }
}
