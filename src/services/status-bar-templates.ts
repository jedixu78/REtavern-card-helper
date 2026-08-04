/**
 * status-bar-templates — 可复用状态栏模板系统（JS 运行时动态渲染）
 *
 * 设计来源：逆向分析 6 张成熟参考卡（遗界/御兽/斗破苍穹/埃瑟尔德/二十一人会/北风之殇）。
 *
 * 架构（注入层 × 数据层 × 渲染层）：
 *   - 注入层：沿用占位符替换 `<StatusPlaceHolderImpl/>`（card-exporter 已支持）
 *   - 数据层：MVU 运行时（MagVarUpdate bundle）提供 getAllVariables()/Mvu/eventOn 等全局，
 *             状态栏脚本订阅 VARIABLE_UPDATE_ENDED 事件实现变量更新→自动重渲染
 *   - 渲染层：schema 反射自动选型（number+range→资源条 / enum→语义徽章 / string→数据行 /
 *             boolean→状态标签 / object|array→列表），CSS 变量驱动主题，一套组件多套皮肤
 *
 * 生成物是完整 HTML 文档（```html 代码块），含 <style> + <script type="module"> + <body>，
 * 由 SillyTavern 渲染 HTML 代码块时执行脚本。
 */

import type { MvuSchemaSection, MvuVariable } from '../constants/defaults';
import { escapeHtml } from '../utils/html';

// ════════════════════════════════════════════════════════════════════════════
// 主题系统（CSS 变量层 — 埃瑟尔德范式：组件只引用变量，主题=变量覆盖包）
// ════════════════════════════════════════════════════════════════════════════

export interface StatusBarTheme {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** CSS 自定义属性覆盖包 */
  vars: Record<string, string>;
}

export const STATUS_BAR_THEMES: StatusBarTheme[] = [
  {
    id: 'terminal',
    name: '战术终端',
    icon: '🖥️',
    description: '暗黑等宽终端风（北风之殇范式）',
    vars: {
      '--sb-bg': '#0e100f', '--sb-bg-2': '#141613', '--sb-bg-3': '#1c1f1a',
      '--sb-text': '#c0c0b0', '--sb-text-dim': '#7a7a60', '--sb-accent': '#9a8c6b',
      '--sb-border': '#2a2a20', '--sb-good': '#709050', '--sb-warn': '#c8a030',
      '--sb-danger': '#b04030', '--sb-bar-track': '#1a1a14', '--sb-radius': '2px',
      '--sb-font': "'Courier New','Source Code Pro',monospace", '--sb-blur': 'none',
    },
  },
  {
    id: 'parchment',
    name: '羊皮纸',
    icon: '📜',
    description: '暖色衬线古风（遗界/埃瑟尔德范式）',
    vars: {
      '--sb-bg': '#f4e4bc', '--sb-bg-2': '#ecdcB0', '--sb-bg-3': '#e3c889',
      '--sb-text': '#3d2914', '--sb-text-dim': '#6b5236', '--sb-accent': '#8b4513',
      '--sb-border': '#b8975a', '--sb-good': '#5a8a3a', '--sb-warn': '#c8860a',
      '--sb-danger': '#c0392b', '--sb-bar-track': '#d8c49a', '--sb-radius': '6px',
      '--sb-font': "'Noto Serif SC','Songti SC',serif", '--sb-blur': 'none',
    },
  },
  {
    id: 'glass',
    name: '毛玻璃光幕',
    icon: '✨',
    description: '半透明金边玄幻（斗破苍穹范式）',
    vars: {
      '--sb-bg': 'rgba(25,10,5,0.88)', '--sb-bg-2': 'rgba(45,22,10,0.72)', '--sb-bg-3': 'rgba(65,32,15,0.6)',
      '--sb-text': '#e8d5b0', '--sb-text-dim': '#b89a6a', '--sb-accent': '#d4af37',
      '--sb-border': 'rgba(212,175,55,0.4)', '--sb-good': '#6ab04c', '--sb-warn': '#e0a020',
      '--sb-danger': '#e05038', '--sb-bar-track': 'rgba(255,255,255,0.08)', '--sb-radius': '12px',
      '--sb-font': "system-ui,-apple-system,sans-serif", '--sb-blur': 'blur(12px)',
    },
  },
  {
    id: 'paper',
    name: '素雅宣纸',
    icon: '🪶',
    description: '浅色楷体柔和（御兽范式）',
    vars: {
      '--sb-bg': '#fdfbf7', '--sb-bg-2': '#f3efe6', '--sb-bg-3': '#ece5d8',
      '--sb-text': '#4a3a2a', '--sb-text-dim': '#8a7a60', '--sb-accent': '#8c2a2a',
      '--sb-border': '#d4c4b7', '--sb-good': '#5a8a4a', '--sb-warn': '#c8860a',
      '--sb-danger': '#b03030', '--sb-bar-track': '#e0d6c6', '--sb-radius': '8px',
      '--sb-font': "'STKaiti','Kaiti','楷体','NSimSun',serif", '--sb-blur': 'none',
    },
  },
];

export function getStatusBarThemeById(id: string): StatusBarTheme {
  return STATUS_BAR_THEMES.find(t => t.id === id) ?? STATUS_BAR_THEMES[0];
}

// ════════════════════════════════════════════════════════════════════════════
// Schema 反射：变量分类 + 语义色 + 结构化为可渲染描述
// ════════════════════════════════════════════════════════════════════════════

export type VarKind = 'bar' | 'number' | 'enum' | 'text' | 'boolean' | 'list';

export interface ReflectedVar {
  path: string;          // 原始路径，如 '关系.情感天平'
  jsPath: string;        // JS 读取路径，如 'stat_data.关系.情感天平'
  label: string;         // 显示名（路径末段）
  kind: VarKind;
  defaultVal: unknown;
  min?: number;
  max?: number;
  enumValues?: string[];
  elId: string;          // 唯一 DOM id
  accent: string;        // 语义色 CSS 变量
}

export interface ReflectedSection {
  name: string;
  vars: ReflectedVar[];
}

/** 按路径关键词映射语义色（绿黄红是通用语言，资源条/徽章三态着色） */
function varAccent(path: string): string {
  const p = path.toLowerCase();
  if (/hp|生命|血量|健康|体力/.test(p) || p.includes('health')) return 'var(--sb-danger)';
  if (/mp|魔力|法力|灵力|查克拉/.test(p) || p.includes('mana')) return 'var(--sb-accent)';
  if (/好感|亲密|爱意|情感|羁绊|信任|倾向|天平/.test(p)) return 'var(--sb-good)';
  if (/金币|金钱|财富|灵石|资源|经验/.test(p) || p.includes('gold') || p.includes('exp')) return 'var(--sb-warn)';
  if (/威胁|危险|敌意|心魔|感染|出血/.test(p)) return 'var(--sb-danger)';
  // 分阶段模板轴变量语义色
  if (/修为|境界|修仙|灵根/.test(p)) return 'var(--sb-good)';      // 成长突破型：绿（正向递增）
  if (/污染|堕落|腐化|黑化/.test(p)) return 'var(--sb-danger)';    // 黑化堕落型：红（负面递增）
  if (/真相|调查|推理|线索/.test(p)) return 'var(--sb-warn)';      // 悬疑推理型：黄（揭露度）
  if (/进度|主线|剧情/.test(p)) return 'var(--sb-accent)';         // 冒险剧情型：主题色（中性推进）
  return 'var(--sb-accent)';
}

/** 变量分类：决定用哪种原子组件渲染 */
function classifyVariable(v: MvuVariable): VarKind {
  const z = v.zodType;
  if (z === 'z.coerce.number()') {
    // 有合理范围（跨度 ≤ 1000）→ 资源条；否则纯数值
    if (v.range && v.range.max > v.range.min && (v.range.max - v.range.min) <= 1000) return 'bar';
    return 'number';
  }
  if (z.startsWith('z.enum(')) return 'enum';
  if (z === 'z.boolean()' || z === 'z.boolean') return 'boolean';
  if (z.startsWith('z.array(') || z.startsWith('z.record(') || z.startsWith('z.object(')) return 'list';
  return 'text';
}

/** 将 schema sections 反射为结构化渲染描述（隐藏变量 $ 前缀不显示） */
export function reflectSections(sections: MvuSchemaSection[]): ReflectedSection[] {
  let counter = 0;
  return sections
    .map(s => ({
      name: s.name,
      vars: s.variables
        .filter(v => v.prefix !== '$')
        .map(v => {
          const kind = classifyVariable(v);
          const rv: ReflectedVar = {
            path: v.path,
            jsPath: `stat_data.${v.path}`,
            label: v.path.split('.').pop() || v.path,
            kind,
            defaultVal: v.initialValue ?? (kind === 'bar' || kind === 'number' ? 0 : kind === 'boolean' ? false : kind === 'list' ? {} : ''),
            min: v.range?.min,
            max: v.range?.max,
            enumValues: v.enumValues,
            elId: `sb-v-${counter++}`,
            accent: varAccent(v.path),
          };
          return rv;
        }),
    }))
    .filter(s => s.vars.length > 0);
}

// ════════════════════════════════════════════════════════════════════════════
// 原子组件 HTML 生成器（含唯一 id，供 JS 填充）
// ════════════════════════════════════════════════════════════════════════════

// 状态栏文本均嵌入标签之间的文本内容，用默认（不转义引号）转义即可。
function esc(s: string): string {
  return escapeHtml(s);
}

function componentHtml(v: ReflectedVar): string {
  const def = v.defaultVal;
  switch (v.kind) {
    case 'bar': {
      const max = v.max ?? 100;
      const min = v.min ?? 0;
      const pct = Math.max(0, Math.min(100, ((Number(def) - min) / (max - min)) * 100));
      return `<div class="sb-bar-wrap" id="${v.elId}">
        <div class="sb-bar-head"><span class="sb-bar-name">${esc(v.label)}</span><span class="sb-bar-text">${esc(String(def))} / ${max}</span></div>
        <div class="sb-bar"><div class="sb-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    }
    case 'number':
      return `<div class="sb-row" id="${v.elId}"><span class="sb-label">${esc(v.label)}</span><span class="sb-val">${esc(String(def))}</span></div>`;
    case 'enum':
      return `<div class="sb-row" id="${v.elId}"><span class="sb-label">${esc(v.label)}</span><span class="sb-badge">${esc(String(def))}</span></div>`;
    case 'boolean':
      return `<div class="sb-row" id="${v.elId}"><span class="sb-label">${esc(v.label)}</span><span class="sb-badge ${def ? 'sb-bad' : 'sb-ok'}">${def ? '是' : '否'}</span></div>`;
    case 'list':
      return `<div class="sb-row-block" id="${v.elId}"><div class="sb-label" style="margin-bottom:3px">${esc(v.label)}</div><ul class="sb-list"><li class="sb-empty">空</li></ul></div>`;
    case 'text':
    default:
      return `<div class="sb-row" id="${v.elId}"><span class="sb-label">${esc(v.label)}</span><span class="sb-val">${esc(String(def))}</span></div>`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// JS 运行时填充逻辑生成器（schema 反射驱动）
// ════════════════════════════════════════════════════════════════════════════

/** 为单个变量生成填充 JS 片段 */
function populateJsForVar(v: ReflectedVar): string {
  const def = JSON.stringify(v.defaultVal);
  const get = `sbGet(all, ${JSON.stringify(v.jsPath)}, ${def})`;
  switch (v.kind) {
    case 'bar': {
      const min = v.min ?? 0;
      const max = v.max ?? 100;
      const unidirectional = min >= 0;
      return `  (function(){
    var v = ${get};
    var el = document.getElementById(${JSON.stringify(v.elId)});
    if(!el) return;
    var pct = Math.max(0, Math.min(100, ((v - ${min}) / (${max - min})) * 100));
    var fill = el.querySelector('.sb-bar-fill');
    if(!fill) return;
    fill.style.width = pct + '%';
    var txt = el.querySelector('.sb-bar-text');
    if(txt) txt.textContent = v + ' / ' + ${max};
    ${unidirectional ? `fill.classList.toggle('sb-danger', pct <= 30);
    fill.classList.toggle('sb-warn', pct > 30 && pct <= 60);` : ''}
  })();`;
    }
    case 'number':
      return `  (function(){
    var el = document.getElementById(${JSON.stringify(v.elId)});
    if(!el) return;
    var val = el.querySelector('.sb-val');
    if(val) val.textContent = ${get};
  })();`;
    case 'enum':
      return `  (function(){
    var v = ${get};
    var el = document.getElementById(${JSON.stringify(v.elId)});
    if(!el) return;
    var b = el.querySelector('.sb-badge');
    b.textContent = v;
  })();`;
    case 'boolean':
      return `  (function(){
    var v = ${get};
    var el = document.getElementById(${JSON.stringify(v.elId)});
    if(!el) return;
    var b = el.querySelector('.sb-badge');
    if(!b) return;
    b.textContent = v ? '是' : '否';
    b.classList.toggle('sb-bad', !!v);
    b.classList.toggle('sb-ok', !v);
  })();`;
    case 'list':
      return `  (function(){
    var v = ${get};
    var el = document.getElementById(${JSON.stringify(v.elId)});
    if(!el) return;
    var ul = el.querySelector('.sb-list');
    if(!ul) return;
    var html = '';
    if (Array.isArray(v)) {
      v.forEach(function(item){ html += '<li>' + escH(typeof item === 'object' ? JSON.stringify(item) : item) + '</li>'; });
    } else if (v && typeof v === 'object') {
      Object.entries(v).forEach(function(e){
        var name = e[0], d = e[1];
        var qty = (d && typeof d === 'object' && d['数量'] != null) ? ' ×' + d['数量'] : (typeof d === 'object' ? '' : ' ' + d);
        html += '<li><span>' + escH(name) + '</span><span>' + escH(qty) + '</span></li>';
      });
    }
    ul.innerHTML = html || '<li class="sb-empty">空</li>';
  })();`;
    case 'text':
    default:
      return `  (function(){
    var el = document.getElementById(${JSON.stringify(v.elId)});
    if(!el) return;
    var val = el.querySelector('.sb-val');
    if(val) val.textContent = ${get};
  })();`;
  }
}

/** 生成完整的运行时脚本（自包含辅助函数 + 守卫式运行时全局调用） */
function buildRuntimeScript(reflected: ReflectedSection[], opts: StatusBarGenerateOptions): string {
  const allVars = reflected.flatMap(s => s.vars);
  const populateBody = allVars.map(populateJsForVar).join('\n');
  const previewValues = JSON.stringify(opts.previewValues ?? {}).replace(/<\/script/gi, '<\\/script');

  // 动态分区发现逻辑：扫描 stat_data 顶层 key，为 schema 中未定义的分区创建 DOM
  const dynamicSectionCode = `
// ── 动态分区支持：自动发现并渲染 schema 之外的 stat_data 分区 ──
var sbCreatedSections = {};
function sbClassifyValue(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? 'number' : 'text';
  if (typeof val === 'boolean') return 'boolean';
  if (Array.isArray(val)) return 'list';
  if (val !== null && typeof val === 'object') return 'list';
  return 'text';
}
function sbEscapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function sbCreateDynamicSection(sectionName, sectionData, all) {
  var safeId = 'sb-dyn-' + sectionName.replace(/[^a-zA-Z0-9\\u4e00-\\u9fff]/g, '-');
  if (document.getElementById(safeId)) return; // 已存在，跳过
  var bodyHtml = '';
  Object.keys(sectionData).forEach(function(varName) {
    var val = sectionData[varName];
    var kind = sbClassifyValue(val);
    var jsPath = 'stat_data.' + sectionName + '.' + varName;
    var displayVal = sbGet(all, jsPath, val);
    switch (kind) {
      case 'number':
        bodyHtml += '<div class="sb-row"><span class="sb-label">' + sbEscapeHtml(varName) + '</span><span class="sb-val">' + sbEscapeHtml(String(displayVal)) + '</span></div>';
        break;
      case 'boolean':
        bodyHtml += '<div class="sb-row"><span class="sb-label">' + sbEscapeHtml(varName) + '</span><span class="sb-badge ' + (displayVal ? 'sb-ok' : 'sb-bad') + '">' + (displayVal ? '是' : '否') + '</span></div>';
        break;
      case 'list':
        bodyHtml += '<div class="sb-row-block"><div class="sb-label" style="margin-bottom:3px">' + sbEscapeHtml(varName) + '</div><ul class="sb-list"><li>' + sbEscapeHtml(JSON.stringify(displayVal)) + '</li></ul></div>';
        break;
      default:
        bodyHtml += '<div class="sb-row"><span class="sb-label">' + sbEscapeHtml(varName) + '</span><span class="sb-val">' + sbEscapeHtml(String(displayVal)) + '</span></div>';
    }
  });
  var sectionHtml = '<div class="sb-section" id="' + safeId + '" data-sb-dynamic="true">';
  sectionHtml += '<div class="sb-section-title"><span>▸ ' + sbEscapeHtml(sectionName) + '</span><span class="sb-arrow">▼</span></div>';
  sectionHtml += '<div class="sb-section-body">' + bodyHtml + '</div></div>';
  document.querySelector('.sb-root').insertAdjacentHTML('beforeend', sectionHtml);
  // 绑定折叠/展开事件
  var titleEl = document.getElementById(safeId).querySelector('.sb-section-title');
  if (titleEl) titleEl.addEventListener('click', function() { titleEl.parentElement.classList.toggle('sb-collapsed'); });
  sbCreatedSections[sectionName] = true;
}
function sbDiscoverDynamicSections(all) {
  var statData = (all && all.stat_data) ? all.stat_data : {};
  if (!statData || typeof statData !== 'object') return;
  Object.keys(statData).forEach(function(sectionName) {
    if (sbCreatedSections[sectionName]) return; // 已创建过，跳过
    var sectionData = statData[sectionName];
    if (sectionData === null || typeof sectionData !== 'object' || Array.isArray(sectionData)) return; // 只处理对象类型分区
    var hasVisibleVars = Object.keys(sectionData).some(function(k) { return !k.startsWith('$'); });
    if (!hasVisibleVars) return; // 无可见变量，跳过
    sbCreateDynamicSection(sectionName, sectionData, all);
  });
}`;

  return `<script type="module">
var sbPreviewValues = ${previewValues};
function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
// 自包含路径读取（不依赖 lodash）
function sbGet(obj, path, def) {
  if (Object.prototype.hasOwnProperty.call(sbPreviewValues, path)) return sbPreviewValues[path];
  var parts = path.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return def;
    cur = cur[parts[i]];
  }
  return cur === undefined ? def : cur;
}
${dynamicSectionCode}
function sbPopulate() {
  var all = (typeof getAllVariables === 'function') ? getAllVariables() : {};
${populateBody}
  sbDiscoverDynamicSections(all);
}
function sbSetPreviewValues(values) {
  sbPreviewValues = values || {};
  sbPopulate();
}
window.__statusBarPreview = { setValues: sbSetPreviewValues };
async function sbInit() {
  try {
    if (typeof waitGlobalInitialized === 'function') { await waitGlobalInitialized('Mvu'); }
  } catch (e) { /* 运行时未就绪也尝试用默认值渲染 */ }
  sbPopulate();
  try {
    if (typeof eventOn === 'function' && typeof Mvu !== 'undefined' && Mvu.events) {
      eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, sbPopulate);
    }
  } catch (e) { /* 事件订阅失败不影响静态展示 */ }
  document.querySelectorAll('.sb-section-title').forEach(function(t){
    t.addEventListener('click', function(){ t.parentElement.classList.toggle('sb-collapsed'); });
  });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function(){ sbInit().catch(function(e){console.error('[StatusBar]',e);}); }); }
  else { sbInit().catch(function(e){console.error('[StatusBar]',e);}); }
}
</script>`;
}

// ════════════════════════════════════════════════════════════════════════════
// 组件样式表（引用 CSS 变量，主题无关）
// ════════════════════════════════════════════════════════════════════════════

const COMPONENT_CSS = `
.sb-root{box-sizing:border-box;width:100%;max-width:560px;margin:6px 0;background:var(--sb-bg);color:var(--sb-text);font-family:var(--sb-font);border:1px solid var(--sb-border);border-radius:var(--sb-radius);padding:12px;box-shadow:0 6px 20px rgba(0,0,0,.18);line-height:1.5;backdrop-filter:var(--sb-blur);-webkit-backdrop-filter:var(--sb-blur);opacity:var(--sb-opacity,1);transition:background-color .25s ease,border-color .25s ease,box-shadow .25s ease,opacity .25s ease}
.sb-root *,.sb-root *::before,.sb-root *::after{box-sizing:border-box}
.sb-root.sb-comfortable{padding:16px;line-height:1.7}
.sb-root.sb-animated .sb-row,.sb-root.sb-animated .sb-bar-fill,.sb-root.sb-animated .sb-badge{transition:all .35s ease}
.sb-root.sb-notice{box-shadow:0 0 0 1px var(--sb-warn),0 8px 28px color-mix(in srgb,var(--sb-warn) 28%,transparent)}
.sb-notice-label{display:none;color:var(--sb-warn);font-size:10px;font-weight:700;margin-left:auto;animation:sb-notice-pulse 1.4s ease-in-out infinite}
.sb-root.sb-notice .sb-notice-label{display:block}
@keyframes sb-notice-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.sb-header{display:flex;align-items:center;gap:10px;padding-bottom:8px;margin-bottom:10px;border-bottom:1px solid var(--sb-border)}
.sb-avatar{width:38px;height:38px;flex-shrink:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--sb-accent),color-mix(in srgb,var(--sb-accent) 45%,var(--sb-bg)));color:#fff;font-weight:700;font-size:16px;border:2px solid color-mix(in srgb,var(--sb-accent) 55%,#fff);box-shadow:0 2px 8px rgba(0,0,0,.2)}
.sb-title{font-size:14px;font-weight:700;color:var(--sb-accent);letter-spacing:1px;flex:1;min-width:0}
.sb-subtitle{font-size:10px;color:var(--sb-text-dim);margin-top:1px}
.sb-section{margin-bottom:8px;border:1px solid var(--sb-border);border-radius:calc(var(--sb-radius) - 2px);overflow:hidden;background:var(--sb-bg-2)}
.sb-section:last-child{margin-bottom:0}
.sb-section-title{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:var(--sb-bg-3);cursor:pointer;user-select:none;font-size:12px;font-weight:700;color:var(--sb-accent);letter-spacing:.5px}
.sb-section-title:hover{filter:brightness(1.08)}
.sb-arrow{font-size:9px;color:var(--sb-text-dim);transition:transform .18s ease}
.sb-section.sb-collapsed .sb-section-body{display:none}
.sb-section.sb-collapsed .sb-arrow{transform:rotate(-90deg)}
.sb-section-body{padding:8px 10px}
.sb-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 0;border-bottom:1px dotted color-mix(in srgb,var(--sb-border) 60%,transparent);font-size:11px}
.sb-row:last-child{border-bottom:none}
.sb-row-block{padding:4px 0;border-bottom:1px dotted color-mix(in srgb,var(--sb-border) 60%,transparent);font-size:11px}
.sb-row-block:last-child{border-bottom:none}
.sb-label{color:var(--sb-text-dim)}
.sb-val{color:var(--sb-text);text-align:right;font-weight:600}
.sb-bar-wrap{margin:6px 0}
.sb-bar-head{display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px}
.sb-bar-name{color:var(--sb-text-dim)}
.sb-bar-text{color:var(--sb-text);font-weight:700}
.sb-bar{height:9px;background:var(--sb-bar-track);border-radius:999px;overflow:hidden;border:1px solid color-mix(in srgb,var(--sb-border) 50%,transparent)}
.sb-bar-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--sb-accent) 65%,var(--sb-bg)),var(--sb-accent));box-shadow:0 0 6px color-mix(in srgb,var(--sb-accent) 40%,transparent);transition:width .45s ease}
.sb-bar-fill.sb-warn{background:linear-gradient(90deg,color-mix(in srgb,var(--sb-warn) 65%,var(--sb-bg)),var(--sb-warn));box-shadow:0 0 6px color-mix(in srgb,var(--sb-warn) 40%,transparent)}
.sb-bar-fill.sb-danger{background:linear-gradient(90deg,color-mix(in srgb,var(--sb-danger) 65%,var(--sb-bg)),var(--sb-danger));box-shadow:0 0 6px color-mix(in srgb,var(--sb-danger) 40%,transparent)}
.sb-badge{display:inline-block;font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid var(--sb-border);background:var(--sb-bg-3);color:var(--sb-text)}
.sb-badge.sb-ok{border-color:color-mix(in srgb,var(--sb-good) 50%,transparent);color:var(--sb-good)}
.sb-badge.sb-warn{border-color:color-mix(in srgb,var(--sb-warn) 50%,transparent);color:var(--sb-warn)}
.sb-badge.sb-bad{border-color:color-mix(in srgb,var(--sb-danger) 50%,transparent);color:var(--sb-danger)}
.sb-list{margin:0;padding:0;list-style:none}
.sb-list li{display:flex;justify-content:space-between;gap:8px;font-size:10px;padding:2px 0;border-bottom:1px dotted color-mix(in srgb,var(--sb-border) 50%,transparent);color:var(--sb-text)}
.sb-list li:last-child{border-bottom:none}
.sb-empty{color:var(--sb-text-dim)}
@media(max-width:520px){.sb-root{padding:9px}.sb-title{font-size:13px}.sb-avatar{width:32px;height:32px;font-size:14px}}
`.trim();

// ════════════════════════════════════════════════════════════════════════════
// 文档组装
// ════════════════════════════════════════════════════════════════════════════

function buildThemeVarsCss(theme: StatusBarTheme, opts: StatusBarGenerateOptions): string {
  const entries = Object.entries(theme.vars).map(([k, v]) => `${k}:${v};`).join('');
  const opacity = Math.max(0.7, Math.min(1, opts.opacity ?? 1));
  return `.sb-root{${entries}--sb-opacity:${opacity};}`;
}

function buildDocument(theme: StatusBarTheme, bodyHtml: string, reflected: ReflectedSection[], opts: StatusBarGenerateOptions): string {
  const css = `${buildThemeVarsCss(theme, opts)}\n${COMPONENT_CSS}`;
  const script = buildRuntimeScript(reflected, opts);
  return '```html\n<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<style>\n'
    + css
    + '\n</style>\n'
    + script
    + '\n</head>\n<body>\n'
    + bodyHtml
    + '\n</body>\n</html>\n```';
}

// ════════════════════════════════════════════════════════════════════════════
// 生成选项与模板
// ════════════════════════════════════════════════════════════════════════════

export interface StatusBarGenerateOptions {
  themeId?: string;
  title?: string;
  showAvatar?: boolean;
  /** 折叠所有分区（信息多时推荐） */
  collapseAll?: boolean;
  /** 状态栏整体透明度（0.7~1） */
  opacity?: number;
  /** 信息密度 */
  density?: 'compact' | 'comfortable';
  /** 是否启用变量更新时的过渡动画 */
  animated?: boolean;
  /** 是否显示装饰性图标/箭头 */
  showIcons?: boolean;
  /** 仅用于独立预览窗口的初始变量覆盖 */
  previewValues?: Record<string, unknown>;
  /** 仅用于独立预览窗口的状态提示 */
  previewNotice?: string;
}

function buildHeader(opts: StatusBarGenerateOptions, totalVars: number): string {
  const title = opts.title || '状态栏';
  const initial = esc(title.trim().charAt(0) || '状');
  const avatar = opts.showAvatar !== false
    ? `<div class="sb-avatar">${initial}</div>`
    : '';
  return `<div class="sb-header">${avatar}<div class="sb-title">${esc(title)}<div class="sb-subtitle">实时状态 · ${totalVars} 项</div></div><span class="sb-notice-label">${esc(opts.previewNotice || '')}</span></div>`;
}

function buildSections(reflected: ReflectedSection[], collapseAll: boolean, multiSection: boolean, showIcons: boolean): string {
  return reflected.map((s, i) => {
    const collapsed = collapseAll || (multiSection && i > 0) ? ' sb-collapsed' : '';
    const body = s.vars.map(componentHtml).join('\n');
    // 单分区且仅一个分区时不显示分区标题（更紧凑）
    if (!multiSection) return `<div class="sb-section-body" style="padding:0">${body}</div>`;
    return `<div class="sb-section${collapsed}">
      <div class="sb-section-title"><span>${showIcons ? '▸ ' : ''}${esc(s.name)}</span><span class="sb-arrow">${showIcons ? '▼' : ''}</span></div>
      <div class="sb-section-body">${body}</div>
    </div>`;
  }).join('\n');
}

/** 紧凑 HUD 型：信息密度高、常驻、窄条（北风/遗界顶部 HUD 范式） */
function generateCompactHud(sections: MvuSchemaSection[], opts: StatusBarGenerateOptions): string {
  const theme = getStatusBarThemeById(opts.themeId || 'terminal');
  const reflected = reflectSections(sections);
  const totalVars = reflected.reduce((n, s) => n + s.vars.length, 0);
  const header = buildHeader({ ...opts, showAvatar: opts.showAvatar ?? false }, totalVars);
  const body = buildSections(reflected, opts.collapseAll ?? false, reflected.length > 1, opts.showIcons !== false);
  const classes = `sb-root${opts.density === 'comfortable' ? ' sb-comfortable' : ''}${opts.animated !== false ? ' sb-animated' : ''}${opts.previewNotice ? ' sb-notice' : ''}`;
  const bodyHtml = `<div class="${classes}" style="max-width:440px">${header}\n${body}</div>`;
  return buildDocument(theme, bodyHtml, reflected, opts);
}

/** 角色面板型：头像 + 可折叠分区 + 资源条（御兽/埃瑟尔德范式） */
function generateCharacterPanel(sections: MvuSchemaSection[], opts: StatusBarGenerateOptions): string {
  const theme = getStatusBarThemeById(opts.themeId || 'parchment');
  const reflected = reflectSections(sections);
  const totalVars = reflected.reduce((n, s) => n + s.vars.length, 0);
  const header = buildHeader({ ...opts, showAvatar: opts.showAvatar ?? true }, totalVars);
  const body = buildSections(reflected, opts.collapseAll ?? false, true, opts.showIcons !== false);
  const classes = `sb-root${opts.density === 'comfortable' ? ' sb-comfortable' : ''}${opts.animated !== false ? ' sb-animated' : ''}${opts.previewNotice ? ' sb-notice' : ''}`;
  const bodyHtml = `<div class="${classes}">${header}\n${body}</div>`;
  return buildDocument(theme, bodyHtml, reflected, opts);
}

export interface StatusBarTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  defaultTheme: string;
  generate: (sections: MvuSchemaSection[], opts: StatusBarGenerateOptions) => string;
}

export const STATUS_BAR_TEMPLATES: StatusBarTemplate[] = [
  {
    id: 'compact-hud',
    name: '紧凑HUD',
    icon: '🖥️',
    description: '高密度窄条，常驻显示，适合变量较少或追求沉浸感的卡片',
    defaultTheme: 'terminal',
    generate: generateCompactHud,
  },
  {
    id: 'character-panel',
    name: '角色面板',
    icon: '🗂️',
    description: '头像+可折叠分区+资源条，适合变量丰富的角色卡',
    defaultTheme: 'parchment',
    generate: generateCharacterPanel,
  },
];

export function getStatusBarTemplateById(id: string): StatusBarTemplate | undefined {
  return STATUS_BAR_TEMPLATES.find(t => t.id === id);
}

export interface StatusBarTemplatePreset {
  templateId: string;
  statusTemplateId: string;
  themeId: string;
  title: string;
}

/** 分阶段/MVU 模板的主题化状态栏预设 */
export const STATUS_BAR_TEMPLATE_PRESETS: StatusBarTemplatePreset[] = [
  { templateId: 'pure-love', statusTemplateId: 'character-panel', themeId: 'paper', title: '纯爱情感' },
  { templateId: 'ntr', statusTemplateId: 'character-panel', themeId: 'glass', title: '堕落情感' },
  { templateId: 'dual-route', statusTemplateId: 'character-panel', themeId: 'parchment', title: '情感天平' },
  { templateId: 'cultivation', statusTemplateId: 'character-panel', themeId: 'parchment', title: '修为境界' },
  { templateId: 'main-plot', statusTemplateId: 'compact-hud', themeId: 'terminal', title: '主线进度' },
  { templateId: 'corruption', statusTemplateId: 'compact-hud', themeId: 'glass', title: '心智污染' },
  { templateId: 'investigation', statusTemplateId: 'character-panel', themeId: 'terminal', title: '调查真相度' },
  { templateId: 'wuxia', statusTemplateId: 'character-panel', themeId: 'paper', title: '江湖状态' },
  { templateId: 'xianxia', statusTemplateId: 'character-panel', themeId: 'parchment', title: '修仙状态' },
  { templateId: 'apocalypse', statusTemplateId: 'compact-hud', themeId: 'terminal', title: '生存终端' },
  { templateId: 'modern', statusTemplateId: 'character-panel', themeId: 'glass', title: '都市状态' },
];

export function getStatusBarPresetByTemplateId(templateId: string): StatusBarTemplatePreset | undefined {
  return STATUS_BAR_TEMPLATE_PRESETS.find(preset => preset.templateId === templateId);
}


export function generateStatusBarHtml(
  templateId: string,
  sections: MvuSchemaSection[],
  opts: StatusBarGenerateOptions = {},
): string {
  const template = getStatusBarTemplateById(templateId);
  if (!template) return '';
  const merged: StatusBarGenerateOptions = { ...opts, themeId: opts.themeId || template.defaultTheme };
  return template.generate(sections, merged);
}
