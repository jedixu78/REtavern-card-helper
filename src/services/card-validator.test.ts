import { describe, it, expect } from 'vitest';
import { validateCard, validateCardHardFails, hasHardFails } from './card-validator';
import type { LorebookEntry } from '../constants/defaults';
import { createEmptyLorebookEntry, REGEX_SCRIPT_NAMES } from '../constants/defaults';

function makeValidCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '测试角色',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '你好，旅行者。',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['测试'],
      creator: '',
      character_version: '1.0',
      extensions: {},
      character_book: {
        name: '测试世界书',
        description: '',
        scan_depth: 200,
        token_budget: 1500,
        recursive_scanning: false,
        extensions: {},
        entries: [],
      },
    },
    ...overrides,
  };
}

function makeEntry(overrides: Partial<LorebookEntry> = {}): Record<string, unknown> {
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
    position: 'after_char',
    priority: 0,
    case_sensitive: false,
    use_regex: false,
    ...overrides,
  };
}

describe('validateCard', () => {
  it('有效卡片通过验证（无错误）', () => {
    const result = validateCard(makeValidCard());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('缺少 spec 时报错', () => {
    const result = validateCard(makeValidCard({ spec: 'wrong' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('缺少 spec: "chara_card_v2" 或 "chara_card_v3"');
  });

  it('缺少 spec_version 时报错', () => {
    const result = validateCard(makeValidCard({ spec_version: '1.0' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('缺少 spec_version: "2.0" 或 "3.0"');
  });

  it('缺少 data 对象时报错并提前返回', () => {
    const result = validateCard({ spec: 'chara_card_v2', spec_version: '2.0' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('缺少 data 对象');
  });

  it('name 为空时报错', () => {
    const card = makeValidCard();
    (card.data as Record<string, unknown>).name = '';
    const result = validateCard(card);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('first_mes 为空时产生警告', () => {
    const card = makeValidCard();
    (card.data as Record<string, unknown>).first_mes = '';
    const result = validateCard(card);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('first_mes'))).toBe(true);
  });

  it('alternate_greetings 不是数组时警告', () => {
    const card = makeValidCard();
    (card.data as Record<string, unknown>).alternate_greetings = 'not-array';
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('alternate_greetings'))).toBe(true);
  });

  it('extensions 不是对象时报错', () => {
    const card = makeValidCard();
    (card.data as Record<string, unknown>).extensions = 'string';
    const result = validateCard(card);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('extensions'))).toBe(true);
  });

  it('世界书条目空内容时警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [makeEntry({ content: '' })];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('内容为空'))).toBe(true);
  });

  it('非蓝灯条目缺触发词时警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [makeEntry({ keys: [], constant: false })];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('触发关键词'))).toBe(true);
  });

  it('单字符触发词时警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [makeEntry({ keys: ['a'], constant: false })];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('单字符触发词'))).toBe(true);
  });

  it('selective 无 secondary_keys 时警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [makeEntry({ selective: true, secondary_keys: [], constant: false })];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('selective'))).toBe(true);
  });

  it('所有条目禁用时警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [makeEntry({ enabled: false }), makeEntry({ enabled: false })];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('禁用状态'))).toBe(true);
  });

  it('probability 为 0 的启用条目警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [makeEntry({ extensions: { probability: 0 } })];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('probability'))).toBe(true);
  });

  it('无效 position 时警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [makeEntry({ position: 'invalid_pos' as never })];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('position'))).toBe(true);
  });

  it('MVU 未启用时不产生 MVU 相关警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [{ ...makeEntry(), name: '[InitVar]请勿打开', content: '' }];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('MVU'))).toBe(false);
  });

  it('MVU 启用但缺少 InitVar 时警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).mvu_enabled = true;
    const charBook = data.character_book as Record<string, unknown>;
    // 放一个 MVU 条目（变量更新规则）但不放 InitVar，触发缺失警告
    charBook.entries = [{ ...makeEntry(), name: '[mvu_update]变量更新规则', comment: '[mvu_update]变量更新规则', content: 'rules: []', constant: true }];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('[InitVar]'))).toBe(true);
  });

  it('空内容条目超过 3 条时产生清理警告', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [
      makeEntry({ content: '', name: '条目1', comment: '条目1' }),
      makeEntry({ content: '', name: '条目2', comment: '条目2' }),
      makeEntry({ content: '', name: '条目3', comment: '条目3' }),
      makeEntry({ content: '', name: '条目4', comment: '条目4' }),
    ];
    const result = validateCard(card);
    expect(result.warnings.some((w) => w.includes('空内容'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 硬失败校验层（validateCardHardFails）
// ════════════════════════════════════════════════════════════════════════════

describe('validateCardHardFails', () => {
  it('有效卡片无硬失败', () => {
    expect(validateCardHardFails(makeValidCard())).toHaveLength(0);
    expect(hasHardFails(makeValidCard())).toBe(false);
  });

  it('世界书名与 extensions.world 不一致时硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).world = '另一个世界书';
    const fails = validateCardHardFails(card);
    expect(fails.some((f) => f.code === 'book_name_mismatch')).toBe(true);
    expect(hasHardFails(card)).toBe(true);
  });

  it('世界书名一致时不报硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).world = charBook.name;
    expect(validateCardHardFails(card).some((f) => f.code === 'book_name_mismatch')).toBe(false);
  });

  it('调度条目 getWorldInfo 书名与世界书名不一致时硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [
      {
        ...makeEntry(),
        name: '分阶段调度',
        content: `<%= await getWorldInfo("错误书名", "人设分阶段：朋友") _%>`,
      },
    ];
    const fails = validateCardHardFails(card);
    expect(fails.some((f) => f.code === 'dispatcher_book_name_mismatch')).toBe(true);
  });

  it('调度条目 getWorldInfo 书名与世界书名一致时不报硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [
      {
        ...makeEntry(),
        name: '分阶段调度',
        content: `<%= await getWorldInfo("测试世界书", "人设分阶段：朋友") _%>`,
      },
    ];
    expect(validateCardHardFails(card).some((f) => f.code === 'dispatcher_book_name_mismatch')).toBe(false);
  });

  it('MVU 启用但缺 [InitVar] 条目时硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).mvu_enabled = true;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [{ ...makeEntry(), name: '[mvu_update]变量更新规则', content: 'rules: []' }];
    const fails = validateCardHardFails(card);
    expect(fails.some((f) => f.code === 'mvu_missing_initvar')).toBe(true);
  });

  it('MVU 启用且 [InitVar] 内容为空时硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).mvu_enabled = true;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [{ ...makeEntry(), name: '[InitVar]请勿打开', content: '   ' }];
    expect(validateCardHardFails(card).some((f) => f.code === 'mvu_missing_initvar')).toBe(true);
  });

  it('MVU 未启用时不检查 [InitVar]', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [{ ...makeEntry(), name: '[InitVar]请勿打开', content: '' }];
    expect(validateCardHardFails(card).some((f) => f.code === 'mvu_missing_initvar')).toBe(false);
  });

  it('MVU 变量路径含 __proto__ 时硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).mvu_enabled = true;
    const charBook = data.character_book as Record<string, unknown>;
    charBook.entries = [
      {
        ...makeEntry(),
        name: '[InitVar]请勿打开',
        content: 'stat_data:\n  __proto__:\n    bad: true',
      },
    ];
    const fails = validateCardHardFails(card);
    expect(fails.some((f) => f.code === 'mvu_forbidden_path')).toBe(true);
  });

  it('正则脚本名缺少「界面」后缀时硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).regex_scripts = [
      { scriptName: '状态栏', replaceString: '<div></div>' },
    ];
    const fails = validateCardHardFails(card);
    expect(fails.some((f) => f.code === 'regex_script_name_typo')).toBe(true);
  });

  it('正则脚本名正确时不报硬失败', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).regex_scripts = [
      { scriptName: REGEX_SCRIPT_NAMES.statusBar, replaceString: '<div></div>' },
      { scriptName: REGEX_SCRIPT_NAMES.liveChat, replaceString: '<div></div>' },
    ];
    expect(validateCardHardFails(card).some((f) => f.code === 'regex_script_name_typo')).toBe(false);
  });

  it('第三方正则脚本名不受影响', () => {
    const card = makeValidCard();
    const data = card.data as Record<string, unknown>;
    (data.extensions as Record<string, unknown>).regex_scripts = [
      { scriptName: '第三方美化脚本', replaceString: '<div></div>' },
    ];
    expect(validateCardHardFails(card).some((f) => f.code === 'regex_script_name_typo')).toBe(false);
  });
});
