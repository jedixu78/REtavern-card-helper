/**
 * Staged Lorebook Builder Tests - 验证调度条目兼容数组/标量两种 MVU 格式
 */
import { describe, it, expect } from 'vitest';
import {
  autoCondition,
  buildDispatcherContent,
  buildStagedLorebookEntries,
  migrateStagedDispatcherContent,
  alignStagedDispatcherBookName,
  parseDispatcherContent,
  sortStagesByDirection,
  type StagedLorebookConfig,
} from './staged-lorebook-builder';

describe('Staged Lorebook Builder - 调度条目兼容性', () => {
  function makeConfig(override?: Partial<StagedLorebookConfig>): StagedLorebookConfig {
    return {
      axisPath: '傅雪.情感天平',
      axisType: 'number',
      numericDirection: '<=',
      stages: [
        { name: '完全沉沦于张强', condition: '<= -100' },
        { name: '深陷爱河', condition: '<= -80' },
        { name: '意乱情迷', condition: '<= -50' },
        { name: '暗生情愫', condition: '<= -20' },
        { name: '初识涟漪', condition: '<= 19' },
        { name: '母爱变质', condition: '<= 49' },
        { name: '醋意渐生', condition: '<= 79' },
        { name: '爱欲深缠', condition: '<= 99' },
        { name: '孽缘情定', condition: '>= 100' },
      ],
      bookName: '高考冲刺100天',
      dispatcherName: '傅雪分阶段人设',
      ...override,
    };
  }

  it('调度条目应包含 Array.isArray 兼容处理', () => {
    const content = buildDispatcherContent(makeConfig());
    expect(content).toContain("const __stagedRaw_傅雪分阶段人设 = getvar('stat_data.傅雪.情感天平');");
    expect(content).toContain('const __stagedVal_傅雪分阶段人设 = Array.isArray(__stagedRaw_傅雪分阶段人设) ? __stagedRaw_傅雪分阶段人设[0] : __stagedRaw_傅雪分阶段人设;');
  });

  it('所有阶段判断都应使用 __stagedVal', () => {
    const content = buildDispatcherContent(makeConfig());
    expect(content).toContain('if (__stagedVal_傅雪分阶段人设 === undefined)');
    // 所有阶段都用 } else if（第一阶段接在 undefined 检查后）
    expect(content).toContain('} else if (__stagedVal_傅雪分阶段人设 <= -100) {');
    expect(content).toContain('} else if (__stagedVal_傅雪分阶段人设 <= -80) {');
    expect(content).toContain('} else if (__stagedVal_傅雪分阶段人设 >= 100) {');
    // 不应再出现直接 getvar(...) 作为判断条件
    expect(content).not.toMatch(/if \(getvar\(/);
  });

  it('反向解析器仍能正确提取 axisPath 和 bookName', () => {
    const content = buildDispatcherContent(makeConfig());
    const parsed = parseDispatcherContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.axisPath).toBe('傅雪.情感天平');
    expect(parsed!.bookName).toBe('高考冲刺100天');
    expect(parsed!.childComments).toContain('傅雪分阶段人设：完全沉沦于张强');
    expect(parsed!.childComments).toContain('傅雪分阶段人设：孽缘情定');
  });

  it('阶段条目应包含 dispatcher 和正确数量的子阶段', () => {
    const entries = buildStagedLorebookEntries(makeConfig());
    expect(entries.length).toBe(10);
    const dispatcher = entries[0];
    expect(dispatcher.constant).toBe(true);
    expect(dispatcher.selective).toBe(true);
    expect(dispatcher.enabled).toBe(true);
    expect(dispatcher.depth).toBe(3);

    const children = entries.slice(1);
    expect(children.every((e) => e.enabled === false)).toBe(true);
    expect(children.every((e) => e.constant === false)).toBe(true);
    expect(children.every((e) => e.depth === 4)).toBe(true);
  });

  it('<= 方向阶段应按阈值从低到高排序', () => {
    const sorted = sortStagesByDirection(
      [
        { name: 'a', condition: '<= 99' },
        { name: 'b', condition: '<= -100' },
        { name: 'c', condition: '<= -50' },
        { name: 'd', condition: '<= 49' },
      ],
      'number',
      '<=',
    );
    expect(sorted.map((s) => s.condition)).toEqual(['<= -100', '<= -50', '<= 49', '<= 99']);
  });

  it('>= 方向阶段应按阈值从高到低排序', () => {
    const sorted = sortStagesByDirection(
      [
        { name: 'a', condition: '>= 40' },
        { name: 'b', condition: '>= 90' },
        { name: 'c', condition: '>= 0' },
        { name: 'd', condition: '>= 70' },
      ],
      'number',
      '>=',
    );
    expect(sorted.map((s) => s.condition)).toEqual(['>= 90', '>= 70', '>= 40', '>= 0']);
  });

  it('应能同时兼容标量与数组两种 MVU 存储格式', () => {
    const content = buildDispatcherContent(makeConfig());

    // 把 EJS 标签与文本片段转成可执行的 JS
    function ejsToJs(ejs: string): string {
      const tagRe = /(<%_[\s\S]*?_%>|<%=!?[\s\S]*?%>|<%[\s\S]*?%>)/g;
      const out: string[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(ejs)) !== null) {
        const text = ejs.slice(last, m.index);
        if (text) out.push(`output += ${JSON.stringify(text)};`);
        const tag = m[1];
        if (tag.startsWith('<%_')) {
          out.push(tag.slice(4, -3).trim());
        } else if (tag.startsWith('<%=')) {
          const expr = tag.slice(3, tag.endsWith('_%>') ? -3 : -2).trim().replace(/^await\s+/, '');
          out.push(`output += String(${expr});`);
        } else {
          out.push(tag.slice(2, tag.endsWith('_%>') ? -3 : -2).trim());
        }
        last = tagRe.lastIndex;
      }
      const tail = ejs.slice(last);
      if (tail) out.push(`output += ${JSON.stringify(tail)};`);
      return out.join('\n');
    }

    function render(getvarReturn: unknown): string {
      const getvar = () => getvarReturn;
      const getWorldInfo = (_book: string, comment: string) => `[[${comment}]]`;
       
      const fn = new Function('getvar', 'getWorldInfo', `let output = ''; ${ejsToJs(content)}; return output;`);
      return fn(getvar, getWorldInfo);
    }

    // 标量：直接返回值
    expect(render(-100)).toContain('傅雪分阶段人设：完全沉沦于张强');
    expect(render(100)).toContain('傅雪分阶段人设：孽缘情定');
    expect(render(0)).toContain('傅雪分阶段人设：初识涟漪');

    // 数组：参考卡 [值, 描述] 格式
    expect(render([-100, 'desc'])).toContain('傅雪分阶段人设：完全沉沦于张强');
    expect(render([100, 'desc'])).toContain('傅雪分阶段人设：孽缘情定');
    expect(render([0, 'desc'])).toContain('傅雪分阶段人设：初识涟漪');

    // 未定义
    expect(render(undefined)).toContain('未定义');
  });

  it('dual-route 统一 >= 方向应按阈值从高到低排序（含负值缓冲带）', () => {
    const sorted = sortStagesByDirection(
      [
        { name: '缓冲带', condition: '>= -20' },
        { name: '纯爱·深爱', condition: '>= 80' },
        { name: 'NTR·沉沦', condition: '>= -100' },
        { name: '纯爱·暧昧', condition: '>= 20' },
        { name: 'NTR·动摇', condition: '>= -50' },
        { name: 'NTR·沦陷', condition: '>= -80' },
      ],
      'number',
      '>=',
    );
    expect(sorted.map((s) => s.condition)).toEqual([
      '>= 80',
      '>= 20',
      '>= -20',
      '>= -50',
      '>= -80',
      '>= -100',
    ]);
  });

  it('dual-route dispatcher 应正确引用 per-character axis path', () => {
    const cfg = makeConfig({
      axisPath: '林雅宁.情感天平',
      dispatcherName: '林雅宁分阶段人设',
      numericDirection: '>=',
      stages: [
        { name: '纯爱·深爱', condition: '>= 80' },
        { name: '中立·缓冲带', condition: '>= -20' },
        { name: 'NTR·动摇', condition: '>= -50' },
      ],
    });
    const content = buildDispatcherContent(cfg);
    expect(content).toContain("const __stagedRaw_林雅宁分阶段人设 = getvar('stat_data.林雅宁.情感天平');");
    expect(content).toContain('} else if (__stagedVal_林雅宁分阶段人设 >= 80) {');
    expect(content).toContain('} else if (__stagedVal_林雅宁分阶段人设 >= -20) {');
    expect(content).toContain('} else if (__stagedVal_林雅宁分阶段人设 >= -50) {');

    const parsed = parseDispatcherContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.axisPath).toBe('林雅宁.情感天平');
    expect(parsed!.childComments).toContain('林雅宁分阶段人设：纯爱·深爱');
  });

  it('dual-route dispatcher 渲染：缓冲带 0 应命中缓冲带阶段', () => {
    const cfg = makeConfig({
      axisPath: '林雅宁.情感天平',
      dispatcherName: '林雅宁分阶段人设',
      numericDirection: '>=',
      stages: [
        { name: '纯爱·深爱', condition: '>= 80' },
        { name: '中立·缓冲带', condition: '>= -20' },
        { name: 'NTR·动摇', condition: '>= -50' },
      ],
    });
    const content = buildDispatcherContent(cfg);

    function ejsToJs(ejs: string): string {
      const tagRe = /(<%_[\s\S]*?_%>|<%=!?[\s\S]*?%>|<%[\s\S]*?%>)/g;
      const out: string[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(ejs)) !== null) {
        const text = ejs.slice(last, m.index);
        if (text) out.push(`output += ${JSON.stringify(text)};`);
        const tag = m[1];
        if (tag.startsWith('<%_')) {
          out.push(tag.slice(4, -3).trim());
        } else if (tag.startsWith('<%=')) {
          const expr = tag.slice(3, tag.endsWith('_%>') ? -3 : -2).trim().replace(/^await\s+/, '');
          out.push(`output += String(${expr});`);
        } else {
          out.push(tag.slice(2, tag.endsWith('_%>') ? -3 : -2).trim());
        }
        last = tagRe.lastIndex;
      }
      const tail = ejs.slice(last);
      if (tail) out.push(`output += ${JSON.stringify(tail)};`);
      return out.join('\n');
    }

    function render(getvarReturn: unknown): string {
      const getvar = () => getvarReturn;
      const getWorldInfo = (_book: string, comment: string) => `[[${comment}]]`;
       
      const fn = new Function('getvar', 'getWorldInfo', `let output = ''; ${ejsToJs(content)}; return output;`);
      return fn(getvar, getWorldInfo);
    }

    expect(render(0)).toContain('林雅宁分阶段人设：中立·缓冲带');
    expect(render(90)).toContain('林雅宁分阶段人设：纯爱·深爱');
    expect(render(-40)).toContain('林雅宁分阶段人设：NTR·动摇');
  });

  it('migrateStagedDispatcherContent 应把旧版无后缀变量改为角色唯一变量名', () => {
    const oldContent = `<%_ const __stagedRaw = getvar('stat_data.温玉婵.情感天平'); _%>
<%_ const __stagedVal = Array.isArray(__stagedRaw) ? __stagedRaw[0] : __stagedRaw; _%>
<%_ if (__stagedVal === undefined) { _%>
<!-- 错误：阶段轴变量"温玉婵.情感天平"未定义，无法加载分阶段内容。 -->
<%_ } if (__stagedVal >= 90) { _%>
<%= await getWorldInfo("寒雨将临", "温玉婵分阶段人设：甘愿臣服") _%>`;
    const migrated = migrateStagedDispatcherContent(oldContent);
    expect(migrated).toContain('const __stagedRaw_温玉婵分阶段人设 = getvar');
    expect(migrated).toContain('const __stagedVal_温玉婵分阶段人设 = Array.isArray(__stagedRaw_温玉婵分阶段人设)');
    expect(migrated).toContain('if (__stagedVal_温玉婵分阶段人设 >= 90)');
    expect(migrated).not.toMatch(/\b__stagedRaw\b(?!_)/);
    expect(migrated).not.toMatch(/\b__stagedVal\b(?!_)/);
  });

  it('migrateStagedDispatcherContent 对已是新版的调度条目不做改动', () => {
    const newContent = buildDispatcherContent(makeConfig());
    expect(migrateStagedDispatcherContent(newContent)).toBe(newContent);
  });

  it('migrateStagedDispatcherContent 对普通世界书条目不做改动', () => {
    const plain = '# 普通条目\n这是普通内容';
    expect(migrateStagedDispatcherContent(plain)).toBe(plain);
  });
});

// ── S3: 调度条目书名对齐（「阶段不切换」根因防复活） ─────────────────────────

describe('alignStagedDispatcherBookName (S3)', () => {
  const dispatcher = `<%_ const __stagedRaw_测试 = getvar('stat_data.关系.阶段'); _%>
<%_ const __stagedVal_测试 = Array.isArray(__stagedRaw_测试) ? __stagedRaw_测试[0] : __stagedRaw_测试; _%>
<%_ if (__stagedVal_测试 === '朋友') { _%>
<%= await getWorldInfo("旧书名", "测试：朋友") _%>
<%_ } else if (__stagedVal_测试 === '恋人') { _%>
<%= await getWorldInfo("旧书名", "测试：恋人") _%>
<%_ } _%>`;

  it('把调度条目里所有 getWorldInfo 书名改写为导出书名', () => {
    const aligned = alignStagedDispatcherBookName(dispatcher, '阿绫的世界书');
    expect(aligned).toContain('getWorldInfo("阿绫的世界书", "测试：朋友")');
    expect(aligned).toContain('getWorldInfo("阿绫的世界书", "测试：恋人")');
    expect(aligned).not.toContain('旧书名');
  });

  it('书名做 EJS 双引号转义（引号/反斜杠/％>不逃逸）', () => {
    const aligned = alignStagedDispatcherBookName(dispatcher, '书"名\\');
    expect(aligned).toContain('getWorldInfo("书\\"名\\\\", "测试：朋友")');
  });

  it('书名含 $ 不被 String.replace 特殊模式吞掉', () => {
    const aligned = alignStagedDispatcherBookName(dispatcher, '$&书$1');
    expect(aligned).toContain('getWorldInfo("$&书$1", "测试：朋友")');
  });

  it('不带调度签名（__stagedRaw）的第三方 EJS 不改写——可能合法引用别的书', () => {
    const thirdParty = '<%= await getWorldInfo("公共设定书", "共享条目") %>';
    expect(alignStagedDispatcherBookName(thirdParty, '阿绫的世界书')).toBe(thirdParty);
  });

  it('普通文本原样返回', () => {
    expect(alignStagedDispatcherBookName('普通内容', '书')).toBe('普通内容');
    expect(alignStagedDispatcherBookName('', '书')).toBe('');
  });

  it('书名/阶段名含引号时 parseDispatcherContent 仍能解析（不在转义引号处截断）', () => {
    const content = buildDispatcherContent({
      axisPath: '关系.阶段',
      axisType: 'number',
      numericDirection: '>=',
      bookName: '书"名',
      dispatcherName: '角色"分阶段',
      stages: [{ name: '阶段"一', condition: '>= 50' }],
    });
    const parsed = parseDispatcherContent(content);
    expect(parsed).not.toBeNull();
    // 反解出的是**未转义**的原值，可直接与条目 comment/name 比对
    expect(parsed?.bookName).toBe('书"名');
    expect(parsed?.childComments).toContain('角色"分阶段：阶段"一');
  });
});

// ── H7 regression: bookName/dispatcherName/stageName must be escaped in EJS ──

describe('Staged Lorebook Builder — H7 EJS name escaping', () => {
  function ejsToJs(ejs: string): string {
    const tagRe = /(<%_[\s\S]*?_%>|<%=!?[\s\S]*?%>|<%[\s\S]*?%>)/g;
    const out: string[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(ejs)) !== null) {
      const text = ejs.slice(last, m.index);
      if (text) out.push(`output += ${JSON.stringify(text)};`);
      const tag = m[1];
      if (tag.startsWith('<%_')) {
        out.push(tag.slice(4, -3).trim());
      } else if (tag.startsWith('<%=')) {
        const expr = tag.slice(3, tag.endsWith('_%>') ? -3 : -2).trim().replace(/^await\s+/, '');
        out.push(`output += String(${expr});`);
      } else {
        out.push(tag.slice(2, tag.endsWith('_%>') ? -3 : -2).trim());
      }
      last = tagRe.lastIndex;
    }
    const tail = ejs.slice(last);
    if (tail) out.push(`output += ${JSON.stringify(tail)};`);
    return out.join('\n');
  }

  function renderDispatcher(getvarReturn: unknown, content: string): string {
    const getvar = () => getvarReturn;
    // Mock getWorldInfo to return the arguments so we can verify they were
    // parsed correctly (i.e. the original unescaped strings reached the call).
    const getWorldInfo = (book: string, comment: string) => `[[${book}|${comment}]]`;
     
    const fn = new Function('getvar', 'getWorldInfo', `let output = ''; ${ejsToJs(content)}; return output;`);
    return fn(getvar, getWorldInfo);
  }

  it('escapes double quote in bookName', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.情感',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: '我的"特殊"卡片',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    // Must NOT contain the raw unescaped " inside the JS string literal
    expect(content).not.toContain('getWorldInfo("我的"特殊"卡片"');
    // Should contain escaped \"
    expect(content).toContain('getWorldInfo("我的\\"特殊\\"卡片"');
    // EJS compiles and runs — getWorldInfo receives the original unescaped value
    const rendered = renderDispatcher('前期', content);
    expect(rendered).toContain('[[我的"特殊"卡片|主角分阶段人设：前期]]');
  });

  it('escapes backslash in bookName', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.情感',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: 'test\\name',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    expect(content).toContain('getWorldInfo("test\\\\name"');
    const rendered = renderDispatcher('前期', content);
    expect(rendered).toContain('[[test\\name|主角分阶段人设：前期]]');
  });

  it('escapes backslash at end of bookName (critical case)', () => {
    // bookName = 'test\\' (single backslash at end) — would break EJS pre-fix
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.情感',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: 'test\\',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    // Should be escaped to 'test\\\\' (which JS parses as 'test\\')
    expect(content).toContain('getWorldInfo("test\\\\"');
    const rendered = renderDispatcher('前期', content);
    expect(rendered).toContain('[[test\\|主角分阶段人设：前期]]');
  });

  it('escapes double quote in dispatcherName (used in childComment)', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.情感',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: '书名',
      dispatcherName: '主角"分阶段"人设',
    };
    const content = buildDispatcherContent(cfg);
    expect(content).not.toContain('主角"分阶段"人设：前期');
    expect(content).toContain('主角\\"分阶段\\"人设：前期');
    const rendered = renderDispatcher('前期', content);
    expect(rendered).toContain('[[书名|主角"分阶段"人设：前期]]');
  });

  it('escapes double quote in stageName', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.情感',
      axisType: 'enum',
      stages: [{ name: '前期"特殊', condition: "=== '前期\"特殊'" }],
      bookName: '书名',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    expect(content).not.toContain('主角分阶段人设：前期"特殊');
    expect(content).toContain('主角分阶段人设：前期\\"特殊');
    const rendered = renderDispatcher('前期"特殊', content);
    expect(rendered).toContain('[[书名|主角分阶段人设：前期"特殊]]');
  });

  it('escapes % > sequence in bookName to prevent EJS close tag injection', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.情感',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: 'test%>injection',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    // The %> in the input should be neutralized (e.g. %\> or %> escaped)
    // so it doesn't prematurely close the EJS tag.
    expect(content).not.toMatch(/getWorldInfo\("test%>injection"/);
  });
});

// ── H9 regression: axisPath must be escaped in single-quoted EJS getvar(...) ──

describe('Staged Lorebook Builder — H9 EJS axisPath escaping', () => {
  function ejsToJs(ejs: string): string {
    const tagRe = /(<%_[\s\S]*?_%>|<%=!?[\s\S]*?%>|<%[\s\S]*?%>)/g;
    const out: string[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(ejs)) !== null) {
      const text = ejs.slice(last, m.index);
      if (text) out.push(`output += ${JSON.stringify(text)};`);
      const tag = m[1];
      if (tag.startsWith('<%_')) {
        out.push(tag.slice(4, -3).trim());
      } else if (tag.startsWith('<%=')) {
        const expr = tag.slice(3, tag.endsWith('_%>') ? -3 : -2).trim().replace(/^await\s+/, '');
        out.push(`output += String(${expr});`);
      } else {
        out.push(tag.slice(2, tag.endsWith('_%>') ? -3 : -2).trim());
      }
      last = tagRe.lastIndex;
    }
    const tail = ejs.slice(last);
    if (tail) out.push(`output += ${JSON.stringify(tail)};`);
    return out.join('\n');
  }

  function renderDispatcher(getvarReturn: unknown, content: string): string {
    // Mock getvar to capture the path it was called with.
    const calls: string[] = [];
    const getvar = (path: string) => {
      calls.push(path);
      return getvarReturn;
    };
    const getWorldInfo = (_book: string, comment: string) => `[[${comment}]]`;
     
    const fn = new Function('getvar', 'getWorldInfo', `let output = ''; ${ejsToJs(content)}; return output;`);
    const out = fn(getvar, getWorldInfo);
    return out + '||' + calls.join(',');
  }

  it('escapes single quote in axisPath', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: "主角.阶段'",
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: 'test',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    // Pre-fix: would contain "stat_data.主角.阶段'" (raw quote, breaks EJS)
    expect(content).not.toContain("getvar('stat_data.主角.阶段'");
    // Post-fix: should contain escaped form
    expect(content).toContain("getvar('stat_data.主角.阶段\\'");
    // EJS compiles and runs — getvar receives the original unescaped path
    const rendered = renderDispatcher('前期', content);
    expect(rendered).toContain('stat_data.主角.阶段\'');
  });

  it('escapes backslash in axisPath', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.阶段\\',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: 'test',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    // Should contain escaped \\ (double backslash in source)
    expect(content).toContain("getvar('stat_data.主角.阶段\\\\'");
    const rendered = renderDispatcher('前期', content);
    expect(rendered).toContain('stat_data.主角.阶段\\');
  });

  it('escapes backslash at end of axisPath (critical case)', () => {
    // axisPath with trailing \ — would consume the closing ' pre-fix
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.x\\',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: 'test',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    // Must not contain raw trailing \' (would escape closing quote)
    expect(content).not.toMatch(/getvar\('stat_data\.主角\.x\\'\b/);
    // Should contain escaped \\
    expect(content).toContain("getvar('stat_data.主角.x\\\\'");
  });

  it('escapes % > sequence in axisPath to prevent EJS close tag injection', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.x%>y',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: 'test',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    expect(content).not.toMatch(/getvar\('stat_data\.主角\.x%>y/);
  });

  it('escapes newline in axisPath', () => {
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.x\ny',
      axisType: 'enum',
      stages: [{ name: '前期', condition: "=== '前期'" }],
      bookName: 'test',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);
    // Must not contain raw newline inside the JS string literal
    expect(content).not.toMatch(/getvar\('stat_data\.主角\.x\ny/);
    // Should contain escaped \n
    expect(content).toContain("getvar('stat_data.主角.x\\ny'");
  });
});

// ── H12 regression: autoCondition must escape backslash, not just single quote ──
//
// autoCondition emits `=== '${stage.name}'` for enum stages. Previously it only
// replaced `'` with `\'`, leaving backslash untouched. A stage name containing
// `\` followed by `'` would produce `\\'` which the JS parser sees as `\`
// (escaped) + closing quote — letting subsequent content execute as code.

describe('Staged Lorebook Builder — H12 autoCondition backslash+quote injection', () => {
  /**
   * EJS→JS converter matching H7/H9 test pattern: handles <%_ ... _%>,
   * <%= await expr %>, and <% ... %> tag forms.
   */
  function ejsToJs(ejs: string): string {
    const tagRe = /(<%_[\s\S]*?_%>|<%=!?[\s\S]*?%>|<%[\s\S]*?%>)/g;
    const out: string[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(ejs)) !== null) {
      out.push(ejs.slice(last, m.index));
      const tag = m[0];
      if (tag.startsWith('<%_')) {
        out.push(tag.slice(3, -3).trim());
      } else if (tag.startsWith('<%=')) {
        const expr = tag.slice(3, tag.endsWith('_%>') ? -3 : -2).trim().replace(/^await\s+/, '');
        out.push(`output += String(${expr});`);
      } else {
        out.push(tag.slice(2, tag.endsWith('_%>') ? -3 : -2).trim());
      }
      last = tagRe.lastIndex;
    }
    out.push(ejs.slice(last));
    return out.join('');
  }

  /** Render the dispatcher with a stubbed getvar/getWorldInfo. */
  function renderDispatcher(getvarReturn: unknown, content: string): string {
    const calls: string[] = [];
    const getvar = (path: string) => { calls.push(path); return getvarReturn; };
    const getWorldInfo = (_book: string, comment: string) => `[[${comment}]]`;
     
    const fn = new Function('getvar', 'getWorldInfo', `let output = ''; ${ejsToJs(content)}; return output;`);
    return fn(getvar, getWorldInfo) + '||' + calls.join(',');
  }

  it('autoCondition escapes backslash+quote combo (critical injection vector)', () => {
    // stage.name = `阶段\'; evilCode(); //` (backslash + single quote)
    // Old replace: `阶段\\'; evilCode(); //` → JS parses `\\` as `\`, then
    // `'` closes the string, then `evilCode()` runs.
    // New escapeEjsSingleQuoted: `阶段\\\\\\'; evilCode(); //` — wait, let's
    // verify the actual output is safe.
    const maliciousName = "阶段\\'; evilCode(); //";
    const cond = autoCondition('enum', maliciousName);
    // The condition must NOT end the string early with an unescaped quote
    // followed by code. Safe form: backslash is doubled (so `\\` → `\` at
    // runtime), then `'` is escaped as `\'`.
    expect(cond).not.toBe(`=== '阶段\\'; evilCode(); //'`);
    // The escaped form should have the backslash doubled AND the quote escaped
    expect(cond).toContain('阶段\\\\'); // backslash doubled
    expect(cond).toContain("\\'"); // quote escaped
  });

  it('autoCondition escapes backslash at end of name (critical case)', () => {
    // stage.name = `阶段\` (single trailing backslash)
    // Old: `=== '阶段\'` → `\` escapes the closing `'`, string never closes
    // New: `=== '阶段\\'` → `\\` → `\`, string closes correctly
    const cond = autoCondition('enum', '阶段\\');
    expect(cond).toBe(`=== '阶段\\\\'`);
  });

  it('autoCondition escapes single quote alone', () => {
    const cond = autoCondition('enum', "阶段'恶意");
    // Only the single quote is escaped to \'; no backslash in input means no
    // extra escaping. Result: `=== '阶段\'恶意'` (one backslash + escaped quote).
    expect(cond).toBe(`=== '阶段\\'恶意'`);
  });

  it('autoCondition escapes %> sequence', () => {
    const cond = autoCondition('enum', '阶段%>恶意');
    // %> must be neutralized so it doesn't terminate the EJS scriptlet early
    expect(cond).not.toMatch(/阶段%>恶意/);
  });

  it('autoCondition escapes newline', () => {
    const cond = autoCondition('enum', '阶段\n恶意');
    expect(cond).toContain('\\n');
    expect(cond).not.toMatch(/阶段\n恶意/);
  });

  it('autoCondition does not mangle normal stage names', () => {
    expect(autoCondition('enum', '前期')).toBe(`=== '前期'`);
    expect(autoCondition('enum', '高潮')).toBe(`=== '高潮'`);
  });

  it('autoCondition numeric path is unaffected', () => {
    expect(autoCondition('number', 50, '>=')).toBe('>= 50');
    expect(autoCondition('number', 'abc', '>=')).toBe('>= 0');
  });

  it('buildDispatcherContent with malicious enum stage.name keeps EJS runtime safe', () => {
    // End-to-end: a stage.name with backslash+quote should not let code run
    // when the dispatcher is evaluated. The stage should never match (because
    // the runtime value won't equal the malicious string), and no code
    // outside the string literal should execute.
    const cfg: StagedLorebookConfig = {
      axisPath: '主角.阶段',
      axisType: 'enum',
      stages: [
        { name: "恶意\\'; evilCode(); //" },
        { name: '正常' },
      ],
      bookName: 'test',
      dispatcherName: '主角分阶段人设',
    };
    const content = buildDispatcherContent(cfg);

    // Render with a value that matches the normal stage — should output
    // the normal stage's content without executing evilCode().
    let evilExecuted = false;
    const g = globalThis as Record<string, unknown>;
    const originalFn = g.evilCode;
    try {
      g.evilCode = () => { evilExecuted = true; };
      const output = renderDispatcher('正常', content);
      expect(evilExecuted).toBe(false);
      expect(output).toContain('[[主角分阶段人设：正常]]');
    } finally {
      if (originalFn === undefined) {
        delete g.evilCode;
      } else {
        g.evilCode = originalFn;
      }
    }
  });
});

// ── 新增分阶段模板（cultivation/main-plot/corruption/investigation）的排序与调度 ──

describe('Staged Lorebook Builder — 新增非恋爱模板的排序与调度', () => {
  /** EJS → JS 转换（复用 H7/H9 测试中的实现） */
  function ejsToJs(ejs: string): string {
    const tagRe = /(<%_[\s\S]*?_%>|<%=!?[\s\S]*?%>|<%[\s\S]*?%>)/g;
    const out: string[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(ejs)) !== null) {
      const text = ejs.slice(last, m.index);
      if (text) out.push(`output += ${JSON.stringify(text)};`);
      const tag = m[1];
      if (tag.startsWith('<%_')) {
        out.push(tag.slice(4, -3).trim());
      } else if (tag.startsWith('<%=')) {
        const expr = tag.slice(3, tag.endsWith('_%>') ? -3 : -2).trim().replace(/^await\s+/, '');
        out.push(`output += String(${expr});`);
      } else {
        out.push(tag.slice(2, tag.endsWith('_%>') ? -3 : -2).trim());
      }
      last = tagRe.lastIndex;
    }
    const tail = ejs.slice(last);
    if (tail) out.push(`output += ${JSON.stringify(tail)};`);
    return out.join('\n');
  }

  function renderDispatcher(getvarReturn: unknown, content: string): string {
    const getvar = () => getvarReturn;
    const getWorldInfo = (_book: string, comment: string) => `[[${comment}]]`;
     
    const fn = new Function('getvar', 'getWorldInfo', `let output = ''; ${ejsToJs(content)}; return output;`);
    return fn(getvar, getWorldInfo);
  }

  // 4 个新模板的 fixtures（与 staged-templates.ts 中的定义一致）
  const newTemplateFixtures = [
    {
      name: '修仙境界 (cultivation)',
      axisPath: '境界.修为',
      dispatcherName: '主角分阶段人设',
      stages: [
        { name: '炼气', condition: '>= 0' },
        { name: '筑基', condition: '>= 15' },
        { name: '金丹', condition: '>= 35' },
        { name: '元婴', condition: '>= 55' },
        { name: '化神', condition: '>= 75' },
        { name: '炼虚', condition: '>= 90' },
        { name: '大乘', condition: '>= 100' },
      ],
    },
    {
      name: '主线推进 (main-plot)',
      axisPath: '剧情.进度',
      dispatcherName: '主角分阶段人设',
      stages: [
        { name: '序章', condition: '>= 0' },
        { name: '起步', condition: '>= 20' },
        { name: '发展', condition: '>= 40' },
        { name: '转折', condition: '>= 65' },
        { name: '高潮', condition: '>= 85' },
        { name: '终章', condition: '>= 100' },
      ],
    },
    {
      name: '心智污染 (corruption)',
      axisPath: '心智.污染度',
      dispatcherName: '主角分阶段人设',
      stages: [
        { name: '正常', condition: '>= 0' },
        { name: '动摇', condition: '>= 20' },
        { name: '异常', condition: '>= 40' },
        { name: '黑化', condition: '>= 65' },
        { name: '崩溃', condition: '>= 85' },
        { name: '毁灭', condition: '>= 100' },
      ],
    },
    {
      name: '案件调查 (investigation)',
      axisPath: '调查.真相度',
      dispatcherName: '主角分阶段人设',
      stages: [
        { name: '迷雾', condition: '>= 0' },
        { name: '初步调查', condition: '>= 15' },
        { name: '线索串联', condition: '>= 35' },
        { name: '锁定嫌疑人', condition: '>= 55' },
        { name: '真相浮现', condition: '>= 75' },
        { name: '破案', condition: '>= 90' },
        { name: '反转/终局', condition: '>= 100' },
      ],
    },
  ] as const;

  for (const fx of newTemplateFixtures) {
    describe(`${fx.name}`, () => {
      // 实际使用时 handleApply 会先 sortStagesByDirection 再构建，此处同步该流程
      const sortedStages = sortStagesByDirection(
        fx.stages.map((s) => ({ name: s.name, condition: s.condition })),
        'number',
        '>=',
      );
      const cfg: StagedLorebookConfig = {
        axisPath: fx.axisPath,
        axisType: 'number',
        numericDirection: '>=',
        stages: sortedStages,
        bookName: '测试卡',
        dispatcherName: fx.dispatcherName,
      };

      it('>= 方向阶段应按阈值从高到低排序', () => {
        // 打乱顺序后排序应恢复为从高到低
        const shuffled = [...fx.stages].reverse().map((s) => ({ name: s.name, condition: s.condition }));
        const sorted = sortStagesByDirection(shuffled, 'number', '>=');
        const expectedConditions = fx.stages.map((s) => s.condition).slice().reverse();
        expect(sorted.map((s) => s.condition)).toEqual(expectedConditions);
      });

      it('dispatcher 应正确引用该模板的轴路径', () => {
        const content = buildDispatcherContent(cfg);
        expect(content).toContain(`getvar('stat_data.${fx.axisPath}')`);
        // 排序后最高阈值在最前（第一个 else if）
        const highestStage = fx.stages[fx.stages.length - 1];
        expect(content).toContain(`} else if (__stagedVal_主角分阶段人设 ${highestStage.condition}) {`);
      });

      it('调度条目生成正确数量的子阶段', () => {
        const entries = buildStagedLorebookEntries(cfg);
        // 1 个 dispatcher + N 个子阶段
        expect(entries.length).toBe(fx.stages.length + 1);
        const dispatcher = entries[0];
        expect(dispatcher.constant).toBe(true);
        expect(dispatcher.enabled).toBe(true);
        const children = entries.slice(1);
        expect(children.every((e) => e.enabled === false)).toBe(true);
      });

      it('渲染：初始值 0 命中第一阶段，满值命中最高阶段', () => {
        const content = buildDispatcherContent(cfg);
        const firstStage = fx.stages[0];        // 最低阈值阶段（fixtures 里从低到高排列）
        const highestStage = fx.stages[fx.stages.length - 1]; // 最高阈值阶段

        // 初始值 0 → 命中最低阈值阶段（>= 0）
        expect(renderDispatcher(0, content)).toContain(`主角分阶段人设：${firstStage.name}`);
        // 满值 100 → 命中最高阈值阶段（>= 100）
        expect(renderDispatcher(100, content)).toContain(`主角分阶段人设：${highestStage.name}`);
        // 未定义 → 错误提示
        expect(renderDispatcher(undefined, content)).toContain('未定义');
      });

      it('渲染：中间值命中对应阶段', () => {
        const content = buildDispatcherContent(cfg);
        // 取中间一个阶段的阈值验证（fx.stages 从低到高排列）
        const midIdx = Math.floor(fx.stages.length / 2);
        const midStage = fx.stages[midIdx];
        const midThreshold = parseInt(midStage.condition.replace(/[^\d-]/g, ''), 10);
        // 值 = midThreshold 时，更高阈值都不满足，该阈值满足 → 命中该阶段
        expect(renderDispatcher(midThreshold, content)).toContain(`主角分阶段人设：${midStage.name}`);
      });

      it('反向解析器能正确提取轴路径和子条目', () => {
        const content = buildDispatcherContent(cfg);
        const parsed = parseDispatcherContent(content);
        expect(parsed).not.toBeNull();
        expect(parsed!.axisPath).toBe(fx.axisPath);
        expect(parsed!.bookName).toBe('测试卡');
        // 第一个和最后一个子条目都应被解析到
        expect(parsed!.childComments).toContain(`主角分阶段人设：${fx.stages[0].name}`);
        expect(parsed!.childComments).toContain(`主角分阶段人设：${fx.stages[fx.stages.length - 1].name}`);
      });
    });
  }
});
