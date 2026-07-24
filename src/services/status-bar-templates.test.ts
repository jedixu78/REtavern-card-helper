import { describe, it, expect } from 'vitest';
import {
  STATUS_BAR_TEMPLATES,
  STATUS_BAR_THEMES,
  generateStatusBarHtml,
  getStatusBarTemplateById,
  getStatusBarThemeById,
  reflectSections,
} from './status-bar-templates';
import type { MvuSchemaSection } from '../constants/defaults';

// ── 测试数据 ────────────────────────────────────────────────────────────────

const simpleSchema: MvuSchemaSection[] = [
  {
    name: '关系',
    variables: [
      { path: '关系.情感天平', zodType: 'z.coerce.number()', description: '情感倾向', prefix: '', initialValue: 35, range: { min: -100, max: 100 } },
    ],
  },
];

const richSchema: MvuSchemaSection[] = [
  {
    name: '系统',
    variables: [
      { path: '系统.封锁天数', zodType: 'z.coerce.number()', description: '天数', prefix: '', initialValue: 3, range: { min: 1, max: 100 } },
      { path: '系统.当前地点', zodType: 'z.string()', description: '地点', prefix: '', initialValue: '旧居民区' },
      { path: '系统.天气', zodType: 'z.enum(["晴","阴","雨","雪"])', description: '天气', prefix: '', initialValue: '阴', enumValues: ['晴', '阴', '雨', '雪'] },
    ],
  },
  {
    name: '健康',
    variables: [
      { path: '健康.头部血量', zodType: 'z.coerce.number()', description: '头部', prefix: '', initialValue: 20, range: { min: 0, max: 35 } },
      { path: '健康.胸腔血量', zodType: 'z.coerce.number()', description: '胸腔', prefix: '', initialValue: 80, range: { min: 0, max: 85 } },
      { path: '健康.出血状态', zodType: 'z.enum(["无","轻度","重度","内出血"])', description: '出血', prefix: '', initialValue: '轻度', enumValues: ['无', '轻度', '重度', '内出血'] },
      { path: '健康.感染', zodType: 'z.boolean()', description: '感染', prefix: '', initialValue: false },
    ],
  },
  {
    name: '背包',
    variables: [
      { path: '背包.物品', zodType: 'z.record(z.string(), z.object({}))', description: '物品', prefix: '', initialValue: { '绷带': { '数量': 2 }, '手枪': { '数量': 1 } } },
      { path: '背包.隐藏标记', zodType: 'z.boolean()', description: '隐藏', prefix: '$', initialValue: false },
    ],
  },
];

// ── 注册表 ──────────────────────────────────────────────────────────────────

describe('状态栏模板注册表', () => {
  it('包含 2 个内置模板与 4 套主题', () => {
    expect(STATUS_BAR_TEMPLATES.map(t => t.id)).toEqual(['compact-hud', 'character-panel']);
    expect(STATUS_BAR_THEMES.map(t => t.id)).toEqual(['terminal', 'parchment', 'glass', 'paper']);
  });

  it('按 id 查找模板与主题，未知主题回退到第一个', () => {
    expect(getStatusBarTemplateById('compact-hud')?.name).toBe('紧凑HUD');
    expect(getStatusBarTemplateById('不存在')).toBeUndefined();
    expect(getStatusBarThemeById('不存在').id).toBe('terminal');
  });
});

// ── Schema 反射 ─────────────────────────────────────────────────────────────

describe('schema 反射选型', () => {
  it('number+合理范围 → bar', () => {
    const reflected = reflectSections(simpleSchema);
    expect(reflected[0].vars[0].kind).toBe('bar');
  });

  it('enum → enum，string → text，boolean → boolean，record → list', () => {
    const reflected = reflectSections(richSchema);
    const health = reflected.find(s => s.name === '健康')!;
    const byLabel = Object.fromEntries(health.vars.map(v => [v.label, v.kind]));
    expect(byLabel['头部血量']).toBe('bar');
    expect(byLabel['出血状态']).toBe('enum');
    expect(byLabel['感染']).toBe('boolean');
    const bag = reflected.find(s => s.name === '背包')!;
    expect(bag.vars.find(v => v.label === '物品')?.kind).toBe('list');
  });

  it('隐藏变量（$ 前缀）不参与反射', () => {
    const reflected = reflectSections(richSchema);
    const bag = reflected.find(s => s.name === '背包')!;
    expect(bag.vars.find(v => v.label === '隐藏标记')).toBeUndefined();
  });

  it('jsPath 以 stat_data. 开头', () => {
    const reflected = reflectSections(simpleSchema);
    expect(reflected[0].vars[0].jsPath).toBe('stat_data.关系.情感天平');
  });
});

// ── 生成有效性 ──────────────────────────────────────────────────────────────

describe('generateStatusBarHtml 输出', () => {
  for (const tmpl of STATUS_BAR_TEMPLATES) {
    for (const theme of STATUS_BAR_THEMES) {
      it(`${tmpl.id} + ${theme.id} 生成完整 HTML 文档`, () => {
        const html = generateStatusBarHtml(tmpl.id, richSchema, { themeId: theme.id, title: '行动记录' });
        expect(html.startsWith('```html')).toBe(true);
        expect(html).toContain('<script type="module">');
        expect(html).toContain('getAllVariables');
        expect(html).toContain('VARIABLE_UPDATE_ENDED');
        expect(html).toContain('sbGet');
        expect(html.trim().endsWith('```')).toBe(true);
      });
    }
  }

  it('未知模板返回空字符串', () => {
    expect(generateStatusBarHtml('nonexistent', richSchema)).toBe('');
  });

  it('生成的脚本读取每个可见变量', () => {
    const html = generateStatusBarHtml('character-panel', richSchema, { themeId: 'terminal' });
    expect(html).toContain('stat_data.健康.头部血量');
    expect(html).toContain('stat_data.系统.当前地点');
    // 隐藏变量不应出现
    expect(html).not.toContain('stat_data.背包.隐藏标记');
  });

  it('资源条含三态着色逻辑（单向）与过渡动画', () => {
    const html = generateStatusBarHtml('compact-hud', richSchema, { themeId: 'terminal' });
    expect(html).toContain('sb-bar-fill');
    expect(html).toContain('transition:width');
    expect(html).toContain("classList.toggle('sb-danger'");
  });

  it('视觉选项会写入透明度、密度、动画与图标配置', () => {
    const html = generateStatusBarHtml('character-panel', simpleSchema, {
      themeId: 'glass',
      opacity: 0.8,
      density: 'comfortable',
      animated: false,
      showIcons: false,
    });
    expect(html).toContain('--sb-opacity:0.8');
    expect(html).toContain('sb-comfortable');
    expect(html).not.toContain('class="sb-root sb-comfortable sb-animated"');
    expect(html).not.toContain('▸ 关系');
  });

  it('预览值覆盖会写入运行时并优先于默认变量', () => {
    const html = generateStatusBarHtml('compact-hud', simpleSchema, {
      previewValues: { 'stat_data.关系.情感天平': 88 },
      previewNotice: '新通知',
    });
    expect(html).toContain('var sbPreviewValues = {"stat_data.关系.情感天平":88};');
    expect(html).toContain('window.__statusBarPreview');
    expect(html).toContain('新通知');
    expect(html).toContain('sb-notice');
  });
});
