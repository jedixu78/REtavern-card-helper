/**
 * Utilities for lorebook revise flow.
 * Extracted from LorebookReviewDialog so they can be tested without React context.
 */
import type { LorebookEntry, LorebookPosition, AIGeneratedLorebookEntry } from '../constants/defaults';
import { createEmptyLorebookEntry } from '../constants/defaults';

/** 把 AI 返回的 AIGeneratedLorebookEntry[] 映射为完整 LorebookEntry[]（重新分配 id）。 */
export function mapAiEntriesToLorebookEntries(items: AIGeneratedLorebookEntry[]): LorebookEntry[] {
  return items.map((item) => {
    const base = createEmptyLorebookEntry();
    const secondaryKeys = item.secondary_keys || [];
    return {
      ...base,
      name: item.name || '',
      keys: item.keys || [],
      secondary_keys: secondaryKeys,
      content: item.content || '',
      comment: item.comment || item.name || '',
      constant: item.constant ?? false,
      selective: secondaryKeys.length > 0 ? item.selective ?? true : false,
      insertion_order: item.insertion_order ?? 100,
      position: (item.position ?? 'after_char') as LorebookPosition,
      priority: item.priority ?? 50,
      probability: item.probability ?? 100,
      group: item.group || '',
      group_weight: item.group_weight ?? 100,
      selectiveLogic: item.selectiveLogic ?? 0,
      role: item.role ?? 0,
      depth: item.depth ?? 4,
      exclude_recursion: item.exclude_recursion ?? false,
      prevent_recursion: item.prevent_recursion ?? false,
      use_regex: item.use_regex ?? false,
      match_whole_words: item.match_whole_words ?? true,
      sticky: item.sticky ?? 0,
      cooldown: item.cooldown ?? 0,
      delay: item.delay ?? 0,
      ignore_budget: item.ignore_budget ?? false,
    } as LorebookEntry;
  });
}
