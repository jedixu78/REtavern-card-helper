/**
 * mvu-sim — 试聊里的 MVU（MagVarUpdate）变量引擎模拟器。纯函数，无第三方运行时依赖。
 *
 * 试聊此前只能沙盒渲染状态栏布局，`{{format_message_variable::stat_data.xxx}}`
 * 宏没有变量引擎求值、原样显示——状态栏卡验证得了布局、验证不了数值绑定。
 * 本模块按 MagVarUpdate 源码（本地参考 `magvarupdate/`，gitignore）与酒馆助手
 * （js-slash-runner）的宏实现逐条移植语义，让试聊里的变量真实演进。
 *
 * ── 移植的真实语义（来源标注）────────────────────────────────────────────────
 * 命令提取（magvarupdate/src/function/update_variables.ts · extractCommands）：
 *   - 全文扫描，不限于 <UpdateVariable> 块内；
 *   - `_.set/insert/assign/remove/unset/delete/add(...)`：括号配对状态机（引号感知），
 *     闭括号后必须紧跟 `;`，其后可选 `//原因` 注释；
 *   - `<json_patch>` / `<JSONPatch>` 块（大小写不敏感、可带代码围栏）解析为 JSON 数组，
 *     操作翻译：replace→set、delta→add、insert/add→insert、remove→delete、move→move；
 *     move 在真实引擎的执行 switch 里没有分支——是静默 no-op，这里如实镜像并记警告；
 *   - 别名：assign→insert、remove/unset→delete；命令按出现位置排序执行。
 * 命令执行（同文件 · updateVariables，无 schema 分支）：
 *   - `_.set`：路径必须已存在，否则记错误跳过；旧值为 VWD（[值, "描述"] 二元组且
 *     值不是数组）时只更新 [0]；旧值为数字且新值为字符串时强转 Number；
 *   - `_.add`：路径必须存在；数字加 delta（toPrecision(12) 防浮点误差）；旧值可解析
 *     为日期时按毫秒推进并存 ISO 串；VWD 感知；
 *   - `_.insert` 双参：数组 push / 对象深合并（lodash merge 语义：数组按下标并，
 *     对象源并入数组目标时按下标写入）；三参：数组按索引 splice（`-` 表示追加到
 *     尾部）/ 对象设键。目标路径**不存在（undefined）时报错跳过**——真实引擎的
 *     验证 1 在一切 schema 检查之前无条件拒绝；只有目标值为 null 时才自动建容器；
 *   - `_.delete`：单参数字尾路径→数组 splice；否则整路径 unset；双参→按索引/深等值
 *     删数组元素、按键名/键序删对象键。
 * 初始变量（magvarupdate/src/function/initvar/variable_init.ts · loadInitVarData）：
 *   - comment 含 `[initvar]`（大小写不敏感）的世界书条目；真实实现**不检查 enabled**，
 *     禁用条目照样加载（本工具导出的「[InitVar]请勿打开」正是禁用兜底）；
 *   - 内容可被 `<initvar>…</initvar>` 包裹、可带代码围栏，剥掉后按 YAML/JSON 解析；
 *   - 多条目 correctlyMerge 合并（数组整体替换，不按下标并）；
 *   - 开场白里的 `<initvar>` 块存在时**整体覆盖**世界书基线；
 *   - 本工具的卡额外用 EJS `<%_ setvar('stat_data.X', V); _%>` 前缀设初值（参考卡
 *     「银帷骑士团」方案），setvar 覆盖 initvar 基线；
 *   - 开场白正文与后续消息一样会跑一遍命令提取（真实 MVU 对 0 层 swipe 也执行）。
 * 宏替换（js-slash-runner/src/function/macro_like.ts）：
 *   - `{{get_message_variable::path}}`：字符串原样输出，其余单行 JSON.stringify；
 *   - `{{format_message_variable::path}}`：捕获同行前缀，YAML 输出（多行字符串用
 *     literal 块），续行统一缩进「前缀宽度」个空格；前缀里嵌套的 format 宏递归处理；
 *   - 两者都深度剔除以 `$` 开头的键；路径先做 HTML 实体反转义。
 * 消息后处理（update_variables.ts · handleVariablesInMessage）：
 *   - AI 消息缺 `<StatusPlaceHolderImpl/>` 时自动补到末尾；
 *   - `<status_current_variable>…</…>` 块从消息里删除。
 *
 * ── 与真实运行时的已知差距（UI 提示需与此保持同步）─────────────────────────────
 *   1. 不模拟 schema：真实 MVU 会从初始数据生成 schema 并拒绝向未标记 extensible 的
 *      数组/对象插入、拒绝删除 required 键；这里一律放行（更宽松）。
 *   2. 命令值解析不用 mathjs / new Function（AI 文本喂给 new Function 是 XSS 向量，
 *      本工具的安全边界不允许）：JSON → 宽松 JSON（裸键/单引号/尾逗号）→ 纯四则
 *      运算求值（+-*_/%()）→ YAML 子集（仅接受对象/数组结果）→ 裸字符串。
 *      sqrt() 之类的 mathjs 函数调用不支持。<json_patch> 块内容解析同理：用
 *      「严格 JSON → 宽松 JSON → YAML 子集」链替代真实 parseString 的
 *      YAML/JSON5/jsonrepair 链，jsonrepair 级别的破损修复不覆盖。
 *   3. 命令内容里的 ST 宏（{{user}} 等）不做替换（真实 MVU 先过 substitudeMacros）。
 *   4. 宏只解析 message 类型；chat/character/preset/global 保留原样并计入未解析清单
 *      （真实 MVU 默认也不再同步聊天变量，见其 CHANGELOG 2025-11-11）。
 *   5. 路径不存在时宏保留原样并计入未解析清单；真实运行时会渲染成 "null"。
 *      刻意偏离：显示假 null 比显示宏本身更误导。
 *   6. YAML 为手写够用子集：锚点/别名/折叠块/多文档等高级语法不支持，解析失败会
 *      进 warnings 如实上报。
 *   7. 状态栏 HTML 里残留的 EJS（<%- getvar(...) %> 等）不执行——导出层已把这类
 *      写法转换成 format_message_variable 宏，未转换的第三方卡如实露出。
 *   8. 刻意比上游更严：路径段 `__proto__` / `constructor` / `prototype` 一律拒绝
 *      （见 FORBIDDEN_KEYS）。真实 MVU 用 lodash，其 safeGet + baseAssignValue
 *      自带同等防护；这里是手写等价物必须补上的原型污染防线。
 */
import { deepClone } from '../utils/deep-clone';
import { parseAIJson } from './ai-json';

// ============================================================================
// 类型
// ============================================================================

export type StatData = Record<string, unknown>;

/** 一条命令的执行记录（含失败的：ok=false + error） */
export interface MvuChange {
  /** set / add / insert / delete / move */
  op: string;
  path: string;
  /** 生效前的值（VWD 已解包出实际值）；失败时为当前值或 undefined */
  from: unknown;
  /** 生效后的值（VWD 已解包）；失败时 undefined */
  to: unknown;
  reason: string;
  ok: boolean;
  error?: string;
}

export interface MvuApplyResult {
  /** 新的 stat_data（输入永不被修改；无命令时原引用返回） */
  statData: StatData;
  changes: MvuChange[];
  /** json_patch 块解析失败等提取层警告 */
  warnings: string[];
}

export interface MvuInitResult {
  statData: StatData;
  /** 初始值来源描述，如「[InitVar]请勿打开」「开场白 setvar ×12」 */
  sources: string[];
  warnings: string[];
}

export interface MvuMacroResult {
  html: string;
  /** 未能解析的宏原文（路径不存在 / 非 message 类型） */
  unresolved: string[];
}

export interface MvuTimeline {
  /** 是否检测到 MVU 结构（有初始变量来源或任一消息产生了命令） */
  active: boolean;
  init: MvuInitResult;
  /** snapshots[i] = 处理完第 i 条消息后的 stat_data */
  snapshots: StatData[];
  /** changesByMessage[i] = 第 i 条消息产生的命令记录 */
  changesByMessage: MvuChange[][];
  /** 各消息提取层警告（与 changesByMessage 对齐） */
  warningsByMessage: string[][];
}

type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return typeof v === 'object' && v !== null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ============================================================================
// 路径工具（对齐 lodash get/set/has/unset 在 MVU 用到的子集）
// ============================================================================

/** 'a.b[0]["x y"]' → ['a','b','0','x y']。引号内的 ] 与转义引号按字面处理。
 * 同时兼容 JSON Pointer 格式 '/a/b/c'（AI 经常在 JSONPatch 路径里写这种格式）。
 */
export function toPathParts(path: string): string[] {
  // JSON Pointer：以 / 开头，段内 ~0 替换为 ~，~1 替换为 /
  if (path.startsWith('/')) {
    return path
      .slice(1)
      .split('/')
      .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  const parts: string[] = [];
  let current = '';
  let i = 0;
  const flush = () => {
    if (current !== '') {
      parts.push(current);
      current = '';
    }
  };
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      flush();
      i += 1;
      continue;
    }
    if (ch === '[') {
      flush();
      i += 1;
      const quote = path[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        let key = '';
        while (i < path.length && path[i] !== quote) {
          if (path[i] === '\\' && i + 1 < path.length) {
            key += path[i + 1];
            i += 2;
            continue;
          }
          key += path[i];
          i += 1;
        }
        i += 1; // 收尾引号
        while (i < path.length && path[i] !== ']') i += 1;
        i += 1; // ]
        parts.push(key);
        continue;
      }
      let key = '';
      while (i < path.length && path[i] !== ']') {
        key += path[i];
        i += 1;
      }
      i += 1; // ]
      if (key !== '') parts.push(key);
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  return parts;
}

/**
 * 原型污染防线：这些路径段一律不当作可遍历/可写的普通键。
 *
 * 输入源全部不可信——命令来自 AI 回复文本、initvar 来自导入的第三方卡片。
 * 没有这道防线时 `_.insert('__proto__', {...})`、JSONPatch `"/__proto__/x"`、
 * initvar 里的自有 `__proto__` 键、开场白 `setvar('stat_data.__proto__.x')`
 * 都会把值写进**页面全局 Object.prototype**（不是克隆对象），在整个 SPA
 * 生命周期内持续生效：污染 `disabled:true` 能让 chat-render 判定所有卡内正则
 * 脚本为禁用（状态栏/直播间全哑火），污染 `regex_scripts` 能让 extractRegexScripts
 * 从任意卡片读到攻击者数组。
 *
 * 真实 MVU 用 lodash，其 safeGet + baseAssignValue(defineProperty) 自带这层防护；
 * 手写等价物必须补上。这是刻意的加固偏离（比上游更严），不是语义漏移。
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** lodash safeGet 等价：原型链上的键视为不存在，杜绝 __proto__ 逃逸成容器 */
function readKey(container: Container, key: string): unknown {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  return (container as Record<string, unknown>)[key];
}

/** lodash baseAssignValue 等价：这些键写成目标对象上的自有属性，不触发 setter */
function writeKey(container: Container, key: string, value: unknown): void {
  if (FORBIDDEN_KEYS.has(key)) {
    Object.defineProperty(container, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  (container as Record<string, unknown>)[key] = value;
}

export function getAtPath(root: unknown, path: string | string[]): unknown {
  const parts = Array.isArray(path) ? path : toPathParts(path);
  let cur: unknown = root;
  for (const part of parts) {
    if (!isContainer(cur)) return undefined;
    cur = readKey(cur, part);
  }
  return cur;
}

export function hasAtPath(root: unknown, path: string | string[]): boolean {
  const parts = Array.isArray(path) ? path : toPathParts(path);
  if (parts.length === 0) return false;
  let cur: unknown = root;
  for (const part of parts) {
    if (!isContainer(cur)) return false;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return false;
    cur = readKey(cur, part);
  }
  return true;
}

/** lodash _.set 语义：中间容器缺失时按「下一段是否纯数字」建数组或对象。 */
export function setAtPath(root: Container, path: string | string[], value: unknown): void {
  const parts = Array.isArray(path) ? path : toPathParts(path);
  if (parts.length === 0) return;
  let cur: Container = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const existing = readKey(cur, parts[i]);
    if (isContainer(existing)) {
      cur = existing;
      continue;
    }
    const next: Container = /^\d+$/.test(parts[i + 1]) ? [] : {};
    writeKey(cur, parts[i], next);
    cur = next;
  }
  writeKey(cur, parts[parts.length - 1], value);
}

/** lodash _.unset 语义：数组上 delete 会留洞（MVU 的数组元素删除在别处用 splice）。 */
function unsetAtPath(root: Container, path: string | string[]): void {
  const parts = Array.isArray(path) ? path : toPathParts(path);
  if (parts.length === 0) return;
  const last = parts[parts.length - 1];
  // 不允许构造出的删除命令剥掉真实原型上的方法
  if (FORBIDDEN_KEYS.has(last)) return;
  const parent = parts.length === 1 ? root : getAtPath(root, parts.slice(0, -1));
  if (!isContainer(parent)) return;
  delete (parent as Record<string, unknown>)[last];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * lodash _.merge 语义：深合并，数组按下标并（用于 _.insert 的对象合并分支）。
 * 跨类型规则对齐 lodash baseMergeDeep：对象源可以并入数组目标（键当下标写入，
 * 数组身份保留，`_.merge({a:[1,2]},{a:{1:'x'}})` → a=[1,'x']）；
 * 数组源遇到非数组目标则整体替换。
 */
function lodashLikeMerge(target: Container, source: Container): void {
  const entries = Array.isArray(source)
    ? source.map((v, i) => [String(i), v] as const)
    : Object.entries(source);
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    const existing = readKey(target, key);
    if (isContainer(value) && isContainer(existing) && !(Array.isArray(value) && !Array.isArray(existing))) {
      lodashLikeMerge(existing, value);
    } else if (isContainer(value)) {
      writeKey(target, key, deepClone(value));
    } else {
      writeKey(target, key, value);
    }
  }
}

/** MVU correctlyMerge 语义：深合并但数组整体替换（用于 initvar 多条目合并）。 */
export function mergeInitData(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // JSON.parse('{"__proto__":{...}}') 产生的是**自有**键，Object.entries 会枚举到；
    // 必须走 readKey/writeKey 的原型污染防线，不能裸读裸写
    const existing = readKey(target, key);
    if (isPlainObject(value) && isPlainObject(existing)) {
      mergeInitData(existing, value);
    } else {
      writeKey(target, key, deepClone(value));
    }
  }
  return target;
}

// ============================================================================
// 值解析（对齐 parseCommandValue，安全替代 new Function / mathjs）
// ============================================================================

export function trimQuotesAndBackslashes(str: string): string {
  if (typeof str !== 'string') return str;
  // 与真实实现逐字一致（无 s 标志）：含换行的输入整体匹配失败、原样返回，
  // 多行字符串的首尾引号/反引号保留在值里
  return str.replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/, '$1');
}

/** 宽松 JSON：裸键加引号、单引号转双引号、去尾逗号。仅用于 {}/[] 字面量。 */
function tryLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* 继续 */
  }
  let s = text;
  // 裸键加引号：{ key: 1 } / , key: 1（中文键也常见）
  s = s.replace(/([{,]\s*)([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*:/g, '$1"$2":');
  // 单引号字符串转双引号（内部的双引号转义）
  s = s.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => JSON.stringify(inner.replace(/\\(['"\\])/g, '$1')));
  // 尾逗号
  s = s.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * 纯四则运算求值（数字 + - * / % 括号）。真实 MVU 用 mathjs，这里只覆盖 LLM
 * 常见的算式输出（'10 + 2' 等）；解析失败返回 null 落回字符串。
 */
function evalArithmetic(expr: string): number | null {
  if (!/^[\d\s+\-*/%().]+$/.test(expr) || !/\d/.test(expr)) return null;
  let pos = 0;
  const peek = () => expr[pos];
  const skipWs = () => {
    while (pos < expr.length && /\s/.test(expr[pos])) pos += 1;
  };
  const parseExpr = (): number => {
    let left = parseTerm();
    for (;;) {
      skipWs();
      const op = peek();
      if (op !== '+' && op !== '-') return left;
      pos += 1;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
  };
  const parseTerm = (): number => {
    let left = parseFactor();
    for (;;) {
      skipWs();
      const op = peek();
      if (op !== '*' && op !== '/' && op !== '%') return left;
      pos += 1;
      const right = parseFactor();
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
  };
  const parseFactor = (): number => {
    skipWs();
    if (peek() === '-') {
      pos += 1;
      return -parseFactor();
    }
    if (peek() === '+') {
      pos += 1;
      return parseFactor();
    }
    if (peek() === '(') {
      pos += 1;
      const inner = parseExpr();
      skipWs();
      if (peek() !== ')') throw new Error('unbalanced paren');
      pos += 1;
      return inner;
    }
    const match = expr.slice(pos).match(/^\d+(?:\.\d+)?/);
    if (!match) throw new Error('expected number');
    pos += match[0].length;
    return Number(match[0]);
  };
  try {
    const result = parseExpr();
    skipWs();
    if (pos !== expr.length) return null;
    if (!Number.isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * 值嵌套深度上限。stat_data 的嵌套深度完全由不可信文本控制
 * （`_.set('x', [[[…]]])` 走 JSON.parse，任意深度都能解析成功），而下游的
 * deepClone / yamlStringify / omitDollarKeysDeep 都是无上限递归——一条 6KB 的
 * 恶意消息就能让渲染期抛 RangeError，被根 ErrorBoundary 接管掀翻整站；
 * 而且消息已落 IndexedDB，刷新会再次崩溃、用户无 UI 手段自救。
 */
const MAX_VALUE_DEPTH = 64;

/** 迭代式深度检查（本身不会爆栈）：超过上限即判定为畸形/恶意值。 */
export function exceedsDepth(value: unknown, max = MAX_VALUE_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (!isContainer(current)) continue;
    if (depth >= max) return true;
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return false;
}

/** 对齐 MVU parseCommandValue 的降级链（安全实现，差距见模块头注释）。 */
export function parseCommandValue(valStr: string): unknown {
  if (typeof valStr !== 'string') return valStr;
  const trimmed = valStr.trim();

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed === 'undefined') return undefined;

  // 嵌套过深的结构降级成裸字符串，绝不让它进 stat_data（见 MAX_VALUE_DEPTH）
  const guardDepth = (value: unknown): unknown =>
    exceedsDepth(value) ? trimQuotesAndBackslashes(valStr) : value;

  try {
    return guardDepth(JSON.parse(trimmed));
  } catch {
    /* 继续 */
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    const lenient = tryLenientJson(trimmed);
    if (lenient !== undefined && isContainer(lenient)) return guardDepth(lenient);
  }

  const arith = evalArithmetic(trimmed);
  if (arith !== null) return parseFloat(arith.toPrecision(12));

  // 真实链在 mathjs 之后还有 YAML.parse 一级（`状态: 良好` 这类裸值会解析成对象）。
  // 这里用手写 YAML 子集近似，只接受容器结果——标量结果与最终的裸字符串回退等价。
  try {
    const yamlVal = parseSimpleYaml(trimmed);
    if (isContainer(yamlVal)) return guardDepth(yamlVal);
  } catch {
    /* 不是 YAML，落回裸字符串 */
  }

  return trimQuotesAndBackslashes(valStr);
}

// ============================================================================
// 命令提取（对齐 extractCommands）
// ============================================================================

type CommandName = 'set' | 'insert' | 'assign' | 'remove' | 'unset' | 'delete' | 'add' | 'move';

interface Command {
  type: CommandName;
  fullMatch: string;
  args: string[];
  reason: string;
}

/** 找到与 startPos 前那个开括号匹配的闭括号；引号（含反引号）内的括号不计数。 */
function findMatchingCloseParen(str: string, startPos: number): number {
  let parenCount = 1;
  let inQuote = false;
  let quoteChar = '';
  for (let i = startPos; i < str.length; i++) {
    const char = str[i];
    const prevChar = i > 0 ? str[i - 1] : '';
    if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuote = false;
      }
    }
    if (!inQuote) {
      if (char === '(') parenCount += 1;
      else if (char === ')') {
        parenCount -= 1;
        if (parenCount === 0) return i;
      }
    }
  }
  return -1;
}

/** 顶层逗号分割参数；引号与三种括号内的逗号不算分隔符。 */
export function parseParameters(paramsString: string): string[] {
  const params: string[] = [];
  let currentParam = '';
  let inQuote = false;
  let quoteChar = '';
  let bracketCount = 0;
  let braceCount = 0;
  let parenCount = 0;
  for (let i = 0; i < paramsString.length; i++) {
    const char = paramsString[i];
    if ((char === '"' || char === "'" || char === '`') && (i === 0 || paramsString[i - 1] !== '\\')) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuote = false;
      }
    }
    if (!inQuote) {
      if (char === '(') parenCount += 1;
      if (char === ')') parenCount -= 1;
      if (char === '[') bracketCount += 1;
      if (char === ']') bracketCount -= 1;
      if (char === '{') braceCount += 1;
      if (char === '}') braceCount -= 1;
    }
    if (char === ',' && !inQuote && parenCount === 0 && bracketCount === 0 && braceCount === 0) {
      params.push(currentParam.trim());
      currentParam = '';
      continue;
    }
    currentParam += char;
  }
  if (currentParam.trim()) params.push(currentParam.trim());
  return params;
}

/** 路径规整（逐行对齐 MVU pathFix）：裸数字下标保留、引号键转 bracket 形式等。 */
export function pathFix(path: string): string {
  if (!path) return path;
  const fixedBrackets = path.replace(/\[([^\]]*)\]/g, (_match, rawInner: string) => {
    let inner = rawInner.trim();
    if (!inner) return '[]';
    let wasQuoted = false;
    const first = inner[0];
    const last = inner[inner.length - 1];
    if (inner.length >= 2 && (first === '"' || first === "'") && first === last) {
      wasQuoted = true;
      inner = inner.slice(1, -1);
    }
    const isPureDigits = /^\d+$/.test(inner);
    const hasWhitespace = /\s/.test(inner);
    if (isPureDigits) {
      if (!wasQuoted) return `[${inner}]`;
      const escaped = inner.replace(/"/g, '\\"');
      return `["${escaped}"]`;
    }
    if (hasWhitespace) {
      const escaped = inner.replace(/"/g, '\\"');
      return `["${escaped}"]`;
    }
    return `[${inner}]`;
  });
  const fixedDots = fixedBrackets.replace(
    /(^|\.)(["'])([^"']*)\2(?=\.|\[|$)/g,
    (_match, prefix: string, _quote: string, name: string) => {
      const hasWhitespace = /\s/.test(name);
      const hasSpecial = /[.[\]]/.test(name);
      if (!hasWhitespace && !hasSpecial) return prefix + name;
      const escaped = name.replace(/"/g, '\\"');
      if (prefix === '.') return `["${escaped}"]`;
      return `${prefix}["${escaped}"]`;
    },
  );
  return fixedDots;
}

/** JSON Patch 路径 '/a/b/0' → 'a.b.0'（容忍缺少开头的 /）。
 * 按 RFC 6901 处理转义：~1 → /，~0 → ~（先 ~1 后 ~0，避免 ~01 歧义）。
 */
function jsonPatchPathToCommandPath(path: string | undefined): string {
  if (!path) return '';
  const pathWithoutRoot = path.startsWith('/') ? path.substring(1) : path;
  return pathWithoutRoot
    .replace(/~1/g, '/')
    .replace(/~0/g, '~')
    .replace(/\//g, '.');
}

function isJsonPatch(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return false;
  // 真实实现（magvarupdate/src/util.ts）：空数组是合法 patch——零命令、不告警
  if (value.length === 0) return true;
  // 每个 op 必须带 path（move 允许用 to）；一个坏 op 令整块作废——与真实一致
  return value.every(
    (op) =>
      isPlainObject(op) &&
      typeof op.op === 'string' &&
      (typeof op.path === 'string' || (op.op === 'move' && typeof op.to === 'string')),
  );
}

function extractJsonPatch(patch: Array<Record<string, unknown>>): Command[] {
  const translated: Command[] = [];
  for (const op of patch) {
    const path = jsonPatchPathToCommandPath((op.path ?? op.to) as string | undefined);
    switch (op.op) {
      case 'replace':
        translated.push({ type: 'set', fullMatch: JSON.stringify(op), args: [path, JSON.stringify(op.value)], reason: 'json_patch' });
        break;
      case 'delta':
        translated.push({ type: 'add', fullMatch: JSON.stringify(op), args: [path, JSON.stringify(op.value)], reason: 'json_patch' });
        break;
      case 'insert':
      case 'add': {
        const pathParts = toPathParts(path);
        const lastPart = pathParts[pathParts.length - 1] ?? '';
        const containerPath = pathParts.slice(0, -1).join('.');
        // 保留 JSON Patch 的 "-" 特殊 token，交给执行阶段结合目标集合类型解释
        const keyOrIndexArg = /^\d+$/.test(lastPart) ? lastPart : `'${lastPart}'`;
        translated.push({
          type: 'insert',
          fullMatch: JSON.stringify(op),
          args: [containerPath, keyOrIndexArg, JSON.stringify(op.value)],
          reason: 'json_patch',
        });
        break;
      }
      case 'remove':
        translated.push({ type: 'delete', fullMatch: JSON.stringify(op), args: [path], reason: 'json_patch' });
        break;
      case 'move':
        translated.push({
          type: 'move',
          fullMatch: JSON.stringify(op),
          args: [jsonPatchPathToCommandPath(op.from as string | undefined), path],
          reason: 'json_patch',
        });
        break;
    }
  }
  return translated;
}

const JSON_PATCH_BLOCK_RE = /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/gim;

/**
 * json_patch 块内容解析：近似真实 parseString（YAML→JSON5→jsonrepair→YAML）的
 * 宽容度——裸键/单引号的 JSON5 风格与 YAML 列表写法的 patch 都要能执行（差距 2）。
 */
function parseJsonPatchContent(content: string): unknown {
  const jsonFirst = /^[[{]/.test(content);
  if (!jsonFirst) {
    try {
      return parseSimpleYaml(content);
    } catch {
      /* 继续走 JSON 链 */
    }
  }
  const strict = parseAIJson(content);
  if (strict !== null) return strict;
  const lenient = tryLenientJson(content);
  if (lenient !== undefined) return lenient;
  if (jsonFirst) {
    try {
      return parseSimpleYaml(content);
    } catch {
      /* 放弃 */
    }
  }
  return null;
}

export interface ExtractResult {
  commands: Command[];
  warnings: string[];
}

/**
 * 命令扫描的字符预算。findMatchingCloseParen 在括号不配对时会一路扫到串尾，
 * 而 `_.set(` 每次只前进 6 个字符——N 个未闭合调用就是 O(N·len)。
 * 20000 个未闭合 `_.set(`（120KB）能把主线程阻塞几十秒，而 buildVariableTimeline
 * 会对**全部历史消息**重放、每来一条新消息重算一次。
 * 现实输入远低于这个上限；超预算即停止提取并给出警告（可见地降级，而非静默）。
 */
const COMMAND_SCAN_BUDGET = 1_000_000;

/** 从消息全文提取全部命令（json_patch 块 + _.xxx() 调用），按出现位置排序。 */
export function extractCommands(inputText: string): ExtractResult {
  const indexed: Array<Command & { $index: number }> = [];
  const warnings: string[] = [];

  JSON_PATCH_BLOCK_RE.lastIndex = 0;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = JSON_PATCH_BLOCK_RE.exec(inputText)) !== null) {
    const content = blockMatch[2].trim();
    if (!content) continue;
    const parsed = parseJsonPatchContent(content);
    if (isJsonPatch(parsed)) {
      for (const command of extractJsonPatch(parsed)) {
        indexed.push({ $index: blockMatch.index, ...command });
      }
    } else {
      warnings.push(`JSONPatch 块解析失败：${content.slice(0, 80)}${content.length > 80 ? '…' : ''}`);
    }
  }

  // lastIndex 驱动的全局正则，避免每轮 substring 复制整串
  const commandStartRe = /_\.(set|insert|assign|remove|unset|delete|add)\(/g;
  let i = 0;
  let scanned = 0;
  let budgetExhausted = false;
  while (i < inputText.length) {
    commandStartRe.lastIndex = i;
    const setMatch = commandStartRe.exec(inputText);
    if (!setMatch) break;
    const commandType = setMatch[1] as CommandName;
    const setStart = setMatch.index;
    const openParen = setStart + setMatch[0].length;
    const closeParen = findMatchingCloseParen(inputText, openParen);
    // 括号配对扫描的字符数计入预算；未闭合的调用会一路扫到串尾，最烧预算
    scanned += (closeParen === -1 ? inputText.length : closeParen) - openParen;
    if (scanned > COMMAND_SCAN_BUDGET) {
      budgetExhausted = true;
      break;
    }
    if (closeParen === -1) {
      i = openParen;
      continue;
    }
    let endPos = closeParen + 1;
    if (endPos >= inputText.length || inputText[endPos] !== ';') {
      i = closeParen + 1;
      continue;
    }
    endPos += 1;
    let comment = '';
    // \s* 与真实实现一致：换行后的 // 注释也会被吸附为上一条命令的 reason
    const potentialComment = inputText.substring(endPos).match(/^\s*\/\/(.*)/);
    if (potentialComment) {
      comment = potentialComment[1].trim();
      endPos += potentialComment[0].length;
    }
    const fullMatch = inputText.substring(setStart, endPos);
    const params = parseParameters(inputText.substring(openParen, closeParen));

    let isValid = false;
    if (commandType === 'set' && params.length >= 2) isValid = true;
    else if (commandType === 'assign' && params.length >= 2) isValid = true;
    else if (commandType === 'insert' && params.length >= 2) isValid = true;
    else if (commandType === 'remove' && params.length >= 1) isValid = true;
    else if (commandType === 'unset' && params.length >= 1) isValid = true;
    else if (commandType === 'delete' && params.length >= 1) isValid = true;
    else if (commandType === 'add' && params.length === 2) isValid = true;

    if (isValid) {
      indexed.push({ $index: setStart, type: commandType, fullMatch, args: params, reason: comment });
    }
    i = endPos;
  }

  if (budgetExhausted) {
    warnings.push('变量命令扫描超出预算（疑似畸形或超长内容），已跳过剩余部分');
  }

  indexed.sort((a, b) => a.$index - b.$index);
  return { commands: indexed.map(({ $index: _unused, ...rest }) => rest), warnings };
}

// ============================================================================
// 命令执行（对齐 updateVariables，无 schema —— 差距见模块头注释第 1 条）
// ============================================================================

/** VWD（ValueWithDescription）判定：[值, '描述'] 且值不是数组。 */
function isVwd(value: unknown): value is [unknown, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' && !Array.isArray(value[0]);
}

/** 旧值可解析为日期（且不是纯数字串）时返回 Date，否则 null。对齐 _.add 的日期分支。 */
function tryParseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime()) && Number.isNaN(Number(value))) return parsed;
  return null;
}

/**
 * 对 stat_data 执行一条 AI 回复里的全部变量命令。不可变：输入永不被修改；
 * 没有任何命令时返回原引用。每条命令产出一条 MvuChange（失败的 ok=false）。
 */
export function applyUpdateBlocks(statData: StatData, aiReply: string): MvuApplyResult {
  const { commands, warnings } = extractCommands(aiReply);
  if (commands.length === 0) return { statData, changes: [], warnings };

  const data: StatData = deepClone(statData);
  const changes: MvuChange[] = [];

  // 别名归一（对齐真实实现）
  for (const cmd of commands) {
    if (cmd.type === 'remove') cmd.type = 'delete';
    else if (cmd.type === 'assign') cmd.type = 'insert';
    else if (cmd.type === 'unset') cmd.type = 'delete';
  }

  for (const command of commands) {
    const path = command.type === 'move'
      ? command.args[1] ?? ''
      : pathFix(trimQuotesAndBackslashes(command.args[0] ?? ''));
    const reason = command.reason;
    const fail = (error: string, from?: unknown) => {
      changes.push({ op: command.type, path, from, to: undefined, reason, ok: false, error });
    };

    switch (command.type) {
      case 'set': {
        if (path !== '' && !hasAtPath(data, path)) {
          fail(`路径 '${path}' 不存在于 stat_data，set 已跳过`);
          continue;
        }
        const oldValue = path === '' ? deepClone(data) : getAtPath(data, path);
        let newValue = parseCommandValue(command.args[command.args.length - 1]);
        if (newValue instanceof Date) newValue = newValue.toISOString();

        if (isVwd(oldValue)) {
          const previous = deepClone(oldValue[0]);
          const coerced = typeof oldValue[0] === 'number' && newValue !== null ? Number(newValue) : newValue;
          const vwd = getAtPath(data, path) as [unknown, string];
          vwd[0] = coerced;
          changes.push({ op: 'set', path, from: previous, to: coerced, reason, ok: true });
        } else if (typeof oldValue === 'number' && newValue !== null && typeof newValue === 'string') {
          setAtPath(data, path, Number(newValue));
          changes.push({ op: 'set', path, from: oldValue, to: Number(newValue), reason, ok: true });
        } else if (path) {
          setAtPath(data, path, newValue);
          changes.push({ op: 'set', path, from: oldValue, to: newValue, reason, ok: true });
        } else if (isPlainObject(newValue)) {
          // 真实 MVU 允许 _.set('', v) 替换整个 stat_data（含原始类型）；
          // 这里限定对象，保住 StatData 的类型不被打穿
          const previous = oldValue;
          for (const key of Object.keys(data)) delete data[key];
          for (const key of Object.keys(newValue)) writeKey(data, key, (newValue as Record<string, unknown>)[key]);
          changes.push({ op: 'set', path, from: previous, to: deepClone(newValue), reason, ok: true });
        } else {
          fail('根路径替换仅支持对象值（真实 MVU 允许任意值，这里刻意收紧）', oldValue);
        }
        break;
      }

      case 'insert': {
        const existingValue = path === '' ? data : getAtPath(data, path);
        // 真实引擎的验证 1（先于一切 schema 检查）：目标是原始类型或**不存在
        // （undefined）**都拒绝——`undefined !== null` 落入该分支。只有目标值为
        // null 时才会走到后面的自动建容器。LLM 常写 `_.insert('新路径', ...)`，
        // 真实 MVU 一律报错跳过，这里必须如实镜像，否则试聊里看着能用、上真实酒馆全崩。
        if (existingValue !== null && !isContainer(existingValue)) {
          fail(`路径 '${path}' 上是原始类型（${typeof existingValue}）或不存在，无法插入`, existingValue);
          continue;
        }
        const oldValue = deepClone(existingValue);

        if (command.args.length === 2) {
          let valueToAssign = parseCommandValue(command.args[1]);
          if (valueToAssign instanceof Date) valueToAssign = valueToAssign.toISOString();
          const resolved = path === '' ? data : getAtPath(data, path);
          let collection: Container;
          if (isContainer(resolved)) {
            collection = resolved;
          } else {
            collection = Array.isArray(valueToAssign) ? [] : {};
            setAtPath(data, path, collection);
          }
          if (Array.isArray(collection)) {
            collection.push(valueToAssign);
            changes.push({ op: 'insert', path, from: oldValue, to: deepClone(collection), reason, ok: true });
          } else if (isPlainObject(valueToAssign)) {
            lodashLikeMerge(collection, valueToAssign);
            changes.push({ op: 'insert', path, from: oldValue, to: deepClone(collection), reason, ok: true });
          } else {
            fail(`无法把${Array.isArray(valueToAssign) ? '数组' : '非对象'}合并进对象 '${path}'`, oldValue);
          }
        } else if (command.args.length >= 3) {
          let valueToAssign = parseCommandValue(command.args[2]);
          if (valueToAssign instanceof Date) valueToAssign = valueToAssign.toISOString();
          const keyOrIndex = parseCommandValue(command.args[1]);
          const collection = path === '' ? data : getAtPath(data, path);
          if (Array.isArray(collection) && (typeof keyOrIndex === 'number' || keyOrIndex === '-')) {
            const insertIndex = keyOrIndex === '-' ? collection.length : keyOrIndex;
            collection.splice(insertIndex, 0, valueToAssign);
            changes.push({ op: 'insert', path, from: oldValue, to: deepClone(collection), reason, ok: true });
          } else if (isContainer(collection)) {
            writeKey(collection, String(keyOrIndex), valueToAssign);
            changes.push({ op: 'insert', path: `${path}.${String(keyOrIndex)}`, from: undefined, to: valueToAssign, reason, ok: true });
          } else {
            const created: Container = {};
            setAtPath(data, path, created);
            writeKey(created, String(keyOrIndex), valueToAssign);
            changes.push({ op: 'insert', path: `${path}.${String(keyOrIndex)}`, from: undefined, to: valueToAssign, reason, ok: true });
          }
        } else {
          fail(`_.insert 参数数量不合法（路径 '${path}'）`);
        }
        break;
      }

      case 'delete': {
        const parts = toPathParts(path);
        const lastPart = parts[parts.length - 1] ?? '';
        const isArrayElementPath = /^\d+$/.test(lastPart);

        if (command.args.length === 1 && isArrayElementPath) {
          const containerPath = parts.slice(0, -1);
          const container = getAtPath(data, containerPath);
          const indexToRemove = parseInt(lastPart, 10);
          if (Array.isArray(container) && indexToRemove < container.length) {
            const removed = container[indexToRemove];
            container.splice(indexToRemove, 1);
            changes.push({ op: 'delete', path, from: removed, to: undefined, reason, ok: true });
            continue;
          }
        }

        if (!hasAtPath(data, path)) {
          fail(`路径 '${path}' 不存在，无法删除`);
          continue;
        }

        // 「没有第二参数」与「第二参数解析为 undefined」不能折叠：真实引擎对后者
        // 报 "Could not determine target for deletion" 并保留数据
        const hasSecondArg = command.args.length > 1;
        const targetToRemove = hasSecondArg ? parseCommandValue(command.args[1]) : undefined;
        if (hasSecondArg && targetToRemove === undefined) {
          fail(`无法确定 '${path}' 的删除目标（第二参数解析为 undefined）`);
          continue;
        }
        if (!hasSecondArg) {
          const removed = getAtPath(data, path);
          unsetAtPath(data, path);
          changes.push({ op: 'delete', path, from: removed, to: undefined, reason, ok: true });
          break;
        }

        const collection = getAtPath(data, path);
        if (!isContainer(collection)) {
          fail(`路径 '${path}' 不是数组或对象，无法从中删除`, collection);
          continue;
        }
        let itemRemoved = false;
        let removedValue: unknown;
        if (Array.isArray(collection)) {
          let indexToRemove = -1;
          if (typeof targetToRemove === 'number') indexToRemove = targetToRemove;
          else indexToRemove = collection.findIndex((item) => deepEqual(item, targetToRemove));
          if (indexToRemove >= 0 && indexToRemove < collection.length) {
            removedValue = collection[indexToRemove];
            collection.splice(indexToRemove, 1);
            itemRemoved = true;
          }
        } else if (typeof targetToRemove === 'number') {
          const keys = Object.keys(collection);
          if (targetToRemove >= 0 && targetToRemove < keys.length) {
            const keyToRemove = keys[targetToRemove];
            removedValue = collection[keyToRemove];
            delete collection[keyToRemove];
            itemRemoved = true;
          }
        } else {
          const keyToRemove = trimQuotesAndBackslashes(String(targetToRemove));
          if (Object.prototype.hasOwnProperty.call(collection, keyToRemove)) {
            removedValue = collection[keyToRemove];
            delete collection[keyToRemove];
            itemRemoved = true;
          }
        }
        if (itemRemoved) {
          changes.push({ op: 'delete', path, from: removedValue, to: undefined, reason, ok: true });
        } else {
          fail(`在 '${path}' 上执行删除失败（目标未命中）`);
        }
        break;
      }

      case 'add': {
        if (!hasAtPath(data, path)) {
          fail(`路径 '${path}' 不存在于 stat_data，add 已跳过`);
          continue;
        }
        const oldValue = getAtPath(data, path);
        const vwd = isVwd(oldValue);
        const valueToAdd = vwd ? (oldValue as [unknown, string])[0] : oldValue;
        const delta = parseCommandValue(command.args[1]);
        const potentialDate = valueToAdd instanceof Date ? valueToAdd : tryParseDate(valueToAdd);

        if (potentialDate) {
          if (typeof delta !== 'number') {
            fail(`日期增量 '${command.args[1]}' 不是数字，add 已跳过`, valueToAdd);
            continue;
          }
          const newIso = new Date(potentialDate.getTime() + delta).toISOString();
          if (vwd) (getAtPath(data, path) as [unknown, string])[0] = newIso;
          else setAtPath(data, path, newIso);
          changes.push({ op: 'add', path, from: valueToAdd, to: newIso, reason, ok: true });
        } else if (typeof valueToAdd === 'number') {
          if (typeof delta !== 'number') {
            fail(`增量 '${command.args[1]}' 不是数字，add 已跳过`, valueToAdd);
            continue;
          }
          const newValue = parseFloat((valueToAdd + delta).toPrecision(12));
          if (vwd) (getAtPath(data, path) as [unknown, string])[0] = newValue;
          else setAtPath(data, path, newValue);
          changes.push({ op: 'add', path, from: valueToAdd, to: newValue, reason, ok: true });
        } else {
          fail(`路径 '${path}' 的值不是数字或日期，add 已跳过`, valueToAdd);
        }
        break;
      }

      case 'move': {
        // 真实 MVU 的执行 switch 没有 move 分支——静默 no-op。如实镜像并给出警告。
        fail('move 操作在真实 MVU 引擎中未实现（静默忽略），模拟器同样不执行');
        break;
      }

      default:
        break;
    }
  }

  return { statData: data, changes, warnings };
}

// ============================================================================
// YAML 够用子集（解析 initvar / 序列化 format 宏输出）
// ============================================================================

/** 单个标量的解析：引号串、数字、布尔、null、行内 [] {}、余下按裸字符串。 */
function parseYamlScalar(raw: string): unknown {
  let text = raw.trim();
  if (text === '') return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const quote = text[0];
    const inner = text.slice(1, -1);
    if (quote === '"') {
      try {
        return JSON.parse(text);
      } catch {
        return inner;
      }
    }
    // 单引号 YAML：'' 表示一个 '
    return inner.replace(/''/g, "'");
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    const parsed = tryLenientJson(text);
    if (parsed !== undefined) return parsed;
    return text;
  }
  // 未引号标量：先剥行内注释（YAML 要求 # 前有空白），再判定类型
  const hashIdx = text.search(/\s#/);
  if (hashIdx >= 0) text = text.slice(0, hashIdx).trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
  return text;
}

interface YamlLine {
  indent: number;
  content: string;
}

/**
 * 手写 YAML 子集解析：嵌套映射、序列（含 `- key: value` 对象项）、带引号/行内
 * 集合标量、`|` / `|-` literal 块。不支持锚点、别名、折叠块、多文档（见差距 6）。
 * 内容以 { 或 [ 开头时按宽松 JSON 解析（initvar 实际常见 JSON，如参考例「理理」）。
 */
export function parseSimpleYaml(text: string): unknown {
  const trimmedAll = text.trim();
  if (!trimmedAll) return null;
  if (trimmedAll.startsWith('{') || trimmedAll.startsWith('[')) {
    const parsed = parseAIJson(trimmedAll);
    if (parsed !== null) return parsed;
    throw new Error('内容以 {/[ 开头但无法按 JSON 解析');
  }

  const rawLines = text.split(/\r?\n/);
  const lines: YamlLine[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    if (/^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, content: raw.trim() });
  }
  if (lines.length === 0) return null;

  let pos = 0;

  /** 读取 literal 块（| / |-）：吃掉所有缩进更深的原始行。 */
  const parseLiteralBlock = (parentIndent: number, chomp: boolean): string => {
    const collected: string[] = [];
    // literal 块要从原始行读（空行与前导空格都有意义），从当前 lines[pos] 反推原始行号不可靠，
    // 这里采用简化：从预处理行读取内容（丢失块内空行——差距 6 已声明）
    let blockIndent = -1;
    while (pos < lines.length && lines[pos].indent > parentIndent) {
      if (blockIndent === -1) blockIndent = lines[pos].indent;
      collected.push(' '.repeat(Math.max(0, lines[pos].indent - blockIndent)) + lines[pos].content);
      pos += 1;
    }
    const joined = collected.join('\n');
    return chomp ? joined : `${joined}\n`;
  };

  const parseBlock = (indent: number): unknown => {
    if (pos >= lines.length) return null;
    const isSeq = lines[pos].content.startsWith('- ') || lines[pos].content === '-';
    if (isSeq) {
      const arr: unknown[] = [];
      while (pos < lines.length && lines[pos].indent === indent && (lines[pos].content.startsWith('- ') || lines[pos].content === '-')) {
        const itemText = lines[pos].content === '-' ? '' : lines[pos].content.slice(2);
        if (!itemText) {
          pos += 1;
          arr.push(pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null);
          continue;
        }
        const kvMatch = itemText.match(/^([^:]+):(?:\s+(.*))?$/);
        if (kvMatch && !itemText.startsWith('{') && !itemText.startsWith('[') && !itemText.startsWith('"') && !itemText.startsWith("'")) {
          // `- key: value` 对象项：把后续更深缩进的 key 并入同一对象
          const obj: Record<string, unknown> = {};
          const key = parseYamlKey(kvMatch[1]);
          const inlineVal = kvMatch[2];
          pos += 1;
          if (inlineVal !== undefined && inlineVal !== '') {
            obj[key] = parseYamlScalar(inlineVal);
          } else if (pos < lines.length && lines[pos].indent > indent + 2) {
            obj[key] = parseBlock(lines[pos].indent);
          } else {
            obj[key] = null;
          }
          while (pos < lines.length && lines[pos].indent > indent && !lines[pos].content.startsWith('- ')) {
            const contMatch = lines[pos].content.match(/^([^:]+):(?:\s+(.*))?$/);
            if (!contMatch) break;
            const contKey = parseYamlKey(contMatch[1]);
            const contVal = contMatch[2];
            pos += 1;
            if (contVal !== undefined && contVal !== '') {
              obj[contKey] = parseYamlScalar(contVal);
            } else if (pos < lines.length && lines[pos].indent > indent + 2) {
              obj[contKey] = parseBlock(lines[pos].indent);
            } else {
              obj[contKey] = null;
            }
          }
          arr.push(obj);
          continue;
        }
        arr.push(parseYamlScalar(itemText));
        pos += 1;
      }
      return arr;
    }

    const obj: Record<string, unknown> = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].content.startsWith('- ')) {
      const line = lines[pos].content;
      const colonMatch = matchYamlKeyColon(line);
      if (!colonMatch) {
        throw new Error(`无法解析的 YAML 行：${line}`);
      }
      const { key, rest } = colonMatch;
      pos += 1;
      if (rest === '' || rest === undefined) {
        if (pos < lines.length && lines[pos].indent > indent) {
          obj[key] = parseBlock(lines[pos].indent);
        } else {
          obj[key] = null;
        }
      } else if (rest === '|' || rest === '|-') {
        obj[key] = parseLiteralBlock(indent, rest === '|-');
      } else {
        obj[key] = parseYamlScalar(rest);
      }
    }
    return obj;
  };

  const result = parseBlock(lines[0].indent);
  if (pos < lines.length) {
    throw new Error(`YAML 存在未消费的行（缩进不一致？）：${lines[pos].content}`);
  }
  return result;
}

function parseYamlKey(raw: string): string {
  const key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1);
  }
  return key;
}

/** 切出 `key: rest`；键可带引号（引号内的冒号不算分隔）。 */
function matchYamlKeyColon(line: string): { key: string; rest: string } | null {
  if (line.startsWith('"') || line.startsWith("'")) {
    const quote = line[0];
    const closeIdx = line.indexOf(quote, 1);
    if (closeIdx === -1) return null;
    const after = line.slice(closeIdx + 1).trimStart();
    if (!after.startsWith(':')) return null;
    return { key: line.slice(1, closeIdx), rest: after.slice(1).trim() };
  }
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  // `:` 后必须是行尾或空白，避免把 "http://x" 切开
  const next = line[idx + 1];
  if (next !== undefined && next !== ' ' && next !== '\t') return null;
  return { key: line.slice(0, idx).trim(), rest: line.slice(idx + 1).trim() };
}

/** 序列化为 YAML（对齐 yaml 库 blockQuote:'literal' 的观感；细节非逐字节一致）。 */
export function yamlStringify(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    if (value.includes('\n')) {
      const inner = value.replace(/\n$/, '').split('\n').map((l) => `${pad}  ${l}`).join('\n');
      return `|-\n${inner}`;
    }
    return yamlScalarString(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (isContainer(item)) {
          const nested = yamlStringify(item, indent + 1);
          if (Array.isArray(item) && item.length > 0) return `${pad}-\n${nested}`;
          if (isPlainObject(item) && Object.keys(item).length > 0) {
            // `- key: value` 首行内联
            const lines = nested.split('\n');
            const first = lines[0].trimStart();
            const rest = lines.slice(1);
            return [`${pad}- ${first}`, ...rest].join('\n');
          }
          return `${pad}- ${nested}`;
        }
        const scalar = yamlStringify(item, indent + 1);
        if (scalar.startsWith('|-')) {
          return `${pad}- ${scalar}`;
        }
        return `${pad}- ${scalar}`;
      })
      .join('\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return entries
    .map(([key, v]) => {
      const keyText = yamlScalarKey(key);
      if (isContainer(v)) {
        if ((Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0)) {
          return `${pad}${keyText}: ${Array.isArray(v) ? '[]' : '{}'}`;
        }
        return `${pad}${keyText}:\n${yamlStringify(v, indent + 1)}`;
      }
      const scalar = yamlStringify(v, indent);
      return `${pad}${keyText}: ${scalar}`;
    })
    .join('\n');
}

function yamlScalarString(value: string): string {
  if (value === '') return '""';
  const needsQuote =
    /^[\s#&*!|>%@`"'{[\]},-]/.test(value) ||
    /[:#]\s/.test(value) ||
    /\s$/.test(value) ||
    /^(?:true|false|null|~)$/i.test(value) ||
    /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ||
    value.includes(': ');
  return needsQuote ? JSON.stringify(value) : value;
}

function yamlScalarKey(key: string): string {
  if (key === '' || /[:#{}[\],&*!|>'"%@`]/.test(key) || /^\s|\s$/.test(key) || /^-/.test(key)) {
    return JSON.stringify(key);
  }
  return key;
}

// ============================================================================
// 初始变量（对齐 loadInitVarData + 本工具的 setvar 前缀方案）
// ============================================================================

interface CardEntryLike {
  comment?: unknown;
  name?: unknown;
  content?: unknown;
}

function extractCardData(card: unknown): Record<string, unknown> {
  if (!isPlainObject(card)) return {};
  const data = card.data;
  return isPlainObject(data) ? data : card;
}

function extractBookEntries(card: unknown): CardEntryLike[] {
  const data = extractCardData(card);
  const book = data.character_book;
  if (!isPlainObject(book)) return [];
  const entries = book.entries;
  if (Array.isArray(entries)) return entries.filter(isPlainObject) as CardEntryLike[];
  // ST 世界书 JSON 的 entries 也可能是对象表
  if (isPlainObject(entries)) return Object.values(entries).filter(isPlainObject) as CardEntryLike[];
  return [];
}

/** 剥掉 <initvar> 包裹与代码围栏（正则逐字对齐 loadInitVarData）。 */
function stripInitvarWrappers(content: string): string {
  let text = content;
  const xmlMatch = text.trim().match(/.*<initvar>.*\n([\s\S]*)\n.*<\/initvar>.*/m);
  if (xmlMatch) text = xmlMatch[1];
  const codeblockMatch = text.trim().match(/```.*\n([\s\S]*)\n```/m);
  if (codeblockMatch) text = codeblockMatch[1];
  return text;
}

export interface SetvarCall {
  path: string;
  value: unknown;
}

/**
 * 提取 EJS 里的 setvar/setLocalVar 调用（本工具开场白初始值方案）。
 * 只认第一个参数是 'stat_data.' 开头字符串字面量的调用。
 */
export function extractSetvarCalls(text: string): SetvarCall[] {
  const calls: SetvarCall[] = [];
  let i = 0;
  while (i < text.length) {
    const match = text.substring(i).match(/\b(?:setvar|setLocalVar)\s*\(/);
    if (!match || match.index === undefined) break;
    const openParen = i + match.index + match[0].length;
    const closeParen = findMatchingCloseParen(text, openParen);
    if (closeParen === -1) {
      i = openParen;
      continue;
    }
    const params = parseParameters(text.substring(openParen, closeParen));
    i = closeParen + 1;
    if (params.length < 2) continue;
    const rawPath = params[0].trim();
    const quote = rawPath[0];
    if ((quote !== "'" && quote !== '"') || rawPath[rawPath.length - 1] !== quote) continue;
    // 反转义 escapeEjsSingleQuoted 产物（\\ 与 \'）
    const path = rawPath.slice(1, -1).replace(/\\(['"\\])/g, '$1');
    if (!path.startsWith('stat_data.')) continue;
    // 值参数：字符串字面量同样反转义；其余（数字/布尔）走通用解析
    const rawValue = params[1].trim();
    const valueQuote = rawValue[0];
    const value =
      (valueQuote === "'" || valueQuote === '"') && rawValue[rawValue.length - 1] === valueQuote && rawValue.length >= 2
        ? rawValue.slice(1, -1).replace(/\\(['"\\])/g, '$1')
        : parseCommandValue(rawValue);
    calls.push({ path: path.slice('stat_data.'.length), value });
  }
  return calls;
}

const FIRST_MES_INITVAR_RE = /<(initvar)>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/\1>/gim;

/**
 * 从卡片解析初始 stat_data：
 *   [initvar] 世界书条目（含禁用的）→ 开场白 <initvar> 块（存在则整体覆盖）→
 *   开场白 EJS setvar 覆盖单点。开场白正文的命令由 buildVariableTimeline 统一执行。
 */
export function parseInitialVariables(card: unknown): MvuInitResult {
  const sources: string[] = [];
  const warnings: string[] = [];
  let statData: StatData = {};

  for (const entry of extractBookEntries(card)) {
    const label = typeof entry.comment === 'string' && entry.comment.trim()
      ? entry.comment
      : typeof entry.name === 'string' ? entry.name : '';
    // 真实 MVU 只看 comment；导出/导入路径两字段互为镜像，这里放宽到 comment ?? name
    if (!label.toLowerCase().includes('[initvar]')) continue;
    if (typeof entry.content !== 'string' || !entry.content.trim()) continue;
    try {
      const parsed = parseSimpleYaml(stripInitvarWrappers(entry.content));
      if (isPlainObject(parsed)) {
        if (exceedsDepth(parsed)) {
          warnings.push(`InitVar 条目「${label}」的数据嵌套过深（>${MAX_VALUE_DEPTH} 层），已忽略`);
        } else {
          mergeInitData(statData, parsed);
          sources.push(label);
        }
      } else if (parsed !== null) {
        warnings.push(`InitVar 条目「${label}」的内容不是对象，已忽略`);
      }
    } catch (err) {
      warnings.push(`InitVar 条目「${label}」解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const data = extractCardData(card);
  const firstMes = typeof data.first_mes === 'string' ? data.first_mes : '';

  if (firstMes) {
    // 开场白 <initvar> 块：真实语义是「以块内容为基准、忽略世界书 [initvar]」
    FIRST_MES_INITVAR_RE.lastIndex = 0;
    const overridden: StatData = {};
    let hasOverride = false;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = FIRST_MES_INITVAR_RE.exec(firstMes)) !== null) {
      try {
        const parsed = parseSimpleYaml(blockMatch[2]);
        if (isPlainObject(parsed)) {
          if (exceedsDepth(parsed)) {
            warnings.push(`开场白 <initvar> 块的数据嵌套过深（>${MAX_VALUE_DEPTH} 层），已忽略`);
          } else {
            mergeInitData(overridden, parsed);
            hasOverride = true;
          }
        }
      } catch (err) {
        warnings.push(`开场白 <initvar> 块解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (hasOverride) {
      statData = overridden;
      sources.push('开场白 <initvar> 块（覆盖世界书基线）');
    }

    const setvarCalls = extractSetvarCalls(firstMes);
    if (setvarCalls.length > 0) {
      for (const call of setvarCalls) {
        setAtPath(statData, call.path, call.value);
      }
      sources.push(`开场白 setvar ×${setvarCalls.length}`);
    }
  }

  return { statData, sources, warnings };
}

// ============================================================================
// 宏替换（对齐 js-slash-runner macro_like.ts）
// ============================================================================

function htmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 深度剔除以 $ 开头的键（对齐 omitDeepBy）。 */
export function omitDollarKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitDollarKeysDeep);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$')) continue;
      out[k] = omitDollarKeysDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * 路径捕获用 `[^{}\n]*`（贪婪、无歧义）而非真实实现的 `(.*?)`：后者在「有起始
 * 标记但永不闭合」的长行上是二次复杂度（每个起始位置都要懒扩展扫到行尾）。
 * 真实的变量路径不含 `{` / `}` / 换行，语义无损。
 */
const GET_VARIABLE_RE = /\{\{get_(message|chat|character|preset|global)_variable::([^{}\n]*)\}\}/gi;
/**
 * format 宏。真实实现用 `^(.*)\{\{format_…\}\}` 的贪婪前缀 + 对前缀递归，
 * 这里换成「逐行、从左到右迭代扫描」的等价实现（见 substituteVariableMacros）：
 * 语义相同（每个宏的续行缩进 = 该宏之前已解析文本的宽度），但避免了两个坑——
 * 递归深度 = 单行宏个数（约 5000 个即爆栈、渲染期 RangeError 掀翻整站），
 * 以及 `^(.*)` 在「有起始标记但永不闭合」的长行上的二次回溯。
 */
const FORMAT_VARIABLE_RE = /\{\{format_(message|chat|character|preset|global)_variable::([^{}\n]*)\}\}/gi;

interface MacroLookup {
  found: boolean;
  value: unknown;
}

function lookupMacroPath(variables: Record<string, unknown>, rawPath: string): MacroLookup {
  // 与真实实现一致不做 trim：`{{get_message_variable::stat_data.好感度 }}`（尾随空格）
  // 在真实运行时查不到（lodash 路径段含空格），这里同样进 unresolved，作者才能发现宏写坏了
  const path = htmlUnescape(rawPath);
  if (!path) return { found: false, value: undefined };
  if (!hasAtPath(variables, path)) return { found: false, value: undefined };
  return { found: true, value: omitDollarKeysDeep(getAtPath(variables, path)) };
}

/**
 * 把已渲染 HTML 里的变量宏替换为 statData 的实际值。
 *   - 仅解析 message 类型（差距 4）；
 *   - 路径不存在保留宏原样并计入 unresolved（差距 5，真实运行时渲染 "null"）。
 */
export function substituteVariableMacros(html: string, statData: StatData): MvuMacroResult {
  const variables: Record<string, unknown> = { stat_data: statData };
  const unresolved: string[] = [];

  // 顺序对齐真实 macros 数组（get 在前、format 在后）：format 计算前缀宽度时
  // 同行的 get 宏必须已经替换成实际值，否则续行缩进按宏原文宽度算、YAML 块右漂
  const afterGet = html.replace(GET_VARIABLE_RE, (substring: string, type: string, path: string) => {
    if (type.toLowerCase() !== 'message') {
      unresolved.push(substring);
      return substring;
    }
    const lookup = lookupMacroPath(variables, path);
    if (!lookup.found) {
      unresolved.push(substring);
      return substring;
    }
    return typeof lookup.value === 'string' ? lookup.value : JSON.stringify(lookup.value);
  });

  // format 宏：逐行、从左到右迭代（真实实现的贪婪前缀 + 递归的等价形式）。
  // 每个宏的续行缩进 = 该宏之前**已解析**文本在本行的宽度。
  const lines = afterGet.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    FORMAT_VARIABLE_RE.lastIndex = 0;
    if (!FORMAT_VARIABLE_RE.test(line)) continue;
    FORMAT_VARIABLE_RE.lastIndex = 0;

    let resolved = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = FORMAT_VARIABLE_RE.exec(line)) !== null) {
      resolved += line.slice(cursor, match.index);
      cursor = match.index + match[0].length;
      const [macroText, type, path] = match;

      if (type.toLowerCase() !== 'message') {
        unresolved.push(macroText);
        resolved += macroText;
        continue;
      }
      const lookup = lookupMacroPath(variables, path);
      if (!lookup.found) {
        unresolved.push(macroText);
        resolved += macroText;
        continue;
      }
      const text = typeof lookup.value === 'string'
        ? lookup.value
        : yamlStringify(lookup.value).trimEnd();
      resolved += text.replaceAll('\n', '\n' + ' '.repeat(resolved.length));
    }
    lines[li] = resolved + line.slice(cursor);
  }

  return { html: lines.join('\n'), unresolved: Array.from(new Set(unresolved)) };
}

// ============================================================================
// 消息显示后处理（对齐 handleVariablesInMessage 的两个渲染侧行为）
// ============================================================================

const STATUS_CURRENT_VARIABLE_RE = /<(status_current_variable)>(?:(?!<\1>).)*<\/\1?>/gis;
const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';
/** EJS 块（<% ... %>，含 <%_ _%> 变体）。仅当内容全是 setvar/setLocalVar 调用时才删。 */
const EJS_BLOCK_RE = /<%[_=-]?([\s\S]*?)[_-]?%>/g;
/**
 * 内层用 `[^)]*` 而非 `[\s\S]*?`：后者让每次重复都能跨越任意多个 `)` 与内嵌的
 * setvar token，N 个连续调用有 2^(N-1) 种切分，末尾多一个字符导致匹配失败时
 * 引擎会穷举全部切分——30 个 setvar（427 字节）就能把主线程永久冻住。
 * 现在每次重复的边界唯一确定，匹配是线性的。
 * 代价：参数字符串里含字面量 `)` 的调用不再被识别为「纯 setvar 块」，
 * 该块会原样保留而不是删除——失败方向安全（多显示一段文字，而非卡死）。
 */
const SETVAR_ONLY_RE = /^[\s;]*(?:(?:setvar|setLocalVar)\s*\([^)]*\)[\s;]*)+$/;

export interface MvuDisplayOptions {
  /** 卡里存在状态栏占位符替换脚本时，给缺占位符的 AI 消息补上（对齐真实 MVU） */
  appendPlaceholder: boolean;
}

/**
 * MVU 激活时对 AI 消息的显示预处理（在卡内正则脚本之前跑，对应真实运行时
 * 「MVU 修改消息存储 → ST 正则显示替换」的顺序）：
 *   1. 缺 <StatusPlaceHolderImpl/> 时补到末尾——判定必须在删块**之前**（对齐真实
 *      handleVariablesInMessage 的顺序）：占位符只出现在 <status_current_variable>
 *      块内时，真实运行时判定「已存在」不补、随后连块一起删掉、状态栏不渲染；
 *   2. 删 <status_current_variable> 块；
 *   3. 删纯 setvar 的 EJS 初始化块（真实运行时由酒馆助手模板引擎吃掉）。
 */
export function applyMvuDisplayPostProcess(text: string, opts: MvuDisplayOptions): string {
  let out = text;
  if (opts.appendPlaceholder && !out.includes(STATUS_PLACEHOLDER)) {
    out += `\n\n${STATUS_PLACEHOLDER}`;
  }
  out = out.replace(STATUS_CURRENT_VARIABLE_RE, '');
  out = out.replace(EJS_BLOCK_RE, (whole: string, inner: string) => (SETVAR_ONLY_RE.test(inner) ? '' : whole));
  return out;
}

/**
 * 提示词/世界书扫描通道用：删掉 AI 消息里的 <status_current_variable> 块。
 * 真实 MVU 会把该块从消息存储里物理删除（handleVariablesInMessage 改写后
 * setChatMessages），因此后续轮次发给 AI 的历史与 WI 扫描都看不到它——
 * 试聊侧必须同样处理，否则块里的变量转储会被回喂给 AI 并误触发世界书条目。
 */
export function stripStatusCurrentVariable(text: string): string {
  return text.replace(STATUS_CURRENT_VARIABLE_RE, '');
}

// ============================================================================
// 时间线：初始值 + 按消息序列重放（重 roll 回滚天然成立）
// ============================================================================

export interface TimelineMessage {
  role: string;
  content: string;
}

/**
 * 对整段会话按序重放变量演进。messages 是唯一事实来源——重 roll 丢掉尾部消息后
 * 重算即自动回滚，无需额外状态。真实 MVU 对用户消息同样执行命令（可手动作弊），
 * 以及「assistant 消息 < 5 字符跳过」的怪癖，均如实移植。
 */
export function buildVariableTimeline(card: unknown, messages: TimelineMessage[]): MvuTimeline {
  const init = parseInitialVariables(card);
  const snapshots: StatData[] = [];
  const changesByMessage: MvuChange[][] = [];
  const warningsByMessage: string[][] = [];

  let current = init.statData;
  let sawCommands = false;
  for (const message of messages) {
    if (message.role === 'assistant' && message.content.length < 5) {
      snapshots.push(current);
      changesByMessage.push([]);
      warningsByMessage.push([]);
      continue;
    }
    const result = applyUpdateBlocks(current, message.content);
    if (result.changes.length > 0) sawCommands = true;
    current = result.statData;
    snapshots.push(current);
    changesByMessage.push(result.changes);
    warningsByMessage.push(result.warnings);
  }

  const active = init.sources.length > 0 || Object.keys(init.statData).length > 0 || sawCommands;
  return { active, init, snapshots, changesByMessage, warningsByMessage };
}
