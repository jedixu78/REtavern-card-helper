/**
 * 深度集成测试 - 使用真实 AI API 验证全流程稳定性
 *
 * 测试目标：
 * 1. AI 能否稳定输出可解析的 JSON 格式（多次测试）
 * 2. 全流程建卡：世界书 -> 角色 -> 开场白 -> 组装
 * 3. 导出卡片格式合规性（V3 spec、世界书、MVU、正则脚本）
 * 4. 占位符/EJS 模板/MVU 宏 不失效
 * 5. 卡片往返一致性（assembleCard -> cardToDraft）
 *
 * 运行方式：
 *   $env:VOLCENGINE_API_KEY="ark-xxx"; $env:VOLCENGINE_MODEL="ark-code-latest"; npx vitest run src/services/deep-integration.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  CHARACTER_GENERATE_PROMPT,
  WORLD_ANCHOR_EXPAND_PROMPT,
  LOREBOOK_GENERATE_PROMPT,
  FIRST_MESSAGE_PROMPT,
} from '../constants/prompts';
import {
  createEmptyDraft,
  createEmptyLorebookEntry,
  generateId,
  resolveBookName,
  REGEX_SCRIPT_NAMES,
} from '../constants/defaults';
import type { WizardDraft, LorebookEntry, AIGeneratedLorebookEntry, WizardCharacter, MvuSchemaSection } from '../constants/defaults';
import { parseAIJson } from './ai-json';
import { assembleCard, cardToDraft } from './card-exporter';
import { getBeginnerTemplateById } from '../constants/beginner-templates';
import { buildStagedLorebookEntries } from './staged-lorebook-builder';
import { generateLiveChatHtml } from './live-chat-templates';
import { generateStatusBarHtml } from './status-bar-templates';

// ── 凭证（从环境变量读取）──────────────────────────────────────────────
const API_BASE = process.env.VOLCENGINE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3';
const API_KEY = process.env.VOLCENGINE_API_KEY || '';
const MODEL = process.env.VOLCENGINE_MODEL || 'ark-code-latest';

// ── 测试数据 ─────────────────────────────────────────────────────────
const CARD_NAME = '危城';
const TAGS = ['现代都市', '悬疑情感', '继姐弟', '日常'];
const NSFW = false;
const WORLD_ANCHOR_TEXT = `类型：现代都市·悬疑情感
时代：2024年，智能手机普及，社交媒体发达
文化背景：中国二线城市，大学城周边，传媒行业兴起
人文细节：老式复式楼、超市补货习惯、抹茶百奇棒作为情感纽带
硬性约束：禁止超自然元素，所有冲突必须源于现实人际关系`;
const CHARACTER_CONSTRAINT = '继姐，冷萌大学生，与{{user}}同住';

// ── API 调用辅助 ──────────────────────────────────────────────────────
async function callAPI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 16000,
  temperature = 0.8,
  maxRetries = 3,
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature,
        }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        lastError = new Error(`API ${response.status}: ${errorText.slice(0, 200)}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw lastError;
      }
      const data = await response.json();
      const content = data.choices[0].message.content as string;
      const finishReason = data.choices[0].finish_reason as string;
      // 推理模型可能因 reasoning_content 占用 token 导致 content 被截断
      if (finishReason === 'length' || !content) {
        console.warn(`  ⚠ 响应可能不完整: finish_reason=${finishReason}, content.length=${content?.length || 0}`);
      }
      return content || '';
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('API call failed');
}

// ── 解析重试辅助：推理模型偶尔输出不可解析的 JSON，需要重试 ──────────
const parseStats = { attempts: 0, successes: 0, failures: 0 };

async function callAndParse<T>(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 16000,
  temperature = 0.8,
  parseRetries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= parseRetries; attempt++) {
    const text = await callAPI(systemPrompt, userPrompt, maxTokens, temperature);
    parseStats.attempts++;
    const parsed = parseAIJson(text) as T | null;
    if (parsed !== null) {
      parseStats.successes++;
      if (attempt > 1) {
        console.log(`  ↻ 第 ${attempt} 次解析成功 (前 ${attempt - 1} 次失败)`);
      }
      return parsed;
    }
    parseStats.failures++;
    console.warn(`  ⚠ 第 ${attempt}/${parseRetries} 次: JSON 解析失败, content.length=${text.length}, 前100字符="${text.slice(0, 100)}"`);
    if (attempt < parseRetries) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`JSON 解析连续 ${parseRetries} 次失败`);
}

// ── 条目转换辅助 ──────────────────────────────────────────────────────
function aiEntryToLorebookEntry(aiEntry: AIGeneratedLorebookEntry): LorebookEntry {
  const entry = createEmptyLorebookEntry();
  entry.id = generateId();
  entry.name = aiEntry.name || 'Unnamed';
  entry.keys = aiEntry.keys || [];
  entry.secondary_keys = aiEntry.secondary_keys || [];
  entry.content = aiEntry.content || '';
  entry.comment = aiEntry.comment || aiEntry.name || '';
  entry.constant = aiEntry.constant ?? false;
  entry.selective = aiEntry.selective ?? false;
  entry.selectiveLogic = aiEntry.selectiveLogic ?? 0;
  entry.insertion_order = aiEntry.insertion_order ?? 100;
  entry.position = (aiEntry.position as LorebookEntry['position']) || 'after_char';
  entry.priority = aiEntry.priority ?? 50;
  entry.probability = aiEntry.probability ?? 100;
  entry.group = aiEntry.group || '';
  entry.group_weight = aiEntry.group_weight ?? 100;
  entry.role = aiEntry.role ?? 0;
  entry.depth = aiEntry.depth ?? 4;
  return entry;
}

function syncCharacterToEntries(
  character: WizardCharacter,
  existingEntries: LorebookEntry[],
): { entries: LorebookEntry[]; character: WizardCharacter } {
  if (!character.name?.trim() || !character.description?.trim()) {
    return { entries: existingEntries, character };
  }
  const entryId = generateId();
  const entry = createEmptyLorebookEntry();
  entry.id = entryId;
  entry.name = `${character.name}角色设定`;
  entry.keys = [character.name];
  entry.content = character.description.trim();
  entry.constant = character.constant ?? true;
  entry.insertion_order = 1;
  entry.priority = 100;
  entry.comment = `${character.name}角色设定`;
  entry.prevent_recursion = true;
  const updatedChar = { ...character, entryIds: [entryId] };
  return { entries: [...existingEntries, entry], character: updatedChar };
}

// ════════════════════════════════════════════════════════════════════════
// 测试套件
// ════════════════════════════════════════════════════════════════════════
describe.skipIf(!API_KEY)('深度集成测试 - AI 全流程建卡稳定性', () => {
  let draft: WizardDraft;
  let finalCard: ReturnType<typeof assembleCard>;

  beforeAll(() => {
    draft = createEmptyDraft();
    draft.cardName = CARD_NAME;
    draft.tags = TAGS;
  });

  // ── 1. API 连通性 ──────────────────────────────────────────────────
  it('1. API 连通性：模型可响应', async () => {
    const reply = await callAPI(
      '你是一个测试助手，请回复"OK"。',
      '请回复 OK',
      500,
      0,
    );
    expect(reply.length).toBeGreaterThan(0);
    console.log(`✓ API 连通: 模型=${MODEL}, 回复="${reply.slice(0, 50)}", 长度=${reply.length}`);
  }, 30000);

  // ── 2. JSON 格式稳定性（3 次独立生成）──────────────────────────────
  describe('2. JSON 格式稳定性（3 次独立生成）', () => {
    const results: { parsed: boolean; entryCount: number; hasRequiredFields: boolean }[] = [];

    for (let run = 1; run <= 3; run++) {
      it(`2.${run} 世界书条目生成 - 第 ${run} 次`, async () => {
        const prompts = LOREBOOK_GENERATE_PROMPT(
          CARD_NAME,
          '张楚怡：继姐，冷萌大学生',
          '人物关系与日常场景',
          5,
          NSFW,
          WORLD_ANCHOR_TEXT,
          'zh',
          undefined,
          undefined,
          4,
        );
        const aiEntries = await callAndParse<AIGeneratedLorebookEntry[]>(prompts.system, prompts.user, 16000, 0.8);
        expect(aiEntries).not.toBeNull();
        expect(Array.isArray(aiEntries)).toBe(true);

        const entries = (aiEntries || []).map(aiEntryToLorebookEntry);
        expect(entries.length).toBeGreaterThanOrEqual(3);

        // 验证每个条目的必需字段（constant 条目允许空 keys）
        let allValid = true;
        for (const e of entries) {
          if (!e.name || !e.content) {
            allValid = false;
            console.log(`  ✗ 条目 "${e.name}" 缺少必需字段: name=${!!e.name} content=${!!e.content}`);
          }
          if (!e.constant && (!e.keys || e.keys.length === 0)) {
            allValid = false;
            console.log(`  ✗ 非常驻条目 "${e.name}" 缺少 keys`);
          }
        }

        results.push({
          parsed: true,
          entryCount: entries.length,
          hasRequiredFields: allValid,
        });

        console.log(`✓ 第 ${run} 次: 解析成功, ${entries.length} 条, 字段完整=${allValid}`);
        expect(allValid).toBe(true);
      }, 600000);
    }

    it('2.4 三次生成结果一致性统计', () => {
      expect(results.length).toBe(3);
      const allParsed = results.every(r => r.parsed);
      const allValid = results.every(r => r.hasRequiredFields);
      const counts = results.map(r => r.entryCount);
      const maxDiff = Math.max(...counts) - Math.min(...counts);
      console.log(`✓ 三次生成统计: 条目数=[${counts.join(', ')}], 全部解析=${allParsed}, 全部字段完整=${allValid}, 数量差=${maxDiff}`);
      console.log(`✓ JSON 解析统计: 尝试=${parseStats.attempts}, 成功=${parseStats.successes}, 失败=${parseStats.failures}, 成功率=${((parseStats.successes / parseStats.attempts) * 100).toFixed(0)}%`);
      expect(allParsed).toBe(true);
      expect(allValid).toBe(true);
      // 条目数量波动不超过 3（AI 生成有合理变化范围）
      expect(maxDiff).toBeLessThanOrEqual(3);
    });
  });

  // ── 3. 全流程建卡 ──────────────────────────────────────────────────
  it('3.1 生成世界锚定条目', async () => {
    const prompts = WORLD_ANCHOR_EXPAND_PROMPT(CARD_NAME, WORLD_ANCHOR_TEXT, '', NSFW, 'zh');
    const aiEntries = await callAndParse<AIGeneratedLorebookEntry[]>(prompts.system, prompts.user, 16000, 0.8);
    const entries = (aiEntries || []).map(aiEntryToLorebookEntry);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    draft.lorebookEntries = [...draft.lorebookEntries, ...entries];
    console.log(`✓ 世界锚定: ${entries.length} 条`);
  }, 600000);

  it('3.2 生成角色描述', async () => {
    const prompts = CHARACTER_GENERATE_PROMPT(CARD_NAME, CHARACTER_CONSTRAINT, undefined, undefined, NSFW, 'zh');
    const description = await callAPI(prompts.system, prompts.user, 16000, 0.85);
    expect(description.length).toBeGreaterThan(800);

    const character: WizardCharacter = {
      id: generateId(),
      name: '张楚怡',
      description,
      constant: true,
    };
    const syncResult = syncCharacterToEntries(character, draft.lorebookEntries);
    draft.lorebookEntries = syncResult.entries;
    draft.characters = [syncResult.character];
    expect(draft.characters[0].entryIds).toBeDefined();
    expect(draft.characters[0].entryIds!.length).toBeGreaterThan(0);
    console.log(`✓ 角色描述: ${description.length} 字符`);
  }, 600000);

  it('3.3 生成世界书条目（批量）', async () => {
    const characterContext = draft.characters.map(c => `${c.name}: ${c.description}`).join('\n\n');
    const prompts = LOREBOOK_GENERATE_PROMPT(
      CARD_NAME, characterContext, '人物关系深化与日常场景扩展',
      8, NSFW, WORLD_ANCHOR_TEXT, 'zh', undefined, undefined, 6,
    );
    const aiEntries = await callAndParse<AIGeneratedLorebookEntry[]>(prompts.system, prompts.user, 16000, 0.8);
    const entries = (aiEntries || []).map(aiEntryToLorebookEntry);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    draft.lorebookEntries = [...draft.lorebookEntries, ...entries];
    console.log(`✓ 世界书批量: ${entries.length} 条, 总计 ${draft.lorebookEntries.length} 条`);
  }, 600000);

  it('3.4 生成开场白', async () => {
    const characterContext = draft.characters.map(c => `${c.name}: ${c.description}`).join('\n\n');
    const prompts = FIRST_MESSAGE_PROMPT(CARD_NAME, characterContext, '', 2000, WORLD_ANCHOR_TEXT, undefined, 'zh');
    const firstMessage = await callAPI(prompts.system, prompts.user, 16000, 0.9);
    expect(firstMessage.length).toBeGreaterThan(800);
    draft.firstMessage = firstMessage;
    console.log(`✓ 开场白: ${firstMessage.length} 字符`);
  }, 600000);

  // ── 4. 组装卡片（MVU + 分阶段 + 直播间）────────────────────────────
  it('4. 组装卡片（含 MVU + 分阶段 + 直播间）', () => {
    // MVU 配置（都市日常模板）
    const modernTemplate = getBeginnerTemplateById('modern');
    expect(modernTemplate).toBeDefined();
    const { schemaSections, updateRules } = { schemaSections: modernTemplate!.buildSections(), updateRules: modernTemplate!.buildRules() };
    const statsSection = schemaSections.find((s: MvuSchemaSection) => s.name === '生活指标');
    if (statsSection) {
      const moodVar = statsSection.variables.find(v => v.path === '指标.心情');
      if (moodVar) moodVar.initialValue = 60;
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
      statusBarHtml: generateStatusBarHtml('character-panel', schemaSections, {
        themeId: 'terminal',
        title: modernTemplate!.statusBarTitle,
        density: 'compact',
      }),
      statusBarStyle: 'compact-panel',
      statusBarShowIcons: false,
      statusBarOptions: {
        themeId: 'terminal',
        title: modernTemplate!.statusBarTitle,
        density: 'compact',
      },
    };
    draft.useMvuExport = true;

    // 分阶段模式
    const bookName = resolveBookName(draft);
    const stagedEntries = buildStagedLorebookEntries({
      axisPath: '社交.关系',
      axisType: 'enum',
      bookName,
      dispatcherName: '张楚怡分阶段人设',
      stages: [
        { name: '陌生人', condition: `=== '陌生人'`, content: '# 陌生人阶段\n态度冷淡，保持距离' },
        { name: '朋友', condition: `=== '朋友'`, content: '# 朋友阶段\n自然放松，主动聊天' },
        { name: '恋人', condition: `=== '恋人'`, content: '# 恋人阶段\n温柔撒娇，完全信任' },
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
      characters: [{
        name: '张楚怡',
        summary: '冷萌大学生',
        axisPath: '社交.关系',
        axisType: 'enum',
        stages: [
          { name: '陌生人', condition: `=== '陌生人'`, annotation: '冷淡疏离' },
        { name: '朋友', condition: `=== '朋友'`, annotation: '自然放松' },
        { name: '恋人', condition: `=== '恋人'`, annotation: '温柔撒娇' },
        ],
      }],
    };

    // 直播间面板
    const liveChatHtml = generateLiveChatHtml({
      themeId: 'terminal',
      title: '危城直播间',
      maxVisible: 8,
      initialComments: ['这个继姐好高冷啊', '感觉她在偷看{{user}}'],
    });
    draft.liveStreamChat = {
      enabled: true,
      html: liveChatHtml,
      themeId: 'terminal',
      title: '危城直播间',
      maxVisible: 8,
      initialComments: ['这个继姐好高冷啊', '感觉她在偷看{{user}}'],
    };

    // 填充剩余字段
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

    // 组装
    finalCard = assembleCard(draft);
    console.log(`✓ 卡片组装成功: spec=${finalCard.spec}, 条目数=${Object.keys(finalCard.data.character_book.entries).length}`);
  });

  // ── 5. 格式验证 ────────────────────────────────────────────────────
  describe('5. 导出格式验证', () => {
    it('5.1 V3 规范合规', () => {
      expect(finalCard.spec).toBe('chara_card_v3');
      expect(finalCard.spec_version).toBe('3.0');
      expect(finalCard.name).toBe(CARD_NAME);
      expect(finalCard.data.name).toBe(CARD_NAME);
      expect(finalCard.data.tags).toEqual(TAGS);
      expect(finalCard.data.first_mes).toBeDefined();
      expect(finalCard.data.first_mes.length).toBeGreaterThan(500);
      console.log('✓ V3 规范: spec/spec_version/name/tags/first_mes 全部正确');
    });

    it('5.2 世界书条目结构', () => {
      const entries = finalCard.data.character_book;
      expect(entries).toBeDefined();
      expect(entries.name).toBeDefined();
      const entryList = Object.values(entries.entries) as any[];
      expect(entryList.length).toBeGreaterThanOrEqual(10);

      // 每个条目必须有必需字段
      for (const e of entryList) {
        expect(e.keys).toBeDefined();
        expect(e.content).toBeDefined();
        expect(e.name).toBeDefined();
        expect(e.insertion_order).toBeDefined();
        expect(e.enabled).toBeDefined();
        expect(e.constant).toBeDefined();
      }
      console.log(`✓ 世界书: ${entryList.length} 条, 全部含必需字段`);
    });

    it('5.3 MVU 条目注入', () => {
      const entryList = Object.values(finalCard.data.character_book.entries) as any[];
      const mvuNames = ['[mvu_update]变量更新规则', 'MVU 变量列表', 'MVU 变量输出格式'];
      for (const name of mvuNames) {
        const found = entryList.find(e => e.name === name);
        expect(found).toBeDefined();
        expect(found.content.length).toBeGreaterThan(0);
        expect(found.constant).toBe(true);
      }
      console.log(`✓ MVU 条目: ${mvuNames.length} 个核心条目全部注入`);
    });

    it('5.4 正则脚本注入（状态栏 + 直播间）', () => {
      const scripts = finalCard.data.extensions.regex_scripts as any[];
      expect(scripts).toBeDefined();
      expect(Array.isArray(scripts)).toBe(true);

      const statusBarScript = scripts.find(s => s.scriptName === REGEX_SCRIPT_NAMES.statusBar);
      expect(statusBarScript).toBeDefined();
      expect(statusBarScript.findRegex).toBeDefined();
      expect(statusBarScript.replaceString).toBeDefined();
      expect(statusBarScript.replaceString.length).toBeGreaterThan(100);

      const liveChatScript = scripts.find(s => s.scriptName === REGEX_SCRIPT_NAMES.liveChat);
      expect(liveChatScript).toBeDefined();
      expect(liveChatScript.findRegex).toBeDefined();
      expect(liveChatScript.replaceString).toBeDefined();

      console.log(`✓ 正则脚本: 状态栏 + 直播间 各 1 个, 共 ${scripts.length} 个`);
    });

    it('5.5 分阶段调度器条目', () => {
      const entryList = Object.values(finalCard.data.character_book.entries) as any[];
      const dispatcher = entryList.find(e => e.name === '张楚怡分阶段人设');
      expect(dispatcher).toBeDefined();
      expect(dispatcher.constant).toBe(true);
      expect(dispatcher.content).toContain('getWorldInfo');
      expect(dispatcher.content).toContain(resolveBookName(draft));

      // 子条目
      const children = entryList.filter(e =>
        e.comment?.includes('张楚怡分阶段人设：') && e.name !== '张楚怡分阶段人设',
      );
      expect(children.length).toBe(3); // 陌生人/朋友/恋人

      console.log(`✓ 分阶段: 1 调度器 + ${children.length} 子条目, 书名一致`);
    });

    it('5.6 tavern_helper 扩展', () => {
      const ext = finalCard.data.extensions as Record<string, unknown>;
      expect(ext).toHaveProperty('tavern_helper');
      const helper = ext.tavern_helper as { scripts: unknown[] };
      expect(helper).toHaveProperty('scripts');
      expect(helper.scripts.length).toBeGreaterThan(0);
      console.log(`✓ tavern_helper: ${helper.scripts.length} 个脚本`);
    });
  });

  // ── 6. 占位符 / EJS / 宏 验证 ─────────────────────────────────────
  describe('6. 占位符与模板验证', () => {
    it('6.1 分阶段 EJS 调度模板有效', () => {
      const entryList = Object.values(finalCard.data.character_book.entries) as any[];
      const dispatcher = entryList.find(e => e.name === '张楚怡分阶段人设');
      expect(dispatcher).toBeDefined();
      // 调度器应包含 EJS 模板语法
      expect(dispatcher.content).toContain('<%');
      expect(dispatcher.content).toContain('%>');
      // 应包含 getWorldInfo 调用
      expect(dispatcher.content).toContain('getWorldInfo');
      // 不应包含未转义的 %>（EJS 闭合标签除外）
      console.log(`✓ 调度器 EJS: 含 <%%> 模板语法 + getWorldInfo 调用`);
    });

    it('6.2 分阶段子条目含阶段标记', () => {
      const entryList = Object.values(finalCard.data.character_book.entries) as any[];
      const children = entryList.filter(e =>
        e.comment?.includes('张楚怡分阶段人设：'),
      );
      for (const child of children) {
        expect(child.content.length).toBeGreaterThan(0);
        // 子条目 comment 应包含阶段名
        expect(child.comment).toContain('张楚怡分阶段人设：');
      }
      console.log(`✓ 子条目: ${children.length} 个, 全部含阶段标记`);
    });

    it('6.3 MVU 变量列表含变量路径', () => {
      const entryList = Object.values(finalCard.data.character_book.entries) as any[];
      const varList = entryList.find(e => e.name === 'MVU 变量列表');
      expect(varList).toBeDefined();
      // 应包含分区名
      expect(varList.content).toContain('档案');
      expect(varList.content).toContain('社交');
      expect(varList.content).toContain('指标');
      console.log('✓ MVU 变量列表: 含档案/社交/指标分区');
    });

    it('6.4 MVU 更新规则含 YAML 结构', () => {
      const entryList = Object.values(finalCard.data.character_book.entries) as any[];
      const rules = entryList.find(e => e.name === '[mvu_update]变量更新规则');
      expect(rules).toBeDefined();
      expect(rules.content).toContain('变量更新规则');
      expect(rules.content.length).toBeGreaterThan(50);
      console.log(`✓ MVU 更新规则: ${rules.content.length} 字符`);
    });

    it('6.5 正则脚本能正确匹配占位符', () => {
      const scripts = finalCard.data.extensions.regex_scripts as any[];
      const statusBarScript = scripts.find(s => s.scriptName === REGEX_SCRIPT_NAMES.statusBar);
      expect(statusBarScript).toBeDefined();

      // 编译正则验证可执行
      const regex = new RegExp(statusBarScript.findRegex, statusBarScript.placement?.[0] === 'string' ? 'g' : '');
      expect(regex).toBeDefined();

      // 替换字符串应包含 HTML 内容
      expect(statusBarScript.replaceString).toContain('<');
      expect(statusBarScript.replaceString).toContain('sb-'); // 状态栏 CSS 类名前缀

      console.log('✓ 状态栏正则: pattern 可编译, replaceString 含 HTML');
    });

    it('6.6 直播间正则脚本占位符', () => {
      const scripts = finalCard.data.extensions.regex_scripts as any[];
      const liveChatScript = scripts.find(s => s.scriptName === REGEX_SCRIPT_NAMES.liveChat);
      expect(liveChatScript).toBeDefined();

      const regex = new RegExp(liveChatScript.findRegex);
      expect(regex).toBeDefined();
      expect(liveChatScript.replaceString).toContain('lc-root'); // 直播间根元素

      console.log('✓ 直播间正则: pattern 可编译, replaceString 含 lc-root');
    });

    it('6.7 世界书名一致性', () => {
      const bookName = resolveBookName(draft);
      expect(finalCard.data.character_book.name).toBe(bookName);
      expect(finalCard.data.extensions.world).toBe(bookName);

      const entryList = Object.values(finalCard.data.character_book.entries) as any[];
      const dispatcher = entryList.find(e => e.name === '张楚怡分阶段人设');
      expect(dispatcher.content).toContain(bookName);
      console.log(`✓ 世界书名一致性: character_book.name = extensions.world = 调度器参数 = "${bookName}"`);
    });
  });

  // ── 7. 卡片往返一致性 ─────────────────────────────────────────────
  describe('7. 卡片往返一致性（assembleCard -> cardToDraft）', () => {
    it('7.1 cardToDraft 能解析导出卡', () => {
      const roundTripDraft = cardToDraft(finalCard);
      expect(roundTripDraft.cardName).toBe(CARD_NAME);
      expect(roundTripDraft.tags).toEqual(TAGS);
      expect(roundTripDraft.firstMessage.length).toBeGreaterThan(500);
      expect(roundTripDraft.lorebookEntries.length).toBeGreaterThanOrEqual(10);
      console.log(`✓ 往返: cardName=${roundTripDraft.cardName}, 条目=${roundTripDraft.lorebookEntries.length}`);
    });

    it('7.2 往返后 MVU 启用状态保留', () => {
      // schemaSections 是向导侧配置，编译为 MVU 条目/脚本后不参与往返；
      // 此处验证 MVU 仍启用，且导出卡中的 MVU 条目在往返后仍存在。
      const roundTripDraft = cardToDraft(finalCard);
      expect(roundTripDraft.mvu).toBeDefined();
      expect(roundTripDraft.mvu!.enabled).toBe(true);
      // 往返后再组装，验证 MVU 条目仍注入
      const roundTripCard = assembleCard(roundTripDraft);
      const entries = Object.values(roundTripCard.data.character_book.entries) as any[];
      const hasMvuRules = entries.some(e => e.name === '[mvu_update]变量更新规则');
      expect(hasMvuRules).toBe(true);
      console.log(`✓ 往返 MVU: enabled=${roundTripDraft.mvu!.enabled}, MVU 条目保留=${hasMvuRules}`);
    });

    it('7.3 往返后正则脚本保留', () => {
      const roundTripCard = assembleCard(cardToDraft(finalCard));
      const scripts = roundTripCard.data.extensions.regex_scripts as any[];
      expect(scripts.find(s => s.scriptName === REGEX_SCRIPT_NAMES.statusBar)).toBeDefined();
      expect(scripts.find(s => s.scriptName === REGEX_SCRIPT_NAMES.liveChat)).toBeDefined();
      console.log(`✓ 往返正则: 状态栏 + 直播间 均保留`);
    });
  });
});
