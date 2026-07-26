import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildSystemPromptWithTriggers,
  buildPostHistoryInstructions,
  evaluateCardLorebook,
  toTriggerableEntry,
} from './prompt-builder';

function makeCard(overrides: Record<string, unknown> = {}): { data: Record<string, unknown> } {
  return {
    data: {
      name: '艾莉亚',
      description: '一位勇敢的精灵游侠。',
      personality: '果断、忠诚',
      scenario: '在森林中相遇',
      first_mes: '你好，旅行者。',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      character_book: { entries: [] },
      ...overrides,
    },
  };
}

describe('buildSystemPrompt', () => {
  it('包含角色名称', () => {
    const prompt = buildSystemPrompt(makeCard() as never);
    expect(prompt).toContain('艾莉亚');
  });

  it('包含角色描述', () => {
    const prompt = buildSystemPrompt(makeCard() as never);
    expect(prompt).toContain('勇敢的精灵游侠');
  });

  it('包含性格', () => {
    const prompt = buildSystemPrompt(makeCard() as never);
    expect(prompt).toContain('果断');
  });

  it('包含场景', () => {
    const prompt = buildSystemPrompt(makeCard() as never);
    expect(prompt).toContain('森林');
  });

  it('使用 system_prompt 覆盖（当非空时）', () => {
    const card = makeCard({ system_prompt: '你是一个特殊系统提示。' }) as never;
    const prompt = buildSystemPrompt(card);
    expect(prompt).toContain('特殊系统提示');
  });

  it('空名称时使用默认 Character', () => {
    const card = makeCard({ name: '' }) as never;
    const prompt = buildSystemPrompt(card);
    // 不应崩溃，prompt 仍应包含其他内容
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('世界书常驻条目被包含在 prompt 中', () => {
    const card = makeCard({
      character_book: {
        entries: [
          { keys: ['艾莉亚'], content: '艾莉亚的详细背景故事', name: '背景', enabled: true, constant: true, insertion_order: 1 },
          { keys: ['无关'], content: '这条不应出现', name: '无关', enabled: true, constant: false, insertion_order: 2 },
        ],
      },
    }) as never;
    const prompt = buildSystemPrompt(card);
    expect(prompt).toContain('详细背景故事');
  });

  it('禁用的世界书条目不被包含', () => {
    const card = makeCard({
      character_book: {
        entries: [
          { keys: ['x'], content: '禁用内容', name: '禁用', enabled: false, constant: true, insertion_order: 1 },
        ],
      },
    }) as never;
    const prompt = buildSystemPrompt(card);
    expect(prompt).not.toContain('禁用内容');
  });
});

// ── 世界书触发接入 ──────────────────────────────────────────────────────────
// 导出卡形态的条目：ST 运行时字段在 extensions 下，selectiveLogic 是 ST 数值。

function bookCard(entries: Record<string, unknown>[], book: Record<string, unknown> = {}) {
  return makeCard({ character_book: { entries, ...book } }) as never;
}

function greenEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    keys: ['禁林'],
    secondary_keys: [],
    content: '禁林深处有一座废弃塔楼。',
    name: '禁林',
    enabled: true,
    constant: false,
    insertion_order: 10,
    case_sensitive: false,
    use_regex: false,
    extensions: { selectiveLogic: 0, probability: 100, useProbability: true, depth: 4 },
    ...overrides,
  };
}

describe('toTriggerableEntry — 字段映射', () => {
  it('extensions.selectiveLogic 的 ST 数值被翻译为引擎的 UI 索引', () => {
    // ST: 0=and_any 3=and_all 1=not_all 2=not_any → UI: 0/1/2/3
    expect(toTriggerableEntry({ extensions: { selectiveLogic: 0 } }).selectiveLogic).toBe(0);
    expect(toTriggerableEntry({ extensions: { selectiveLogic: 3 } }).selectiveLogic).toBe(1);
    expect(toTriggerableEntry({ extensions: { selectiveLogic: 1 } }).selectiveLogic).toBe(2);
    expect(toTriggerableEntry({ extensions: { selectiveLogic: 2 } }).selectiveLogic).toBe(3);
  });

  it('草稿形态（顶层 selectiveLogic，已是 UI 索引）原样透传', () => {
    expect(toTriggerableEntry({ selectiveLogic: 1 }).selectiveLogic).toBe(1);
  });

  it('match_whole_words 的 null 表示继承全局，不被压成 false', () => {
    expect(toTriggerableEntry({ extensions: { match_whole_words: null } }).match_whole_words).toBeNull();
    expect(toTriggerableEntry({ extensions: { match_whole_words: false } }).match_whole_words).toBe(false);
    expect(toTriggerableEntry({}).match_whole_words).toBeUndefined();
  });

  it('useProbability=false 时不做概率判定', () => {
    expect(toTriggerableEntry({ extensions: { probability: 0, useProbability: false } }).probability).toBeUndefined();
    expect(toTriggerableEntry({ extensions: { probability: 30, useProbability: true } }).probability).toBe(30);
  });

  it('enabled / constant 缺省值与导出卡一致', () => {
    const mapped = toTriggerableEntry({});
    expect(mapped.enabled).toBe(true);
    expect(mapped.constant).toBe(false);
  });
});

describe('evaluateCardLorebook', () => {
  it('绿灯条目在关键词出现时被激活，并报告命中的关键词', () => {
    const card = bookCard([greenEntry()]);
    const result = evaluateCardLorebook(card, [{ role: 'user', content: '我们去禁林看看' }]);
    expect(result.activated).toHaveLength(1);
    expect(result.activated[0].reason).toBe('keyword');
    expect(result.activated[0].matchedKeys).toEqual(['禁林']);
    expect(result.skipped).toHaveLength(0);
  });

  it('关键词没出现时记为 no-match，供 UI 解释绿灯为什么不亮', () => {
    const card = bookCard([greenEntry()]);
    const result = evaluateCardLorebook(card, [{ role: 'user', content: '今天天气不错' }]);
    expect(result.activated).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('no-match');
  });

  it('禁用条目记为 disabled', () => {
    const card = bookCard([greenEntry({ enabled: false })]);
    const result = evaluateCardLorebook(card, [{ role: 'user', content: '禁林' }]);
    expect(result.skipped[0].reason).toBe('disabled');
  });

  it('绿灯条目没有关键词时记为 no-keys', () => {
    const card = bookCard([greenEntry({ keys: [] })]);
    const result = evaluateCardLorebook(card, [{ role: 'user', content: '禁林' }]);
    expect(result.skipped[0].reason).toBe('no-keys');
  });

  it('AND ALL（ST 数值 3）要求次要关键词全部命中', () => {
    const entry = greenEntry({
      secondary_keys: ['夜晚', '月光'],
      extensions: { selectiveLogic: 3 },
    });
    const partial = evaluateCardLorebook(bookCard([entry]), [{ role: 'user', content: '夜晚的禁林' }]);
    expect(partial.skipped[0]?.reason).toBe('secondary-logic');

    const full = evaluateCardLorebook(bookCard([entry]), [{ role: 'user', content: '夜晚月光下的禁林' }]);
    expect(full.activated).toHaveLength(1);
  });

  it('没有做 ST→UI 映射就会把 AND ALL 误判成 NOT ALL（回归保护）', () => {
    // 引擎的 UI 索引 2 = NOT ALL：只命中一个次要关键词反而会放行。
    // 这条断言锁住「映射存在」——若映射被摘掉，上一个用例的 partial 会变成 activated。
    const entry = greenEntry({ secondary_keys: ['夜晚', '月光'], extensions: { selectiveLogic: 3 } });
    expect(toTriggerableEntry(entry).selectiveLogic).toBe(1);
  });

  it('概率为 0 的条目记为 probability', () => {
    const entry = greenEntry({ extensions: { probability: 0, useProbability: true } });
    const result = evaluateCardLorebook(bookCard([entry]), [{ role: 'user', content: '禁林' }]);
    expect(result.skipped[0].reason).toBe('probability');
  });

  it('character_book.scan_depth 决定扫描窗口', () => {
    const messages = [
      { role: 'user', content: '禁林' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    const entry = greenEntry({ extensions: { selectiveLogic: 0 } }); // 无条目级 depth
    const shallow = evaluateCardLorebook(bookCard([entry], { scan_depth: 2 }), messages);
    expect(shallow.activated).toHaveLength(0);
    const deep = evaluateCardLorebook(bookCard([entry], { scan_depth: 10 }), messages);
    expect(deep.activated).toHaveLength(1);
  });

  it('没有世界书时返回空结果', () => {
    const result = evaluateCardLorebook(makeCard({ character_book: undefined }) as never, []);
    expect(result).toEqual({ activated: [], skipped: [] });
  });
});

describe('buildSystemPromptWithTriggers', () => {
  it('绿灯条目命中后其内容进入系统提示词', () => {
    const card = bookCard([greenEntry()]);
    const { prompt, triggers } = buildSystemPromptWithTriggers(card, [
      { role: 'user', content: '带我去禁林' },
    ]);
    expect(prompt).toContain('废弃塔楼');
    expect(triggers.activated).toHaveLength(1);
  });

  it('不传消息时绿灯不触发（等价于旧的「只塞蓝灯」行为）', () => {
    const card = bookCard([greenEntry()]);
    expect(buildSystemPrompt(card)).not.toContain('废弃塔楼');
  });

  it('激活条目按 insertion_order 升序注入', () => {
    const card = bookCard([
      greenEntry({ id: 1, keys: ['甲'], content: 'LATER', insertion_order: 90 }),
      greenEntry({ id: 2, keys: ['乙'], content: 'EARLIER', insertion_order: 10 }),
    ]);
    const prompt = buildSystemPrompt(card, [{ role: 'user', content: '甲和乙' }]);
    expect(prompt.indexOf('EARLIER')).toBeLessThan(prompt.indexOf('LATER'));
  });

  it('蓝灯条目无论有没有消息都注入', () => {
    const card = bookCard([greenEntry({ constant: true, keys: [], content: '常驻设定' })]);
    expect(buildSystemPrompt(card)).toContain('常驻设定');
  });
});

describe('buildPostHistoryInstructions', () => {
  it('有 post_history_instructions 时返回内容', () => {
    const card = makeCard({ post_history_instructions: '请保持角色一致。' }) as never;
    const result = buildPostHistoryInstructions(card);
    expect(result).toBe('请保持角色一致。');
  });

  it('无 post_history_instructions 时返回空字符串', () => {
    const card = makeCard({ post_history_instructions: '' }) as never;
    const result = buildPostHistoryInstructions(card);
    expect(result).toBe('');
  });

  it('只有空白的 post_history_instructions 返回空字符串', () => {
    const card = makeCard({ post_history_instructions: '   \n  ' }) as never;
    const result = buildPostHistoryInstructions(card);
    expect(result).toBe('');
  });
});
