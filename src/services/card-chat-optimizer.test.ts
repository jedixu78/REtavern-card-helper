import { describe, it, expect } from 'vitest';
import type { WizardDraft } from '../constants/defaults';
import { createEmptyLorebookEntry } from '../constants/defaults';
import {
  parseCardChatEdits,
  computeCardChatDiffs,
  applyCardChatPatch,
  applySingleChange,
  applyPatchesToCardData,
  filterByWriteGate,
  buildChangeProposal,
  WRITE_GATE_ALLOWED_FIELDS,
} from './card-chat-optimizer';

function emptyDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    cardName: 'Test Card',
    characters: [{ id: 'char-1', name: 'Alice', description: 'A brave knight.' }],
    lorebookEntries: [
      {
        id: 'entry-1',
        name: 'Background',
        comment: 'Background',
        keys: ['past'],
        secondary_keys: [],
        content: 'She was born in a small village.',
        enabled: true,
        constant: false,
        selective: false,
        insertion_order: 100,
        position: 'after_char',
        priority: 50,
        case_sensitive: false,
        use_regex: false,
        probability: 100,
        group: '',
        group_weight: 100,
        selectiveLogic: 0,
        role: 0,
        depth: 4,
        exclude_recursion: false,
        prevent_recursion: false,
        match_whole_words: false,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        ignore_budget: false,
      },
    ],
    firstMessage: 'Hello there.',
    scenario: 'A fantasy world.',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    creator_notes: '',
    creator: '',
    character_version: '',
    tags: ['fantasy'],
    bookScanDepth: 50,
    bookTokenBudget: 2000,
    bookRecursiveScanning: false,
    ...overrides,
  };
}

describe('applyPatchesToCardData - 世界书 id 唯一性 (B1)', () => {
  it('同批次先 delete 再 add 后，新条目 id 不与保留条目重复', () => {
    const cardData: Record<string, unknown> = {
      data: {
        character_book: {
          entries: [1, 2, 3, 4, 5].map((n) => ({
            id: n,
            comment: `c${n}`,
            name: `c${n}`,
            content: '',
            keys: [],
          })),
        },
      },
    };
    const result = applyPatchesToCardData(cardData, [
      { field: 'lorebookEntries', action: 'delete', comment: 'c3' },
      { field: 'lorebookEntries', action: 'add', comment: 'c6', content: 'x' },
    ]);
    const entries = (result.data as { character_book: { entries: Array<{ id: number }> } })
      .character_book.entries;
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // 无重复 id
  });
});

describe('applyCardChatPatch - 角色描述编辑同步世界书 (B5)', () => {
  it('characters replace 更新描述后，关联的角色设定条目内容也更新', () => {
    const draft = emptyDraft({
      characters: [{ id: 'char-1', name: 'Alice', description: 'old', entryIds: ['role-1'] }],
      lorebookEntries: [
        {
          ...createEmptyLorebookEntry(),
          id: 'role-1',
          name: 'Alice - 角色设定',
          comment: 'Alice 的角色设定',
          content: 'old',
        },
      ],
    });
    const result = applyCardChatPatch(draft, {
      proposedChanges: [
        { field: 'characters', action: 'replace', id: 'char-1', description: 'Alice is now kind.' },
      ],
    });
    const entry = result.lorebookEntries.find((e) => e.id === 'role-1');
    expect(entry?.content).toBe('Alice is now kind.');
    expect(result.characters[0].description).toBe('Alice is now kind.');
  });
});

describe('parseCardChatEdits', () => {
  it('parses a markdown-fenced JSON with proposedChanges', () => {
    const text = '```json\n{"proposedChanges":[{"field":"firstMessage","value":"你好。"}]}\n```';
    const result = parseCardChatEdits(text);
    expect(result).not.toBeNull();
    expect(result!.proposedChanges).toHaveLength(1);
    expect(result!.proposedChanges[0]).toMatchObject({ field: 'firstMessage', value: '你好。' });
  });

  it('parses plain JSON without fences', () => {
    const text = '{"proposedChanges":[{"field":"cardName","value":"New Name"}]}';
    const result = parseCardChatEdits(text);
    expect(result).not.toBeNull();
    expect(result!.proposedChanges[0]).toMatchObject({ field: 'cardName', value: 'New Name' });
  });

  it('returns null for normal chat reply', () => {
    const text = '我觉得你可以把开场白改得更温柔一些。';
    expect(parseCardChatEdits(text)).toBeNull();
  });

  it('returns null when proposedChanges is missing', () => {
    const text = '{"foo":"bar"}';
    expect(parseCardChatEdits(text)).toBeNull();
  });

  it('parses lorebook add/replace/delete changes', () => {
    const text = JSON.stringify({
      proposedChanges: [
        { field: 'lorebookEntries', action: 'replace' as const, comment: 'Background', content: 'New content', keys: ['past', 'village'] },
        { field: 'lorebookEntries', action: 'add' as const, comment: 'New Entry', content: 'New entry content', keys: ['magic'] },
        { field: 'lorebookEntries', action: 'delete' as const, comment: 'Background' },
      ],
    });
    const result = parseCardChatEdits(text);
    expect(result).not.toBeNull();
    expect(result!.proposedChanges).toHaveLength(3);
  });

  it('parses character changes', () => {
    const text = JSON.stringify({
      proposedChanges: [
        { field: 'characters', action: 'replace' as const, id: 'char-1', description: 'A kind healer.' },
        { field: 'characters', action: 'add' as const, name: 'Bob', description: 'A rogue.' },
      ],
    });
    const result = parseCardChatEdits(text);
    expect(result).not.toBeNull();
    expect(result!.proposedChanges).toHaveLength(2);
  });
});

describe('computeCardChatDiffs', () => {
  it('computes diff for scalar field change', () => {
    const draft = emptyDraft();
    const proposals = { proposedChanges: [{ field: 'firstMessage' as const, value: '你好。' }] };
    const diffs = computeCardChatDiffs(draft, proposals);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].hasChange).toBe(true);
    expect(diffs[0].before).toBe('Hello there.');
    expect(diffs[0].after).toBe('你好。');
  });

  it('detects unchanged scalar field', () => {
    const draft = emptyDraft();
    const proposals = { proposedChanges: [{ field: 'cardName' as const, value: 'Test Card' }] };
    const diffs = computeCardChatDiffs(draft, proposals);
    expect(diffs[0].hasChange).toBe(false);
  });

  it('computes diff for lorebook entry replace', () => {
    const draft = emptyDraft();
    const proposals = { proposedChanges: [{ field: 'lorebookEntries' as const, action: 'replace' as const, comment: 'Background', content: 'Modified content', keys: ['past'] }] };
    const diffs = computeCardChatDiffs(draft, proposals);
    expect(diffs[0].hasChange).toBe(true);
  });

  it('ignores lorebook replace for missing comment', () => {
    const draft = emptyDraft();
    const proposals = { proposedChanges: [{ field: 'lorebookEntries' as const, action: 'replace' as const, comment: 'Missing', content: 'x' }] };
    const diffs = computeCardChatDiffs(draft, proposals);
    expect(diffs[0].hasChange).toBe(false);
  });
});

describe('applyCardChatPatch', () => {
  it('applies scalar field change', () => {
    const draft = emptyDraft();
    const proposals = { proposedChanges: [{ field: 'firstMessage' as const, value: '你好。' }] };
    const next = applyCardChatPatch(draft, proposals);
    expect(next.firstMessage).toBe('你好。');
  });

  it('replaces character description', () => {
    const draft = emptyDraft();
    const proposals = { proposedChanges: [{ field: 'characters' as const, action: 'replace' as const, id: 'char-1', description: 'A kind healer.' }] };
    const next = applyCardChatPatch(draft, proposals);
    expect(next.characters[0].description).toBe('A kind healer.');
  });

  it('adds a new lorebook entry', () => {
    const draft = emptyDraft();
    const proposals = { proposedChanges: [{ field: 'lorebookEntries' as const, action: 'add' as const, comment: 'Magic', content: 'She can cast spells.', keys: ['magic'] }] };
    const next = applyCardChatPatch(draft, proposals);
    expect(next.lorebookEntries).toHaveLength(2);
    expect(next.lorebookEntries[1].comment).toBe('Magic');
  });

  it('deletes a lorebook entry', () => {
    const draft = emptyDraft();
    const proposals = { proposedChanges: [{ field: 'lorebookEntries' as const, action: 'delete' as const, comment: 'Background' }] };
    const next = applyCardChatPatch(draft, proposals);
    expect(next.lorebookEntries).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// governed-write 写入门禁（Write Gate）
// ════════════════════════════════════════════════════════════════════════════

describe('filterByWriteGate - governed-write 字段白名单', () => {
  it('白名单内的字段全部保留', () => {
    const changes = WRITE_GATE_ALLOWED_FIELDS.map((field) => ({
      field,
      value: 'test',
    } as const));
    const filtered = filterByWriteGate(changes);
    expect(filtered).toHaveLength(WRITE_GATE_ALLOWED_FIELDS.length);
  });

  it('白名单外的字段被丢弃', () => {
    const changes = [
      { field: 'cardName' as const, value: '合法' },
      { field: 'regex_scripts' as unknown as 'cardName', value: '越权' },
      { field: 'character_book.name' as unknown as 'cardName', value: '越权' },
      { field: 'extensions.world' as unknown as 'cardName', value: '越权' },
      { field: '_passthrough' as unknown as 'cardName', value: '越权' },
    ];
    const filtered = filterByWriteGate(changes);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].field).toBe('cardName');
  });

  it('空列表返回空列表', () => {
    expect(filterByWriteGate([])).toHaveLength(0);
  });
});

describe('buildChangeProposal - governed-write 变更提案', () => {
  it('自动过滤越权字段并设置审批状态为 pending', () => {
    const proposals = {
      proposedChanges: [
        { field: 'firstMessage' as const, value: '你好' },
        { field: 'regex_scripts' as unknown as 'cardName', value: '越权' },
      ],
    };
    const proposal = buildChangeProposal(proposals);
    expect(proposal.approvalState).toBe('pending');
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0].field).toBe('firstMessage');
    expect(proposal.targetPaths).toBe(WRITE_GATE_ALLOWED_FIELDS);
    expect(typeof proposal.createdAt).toBe('number');
  });

  it('空提案也返回 valid ChangeProposal', () => {
    const proposal = buildChangeProposal({ proposedChanges: [] });
    expect(proposal.changes).toHaveLength(0);
    expect(proposal.approvalState).toBe('pending');
  });
});

describe('applyCardChatPatch - governed-write 越权补丁被丢弃', () => {
  it('尝试通过越权字段修改 regex 名时被静默丢弃', () => {
    const draft = emptyDraft();
    // 模拟 AI 返回越权补丁（field 不在白名单）
    const proposals = {
      proposedChanges: [
        { field: 'regex_scripts' as unknown as 'cardName', value: '恶意改名' },
        { field: 'firstMessage' as const, value: '合法修改' },
      ],
    };
    const next = applyCardChatPatch(draft, proposals);
    // 越权字段被丢弃，合法字段被应用
    expect(next.firstMessage).toBe('合法修改');
  });

  it('applySingleChange 对越权补丁返回原 draft', () => {
    const draft = emptyDraft();
    const originalFirstMessage = draft.firstMessage;
    // 单条越权补丁
    const change = { field: 'extensions.world' as unknown as 'cardName', value: '恶意改书名' };
    const next = applySingleChange(draft, change);
    // 越权补丁被丢弃，draft 不变
    expect(next).toBe(draft);
    expect(next.firstMessage).toBe(originalFirstMessage);
  });
});
