/**
 * lorebook-predicates — 判断世界书条目「归属/可编辑性」的纯谓词。
 *
 * 从 card-exporter 抽出的原因不是那个文件大，而是耦合方向不对：
 * 这三个谓词里有两个根本不参与卡片正反映射，却有 6 个模块
 * （card-optimizer / card-chat-optimizer / quality-checker / WizardPage /
 * StepWorldBook / StepPolishExport）为了它们去 import card-exporter，
 * 连带把 mvu-builder、staged-lorebook-builder、card-fixers 整条依赖图拖进来。
 *
 * 本模块只依赖 constants/defaults 与 staged-lorebook-builder，
 * 且不反向依赖 card-exporter（card-exporter 单向 import 本模块）。
 */
import type { LorebookEntry, WizardDraft } from '../constants/defaults';
import { MVU_LOREBOOK_ENTRY_NAMES } from '../constants/defaults';
import { parseDispatcherContent } from './staged-lorebook-builder';

/**
 * 检测哪些世界书条目属于分阶段世界书系统。
 * 返回需要过滤掉的条目索引集合（MVU 未启用时不应导出）。
 */
export function findStagedLorebookEntryIndices(entries: LorebookEntry[]): Set<number> {
  const indices = new Set<number>();
  const childComments = new Set<string>();

  entries.forEach((entry, idx) => {
    const parsed = parseDispatcherContent(entry.content || '');
    if (parsed) {
      indices.add(idx);
      parsed.childComments.forEach((c) => childComments.add(c));
    }
  });

  entries.forEach((entry, idx) => {
    if (indices.has(idx)) return;
    const comment = entry.comment || '';
    const name = entry.name || '';
    if (childComments.has(comment) || childComments.has(name)) {
      indices.add(idx);
    }
  });

  return indices;
}

export function isProtectedLorebookEntry(entry: LorebookEntry, idx: number, stagedIndices: Set<number>): boolean {
  const name = (entry.name || '').trim();
  const comment = (entry.comment || '').trim();
  return MVU_LOREBOOK_ENTRY_NAMES.includes(name) || MVU_LOREBOOK_ENTRY_NAMES.includes(comment) || stagedIndices.has(idx);
}

/**
 * 角色设定条目的命名约定（`syncCharacterEntries` 生成、`cardToDraft` 反解都靠它）：
 *   主条目 `${name} - 角色设定`，分块续篇 `${name} - 角色设定 (2)`。
 * comment 侧是 `${name}的角色设定` / `${name}的角色设定 (续2)`，两侧都要认。
 */
function characterEntryPattern(charName: string): RegExp {
  const escaped = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\s*(?:-\\s*角色设定|的角色设定)(?:\\s*[（(](?:续)?\\d+[）)])?$`);
}

/** 空白不敏感归一：同步分块用 '\n\n' 重新拼接，原文段间若是 3+ 换行就不再是字面子串。 */
function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 角色描述是否已经同步进世界书条目（导出时据此决定要不要写 `data.description`，
 * token 预算据此决定要不要把描述单独计一次）。
 *
 * 判定按角色限定 + 覆盖率，而不是「任意条目内容是描述的子串」：
 *   - 只看该角色自己的「角色设定」条目 → 第三方卡里恰好复述了某条世界书内容的
 *     描述不会被误杀，多角色之间也不会互相误伤；
 *   - 要求这些条目近乎覆盖整段描述 → 长描述分块（>2000 字切多条）仍判定为已同步。
 *
 * 单一来源：card-exporter 与 token-budget 都调这里，不要再各自复制一份启发式。
 */
export function isCharacterDescriptionSynced(
  charName: string,
  description: string,
  entries: Array<{ name?: string; comment?: string; content?: string }>,
): boolean {
  const normalizedDesc = normalizeForCompare(description || '');
  if (!normalizedDesc) return false;
  const pattern = characterEntryPattern((charName || '').trim());
  const own = entries.filter((e) => pattern.test((e.name || '').trim()) || pattern.test((e.comment || '').trim()));
  if (own.length === 0) return false;
  const covered = own
    .map((e) => normalizeForCompare(e.content || ''))
    .filter((c) => c.length > 0 && normalizedDesc.includes(c))
    .reduce((sum, c) => sum + c.length, 0);
  // 近乎全覆盖才算已同步；用户改写过描述（旧条目只剩零星重合）时判定为未同步
  return covered >= normalizedDesc.length * 0.9;
}

/** Returns the editable (non-protected) lorebook entries, accounting for staged mode. */
export function editableLorebookEntries(draft: WizardDraft): LorebookEntry[] {
  let stagedIndices = new Set<number>();
  if (draft.stagedMode?.enabled) {
    try {
      stagedIndices = findStagedLorebookEntryIndices(draft.lorebookEntries || []);
    } catch {
      stagedIndices = new Set();
    }
  }
  return (draft.lorebookEntries || []).filter((entry, idx) => !isProtectedLorebookEntry(entry, idx, stagedIndices));
}
