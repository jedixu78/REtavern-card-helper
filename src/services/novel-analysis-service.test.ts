import { describe, it, expect } from 'vitest';
import {
  analysisToLorebookEntries,
  buildAnalysisVariableBlueprints,
  exportAnalysisAsJson,
  friendlyNovelAnalysisError,
  parseAnalysisImportJson,
  prepareNovelAnalysisPrompt,
  type NovelAnalysisResult,
  type NovelChunk,
  type NovelItemSetting,
  type NovelPlotStage,
  type NovelEasterEgg,
} from './novel-analysis-service';

function makeAnalysis(overrides: Partial<NovelAnalysisResult> = {}): NovelAnalysisResult {
  return {
    summary: '测试摘要',
    genre: '测试类型',
    tone: '测试氛围',
    styleProfile: {
      narration: '', dialogue: '', pacing: '', imagery: '', taboos: [],
    },
    characters: [],
    relationshipMap: [],
    uniqueSettings: [],
    items: [],
    locations: [],
    factions: [],
    timeline: [],
    mainPlot: { premise: '', stages: [], resolution: '' },
    easterEggs: [],
    lorebookEntries: [],
    cleaningNotes: [],
    ...overrides,
  };
}

describe('analysisToLorebookEntries', () => {
  it('returns empty array for empty analysis', () => {
    const entries = analysisToLorebookEntries(makeAnalysis());
    expect(entries).toEqual([]);
  });

  it('tags AI-extracted lorebookEntries with fromSkeleton + skeletonExpanded', () => {
    const analysis = makeAnalysis({
      lorebookEntries: [
        {
          name: '人物A',
          keys: ['人物A', 'A'],
          content: 'A 的设定',
          category: '人物',
        },
      ],
    });
    const entries = analysisToLorebookEntries(analysis);
    expect(entries).toHaveLength(1);
    expect(entries[0].fromSkeleton).toBe(true);
    expect(entries[0].skeletonExpanded).toBe(false);
    expect(entries[0].name).toBe('人物A');
  });

  it('filters out lorebookEntries with empty content', () => {
    const analysis = makeAnalysis({
      lorebookEntries: [
        { name: 'A', keys: ['A'], content: '   ', category: '人物' },
        { name: 'B', keys: ['B'], content: '内容', category: '人物' },
      ],
    });
    const entries = analysisToLorebookEntries(analysis);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('B');
  });

  describe('items', () => {
    const item: NovelItemSetting = {
      name: '神器X',
      category: '神器',
      attributes: '稀有度SSR',
      function: '斩杀',
      acquisition: '深渊',
      significance: '主线关键',
    };

    it('creates an independent entry per item', () => {
      const entries = analysisToLorebookEntries(makeAnalysis({ items: [item] }));
      const itemEntry = entries.find((e) => e.name === '神器X');
      expect(itemEntry).toBeDefined();
      expect(itemEntry!.content).toContain('属性：稀有度SSR');
      expect(itemEntry!.content).toContain('功能用途：斩杀');
      expect(itemEntry!.content).toContain('获取途径：深渊');
      expect(itemEntry!.content).toContain('叙事意义：主线关键');
      expect(itemEntry!.fromSkeleton).toBe(true);
    });

    it('skips items without name or function', () => {
      const entries = analysisToLorebookEntries(makeAnalysis({
        items: [
          { ...item, name: '', function: 'f' },
          { ...item, name: 'ok', function: '' },
          item,
        ],
      }));
      const itemEntries = entries.filter((e) => e.name === '神器X');
      expect(itemEntries).toHaveLength(1);
    });
  });

  describe('mainPlot staged dispatcher', () => {
    const stages: NovelPlotStage[] = [
      { name: '前期', summary: '前期简述', keyEvents: ['e1', 'e2', 'e3'], climax: '前期高潮' },
      { name: '后期', summary: '后期简述', keyEvents: ['e4', 'e5', 'e6'], climax: '后期高潮' },
    ];

    it('generates dispatcher + child entries when stages.length >= 2', () => {
      const entries = analysisToLorebookEntries(makeAnalysis({
        mainPlot: { premise: '前提', stages, resolution: '结局' },
      }));
      // 1 dispatcher + 2 child entries
      const dispatcher = entries.find((e) => e.name === '剧情主线分阶段');
      expect(dispatcher).toBeDefined();
      expect(dispatcher!.constant).toBe(true);
      expect(dispatcher!.enabled).toBe(true);
      expect(dispatcher!.content).toContain('--- 剧情前提 ---');
      expect(dispatcher!.content).toContain('前提');
      expect(dispatcher!.content).toContain('--- 结局收束 ---');
      expect(dispatcher!.content).toContain('结局');
      expect(dispatcher!.content).toContain('__NOVEL_ANALYSIS__');
      expect(dispatcher!.content).toContain("getvar('stat_data.剧情.进度')");
      expect(dispatcher!.content).toContain('前期');
      expect(dispatcher!.content).toContain('后期');

      const child1 = entries.find((e) => e.name === '剧情主线分阶段：前期');
      expect(child1).toBeDefined();
      expect(child1!.enabled).toBe(false);
      expect(child1!.content).toContain('前期简述');
      expect(child1!.content).toContain('前期高潮');

      const child2 = entries.find((e) => e.name === '剧情主线分阶段：后期');
      expect(child2).toBeDefined();
      expect(child2!.enabled).toBe(false);
    });

    it('does not generate dispatcher when stages.length < 2', () => {
      const entries = analysisToLorebookEntries(makeAnalysis({
        mainPlot: { premise: 'p', stages: [stages[0]], resolution: 'r' },
      }));
      expect(entries.find((e) => e.name === '剧情主线分阶段')).toBeUndefined();
    });

    it('dispatcher EJS evaluates correctly at runtime', () => {
      const entries = analysisToLorebookEntries(makeAnalysis({
        mainPlot: { premise: '前提', stages, resolution: '结局' },
      }));
      const dispatcher = entries.find((e) => e.name === '剧情主线分阶段')!;

      // Transpile EJS to plain JS — same approach as staged-lorebook-builder.test.ts
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
         
        const fn = new Function('getvar', 'getWorldInfo', `let output = ''; ${ejsToJs(dispatcher.content)}; return output;`);
        return fn(getvar, getWorldInfo);
      }

      // undefined variable → error message
      expect(render(undefined)).toContain('未定义');
      // matches 前期 stage
      expect(render('前期')).toContain('[[剧情主线分阶段：前期]]');
      // matches 后期 stage
      expect(render('后期')).toContain('[[剧情主线分阶段：后期]]');
      // unknown value → warning
      expect(render('未知阶段')).toContain('未匹配');
      // array form: [value, description]
      expect(render(['前期', 'desc'])).toContain('[[剧情主线分阶段：前期]]');
    });
  });

  describe('easterEggs', () => {
    const egg: NovelEasterEgg = {
      id: 'hidden_reunion',
      name: '重逢',
      trigger: '在咖啡馆提及旧时光',
      content: '她们在咖啡馆重逢...',
      keys: ['重逢', '咖啡馆'],
    };

    it('creates EJS-guarded entry per easter egg', () => {
      const entries = analysisToLorebookEntries(makeAnalysis({ easterEggs: [egg] }));
      const eggEntry = entries.find((e) => e.name === '彩蛋：重逢');
      expect(eggEntry).toBeDefined();
      expect(eggEntry!.enabled).toBe(true);
      expect(eggEntry!.keys).toEqual(['重逢', '咖啡馆']);
      expect(eggEntry!.content).toContain("<%_ if (getvar('stat_data.彩蛋.hidden_reunion') === true) { _%>");
      expect(eggEntry!.content).toContain('她们在咖啡馆重逢');
      expect(eggEntry!.content).toContain('<%_ } _%>');
      expect(eggEntry!.fromSkeleton).toBe(true);
    });

    it('skips easter eggs without id or content', () => {
      const entries = analysisToLorebookEntries(makeAnalysis({
        easterEggs: [
          { ...egg, id: '' },
          { ...egg, content: '   ' },
          egg,
        ],
      }));
      const eggEntries = entries.filter((e) => e.name === '彩蛋：重逢');
      expect(eggEntries).toHaveLength(1);
    });

    it('easter egg EJS guard evaluates correctly at runtime', () => {
      const entries = analysisToLorebookEntries(makeAnalysis({ easterEggs: [egg] }));
      const eggEntry = entries.find((e) => e.name === '彩蛋：重逢')!;

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
         
        const fn = new Function('getvar', `let output = ''; ${ejsToJs(eggEntry.content)}; return output;`);
        return fn(getvar);
      }

      // Flag = true → content injected
      const rendered = render(true);
      expect(rendered).toContain('她们在咖啡馆重逢');
      expect(rendered).toContain('触发条件：在咖啡馆提及旧时光');
      // Flag = false → content NOT injected
      expect(render(false)).not.toContain('她们在咖啡馆重逢');
      // Flag = undefined → content NOT injected
      expect(render(undefined)).not.toContain('她们在咖啡馆重逢');
    });
  });

  // ── H8 regression: egg.id must be sanitized in EJS getvar(...) and MVU path ──

  describe('H8 — egg.id sanitization (EJS single-quote injection)', () => {
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

    function renderEntry(getvarReturn: unknown, content: string): string {
      const calls: string[] = [];
      const getvar = (path: string) => { calls.push(path); return getvarReturn; };
       
      const fn = new Function('getvar', `let output = ''; ${ejsToJs(content)}; return output;`);
      return fn(getvar) + '||' + calls.join(',');
    }

    it('sanitizes single quote in egg.id (EJS injection vector)', () => {
      const maliciousEgg: NovelEasterEgg = {
        id: "x'); evilCode(); //",
        name: '彩蛋名',
        trigger: '触发',
        content: '彩蛋内容',
        keys: ['k'],
      };
      const entries = analysisToLorebookEntries(makeAnalysis({ easterEggs: [maliciousEgg] }));
      const eggEntry = entries.find((e) => e.name.startsWith('彩蛋：'));
      expect(eggEntry).toBeDefined();
      // Pre-fix: would contain raw "x'); evilCode(); //" in getvar call
      expect(eggEntry!.content).not.toContain("彩蛋.x');");
      // Post-fix: path between 'stat_data.彩蛋.' and the closing ' must only
      // contain safe identifier chars (no quote/backslash/space/paren etc.)
      const pathMatch = eggEntry!.content.match(
        /getvar\('stat_data\.(彩蛋\.[A-Za-z0-9_\u4e00-\u9fa5]+)'\)/,
      );
      expect(pathMatch).toBeDefined();
      expect(pathMatch![1].length).toBeGreaterThan('彩蛋.'.length);
    });

    it('sanitizes backslash in egg.id', () => {
      const maliciousEgg: NovelEasterEgg = {
        id: 'x\\y',
        name: '彩蛋名',
        trigger: '触发',
        content: '彩蛋内容',
        keys: ['k'],
      };
      const entries = analysisToLorebookEntries(makeAnalysis({ easterEggs: [maliciousEgg] }));
      const eggEntry = entries.find((e) => e.name.startsWith('彩蛋：'));
      expect(eggEntry).toBeDefined();
      // Path should be a safe identifier — no raw backslash
      expect(eggEntry!.content).not.toMatch(/彩蛋\.x\\y/);
    });

    it('sanitized egg.id keeps EJS runtime working', () => {
      const maliciousEgg: NovelEasterEgg = {
        id: "x' OR evil='y",
        name: '彩蛋名',
        trigger: '触发',
        content: '彩蛋内容',
        keys: ['k'],
      };
      const entries = analysisToLorebookEntries(makeAnalysis({ easterEggs: [maliciousEgg] }));
      const eggEntry = entries.find((e) => e.name.startsWith('彩蛋：'))!;
      // EJS compiles and runs without syntax errors
      expect(() => renderEntry(true, eggEntry.content)).not.toThrow();
      // Content injected when flag is true
      const rendered = renderEntry(true, eggEntry.content);
      expect(rendered).toContain('彩蛋内容');
      // Content NOT injected when flag is false
      expect(renderEntry(false, eggEntry.content)).not.toContain('彩蛋内容');
    });

    it('sanitizes egg.id in buildAnalysisVariableBlueprints (MVU path)', () => {
      const maliciousEgg: NovelEasterEgg = {
        id: "x'); evil(); //",
        name: '彩蛋名',
        trigger: '触发',
        content: '彩蛋内容',
        keys: ['k'],
      };
      const blueprints = buildAnalysisVariableBlueprints(makeAnalysis({ easterEggs: [maliciousEgg] }));
      const eggVar = blueprints.find((b) => b.path.startsWith('彩蛋.'));
      expect(eggVar).toBeDefined();
      // Path should be a safe identifier — no quote/backslash/space
      expect(eggVar!.path).toMatch(/^彩蛋\.[A-Za-z0-9_\u4e00-\u9fa5]+$/);
      // Should not contain raw quote or backslash
      expect(eggVar!.path).not.toContain("'");
      expect(eggVar!.path).not.toContain('\\');
    });

    it('skips egg.id that sanitizes to empty', () => {
      const maliciousEgg: NovelEasterEgg = {
        id: "''",
        name: '彩蛋名',
        trigger: '触发',
        content: '彩蛋内容',
        keys: ['k'],
      };
      const entries = analysisToLorebookEntries(makeAnalysis({ easterEggs: [maliciousEgg] }));
      // Either no egg entry, or an entry with a safe fallback id
      const eggEntries = entries.filter((e) => e.name.startsWith('彩蛋：'));
      expect(eggEntries.length).toBeLessThanOrEqual(1);
      if (eggEntries.length === 1) {
        // Path between 'stat_data.彩蛋.' and the closing ' must only contain
        // safe identifier chars (sanitizeSegment fallback is 'flag' for empty)
        const pathMatch = eggEntries[0].content.match(
          /getvar\('stat_data\.(彩蛋\.[A-Za-z0-9_\u4e00-\u9fa5]+)'\)/,
        );
        expect(pathMatch).toBeDefined();
      }
    });
  });
});

describe('buildAnalysisVariableBlueprints', () => {
  it('emits 剧情.进度 enum when mainPlot.stages has >= 2 entries', () => {
    const analysis = makeAnalysis({
      mainPlot: {
        premise: 'p',
        stages: [
          { name: '前期', summary: '', keyEvents: [], climax: '' },
          { name: '后期', summary: '', keyEvents: [], climax: '' },
        ],
        resolution: 'r',
      },
    });
    const blueprints = buildAnalysisVariableBlueprints(analysis);
    const plotVar = blueprints.find((b) => b.path === '剧情.进度');
    expect(plotVar).toBeDefined();
    expect(plotVar!.type).toBe('enum');
    expect(plotVar!.options).toEqual(['前期', '后期']);
    expect(plotVar!.default).toBe('前期');
  });

  it('does not emit 剧情.进度 when stages.length < 2', () => {
    const analysis = makeAnalysis({
      mainPlot: {
        premise: 'p',
        stages: [{ name: '前期', summary: '', keyEvents: [], climax: '' }],
        resolution: 'r',
      },
    });
    const blueprints = buildAnalysisVariableBlueprints(analysis);
    expect(blueprints.find((b) => b.path === '剧情.进度')).toBeUndefined();
  });

  it('emits one 彩蛋.{id} boolean per easter egg', () => {
    const analysis = makeAnalysis({
      easterEggs: [
        { id: 'egg_a', name: 'A', trigger: 't', content: 'c', keys: [] },
        { id: 'egg_b', name: 'B', trigger: 't', content: 'c', keys: [] },
        { id: '', name: 'empty', trigger: 't', content: 'c', keys: [] },
      ],
    });
    const blueprints = buildAnalysisVariableBlueprints(analysis);
    const eggBlueprints = blueprints.filter((b) => b.path.startsWith('彩蛋.'));
    expect(eggBlueprints).toHaveLength(2);
    expect(eggBlueprints[0].path).toBe('彩蛋.egg_a');
    expect(eggBlueprints[1].path).toBe('彩蛋.egg_b');
    expect(eggBlueprints[0].type).toBe('boolean');
    expect(eggBlueprints[0].default).toBe(false);
  });

  it('returns empty array for empty analysis', () => {
    expect(buildAnalysisVariableBlueprints(makeAnalysis())).toEqual([]);
  });
});

// ── S1-8 item 1: prompt token precheck ───────────────────────────────────────

function makeChunks(count: number, charsPerChunk: number): NovelChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `第${i + 1}章`,
    content: '阿'.repeat(charsPerChunk),
    start: i * charsPerChunk,
    end: (i + 1) * charsPerChunk,
  }));
}

describe('prepareNovelAnalysisPrompt (token 预检)', () => {
  it('short input is not degraded', () => {
    const { system, user, precheck } = prepareNovelAnalysisPrompt('短篇', makeChunks(3, 2000), 'gpt-4o');
    expect(system.length).toBeGreaterThan(0);
    expect(user).toContain('阿');
    expect(precheck.degraded).toBe(false);
    expect(precheck.exceedsLimit).toBe(false);
    expect(precheck.estimatedTokens).toBeGreaterThan(0);
    expect(precheck.estimatedTokens).toBeLessThanOrEqual(precheck.tokenLimit);
  });

  it('long input on a mid-context model shrinks the sample until it fits', () => {
    // 10 chunks × 12000 CJK chars → full 42000-char sample ≈ 57k tokens。
    // 未知模型的保守默认上限 50000 → 必须降一档才装得下。
    const chunks = makeChunks(10, 12000);
    const degradedRun = prepareNovelAnalysisPrompt('长篇', chunks, 'some-unknown-model');
    expect(degradedRun.precheck.degraded).toBe(true);
    expect(degradedRun.precheck.exceedsLimit).toBe(false);
    expect(degradedRun.precheck.estimatedTokens).toBeLessThanOrEqual(degradedRun.precheck.tokenLimit);
    expect(degradedRun.precheck.sampleMaxChars).toBeLessThan(42000);

    // Same input on a long-context model needs no degradation…
    const longContextRun = prepareNovelAnalysisPrompt('长篇', chunks, 'gemini-2.5-pro');
    expect(longContextRun.precheck.degraded).toBe(false);
    expect(longContextRun.precheck.tokenLimit).toBeGreaterThan(degradedRun.precheck.tokenLimit);
    // …so the degraded prompt is actually shorter than the full one.
    expect(degradedRun.user.length).toBeLessThan(longContextRun.user.length);
  });

  it('gpt-3.5 等短上下文模型如实报告超限，而不是假装 50k 装得下', () => {
    // 修复前 gpt-3.5 未被模式表匹配、落到 50000 默认值——预检声称「已适配」
    // 但真实上下文只有 16k，调用必然 400。现在按 12000 如实判定。
    const chunks = makeChunks(10, 12000);
    const run = prepareNovelAnalysisPrompt('长篇', chunks, 'gpt-3.5-turbo');
    expect(run.precheck.tokenLimit).toBe(12000);
    // 阶梯最低档 12000 字的中文样本仍超 12000 token 上限 → 必须如实标记超限
    expect(run.precheck.degraded).toBe(true);
    expect(run.precheck.exceedsLimit).toBe(true);
  });

  it('throws the no-text error for empty chunks', () => {
    expect(() => prepareNovelAnalysisPrompt('空', [], 'gpt-4o')).toThrow('请先输入或上传小说文本');
  });
});

// ── S1-8 item 1: friendly API error messages ─────────────────────────────────

describe('friendlyNovelAnalysisError', () => {
  it('maps 429 rate-limit errors', () => {
    const msg = friendlyNovelAnalysisError(new Error('AI API 调用失败 (429)：Too Many Requests'));
    expect(msg).toContain('限流');
  });

  it('maps Gemini prohibited-content errors', () => {
    const msg = friendlyNovelAnalysisError(new Error('AI API 返回错误：PROHIBITED_CONTENT: request blocked'));
    expect(msg).toContain('Gemini 安全策略');
  });

  it('maps 400 safety rejections', () => {
    const msg = friendlyNovelAnalysisError(new Error('AI API 调用失败 (400)：safety system rejected the request'));
    expect(msg).toContain('安全策略');
  });

  it('passes unmatched messages through unchanged', () => {
    expect(friendlyNovelAnalysisError(new Error('某个普通错误'))).toBe('某个普通错误');
  });

  it('falls back to a generic message for empty input', () => {
    expect(friendlyNovelAnalysisError(undefined)).toContain('小说分析失败');
  });
});

// ── S1-8 item 3: analysis JSON re-import ─────────────────────────────────────

describe('parseAnalysisImportJson', () => {
  const entry = { name: '人物A', keys: ['人物A'], content: 'A 的设定', category: '人物' };

  it('round-trips exportAnalysisAsJson output', () => {
    const analysis = makeAnalysis({ summary: '整体摘要', lorebookEntries: [entry] });
    const raw = exportAnalysisAsJson('我的小说', makeChunks(2, 100), analysis);
    const imported = parseAnalysisImportJson(raw);
    expect(imported.title).toBe('我的小说');
    expect(imported.analysis.summary).toBe('整体摘要');
    expect(imported.analysis.lorebookEntries).toHaveLength(1);
    expect(imported.analysis.lorebookEntries[0].name).toBe('人物A');
    // Restored analysis feeds the existing pipeline unchanged
    expect(analysisToLorebookEntries(imported.analysis)).toHaveLength(1);
  });

  it('accepts a bare analysis object (no wrapper)', () => {
    const analysis = makeAnalysis({ summary: '裸对象', lorebookEntries: [entry] });
    const imported = parseAnalysisImportJson(JSON.stringify(analysis));
    expect(imported.title).toBe('');
    expect(imported.analysis.summary).toBe('裸对象');
  });

  it('fills missing optional fields via normalization', () => {
    const raw = JSON.stringify({ title: 't', analysis: { summary: 's', lorebookEntries: [] } });
    const imported = parseAnalysisImportJson(raw);
    expect(imported.analysis.characters).toEqual([]);
    expect(imported.analysis.items).toEqual([]);
    expect(imported.analysis.easterEggs).toEqual([]);
    expect(imported.analysis.styleProfile.taboos).toEqual([]);
    expect(imported.analysis.mainPlot).toEqual({ premise: '', stages: [], resolution: '' });
  });

  it('rejects invalid JSON with a Chinese error', () => {
    expect(() => parseAnalysisImportJson('不是JSON{{{')).toThrow('不是有效的 JSON');
  });

  it('rejects non-object top level', () => {
    expect(() => parseAnalysisImportJson('[1,2,3]')).toThrow('顶层应为对象');
  });

  it('rejects objects without an analysis field', () => {
    expect(() => parseAnalysisImportJson(JSON.stringify({ foo: 1 }))).toThrow('缺少 analysis 字段');
  });

  it('rejects analysis with wrong-typed required fields', () => {
    const raw = JSON.stringify({ analysis: { summary: 123, lorebookEntries: '不是数组' } });
    expect(() => parseAnalysisImportJson(raw)).toThrow('缺少必需字段');
  });

  it('rejects non-object lorebookEntries elements', () => {
    const raw = JSON.stringify({ analysis: { summary: 's', lorebookEntries: ['字符串条目'] } });
    expect(() => parseAnalysisImportJson(raw)).toThrow('非对象条目');
  });
});
