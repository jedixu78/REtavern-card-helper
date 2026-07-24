/**
 * beginner-templates.test.ts — 新手模式模板系统单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  BEGINNER_TEMPLATES,
  getBeginnerTemplateById,
  applyBeginnerTemplate,
  buildTemplateAIBlueprint,
  getTemplateBlueprint,
} from '../constants/beginner-templates';
import { createEmptyMvuConfig } from '../constants/defaults';

describe('beginner-templates', () => {
  describe('模板注册表', () => {
    it('包含 4 个主题模板', () => {
      expect(BEGINNER_TEMPLATES).toHaveLength(4);
    });

    it('每个模板有唯一 id', () => {
      const ids = BEGINNER_TEMPLATES.map(t => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('每个模板有必要的元数据', () => {
      for (const t of BEGINNER_TEMPLATES) {
        expect(t.id).toBeTruthy();
        expect(t.name).toBeTruthy();
        expect(t.icon).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.themeColor).toMatch(/^#/);
        expect(t.themeGradient).toContain('gradient');
        expect(t.tags.length).toBeGreaterThan(0);
        expect(t.statusBarTitle).toBeTruthy();
      }
    });

    it('包含武侠、修仙、末日、都市四种风格', () => {
      const ids = BEGINNER_TEMPLATES.map(t => t.id);
      expect(ids).toContain('wuxia');
      expect(ids).toContain('xianxia');
      expect(ids).toContain('apocalypse');
      expect(ids).toContain('modern');
    });
  });

  describe('getBeginnerTemplateById', () => {
    it('能按 id 查找模板', () => {
      const wuxia = getBeginnerTemplateById('wuxia');
      expect(wuxia).toBeDefined();
      expect(wuxia!.name).toBe('江湖武侠');
    });

    it('不存在的 id 返回 undefined', () => {
      expect(getBeginnerTemplateById('nonexistent')).toBeUndefined();
    });
  });

  describe('模板变量结构', () => {
    for (const template of BEGINNER_TEMPLATES) {
      describe(`${template.name} (${template.id})`, () => {
        it('buildSections 返回非空分区数组', () => {
          const sections = template.buildSections();
          expect(sections.length).toBeGreaterThan(0);
        });

        it('每个分区有名称和变量', () => {
          const sections = template.buildSections();
          for (const s of sections) {
            expect(s.name).toBeTruthy();
            expect(s.variables.length).toBeGreaterThan(0);
          }
        });

        it('每个变量有 path、zodType、description', () => {
          const sections = template.buildSections();
          for (const s of sections) {
            for (const v of s.variables) {
              expect(v.path).toBeTruthy();
              expect(v.zodType).toBeTruthy();
              expect(v.description).toBeTruthy();
            }
          }
        });

        it('变量路径包含点分格式', () => {
          const sections = template.buildSections();
          for (const s of sections) {
            for (const v of s.variables) {
              expect(v.path).toContain('.');
            }
          }
        });

        it('数值变量有 range', () => {
          const sections = template.buildSections();
          for (const s of sections) {
            for (const v of s.variables) {
              if (v.zodType === 'z.coerce.number()') {
                expect(v.range).toBeDefined();
                expect(v.range!.min).toBeLessThan(v.range!.max);
              }
            }
          }
        });

        it('枚举变量有 enumValues', () => {
          const sections = template.buildSections();
          for (const s of sections) {
            for (const v of s.variables) {
              if (v.zodType.startsWith('z.enum(')) {
                expect(v.enumValues).toBeDefined();
                expect(v.enumValues!.length).toBeGreaterThan(1);
              }
            }
          }
        });

        it('buildRules 返回非空规则数组', () => {
          const rules = template.buildRules();
          expect(rules.length).toBeGreaterThan(0);
        });

        it('每条规则有 path 和 check', () => {
          const rules = template.buildRules();
          for (const r of rules) {
            expect(r.path).toBeTruthy();
            expect(r.check).toBeDefined();
            expect(r.check!.length).toBeGreaterThan(0);
          }
        });

        it('规则路径在变量中有定义', () => {
          const sections = template.buildSections();
          const allPaths = new Set(sections.flatMap(s => s.variables.map(v => v.path)));
          const rules = template.buildRules();
          for (const r of rules) {
            expect(allPaths.has(r.path)).toBe(true);
          }
        });

        it('蓝图分区与 buildSections 分区名一致', () => {
          const blueprintNames = template.sections.map(s => s.name);
          const sectionNames = template.buildSections().map(s => s.name);
          expect(blueprintNames).toEqual(sectionNames);
        });
      });
    }
  });

  describe('武侠模板特定检查', () => {
    const wuxia = getBeginnerTemplateById('wuxia')!;

    it('包含秘籍、武林轶事、个人简介、背包分区', () => {
      const names = wuxia.sections.map(s => s.name);
      expect(names).toContain('武功秘籍');
      expect(names).toContain('武林轶事');
      expect(names).toContain('个人简介');
      expect(names).toContain('背包行囊');
    });

    it('秘籍列表是 record 类型', () => {
      const sections = wuxia.buildSections();
      const wuxiaSection = sections.find(s => s.name === '武功秘籍');
      const listVar = wuxiaSection?.variables.find(v => v.path === '秘籍.列表');
      expect(listVar).toBeDefined();
      expect(listVar!.zodType).toContain('z.record(');
    });

    it('属性变量有合理范围', () => {
      const sections = wuxia.buildSections();
      const attrSection = sections.find(s => s.name === '江湖属性');
      expect(attrSection).toBeDefined();
      const wuli = attrSection!.variables.find(v => v.path === '属性.武力');
      expect(wuli!.range).toEqual({ min: 0, max: 100 });
      const shengwang = attrSection!.variables.find(v => v.path === '属性.声望');
      expect(shengwang!.range).toEqual({ min: -100, max: 100 });
    });

    it('蓝图中秘籍变量标记为 AI 可生成', () => {
      const section = wuxia.sections.find(s => s.name === '武功秘籍');
      expect(section).toBeDefined();
      for (const v of section!.variables) {
        expect(v.aiGeneratable).toBe(true);
      }
    });
  });

  describe('applyBeginnerTemplate', () => {
    it('生成启用的 MvuConfig', () => {
      const wuxia = getBeginnerTemplateById('wuxia')!;
      const config = applyBeginnerTemplate(wuxia);
      expect(config.enabled).toBe(true);
      expect(config.mode).toBe('beginner');
      expect(config.beginnerTemplateId).toBe('wuxia');
    });

    it('填充 schemaSections 和 updateRules', () => {
      const xianxia = getBeginnerTemplateById('xianxia')!;
      const config = applyBeginnerTemplate(xianxia);
      expect(config.schemaSections.length).toBeGreaterThan(0);
      expect(config.updateRules.length).toBeGreaterThan(0);
    });

    it('保留已有配置的 statusBar 字段', () => {
      const existing = { ...createEmptyMvuConfig(), statusBarHtml: '<div>test</div>', statusBarStyle: 'compact-hud' };
      const wuxia = getBeginnerTemplateById('wuxia')!;
      const config = applyBeginnerTemplate(wuxia, existing);
      expect(config.statusBarHtml).toBe('<div>test</div>');
      expect(config.statusBarStyle).toBe('compact-hud');
    });

    it('清空派生内容字段（让组件重算）', () => {
      const existing = { ...createEmptyMvuConfig(), schemaTsContent: 'old content' };
      const wuxia = getBeginnerTemplateById('wuxia')!;
      const config = applyBeginnerTemplate(wuxia, existing);
      expect(config.schemaTsContent).toBe('');
      expect(config.initvarYamlContent).toBe('');
      expect(config.updateRulesYamlContent).toBe('');
    });
  });

  describe('buildTemplateAIBlueprint', () => {
    it('生成包含模板名和所有分区的文本', () => {
      const wuxia = getBeginnerTemplateById('wuxia')!;
      const blueprint = buildTemplateAIBlueprint(wuxia);
      expect(blueprint).toContain('江湖武侠');
      expect(blueprint).toContain('武功秘籍');
      expect(blueprint).toContain('武林轶事');
      expect(blueprint).toContain('个人简介');
      expect(blueprint).toContain('背包行囊');
    });

    it('包含 AI 可生成变量的提示', () => {
      const wuxia = getBeginnerTemplateById('wuxia')!;
      const blueprint = buildTemplateAIBlueprint(wuxia);
      expect(blueprint).toContain('秘籍列表');
      expect(blueprint).toContain('生成');
    });
  });

  describe('getTemplateBlueprint', () => {
    it('返回模板的分区蓝图', () => {
      const modern = getBeginnerTemplateById('modern')!;
      const blueprint = getTemplateBlueprint(modern);
      expect(blueprint).toEqual(modern.sections);
      expect(blueprint.length).toBe(4);
    });
  });
});
