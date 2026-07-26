import { describe, it, expect } from 'vitest';
import { assembleCard, cardToDraft } from './card-exporter';
import { findStagedLorebookEntryIndices } from './lorebook-predicates';
import { createEmptyDraft, createEmptyLorebookEntry, createEmptyCharacter } from '../constants/defaults';
import type { WizardDraft, LorebookEntry } from '../constants/defaults';
import { generateLiveChatHtml } from './live-chat-templates';

function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return { ...createEmptyDraft(), ...overrides };
}

describe('match_whole_words 往返 (B3)', () => {
  it('显式 null（继承 ST 默认）往返后仍为 null，不被翻成 true', () => {
    const draft = makeDraft({
      cardName: 'T',
      lorebookEntries: [{ ...createEmptyLorebookEntry(), comment: 'E', name: 'E' }],
    });
    const card = assembleCard(draft) as unknown as {
      data: { character_book: { entries: Array<{ extensions: Record<string, unknown> }> } };
    };
    // 模拟外部卡片显式声明 inherit（null）
    card.data.character_book.entries[0].extensions.match_whole_words = null;
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    const entry = restored.lorebookEntries.find((e) => e.comment === 'E');
    expect(entry?.match_whole_words).toBeNull();
  });
});

describe('appendPlaceholders 关闭功能时移除占位符 (B4)', () => {
  it('移除残留占位符但不折叠正文的段落空行', () => {
    const draft = makeDraft({
      cardName: 'T',
      firstMessage: 'Intro\n\n<StatusPlaceHolderImpl/>\n\nMore',
    });
    const card = assembleCard(draft) as unknown as { data: { first_mes: string } };
    const fm = card.data.first_mes;
    expect(fm).not.toContain('<StatusPlaceHolderImpl/>');
    expect(fm).toContain('Intro');
    expect(fm).toContain('More');
    expect(fm).not.toBe('Intro\nMore'); // 不应被压成单行
    expect(fm).toMatch(/Intro\n\n[\s\S]*More/); // 段落空行保留
  });
});

describe('assembleCard', () => {
  it('生成符合 V3 spec 的卡片结构', () => {
    const draft = makeDraft({ cardName: '测试角色' });
    const card = assembleCard(draft);
    expect(card.spec).toBe('chara_card_v3');
    expect(card.spec_version).toBe('3.0');
    expect(card.data.name).toBe('测试角色');
  });

  it('extensions.world 与 character_book.name 一致', () => {
    const draft = makeDraft({ cardName: '测试角色' });
    const card = assembleCard(draft);
    expect(card.data.extensions.world).toBe(card.data.character_book.name);
  });

  it('卡片名称作为顶层 name 和 data.name', () => {
    const draft = makeDraft({ cardName: '银帷骑士' });
    const card = assembleCard(draft);
    expect(card.name).toBe('银帷骑士');
    expect(card.data.name).toBe('银帷骑士');
  });

  it('包含 character_book 且 entries 为数组', () => {
    const draft = makeDraft({ cardName: '测试' });
    const card = assembleCard(draft);
    expect(card.data.character_book).toBeDefined();
    expect(Array.isArray(card.data.character_book.entries)).toBe(true);
  });

  it('世界书条目按 insertion_order 排序', () => {
    const e1 = { ...createEmptyLorebookEntry(), insertion_order: 3, comment: 'C', name: 'C' };
    const e2 = { ...createEmptyLorebookEntry(), insertion_order: 1, comment: 'A', name: 'A' };
    const e3 = { ...createEmptyLorebookEntry(), insertion_order: 2, comment: 'B', name: 'B' };
    const draft = makeDraft({ cardName: '测试', lorebookEntries: [e1, e2, e3] });
    const card = assembleCard(draft);
    const entries = card.data.character_book.entries;
    expect(entries[0].comment).toBe('A');
    expect(entries[1].comment).toBe('B');
    expect(entries[2].comment).toBe('C');
  });

  it('MVU 未启用时不导出 MVU 相关条目', () => {
    const draft = makeDraft({ cardName: '测试' });
    const card = assembleCard(draft);
    const entries = card.data.character_book.entries;
    const mvuNames = entries.filter((e) =>
      ['[InitVar]请勿打开', '[mvu_update]变量更新规则', 'MVU 变量列表', 'MVU 变量输出格式', 'EJS预处理'].includes(e.name),
    );
    expect(mvuNames).toHaveLength(0);
  });

  it('first_mes 在 MVU 启用时包含状态栏占位符', () => {
    const draft = makeDraft({
      cardName: '测试',
      firstMessage: '你好。',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '<div>状态栏</div>',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    expect(card.data.first_mes).toContain('<StatusPlaceHolderImpl/>');
  });

  it('状态栏 HTML 导出时保留 ```html 围栏（SillyTavern 需要围栏才执行脚本）', () => {
    const draft = makeDraft({
      cardName: '测试',
      firstMessage: '你好。',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{ name: '测试', variables: [{ path: '测试.值', zodType: 'z.coerce.number()', description: '', prefix: '', initialValue: 0 }] }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '...',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '<div>状态栏</div>',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    const scripts = ((card.data.extensions as unknown as Record<string, unknown>).regex_scripts as Array<Record<string, unknown>>);
    const render = scripts.find((s) => s.scriptName === '状态栏界面');
    expect(String(render?.replaceString)).toMatch(/^```html/i);
  });

  it('直播间面板会注入独立占位符并导出界面/AI双正则', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: ['测试评论'] });
    const draft = makeDraft({
      cardName: '直播测试',
      firstMessage: '开播。',
      liveStreamChat: {
        enabled: true,
        html,
        themeId: 'terminal',
        title: '测试直播间',
        maxVisible: 10,
        initialComments: ['测试评论'],
      },
    });
    const card = assembleCard(draft);
    expect(card.data.first_mes).toContain('<LiveStreamChatImpl/>');
    const scripts = ((card.data.extensions as unknown as Record<string, unknown>).regex_scripts as Array<Record<string, unknown>>);
    const render = scripts.find((s) => s.scriptName === '直播间界面');
    const hide = scripts.find((s) => s.scriptName === '对AI隐藏直播间');
    expect(render?.findRegex).toBe('<LiveStreamChatImpl/>');
    // 导出时保留 ```html 围栏：SillyTavern 只在 ```html 代码块中执行 <script type="module">
    expect(String(render?.replaceString)).toMatch(/^```html/i);
    expect(String(render?.replaceString)).toContain('lc-root');
    expect(hide?.promptOnly).toBe(true);
  });

  it('first_mes 在 MVU 未启用时不包含状态栏占位符', () => {
    const draft = makeDraft({ cardName: '测试', firstMessage: '你好。' });
    const card = assembleCard(draft);
    expect(card.data.first_mes).not.toContain('<StatusPlaceHolderImpl/>');
  });

  it('existingId 被保留在卡片中', () => {
    const draft = makeDraft({ cardName: '测试' });
    const card = assembleCard(draft, 42);
    expect(card.id).toBe(42);
  });

  it('无 existingId 时卡片不含 id', () => {
    const draft = makeDraft({ cardName: '测试' });
    const card = assembleCard(draft);
    expect(card.id).toBeUndefined();
  });

  it('creator_notes 为空时使用默认值', () => {
    const draft = makeDraft({ cardName: '测试', creator_notes: '' });
    const card = assembleCard(draft);
    expect(card.data.creator_notes).toContain('吟游手册');
  });

  it('_meta 包含角色信息', () => {
    const char = { ...createEmptyCharacter(), name: '角色1', description: '描述' };
    const draft = makeDraft({ cardName: '测试', characters: [char] });
    const card = assembleCard(draft);
    expect(card._meta.characters).toHaveLength(1);
    expect(card._meta.characters[0].name).toBe('角色1');
  });

  it('_meta 中的 entryIds 剔除已不存在的条目，并映射成导出后的条目 id', () => {
    // 导出会把条目 id 重排成 1..N；_meta 必须存重排后的 id，否则重新打开卡时
    // entryIds 与 lorebookEntries 永远对不上（角色「已同步」判定与 id 复用双双失效）
    const entry = createEmptyLorebookEntry();
    const char = { ...createEmptyCharacter(), name: '角色1', description: '描述', entryIds: [entry.id, 'deleted-id'] };
    const draft = makeDraft({ cardName: '测试', characters: [char], lorebookEntries: [entry] });
    const card = assembleCard(draft);
    expect(card._meta.characters[0].entryIds).toEqual(['1']);
    expect(card.data.character_book.entries[0].id).toBe(1);
  });

  it('_meta 的 entryIds 在世界锚 unshift 重编号后仍指向正确条目', () => {
    const entry = { ...createEmptyLorebookEntry(), name: 'E', comment: 'E', content: 'c', keys: ['k'] };
    const char = { ...createEmptyCharacter(), name: '角色1', description: '描述', entryIds: [entry.id] };
    const draft = makeDraft({
      cardName: '测试',
      characters: [char],
      lorebookEntries: [entry],
      worldAnchor: { era: '近未来', coreRules: '无超能力', hardConstraints: '', tone: '' },
    });
    const card = assembleCard(draft);
    const mappedId = card._meta.characters[0].entryIds[0];
    const target = card.data.character_book.entries.find((e) => String(e.id) === mappedId);
    expect(target?.name).toBe('E');
  });

  it('从 _meta 恢复时，数字型 id/entryIds 会被规范化为字符串', () => {
    const card = assembleCard(makeDraft({ cardName: '测试' }));
    card._meta = {
      characters: [{
        id: 123,
        name: 'Alice',
        description: '描述',
        entryIds: [1, 2],
      }],
    } as unknown as typeof card._meta;
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.characters[0].id).toBe('123');
    expect(restored.characters[0].entryIds).toEqual(['1', '2']);
  });

  it('tags 被正确导出', () => {
    const draft = makeDraft({ cardName: '测试', tags: ['奇幻', '冒险'] });
    const card = assembleCard(draft);
    expect(card.data.tags).toEqual(['奇幻', '冒险']);
  });

  it('alternate_greetings 被正确导出', () => {
    const draft = makeDraft({ cardName: '测试', alternate_greetings: ['问候1', '问候2'] });
    const card = assembleCard(draft);
    expect(card.data.alternate_greetings).toEqual(['问候1', '问候2']);
  });

  it('启用直播间面板时 alternate_greetings 也追加占位符', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: ['测试评论'] });
    const draft = makeDraft({
      cardName: '测试',
      alternate_greetings: ['问候1', '问候2'],
      liveStreamChat: {
        enabled: true,
        html,
        themeId: 'terminal',
        title: '直播间',
        maxVisible: 10,
        initialComments: ['测试评论'],
      },
    });
    const card = assembleCard(draft);
    expect(card.data.alternate_greetings[0]).toContain('<LiveStreamChatImpl/>');
    expect(card.data.alternate_greetings[1]).toContain('<LiveStreamChatImpl/>');
  });

  it('MVU 未启用但直播间启用时创建直播间面板规则世界书条目', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: ['测试评论'] });
    const draft = makeDraft({
      cardName: '测试',
      firstMessage: '开播。',
      liveStreamChat: {
        enabled: true,
        html,
        themeId: 'terminal',
        title: '直播间',
        maxVisible: 10,
        initialComments: ['测试评论'],
      },
    });
    const card = assembleCard(draft);
    const ruleEntry = card.data.character_book.entries.find((e: { name?: string; content?: string }) => e.name === '直播间面板规则');
    expect(ruleEntry).toBeDefined();
    expect(ruleEntry?.content).toContain('<live_chat_rule>');
    expect(ruleEntry?.constant).toBe(true);
  });

  it('MVU 启用且直播间启用时 variableOutputFormat 包含 live_chat_rule', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: ['测试评论'] });
    const draft = makeDraft({
      cardName: '测试',
      firstMessage: '开播。',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{ name: '测试', variables: [{ path: '测试.值', zodType: 'z.coerce.number()', description: '', prefix: '', initialValue: 0 }] }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '...',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: 'none',
      },
      liveStreamChat: {
        enabled: true,
        html,
        themeId: 'terminal',
        title: '直播间',
        maxVisible: 10,
        initialComments: ['测试评论'],
      },
    });
    const card = assembleCard(draft);
    const outputFormat = card.data.character_book.entries.find((e: { name?: string; content?: string }) => e.name === 'MVU 变量输出格式');
    expect(outputFormat).toBeDefined();
    expect(outputFormat?.content).toContain('<live_chat_rule>');
  });
});

describe('cardToDraft', () => {
  it('往返一致：assembleCard → cardToDraft 保留 cardName', () => {
    const draft = makeDraft({ cardName: '往返测试', firstMessage: '开场白' });
    const card = assembleCard(draft);
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.cardName).toBe('往返测试');
    expect(restored.firstMessage).toBe('开场白');
  });

  it('往返一致：保留 tags', () => {
    const draft = makeDraft({ cardName: '测试', tags: ['标签1', '标签2'] });
    const card = assembleCard(draft);
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.tags).toEqual(['标签1', '标签2']);
  });

  it('往返一致：保留 scenario', () => {
    const draft = makeDraft({ cardName: '测试', scenario: '场景描述' });
    const card = assembleCard(draft);
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.scenario).toBe('场景描述');
  });

  it('往返一致：保留 lorebook 条目数量', () => {
    const entries = [
      { ...createEmptyLorebookEntry(), comment: '条目1', name: '条目1', content: '内容1', keys: ['词1'] },
      { ...createEmptyLorebookEntry(), comment: '条目2', name: '条目2', content: '内容2', keys: ['词2'] },
    ];
    const draft = makeDraft({ cardName: '测试', lorebookEntries: entries });
    const card = assembleCard(draft);
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.lorebookEntries).toHaveLength(2);
  });

  it('从 _meta 恢复角色信息', () => {
    const char = { ...createEmptyCharacter(), name: '艾莉亚', description: '精灵游侠' };
    const draft = makeDraft({ cardName: '测试', characters: [char] });
    const card = assembleCard(draft);
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.characters).toHaveLength(1);
    expect(restored.characters[0].name).toBe('艾莉亚');
  });

  it('MVU 未启用的卡片不恢复 mvu config', () => {
    const draft = makeDraft({ cardName: '测试' });
    const card = assembleCard(draft);
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.mvu).toBeUndefined();
  });

  it('bookScanDepth 和 bookTokenBudget 被保留', () => {
    const draft = makeDraft({ cardName: '测试', bookScanDepth: 300, bookTokenBudget: 2000 });
    const card = assembleCard(draft);
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.bookScanDepth).toBe(300);
    expect(restored.bookTokenBudget).toBe(2000);
  });

  it('缺少 _meta.characters 时，从角色设定条目重建角色后不会保留重复条目', () => {
    const roleEntry = { ...createEmptyLorebookEntry(), name: 'Alice - 角色设定', content: '描述', constant: true };
    const otherEntry = { ...createEmptyLorebookEntry(), name: '其他', content: '内容' };
    const draft = makeDraft({ cardName: '测试', lorebookEntries: [roleEntry, otherEntry] });
    const card = assembleCard(draft);
    const cardWithoutMeta = { ...card, _meta: {} };
    const restored = cardToDraft(cardWithoutMeta as unknown as Record<string, unknown>);
    expect(restored.characters).toHaveLength(1);
    expect(restored.characters[0].name).toBe('Alice');
    expect(restored.lorebookEntries).toHaveLength(1);
    expect(restored.lorebookEntries[0].name).toBe('其他');
  });

  it('往返后世界书条目和角色 entryIds 保持字符串类型', () => {
    const entries = [
      { ...createEmptyLorebookEntry(), comment: '条目1', name: '条目1', content: '内容1', keys: ['词1'] },
      { ...createEmptyLorebookEntry(), comment: '条目2', name: '条目2', content: '内容2', keys: ['词2'] },
    ];
    const draft = makeDraft({ cardName: '测试', lorebookEntries: entries });
    const card = assembleCard(draft);
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.lorebookEntries.every((e) => typeof e.id === 'string')).toBe(true);
  });
});

// ── S2-3: mes_example 全链路 ────────────────────────────────────────────────
describe('mes_example 全链路 (S2-3)', () => {
  it('createEmptyDraft 提供 mes_example 默认值', () => {
    expect(createEmptyDraft().mes_example).toBe('');
  });

  it('assembleCard 导出 data.mes_example', () => {
    const example = '<START>\n{{user}}: 你好\n{{char}}: 你好呀，旅行者。';
    const card = assembleCard(makeDraft({ cardName: '测试', mes_example: example }));
    expect(card.data.mes_example).toBe(example);
  });

  it('mes_example 为空时导出空字符串而非 undefined（V2/V3 规范字段必须存在）', () => {
    const card = assembleCard(makeDraft({ cardName: '测试' }));
    expect(card.data.mes_example).toBe('');
  });

  it('cardToDraft 读回 ST 卡的 mes_example，不再静默丢弃', () => {
    const stCard = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'ST 卡',
        first_mes: '你好。',
        mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
        extensions: {},
      },
    };
    const restored = cardToDraft(stCard as unknown as Record<string, unknown>);
    expect(restored.mes_example).toBe('<START>\n{{user}}: hi\n{{char}}: hello');
  });

  it('cardToDraft 读回 V1 卡（顶层 mes_example）', () => {
    const v1Card = { name: 'V1 卡', first_mes: '你好。', mes_example: '<START>\nA: x' };
    const restored = cardToDraft(v1Card as unknown as Record<string, unknown>);
    expect(restored.mes_example).toBe('<START>\nA: x');
  });

  it('往返一致：assembleCard → cardToDraft 保留 mes_example', () => {
    const example = '<START>\n{{user}}: 往返\n{{char}}: 测试';
    const card = assembleCard(makeDraft({ cardName: '往返', mes_example: example }));
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.mes_example).toBe(example);
    // 二次往返仍稳定
    const card2 = assembleCard(makeDraft({ ...restored }));
    expect(card2.data.mes_example).toBe(example);
  });
});

// ── S3: description / personality 归一化丢失修复 ────────────────────────────
describe('description/personality 保真 (S3)', () => {
  it('createEmptyDraft 提供 personality 默认值', () => {
    expect(createEmptyDraft().personality).toBe('');
  });

  it('第三方卡（有描述、无匹配条目）导入→导出：description 逐字保真', () => {
    const desc = '来自北境的旅人，沉默寡言。';
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '旅人',
        description: desc,
        personality: '冷淡',
        first_mes: '……你好。',
        extensions: {},
      },
    };
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.personality).toBe('冷淡');
    const exported = assembleCard(restored);
    expect(exported.data.description).toBe(desc);
    expect(exported.data.personality).toBe('冷淡');
  });

  it('向导卡（角色已同步为世界书条目，entryIds 命中）导出 description 仍为 空', () => {
    const entry = { ...createEmptyLorebookEntry(), id: 'e1', name: '阿绫 - 角色设定', comment: '阿绫 - 角色设定', content: '阿绫的完整设定', constant: true };
    const draft = makeDraft({
      cardName: '阿绫',
      characters: [{ id: 'c1', name: '阿绫', description: '阿绫的完整设定', entryIds: ['e1'] }],
      lorebookEntries: [entry],
    });
    expect(assembleCard(draft).data.description).toBe('');
  });

  it('entryIds 失效（历史卡存的是草稿 id）时，按角色的条目覆盖率兜底判定为已同步', () => {
    // 长描述会被 syncCharacterEntries 切成「阿绫 - 角色设定」+「… (2)」，
    // 且分块用 '\n\n' 重新拼接——原文段间是 3 个换行时不再是字面子串，
    // 所以判定必须空白不敏感（isCharacterDescriptionSynced 会归一化空白）
    const chunk1 = { ...createEmptyLorebookEntry(), id: 'new-1', name: '阿绫 - 角色设定', comment: '阿绫 的角色设定', content: '阿绫的完整设定（分块一）', constant: true };
    const chunk2 = { ...createEmptyLorebookEntry(), id: 'new-2', name: '阿绫 - 角色设定 (2)', comment: '阿绫 的角色设定 (续2)', content: '阿绫的完整设定（分块二）', constant: true };
    const draft = makeDraft({
      cardName: '阿绫',
      characters: [{ id: 'c1', name: '阿绫', description: '阿绫的完整设定（分块一）\n\n\n阿绫的完整设定（分块二）', entryIds: ['stale-id'] }],
      lorebookEntries: [chunk1, chunk2],
    });
    expect(assembleCard(draft).data.description).toBe('');
  });

  it('第三方卡里恰好复述过某条世界书内容的描述不被误杀', () => {
    // 判定按角色限定候选条目：非「X - 角色设定」的条目不参与，
    // 否则「她是吸血鬼。」这种短条目会让整段描述被当成已同步而丢弃
    const entry = { ...createEmptyLorebookEntry(), name: '吸血鬼', comment: '吸血鬼', content: '她是吸血鬼。', keys: ['吸血鬼'] };
    const draft = makeDraft({
      cardName: '艾莉',
      characters: [{ id: 'c1', name: '艾莉', description: '艾莉是北境的旅人。她是吸血鬼。她讨厌大蒜。' }],
      lorebookEntries: [entry],
    });
    expect(assembleCard(draft).data.description).toBe('艾莉是北境的旅人。她是吸血鬼。她讨厌大蒜。');
  });

  it('跨角色不误伤：B 的描述引用了 A 的条目内容仍保留', () => {
    const entryA = { ...createEmptyLorebookEntry(), name: 'A - 角色设定', comment: 'A 的角色设定', content: 'A的设定', constant: true };
    const draft = makeDraft({
      cardName: '双子',
      characters: [
        { id: 'a', name: 'A', description: 'A的设定' },
        { id: 'b', name: 'B', description: 'B住在同一个村子。A的设定也适用于B。' },
      ],
      lorebookEntries: [entryA],
    });
    expect(assembleCard(draft).data.description).toBe('B住在同一个村子。A的设定也适用于B。');
  });

  it('用户改写描述后，旧条目只剩零星重合 → 判为未同步，新描述写回卡里', () => {
    const stale = { ...createEmptyLorebookEntry(), name: '小明 - 角色设定', comment: '小明 的角色设定', content: '小明是个学生。', constant: true };
    const draft = makeDraft({
      cardName: '小明',
      characters: [{ id: 'c1', name: '小明', description: '小明是个上班族，三十岁。', entryIds: ['stale'] }],
      lorebookEntries: [stale],
    });
    expect(assembleCard(draft).data.description).toBe('小明是个上班族，三十岁。');
  });

  it('多个未同步角色的描述按顺序 join', () => {
    const draft = makeDraft({
      cardName: '双子',
      characters: [
        { id: 'c1', name: '姐姐', description: '姐姐的描述' },
        { id: 'c2', name: '妹妹', description: '妹妹的描述' },
      ],
    });
    expect(assembleCard(draft).data.description).toBe('姐姐的描述\n\n妹妹的描述');
  });

  it('长描述（分块 + 段间多空行）往返导出不把内容写第二份', () => {
    // 复现「重开已保存的卡再导出 → 同一段设定在卡里存在两份」：
    // 导出把条目 id 重排成 1..N，若 _meta 仍存草稿 id，两个集合零交集
    const para = (i: number) => `第${i}段设定。`.repeat(30);
    const description = [para(1), para(2), para(3)].join('\n\n\n');
    const chunks = [para(1), para(2), para(3)].map((content, i) => ({
      ...createEmptyLorebookEntry(),
      id: `chunk-${i}`,
      name: `小明 - 角色设定${i > 0 ? ` (${i + 1})` : ''}`,
      comment: `小明 的角色设定${i > 0 ? ` (续${i + 1})` : ''}`,
      content,
      constant: true,
      keys: ['小明'],
    }));
    const draft = makeDraft({
      cardName: '小明的故事',
      characters: [{ id: 'c1', name: '小明', description, entryIds: chunks.map((c) => c.id) }],
      lorebookEntries: chunks,
    });

    const card1 = assembleCard(draft);
    expect(card1.data.description).toBe('');
    // _meta 存的是导出后的 id，与 character_book.entries 对得上
    const exportedIds = card1.data.character_book.entries.map((e) => String(e.id));
    expect(card1._meta.characters[0].entryIds.every((id) => exportedIds.includes(id))).toBe(true);

    // 往返：重新打开卡再导出，描述仍不重复写出
    const card2 = assembleCard(cardToDraft(card1 as unknown as Record<string, unknown>));
    expect(card2.data.description).toBe('');
    expect(card2._meta.characters[0].entryIds.length).toBe(3);
  });

  it('personality 往返一致：assembleCard → cardToDraft 二次往返稳定', () => {
    const card = assembleCard(makeDraft({ cardName: 'P', personality: '外冷内热' }));
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.personality).toBe('外冷内热');
    expect(assembleCard(restored).data.personality).toBe('外冷内热');
  });
});

// ── S3: 世界书名/描述保真 + 调度条目书名对齐 ────────────────────────────────
describe('世界书元数据保真 (S3)', () => {
  it('默认书名按卡名派生，extensions.world 与 character_book.name 恒相等', () => {
    const card = assembleCard(makeDraft({ cardName: '阿绫' }));
    expect(card.data.character_book.name).toBe('阿绫的世界书');
    expect((card.data.extensions as unknown as Record<string, unknown>).world).toBe('阿绫的世界书');
  });

  it('自定义书名/描述往返保真，world 跟随书名', () => {
    const card = assembleCard(makeDraft({ cardName: '阿绫', bookName: '铁与雾编年史', bookDescription: '北境世界观' }));
    expect(card.data.character_book.name).toBe('铁与雾编年史');
    expect(card.data.character_book.description).toBe('北境世界观');
    expect((card.data.extensions as unknown as Record<string, unknown>).world).toBe('铁与雾编年史');

    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.bookName).toBe('铁与雾编年史');
    expect(restored.bookDescription).toBe('北境世界观');
    const again = assembleCard(restored);
    expect(again.data.character_book.name).toBe('铁与雾编年史');
    expect(again.data.character_book.description).toBe('北境世界观');
  });

  it('派生默认形态的书名往返后仍跟随卡名（改卡名书名不卡旧值）', () => {
    const restored = cardToDraft(assembleCard(makeDraft({ cardName: '阿绫' })) as unknown as Record<string, unknown>);
    expect(restored.bookName).toBe('');
    restored.cardName = '新名字';
    expect(assembleCard(restored).data.character_book.name).toBe('新名字的世界书');
  });

  it('第三方自定义书名导入→导出逐字保真', () => {
    const card = makeThirdPartyCard() as { data: Record<string, unknown> };
    (card.data.character_book as Record<string, unknown>).name = '铁与雾编年史';
    (card.data.character_book as Record<string, unknown>).description = '第三方书描述';
    (card.data.extensions as Record<string, unknown>).world = '铁与雾编年史';
    const exported = assembleCard(cardToDraft(card as unknown as Record<string, unknown>));
    expect(exported.data.character_book.name).toBe('铁与雾编年史');
    expect(exported.data.character_book.description).toBe('第三方书描述');
    expect((exported.data.extensions as unknown as Record<string, unknown>).world).toBe('铁与雾编年史');
  });

  it('只有 extensions.world、没有 character_book.name 的卡：书名不被静默改写', () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '旅人',
        first_mes: '你好。',
        extensions: { world: '共享大世界书' },
        character_book: { entries: [] },
      },
    };
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.bookName).toBe('共享大世界书');
    const exported = assembleCard(restored);
    expect(exported.data.character_book.name).toBe('共享大世界书');
    expect((exported.data.extensions as unknown as Record<string, unknown>).world).toBe('共享大世界书');
  });

  it('character_book.name 为非字符串时不崩溃，退回按卡名派生', () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: '旅人', first_mes: 'x', extensions: {}, character_book: { name: 12345, description: null, entries: [] } },
    };
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    expect(restored.bookName).toBe('');
    expect(restored.bookDescription).toBe('');
    expect(assembleCard(restored).data.character_book.name).toBe('旅人的世界书');
  });

  it('卡名带前导空白时派生书名两侧对称，改卡名后书名仍跟随', () => {
    const card = assembleCard(makeDraft({ cardName: ' 阿绫' }));
    expect(card.data.character_book.name).toBe('阿绫的世界书');
    const restored = cardToDraft(card as unknown as Record<string, unknown>);
    // 派生形态 → 存空串，书名继续跟随卡名
    expect(restored.bookName).toBe('');
    restored.cardName = '新名';
    expect(assembleCard(restored).data.character_book.name).toBe('新名的世界书');
  });

  it('导出时分阶段调度条目的 getWorldInfo 书名对齐导出书名（阶段不切换根因）', () => {
    // 旧版调度条目：书名烤死为卡名（与导出书名「卡名的世界书」不一致 → ST 里查无此书）
    const dispatcherContent = `<%_ const __stagedRaw_测试 = getvar('stat_data.关系.阶段'); _%>
<%_ const __stagedVal_测试 = Array.isArray(__stagedRaw_测试) ? __stagedRaw_测试[0] : __stagedRaw_测试; _%>
<%_ if (__stagedVal_测试 === '朋友') { _%>
<%= await getWorldInfo("阿绫", "测试：朋友") _%>
<%_ } _%>`;
    const draft = makeDraft({
      cardName: '阿绫',
      mvu: {
        enabled: true, mode: 'expert', schemaSections: [], updateRules: [], ejsConfigs: [],
        ejsPreprocessContent: '', schemaTsContent: '...', initvarYamlContent: '', updateRulesYamlContent: '',
        statusBarHtml: '', statusBarStyle: 'compact-panel',
      },
      lorebookEntries: [
        { ...createEmptyLorebookEntry(), name: '测试-调度', comment: '测试-调度', content: dispatcherContent, constant: true },
        { ...createEmptyLorebookEntry(), name: '普通', comment: '普通', content: '<%= await getWorldInfo("公共设定书", "共享") %>', keys: ['k'] },
      ],
    });
    const entries = assembleCard(draft).data.character_book.entries;
    const dispatcher = entries.find((e) => e.name === '测试-调度');
    const plain = entries.find((e) => e.name === '普通');
    expect(dispatcher?.content).toContain('getWorldInfo("阿绫的世界书", "测试：朋友")');
    // 无调度签名的第三方 EJS 不动
    expect(plain?.content).toContain('getWorldInfo("公共设定书", "共享")');
  });
});

// ── S2-3: at_depth 位置保真 ──────────────────────────────────────────────────
describe('at_depth 位置保真 (S2-3)', () => {
  function cardWithEntryPosition(entryPosition: unknown, extPosition: unknown) {
    return {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '位置测试',
        extensions: {},
        character_book: {
          name: '书',
          entries: [{
            id: 1,
            name: '深度条目',
            content: '内容',
            keys: ['k'],
            enabled: true,
            constant: false,
            position: entryPosition,
            extensions: { position: extPosition, depth: 3 },
          }],
        },
      },
    } as unknown as Record<string, unknown>;
  }

  it('extensions.position=4 时不降级为 after_char', () => {
    const restored = cardToDraft(cardWithEntryPosition('after_char', 4));
    expect(restored.lorebookEntries[0].position).toBe('at_depth');
  });

  it('extensions.position 为字符串 at_depth 时同样识别', () => {
    const restored = cardToDraft(cardWithEntryPosition('after_char', 'at_depth'));
    expect(restored.lorebookEntries[0].position).toBe('at_depth');
  });

  it('entry.position 直接是 at_depth 字符串时保留', () => {
    const restored = cardToDraft(cardWithEntryPosition('at_depth', undefined));
    expect(restored.lorebookEntries[0].position).toBe('at_depth');
  });

  it('entry.position 是数值时也能还原', () => {
    const restored = cardToDraft(cardWithEntryPosition(4, undefined));
    expect(restored.lorebookEntries[0].position).toBe('at_depth');
  });

  it('其它数值位置按 POSITION_INDEX 反向还原', () => {
    expect(cardToDraft(cardWithEntryPosition('after_char', 0)).lorebookEntries[0].position).toBe('before_char');
    expect(cardToDraft(cardWithEntryPosition('after_char', 2)).lorebookEntries[0].position).toBe('before_author');
    expect(cardToDraft(cardWithEntryPosition('after_char', 5)).lorebookEntries[0].position).toBe('before_example');
    expect(cardToDraft(cardWithEntryPosition('after_char', 6)).lorebookEntries[0].position).toBe('after_example');
  });

  it('位置信息缺失或非法时回退 after_char', () => {
    expect(cardToDraft(cardWithEntryPosition(undefined, undefined)).lorebookEntries[0].position).toBe('after_char');
    expect(cardToDraft(cardWithEntryPosition('unknown_pos', 99)).lorebookEntries[0].position).toBe('after_char');
  });

  it('导出时 at_depth 按原值写回 extensions.position=4', () => {
    const restored = cardToDraft(cardWithEntryPosition('after_char', 4));
    const card = assembleCard(restored);
    const entry = card.data.character_book.entries[0];
    expect(entry.position).toBe('at_depth');
    expect((entry.extensions as Record<string, unknown>).position).toBe(4);
  });

  it('往返不改变普通 after_char 条目的位置', () => {
    const draft = makeDraft({
      cardName: '测试',
      lorebookEntries: [{ ...createEmptyLorebookEntry(), name: 'E', comment: 'E', content: 'c', keys: ['k'] }],
    });
    const restored = cardToDraft(assembleCard(draft) as unknown as Record<string, unknown>);
    expect(restored.lorebookEntries[0].position).toBe('after_char');
  });
});

// ── S2-3: 导入字段直通层 (passthrough) ───────────────────────────────────────
//
// 第三方卡「导入 → 无修改 → 导出」应逐字段等价。fixture 里本工具「拥有」的字段
// 已按本工具的规范形态书写（否则失败原因与直通层无关），本工具会强制归一化的字段：
//   - data.description：仅当角色描述已同步进世界书条目时归一化为 ''；
//     未同步的导入描述会写回（S3 保真修复），personality 走往返直通
//   - character_book.name / description：S3 起保真——自定义书名/描述原样保留，
//     仅「派生默认形态」（卡名的世界书）跟随卡名；extensions.world 恒等于书名
//   - 条目 id 重排为 1..N、extensions.display_index 重排为数组下标
function makeThirdPartyCard() {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: '第三方角色',
      description: '第三方角色的原始描述：一位来自北境的旅人。',
      personality: '傲娇但心软，嘴上不饶人。',
      scenario: '一个第三方场景',
      first_mes: '你好，我是第三方卡。',
      mes_example: '<START>\n{{user}}: 你好\n{{char}}: 你好呀',
      creator_notes: '第三方作者备注',
      system_prompt: '第三方系统提示',
      post_history_instructions: '第三方历史后指令',
      alternate_greetings: ['另一个开场白'],
      tags: ['第三方', '测试'],
      creator: '第三方作者',
      character_version: '2.1',

      // ── V3 规范 / 第三方工具的字段：本工具不认识，必须原样保留 ──
      nickname: '小三',
      group_only_greetings: ['组队开场白'],
      creation_date: 1700000000,
      assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],

      character_book: {
        name: '第三方角色的世界书',
        description: '',
        scan_depth: 100,
        token_budget: 800,
        recursive_scanning: true,
        extensions: { book_level_custom: 'keep-me' },
        custom_book_field: '书级未知字段',
        entries: [{
          id: 1,
          keys: ['关键词'],
          secondary_keys: ['次要词'],
          content: '第三方条目内容',
          name: '第三方条目',
          enabled: true,
          insertion_order: 10,
          case_sensitive: false,
          selective: true,
          constant: false,
          position: 'after_char',
          priority: 30,
          comment: '第三方条目',
          use_regex: false,
          // 条目根层级未知字段
          third_party_flag: true,
          extensions: {
            position: 1,
            probability: 80,
            // 第三方卡显式关闭了概率判定；本工具恒写 true 且无 UI 入口，
            // 必须以卡里的值为准，否则往返后条目会被翻转成按概率触发
            useProbability: false,
            group: '组A',
            group_override: false,
            group_weight: 70,
            selectiveLogic: 0,
            role: 0,
            depth: 4,
            scan_depth: 4,
            exclude_recursion: false,
            prevent_recursion: false,
            // 本工具写死常量、无 UI 入口 → 以导入值为准
            delay_until_recursion: 3,
            automation_id: 'my-automation',
            vectorized: true,
            use_probability: false,
            match_whole_words: null,
            use_group_scoring: false,
            case_sensitive: null,
            sticky: 2,
            cooldown: 1,
            delay: 5,
            match_persona_description: false,
            match_character_description: false,
            match_character_personality: false,
            match_character_depth_prompt: false,
            match_scenario: false,
            match_creator_notes: false,
            triggers: [],
            ignore_budget: false,
            outlet_name: '',
            display_index: 0,
            // 条目 extensions 里的未知字段
            third_party_ext: 'keep',
          },
        }],
      },

      extensions: {
        // 真实内容的 depth_prompt（本工具只会写空占位，导入值必须胜出）
        depth_prompt: { prompt: '你要牢记设定', depth: 2, role: 'system' },
        talkativeness: '0.7',
        fav: true,
        third_party_tool: { version: 3, note: '自定义扩展' },
        regex_scripts: [{
          id: 'tp-1',
          scriptName: '第三方美化脚本',
          findRegex: '/foo/g',
          replaceString: '<b>foo</b>',
          placement: [2],
          disabled: false,
          markdownOnly: true,
          promptOnly: false,
        }],
        world: '第三方角色的世界书',
      },
    },
  } as unknown as Record<string, unknown>;
}

describe('导入字段直通层 passthrough (S2-3)', () => {
  it('核心验收：第三方卡「导入 → 无修改 → 导出」data 逐字段等价', () => {
    const original = makeThirdPartyCard();
    const exported = assembleCard(cardToDraft(original));
    expect(exported.data).toEqual((original as { data: unknown }).data);
  });

  it('保留 data 层未知字段（V3 assets / nickname / group_only_greetings 等）', () => {
    const draft = cardToDraft(makeThirdPartyCard());
    expect(draft._passthrough?.data).toMatchObject({
      nickname: '小三',
      group_only_greetings: ['组队开场白'],
      creation_date: 1700000000,
    });
    const data = assembleCard(draft).data as unknown as Record<string, unknown>;
    expect(data.nickname).toBe('小三');
    expect(data.assets).toEqual([{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }]);
  });

  it('保留 data.extensions 中非本工具生成的键', () => {
    const ext = assembleCard(cardToDraft(makeThirdPartyCard())).data.extensions as unknown as Record<string, unknown>;
    expect(ext.third_party_tool).toEqual({ version: 3, note: '自定义扩展' });
    expect(ext.talkativeness).toBe('0.7');
    // 有实际内容的 depth_prompt 不被本工具的空占位覆盖
    expect(ext.depth_prompt).toEqual({ prompt: '你要牢记设定', depth: 2, role: 'system' });
  });

  it('保留第三方 regex_scripts（自定义正则美化脚本）', () => {
    const ext = assembleCard(cardToDraft(makeThirdPartyCard())).data.extensions as unknown as Record<string, unknown>;
    const scripts = ext.regex_scripts as Array<Record<string, unknown>>;
    expect(scripts).toHaveLength(1);
    expect(scripts[0].scriptName).toBe('第三方美化脚本');
  });

  it('MVU 启用时第三方脚本与本工具脚本共存且本工具脚本不重复', () => {
    const draft = cardToDraft(makeThirdPartyCard());
    draft.mvu = {
      enabled: true,
      mode: 'expert',
      schemaSections: [{ name: '测试', variables: [{ path: '测试.值', zodType: 'z.coerce.number()', description: '', prefix: '', initialValue: 0 }] }],
      updateRules: [],
      ejsConfigs: [],
      ejsPreprocessContent: '',
      schemaTsContent: '...',
      initvarYamlContent: '',
      updateRulesYamlContent: '',
      statusBarHtml: '<div>状态栏</div>',
      statusBarStyle: 'compact-panel',
    };
    const ext = assembleCard(draft).data.extensions as unknown as Record<string, unknown>;
    const names = (ext.regex_scripts as Array<Record<string, unknown>>).map((s) => s.scriptName);
    expect(names).toContain('第三方美化脚本');
    expect(names).toContain('状态栏界面');
    // 每个本工具脚本只出现一次
    expect(new Set(names).size).toBe(names.length);

    // 再往返一次：本工具生成的脚本不会被当成第三方脚本堆积
    const roundTripped = assembleCard(cardToDraft(assembleCard(draft) as unknown as Record<string, unknown>));
    const names2 = ((roundTripped.data.extensions as unknown as Record<string, unknown>).regex_scripts as Array<Record<string, unknown>>).map((s) => s.scriptName);
    expect(names2.filter((n) => n === '第三方美化脚本')).toHaveLength(1);
    expect(new Set(names2).size).toBe(names2.length);
  });

  it('保留条目级未知字段与 automation_id / vectorized / useProbability / scan_depth / delay_until_recursion', () => {
    const draft = cardToDraft(makeThirdPartyCard());
    expect(draft.lorebookEntries[0]._passthrough).toEqual({
      root: { third_party_flag: true },
      extensions: {
        delay_until_recursion: 3,
        automation_id: 'my-automation',
        vectorized: true,
        // ST 真正的概率开关；非默认值必须留存
        useProbability: false,
        // 条目级扫描深度：本工具写 null（继承书级），导入值优先
        scan_depth: 4,
        // 名字写错的字段（ST 里没有 use_probability）当作未知字段原样保留
        use_probability: false,
        third_party_ext: 'keep',
      },
    });

    const entry = assembleCard(draft).data.character_book.entries[0];
    expect(entry.third_party_flag).toBe(true);
    const ext = entry.extensions as Record<string, unknown>;
    expect(ext.automation_id).toBe('my-automation');
    expect(ext.vectorized).toBe(true);
    expect(ext.useProbability).toBe(false);
    expect(ext.scan_depth).toBe(4);
    expect(ext.delay_until_recursion).toBe(3);
    expect(ext.third_party_ext).toBe('keep');
  });

  it('scan_depth 与 depth 不再互相污染：本工具导出写 null 继承书级', () => {
    // 自家草稿（无导入直通层）：depth=4 是 at_depth 插入楼层，
    // 不应被派生成条目级扫描深度 scan_depth=4（那会覆盖书级 scan_depth）
    const draft = makeDraft({
      cardName: 'T',
      lorebookEntries: [{ ...createEmptyLorebookEntry(), comment: 'E', name: 'E', depth: 4 }],
    });
    const ext = assembleCard(draft).data.character_book.entries[0].extensions as Record<string, unknown>;
    expect(ext.depth).toBe(4);
    expect(ext.scan_depth).toBeNull();
  });

  it('保留 character_book 层的未知字段与其 extensions', () => {
    const book = assembleCard(cardToDraft(makeThirdPartyCard())).data.character_book as unknown as Record<string, unknown>;
    expect(book.custom_book_field).toBe('书级未知字段');
    expect(book.extensions).toEqual({ book_level_custom: 'keep-me' });
  });

  it('已知字段永远以本工具的值为准，直通层只填补空缺', () => {
    const draft = makeDraft({
      cardName: '本工具卡名',
      firstMessage: '本工具开场白',
      lorebookEntries: [{
        ...createEmptyLorebookEntry(),
        name: 'E', comment: 'E', content: '本工具内容', keys: ['k'], probability: 42,
        _passthrough: {
          root: { content: '直通层试图覆盖', id: 999, name: '直通层名字' },
          extensions: { probability: 1, position: 6, display_index: 77, keep_me: true },
        },
      }],
      // 伪造一个「试图覆盖已知字段」的直通层（cardToDraft 不会产出这种数据，此处防御性验证合并顺序）
      _passthrough: {
        data: { name: 'HACKED', first_mes: 'HACKED', tags: ['HACKED'], keep_me: 'ok' },
        extensions: { world: 'HACKED', mvu_enabled: true, keep_me: 'ok' },
      },
    });
    const card = assembleCard(draft);
    const data = card.data as unknown as Record<string, unknown>;

    expect(data.name).toBe('本工具卡名');
    expect(data.first_mes).toBe('本工具开场白');
    expect(data.tags).toEqual([]);
    expect(data.keep_me).toBe('ok');

    const ext = card.data.extensions as unknown as Record<string, unknown>;
    expect(ext.world).toBe('本工具卡名的世界书');
    expect(ext.mvu_enabled).toBeUndefined();
    expect(ext.keep_me).toBe('ok');

    const entry = card.data.character_book.entries[0];
    expect(entry.content).toBe('本工具内容');
    expect(entry.id).toBe(1);
    expect(entry.name).toBe('E');
    const entryExt = entry.extensions as Record<string, unknown>;
    expect(entryExt.probability).toBe(42);
    expect(entryExt.position).toBe(1);
    expect(entryExt.display_index).toBe(0);
    expect(entryExt.keep_me).toBe(true);
  });

  it('本工具自家卡往返不产生直通层数据（草稿保持干净）', () => {
    const draft = makeDraft({
      cardName: '自家卡',
      firstMessage: '开场白',
      lorebookEntries: [{ ...createEmptyLorebookEntry(), name: 'E', comment: 'E', content: 'c', keys: ['k'] }],
    });
    const restored = cardToDraft(assembleCard(draft) as unknown as Record<string, unknown>);
    expect(restored._passthrough).toBeUndefined();
    expect(restored.lorebookEntries[0]._passthrough).toBeUndefined();
  });

  it('无 UI 入口的 ST 运行时字段（match_* / triggers / outlet_name / use_group_scoring）非默认值往返保真', () => {
    const card = makeThirdPartyCard() as { data: { character_book: { entries: Array<{ extensions: Record<string, unknown> }> } } };
    Object.assign(card.data.character_book.entries[0].extensions, {
      match_scenario: true,
      match_character_description: true,
      triggers: ['normal', 'continue'],
      outlet_name: '自定义出口',
      use_group_scoring: true,
    });
    const exported = assembleCard(cardToDraft(card as unknown as Record<string, unknown>));
    const ext = exported.data.character_book.entries[0].extensions as Record<string, unknown>;
    expect(ext.match_scenario).toBe(true);
    expect(ext.match_character_description).toBe(true);
    expect(ext.triggers).toEqual(['normal', 'continue']);
    expect(ext.outlet_name).toBe('自定义出口');
    expect(ext.use_group_scoring).toBe(true);
    // 默认值字段仍是本工具常量（不进直通层）
    expect(ext.match_persona_description).toBe(false);
  });

  it('本工具 MVU + 直播间卡往返也不产生直通层数据', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: ['测试评论'] });
    const draft = makeDraft({
      cardName: 'MVU 卡',
      firstMessage: '开播。',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{ name: '测试', variables: [{ path: '测试.值', zodType: 'z.coerce.number()', description: '', prefix: '', initialValue: 0 }] }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '...',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '<div>状态栏</div>',
        statusBarStyle: 'compact-panel',
      },
      liveStreamChat: {
        enabled: true, html, themeId: 'terminal', title: '直播间', maxVisible: 10, initialComments: ['测试评论'],
      },
    });
    const restored = cardToDraft(assembleCard(draft) as unknown as Record<string, unknown>);
    expect(restored._passthrough).toBeUndefined();
  });

  it('extensions 为畸形值（字符串/数组）时不会被拆成下标键污染导出', () => {
    const brokenCard = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '畸形卡',
        first_mes: '你好。',
        extensions: 'not-an-object',
        character_book: {
          name: '书',
          extensions: ['also', 'wrong'],
          entries: [{
            id: 1, name: 'E', content: 'c', keys: ['k'], enabled: true, constant: false,
            extensions: 'broken',
          }],
        },
      },
    } as unknown as Record<string, unknown>;
    const draft = cardToDraft(brokenCard);
    expect(draft._passthrough?.extensions).toBeUndefined();
    expect(draft.lorebookEntries[0]._passthrough).toBeUndefined();
    const card = assembleCard(draft);
    const ext = card.data.extensions as unknown as Record<string, unknown>;
    expect(ext['0']).toBeUndefined();
    expect(card.data.character_book.entries[0].extensions['0']).toBeUndefined();
  });

  it('纯 V1 卡导入时不把 spec/_meta 等信封字段塞进直通层', () => {
    const v1Card = {
      name: 'V1 卡',
      description: '',
      first_mes: '你好。',
      spec: 'chara_card_v2',
      spec_version: '2.0',
      _meta: { characters: [] },
      id: 7,
      createdAt: new Date(),
      custom_v1_field: '保留我',
    };
    const draft = cardToDraft(v1Card as unknown as Record<string, unknown>);
    const passData = draft._passthrough?.data ?? {};
    expect(passData.custom_v1_field).toBe('保留我');
    for (const banned of ['spec', 'spec_version', '_meta', 'id', 'createdAt', 'data']) {
      expect(passData[banned]).toBeUndefined();
    }
    const data = assembleCard(draft).data as unknown as Record<string, unknown>;
    expect(data.spec).toBeUndefined();
    expect(data._meta).toBeUndefined();
    expect(data.custom_v1_field).toBe('保留我');
  });
});

describe('findStagedLorebookEntryIndices', () => {
  it('无分阶段条目时返回空集合', () => {
    const entries: LorebookEntry[] = [
      { ...createEmptyLorebookEntry(), comment: '普通', name: '普通', content: '内容' },
    ];
    const indices = findStagedLorebookEntryIndices(entries);
    expect(indices.size).toBe(0);
  });

  it('包含 getWorldInfo 调度内容的条目被识别', () => {
    // parseDispatcherContent 需要同时匹配 getvar('stat_data.XXX') 和 getWorldInfo("书名", "子条目")
    const dispatcherContent = `<%_ const stage = getvar('stat_data.阶段'); const w = getWorldInfo("阶段书", "阶段1"); _%>`;
    const entries: LorebookEntry[] = [
      { ...createEmptyLorebookEntry(), comment: '调度', name: '调度', content: dispatcherContent },
      { ...createEmptyLorebookEntry(), comment: '普通', name: '普通', content: '普通内容' },
    ];
    const indices = findStagedLorebookEntryIndices(entries);
    expect(indices.has(0)).toBe(true);
    expect(indices.has(1)).toBe(false);
  });
});

// ── H11 regression: v.path must be escaped in buildFirstMessage's setvar calls ──
//
// buildFirstMessage emits EJS setvar calls in first_mes:
//   <%_ setvar('stat_data.${v.path}', <value>); _%>
// v.path comes from MvuVariable.path which is a free-text <input> in
// StepMvuVariables.tsx and is populated without sanitization by
// mergeVariableBlueprintsIntoMvu (AI-generated). A `'`, `\`, or `%>` in the
// path would otherwise break out of the single-quoted JS string literal and
// allow EJS code injection (same vector as H7-H10).

describe('assembleCard — H11 EJS v.path escaping in first_mes setvar calls', () => {
  it('escapes single quote in v.path for number-typed variable', () => {
    const draft = makeDraft({
      cardName: '测试',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{
          name: '角色',
          variables: [
            { path: "好感度'); evilCode(); //", zodType: 'z.coerce.number()', initialValue: 0, prefix: '', description: '' },
          ],
        }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    const firstMes = card.data.first_mes;
    // The raw, unescaped payload must NOT appear in first_mes (would mean injection succeeded)
    expect(firstMes).not.toContain("stat_data.好感度'); evilCode(); //");
    // The escaped form (single quote escaped to \') must be present
    expect(firstMes).toContain("stat_data.好感度\\'); evilCode(); //");
  });

  it('escapes single quote in v.path for boolean-typed variable', () => {
    const draft = makeDraft({
      cardName: '测试',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{
          name: '角色',
          variables: [
            { path: "存活'); evil(); //", zodType: 'z.boolean()', initialValue: true, prefix: '', description: '' },
          ],
        }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    const firstMes = card.data.first_mes;
    expect(firstMes).not.toContain("stat_data.存活'); evil(); //");
    expect(firstMes).toContain("stat_data.存活\\'); evil(); //");
  });

  it('escapes single quote in v.path for string-typed variable (value also escaped)', () => {
    const draft = makeDraft({
      cardName: '测试',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{
          name: '角色',
          variables: [
            { path: "名字'); evil(); //", zodType: 'z.string()', initialValue: '艾伦', prefix: '', description: '' },
          ],
        }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    const firstMes = card.data.first_mes;
    expect(firstMes).not.toContain("stat_data.名字'); evil(); //");
    expect(firstMes).toContain("stat_data.名字\\'); evil(); //");
  });

  it('escapes backslash at end of v.path (critical case)', () => {
    // A trailing backslash would escape the closing quote and break syntax.
    const draft = makeDraft({
      cardName: '测试',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{
          name: '角色',
          variables: [
            { path: '角色.x\\', zodType: 'z.coerce.number()', initialValue: 0, prefix: '', description: '' },
          ],
        }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    const firstMes = card.data.first_mes;
    // Trailing backslash must be doubled (so \\' in output, which is \\\\ in regex)
    expect(firstMes).toMatch(/stat_data\.角色\.x\\\\'/);
  });

  it('escapes %> sequence in v.path to prevent EJS close tag injection', () => {
    const draft = makeDraft({
      cardName: '测试',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{
          name: '角色',
          variables: [
            { path: '角色.x%>y', zodType: 'z.coerce.number()', initialValue: 0, prefix: '', description: '' },
          ],
        }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    const firstMes = card.data.first_mes;
    // %> must be escaped so it doesn't terminate the EJS scriptlet early
    expect(firstMes).not.toContain('stat_data.角色.x%>y');
    expect(firstMes).toContain('stat_data.角色.x%\\>y');
  });

  it('escapes newline in v.path', () => {
    const draft = makeDraft({
      cardName: '测试',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{
          name: '角色',
          variables: [
            { path: '角色.x\ny', zodType: 'z.coerce.number()', initialValue: 0, prefix: '', description: '' },
          ],
        }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    const firstMes = card.data.first_mes;
    // Newline must be escaped to \n (backslash-n) so it doesn't break the JS literal
    expect(firstMes).not.toContain('stat_data.角色.x\ny');
    expect(firstMes).toContain('stat_data.角色.x\\ny');
  });

  it('normal v.path still produces valid setvar call', () => {
    // Sanity check: legitimate variable paths must continue to work.
    const draft = makeDraft({
      cardName: '测试',
      mvu: {
        enabled: true,
        mode: 'expert',
        schemaSections: [{
          name: '角色',
          variables: [
            { path: '角色.好感度', zodType: 'z.coerce.number()', initialValue: 50, prefix: '', description: '' },
            { path: '角色.存活', zodType: 'z.boolean()', initialValue: true, prefix: '', description: '' },
            { path: '角色.名字', zodType: 'z.string()', initialValue: '艾伦', prefix: '', description: '' },
          ],
        }],
        updateRules: [],
        ejsConfigs: [],
        ejsPreprocessContent: '',
        schemaTsContent: '',
        initvarYamlContent: '',
        updateRulesYamlContent: '',
        statusBarHtml: '',
        statusBarStyle: 'compact-panel',
      },
    });
    const card = assembleCard(draft);
    const firstMes = card.data.first_mes;
    expect(firstMes).toContain("setvar('stat_data.角色.好感度', 50)");
    expect(firstMes).toContain("setvar('stat_data.角色.存活', true)");
    expect(firstMes).toContain("setvar('stat_data.角色.名字', '艾伦')");
  });
});
