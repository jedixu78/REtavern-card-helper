/**
 * Card Chat Optimizer — powers the AI Card Editor chat page.
 *
 * Lets users import a character card, chat with AI about changes, and receive
 * structured edit proposals that can be reviewed as diffs before applying.
 */

import type { WizardDraft } from '../constants/defaults';
import { generateId, createEmptyLorebookEntry, createEmptyMvuConfig, REGEX_SCRIPT_NAMES } from '../constants/defaults';
import { parseAIJson } from './ai-json';
import { editableLorebookEntries } from './lorebook-predicates';
import { deepClone } from '../utils/deep-clone';


// ════════════════════════════════════════════════════════════════════════════
// 原始 JSON 补丁系统
// ────────────────────────────────────────────────────────────────────────────
// 设计原则（用户强约束方案）：
//   1. 导入的卡片本质上是一个 JSON 文件，作为"底版"原样保留
//   2. AI 只能通过 proposedChanges 提出修改（替换/删减/新增）
//   3. 所有修改必须经过用户确认后才应用到原始 JSON
//   4. AI 不得修改未涉及的相关依赖，其他字段一律原样保留
//   5. 导出时直接导出"原始 JSON + 已确认 patches"，不走 cardToDraft → assembleCard 的有损往返
// ════════════════════════════════════════════════════════════════════════════

export type CardChatEditableField =
  | 'cardName'
  | 'tags'
  | 'firstMessage'
  | 'scenario'
  | 'system_prompt'
  | 'post_history_instructions'
  | 'creator_notes'
  | 'characters'
  | 'lorebookEntries'
  | 'mvu.statusBarHtml'
  | 'liveStreamChat.html';

export interface ProposedChange {
  field: CardChatEditableField;
  /** For scalar fields (cardName, firstMessage, scenario, etc.) */
  value?: string | string[];
  /** For characters and lorebookEntries */
  action?: 'replace' | 'add' | 'delete';
  /** Character id (for characters replace) */
  id?: string;
  /** Character / entry name */
  name?: string;
  /** Character description (for characters replace/add) */
  description?: string;
  /** Lorebook entry comment used as identifier */
  comment?: string;
  /** New comment when renaming a lorebook entry */
  newComment?: string;
  /** Lorebook entry content */
  content?: string;
  /** Lorebook entry keys */
  keys?: string[];
}

export interface CardChatProposals {
  proposedChanges: ProposedChange[];
}

export interface ChangeDiff {
  change: ProposedChange;
  hasChange: boolean;
  before: unknown;
  after: unknown;
}

const FIELD_LABELS: Record<CardChatEditableField, string> = {
  cardName: '卡片名称',
  tags: '标签',
  firstMessage: '开场白',
  scenario: '世界观/情境',
  system_prompt: '系统提示',
  post_history_instructions: '历史后指令',
  creator_notes: '创作者备注',
  characters: '角色设定',
  lorebookEntries: '世界书条目',
  'mvu.statusBarHtml': '状态栏 HTML',
  'liveStreamChat.html': '直播间面板 HTML',
};

export function fieldLabel(field: CardChatEditableField): string {
  return FIELD_LABELS[field] || field;
}

/**
 * Derive a human-readable display name for a diff, identifying the specific
 * entry/character affected rather than just showing the generic field label.
 */
export function diffDisplayName(diff: ChangeDiff): string {
  const { change, before } = diff;
  if (change.field === 'lorebookEntries') {
    const comment = change.comment || (before as { comment?: string } | null)?.comment || '';
    return comment || '未命名条目';
  }
  if (change.field === 'characters') {
    const name = change.name || (before as { name?: string } | null)?.name || '';
    return name || '未命名角色';
  }
  return fieldLabel(change.field);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n...[truncated]';
}

/** Build a concise snapshot of the current draft for the AI prompt. */
function draftSnapshot(draft: WizardDraft): string {
  const lines: string[] = [];

  lines.push(`## 基础信息`);
  lines.push(`cardName: ${JSON.stringify(draft.cardName || '')}`);
  lines.push(`tags: ${JSON.stringify(draft.tags || [])}`);
  lines.push(`firstMessage: ${JSON.stringify(truncate(draft.firstMessage || '', 2000))}`);
  lines.push(`scenario: ${JSON.stringify(truncate(draft.scenario || '', 2000))}`);
  lines.push(`system_prompt: ${JSON.stringify(truncate(draft.system_prompt || '', 2000))}`);
  lines.push(`post_history_instructions: ${JSON.stringify(truncate(draft.post_history_instructions || '', 1000))}`);
  lines.push(`creator_notes: ${JSON.stringify(truncate(draft.creator_notes || '', 1000))}`);

  if (draft.characters?.length) {
    lines.push(`\n## 角色设定`);
    for (const ch of draft.characters) {
      lines.push(`- id: ${ch.id}, name: ${JSON.stringify(ch.name || '')}`);
      lines.push(`  description: ${JSON.stringify(truncate(ch.description || '', 3000))}`);
    }
  }

  const entries = editableLorebookEntries(draft).filter((e) => e.enabled);
  if (entries.length) {
    lines.push(`\n## 可编辑世界书条目（按 comment 字段识别）`);
    for (const e of entries) {
      lines.push(`- comment: ${JSON.stringify(e.comment || '')}`);
      lines.push(`  keys: ${JSON.stringify(e.keys || [])}`);
      lines.push(`  content: ${JSON.stringify(truncate(e.content || '', 2000))}`);
    }
  }

  if (draft.mvu?.enabled) {
    lines.push(`\n## MVU 状态栏 HTML（可修改）`);
    lines.push(`mvu.statusBarHtml: ${JSON.stringify(truncate(draft.mvu.statusBarHtml || '', 2000))}`);
  }
  if (draft.liveStreamChat?.enabled) {
    lines.push(`\n## 直播间评论面板（已启用，可修改 HTML）`);
    lines.push(`liveStreamChat.html: ${JSON.stringify(truncate(draft.liveStreamChat.html || '', 2000))}`);
    lines.push(`注：直播面板通过 stat_data.直播间.评论 数组渲染弹幕，占位符 <LiveStreamChatImpl/> 由正则脚本替换为面板 HTML。`);
  }

  return lines.join('\n');
}

export function buildCardChatPrompt(
  draft: WizardDraft,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[],
): { system: string; user: string } {
  const system = `你是一位资深的 SillyTavern 角色卡编辑专家。创作者会把他导入的角色卡数据发给你，并请你帮忙修改。

## 核心原则（强约束）
导入的卡片本质上是一个 JSON 文件，作为"底版"原样保留。你只能通过返回 proposedChanges 提出修改（替换/删减/新增），所有修改必须经过创作者确认后才会应用。
**你不得修改未涉及的相关依赖，其他不相关的一律不管，原样保留。** 卡片中的 MVU 脚本、正则脚本、extensions、ST 运行时字段等只有在用户明确要求修改对应字段时才允许变动。

## 当前角色卡数据
${draftSnapshot(draft)}

## 工作规则
1. 普通建议、诊断、灵感类回复用中文 markdown 输出，直接给出可执行的修改思路。
2. 当创作者明确要求修改（例如"把 NTR 剧情改成纯爱"、"改一下开场白"、"增加一条世界书条目"）时，必须只返回如下 JSON，不要加 markdown 代码块，不要加解释文字：

{
  "proposedChanges": [
    { "field": "cardName", "value": "新名称" },
    { "field": "tags", "value": ["标签1", "标签2"] },
    { "field": "firstMessage", "value": "新开场白" },
    { "field": "scenario", "value": "新世界观" },
    { "field": "system_prompt", "value": "新系统提示" },
    { "field": "post_history_instructions", "value": "新历史后指令" },
    { "field": "creator_notes", "value": "新创作者备注" },
    { "field": "mvu.statusBarHtml", "value": "新状态栏HTML" },
    { "field": "liveStreamChat.html", "value": "新直播间面板HTML" },
    { "field": "characters", "action": "replace", "id": "角色id", "description": "新角色描述" },
    { "field": "characters", "action": "add", "name": "新角色名", "description": "新角色描述" },
    { "field": "lorebookEntries", "action": "replace", "comment": "原条目comment", "content": "新内容", "keys": ["触发词"] },
    { "field": "lorebookEntries", "action": "add", "comment": "新条目comment", "content": "内容", "keys": ["触发词"] },
    { "field": "lorebookEntries", "action": "delete", "comment": "要删除的条目comment" }
  ]
}

3. **强约束：你只能修改用户明确要求的字段，禁止改动未提及的字段。** 未涉及的相关依赖（MVU 脚本、正则、extensions 等）一律原样保留。
4. 修改必须保持人设一致，禁止自相矛盾。
5. 对于 lorebookEntries，必须通过 comment 字段匹配原条目；新增条目的 comment 必须唯一。
6. 如果用户要求涉及 NSFW/纯爱/NTR 等剧情走向切换，只调整用户明确提及的字段及直接相关的内容（如 firstMessage、scenario、角色描述、相关世界书条目），不得擅自修改未提及的 MVU 脚本、正则或其他依赖。
7. 你的 proposedChanges 只包含"差异"——只列出需要改动的字段，不要把未改动的字段也列出来。`;

  const user = history.length > 0
    ? `请继续基于上面的卡片数据和之前的对话，处理以下需求：\n\n${userMessage}`
    : userMessage;

  return { system, user };
}

export function parseCardChatEdits(text: string): CardChatProposals | null {
  const parsed = parseAIJson(text);
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  const raw = obj.proposedChanges;
  if (!Array.isArray(raw)) return null;

  const proposedChanges: ProposedChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const change = item as Record<string, unknown>;
    const field = change.field as CardChatEditableField | undefined;
    if (!field) continue;

    const base: ProposedChange = { field };

    if (field === 'cardName' || field === 'firstMessage' || field === 'scenario' ||
        field === 'system_prompt' || field === 'post_history_instructions' || field === 'creator_notes' ||
        field === 'mvu.statusBarHtml' || field === 'liveStreamChat.html') {
      if (typeof change.value === 'string') base.value = change.value;
    } else if (field === 'tags') {
      if (Array.isArray(change.value)) {
        base.value = (change.value as unknown[]).filter((v): v is string => typeof v === 'string');
      }
    } else if (field === 'characters') {
      const action = change.action as 'replace' | 'add' | 'delete' | undefined;
      if (action === 'replace' || action === 'add' || action === 'delete') {
        base.action = action;
        if (typeof change.id === 'string') base.id = change.id;
        if (typeof change.name === 'string') base.name = change.name;
        if (typeof change.description === 'string') base.description = change.description;
        proposedChanges.push(base);
      }
    } else if (field === 'lorebookEntries') {
      const action = change.action as 'replace' | 'add' | 'delete' | undefined;
      if (action === 'replace' || action === 'add' || action === 'delete') {
        base.action = action;
        if (typeof change.comment === 'string') base.comment = change.comment;
        if (typeof change.newComment === 'string') base.newComment = change.newComment;
        if (typeof change.content === 'string') base.content = change.content;
        if (Array.isArray(change.keys)) {
          base.keys = (change.keys as unknown[]).filter((k): k is string => typeof k === 'string');
        }
        proposedChanges.push(base);
      }
    }

    if (base.value !== undefined || base.action !== undefined) {
      if (field === 'tags' || field === 'cardName' || field === 'firstMessage' ||
          field === 'scenario' || field === 'system_prompt' || field === 'post_history_instructions' ||
          field === 'creator_notes' || field === 'mvu.statusBarHtml' || field === 'liveStreamChat.html') {
        proposedChanges.push(base);
      }
    }
  }

  return proposedChanges.length > 0 ? { proposedChanges } : null;
}

export function computeCardChatDiffs(draft: WizardDraft, proposals: CardChatProposals): ChangeDiff[] {
  const diffs: ChangeDiff[] = [];

  for (const change of proposals.proposedChanges) {
    let before: unknown;
    let after: unknown;
    let hasChange = false;

    if (change.field === 'cardName') {
      before = draft.cardName || '';
      after = change.value || '';
      hasChange = before !== after;
    } else if (change.field === 'tags') {
      before = draft.tags || [];
      after = change.value || [];
      hasChange = JSON.stringify((before as string[]).slice().sort()) !== JSON.stringify((after as string[]).slice().sort());
    } else if (change.field === 'firstMessage') {
      before = draft.firstMessage || '';
      after = change.value || '';
      hasChange = before !== after;
    } else if (change.field === 'scenario') {
      before = draft.scenario || '';
      after = change.value || '';
      hasChange = before !== after;
    } else if (change.field === 'system_prompt') {
      before = draft.system_prompt || '';
      after = change.value || '';
      hasChange = before !== after;
    } else if (change.field === 'post_history_instructions') {
      before = draft.post_history_instructions || '';
      after = change.value || '';
      hasChange = before !== after;
    } else if (change.field === 'creator_notes') {
      before = draft.creator_notes || '';
      after = change.value || '';
      hasChange = before !== after;
    } else if (change.field === 'mvu.statusBarHtml') {
      before = draft.mvu?.statusBarHtml || '';
      after = change.value || '';
      hasChange = before !== after;
    } else if (change.field === 'liveStreamChat.html') {
      before = draft.liveStreamChat?.html || '';
      after = change.value || '';
      hasChange = before !== after;
    } else if (change.field === 'characters') {
      if (change.action === 'replace' && change.id) {
        const ch = draft.characters.find((c) => c.id === change.id);
        before = ch ? { name: ch.name, description: ch.description } : null;
        after = { name: change.name ?? ch?.name ?? '', description: change.description ?? ch?.description ?? '' };
        hasChange = !!ch && (
          (change.description !== undefined && ch.description !== change.description) ||
          (change.name !== undefined && ch.name !== change.name)
        );
      } else if (change.action === 'add') {
        before = null;
        after = { name: change.name || '', description: change.description || '' };
        hasChange = true;
      } else if (change.action === 'delete' && change.id) {
        const ch = draft.characters.find((c) => c.id === change.id);
        before = ch ? { name: ch.name, description: ch.description } : null;
        after = null;
        hasChange = !!ch;
      }
    } else if (change.field === 'lorebookEntries') {
      const entries = editableLorebookEntries(draft);
      const matches = entries.filter((e) => e.comment === change.comment);
      if (change.action === 'replace' && matches.length > 0) {
        const match = matches[0];
        before = { comment: match.comment, content: match.content, keys: match.keys };
        after = { comment: change.newComment || match.comment, content: change.content ?? match.content, keys: change.keys ?? match.keys };
        hasChange = matches.some((m) =>
          (change.content !== undefined && m.content !== change.content) ||
          (change.newComment !== undefined && m.comment !== change.newComment) ||
          JSON.stringify(m.keys.slice().sort()) !== JSON.stringify((change.keys ?? m.keys).slice().sort())
        );
      } else if (change.action === 'add') {
        before = null;
        after = { comment: change.comment || '', content: change.content || '', keys: change.keys || [] };
        hasChange = true;
      } else if (change.action === 'delete' && matches.length > 0) {
        const match = matches[0];
        before = { comment: match.comment, content: match.content, keys: match.keys };
        after = null;
        hasChange = true;
      }
    }

    diffs.push({ change, hasChange, before, after });
  }

  return diffs;
}

/** Apply a single proposed change to a draft (returns a new draft). */
export function applySingleChange(draft: WizardDraft, change: ProposedChange): WizardDraft {
  return applyCardChatPatch(draft, { proposedChanges: [change] });
}

export function applyCardChatPatch(draft: WizardDraft, proposals: CardChatProposals): WizardDraft {
  const next: WizardDraft = { ...draft };

  for (const change of proposals.proposedChanges) {
    if (change.field === 'cardName' && typeof change.value === 'string') {
      next.cardName = change.value;
    } else if (change.field === 'tags' && Array.isArray(change.value)) {
      next.tags = change.value as string[];
    } else if (change.field === 'firstMessage' && typeof change.value === 'string') {
      next.firstMessage = change.value;
    } else if (change.field === 'scenario' && typeof change.value === 'string') {
      next.scenario = change.value;
    } else if (change.field === 'system_prompt' && typeof change.value === 'string') {
      next.system_prompt = change.value;
    } else if (change.field === 'post_history_instructions' && typeof change.value === 'string') {
      next.post_history_instructions = change.value;
    } else if (change.field === 'creator_notes' && typeof change.value === 'string') {
      next.creator_notes = change.value;
    } else if (change.field === 'mvu.statusBarHtml' && typeof change.value === 'string') {
      // MVU 不存在时创建一个空配置并启用，保证 statusBarHtml 能被实际写入与导出
      // （与 liveStreamChat.html 行为一致，避免 diff 显示有变更但 apply 静默丢弃）
      if (!next.mvu) {
        next.mvu = createEmptyMvuConfig();
      }
      next.mvu = { ...next.mvu, statusBarHtml: change.value };
    } else if (change.field === 'liveStreamChat.html' && typeof change.value === 'string') {
      next.liveStreamChat = next.liveStreamChat
        ? { ...next.liveStreamChat, html: change.value, enabled: true }
        : { enabled: true, html: change.value, themeId: 'terminal', title: '直播间', maxVisible: 10, initialComments: [] };
    } else if (change.field === 'characters') {
      if (change.action === 'replace' && change.id &&
          (typeof change.description === 'string' || typeof change.name === 'string')) {
        const targetChar = next.characters.find((c) => c.id === change.id);
        next.characters = next.characters.map((c) =>
          c.id === change.id
            ? { ...c, description: change.description ?? c.description, name: change.name ?? c.name }
            : c
        );
        // B5: 角色描述实际喂给 AI 的是「角色设定」世界书条目，仅改 characters 不会写回条目，
        // 导致应用后的编辑对导出卡片无效。这里通过 entryIds 关联把新描述同步到世界书条目：
        // 将可能被拆分的多条合并为一条（保留首条的 name/comment 等元数据），并让 entryIds 指向它。
        if (targetChar && typeof change.description === 'string') {
          const linkedIds = new Set(targetChar.entryIds ?? []);
          const currentEntries = next.lorebookEntries || [];
          const linked = linkedIds.size > 0 ? currentEntries.filter((e) => linkedIds.has(e.id)) : [];
          if (linked.length > 0) {
            const primaryId = linked[0].id;
            next.lorebookEntries = currentEntries
              .filter((e) => e.id === primaryId || !linkedIds.has(e.id))
              .map((e) =>
                e.id === primaryId
                  ? { ...e, content: change.description as string, name: change.name ?? e.name }
                  : e
              );
            next.characters = next.characters.map((c) =>
              c.id === change.id ? { ...c, entryIds: [primaryId] } : c
            );
          }
        }
      } else if (change.action === 'add' && typeof change.description === 'string') {
        next.characters = [
          ...next.characters,
          { id: generateId(), name: change.name || '', description: change.description! },
        ];
      } else if (change.action === 'delete' && change.id) {
        next.characters = next.characters.filter((c) => c.id !== change.id);
      }
    } else if (change.field === 'lorebookEntries') {
      const entries = next.lorebookEntries || [];
      if (change.action === 'replace' && change.comment) {
        let replaced = false;
        next.lorebookEntries = entries.map((e) => {
          if (e.comment !== change.comment) return e;
          replaced = true;
          return {
            ...e,
            comment: change.newComment ?? e.comment,
            name: change.name ?? e.name,
            content: change.content ?? e.content,
            keys: change.keys ?? e.keys,
          };
        });
        // Fallback to add if the target entry no longer exists.
        if (!replaced && change.content !== undefined) {
          next.lorebookEntries = [
            ...entries,
            {
              ...createEmptyLorebookEntry(),
              id: generateId(),
              comment: change.newComment ?? change.comment,
              name: change.name || change.comment || '',
              content: change.content,
              keys: change.keys || [],
            },
          ];
        }
      } else if (change.action === 'add') {
        const targetComment = change.comment || '';
        const exists = entries.some((e) => e.comment === targetComment);
        if (exists) {
          next.lorebookEntries = entries.map((e) =>
            e.comment === targetComment
              ? { ...e, name: change.name ?? e.name, content: change.content ?? e.content, keys: change.keys ?? e.keys }
              : e
          );
        } else {
          next.lorebookEntries = [
            ...entries,
            {
              ...createEmptyLorebookEntry(),
              id: generateId(),
              comment: targetComment,
              name: change.name || targetComment || '',
              content: change.content || '',
              keys: change.keys || [],
            },
          ];
        }
      } else if (change.action === 'delete' && change.comment) {
        next.lorebookEntries = entries.filter((e) => e.comment !== change.comment);
      }
    }
  }

  return next;
}

// ════════════════════════════════════════════════════════════════════════════
// 原始 JSON 补丁应用（绕过 cardToDraft → assembleCard 往返，避免数据丢失）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 在原始卡片 JSON 上应用单个补丁。
 *
 * 与 applyCardChatPatch（作用于 WizardDraft）不同，此函数直接操作原始 JSON 结构，
 * 完整保留所有未涉及字段（包括 MVU 脚本、正则、extensions、ST 运行时字段等）。
 */
export function applyPatchToCardData(
  cardData: Record<string, unknown>,
  change: ProposedChange,
): Record<string, unknown> {
  const next = deepClone(cardData);
  const hasNestedData = next.data && typeof next.data === 'object';
  const data = (hasNestedData ? (next.data as Record<string, unknown>) : next) as Record<string, unknown>;

  if (change.field === 'cardName' && typeof change.value === 'string') {
    data.name = change.value;
    if (hasNestedData) next.name = change.value;
  } else if (change.field === 'tags' && Array.isArray(change.value)) {
    data.tags = change.value;
  } else if (change.field === 'firstMessage' && typeof change.value === 'string') {
    data.first_mes = change.value;
  } else if (change.field === 'scenario' && typeof change.value === 'string') {
    data.scenario = change.value;
  } else if (change.field === 'system_prompt' && typeof change.value === 'string') {
    data.system_prompt = change.value;
  } else if (change.field === 'post_history_instructions' && typeof change.value === 'string') {
    data.post_history_instructions = change.value;
  } else if (change.field === 'creator_notes' && typeof change.value === 'string') {
    data.creator_notes = change.value;
  } else if (change.field === 'mvu.statusBarHtml' && typeof change.value === 'string') {
    const ext = (data.extensions || {}) as Record<string, unknown>;
    const scripts = Array.isArray(ext.regex_scripts) ? (ext.regex_scripts as Array<Record<string, unknown>>) : [];
    const target = scripts.find((s) => s.scriptName === REGEX_SCRIPT_NAMES.statusBar);
    if (target) target.replaceString = change.value;
  } else if (change.field === 'liveStreamChat.html' && typeof change.value === 'string') {
    const ext = (data.extensions || {}) as Record<string, unknown>;
    const scripts = Array.isArray(ext.regex_scripts) ? (ext.regex_scripts as Array<Record<string, unknown>>) : [];
    const target = scripts.find((s) => s.scriptName === REGEX_SCRIPT_NAMES.liveChat);
    if (target) target.replaceString = change.value;
  } else if (change.field === 'characters') {
    const meta = (next._meta || {}) as Record<string, unknown>;
    const characters = Array.isArray(meta.characters) ? (meta.characters as Array<Record<string, unknown>>) : [];
    if (change.action === 'replace' && change.id) {
      const idx = characters.findIndex((c) => String(c.id) === String(change.id));
      if (idx >= 0) characters[idx] = { ...characters[idx], ...(typeof change.name === 'string' ? { name: change.name } : {}), ...(typeof change.description === 'string' ? { description: change.description } : {}) };
    } else if (change.action === 'add' && typeof change.description === 'string') {
      characters.push({ id: generateId(), name: change.name || '', description: change.description, entryIds: [] });
    } else if (change.action === 'delete' && change.id) {
      const idx = characters.findIndex((c) => String(c.id) === String(change.id));
      if (idx >= 0) characters.splice(idx, 1);
    }
    meta.characters = characters;
    next._meta = meta;
  } else if (change.field === 'lorebookEntries') {
    const charBook = (data.character_book || undefined) as Record<string, unknown> | undefined;
    if (!charBook) return next;
    const entries = Array.isArray(charBook.entries) ? (charBook.entries as Array<Record<string, unknown>>) : [];
    if (change.action === 'replace' && change.comment) {
      const idx = entries.findIndex((e) => (e.comment || e.name) === change.comment);
      if (idx >= 0) entries[idx] = { ...entries[idx], ...(typeof change.newComment === 'string' ? { comment: change.newComment, name: change.newComment } : {}), ...(typeof change.content === 'string' ? { content: change.content } : {}), ...(Array.isArray(change.keys) ? { keys: change.keys } : {}) };
    } else if (change.action === 'add') {
      const targetComment = change.comment || '';
      const idx = entries.findIndex((e) => (e.comment || e.name) === targetComment);
      if (idx >= 0) {
        entries[idx] = { ...entries[idx], ...(typeof change.content === 'string' ? { content: change.content } : {}), ...(Array.isArray(change.keys) ? { keys: change.keys } : {}) };
      } else {
        const maxId = entries.reduce((m, e) => { const n = typeof e.id === 'number' ? e.id : Number(e.id); return Number.isFinite(n) && n > m ? n : m; }, 0);
        entries.push({ id: maxId + 1, keys: change.keys || [], secondary_keys: [], content: change.content || '', name: targetComment, comment: targetComment, enabled: true, insertion_order: entries.length, case_sensitive: false, selective: false, constant: false, position: 'after_char', priority: 0, use_regex: false });
      }
      charBook.entries = entries;
      data.character_book = charBook;
    } else if (change.action === 'delete' && change.comment) {
      const idx = entries.findIndex((e) => (e.comment || e.name) === change.comment);
      if (idx >= 0) entries.splice(idx, 1);
      charBook.entries = entries;
      data.character_book = charBook;
    }
    if (change.action === 'replace') { charBook.entries = entries; data.character_book = charBook; }
  }

  return next;
}

/** 批量应用补丁到原始卡片 JSON。按顺序依次应用每个 change。 */
export function applyPatchesToCardData(
  cardData: Record<string, unknown>,
  changes: ProposedChange[],
): Record<string, unknown> {
  let result = cardData;
  for (const change of changes) {
    result = applyPatchToCardData(result, change);
  }
  return result;
}