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
