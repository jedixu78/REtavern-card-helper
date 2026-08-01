import { MVU_LOREBOOK_ENTRY_NAMES, REGEX_SCRIPT_NAMES } from '../constants/defaults';

/**
 * Card Validator - validates a card against SillyTavern Character Card V2/V3 spec.
 *
 * V2 Spec: https://github.com/malfoyslastname/character-card-spec-v2
 * V3 Spec: https://github.com/malfoyslastname/character-card-spec-v3
 *
 * Returns errors (blocking) and warnings (non-blocking).
 *
 * `validateCardHardFails` 是更上层的「零分否决」层：命中任一规则即整卡不可发布，
 * 与 `validateCard` 的 errors/warnings 评分解耦。它专防 CLAUDE.md 反复警告的
 * 「阶段不切换」「MVU 运行时崩」「正则名断线」等根因类 bug。
 */

/** 原型污染防御：MVU 路径中禁止出现的键（与 mvu-sim.ts 的 FORBIDDEN_KEYS 同源）。 */
const HARD_FAIL_FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ACCEPTABLE_SPECS = ['chara_card_v2', 'chara_card_v3'];
const ACCEPTABLE_SPEC_VERSIONS = ['2.0', '3.0'];

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface ValidationOptions {
  stagedLorebookEntryIndices?: Set<number>;
}

const VALID_POSITIONS = [
  'before_char',
  'after_char',
  'before_example',
  'after_example',
  'before_author',
  'after_author',
  'at_depth',
];

export function validateCard(card: Record<string, unknown>, options: ValidationOptions = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Spec envelope validation (accept V2 and V3) ────────────────────────
  if (!card.spec || !ACCEPTABLE_SPECS.includes(card.spec as string)) {
    errors.push('缺少 spec: "chara_card_v2" 或 "chara_card_v3"');
  }

  if (!card.spec_version || !ACCEPTABLE_SPEC_VERSIONS.includes(card.spec_version as string)) {
    errors.push('缺少 spec_version: "2.0" 或 "3.0"');
  }

  const data = card.data as Record<string, unknown> | undefined;

  if (!data) {
    errors.push('缺少 data 对象');
    return { valid: false, errors, warnings };
  }

  // ── Required V1 fields (nested in data) ────────────────────────────────
  if (!data.name || typeof data.name !== 'string') {
    errors.push('卡片名称 (name) 是必填项');
  }

  // 国内写卡通常把角色设定放在世界书，description 保持为空是正常做法

  if (!data.first_mes || typeof data.first_mes !== 'string') {
    warnings.push('开场白 (first_mes) 为空 — 对话将没有开场');
  }

  // personality, scenario, mes_example can be empty strings per spec
  if (data.personality !== undefined && typeof data.personality !== 'string') {
    warnings.push('personality 应为字符串类型');
  }

  if (data.scenario !== undefined && typeof data.scenario !== 'string') {
    warnings.push('scenario 应为字符串类型');
  }

  // ── V2 specific fields ─────────────────────────────────────────────────
  // extensions must exist and default to {}
  if (data.extensions !== undefined && typeof data.extensions !== 'object') {
    errors.push('extensions 必须是对象类型');
  }

  // alternate_greetings should be an array
  if (data.alternate_greetings !== undefined && !Array.isArray(data.alternate_greetings)) {
    warnings.push('alternate_greetings 应为数组');
  }

  // tags should be an array of strings
  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags)) {
      warnings.push('tags 应为字符串数组');
    }
  }

  // ── character_book validation ──────────────────────────────────────────
  const charBook = data.character_book as Record<string, unknown> | undefined;
  if (charBook) {
    // character_book.extensions must exist
    if (charBook.extensions !== undefined && typeof charBook.extensions !== 'object') {
      warnings.push('character_book.extensions 应为对象');
    }

    if (charBook.entries && Array.isArray(charBook.entries)) {
      let enabledCount = 0;
      let emptyContentCount = 0;
      let missingKeysCount = 0;

      charBook.entries.forEach((entry: Record<string, unknown>, i: number) => {
        const entryName = (entry.name as string) || `条目 ${i + 1}`;
        const keys = Array.isArray(entry.keys) ? entry.keys as string[] : [];
        const secondaryKeys = Array.isArray(entry.secondary_keys) ? entry.secondary_keys as string[] : [];
        const content = typeof entry.content === 'string' ? entry.content : '';
        const enabled = entry.enabled !== false;
        const constant = entry.constant === true;
        const selective = entry.selective === true;
        const probability = entry.extensions && typeof entry.extensions === 'object'
          ? ((entry.extensions as Record<string, unknown>).probability as number | undefined)
          : undefined;

        if (enabled) enabledCount++;
        if (!content.trim()) emptyContentCount++;

        // keys: required for non-constant entries
        if (!entry.keys || !Array.isArray(entry.keys)) {
          if (enabled) {
            missingKeysCount++;
          }
        } else if (enabled && keys.length === 0 && !constant) {
          missingKeysCount++;
        }

        if (!constant && keys.some((key) => key.trim().length === 1)) {
          warnings.push(`世界书条目 "${entryName}" 存在单字符触发词，容易误触发`);
        }

        if (selective && secondaryKeys.length === 0 && !options.stagedLorebookEntryIndices?.has(i)) {
          warnings.push(`世界书条目 "${entryName}" 启用了 selective 但没有 secondary_keys`);
        }

        if (enabled && probability === 0) {
          warnings.push(`世界书条目 "${entryName}" 的 probability 为 0，启用后也不会触发`);
        }

        // content: should not be empty
        if (!content.trim()) {
          warnings.push(`世界书条目 "${entryName}" 内容为空`);
        }

        // insertion_order: should be a number
        if (entry.insertion_order !== undefined && typeof entry.insertion_order !== 'number') {
          warnings.push(`世界书条目 "${entryName}" 的 insertion_order 应为数字`);
        }

        // position validation
        if (entry.position && !VALID_POSITIONS.includes(entry.position as string)) {
          warnings.push(`世界书条目 "${entryName}" 的 position 值无效`);
        }

        // entry.extensions must exist
        if (entry.extensions !== undefined && typeof entry.extensions !== 'object') {
          warnings.push(`世界书条目 "${entryName}" 的 extensions 应为对象`);
        }
      });

      if (enabledCount === 0 && charBook.entries.length > 0) {
        warnings.push('所有世界书条目都处于禁用状态');
      }

      if (missingKeysCount > 0) {
        warnings.push(`${missingKeysCount} 个启用的非常量世界书条目没有触发关键词`);
      }

      if (emptyContentCount > 3) {
        warnings.push(`存在 ${emptyContentCount} 个空内容世界书条目，建议导出前清理`);
      }

      // ── MVU entries validation ──────────────────────────────────────────
      // MVU 相关警告只在卡片明确启用 MVU（extensions.mvu_enabled === true）时才会产生。
      // 如果用户没有启用 MVU，即使世界书中残留 MVU 条目，也不应报 MVU 专用警告，
      // 更不应要求安装 MVU 脚本/正则。
      const ext = (data.extensions || {}) as Record<string, unknown>;
      const mvuEnabled = ext.mvu_enabled === true;
      const mvuEntries = (charBook.entries as Record<string, unknown>[]).filter(e =>
        MVU_LOREBOOK_ENTRY_NAMES.includes(e.name as string)
      );
      if (mvuEnabled && mvuEntries.length > 0) {
        // Check initvar exists
        const initvarEntry = mvuEntries.find(e => e.name === '[InitVar]请勿打开');
        if (!initvarEntry) {
          warnings.push('MVU 已启用但缺少 [InitVar] 初始变量条目');
        } else if (!(initvarEntry.content as string || '').trim()) {
          warnings.push('MVU 已启用但 [InitVar] 内容为空，运行时将报错「没有找到 InitVar 数据」');
        }
        // Check update rules exists
        const hasUpdateRules = mvuEntries.some(e => e.name === '[mvu_update]变量更新规则');
        if (!hasUpdateRules) {
          warnings.push('MVU 已启用但缺少变量更新规则条目');
        }
        // Check all MVU entries are constant
        for (const entry of mvuEntries) {
          if (!entry.constant) {
            warnings.push(`MVU 条目 "${entry.name}" 应为蓝灯条目 (constant)`);
          }
        }

        // Check MVU scripts and regex scripts in extensions
        // SillyTavern / JS-Slash-Runner 要求 scripts 和 regex_scripts 都是数组
        const tavernHelper = ext.tavern_helper as Record<string, unknown> | undefined;
        const scripts = tavernHelper?.scripts as unknown[] | undefined;
        const hasMvuScript = Array.isArray(scripts) && scripts.some(
          s => typeof s === 'object' && s !== null && (s as { name?: string }).name === 'MVU'
        );
        const hasZodScript = Array.isArray(scripts) && scripts.some(
          s => typeof s === 'object' && s !== null && (s as { name?: string }).name === 'Zod'
        );
        if (!hasMvuScript) {
          warnings.push('MVU 已启用但酒馆助手脚本未注册 MVU 主脚本（extensions.tavern_helper.scripts 中缺少 name=MVU 的脚本）');
        }
        if (!hasZodScript) {
          warnings.push('MVU 已启用但酒馆助手脚本未注册 Zod 校验脚本（extensions.tavern_helper.scripts 中缺少 name=Zod 的脚本）');
        }

        const regexScripts = ext.regex_scripts as unknown[] | undefined;
        const hasHideUpdateScript = Array.isArray(regexScripts) && regexScripts.some(
          s => typeof s === 'object' && s !== null && (s as { scriptName?: string }).scriptName === '对AI隐藏变量更新'
        );
        if (!hasHideUpdateScript) {
          warnings.push('MVU 已启用但缺少变量更新隐藏正则脚本，<update> 标签会暴露给 AI');
        }

        // 状态栏通过 regex_scripts 实现
        const hasStatusBar = ext.mvu_has_status_bar === true;
        if (hasStatusBar) {
          const hasStatusBarRegex = Array.isArray(regexScripts) && regexScripts.some(
            s => typeof s === 'object' && s !== null && (s as { scriptName?: string }).scriptName === REGEX_SCRIPT_NAMES.statusBar
          );
          const hasHideStatusBarRegex = Array.isArray(regexScripts) && regexScripts.some(
            s => typeof s === 'object' && s !== null && (s as { scriptName?: string }).scriptName === '对AI隐藏状态栏'
          );
          if (!hasStatusBarRegex) {
            warnings.push('MVU 已启用且包含状态栏，但 regex_scripts 中缺少 "状态栏界面" 正则脚本');
          }
          if (!hasHideStatusBarRegex) {
            warnings.push('MVU 已启用且包含状态栏，但 regex_scripts 中缺少 "对AI隐藏状态栏" 正则脚本');
          }
        }
      }

    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ════════════════════════════════════════════════════════════════════════════
// 硬失败校验层（零分否决）
// ────────────────────────────────────────────────────────────────────────────
// 与 `validateCard` 的 errors/warnings 评分解耦。命中任一规则即整卡不可发布。
// 灵感来自 AFV 的 rubric.md「硬失败」概念：某些错误无视总分直接阻断发布。
// 专防 CLAUDE.md 反复点名的根因类 bug：
//   - 世界书名三处不一致 → ST 里 loadWorldInfo 精确匹配失败 →「阶段不切换」
//   - MVU 启用但缺 [InitVar] → 运行时报「没有找到 InitVar 数据」
//   - MVU 路径命中原型污染键 → __proto__ 逃逸
//   - 状态栏/直播间正则名拼写错误 → 界面接线静默断开
// ════════════════════════════════════════════════════════════════════════════

/** 硬失败规则标识符（稳定 ID，便于 UI/测试引用） */
export type HardFailCode =
  | 'book_name_mismatch'
  | 'dispatcher_book_name_mismatch'
  | 'mvu_missing_initvar'
  | 'mvu_forbidden_path'
  | 'regex_script_name_typo';

export interface HardFail {
  code: HardFailCode;
  /** 面向用户的中文说明 */
  message: string;
  /** 修复提示 */
  fixHint: string;
}

/**
 * 在已组装的卡片 JSON 上执行硬失败校验。
 *
 * 与 `validateCard` 不同，这里只检查「命中即不可发布」的根因类问题，
 * 不检查字段类型/缺失等常规规范错误（那些由 `validateCard` 的 errors 负责）。
 *
 * 返回空数组 = 无硬失败，可以发布；非空 = 整卡不可发布。
 */
export function validateCardHardFails(card: Record<string, unknown>): HardFail[] {
  const fails: HardFail[] = [];
  const data = (card.data ?? card) as Record<string, unknown>;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fails;

  const ext = (data.extensions ?? {}) as Record<string, unknown>;
  const charBook = data.character_book as Record<string, unknown> | undefined;
  const bookName = typeof charBook?.name === 'string' ? charBook.name : '';
  const worldName = typeof ext.world === 'string' ? ext.world : '';

  // ── 1. 世界书名三处一致：character_book.name === extensions.world ──────
  // ST 用 extensions.world 关联世界书文件；character_book.name 是书本身的名字。
  // 两者不一致时 ST 不会自动加载世界书，调度条目也拉不到子条目。
  if (bookName && worldName && bookName !== worldName) {
    fails.push({
      code: 'book_name_mismatch',
      message: `世界书名不一致：character_book.name="${bookName}" 但 extensions.world="${worldName}"`,
      fixHint: '两者必须完全一致（含大小写/空格）。请在导出前统一书名。',
    });
  }

  // ── 2. 分阶段调度条目的 getWorldInfo("书名", ...) 与书名一致 ──────────
  // 这是「阶段不切换」的根因：ST 的 loadWorldInfo 按书名精确匹配，
  // 调度条目里写错一个字就拉不到子条目，阶段永远停在第一个。
  if (charBook && Array.isArray(charBook.entries)) {
    for (const entry of charBook.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const content = (entry as Record<string, unknown>).content;
      if (typeof content !== 'string') continue;
      // 匹配 getWorldInfo("...", ...) 或 getWorldInfo('...', ...) 的第一个参数
      const matches = content.matchAll(/getWorldInfo\(\s*(['"])([^'"]+?)\1/g);
      for (const m of matches) {
        const dispatcherBookName = m[2];
        if (bookName && dispatcherBookName !== bookName) {
          fails.push({
            code: 'dispatcher_book_name_mismatch',
            message: `分阶段调度条目里 getWorldInfo("${dispatcherBookName}", ...) 与世界书名 "${bookName}" 不一致`,
            fixHint: '调度条目的书名参数必须与世界书名完全一致。这是「阶段不切换」的最常见根因。',
          });
          break; // 每条 entry 只报一次
        }
      }
    }
  }

  // ── 3. MVU 启用但缺 [InitVar] 初始变量条目 ──────────────────────────
  // 运行时报「没有找到 InitVar 数据」的直接原因。
  const mvuEnabled = ext.mvu_enabled === true;
  if (mvuEnabled && charBook && Array.isArray(charBook.entries)) {
    const initvarEntry = (charBook.entries as Record<string, unknown>[]).find(
      (e) => e && (e.name === '[InitVar]请勿打开' || e.comment === '[InitVar]请勿打开'),
    );
    const initvarContent = typeof initvarEntry?.content === 'string' ? initvarEntry.content : '';
    if (!initvarEntry || !initvarContent.trim()) {
      fails.push({
        code: 'mvu_missing_initvar',
        message: 'MVU 已启用但缺少 [InitVar]请勿打开 条目或其内容为空',
        fixHint: '运行时会报「没有找到 InitVar 数据」。请到第 5 步（MVU变量）重新生成或补全初始变量。',
      });
    }
  }

  // ── 4. MVU 变量路径命中原型污染键 ───────────────────────────────────
  // 扫描 [InitVar] 内容里的 YAML 路径与 schema 里的变量路径。
  // FORBIDDEN_KEYS 命中会导致 __proto__ 逃逸成容器，是安全边界。
  if (mvuEnabled && charBook && Array.isArray(charBook.entries)) {
    const initvarEntry = (charBook.entries as Record<string, unknown>[]).find(
      (e) => e && (e.name === '[InitVar]请勿打开' || e.comment === '[InitVar]请勿打开'),
    );
    const initvarContent = typeof initvarEntry?.content === 'string' ? initvarEntry.content : '';
    if (initvarContent) {
      // 扫描 YAML 里的路径段：形如 "角色:" / "  好感度:" 的键名
      // 也扫描点分路径 stat_data.角色.__proto__
      const yamlKeys = initvarContent.match(/^[ \t]*([^\s:#][^:]*?):/gm) ?? [];
      const dotPaths = initvarContent.match(/[\w\u4e00-\u9fff.]+/g) ?? [];
      const allSegments = new Set<string>();
      for (const k of yamlKeys) {
        const seg = k.replace(/^[ \t]*|:/g, '').trim();
        if (seg) allSegments.add(seg);
      }
      for (const p of dotPaths) {
        for (const seg of p.split('.')) {
          if (seg) allSegments.add(seg);
        }
      }
      for (const seg of allSegments) {
        if (HARD_FAIL_FORBIDDEN_KEYS.has(seg)) {
          fails.push({
            code: 'mvu_forbidden_path',
            message: `MVU 变量路径中包含禁止键 "${seg}"（原型污染风险）`,
            fixHint: `路径段 "${seg}" 会被写入对象原型链，可能导致安全漏洞。请重命名该变量。`,
          });
          break;
        }
      }
    }
  }

  // ── 5. 正则脚本名拼写错误（状态栏/直播间界面）──────────────────────
  // 常见 typo：写成「状态栏」少个「界面」，导致按名匹配的导入/校验/补丁全断。
  const regexScripts = Array.isArray(ext.regex_scripts) ? (ext.regex_scripts as Record<string, unknown>[]) : [];
  if (regexScripts.length > 0) {
    for (const s of regexScripts) {
      if (!s || typeof s !== 'object') continue;
      const name = typeof s.scriptName === 'string' ? s.scriptName : '';
      // 精确捕获常见错误形态：缺「界面」、缺空格、加了多余空格
      const isStatusBarTypo = name.length > 0 &&
        name !== REGEX_SCRIPT_NAMES.statusBar &&
        name.replace(/\s/g, '') === REGEX_SCRIPT_NAMES.statusBar.replace(/\s/g, '');
      const isLiveChatTypo = name.length > 0 &&
        name !== REGEX_SCRIPT_NAMES.liveChat &&
        name.replace(/\s/g, '') === REGEX_SCRIPT_NAMES.liveChat.replace(/\s/g, '');
      // 只在「去掉空格后相等但原始不等」时报（捕获空格差异）
      // 或在「名字是状态栏/直播间的严格前缀且不等」时报（捕获缺「界面」）
      const isPrefixStatusBar = name.length > 0 &&
        name !== REGEX_SCRIPT_NAMES.statusBar &&
        (REGEX_SCRIPT_NAMES.statusBar.startsWith(name) || name.startsWith('状态栏')) &&
        name.length >= 3 && name.length < REGEX_SCRIPT_NAMES.statusBar.length;
      const isPrefixLiveChat = name.length > 0 &&
        name !== REGEX_SCRIPT_NAMES.liveChat &&
        (REGEX_SCRIPT_NAMES.liveChat.startsWith(name) || name.startsWith('直播间')) &&
        name.length >= 3 && name.length < REGEX_SCRIPT_NAMES.liveChat.length;
      if (isStatusBarTypo || isLiveChatTypo || isPrefixStatusBar || isPrefixLiveChat) {
        fails.push({
          code: 'regex_script_name_typo',
          message: `正则脚本名 "${name}" 与工具注册名不完全一致（应为「${REGEX_SCRIPT_NAMES.statusBar}」或「${REGEX_SCRIPT_NAMES.liveChat}」）`,
          fixHint: '按名匹配的导入/校验/补丁会静默断开。请勿手动改名。',
        });
        break; // 只报一次
      }
    }
  }

  return fails;
}

/** 便捷方法：是否存在任一硬失败 */
export function hasHardFails(card: Record<string, unknown>): boolean {
  return validateCardHardFails(card).length > 0;
}
