import { describe, it, expect } from 'vitest';
import { encodeValue, decodeValue, validateBackup, BACKUP_FORMAT, BACKUP_VERSION } from './backup-service';

describe('backup encode/decode 往返', () => {
  it('Date 编码后可还原为等值 Date', async () => {
    const d = new Date('2026-07-27T12:34:56.789Z');
    const encoded = await encodeValue({ createdAt: d });
    // 编码结果必须是可 JSON 序列化的普通对象
    const jsonRoundTrip = JSON.parse(JSON.stringify(encoded));
    const decoded = decodeValue(jsonRoundTrip) as { createdAt: Date };
    expect(decoded.createdAt).toBeInstanceOf(Date);
    expect(decoded.createdAt.getTime()).toBe(d.getTime());
  });

  it('Blob 编码为 base64 后可还原且字节一致', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 137, 80, 78, 71]);
    const blob = new Blob([bytes], { type: 'image/png' });
    const encoded = await encodeValue({ cover: blob });
    const jsonRoundTrip = JSON.parse(JSON.stringify(encoded));
    const decoded = decodeValue(jsonRoundTrip) as { cover: Blob };
    expect(decoded.cover).toBeInstanceOf(Blob);
    expect(decoded.cover.type).toBe('image/png');
    const restored = new Uint8Array(await decoded.cover.arrayBuffer());
    expect(Array.from(restored)).toEqual(Array.from(bytes));
  });

  it('嵌套结构（数组/对象/null/原始值）原样保留', async () => {
    const record = {
      id: 7,
      name: '测试',
      deletedAt: null,
      tags: ['a', 'b'],
      nested: { list: [1, { deep: true }], empty: '' },
    };
    const decoded = decodeValue(JSON.parse(JSON.stringify(await encodeValue(record))));
    expect(decoded).toEqual(record);
  });

  it('普通对象即使带 __tch 之外的字段也不会被误判', async () => {
    const record = { __tch: 'not-a-marker', v: 'x' };
    // 不是 'date'/'blob' 标记 → 原样透传
    const decoded = decodeValue(JSON.parse(JSON.stringify(await encodeValue(record))));
    expect(decoded).toEqual(record);
  });
});

describe('validateBackup', () => {
  const valid = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 'x', db: {}, localStorage: {} };

  it('合法备份返回 null', () => {
    expect(validateBackup(valid)).toBeNull();
  });

  it('format 不匹配报错', () => {
    expect(validateBackup({ ...valid, format: 'other' })).toMatch(/不是本应用/);
  });

  it('版本高于当前支持报错（向前兼容拒绝）', () => {
    expect(validateBackup({ ...valid, version: BACKUP_VERSION + 1 })).toMatch(/高于/);
  });

  it('非对象/缺 db 报错', () => {
    expect(validateBackup(null)).toBeTruthy();
    expect(validateBackup('str')).toBeTruthy();
    expect(validateBackup({ format: BACKUP_FORMAT, version: 1 })).toMatch(/缺少数据库/);
  });

  it('表内容不是数组在确认前就被拒绝', () => {
    expect(validateBackup({ ...valid, db: { cards: 'oops' } })).toMatch(/cards.*不是数组/);
    expect(validateBackup({ ...valid, db: { cards: null } })).toMatch(/不是数组/);
  });

  it('localStorage 字段畸形被拒绝，缺失可接受', () => {
    expect(validateBackup({ ...valid, localStorage: 'oops' })).toMatch(/localStorage/);
    expect(validateBackup({ ...valid, localStorage: ['a'] })).toMatch(/localStorage/);
    expect(validateBackup({ ...valid, localStorage: { k: 42 } })).toMatch(/非字符串/);
    expect(validateBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 'x', db: {} })).toBeNull();
  });
});
