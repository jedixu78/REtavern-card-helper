/**
 * chat-render — 把卡内 SillyTavern 正则脚本应用到试聊消息，并准备沙盒渲染。
 *
 * 试聊此前直接把 AI 原文贴在气泡里：卡里的 `<StatusPlaceHolderImpl/>` /
 * `<LiveStreamChatImpl/>` 占位符原样露出，状态栏和直播间面板一个都看不到，
 * 本工具主打的状态栏卡在自己的试聊里等于零验证价值。本模块补上 ST 的
 * regex_scripts 显示层替换，并把替换后的 HTML 交给 sandbox iframe 渲染。
 *
 * 实现的 ST 语义：
 *   - findRegex 支持 `/pattern/flags` 正则与纯字符串字面量两种写法
 *   - replaceString 支持 `{{match}}` 与 `$1..$9` 捕获组
 *   - trimStrings：替换前从命中文本里剔除的片段
 *   - disabled / promptOnly / markdownOnly 决定脚本走「显示」还是「提示词」通道
 *   - placement：1=用户输入，2=AI 输出（为空表示不限）
 *
 * 刻意不实现：minDepth / maxDepth（按楼层深度限制）、substituteRegex（宏替换）、
 * runOnEdit。UI 应如实说明差距。
 */

/** 卡片 data.extensions.regex_scripts 里的一条脚本 */
export interface CardRegexScript {
  id?: string;
  scriptName?: string;
  findRegex?: string;
  replaceString?: string;
  trimStrings?: string[];
  /** 1=用户输入 2=AI 输出 3=斜杠命令 5=世界书 */
  placement?: number[];
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
}

/** display = 界面显示通道（排除 promptOnly）；prompt = 发给 AI 的通道（排除 markdownOnly） */
export type RegexPass = 'display' | 'prompt';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface RenderSegment {
  type: 'text' | 'html';
  content: string;
}

const PLACEMENT_BY_ROLE: Record<ChatRole, number> = {
  user: 1,
  assistant: 2,
  // 试聊不展示 system 消息，按 AI 输出处理即可
  system: 2,
};

/** 从卡片对象里取出正则脚本数组（结构不符时返回空数组，绝不抛错）。 */
export function extractRegexScripts(card: unknown): CardRegexScript[] {
  const data = (card as { data?: unknown })?.data as { extensions?: unknown } | undefined;
  const ext = data?.extensions as { regex_scripts?: unknown } | undefined;
  const scripts = ext?.regex_scripts;
  if (!Array.isArray(scripts)) return [];
  return scripts.filter((s): s is CardRegexScript => Boolean(s) && typeof s === 'object');
}

/** 该脚本是否参与本次通道 + 该角色的替换。 */
function scriptApplies(script: CardRegexScript, pass: RegexPass, role: ChatRole): boolean {
  if (script.disabled === true) return false;
  if (!script.findRegex) return false;
  // ST：promptOnly 的脚本只改发给 AI 的文本，markdownOnly 的只改界面显示；
  // 两个都为 false 表示两边都改。
  if (pass === 'display' && script.promptOnly === true) return false;
  if (pass === 'prompt' && script.markdownOnly === true) return false;

  const placement = script.placement;
  if (Array.isArray(placement) && placement.length > 0) {
    if (!placement.includes(PLACEMENT_BY_ROLE[role])) return false;
  }
  return true;
}

/**
 * 解析 findRegex。ST 的 regexFromString 里斜杠是**可选**的：
 *   - `/pattern/flags` → 按给定 flags 编译
 *   - 裸写的 pattern    → 同样当正则编译（参考卡「二十一人会」的界面脚本就是裸写
 *     `<initial_setup>[\s\S]*?<\/initial_setup>`，当成字面量的话整条脚本会哑火）
 *   - 编译不过（比如就是一段带 `(` 的普通文本）→ 返回 null，调用方退回字面量替换
 *
 * 与 ST 的唯一差异：裸写 pattern 我们补 g（ST 只替换第一处）。占位符类脚本一条
 * 消息里可能出现多次，全替换才是用户预期。
 */
function parseFindRegex(find: string): RegExp | null {
  const slashed = find.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  if (slashed) {
    try {
      // 统一补上 g：ST 的替换是全局的
      const flags = slashed[2].includes('g') ? slashed[2] : `${slashed[2]}g`;
      return new RegExp(slashed[1], flags);
    } catch {
      // 非法正则 → 落到下面的裸写尝试 / 字面量兜底
    }
  }
  try {
    return new RegExp(find, 'g');
  } catch {
    return null;
  }
}

/**
 * 按 ST 语义生成替换文本。单遍扫描，避免 `{{match}}` 插入的内容里若含 `$1`
 * 被二次解释（状态栏 replaceString 是整块 HTML，二次解释会把它改坏）。
 */
function buildReplacement(
  captures: (string | undefined)[],
  replaceString: string,
  trimStrings: string[],
): string {
  let matched = captures[0] ?? '';
  for (const trim of trimStrings) {
    if (trim) matched = matched.split(trim).join('');
  }
  return replaceString.replace(/\{\{match\}\}|\$(\d{1,2})/g, (whole, digit?: string) => {
    if (digit === undefined) return matched;
    const index = Number(digit);
    if (index === 0) return matched;
    const group = captures[index];
    // 越界的 $n 原样保留（HTML/CSS 里可能就是普通字符）
    return group === undefined ? whole : group;
  });
}

/** 从 String.replace 回调的可变参数里还原捕获组数组（剔除 offset / 原串 / 命名组）。 */
function capturesFromReplaceArgs(args: unknown[]): (string | undefined)[] {
  let end = args.length;
  const last = args[end - 1];
  if (typeof last === 'object' && last !== null) end -= 1; // 命名捕获组对象
  end -= 2; // offset, whole string
  return args.slice(0, Math.max(end, 1)) as (string | undefined)[];
}

function applyOneScript(text: string, script: CardRegexScript): string {
  const find = script.findRegex ?? '';
  const replaceString = script.replaceString ?? '';
  const trimStrings = Array.isArray(script.trimStrings) ? script.trimStrings : [];
  if (!find) return text;

  const re = parseFindRegex(find);
  if (re) {
    return text.replace(re, (...args: unknown[]) =>
      buildReplacement(capturesFromReplaceArgs(args), replaceString, trimStrings),
    );
  }
  // 字面量替换：不能走 String.replace 的 `$` 语义，否则 replaceString 里的
  // `$&` / `$'` 会被 JS 解释掉。
  if (!text.includes(find)) return text;
  return text.split(find).join(buildReplacement([find], replaceString, trimStrings));
}

/**
 * 按顺序应用卡内正则脚本。单条脚本抛错只跳过该条，不影响其余脚本与消息显示。
 */
export function applyRegexScripts(
  text: string,
  scripts: CardRegexScript[],
  opts: { pass?: RegexPass; role?: ChatRole } = {},
): string {
  const pass = opts.pass ?? 'display';
  const role = opts.role ?? 'assistant';
  if (!text || !Array.isArray(scripts) || scripts.length === 0) return text;

  let out = text;
  for (const script of scripts) {
    if (!scriptApplies(script, pass, role)) continue;
    try {
      out = applyOneScript(out, script);
    } catch {
      // 单条脚本写坏了不该让整条消息渲染失败
    }
  }
  return out;
}

/** 未被围栏包住、但明显是 HTML 块的启发式判定（避免把 <怒> 之类的角色扮演文本误判）。 */
const RAW_HTML_BLOCK =
  /<\s*(div|section|table|style|script|figure|article|main|header|footer|nav|aside|details|iframe|span|p|ul|ol|li|svg|canvas|form|button|a|h[1-6]|pre|code|blockquote|dl|dt|dd|summary|picture|video|audio|source|template|slot)\b/i;

export function messageContainsHtml(text: string): boolean {
  if (!text) return false;
  if (/```[ \t]*html\b/i.test(text)) return true;
  return RAW_HTML_BLOCK.test(text);
}

/** 已闭合的 ```html 围栏 */
const CLOSED_HTML_FENCE = /```[ \t]*html[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;
/** 未闭合的 ```html 围栏（AI 回复被截断时会出现），其后内容仍按 HTML 处理 */
const OPEN_HTML_FENCE = /```[ \t]*html[ \t]*\r?\n([\s\S]*)$/i;

/**
 * 把（已应用正则脚本的）消息切成纯文本段与 HTML 段。
 * HTML 段交给 sandbox iframe 渲染，文本段照常按气泡文字显示。
 */
export function segmentRenderedMessage(text: string): RenderSegment[] {
  if (!text) return [];
  const segments: RenderSegment[] = [];

  const pushHtml = (chunk: string) => {
    if (chunk.trim()) segments.push({ type: 'html', content: chunk });
  };
  const pushPlain = (chunk: string) => {
    if (!chunk.trim()) return;
    if (RAW_HTML_BLOCK.test(chunk)) {
      // 没有围栏但含 HTML 块（AI 直接吐 HTML，或脚本替换出裸 HTML）
      pushHtml(chunk.trim());
      return;
    }
    segments.push({ type: 'text', content: chunk.replace(/^\n+|\n+$/g, '') });
  };

  CLOSED_HTML_FENCE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = CLOSED_HTML_FENCE.exec(text)) !== null) {
    pushPlain(text.slice(cursor, match.index));
    pushHtml(match[1] ?? '');
    cursor = match.index + match[0].length;
  }

  // 尾段：闭合围栏都消费完了，这里才可能残留一个未闭合的开围栏
  const tail = text.slice(cursor);
  const open = tail.match(OPEN_HTML_FENCE);
  if (open) {
    pushPlain(tail.slice(0, open.index ?? 0));
    pushHtml(open[1] ?? '');
  } else {
    pushPlain(tail);
  }

  return segments;
}

/** iframe 高度自适应消息的判别字段（父窗口据此过滤无关 postMessage）。 */
export const CHAT_FRAME_MESSAGE_KEY = '__retavernChatFrame';

export interface ChatFrameHeightMessage {
  frameId: string;
  height: number;
}

/** 解析沙盒 iframe 回传的高度消息；结构不符返回 null。 */
export function parseChatFrameMessage(data: unknown): ChatFrameHeightMessage | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const frameId = record[CHAT_FRAME_MESSAGE_KEY];
  const height = record.height;
  if (typeof frameId !== 'string' || !frameId) return null;
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null;
  // 单条消息面板不该顶到天上去，防止畸形内容把页面撑爆
  return { frameId, height: Math.min(Math.ceil(height), 4000) };
}

/**
 * 生成沙盒 iframe 的 srcDoc。
 *
 * 安全边界：调用方必须用 `sandbox="allow-scripts"`（**不带 allow-same-origin**）。
 * 卡内 HTML 与脚本来自用户导入的第三方卡片，只有在不可写同源的沙盒里跑，
 * 才拿不到本站的 IndexedDB / localStorage（里面存着用户的 API Key）与父页面 DOM。
 */
/** 卡内 HTML 已经是一份完整文档（参考卡的状态栏 replaceString 就是 `<!doctype html>…`） */
const FULL_DOCUMENT = /^\s*(<!doctype\s+html|<html[\s>])/i;

export function buildSandboxSrcDoc(html: string, frameId: string): string {
  // 拆开写：源码里出现字面量 </script> 会在「打包产物被内联进 HTML」的场景下提前闭合标签
  const CLOSE_SCRIPT_TAG = '<' + '/script>';
  const bootstrap = `(function(){
  var id = ${JSON.stringify(frameId)};
  function measure(){
    // 不能用 documentElement.scrollHeight：它有视口下限，iframe 高度会自锁在初始值再也降不下来。
    // 以 body 的内容高度为准，body 量不到（display:none 等）才退回文档高度。
    var b = document.body;
    if (!b) return document.documentElement.scrollHeight;
    var h = Math.max(b.scrollHeight, Math.ceil(b.getBoundingClientRect().bottom));
    return h > 0 ? h : document.documentElement.scrollHeight;
  }
  function post(){
    try {
      parent.postMessage({ ${JSON.stringify(CHAT_FRAME_MESSAGE_KEY)}: id, height: measure() }, '*');
    } catch (e) { /* 沙盒里父窗口不可达时静默 */ }
  }
  window.addEventListener('load', post);
  if (window.ResizeObserver) {
    try { new ResizeObserver(post).observe(document.body || document.documentElement); } catch (e) {}
  }
  setTimeout(post, 60); setTimeout(post, 300); setTimeout(post, 1200);
})();`;
  const scriptTag = `<script>${bootstrap}${CLOSE_SCRIPT_TAG}`;

  // 卡片自带完整文档时不再套一层（嵌套 html/head/body 会让它的样式表现走样），
  // 只把高度上报脚本注入到 </body> 之前。
  if (FULL_DOCUMENT.test(html)) {
    const idx = html.toLowerCase().lastIndexOf('</body>');
    return idx >= 0 ? html.slice(0, idx) + scriptTag + html.slice(idx) : html + scriptTag;
  }

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; background: transparent; color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 14px; overflow-x: hidden; }
  img, video, canvas, svg { max-width: 100%; }
</style>
</head><body>
${html}
${scriptTag}
</body></html>`;
}
