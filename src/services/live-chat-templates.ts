/**
 * live-chat-templates — 直播间评论面板 HTML 模板生成器
 *
 * 架构（正则驱动 + 可选 MVU 增强）：
 *   - 注入层：占位符 `<LiveStreamChatImpl/>`（card-exporter 负责）
 *   - 渲染层：运行时 JS 立即渲染内置初始评论（无需任何外部依赖）
 *   - 增强层（可选）：若 MVU 运行时可用，订阅 VARIABLE_UPDATE_ENDED 事件
 *             读取 `stat_data.直播间.评论` 实现动态更新
 *
 * 防御性渲染策略：
 *   - AI 发送空数组 [] 时不清空面板，保留上一轮显示（观众永远不沉默）
 *   - AI 发送全无效内容时保留上一轮显示
 *   - 初始化时即使无初始评论也进入"等待直播开始"状态，不留空白
 *
 * 生成物是完整 HTML 文档（```html 代码块），含 <style> + <script type="module"> + <body>。
 */

import { getStatusBarThemeById } from './status-bar-templates';
import type { StatusBarTheme } from './status-bar-templates';
import { escapeHtml } from '../utils/html';

// ════════════════════════════════════════════════════════════════════════════
// 配置选项
// ════════════════════════════════════════════════════════════════════════════

export interface LiveChatGenerateOptions {
  /** 跟随状态栏主题（terminal/parchment/glass/paper） */
  themeId?: string;
  /** 面板标题 */
  title?: string;
  /** 初始评论数显示上限（超出滚动） */
  maxVisible?: number;
  /** 内置初始评论（直接渲染，无需 MVU） */
  initialComments?: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// 组件样式表（引用 CSS 变量，主题无关）
// ════════════════════════════════════════════════════════════════════════════

const COMPONENT_CSS = `
.lc-root{box-sizing:border-box;width:100%;max-width:560px;margin:8px 0;background:var(--sb-bg);color:var(--sb-text);font-family:var(--sb-font);border:1px solid var(--sb-border);border-radius:var(--sb-radius);overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.18);backdrop-filter:var(--sb-blur);-webkit-backdrop-filter:var(--sb-blur)}
.lc-root *,.lc-root *::before,.lc-root *::after{box-sizing:border-box}
.lc-header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--sb-bg-3);cursor:pointer;user-select:none;border-bottom:1px solid var(--sb-border)}
.lc-header:hover{filter:brightness(1.06)}
.lc-dot{width:8px;height:8px;border-radius:50%;background:var(--sb-danger);box-shadow:0 0 6px var(--sb-danger);animation:lc-pulse 1.4s infinite;flex-shrink:0}
@keyframes lc-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.lc-title{font-size:13px;font-weight:700;color:var(--sb-accent);letter-spacing:.5px;flex:1;min-width:0}
.lc-count{font-size:10px;color:var(--sb-text-dim);flex-shrink:0}
.lc-arrow{font-size:9px;color:var(--sb-text-dim);transition:transform .18s ease;flex-shrink:0}
.lc-root.lc-collapsed .lc-body{display:none}
.lc-root.lc-collapsed .lc-arrow{transform:rotate(-90deg)}
.lc-body{max-height:340px;overflow-y:auto;padding:6px 10px;scrollbar-width:thin;scrollbar-color:var(--sb-border) transparent}
.lc-body::-webkit-scrollbar{width:5px}
.lc-body::-webkit-scrollbar-thumb{background:var(--sb-border);border-radius:3px}
.lc-msg{display:flex;gap:7px;padding:4px 0;animation:lc-in .35s ease both}
.lc-msg:nth-child(n+3){animation-delay:.04s}
@keyframes lc-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.lc-avatar{width:24px;height:24px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:11px;border:1px solid rgba(255,255,255,.15)}
.lc-bubble{min-width:0;flex:1}
.lc-meta{display:flex;align-items:baseline;gap:5px;margin-bottom:1px}
.lc-name{font-size:11px;font-weight:700;color:var(--sb-accent);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lc-time{font-size:9px;color:var(--sb-text-dim);flex-shrink:0}
.lc-text{font-size:12px;line-height:1.45;color:var(--sb-text);word-break:break-word;white-space:pre-wrap}
.lc-empty{padding:14px 8px;text-align:center;font-size:11px;color:var(--sb-text-dim)}
@media(max-width:520px){.lc-root{max-width:100%}.lc-title{font-size:12px}.lc-text{font-size:11px}.lc-body{max-height:280px}}
`.trim();

// ════════════════════════════════════════════════════════════════════════════
// 文档组装
// ════════════════════════════════════════════════════════════════════════════

function buildThemeVarsCss(theme: StatusBarTheme): string {
  const entries = Object.entries(theme.vars).map(([k, v]) => `${k}:${v};`).join('');
  return `.lc-root{${entries}}`;
}

function buildBodyHtml(opts: LiveChatGenerateOptions): string {
  const title = opts.title || '直播间';
  const maxVisible = opts.maxVisible ?? 10;
  return `<div class="lc-root" id="lc-root" data-max="${maxVisible}">
  <div class="lc-header" id="lc-header">
    <span class="lc-dot"></span>
    <span class="lc-title">${escapeHtml(title, { quotes: true })}</span>
    <span class="lc-count" id="lc-count">0 人在线</span>
    <span class="lc-arrow">▼</span>
  </div>
  <div class="lc-body" id="lc-body">
    <div class="lc-empty">等待直播开始…</div>
  </div>
</div>`;
}

function buildRuntimeScript(initialComments: string[]): string {
  const commentsJson = JSON.stringify(initialComments);
  return `<script type="module">
// ── 内置初始评论（无需 MVU，立即渲染） ──
var LC_INITIAL = ${commentsJson};
// ── 当前显示的评论（用于防御性渲染：AI 发空数组不清空面板） ──
var LC_CURRENT = [];

// ── 自包含路径读取 ──
function lcGet(obj, path, def) {
  var parts = path.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return def;
    cur = cur[parts[i]];
  }
  return cur === undefined ? def : cur;
}

// ── 内置用户名池与色相种子 ──
var LC_NAMES = ['路人甲','吃瓜群众','老司机','柠檬精','潜水员','键盘侠','催更党','剧透怪','萌新','大佬','铁粉','黑粉','路人乙','围观人士','吃瓜侠','沙发党','前排就坐','路过','匿名观众','潜水怪','杠精','佛系观众','气氛组','电灯泡'];
var LC_USED_NAMES = [];
var LC_USED_HUES = [];

function lcPickName(idx) {
  // 尽量不重复，用尽后循环
  if (LC_USED_NAMES.length >= LC_NAMES.length) {
    LC_USED_NAMES = [];
    LC_USED_HUES = [];
  }
  var name;
  var tries = 0;
  do {
    name = LC_NAMES[Math.floor(Math.random() * LC_NAMES.length)];
    tries++;
  } while (LC_USED_NAMES.indexOf(name) !== -1 && tries < 8);
  LC_USED_NAMES.push(name);
  // 色相均匀分布，避免相邻颜色撞色
  var hue = (idx * 47 + Math.floor(Math.random() * 30)) % 360;
  LC_USED_HUES.push(hue);
  return { name: name, hue: hue };
}

// ── 时间戳生成 ──
var LC_BASE_TS = null;
function lcTimeStr(idx, total) {
  if (LC_BASE_TS === null) LC_BASE_TS = Date.now();
  // 越靠后的评论时间越新，每条间隔 2-6 秒
  var offset = (total - idx) * (2 + Math.floor(Math.random() * 5));
  var d = new Date(LC_BASE_TS - offset * 1000);
  var hh = String(d.getHours()).padStart(2,'0');
  var mm = String(d.getMinutes()).padStart(2,'0');
  return hh + ':' + mm;
}

// ── HTML 转义 ──
function lcEsc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── 渲染评论列表 ──
function lcRender(comments) {
  var body = document.getElementById('lc-body');
  var countEl = document.getElementById('lc-count');
  if (!body) return;
  if (!Array.isArray(comments) || comments.length === 0) {
    // 空数组：保留当前显示，不清空面板（避免 AI 发空数组清屏）
    if (LC_CURRENT.length > 0) {
      comments = LC_CURRENT;
    } else {
      body.innerHTML = '<div class="lc-empty">等待直播开始…</div>';
      if (countEl) countEl.textContent = '0 人在线';
      return;
    }
  }
  // 重置每轮的名称/色相分配，让同一轮评论用户名多样
  LC_USED_NAMES = [];
  LC_USED_HUES = [];
  LC_BASE_TS = null;
  var total = comments.length;
  var html = '';
  var valid = 0;
  for (var i = 0; i < total; i++) {
    var text = comments[i];
    if (text == null) continue;
    text = String(text).trim();
    if (!text) continue;
    valid++;
    var info = lcPickName(i);
    var color = 'hsl(' + info.hue + ',65%,55%)';
    var initial = info.name.charAt(0);
    var time = lcTimeStr(i, total);
    html += '<div class="lc-msg">'
      + '<div class="lc-avatar" style="background:' + color + '">' + lcEsc(initial) + '</div>'
      + '<div class="lc-bubble">'
      + '<div class="lc-meta"><span class="lc-name">' + lcEsc(info.name) + '</span><span class="lc-time">' + time + '</span></div>'
      + '<div class="lc-text">' + lcEsc(text) + '</div>'
      + '</div></div>';
  }
  if (valid === 0) {
    // 所有评论都无效：保留当前显示
    if (LC_CURRENT.length > 0) {
      return;
    }
    body.innerHTML = '<div class="lc-empty">等待直播开始…</div>';
    if (countEl) countEl.textContent = '0 人在线';
    return;
  }
  LC_CURRENT = comments;
  body.innerHTML = html;
  if (countEl) {
    var online = Math.min(valid, 99) + Math.floor(Math.random() * 200) + 1;
    countEl.textContent = online + ' 人在线';
  }
  // 自动滚动到底部
  body.scrollTop = body.scrollHeight;
}

// ── 从 MVU 变量读取评论并渲染（可选增强） ──
function lcPopulate() {
  try {
    var all = (typeof getAllVariables === 'function') ? getAllVariables() : {};
    var comments = lcGet(all, 'stat_data.直播间.评论', []);
    // 兼容标量：非数组包一层
    if (!Array.isArray(comments)) comments = comments == null ? [] : [String(comments)];
    // 防御性：空数组不清空面板（AI 可能本轮不发弹幕，保留上一轮显示）
    lcRender(comments);
  } catch (e) { /* MVU 读取失败不影响静态展示 */ }
}

// ── 初始化：立即渲染内置评论，再尝试订阅 MVU 动态更新 ──
async function lcInit() {
  // 1. 立即渲染内置评论（无需任何外部依赖）
  //    即使 LC_INITIAL 为空也调用 lcRender，让面板进入"等待直播开始"状态
  lcRender(LC_INITIAL);

  // 2. 可选：等待 MVU 运行时就绪后订阅变量更新事件实现动态刷新
  //    不等待会导致 MVU 尚未初始化时订阅失败，后续 AI 更新评论无法动态显示
  try {
    if (typeof waitGlobalInitialized === 'function') { await waitGlobalInitialized('Mvu'); }
  } catch (e) { /* MVU 不可用不影响静态展示 */ }
  try {
    if (typeof eventOn === 'function' && typeof Mvu !== 'undefined' && Mvu.events) {
      eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, lcPopulate);
    }
  } catch (e) { /* MVU 不可用不影响静态展示 */ }

  // 3. 折叠交互
  var header = document.getElementById('lc-header');
  var root = document.getElementById('lc-root');
  if (header && root) {
    header.addEventListener('click', function(){ root.classList.toggle('lc-collapsed'); });
  }
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', lcInit); }
  else { lcInit(); }
}
</script>`;
}

function buildDocument(theme: StatusBarTheme, bodyHtml: string, initialComments: string[]): string {
  const css = `${buildThemeVarsCss(theme)}\n${COMPONENT_CSS}`;
  const script = buildRuntimeScript(initialComments);
  return '```html\n<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<style>\n'
    + css
    + '\n</style>\n'
    + script
    + '\n</head>\n<body>\n'
    + bodyHtml
    + '\n</body>\n</html>\n```';
}

// ════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════

/** 默认内置评论（无需 MVU 即可展示） */
const DEFAULT_COMMENTS = ['开播了开播了！', '前排吃瓜', '这次什么剧本？', '蹲一个', '主播冲鸭'];

/** 生成直播间评论面板 HTML 文档（```html 代码块） */
export function generateLiveChatHtml(opts: LiveChatGenerateOptions = {}): string {
  const theme = getStatusBarThemeById(opts.themeId || 'terminal');
  const bodyHtml = buildBodyHtml(opts);
  const comments = opts.initialComments ?? DEFAULT_COMMENTS;
  return buildDocument(theme, bodyHtml, comments);
}
