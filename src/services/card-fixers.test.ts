import { describe, it, expect } from 'vitest';
import { autoFixEntries, fixLorebookBlueGreenLights } from './card-fixers';
import { createEmptyLorebookEntry } from '../constants/defaults';
import type { LorebookEntry } from '../constants/defaults';
import fs from 'fs';
import path from 'path';

function makeEntry(overrides: Partial<LorebookEntry> = {}): LorebookEntry {
  return {
    ...createEmptyLorebookEntry(),
    keys: ['关键词'],
    content: '这是一段测试内容。',
    name: '测试条目',
    comment: '测试条目',
    enabled: true,
    constant: false,
    selective: false,
    insertion_order: 1,
    priority: 0,
    ...overrides,
  };
}

describe('autoFixEntries', () => {
  it('对无问题的条目不做修改', () => {
    const entries = [makeEntry()];
    const result = autoFixEntries(entries);
    expect(result.fixes).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
  });

  it('禁用空内容条目', () => {
    const entries = [makeEntry({ content: '' })];
    const result = autoFixEntries(entries);
    expect(result.entries[0].enabled).toBe(false);
    expect(result.fixes.some((f) => f.includes('禁用'))).toBe(true);
  });

  it('为无触发词的非蓝灯条目添加 name 作为 key', () => {
    const entries = [makeEntry({ keys: [], name: '角色设定', comment: '角色设定' })];
    const result = autoFixEntries(entries);
    expect(result.entries[0].keys).toContain('角色设定');
    expect(result.fixes.some((f) => f.includes('触发关键词'))).toBe(true);
  });

  it('蓝灯条目的 selective 被移除', () => {
    const entries = [makeEntry({ constant: true, selective: true, secondary_keys: [] })];
    const result = autoFixEntries(entries);
    expect(result.entries[0].selective).toBe(false);
    expect(result.fixes.some((f) => f.includes('selective'))).toBe(true);
  });

  it('有有效触发词的 selective 条目移除 selective', () => {
    const entries = [makeEntry({ selective: true, secondary_keys: [], keys: ['好的关键词'], constant: false })];
    const result = autoFixEntries(entries);
    expect(result.entries[0].selective).toBe(false);
  });

  it('无有效触发词且 selective 的条目被禁用', () => {
    const entries = [makeEntry({ selective: true, secondary_keys: [], keys: ['a'], constant: false, name: '测试' })];
    const result = autoFixEntries(entries);
    expect(result.entries[0].enabled).toBe(false);
  });

  it('拆分超长内容条目（>2500 字符）', () => {
    const longContent = '段落内容。'.repeat(600); // ~3000 chars
    const entries = [makeEntry({ content: longContent, name: '长条目', comment: '长条目' })];
    const result = autoFixEntries(entries);
    expect(result.entries.length).toBeGreaterThan(1);
    expect(result.fixes.some((f) => f.includes('拆分'))).toBe(true);
  });

  it('拆分后子条目继承父条目的 keys', () => {
    const longContent = '段落一内容。\n\n段落二内容。\n\n段落三内容。'.repeat(400);
    const entries = [makeEntry({ content: longContent, keys: ['触发词'], name: '长条目', comment: '长条目' })];
    const result = autoFixEntries(entries);
    for (const e of result.entries) {
      expect(e.keys).toContain('触发词');
    }
  });

  it('无名称无触发词的条目被禁用', () => {
    const entries = [makeEntry({ keys: [], name: '', comment: '' })];
    const result = autoFixEntries(entries);
    expect(result.entries[0].enabled).toBe(false);
  });

  it('多个修复同时应用', () => {
    const entries = [
      makeEntry({ content: '', name: '空条目', comment: '空条目' }),
      makeEntry({ keys: [], constant: false, name: '无关键词', comment: '无关键词' }),
      makeEntry({ selective: true, secondary_keys: [], constant: true, name: '蓝灯selective', comment: '蓝灯selective' }),
    ];
    const result = autoFixEntries(entries);
    expect(result.fixes.length).toBeGreaterThanOrEqual(3);
  });
});

describe('fixLorebookBlueGreenLights - 二十一人会.json 实测', () => {
  // 读取参考卡 JSON，提取世界书条目
  const jsonPath = path.resolve(process.cwd(), '参考', '二十一人会.json');
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
  const rawEntries = ((raw.data as Record<string, unknown>)?.character_book as Record<string, unknown>)?.entries as unknown[];

  // 转换为 LorebookEntry 格式
  const entries: LorebookEntry[] = (rawEntries || []).map((e, i) => {
    const entry = e as Record<string, unknown>;
    return {
      ...createEmptyLorebookEntry(),
      id: String(entry.id ?? i),
      keys: (entry.keys as string[]) || [],
      secondary_keys: (entry.secondary_keys as string[]) || [],
      content: (entry.content as string) || '',
      name: (entry.name as string) || (entry.comment as string) || `Entry ${i}`,
      comment: (entry.comment as string) || (entry.name as string) || '',
      enabled: entry.enabled !== false,
      constant: entry.constant === true,
      selective: entry.selective === true,
      insertion_order: (entry.insertion_order as number) ?? i,
      position: (entry.position as LorebookEntry['position']) ?? 'after_char',
      priority: (entry.priority as number) ?? 0,
      case_sensitive: entry.case_sensitive === true,
      prevent_recursion: entry.prevent_recursion !== false,
    };
  });

  it('成功加载参考卡世界书条目', () => {
    console.log(`\n参考卡共 ${entries.length} 条世界书条目`);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('打印修复前的蓝绿灯状态', () => {
    console.log('\n========== 修复前 ==========');
    for (const e of entries) {
      const light = e.constant ? '蓝灯' : '绿灯';
      const keysStr = e.keys.length > 0 ? e.keys.join(', ') : '(空)';
      const selStr = e.selective ? 'selective=true' : 'selective=false';
      const secStr = (e.secondary_keys?.length ?? 0) > 0 ? `secondary=[${e.secondary_keys.join(',')}]` : 'secondary=(空)';
      const enStr = e.enabled ? '启用' : '禁用';
      console.log(`  [${light}] ${enStr} | ${selStr} ${secStr} | keys: ${keysStr} | ${e.name}`);
    }
  });

  it('执行蓝绿灯修复并对比变化', () => {
    const fixed = fixLorebookBlueGreenLights(entries);

    console.log('\n========== 修复后 ==========');
    const changes: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const before = entries[i];
      const after = fixed[i];
      const light = after.constant ? '蓝灯' : '绿灯';
      const keysStr = after.keys.length > 0 ? after.keys.join(', ') : '(空)';
      const selStr = after.selective ? 'selective=true' : 'selective=false';
      const enStr = after.enabled ? '启用' : '禁用';
      console.log(`  [${light}] ${enStr} | ${selStr} | keys: ${keysStr} | ${after.name}`);

      // 检测变化
      if (before.selective !== after.selective) {
        changes.push(`  ${before.name}: selective ${before.selective} -> ${after.selective}`);
      }
      if (before.keys.length !== after.keys.length ||
          before.keys.join(',') !== after.keys.join(',')) {
        changes.push(`  ${before.name}: keys [${before.keys.join(',')}] -> [${after.keys.join(',')}]`);
      }
    }

    console.log('\n========== 变更项 ==========');
    if (changes.length === 0) {
      console.log('  无变更（参考卡蓝绿灯设置已无问题）');
    } else {
      for (const c of changes) console.log(c);
    }

    // 参考卡中所有蓝灯条目的 selective=true 且 secondary_keys 为空，应被移除
    const blueLightSelectiveBefore = entries.filter(e => e.constant && e.selective);
    const blueLightSelectiveAfter = fixed.filter(e => e.constant && e.selective);
    expect(blueLightSelectiveAfter.length).toBeLessThan(blueLightSelectiveBefore.length);

    // 修复后不应有任何 selective=true 且 secondary_keys 为空的条目
    const badSelective = fixed.filter(e => e.selective && (!e.secondary_keys || e.secondary_keys.length === 0));
    expect(badSelective).toHaveLength(0);

    // 修复后不应有任何绿灯启用条目 keys 为空（除非条目名为空）
    const badGreen = fixed.filter(e => !e.constant && e.enabled && (!e.keys || e.keys.length === 0));
    expect(badGreen).toHaveLength(0);
  });
});
