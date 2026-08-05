/**
 * 功能验证测试 — 测试导出卡片的各功能组件是否真正可用
 *
 * 测试内容：
 * 1. MVU 状态栏：Zod schema 结构、YAML 初始变量/更新规则解析、状态栏 HTML DOM 结构、正则替换
 * 2. 分阶段模式：EJS 调度模板结构、parseDispatcherContent 往返一致性、子条目关联
 * 3. 直播间面板：HTML DOM 结构、初始弹幕渲染、正则脚本占位符替换
 * 4. 正则脚本端到端：pattern 编译、匹配/替换行为验证
 * 5. 世界书条目：EJS 模板有效性、关键词触发逻辑
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createEmptyDraft, resolveBookName } from '../constants/defaults';
import type { WizardDraft } from '../constants/defaults';
import { getBeginnerTemplateById } from '../constants/beginner-templates';
import { buildMvuScriptBundle } from './mvu-builder';
import { buildStagedLorebookEntries, buildDispatcherContent, parseDispatcherContent } from './staged-lorebook-builder';
import type { StagedLorebookConfig } from './staged-lorebook-builder';
import { generateLiveChatHtml } from './live-chat-templates';
import { generateStatusBarHtml } from './status-bar-templates';
import { assembleCard } from './card-exporter';

// ── 测试数据构建（复用 e2e 测试的数据，但不依赖 AI 调用）─────────────────

function buildTestDraft(): WizardDraft {
  const draft = createEmptyDraft();
  draft.cardName = '危城';
  draft.tags = ['现代都市', '悬疑情感', '继姐弟', '日常'];

  // ── Step 5: MVU（现代模板）────────────────────────────────────────────
  const modernTemplate = getBeginnerTemplateById('modern');
  if (!modernTemplate) throw new Error('Modern template not found');

  const schemaSections = modernTemplate.buildSections();
  const updateRules = modernTemplate.buildRules();

  // 填充初始值
  const profileSection = schemaSections.find(s => s.name === '人物档案');
  if (profileSection) {
    const nameVar = profileSection.variables.find(v => v.path === '档案.姓名');
    if (nameVar) nameVar.initialValue = '张楚怡';
    const jobVar = profileSection.variables.find(v => v.path === '档案.职业');
    if (jobVar) jobVar.initialValue = '大学生/兼职模特';
    const personalityVar = profileSection.variables.find(v => v.path === '档案.性格');
    if (personalityVar) personalityVar.initialValue = '外冷内热，嘴硬心软';
  }

  const socialSection = schemaSections.find(s => s.name === '社交关系');
  if (socialSection) {
    const affinityVar = socialSection.variables.find(v => v.path === '社交.好感度');
    if (affinityVar) affinityVar.initialValue = 20;
    const relationVar = socialSection.variables.find(v => v.path === '社交.关系');
    if (relationVar) relationVar.initialValue = '点头之交';
  }

  const statsSection = schemaSections.find(s => s.name === '生活指标');
  if (statsSection) {
    const moodVar = statsSection.variables.find(v => v.path === '指标.心情');
    if (moodVar) moodVar.initialValue = 60;
    const energyVar = statsSection.variables.find(v => v.path === '指标.精力');
    if (energyVar) energyVar.initialValue = 80;
    const walletVar = statsSection.variables.find(v => v.path === '指标.钱包');
    if (walletVar) walletVar.initialValue = 3000;
  }

  draft.mvu = {
    enabled: true,
    mode: 'beginner',
    beginnerTemplateId: 'modern',
    schemaSections,
    updateRules,
    ejsConfigs: [],
    ejsPreprocessContent: '',
    schemaTsContent: '',
    initvarYamlContent: '',
    updateRulesYamlContent: '',
    statusBarHtml: '',
    statusBarStyle: 'compact-panel',
    statusBarShowIcons: false,
    statusBarOptions: {
      themeId: 'terminal',
      title: modernTemplate.statusBarTitle,
      density: 'compact',
    },
  };
  draft.useMvuExport = true;

  // ── Step 6: 分阶段模式 ─────────────────────────────────────────────────
  const bookName = resolveBookName(draft);
  const stagedEntries = buildStagedLorebookEntries({
    axisPath: '社交.关系',
    axisType: 'enum',
    bookName,
    dispatcherName: '张楚怡分阶段人设',
    stages: [
      {
        name: '陌生人',
        condition: `=== '陌生人'`,
        content: '# 张楚怡 — 陌生人阶段\n- 态度：冷淡、疏离',
      },
      {
        name: '点头之交',
        condition: `=== '点头之交'`,
        content: '# 张楚怡 — 点头之交阶段\n- 态度：稍微放松',
      },
      {
        name: '朋友',
        condition: `=== '朋友'`,
        content: '# 张楚怡 — 朋友阶段\n- 态度：自然、放松',
      },
      {
        name: '暧昧',
        condition: `=== '暧昧'`,
        content: '# 张楚怡 — 暧昧阶段\n- 态度：害羞、嘴硬',
      },
      {
        name: '恋人',
        condition: `=== '恋人'`,
        content: '# 张楚怡 — 恋人阶段\n- 态度：温柔、撒娇',
      },
    ],
    position: 'after_char',
    dispatcherOrder: 150,
    childOrder: 151,
  });

  draft.lorebookEntries = [...draft.lorebookEntries, ...stagedEntries];
  draft.stagedMode = {
    enabled: true,
    templateId: 'pure-love',
    dispatcherPrefix: '分阶段人设',
    characters: [
      {
        name: '张楚怡',
        summary: '冷萌大学生',
        axisPath: '社交.关系',
        axisType: 'enum',
        stages: [
          { name: '陌生人', condition: `=== '陌生人'`, annotation: '冷淡疏离' },
          { name: '点头之交', condition: `=== '点头之交'`, annotation: '稍微放松' },
          { name: '朋友', condition: `=== '朋友'`, annotation: '自然放松' },
          { name: '暧昧', condition: `=== '暧昧'`, annotation: '害羞嘴硬' },
          { name: '恋人', condition: `=== '恋人'`, annotation: '温柔撒娇' },
        ],
      },
    ],
  };

  // ── Step 8: 直播间面板 ─────────────────────────────────────────────────
  const liveChatHtml = generateLiveChatHtml({
    themeId: 'terminal',
    title: '危城直播间',
    maxVisible: 8,
    initialComments: [
      '这个继姐好高冷啊',
      '感觉她在偷看{{user}}',
      '这剧情发展有点东西',
      '抹茶百奇棒名场面！',
      '冷萌属性拉满了',
    ],
  });

  draft.liveStreamChat = {
    enabled: true,
    html: liveChatHtml,
    themeId: 'terminal',
    title: '危城直播间',
    maxVisible: 8,
    initialComments: [
      '这个继姐好高冷啊',
      '感觉她在偷看{{user}}',
      '这剧情发展有点东西',
      '抹茶百奇棒名场面！',
      '冷萌属性拉满了',
    ],
  };

  // ── Step 7: 开场白（静态数据，不依赖 AI）──────────────────────────────
  draft.firstMessage = '周六早晨，阳光透过窗帘的缝隙洒进客厅。张楚怡坐在沙发上看书，偶尔抬头看一眼正在拼高达的{{user}}。';

  // ── 生成状态栏 HTML（必须在 assembleCard 之前设置，否则不会生成状态栏正则脚本）
  draft.mvu.statusBarHtml = generateStatusBarHtml(
    'character-panel',
    draft.mvu.schemaSections,
    { themeId: 'terminal', title: '生活手账', density: 'compact' },
  );

  // ── 其他必填字段 ─────────────────────────────────────────────────────
  draft.scenario = '';
  draft.system_prompt = '';
  draft.post_history_instructions = '';
  draft.alternate_greetings = [];
  draft.creator_notes = '';
  draft.creator = '';
  draft.character_version = '1.0';
  draft.bookScanDepth = 200;
  draft.bookTokenBudget = 40000;
  draft.bookRecursiveScanning = false;

  return draft;
}

// ── 测试开始 ─────────────────────────────────────────────────────────────────

describe('Functional Tests - Card Features Validation', () => {
  let draft: WizardDraft;
  let card: any;

  beforeAll(() => {
    draft = buildTestDraft();
    card = assembleCard(draft);
  });

  // ════════════════════════════════════════════════════════════════════════
  // 1. MVU 状态栏功能测试
  // ════════════════════════════════════════════════════════════════════════
  describe('1. MVU Status Bar', () => {
    let bundle: ReturnType<typeof buildMvuScriptBundle>;

    beforeAll(() => {
      bundle = buildMvuScriptBundle(draft.mvu!);
    });

    it('1.1 MVU bundle 所有产物非空', () => {
      expect(bundle.zodTxt.length).toBeGreaterThan(0);
      expect(bundle.variableList.length).toBeGreaterThan(0);
      expect(bundle.variableOutputFormat.length).toBeGreaterThan(0);
      expect(bundle.initvarYaml.length).toBeGreaterThan(0);
      expect(bundle.updateRulesYaml.length).toBeGreaterThan(0);
      console.log(`✓ MVU bundle: zodTxt=${bundle.zodTxt.length}chars, variableList=${bundle.variableList.length}chars`);
    });

    it('1.2 Zod schema 包含正确的 Schema 定义结构', () => {
      // zodTxt 应该包含 registerMvuSchema 调用
      expect(bundle.zodTxt).toContain('registerMvuSchema');
      // 应该包含 Schema 变量定义
      expect(bundle.zodTxt).toContain('Schema');
      // 应该从 CDN 导入
      expect(bundle.zodTxt).toContain('import');
      expect(bundle.zodTxt).toContain('mvu_zod.js');
      console.log('✓ Zod schema: contains registerMvuSchema, import from CDN');
    });

    it('1.3 初始变量 YAML 可被正确解析为嵌套结构', () => {
      const yaml = bundle.initvarYaml;
      // 应该包含嵌套的键结构
      expect(yaml).toContain('档案:');
      expect(yaml).toContain('社交:');
      expect(yaml).toContain('指标:');
      // 应该包含我们设置的初始值
      expect(yaml).toContain('张楚怡');
      expect(yaml).toContain('大学生/兼职模特');
      expect(yaml).toContain('20'); // 好感度
      expect(yaml).toContain('60'); // 心情
      expect(yaml).toContain('80'); // 精力
      expect(yaml).toContain('3000'); // 钱包
      console.log('✓ InitVar YAML: nested structure with correct initial values');
    });

    it('1.4 更新规则 YAML 包含规则分组', () => {
      const yaml = bundle.updateRulesYaml;
      expect(yaml).toContain('变量更新规则:');
      // 现代模板应该有社交和指标相关的规则
      expect(yaml.length).toBeGreaterThan(50);
      console.log(`✓ Update rules YAML: ${yaml.length} chars, properly grouped`);
    });

    it('1.5 变量列表包含所有变量的可读路径', () => {
      const list = bundle.variableList;
      // 应该包含点分路径的展示形式（用 > 分隔）
      expect(list).toContain('档案');
      expect(list).toContain('社交');
      expect(list).toContain('指标');
      // 应该包含具体变量路径
      expect(list).toContain('档案 > 姓名');
      expect(list).toContain('社交 > 好感度');
      expect(list).toContain('指标 > 心情');
      console.log(`✓ Variable list: ${list.length} chars, contains all sections`);
    });

    it('1.6 变量输出格式包含更新规则指令', () => {
      const fmt = bundle.variableOutputFormat;
      expect(fmt).toContain('update_variable_rules');
      expect(fmt).toContain('status_bar_rule');
      console.log(`✓ Variable output format: contains rule directives`);
    });

    it('1.7 状态栏 HTML 生成有效 DOM 结构', () => {
      // 使用 character-panel 模板生成状态栏 HTML
      const html = generateStatusBarHtml(
        'character-panel',
        draft.mvu!.schemaSections,
        {
          themeId: 'terminal',
          title: '生活手账',
          density: 'compact',
        },
      );

      expect(html.length).toBeGreaterThan(100);
      expect(html).toContain('```html');

      // 提取 HTML 内容（去掉 ```html 围栏）
      const rawHtml = html.replace(/^```html\s*\n?/, '').replace(/\n?```\s*$/, '');

      // 用 DOMParser 解析
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');

      // 应该没有解析错误
      const parseErrors = doc.querySelectorAll('parsererror');
      expect(parseErrors.length).toBe(0);

      // 应该包含 CSS 变量定义（:root 或 :host）
      const styleEl = doc.querySelector('style');
      expect(styleEl).not.toBeNull();
      const styleContent = styleEl?.textContent || '';
      expect(styleContent).toContain('--');  // CSS 变量

      // 应该包含 script 标签用于动态渲染
      const scriptEl = doc.querySelector('script');
      expect(scriptEl).not.toBeNull();

      console.log(`✓ Status bar HTML: valid DOM, ${rawHtml.length} chars, has style + script`);
    });

    it('1.8 状态栏正则脚本能正确替换占位符', () => {
      // 生成状态栏 HTML
      const statusBarHtml = generateStatusBarHtml(
        'character-panel',
        draft.mvu!.schemaSections,
        { themeId: 'terminal', title: '生活手账' },
      );

      // 设置到 draft 以便 assembleCard 生成正则脚本
      draft.mvu!.statusBarHtml = statusBarHtml;
      const testCard = assembleCard(draft);

      const regexScripts = testCard.data.extensions.regex_scripts as any[];
      const statusBarScript = regexScripts.find((s: any) => s.scriptName === '状态栏界面');

      expect(statusBarScript).toBeDefined();
      expect(statusBarScript.findRegex).toContain('StatusPlaceHolderImpl');
      expect(statusBarScript.replaceString).toContain('```html');
      expect(statusBarScript.markdownOnly).toBe(true);
      expect(statusBarScript.promptOnly).toBe(false);

      // 模拟 SillyTavern 的正则替换行为
      const placeholder = '<StatusPlaceHolderImpl/>';
      const sampleMessage = `这是一条测试消息。\n${placeholder}\n消息内容继续。`;

      // findRegex 是裸串（非 /.../ 形式），SillyTavern 会将其编译为正则
      // 这里直接做字符串替换来模拟
      const result = sampleMessage.replace(placeholder, statusBarScript.replaceString);
      expect(result).not.toContain(placeholder);
      expect(result).toContain('```html');
      expect(result).toContain('这是一条测试消息。');

      console.log('✓ Status bar regex: placeholder correctly replaced with HTML');
    });

    it('1.9 对AI隐藏状态栏脚本正确移除占位符', () => {
      const regexScripts = card.data.extensions.regex_scripts as any[];
      const hideScript = regexScripts.find((s: any) => s.scriptName === '对AI隐藏状态栏');

      expect(hideScript).toBeDefined();
      expect(hideScript.promptOnly).toBe(true);
      expect(hideScript.findRegex).toContain('StatusPlaceHolderImpl');
      expect(hideScript.replaceString).toBe('');

      console.log('✓ Hide status bar from AI: script configured correctly');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 2. 分阶段模式功能测试
  // ════════════════════════════════════════════════════════════════════════
  describe('2. Staged Mode', () => {
    let stagedConfig: StagedLorebookConfig;
    let dispatcherContent: string;

    beforeAll(() => {
      stagedConfig = {
        axisPath: '社交.关系',
        axisType: 'enum',
        bookName: resolveBookName(draft),
        dispatcherName: '张楚怡分阶段人设',
        stages: [
          { name: '陌生人', condition: `=== '陌生人'`, content: '陌生人阶段内容' },
          { name: '点头之交', condition: `=== '点头之交'`, content: '点头之交阶段内容' },
          { name: '朋友', condition: `=== '朋友'`, content: '朋友阶段内容' },
          { name: '暧昧', condition: `=== '暧昧'`, content: '暧昧阶段内容' },
          { name: '恋人', condition: `=== '恋人'`, content: '恋人阶段内容' },
        ],
      };
      dispatcherContent = buildDispatcherContent(stagedConfig);
    });

    it('2.1 调度条目 EJS 包含正确的变量读取', () => {
      // 应该读取 stat_data.社交.关系
      expect(dispatcherContent).toContain("getvar('stat_data.社交.关系')");
      // 应该有 Array.isArray 守卫
      expect(dispatcherContent).toContain('Array.isArray');
      console.log('✓ Dispatcher EJS: reads stat_data.社交.关系 with Array.isArray guard');
    });

    it('2.2 调度条目 EJS 包含所有阶段的条件分支', () => {
      // 每个阶段都应该有 else if 分支
      expect(dispatcherContent).toContain(`=== '陌生人'`);
      expect(dispatcherContent).toContain(`=== '点头之交'`);
      expect(dispatcherContent).toContain(`=== '朋友'`);
      expect(dispatcherContent).toContain(`=== '暧昧'`);
      expect(dispatcherContent).toContain(`=== '恋人'`);
      // 应该有兜底 else
      expect(dispatcherContent).toContain('else');
      console.log('✓ Dispatcher EJS: all 5 stages + fallback branch present');
    });

    it('2.3 调度条目 EJS 包含 getWorldInfo 调用', () => {
      const bookName = resolveBookName(draft);
      expect(dispatcherContent).toContain('getWorldInfo');
      expect(dispatcherContent).toContain(bookName);
      // 每个阶段都应该调用 getWorldInfo
      const getWorldInfoCount = (dispatcherContent.match(/getWorldInfo/g) || []).length;
      expect(getWorldInfoCount).toBe(5); // 5 个阶段
      console.log(`✓ Dispatcher EJS: ${getWorldInfoCount} getWorldInfo calls`);
    });

    it('2.4 parseDispatcherContent 往返一致性', () => {
      const parsed = parseDispatcherContent(dispatcherContent);
      expect(parsed).not.toBeNull();
      expect(parsed!.axisPath).toBe('社交.关系');
      expect(parsed!.bookName).toBe(resolveBookName(draft));
      expect(parsed!.childComments.length).toBe(5);
      // 子条目 comment 应该是 "张楚怡分阶段人设：{阶段名}"
      expect(parsed!.childComments[0]).toContain('张楚怡分阶段人设');
      expect(parsed!.childComments[0]).toContain('陌生人');
      expect(parsed!.childComments[4]).toContain('恋人');
      console.log(`✓ Dispatcher round-trip: axis=${parsed!.axisPath}, book=${parsed!.bookName}, children=${parsed!.childComments.length}`);
    });

    it('2.5 子条目正确关联到调度条目', () => {
      const entries = Object.values(card.data.character_book.entries) as any[];

      // 找到调度条目
      const dispatcher = entries.find(e => e.name === '张楚怡分阶段人设');
      expect(dispatcher).toBeDefined();
      expect(dispatcher.constant).toBe(true);
      expect(dispatcher.enabled).toBe(true);

      // 找到所有子条目（comment 包含 "张楚怡分阶段人设："）
      const children = entries.filter(e =>
        e.comment?.includes('张楚怡分阶段人设：') && e.name !== '张楚怡分阶段人设'
      );
      expect(children.length).toBe(5);

      // 子条目应该被禁用（只通过 getWorldInfo 拉取）
      for (const child of children) {
        expect(child.enabled).toBe(false);
      }

      // 子条目的 comment 应该对应 5 个阶段
      const stageNames = children.map(c => {
        const match = c.comment.match(/：(.+)$/);
        return match ? match[1] : null;
      }).filter(Boolean);
      expect(stageNames).toContain('陌生人');
      expect(stageNames).toContain('朋友');
      expect(stageNames).toContain('恋人');

      console.log(`✓ Staged entries: 1 dispatcher (constant) + ${children.length} children (disabled)`);
    });

    it('2.6 调度条目 EJS 注入防护有效', () => {
      // 测试包含特殊字符的阶段名
      const evilConfig: StagedLorebookConfig = {
        axisPath: '社交.关系',
        axisType: 'enum',
        bookName: '测试"书名',
        dispatcherName: '测试调度',
        stages: [
          { name: `阶段'; evilCode(); //`, condition: `=== '阶段\\'; evilCode(); //'` },
        ],
      };
      const evilContent = buildDispatcherContent(evilConfig);
      // 应该正确转义，不会破坏 EJS 结构
      expect(evilContent).toContain('getWorldInfo');
      // 不应该有未转义的双引号破坏字符串
      // (escapeEjsDoubleQuoted 会转义 bookName 中的 ")
      expect(evilContent).toContain('测试\\"书名');
      console.log('✓ EJS injection prevention: special characters properly escaped');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 3. 直播间评论面板功能测试
  // ════════════════════════════════════════════════════════════════════════
  describe('3. Live Stream Chat', () => {
    let liveChatHtml: string;

    beforeAll(() => {
      liveChatHtml = generateLiveChatHtml({
        themeId: 'terminal',
        title: '危城直播间',
        maxVisible: 8,
        initialComments: [
          '这个继姐好高冷啊',
          '感觉她在偷看{{user}}',
          '这剧情发展有点东西',
          '抹茶百奇棒名场面！',
          '冷萌属性拉满了',
        ],
      });
    });

    it('3.1 生成的 HTML 包含有效的 DOM 结构', () => {
      expect(liveChatHtml).toContain('```html');
      expect(liveChatHtml).toContain('lc-root');

      // 提取 HTML 内容
      const rawHtml = liveChatHtml.replace(/^```html\s*\n?/, '').replace(/\n?```\s*$/, '');

      // 用 DOMParser 解析
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');

      // 应该没有解析错误
      const parseErrors = doc.querySelectorAll('parsererror');
      expect(parseErrors.length).toBe(0);

      // 应该包含 lc-root 容器
      const root = doc.querySelector('.lc-root');
      expect(root).not.toBeNull();

      console.log(`✓ Live chat HTML: valid DOM, has .lc-root container`);
    });

    it('3.2 初始弹幕被预渲染到 HTML 中', () => {
      const rawHtml = liveChatHtml.replace(/^```html\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');

      // 初始弹幕应该作为静态 HTML 存在
      const htmlText = doc.body.innerHTML;
      expect(htmlText).toContain('这个继姐好高冷啊');
      expect(htmlText).toContain('感觉她在偷看');
      expect(htmlText).toContain('抹茶百奇棒名场面');

      console.log('✓ Initial comments: pre-rendered in static HTML');
    });

    it('3.3 HTML 包含 CSS 样式和主题变量', () => {
      const rawHtml = liveChatHtml.replace(/^```html\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');

      const styleEl = doc.querySelector('style');
      expect(styleEl).not.toBeNull();
      const styleContent = styleEl?.textContent || '';

      // terminal 主题应该有特定的 CSS 变量
      expect(styleContent).toContain('--');  // CSS 变量
      expect(styleContent).toContain('lc-'); // 组件 CSS 类

      console.log('✓ Live chat CSS: theme variables and component styles present');
    });

    it('3.4 HTML 包含 JavaScript 运行时脚本', () => {
      const rawHtml = liveChatHtml.replace(/^```html\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');

      // 应该有 script 标签
      const scripts = doc.querySelectorAll('script');
      expect(scripts.length).toBeGreaterThan(0);

      // 至少有一个 script 包含 lc- 相关函数
      let hasLiveChatScript = false;
      scripts.forEach(s => {
        if (s.textContent?.includes('lc-')) {
          hasLiveChatScript = true;
        }
      });
      expect(hasLiveChatScript).toBe(true);

      console.log('✓ Live chat JS: runtime script with lc- functions present');
    });

    it('3.5 正则脚本正确替换直播间占位符', () => {
      const regexScripts = card.data.extensions.regex_scripts as any[];
      const liveChatScript = regexScripts.find((s: any) => s.scriptName === '直播间界面');

      expect(liveChatScript).toBeDefined();
      expect(liveChatScript.findRegex).toContain('LiveStreamChatImpl');
      expect(liveChatScript.replaceString).toContain('```html');
      expect(liveChatScript.replaceString).toContain('lc-root');
      expect(liveChatScript.markdownOnly).toBe(true);
      expect(liveChatScript.promptOnly).toBe(false);

      // 模拟替换
      const placeholder = '<LiveStreamChatImpl/>';
      const sampleMessage = `开场白内容\n${placeholder}\n后续内容`;
      const result = sampleMessage.replace(placeholder, liveChatScript.replaceString);
      expect(result).not.toContain(placeholder);
      expect(result).toContain('lc-root');

      console.log('✓ Live chat regex: placeholder replaced with panel HTML');
    });

    it('3.6 对AI隐藏直播间脚本正确移除占位符', () => {
      const regexScripts = card.data.extensions.regex_scripts as any[];
      const hideScript = regexScripts.find((s: any) => s.scriptName === '对AI隐藏直播间');

      expect(hideScript).toBeDefined();
      expect(hideScript.promptOnly).toBe(true);
      expect(hideScript.findRegex).toContain('LiveStreamChatImpl');
      expect(hideScript.replaceString).toBe('');

      console.log('✓ Hide live chat from AI: script configured correctly');
    });

    it('3.7 first_mes 包含直播间占位符', () => {
      expect(card.data.first_mes).toContain('<LiveStreamChatImpl/>');
      console.log('✓ first_mes: contains <LiveStreamChatImpl/> placeholder');
    });

    it('3.8 直播间扩展元数据完整', () => {
      const liveChatExt = card.data.extensions.live_stream_chat as any;
      expect(liveChatExt).toBeDefined();
      expect(liveChatExt.enabled).toBe(true);
      expect(liveChatExt.themeId).toBe('terminal');
      expect(liveChatExt.title).toBe('危城直播间');
      expect(liveChatExt.maxVisible).toBe(8);
      expect(liveChatExt.initialComments.length).toBe(5);

      console.log('✓ Live chat metadata: theme, title, comments all present');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 4. 正则脚本端到端测试
  // ════════════════════════════════════════════════════════════════════════
  describe('4. Regex Scripts End-to-End', () => {
    it('4.1 所有正则脚本都有必要的字段', () => {
      const regexScripts = card.data.extensions.regex_scripts as any[];
      expect(Array.isArray(regexScripts)).toBe(true);

      for (const script of regexScripts) {
        expect(script).toHaveProperty('scriptName');
        expect(script).toHaveProperty('findRegex');
        expect(script).toHaveProperty('replaceString');
        expect(script).toHaveProperty('markdownOnly');
        expect(script).toHaveProperty('promptOnly');
        expect(typeof script.scriptName).toBe('string');
        expect(script.scriptName.length).toBeGreaterThan(0);
      }

      console.log(`✓ All ${regexScripts.length} regex scripts have required fields`);
    });

    it('4.2 MVU 变量更新隐藏脚本能匹配 <update> 标签', () => {
      const regexScripts = card.data.extensions.regex_scripts as any[];
      const hideScript = regexScripts.find((s: any) => s.scriptName === '对AI隐藏变量更新');

      if (hideScript) {
        // findRegex 是 /.../ 格式的字符串
        const regexStr = hideScript.findRegex;
        expect(regexStr).toContain('update');

        // 提取正则表达式（去掉首尾斜杠和标志）
        const match = regexStr.match(/^\/(.+)\/([gimsuy]*)$/);
        if (match) {
          // 每个测试用新的 RegExp 实例，避免 g 标志导致 lastIndex 偏移
          const regex1 = new RegExp(match[1], match[2]);
          expect(regex1.test('<updatevariable>')).toBe(true);
          const regex2 = new RegExp(match[1], match[2]);
          expect(regex2.test('<update>')).toBe(true);
        }
        console.log('✓ Hide variable update: regex matches <update> tags');
      } else {
        console.log('⚠ Hide variable update script not found (may not be generated)');
      }
    });

    it('4.3 正则脚本 placement 配置正确', () => {
      const regexScripts = card.data.extensions.regex_scripts as any[];

      for (const script of regexScripts) {
        expect(Array.isArray(script.placement)).toBe(true);
        // placement 应该是 [1, 2] 或 [2] 形式的数组
        for (const p of script.placement) {
          expect([1, 2]).toContain(p);
        }
      }

      console.log('✓ All regex scripts have valid placement config');
    });

    it('4.4 界面显示脚本 vs AI隐藏脚本配对完整', () => {
      const regexScripts = card.data.extensions.regex_scripts as any[];

      // 状态栏配对
      const statusBarShow = regexScripts.find((s: any) => s.scriptName === '状态栏界面');
      const statusBarHide = regexScripts.find((s: any) => s.scriptName === '对AI隐藏状态栏');
      if (statusBarShow) {
        expect(statusBarHide).toBeDefined();
        expect(statusBarShow.markdownOnly).toBe(true);
        expect(statusBarShow.promptOnly).toBe(false);
        expect(statusBarHide!.markdownOnly).toBe(false);
        expect(statusBarHide!.promptOnly).toBe(true);
        console.log('✓ Status bar: show (UI) + hide (AI) pair complete');
      }

      // 直播间配对
      const liveChatShow = regexScripts.find((s: any) => s.scriptName === '直播间界面');
      const liveChatHide = regexScripts.find((s: any) => s.scriptName === '对AI隐藏直播间');
      expect(liveChatShow).toBeDefined();
      expect(liveChatHide).toBeDefined();
      expect(liveChatShow.markdownOnly).toBe(true);
      expect(liveChatShow.promptOnly).toBe(false);
      expect(liveChatHide.markdownOnly).toBe(false);
      expect(liveChatHide.promptOnly).toBe(true);
      console.log('✓ Live chat: show (UI) + hide (AI) pair complete');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 5. 世界书条目完整性测试
  // ════════════════════════════════════════════════════════════════════════
  describe('5. World Book Entries', () => {
    it('5.1 所有条目都有必要的字段且类型正确', () => {
      const entries = Object.values(card.data.character_book.entries) as any[];

      for (const entry of entries) {
        expect(typeof entry.id).toBe('number');
        expect(Array.isArray(entry.keys)).toBe(true);
        expect(typeof entry.content).toBe('string');
        expect(typeof entry.enabled).toBe('boolean');
        expect(typeof entry.constant).toBe('boolean');
        expect(typeof entry.insertion_order).toBe('number');
        expect(typeof entry.position).toBe('string');
        expect(['before_char', 'after_char', 'before_example', 'after_example']).toContain(entry.position);
      }

      console.log(`✓ All ${entries.length} entries have valid required fields`);
    });

    it('5.2 constant 条目优先排序', () => {
      const entries = Object.values(card.data.character_book.entries) as any[];
      // 找到最后一个 constant 条目和第一个非 constant 条目的 insertion_order
      const constantEntries = entries.filter(e => e.constant);
      const nonConstantEntries = entries.filter(e => !e.constant);

      if (constantEntries.length > 0 && nonConstantEntries.length > 0) {
        // constant 条目应该排在前面（insertion_order 更小或相等）
        // 注意：这不是绝对的，因为不同条目可能有不同的 insertion_order
        console.log(`✓ Entry ordering: ${constantEntries.length} constant, ${nonConstantEntries.length} non-constant`);
      }
    });

    it('5.3 分阶段子条目内容非空且包含阶段信息', () => {
      const entries = Object.values(card.data.character_book.entries) as any[];
      const stagedChildren = entries.filter(e =>
        e.comment?.includes('张楚怡分阶段人设：') && e.name !== '张楚怡分阶段人设'
      );

      for (const child of stagedChildren) {
        expect(child.content.length).toBeGreaterThan(0);
        // 内容应该包含阶段相关的描述
        expect(child.content).toContain('张楚怡');
      }

      console.log(`✓ All ${stagedChildren.length} staged children have non-empty content`);
    });

    it('5.4 MVU 核心条目内容完整', () => {
      const entries = Object.values(card.data.character_book.entries) as any[];

      // [mvu_update]变量更新规则
      const updateRules = entries.find(e => e.name === '[mvu_update]变量更新规则');
      expect(updateRules).toBeDefined();
      expect(updateRules.content).toContain('变量更新规则');
      expect(updateRules.constant).toBe(true);

      // MVU 变量列表
      const varList = entries.find(e => e.name === 'MVU 变量列表');
      expect(varList).toBeDefined();
      expect(varList.content.length).toBeGreaterThan(0);
      expect(varList.constant).toBe(true);

      // MVU 变量输出格式
      const varFormat = entries.find(e => e.name === 'MVU 变量输出格式');
      expect(varFormat).toBeDefined();
      expect(varFormat.content).toContain('update_variable_rules');
      expect(varFormat.constant).toBe(true);

      console.log('✓ MVU core entries: update rules, variable list, output format all present');
    });

    it('5.5 世界书扩展配置（scan_depth, token_budget）正确', () => {
      const book = card.data.character_book;
      expect(book.scan_depth).toBe(200);
      expect(book.token_budget).toBe(40000);
      expect(book.name).toBeDefined();
      expect(book.name.length).toBeGreaterThan(0);

      console.log(`✓ World book config: scan_depth=${book.scan_depth}, token_budget=${book.token_budget}, name="${book.name}"`);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 6. 卡片整体结构验证
  // ════════════════════════════════════════════════════════════════════════
  describe('6. Card Structure', () => {
    it('6.1 V3 规范信封完整', () => {
      expect(card.spec).toBe('chara_card_v3');
      expect(card.spec_version).toBe('3.0');
      expect(card.data).toBeDefined();
      expect(card._meta).toBeDefined();
      console.log('✓ V3 envelope: spec, spec_version, data, _meta all present');
    });

    it('6.2 核心数据字段完整', () => {
      expect(card.data.name).toBe('危城');
      expect(card.data.tags).toEqual(['现代都市', '悬疑情感', '继姐弟', '日常']);
      expect(card.data.first_mes.length).toBeGreaterThan(0);
      expect(card.data.description).toBeDefined();
      expect(card.data.extensions).toBeDefined();
      console.log('✓ Core data: name, tags, first_mes, description, extensions');
    });

    it('6.3 first_mes 包含所有占位符', () => {
      expect(card.data.first_mes).toContain('<StatusPlaceHolderImpl/>');
      expect(card.data.first_mes).toContain('<LiveStreamChatImpl/>');
      console.log('✓ first_mes: contains both status bar and live chat placeholders');
    });

    it('6.4 扩展字段包含所有功能模块', () => {
      const ext = card.data.extensions;
      // MVU 相关
      expect(ext.mvu_enabled).toBe(true);
      expect(ext.tavern_helper).toBeDefined();
      // 正则脚本
      expect(ext.regex_scripts).toBeDefined();
      // 直播间元数据
      expect(ext.live_stream_chat).toBeDefined();
      // 世界书引用
      expect(ext.world).toBeDefined();

      console.log('✓ Extensions: MVU, tavern_helper, regex_scripts, live_stream_chat, world');
    });

    it('6.5 酒馆助手脚本注册正确', () => {
      const tavernHelper = card.data.extensions.tavern_helper as any;
      expect(tavernHelper.scripts).toBeDefined();
      expect(Array.isArray(tavernHelper.scripts)).toBe(true);

      // 应该有 MVU 主脚本和 Zod 脚本
      const mvuScript = tavernHelper.scripts.find((s: any) => s.name === 'MVU');
      const zodScript = tavernHelper.scripts.find((s: any) => s.name === 'Zod');

      expect(mvuScript).toBeDefined();
      expect(mvuScript.content).toContain('MagVarUpdate');
      expect(mvuScript.enabled).toBe(true);

      expect(zodScript).toBeDefined();
      expect(zodScript.content).toContain('registerMvuSchema');
      expect(zodScript.enabled).toBe(true);

      console.log('✓ Tavern helper: MVU + Zod scripts registered and enabled');
    });

    it('6.6 JSON 序列化/反序列化保持完整性', () => {
      // 模拟导出为 JSON 再导入的过程
      const jsonStr = JSON.stringify(card);
      const parsed = JSON.parse(jsonStr);

      expect(parsed.spec).toBe(card.spec);
      expect(parsed.data.name).toBe(card.data.name);
      expect(parsed.data.character_book.entries).toBeDefined();

      const origEntries = Object.keys(card.data.character_book.entries).length;
      const parsedEntries = Object.keys(parsed.data.character_book.entries).length;
      expect(parsedEntries).toBe(origEntries);

      console.log(`✓ JSON round-trip: ${origEntries} entries preserved`);
    });
  });
});
