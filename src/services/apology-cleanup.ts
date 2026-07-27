/**
 * 道歉残留清理工具——扫描已有卡片和草稿，剥离 AI 生成内容开头的道歉段落。
 *
 * 用户之前用道歉的 AI 生成的角色卡，已经保存了带道歉内容（如"抱歉，我无法..."
 * 开头的角色描述、世界书条目等）。这个工具批量扫描并清理这些残留。
 *
 * 清理范围：
 * - cards 表：V2 spec 卡片的 data.* 文本字段 + character_book.entries[].content
 * - wizard_drafts 表：WizardDraft 的 characters[].description、lorebookEntries[].content 等
 */
import { db } from '../db/database';
import { stripApologyPrefix } from './ai-service';
import type { WizardDraft } from '../constants/defaults';

/** 清理结果摘要 */
export interface CleanupResult {
  /** 扫描的卡片总数 */
  cardsScanned: number;
  /** 被清理的卡片数 */
  cardsCleaned: number;
  /** 扫描的草稿总数 */
  draftsScanned: number;
  /** 被清理的草稿数 */
  draftsCleaned: number;
  /** 被清理的字段总数 */
  fieldsCleaned: number;
  /** 被清理的字段明细（用于日志/展示） */
  details: Array<{ card: string; field: string; strippedChars: number }>;
}

/** V2 spec 卡片中需要扫描的文本字段路径 */
const CARD_TEXT_FIELDS = [
  'description',
  'first_mes',
  'personality',
  'scenario',
  'system_prompt',
  'mes_example',
  'creator_notes',
  'post_history_instructions',
] as const;

/** WizardDraft 中需要扫描的顶层文本字段 */
const DRAFT_TEXT_FIELDS = [
  'firstMessage',
  'mes_example',
  'personality',
  'scenario',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
  'worldRules',
] as const;

/**
 * 清理单个卡片的道歉残留（原地修改）。
 * 处理 V2 spec (data.*) 和 V1 (顶层) 两种结构。
 * @returns 被清理的字段列表
 */
function cleanCardRecord(
  card: Record<string, unknown>,
  cardName: string,
  details: CleanupResult['details'],
): number {
  let cleanedCount = 0;
  const dataObj = (typeof card.data === 'object' && card.data !== null)
    ? card.data as Record<string, unknown>
    : null;

  // 清理 data.* 和顶层文本字段
  for (const field of CARD_TEXT_FIELDS) {
    // data.* (V2)
    if (dataObj && typeof dataObj[field] === 'string') {
      const original = dataObj[field] as string;
      const cleaned = stripApologyPrefix(original);
      if (cleaned !== original) {
        dataObj[field] = cleaned;
        cleanedCount++;
        details.push({ card: cardName, field: `data.${field}`, strippedChars: original.length - cleaned.length });
      }
    }
    // 顶层 (V1)
    if (typeof card[field] === 'string') {
      const original = card[field] as string;
      const cleaned = stripApologyPrefix(original);
      if (cleaned !== original) {
        card[field] = cleaned;
        cleanedCount++;
        details.push({ card: cardName, field, strippedChars: original.length - cleaned.length });
      }
    }
  }

  // 清理 alternate_greetings[] (数组，每项是字符串)
  const cleanGreetings = (greetings: unknown): boolean => {
    if (!Array.isArray(greetings)) return false;
    let changed = false;
    for (let i = 0; i < greetings.length; i++) {
      if (typeof greetings[i] === 'string') {
        const original = greetings[i] as string;
        const cleaned = stripApologyPrefix(original);
        if (cleaned !== original) {
          greetings[i] = cleaned;
          changed = true;
          cleanedCount++;
          details.push({ card: cardName, field: 'alternate_greetings[]', strippedChars: original.length - cleaned.length });
        }
      }
    }
    return changed;
  };
  if (dataObj) cleanGreetings(dataObj.alternate_greetings);
  cleanGreetings(card.alternate_greetings);

  // 清理 character_book.entries[].content
  const cleanBookEntries = (book: unknown): boolean => {
    if (typeof book !== 'object' || book === null) return false;
    const bookObj = book as Record<string, unknown>;
    if (!Array.isArray(bookObj.entries)) return false;
    let changed = false;
    for (const entry of bookObj.entries) {
      if (typeof entry === 'object' && entry !== null) {
        const entryObj = entry as Record<string, unknown>;
        if (typeof entryObj.content === 'string') {
          const original = entryObj.content as string;
          const cleaned = stripApologyPrefix(original);
          if (cleaned !== original) {
            entryObj.content = cleaned;
            changed = true;
            cleanedCount++;
            const entryName = (typeof entryObj.name === 'string' ? entryObj.name : '') || (typeof entryObj.comment === 'string' ? entryObj.comment : '?');
            details.push({ card: cardName, field: `character_book.entries[${entryName}].content`, strippedChars: original.length - cleaned.length });
          }
        }
      }
    }
    return changed;
  };
  if (dataObj) cleanBookEntries(dataObj.character_book);
  cleanBookEntries(card.character_book);

  return cleanedCount;
}

/**
 * 清理单个 WizardDraft 的道歉残留（原地修改）。
 * @returns 被清理的字段数
 */
function cleanWizardDraft(
  draft: WizardDraft,
  draftName: string,
  details: CleanupResult['details'],
): number {
  let cleanedCount = 0;

  // 顶层文本字段
  for (const field of DRAFT_TEXT_FIELDS) {
    const value = draft[field as keyof WizardDraft];
    if (typeof value === 'string' && value) {
      const cleaned = stripApologyPrefix(value);
      if (cleaned !== value) {
        (draft as unknown as Record<string, unknown>)[field] = cleaned;
        cleanedCount++;
        details.push({ card: draftName, field, strippedChars: value.length - cleaned.length });
      }
    }
  }

  // characters[].description
  if (Array.isArray(draft.characters)) {
    for (const char of draft.characters) {
      if (typeof char.description === 'string' && char.description) {
        const original = char.description;
        const cleaned = stripApologyPrefix(original);
        if (cleaned !== original) {
          char.description = cleaned;
          cleanedCount++;
          details.push({ card: draftName, field: `characters[${char.name}].description`, strippedChars: original.length - cleaned.length });
        }
      }
    }
  }

  // lorebookEntries[].content
  if (Array.isArray(draft.lorebookEntries)) {
    for (const entry of draft.lorebookEntries) {
      if (typeof entry.content === 'string' && entry.content) {
        const original = entry.content;
        const cleaned = stripApologyPrefix(original);
        if (cleaned !== original) {
          entry.content = cleaned;
          cleanedCount++;
          details.push({ card: draftName, field: `lorebookEntries[${entry.comment || entry.name}].content`, strippedChars: original.length - cleaned.length });
        }
      }
    }
  }

  // alternate_greetings[]
  if (Array.isArray(draft.alternate_greetings)) {
    for (let i = 0; i < draft.alternate_greetings.length; i++) {
      if (typeof draft.alternate_greetings[i] === 'string') {
        const original = draft.alternate_greetings[i];
        const cleaned = stripApologyPrefix(original);
        if (cleaned !== original) {
          draft.alternate_greetings[i] = cleaned;
          cleanedCount++;
          details.push({ card: draftName, field: `alternate_greetings[${i}]`, strippedChars: original.length - cleaned.length });
        }
      }
    }
  }

  return cleanedCount;
}

/**
 * 批量清理所有已有卡片和草稿的道歉残留。
 * 扫描 cards 表（未软删）和 wizard_drafts 表，剥离道歉前缀并保存。
 */
export async function cleanAllApologies(): Promise<CleanupResult> {
  const details: CleanupResult['details'] = [];
  let cardsCleaned = 0;
  let draftsCleaned = 0;
  let fieldsCleaned = 0;

  // 1. 清理 cards 表
  const allCards = await db.cards.toArray();
  const cardsScanned = allCards.length;
  const cardsToUpdate: Array<{ id: number; record: Record<string, unknown> }> = [];

  for (const card of allCards) {
    // 跳过软删的卡片
    if (card.deletedAt) continue;
    const record = card as unknown as Record<string, unknown>;
    const cardName = (typeof record.name === 'string' ? record.name : '') || `#${card.id}`;
    const fieldCount = cleanCardRecord(record, cardName, details);
    fieldsCleaned += fieldCount;
    if (fieldCount > 0) {
      cardsCleaned++;
      cardsToUpdate.push({ id: card.id!, record });
    }
  }

  // 批量保存清理后的卡片
  if (cardsToUpdate.length > 0) {
    await db.cards.bulkPut(cardsToUpdate.map(({ id, record }) => ({
      ...record,
      id,
      updatedAt: new Date(),
    })) as never[]);
  }

  // 2. 清理 wizard_drafts 表
  const allDrafts = await db.wizard_drafts.toArray();
  const draftsScanned = allDrafts.length;
  const draftsToUpdate: Array<{ id: string; record: Record<string, unknown> }> = [];

  for (const draftRecord of allDrafts) {
    const draftData = draftRecord.data as WizardDraft;
    if (!draftData || typeof draftData !== 'object') continue;
    const draftName = draftRecord.name || draftData.cardName || `草稿 ${draftRecord.id}`;
    const fieldCount = cleanWizardDraft(draftData, draftName, details);
    fieldsCleaned += fieldCount;
    if (fieldCount > 0) {
      draftsCleaned++;
      // 保留原始记录的所有字段（currentStep, name, messages 等），只替换 data
      draftsToUpdate.push({
        id: draftRecord.id,
        record: { ...draftRecord as unknown as Record<string, unknown>, data: draftData, updatedAt: new Date() },
      });
    }
  }

  // 批量保存清理后的草稿
  if (draftsToUpdate.length > 0) {
    await db.wizard_drafts.bulkPut(draftsToUpdate.map(({ id, record }) => ({
      ...record,
      id,
    })) as never[]);
  }

  return {
    cardsScanned,
    cardsCleaned,
    draftsScanned,
    draftsCleaned,
    fieldsCleaned,
    details,
  };
}
