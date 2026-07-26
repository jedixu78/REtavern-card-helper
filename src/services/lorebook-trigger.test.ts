import { describe, it, expect } from 'vitest';
import { evaluateLorebookTriggers, keyMatches, type TriggerableEntry } from './lorebook-trigger';

function entry(over: Partial<TriggerableEntry> = {}): TriggerableEntry {
  return {
    name: over.name ?? 'E',
    keys: [],
    content: 'C',
    enabled: true,
    constant: false,
    insertion_order: 100,
    ...over,
  };
}

const msg = (content: string) => ({ role: 'user', content });
/** 概率判定固定为「必中」，避免随机性污染断言 */
const alwaysHit = { random: () => 0 };

describe('keyMatches', () => {
  it('默认大小写不敏感，可用 case_sensitive 收紧', () => {
    expect(keyMatches('The Dragon flies', 'dragon')).toBe(true);
    expect(keyMatches('The Dragon flies', 'dragon', { caseSensitive: true })).toBe(false);
  });

  it('整词匹配阻止子串误命中（英文）', () => {
    expect(keyMatches('cat', 'cat', { wholeWords: true })).toBe(true);
    expect(keyMatches('concatenate', 'cat', { wholeWords: true })).toBe(false);
    // 关闭整词后子串命中
    expect(keyMatches('concatenate', 'cat', { wholeWords: false })).toBe(true);
  });

  it('中文无词边界：整词匹配必须退化为子串，否则中文关键词全部哑火', () => {
    // \b 对 CJK 不成立，若不特判则下面这条会返回 false
    expect(keyMatches('他走进了酒馆大门', '酒馆', { wholeWords: true })).toBe(true);
  });

  it('支持 /pattern/flags 正则关键词', () => {
    expect(keyMatches('订单编号 A-1234', '/A-\\d{4}/', { useRegex: true })).toBe(true);
    expect(keyMatches('订单编号 B-1234', '/A-\\d{4}/', { useRegex: true })).toBe(false);
  });

  it('正则非法或非 /../ 写法时退回字面量匹配，不让条目整个哑火', () => {
    expect(keyMatches('值为 a(b', 'a(b', { useRegex: true })).toBe(true);
    expect(keyMatches('普通关键词', '普通', { useRegex: true })).toBe(true);
  });

  it('空关键词/空文本不命中', () => {
    expect(keyMatches('text', '')).toBe(false);
    expect(keyMatches('text', '   ')).toBe(false);
    expect(keyMatches('', 'key')).toBe(false);
  });
});

describe('evaluateLorebookTriggers — 基本触发', () => {
  it('蓝灯常驻条目无条件激活；绿灯未命中则不激活', () => {
    const blue = entry({ name: 'blue', constant: true });
    const green = entry({ name: 'green', keys: ['龙'] });
    const r = evaluateLorebookTriggers([blue, green], [msg('今天天气不错')], alwaysHit);
    expect(r.activated.map((a) => a.entry.name)).toEqual(['blue']);
    expect(r.activated[0].reason).toBe('constant');
    expect(r.skipped.find((s) => s.entry.name === 'green')?.reason).toBe('no-match');
  });

  it('绿灯关键词命中后激活，并记录命中的关键词', () => {
    const green = entry({ name: 'green', keys: ['龙', '巨龙'] });
    const r = evaluateLorebookTriggers([green], [msg('一条巨龙飞过')], alwaysHit);
    expect(r.activated).toHaveLength(1);
    expect(r.activated[0].reason).toBe('keyword');
    // '龙' 与 '巨龙' 都是子串命中
    expect(r.activated[0].matchedKeys).toEqual(['龙', '巨龙']);
  });

  it('禁用条目直接跳过', () => {
    const off = entry({ name: 'off', constant: true, enabled: false });
    const r = evaluateLorebookTriggers([off], [msg('x')], alwaysHit);
    expect(r.activated).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('disabled');
  });

  it('绿灯无关键词记为 no-keys（用户最常见的配置失误）', () => {
    const noKeys = entry({ name: 'nk', keys: [] });
    const r = evaluateLorebookTriggers([noKeys], [msg('任何内容')], alwaysHit);
    expect(r.skipped[0].reason).toBe('no-keys');
  });

  it('按 insertion_order 升序排列激活结果', () => {
    const a = entry({ name: 'a', constant: true, insertion_order: 300 });
    const b = entry({ name: 'b', constant: true, insertion_order: 100 });
    const c = entry({ name: 'c', constant: true, insertion_order: 200 });
    const r = evaluateLorebookTriggers([a, b, c], [msg('x')], alwaysHit);
    expect(r.activated.map((x) => x.entry.name)).toEqual(['b', 'c', 'a']);
  });
});

describe('evaluateLorebookTriggers — 次要关键词逻辑', () => {
  const withLogic = (logic: number) =>
    entry({ keys: ['王国'], secondary_keys: ['战争', '和平'], selectiveLogic: logic });

  it('AND ANY(0)：至少一个次要命中', () => {
    expect(evaluateLorebookTriggers([withLogic(0)], [msg('王国陷入战争')], alwaysHit).activated).toHaveLength(1);
    expect(evaluateLorebookTriggers([withLogic(0)], [msg('王国很大')], alwaysHit).activated).toHaveLength(0);
  });

  it('AND ALL(1)：全部次要命中', () => {
    expect(evaluateLorebookTriggers([withLogic(1)], [msg('王国在战争与和平间摇摆')], alwaysHit).activated).toHaveLength(1);
    expect(evaluateLorebookTriggers([withLogic(1)], [msg('王国陷入战争')], alwaysHit).activated).toHaveLength(0);
  });

  it('NOT ALL(2)：并非全部次要命中', () => {
    expect(evaluateLorebookTriggers([withLogic(2)], [msg('王国陷入战争')], alwaysHit).activated).toHaveLength(1);
    expect(evaluateLorebookTriggers([withLogic(2)], [msg('王国在战争与和平间摇摆')], alwaysHit).activated).toHaveLength(0);
  });

  it('NOT ANY(3)：一个次要都没命中', () => {
    expect(evaluateLorebookTriggers([withLogic(3)], [msg('王国很大')], alwaysHit).activated).toHaveLength(1);
    expect(evaluateLorebookTriggers([withLogic(3)], [msg('王国陷入战争')], alwaysHit).activated).toHaveLength(0);
  });

  it('次要逻辑未通过时记为 secondary-logic，与「主键就没命中」区分开', () => {
    const r = evaluateLorebookTriggers([withLogic(1)], [msg('王国陷入战争')], alwaysHit);
    expect(r.skipped[0].reason).toBe('secondary-logic');
  });

  it('无次要关键词时逻辑设置不影响激活', () => {
    const e = entry({ keys: ['王国'], secondary_keys: [], selectiveLogic: 1 });
    expect(evaluateLorebookTriggers([e], [msg('王国')], alwaysHit).activated).toHaveLength(1);
  });
});

describe('evaluateLorebookTriggers — 扫描深度', () => {
  const messages = [msg('第一条提到龙'), msg('第二条'), msg('第三条'), msg('第四条'), msg('第五条')];

  it('默认深度 4 只扫最近 4 条，扫不到更早的关键词', () => {
    const e = entry({ keys: ['龙'] });
    expect(evaluateLorebookTriggers([e], messages, alwaysHit).activated).toHaveLength(0);
  });

  it('加大全局扫描深度后可命中', () => {
    const e = entry({ keys: ['龙'] });
    expect(evaluateLorebookTriggers([e], messages, { ...alwaysHit, scanDepth: 5 }).activated).toHaveLength(1);
  });

  it('条目级 scanDepth 覆盖全局深度', () => {
    const e = entry({ keys: ['龙'], scanDepth: 5 });
    expect(evaluateLorebookTriggers([e], messages, alwaysHit).activated).toHaveLength(1);
  });
});

describe('evaluateLorebookTriggers — 概率', () => {
  it('probability=0 永不激活并记为 probability', () => {
    const e = entry({ keys: ['龙'], probability: 0 });
    const r = evaluateLorebookTriggers([e], [msg('龙')], alwaysHit);
    expect(r.activated).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('probability');
  });

  it('probability=50 由注入的随机源决定，可复现', () => {
    const e = entry({ keys: ['龙'], probability: 50 });
    expect(evaluateLorebookTriggers([e], [msg('龙')], { random: () => 0.2 }).activated).toHaveLength(1);
    expect(evaluateLorebookTriggers([e], [msg('龙')], { random: () => 0.8 }).activated).toHaveLength(0);
  });

  it('未设置 probability 视为必中（不受随机源影响）', () => {
    const e = entry({ keys: ['龙'] });
    expect(evaluateLorebookTriggers([e], [msg('龙')], { random: () => 0.99 }).activated).toHaveLength(1);
  });

  it('概率同样作用于蓝灯常驻条目', () => {
    const e = entry({ constant: true, probability: 0 });
    expect(evaluateLorebookTriggers([e], [msg('x')], alwaysHit).activated).toHaveLength(0);
  });
});

describe('evaluateLorebookTriggers — 递归扫描', () => {
  it('已激活条目的内容可触发下一条（记为 recursion）', () => {
    const first = entry({ name: 'first', keys: ['入口'], content: '这里通往地下城' });
    const second = entry({ name: 'second', keys: ['地下城'], content: '地下城很危险' });
    const r = evaluateLorebookTriggers([first, second], [msg('我找到了入口')], alwaysHit);
    expect(r.activated.map((a) => a.entry.name).sort()).toEqual(['first', 'second']);
    expect(r.activated.find((a) => a.entry.name === 'second')?.reason).toBe('recursion');
    expect(r.activated.find((a) => a.entry.name === 'second')?.recursionStep).toBe(1);
  });

  it('recursiveScanning=false 时不做递归', () => {
    const first = entry({ name: 'first', keys: ['入口'], content: '这里通往地下城' });
    const second = entry({ name: 'second', keys: ['地下城'] });
    const r = evaluateLorebookTriggers([first, second], [msg('入口')], { ...alwaysHit, recursiveScanning: false });
    expect(r.activated.map((a) => a.entry.name)).toEqual(['first']);
  });

  it('prevent_recursion：自身内容不触发他人', () => {
    const first = entry({ name: 'first', keys: ['入口'], content: '这里通往地下城', prevent_recursion: true });
    const second = entry({ name: 'second', keys: ['地下城'] });
    const r = evaluateLorebookTriggers([first, second], [msg('入口')], alwaysHit);
    expect(r.activated.map((a) => a.entry.name)).toEqual(['first']);
  });

  it('exclude_recursion：只接受真实聊天文本触发，不被递归带出来', () => {
    const first = entry({ name: 'first', keys: ['入口'], content: '这里通往地下城' });
    const second = entry({ name: 'second', keys: ['地下城'], exclude_recursion: true });
    const r = evaluateLorebookTriggers([first, second], [msg('入口')], alwaysHit);
    expect(r.activated.map((a) => a.entry.name)).toEqual(['first']);
    // 但聊天里直接出现「地下城」时仍可激活
    const r2 = evaluateLorebookTriggers([first, second], [msg('我进了地下城')], alwaysHit);
    expect(r2.activated.map((a) => a.entry.name)).toContain('second');
  });

  it('相互引用不会死循环（收敛且有轮次上限）', () => {
    const a = entry({ name: 'a', keys: ['甲'], content: '提到乙' });
    const b = entry({ name: 'b', keys: ['乙'], content: '提到甲' });
    const r = evaluateLorebookTriggers([a, b], [msg('说到甲')], alwaysHit);
    expect(r.activated).toHaveLength(2);
  });

  it('递归缓冲包含聊天原文：次要关键词只在聊天里、主键靠递归带出时仍应激活', () => {
    // 复查用真实执行复现的场景：早期实现的递归文本只有「上一轮新激活条目的 content」，
    // 次要关键词「探索」只在聊天原文里，会被误判为次要逻辑不满足并给出相反的诊断。
    const a = entry({ name: 'a', keys: ['入口'], content: '这里通往地下城' });
    const c = entry({ name: 'c', keys: ['地下城'], secondary_keys: ['探索'], selectiveLogic: 0 });
    const r = evaluateLorebookTriggers([a, c], [msg('我找到了入口，想探索一下')], alwaysHit);
    expect(r.activated.map((x) => x.entry.name).sort()).toEqual(['a', 'c']);
    expect(r.activated.find((x) => x.entry.name === 'c')?.reason).toBe('recursion');
  });

  it('递归缓冲累积：第 2 轮仍能看到第 0 轮激活条目的正文', () => {
    // e2 需要同时看到 e1(第0轮) 与 e3(第1轮) 的内容才能命中
    const e1 = entry({ name: 'e1', keys: ['甲'], content: '含有丙' });
    const e3 = entry({ name: 'e3', keys: ['丙'], content: '含有丁' });
    const e2 = entry({ name: 'e2', keys: ['丁'], secondary_keys: ['丙'], selectiveLogic: 0 });
    const r = evaluateLorebookTriggers([e1, e3, e2], [msg('说到甲')], alwaysHit);
    expect(r.activated.map((x) => x.entry.name).sort()).toEqual(['e1', 'e2', 'e3']);
  });

  it('次要逻辑失败不锁定条目：后续轮次缓冲变大后仍可激活', () => {
    // 第 0 轮：主键「王国」在聊天里命中，但次要键「战争」不在 → 不能因此永久锁死
    const src = entry({ name: 'src', keys: ['号角'], content: '战争爆发了' });
    const target = entry({ name: 'target', keys: ['王国'], secondary_keys: ['战争'], selectiveLogic: 0 });
    const r = evaluateLorebookTriggers([src, target], [msg('王国的号角响起')], alwaysHit);
    expect(r.activated.map((x) => x.entry.name).sort()).toEqual(['src', 'target']);
  });

  it('始终无法满足次要逻辑时，仍如实报告 secondary-logic 而不是 no-match', () => {
    const e = entry({ keys: ['王国'], secondary_keys: ['战争'], selectiveLogic: 0 });
    const r = evaluateLorebookTriggers([e], [msg('王国很大')], alwaysHit);
    expect(r.activated).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('secondary-logic');
  });

  it('概率失败仍然锁定（与 ST 一致：只记忆概率失败）', () => {
    const src = entry({ name: 'src', keys: ['甲'], content: '提到乙' });
    const target = entry({ name: 'target', keys: ['乙'], probability: 0 });
    const r = evaluateLorebookTriggers([src, target], [msg('甲')], alwaysHit);
    expect(r.skipped.find((s) => s.entry.name === 'target')?.reason).toBe('probability');
  });

  it('maxRecursionSteps 限制递归深度', () => {
    const e1 = entry({ name: 'e1', keys: ['一'], content: '二' });
    const e2 = entry({ name: 'e2', keys: ['二'], content: '三' });
    const e3 = entry({ name: 'e3', keys: ['三'], content: '四' });
    const r = evaluateLorebookTriggers([e1, e2, e3], [msg('一')], { ...alwaysHit, maxRecursionSteps: 1 });
    expect(r.activated.map((a) => a.entry.name)).toEqual(['e1', 'e2']);
  });
});

describe('evaluateLorebookTriggers — 整词匹配继承', () => {
  it('match_whole_words 为 null 时继承全局默认', () => {
    const e = entry({ keys: ['cat'], match_whole_words: null });
    // 全局默认整词：concatenate 不应命中
    expect(evaluateLorebookTriggers([e], [msg('concatenate')], alwaysHit).activated).toHaveLength(0);
    // 全局默认关闭整词：命中
    expect(
      evaluateLorebookTriggers([e], [msg('concatenate')], { ...alwaysHit, matchWholeWordsDefault: false }).activated,
    ).toHaveLength(1);
  });

  it('条目级 match_whole_words=false 覆盖全局默认', () => {
    const e = entry({ keys: ['cat'], match_whole_words: false });
    expect(evaluateLorebookTriggers([e], [msg('concatenate')], alwaysHit).activated).toHaveLength(1);
  });
});
