/**
 * worldbook-io — 独立世界书（SillyTavern World Info）JSON 导入/导出（S2-4）。
 *
 * SillyTavern 世界书 JSON 格式（World Info 导入/导出）：
 *   { "entries": [...], "name": "书名", "extensions": {} }
 * 条目字段与角色卡内嵌 character_book 不同：keys 叫 key、secondary_keys 叫
 * keysecondary、运行时字段（probability/group/depth/role/...）直接平铺而非放
 * extensions。这里负责双向转换 + 按标题合并，供卡片库「导出世界书 / 导入世界书」
 * 使用。
 */
import { createEmptyLorebookEntry, generateId } from '../constants/defaults';
import type { LorebookEntry, LorebookPosition } from '../constants/defaults';

const POSITIONS = new Set<LorebookPosition>([
  'before_char',
  'after_char',
  'before_example',
  'after_example',
  'before_author',
  'after_author',
  'at_depth',
]);

/** SillyTavern World Info 条目的平铺结构（导入/导出共用）。 */
export interface WorldInfoEntry {
  uid: number;
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  insertion_order: number;
  enabled: boolean;
  position: LorebookPosition;
  exclude_recursion: boolean;
  prevent_recursion: boolean;
  delay_until_recursion: boolean;
  probability: number;
  useProbability: boolean;
  depth: number;
  group: string;
  groupOverride: boolean;
  groupWeight: number;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useRegex: boolean;
  automationId: string;
  role: number;
  sticky: number;
  cooldown: number;
  delay: number;
  displayIndex: number;
  extensions: Record<string, unknown>;
}

/** LorebookEntry → SillyTavern World Info 条目。 */
export function lorebookEntryToWorldInfoEntry(
  entry: LorebookEntry,
  uid: number,
  displayIndex: number,
): WorldInfoEntry {
  return {
    uid,
    key: [...(entry.keys || [])],
    keysecondary: [...(entry.secondary_keys || [])],
    comment: entry.comment || entry.name || '',
    content: entry.content || '',
    constant: entry.constant ?? false,
    selective: entry.selective ?? false,
    insertion_order: entry.insertion_order ?? displayIndex,
    enabled: entry.enabled ?? true,
    position: entry.position ?? 'after_char',
    exclude_recursion: entry.exclude_recursion ?? false,
    prevent_recursion: entry.prevent_recursion ?? false,
    delay_until_recursion: false,
    probability: entry.probability ?? 100,
    useProbability: true,
    depth: entry.depth ?? 4,
    group: entry.group || '',
    groupOverride: false,
    groupWeight: entry.group_weight ?? 100,
    scanDepth: null,
    caseSensitive: entry.case_sensitive ? true : null,
    matchWholeWords: entry.match_whole_words ?? true,
    useRegex: entry.use_regex ?? false,
    automationId: '',
    role: entry.role ?? 0,
    sticky: entry.sticky ?? 0,
    cooldown: entry.cooldown ?? 0,
    delay: entry.delay ?? 0,
    displayIndex,
    extensions: {},
  };
}

/** SillyTavern World Info 条目 → LorebookEntry（重新分配草稿 id）。 */
export function worldInfoEntryToLorebookEntry(raw: Record<string, unknown>): LorebookEntry {
  const base = createEmptyLorebookEntry();
  const position = raw.position as LorebookPosition;
  // 卡片 JSON 的 data.character_book 把运行时字段放在 entry.extensions 里，
  // 独立世界书 JSON 则平铺在顶层。这里统一"顶层优先、extensions 兜底"。
  const ext = (raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}) as Record<string, unknown>;
  const num = (a: unknown, b: unknown, def: number): number => {
    if (typeof a === 'number') return a;
    if (typeof b === 'number') return b;
    return def;
  };
  const str = (a: unknown, b: unknown, def = ''): string => {
    const v = a ?? b;
    return v === undefined || v === null ? def : String(v);
  };
  const bool = (a: unknown, b: unknown, def = false): boolean => {
    if (typeof a === 'boolean') return a;
    if (typeof b === 'boolean') return b;
    return def;
  };
  const boolOrNull = (a: unknown, b: unknown, def: boolean | null = false): boolean | null => {
    if (typeof a === 'boolean') return a;
    if (a === null) return null;
    if (typeof b === 'boolean') return b;
    if (b === null) return null;
    return def;
  };
  return {
    ...base,
    id: generateId(),
    name: String(raw.comment ?? '') || String(raw.name ?? ''),
    comment: String(raw.comment ?? raw.name ?? ''),
    keys: Array.isArray(raw.key) ? (raw.key as unknown[]).map(String) : Array.isArray(raw.keys) ? (raw.keys as unknown[]).map(String) : [],
    secondary_keys: Array.isArray(raw.keysecondary)
      ? (raw.keysecondary as unknown[]).map(String)
      : Array.isArray(raw.secondary_keys)
        ? (raw.secondary_keys as unknown[]).map(String)
        : [],
    content: String(raw.content ?? ''),
    constant: Boolean(raw.constant),
    selective: Boolean(raw.selective),
    insertion_order: num(raw.insertion_order, ext.insertion_order, 100),
    enabled: raw.enabled !== false,
    position: POSITIONS.has(position) ? position : 'after_char',
    exclude_recursion: bool(raw.exclude_recursion, ext.exclude_recursion),
    prevent_recursion: bool(raw.prevent_recursion, ext.prevent_recursion),
    probability: num(raw.probability, ext.probability, 100),
    depth: num(raw.depth, ext.depth, 4),
    group: str(raw.group, ext.group),
    group_weight: num(raw.groupWeight, num(raw.group_weight, ext.group_weight, 100), 100),
    selectiveLogic: num(raw.selectiveLogic, ext.selectiveLogic, 0),
    role: num(raw.role, ext.role, 0),
    sticky: num(raw.sticky, ext.sticky, 0),
    cooldown: num(raw.cooldown, ext.cooldown, 0),
    delay: num(raw.delay, ext.delay, 0),
    use_regex: bool(raw.useRegex, raw.use_regex, false),
    match_whole_words: boolOrNull(raw.matchWholeWords, boolOrNull(raw.match_whole_words, ext.match_whole_words, true), true),
    case_sensitive: bool(raw.caseSensitive, bool(raw.case_sensitive, ext.case_sensitive, false), false),
    ignore_budget: bool(raw.ignoreBudget, bool(raw.ignore_budget, ext.ignore_budget, false)),
  };
}

/** 构建 SillyTavern World Info JSON 对象。 */
export function buildWorldInfoJson(entries: LorebookEntry[], name: string): {
  entries: WorldInfoEntry[];
  name: string;
  extensions: Record<string, unknown>;
} {
  return {
    entries: entries.map((e, i) => lorebookEntryToWorldInfoEntry(e, i + 1, i)),
    name: name || '',
    extensions: {},
  };
}

/** 解析 SillyTavern World Info JSON（兼容卡片 JSON 里的 data.character_book）。 */
export function parseWorldInfoJson(text: string): { name: string; entries: LorebookEntry[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON 内容不是对象');

  const root = parsed as Record<string, unknown>;
  const book = (root.data as Record<string, unknown> | undefined)?.character_book as Record<string, unknown> | undefined;
  const rawEntries = Array.isArray(root.entries)
    ? (root.entries as unknown[])
    : Array.isArray(book?.entries)
      ? (book.entries as unknown[])
      : null;
  if (!rawEntries) throw new Error('未找到世界书条目（缺少 entries 字段）');

  return {
    name: String(root.name ?? book?.name ?? ''),
    entries: rawEntries
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => worldInfoEntryToLorebookEntry(e)),
  };
}

/** 按标题（comment || name）合并：同标题条目整体覆盖（保留原 id），其余追加。 */
export function mergeLorebookEntries(existing: LorebookEntry[], incoming: LorebookEntry[]): LorebookEntry[] {
  const byTitle = new Map<string, number>();
  existing.forEach((e, i) => {
    const title = (e.comment || e.name || '').trim().toLowerCase();
    if (title) byTitle.set(title, i);
  });

  const merged = [...existing];
  for (const inc of incoming) {
    const title = (inc.comment || inc.name || '').trim().toLowerCase();
    const hit = title ? byTitle.get(title) : undefined;
    if (hit !== undefined) {
      // 保留原 id 与 fromAnchor 等本工具运行时标记，内容以导入为准
      const prev = merged[hit];
      merged[hit] = { ...inc, id: prev.id, fromAnchor: prev.fromAnchor };
    } else {
      merged.push(inc);
      if (title) byTitle.set(title, merged.length - 1);
    }
  }
  return merged;
}

/** 触发浏览器下载（JSON 文件）。 */
export function downloadWorldbookJson(entries: LorebookEntry[], name: string) {
  const json = JSON.stringify(buildWorldInfoJson(entries, name), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(name || 'world-info').replace(/[\\/:*?"<>|]/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 部分浏览器若在 click 后立即 revoke 会中断下载，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
