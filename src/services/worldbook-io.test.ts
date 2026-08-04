import { describe, it, expect } from 'vitest';
import { createEmptyLorebookEntry } from '../constants/defaults';
import {
  buildWorldInfoJson,
  parseWorldInfoJson,
  mergeLorebookEntries,
  lorebookEntryToWorldInfoEntry,
  worldInfoEntryToLorebookEntry,
} from './worldbook-io';

describe('worldbook-io', () => {
  const makeEntry = (name: string, content: string, overrides: Record<string, unknown> = {}) => ({
    ...createEmptyLorebookEntry(),
    name,
    comment: name,
    content,
    keys: ['词1', '词2'],
    constant: true,
    position: 'before_char' as const,
    probability: 80,
    depth: 6,
    group: '互斥组',
    group_weight: 60,
    role: 1,
    sticky: 2,
    cooldown: 3,
    delay: 1,
    ...overrides,
  });

  it('LorebookEntry → World Info 条目字段映射完整', () => {
    const entry = makeEntry('地点：旧城区', '内容', { secondary_keys: ['过滤'], selective: true, use_regex: true, match_whole_words: false });
    const wi = lorebookEntryToWorldInfoEntry(entry, 5, 3);
    expect(wi.uid).toBe(5);
    expect(wi.key).toEqual(['词1', '词2']);
    expect(wi.keysecondary).toEqual(['过滤']);
    expect(wi.comment).toBe('地点：旧城区');
    expect(wi.constant).toBe(true);
    expect(wi.position).toBe('before_char');
    expect(wi.probability).toBe(80);
    expect(wi.depth).toBe(6);
    expect(wi.groupWeight).toBe(60);
    expect(wi.role).toBe(1);
    expect(wi.sticky).toBe(2);
    expect(wi.useRegex).toBe(true);
    expect(wi.matchWholeWords).toBe(false);
  });

  it('World Info 条目 → LorebookEntry 兼容大小写两种字段风格', () => {
    const entry = worldInfoEntryToLorebookEntry({
      comment: '势力：暗影会',
      key: ['暗影会'],
      keysecondary: [],
      content: '正文',
      constant: false,
      position: 'after_char',
      probability: 50,
      depth: 2,
      groupWeight: 30,
    } as unknown as Record<string, unknown>);
    expect(entry.name).toBe('势力：暗影会');
    expect(entry.keys).toEqual(['暗影会']);
    expect(entry.content).toBe('正文');
    expect(entry.probability).toBe(50);
    expect(entry.depth).toBe(2);
    expect(entry.group_weight).toBe(30);
    expect(entry.id).toBeTruthy();
  });

  it('build → parse 往返一致', () => {
    const entries = [
      makeEntry('总纲', '世界总纲内容', { constant: true, position: 'before_char' }),
      makeEntry('人物：张三', '张三的设定', { keys: ['张三'], constant: false }),
    ];
    const json = JSON.stringify(buildWorldInfoJson(entries, '测试世界书'));
    const parsed = parseWorldInfoJson(json);
    expect(parsed.name).toBe('测试世界书');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].name).toBe('总纲');
    expect(parsed.entries[0].content).toBe('世界总纲内容');
    expect(parsed.entries[0].constant).toBe(true);
    expect(parsed.entries[1].keys).toEqual(['张三']);
  });

  it('兼容卡片 JSON 的 data.character_book 结构', () => {
    const cardJson = JSON.stringify({
      data: {
        character_book: {
          name: '卡内世界书',
          entries: [{ comment: '条目A', content: 'A内容', key: ['A'] }],
        },
      },
    });
    const parsed = parseWorldInfoJson(cardJson);
    expect(parsed.name).toBe('卡内世界书');
    expect(parsed.entries[0].name).toBe('条目A');
  });

  it('卡片 JSON 条目运行时字段读自 extensions（顶层兜底）', () => {
    // 卡片 JSON 的 data.character_book 把运行时字段放在 entry.extensions 里
    const entry = worldInfoEntryToLorebookEntry({
      comment: '深层条目',
      content: '正文',
      position: 'after_char',
      extensions: {
        depth: 9999,
        probability: 40,
        group: '互斥组',
        group_weight: 30,
        role: 2,
        sticky: 1,
        cooldown: 5,
        delay: 2,
        exclude_recursion: true,
      },
    } as unknown as Record<string, unknown>);
    expect(entry.depth).toBe(9999);
    expect(entry.probability).toBe(40);
    expect(entry.group).toBe('互斥组');
    expect(entry.group_weight).toBe(30);
    expect(entry.role).toBe(2);
    expect(entry.sticky).toBe(1);
    expect(entry.cooldown).toBe(5);
    expect(entry.delay).toBe(2);
    expect(entry.exclude_recursion).toBe(true);
  });

  it('merge 按标题覆盖并追加新条目（保留原 id）', () => {
    const existing = [
      makeEntry('旧城', '旧内容', { id: 'old-1' }),
      makeEntry('码头', '码头内容', { id: 'old-2' }),
    ];
    const incoming = [
      makeEntry('旧城', '新内容', { id: 'new-1' }),
      makeEntry('新区', '新区内容', { id: 'new-2' }),
    ];
    const merged = mergeLorebookEntries(existing, incoming);
    expect(merged).toHaveLength(3);
    expect(merged[0].id).toBe('old-1');
    expect(merged[0].content).toBe('新内容');
    expect(merged[2].name).toBe('新区');
    expect(merged[2].id).toBe('new-2');
  });

  it('非法输入抛错', () => {
    expect(() => parseWorldInfoJson('not json')).toThrow();
    expect(() => parseWorldInfoJson(JSON.stringify({ name: 'x' }))).toThrow('entries');
  });
});
