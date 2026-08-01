/**
 * Tests for lorebook revise flow: LOREBOOK_REVISE_PROMPT + mapAiEntriesToLorebookEntries.
 * These cover the highest-risk code paths added in the "草稿态预览修改" feature
 * where silent failures (bad AI JSON, missing fields, …) would otherwise be hard to catch.
 */
import { describe, it, expect } from 'vitest';
import { LOREBOOK_REVISE_PROMPT } from '../../constants/prompts';
import type { AIGeneratedLorebookEntry } from '../../constants/defaults';
import { mapAiEntriesToLorebookEntries } from '../../services/lorebook-revise';

describe('LOREBOOK_REVISE_PROMPT', () => {
  const anchorText = '地域：日本 / 世界类型：异世界';
  const currentEntriesJson = JSON.stringify([{ name: '条目1' }]);
  const userRequest = '把地点合并';

  it('包含用户需求和当前条目 JSON', () => {
    const { system, user } = LOREBOOK_REVISE_PROMPT('test', anchorText, currentEntriesJson, userRequest);
    expect(system).toContain(userRequest);
    expect(system).toContain(currentEntriesJson);
    expect(user).toContain('修订这批草稿条目');
  });

  it('包含世界观锚定约束', () => {
    const { system } = LOREBOOK_REVISE_PROMPT('test', anchorText, currentEntriesJson, userRequest);
    expect(system).toContain(anchorText);
    expect(system).toContain('世界观锚定');
  });

  it('NSFW 模式下包含 NSFW 指令', () => {
    const { system } = LOREBOOK_REVISE_PROMPT('test', anchorText, currentEntriesJson, userRequest, true);
    expect(system).toContain('NSFW 内容指令');
  });

  it('非 NSFW 模式下包含内容安全指令', () => {
    const { system } = LOREBOOK_REVISE_PROMPT('test', anchorText, currentEntriesJson, userRequest, false);
    expect(system).toContain('内容安全指令');
  });

  it('要求输出 JSON 数组（非 patch）', () => {
    const { system } = LOREBOOK_REVISE_PROMPT('test', anchorText, currentEntriesJson, userRequest);
    expect(system).toContain('完整的新版条目数组（替换式，非 patch）');
    expect(system).toContain('JSON 数组');
  });
});

describe('mapAiEntriesToLorebookEntries', () => {
  it('映射基本字段', () => {
    const input: AIGeneratedLorebookEntry[] = [
      {
        name: '测试条目',
        keys: ['key1', 'key2'],
        secondary_keys: [],
        content: '内容详情',
        comment: '备注',
        constant: false,
        selective: false,
        insertion_order: 100,
        position: 'after_char',
        priority: 50,
      },
    ];
    const result = mapAiEntriesToLorebookEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('测试条目');
    expect(result[0].keys).toEqual(['key1', 'key2']);
    expect(result[0].content).toBe('内容详情');
    expect(result[0].constant).toBe(false);
    expect(result[0].position).toBe('after_char');
  });

  it('对缺失字段使用默认值', () => {
    const input: AIGeneratedLorebookEntry[] = [
      {
        name: '最小条目',
        keys: ['key'],
        content: '内容',
      } as AIGeneratedLorebookEntry,
    ];
    const result = mapAiEntriesToLorebookEntries(input);
    expect(result).toHaveLength(1);
    // 默认值检查
    expect(result[0].constant).toBe(false);
    expect(result[0].selective).toBe(false);
    expect(result[0].position).toBe('after_char');
    expect(result[0].insertion_order).toBe(100);
    expect(result[0].priority).toBe(50);
    expect(result[0].probability).toBe(100);
    expect(result[0].match_whole_words).toBe(true);
  });

  it('处理空数组', () => {
    const result = mapAiEntriesToLorebookEntries([]);
    expect(result).toHaveLength(0);
  });

  it('处理 undefined/null 字段', () => {
    const input: AIGeneratedLorebookEntry[] = [
      {
        name: '空字段条目',
        keys: undefined as unknown as string[],
        secondary_keys: undefined as unknown as string[],
        content: '内容',
        constant: undefined as unknown as boolean,
      } as AIGeneratedLorebookEntry,
    ];
    const result = mapAiEntriesToLorebookEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].keys).toEqual([]);
    expect(result[0].secondary_keys).toEqual([]);
    expect(result[0].constant).toBe(false);
  });

  it('空 name 回退到空字符串', () => {
    const input: AIGeneratedLorebookEntry[] = [
      { name: '', keys: [], content: '内容' } as AIGeneratedLorebookEntry,
    ];
    const result = mapAiEntriesToLorebookEntries(input);
    expect(result[0].name).toBe('');
  });

  it('空 content 回退到空字符串', () => {
    const input: AIGeneratedLorebookEntry[] = [
      { name: '条目', keys: ['key'], content: '' } as AIGeneratedLorebookEntry,
    ];
    const result = mapAiEntriesToLorebookEntries(input);
    expect(result[0].content).toBe('');
  });
});
