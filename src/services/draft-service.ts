/**
 * Draft box service — manages multiple wizard drafts in IndexedDB.
 *
 * Design:
 *   - Wizard auto-save uses the fixed ID 'new' for crash recovery.
 *   - Wizard manual saves create new draft records with random UUIDs and a display name.
 *   - Card-editor drafts use the 'card-editor-' ID prefix to stay isolated from wizard drafts:
 *       • Auto-save: fixed ID 'card-editor-new'
 *       • Manual saves: random UUIDs prefixed with 'card-editor-'
 */
import { db, type WizardDraftRecord } from '../db/database';
import type { WizardDraft } from '../constants/defaults';
import { WIZARD_DRAFT_VERSION } from '../constants/defaults';

const AUTO_DRAFT_KEY = 'new';
const CARD_EDITOR_AUTO_DRAFT_KEY = 'card-editor-new';
const CARD_EDITOR_DRAFT_PREFIX = 'card-editor-';

// 草稿版本迁移（纯函数）单独放在 draft-migration.ts，便于单测；此处转发导出。
export { migrateDraftRecord, type MigratedDraftPayload } from './draft-migration';

/** Chat message shape persisted alongside card-editor drafts */
export interface CardEditorChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function generateDraftId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for environments where randomUUID is unavailable (e.g. non-secure contexts)
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

function defaultDraftName(draft: WizardDraft): string {
  const cardName = draft.cardName?.trim();
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return cardName ? `${cardName} ${timeStr}` : `未命名草稿 ${timeStr}`;
}

/**
 * Strip the trailing time suffix that defaultDraftName / defaultCardEditorDraftName
 * append to auto-generated names (e.g. "卡片名 07/26 14:30" → "卡片名").
 * Used when displaying draft titles so the save time isn't duplicated — the small
 * subtitle below the title already shows updatedAt.
 *
 * User-renamed drafts are unaffected unless they happen to end with a matching
 * "MM/DD HH:MM" pattern, which is rare.
 */
export function stripTrailingTime(name: string): string {
  return (name || '').replace(/\s+\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}\s*$/, '').trim();
}

export async function saveManualDraft(
  draft: WizardDraft,
  currentStep: number,
  name?: string,
): Promise<WizardDraftRecord> {
  const record: WizardDraftRecord = {
    id: generateDraftId(),
    data: draft,
    currentStep,
    version: WIZARD_DRAFT_VERSION,
    updatedAt: new Date(),
    name: name?.trim() || defaultDraftName(draft),
  };
  await db.wizard_drafts.put(record);
  return record;
}

export async function listManualDrafts(): Promise<WizardDraftRecord[]> {
  const all = await db.wizard_drafts.toArray();
  return all
    .filter((d) => d.id !== AUTO_DRAFT_KEY && !d.id.startsWith(CARD_EDITOR_DRAFT_PREFIX))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function loadDraft(id: string): Promise<WizardDraftRecord | undefined> {
  return db.wizard_drafts.get(id);
}

export async function deleteDraft(id: string): Promise<void> {
  await db.wizard_drafts.delete(id);
}

export async function renameDraft(id: string, name: string): Promise<void> {
  const draft = await db.wizard_drafts.get(id);
  if (!draft) return;
  await db.wizard_drafts.put({
    ...draft,
    name: name.trim() || draft.name,
    updatedAt: new Date(),
  });
}

/** Update the cover image of a wizard draft (null clears it). */
export async function updateDraftCover(id: string, blob: Blob | null): Promise<void> {
  const draft = await db.wizard_drafts.get(id);
  if (!draft) return;
  if (blob) {
    await db.wizard_drafts.put({
      ...draft,
      coverImageBlob: blob,
      updatedAt: new Date(),
    });
  } else {
    const next = { ...draft, updatedAt: new Date() } as Partial<WizardDraftRecord>;
    delete next.coverImageBlob;
    await db.wizard_drafts.put(next as WizardDraftRecord);
  }
}

export async function saveAutoDraft(draft: WizardDraft, currentStep: number): Promise<void> {
  await db.wizard_drafts.put({
    id: AUTO_DRAFT_KEY,
    data: draft,
    currentStep,
    version: WIZARD_DRAFT_VERSION,
    updatedAt: new Date(),
  });
}

export async function loadAutoDraft(): Promise<WizardDraftRecord | undefined> {
  return db.wizard_drafts.get(AUTO_DRAFT_KEY);
}

/**
 * 判断自动草稿（'new'）里是否已有用户的实质内容。
 * 用于「从草稿箱打开草稿」前的覆盖确认：加载别的草稿后，防抖自动保存会在
 * 500ms 内把新内容写进 'new'，静默顶掉正在进行的创作。
 */
export async function autoDraftHasContent(): Promise<boolean> {
  const saved = await loadAutoDraft();
  const d = saved?.data as Partial<WizardDraft> | undefined;
  if (!d) return false;
  return Boolean(
    d.cardName?.trim() ||
    d.firstMessage?.trim() ||
    (d.characters ?? []).some((c) => c?.name?.trim() || c?.description?.trim()) ||
    (d.lorebookEntries ?? []).length > 0,
  );
}

export async function clearAutoDraft(): Promise<void> {
  await db.wizard_drafts.delete(AUTO_DRAFT_KEY);
}

// ════════════════════════════════════════════════════════════════════════════
// Card-editor drafts (independent ID namespace, prefixed with 'card-editor-')
// ════════════════════════════════════════════════════════════════════════════

function defaultCardEditorDraftName(draft: WizardDraft): string {
  const cardName = draft.cardName?.trim();
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return cardName ? `${cardName} ${timeStr}` : `编辑室草稿 ${timeStr}`;
}

function makeCardEditorDraftId(): string {
  return `${CARD_EDITOR_DRAFT_PREFIX}${generateDraftId()}`;
}

/** Auto-save the card-editor state for crash recovery (id: 'card-editor-new'). */
export async function saveCardEditorAutoDraft(
  draft: WizardDraft,
  messages: CardEditorChatMessage[],
  coverSource: 'imported' | 'custom' | 'default',
  coverImageBlob?: Blob | null,
): Promise<void> {
  await db.wizard_drafts.put({
    id: CARD_EDITOR_AUTO_DRAFT_KEY,
    data: draft,
    currentStep: 0,
    version: WIZARD_DRAFT_VERSION,
    updatedAt: new Date(),
    messages,
    coverSource,
    coverImageBlob: coverImageBlob ?? undefined,
  });
}

export async function loadCardEditorAutoDraft(): Promise<WizardDraftRecord | undefined> {
  return db.wizard_drafts.get(CARD_EDITOR_AUTO_DRAFT_KEY);
}

export async function clearCardEditorAutoDraft(): Promise<void> {
  await db.wizard_drafts.delete(CARD_EDITOR_AUTO_DRAFT_KEY);
}

/** Manually save a named card-editor draft. Returns the created record. */
export async function saveCardEditorDraft(
  draft: WizardDraft,
  messages: CardEditorChatMessage[],
  coverSource: 'imported' | 'custom' | 'default',
  coverImageBlob: Blob | null | undefined,
  name?: string,
): Promise<WizardDraftRecord> {
  const record: WizardDraftRecord = {
    id: makeCardEditorDraftId(),
    data: draft,
    currentStep: 0,
    version: WIZARD_DRAFT_VERSION,
    updatedAt: new Date(),
    name: name?.trim() || defaultCardEditorDraftName(draft),
    messages,
    coverSource,
    coverImageBlob: coverImageBlob ?? undefined,
  };
  await db.wizard_drafts.put(record);
  return record;
}

export async function listCardEditorDrafts(): Promise<WizardDraftRecord[]> {
  const all = await db.wizard_drafts.toArray();
  return all
    .filter((d) => d.id.startsWith(CARD_EDITOR_DRAFT_PREFIX) && d.id !== CARD_EDITOR_AUTO_DRAFT_KEY)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function loadCardEditorDraft(id: string): Promise<WizardDraftRecord | undefined> {
  if (!id.startsWith(CARD_EDITOR_DRAFT_PREFIX)) return undefined;
  return db.wizard_drafts.get(id);
}

export async function deleteCardEditorDraft(id: string): Promise<void> {
  if (!id.startsWith(CARD_EDITOR_DRAFT_PREFIX)) return;
  await db.wizard_drafts.delete(id);
}

/** Update the cover image of a card-editor draft (null clears it). */
export async function updateCardEditorDraftCover(id: string, blob: Blob | null): Promise<void> {
  if (!id.startsWith(CARD_EDITOR_DRAFT_PREFIX)) return;
  const draft = await db.wizard_drafts.get(id);
  if (!draft) return;
  if (blob) {
    await db.wizard_drafts.put({
      ...draft,
      coverImageBlob: blob,
      updatedAt: new Date(),
    });
  } else {
    const next = { ...draft, updatedAt: new Date() } as Partial<WizardDraftRecord>;
    delete next.coverImageBlob;
    await db.wizard_drafts.put(next as WizardDraftRecord);
  }
}
