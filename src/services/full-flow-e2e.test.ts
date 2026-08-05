/**
 * 端到端全流程模拟测试
 * 
 * 模拟真实用户从 Step 1 到 Step 9 的完整制卡流程：
 * - Step 1: 卡片名称 + 标签
 * - Step 2: 世界观锚定（AI 生成总纲 + 子条目）
 * - Step 3: 角色创建（AI 生成角色描述）
 * - Step 4: 世界书批量生成（多批次，目标 20-30 条）
 * - Step 5: MVU 变量（都市日常模板，4分区13变量+7规则）
 * - Step 6: 分阶段模式（5阶段关系轴，调度+子条目）
 * - Step 7: 开场白生成
 * - Step 8: 直播间面板（terminal主题，初始弹幕）
 * - Step 9: 组装卡牌 + 验证导出（含MVU/分阶段/直播间验证）
 * 
 * 验证目标：
 * - 世界书条目数量与正常卡一致（20-30+）
 * - MVU 条目正确注入（EJS预处理/更新规则/变量列表/输出格式）
 * - 分阶段条目正确注入（1调度+5子条目）
 * - 直播间正则脚本正确注入（显示+隐藏）
 * - 导出的卡牌结构符合 SillyTavern V2/V3 规范
 * - 各字段完整、类型正确
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  CHARACTER_GENERATE_PROMPT,
  WORLD_ANCHOR_EXPAND_PROMPT,
  LOREBOOK_GENERATE_PROMPT,
  FIRST_MESSAGE_PROMPT,
} from '../constants/prompts';
import { createEmptyDraft, createEmptyLorebookEntry, generateId, resolveBookName } from '../constants/defaults';
import type { WizardDraft, LorebookEntry, AIGeneratedLorebookEntry, WizardCharacter } from '../constants/defaults';
import { parseAIJson } from './ai-json';
import { assembleCard } from './card-exporter';
import { getBeginnerTemplateById } from '../constants/beginner-templates';
import { buildStagedLorebookEntries } from './staged-lorebook-builder';
import { generateLiveChatHtml } from './live-chat-templates';

// Volcengine Ark API configuration
const VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const VOLCENGINE_API_KEY = (import.meta.env.VOLCENGINE_API_KEY as string) || '';
const TEST_MODEL = 'deepseek-v4-flash';

async function callVolcengineAPI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 8000,
  temperature = 0.8,
  maxRetries = 3,
): Promise<string> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${VOLCENGINE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${VOLCENGINE_API_KEY}`,
        },
        body: JSON.stringify({
          model: TEST_MODEL,
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
        lastError = new Error(`API request failed: ${response.status} ${errorText}`);
        console.warn(`API call attempt ${attempt}/${maxRetries} failed: ${response.status}`);
        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          continue;
        }
        throw lastError;
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        console.warn(`API call attempt ${attempt}/${maxRetries} threw error, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        continue;
      }
    }
  }
  
  throw lastError || new Error('API call failed after all retries');
}

// Helper: Convert AI-generated entry to LorebookEntry format
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
  entry.position = (aiEntry.position as any) || 'after_char';
  entry.priority = aiEntry.priority ?? 50;
  entry.probability = aiEntry.probability ?? 100;
  entry.group = aiEntry.group || '';
  entry.group_weight = aiEntry.group_weight ?? 100;
  entry.role = aiEntry.role ?? 0;
  entry.depth = aiEntry.depth ?? 4;
  entry.exclude_recursion = aiEntry.exclude_recursion ?? false;
  entry.prevent_recursion = aiEntry.prevent_recursion ?? false;
  entry.sticky = aiEntry.sticky ?? 0;
  entry.cooldown = aiEntry.cooldown ?? 0;
  entry.delay = aiEntry.delay ?? 0;
  entry.use_regex = aiEntry.use_regex ?? false;
  entry.match_whole_words = aiEntry.match_whole_words ?? true;
  entry.ignore_budget = aiEntry.ignore_budget ?? false;
  return entry;
}

// Helper: Sync character descriptions to lorebook entries (simplified version of syncCharacterEntries)
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

// ── 测试数据 ─────────────────────────────────────────────────────────
const CARD_NAME = '危城';
const TAGS = ['现代都市', '悬疑情感', '继姐弟', '日常'];
const NSFW = false;

const WORLD_ANCHOR = {
  type: '现代都市·悬疑情感',
  era: '2024年，智能手机普及，社交媒体发达',
  culture: '中国二线城市，大学城周边，传媒行业兴起',
  humanity: '老式复式楼、超市补货习惯、抹茶百奇棒作为情感纽带',
  constraints: '禁止超自然元素，所有冲突必须源于现实人际关系',
};

const WORLD_ANCHOR_TEXT = `类型：${WORLD_ANCHOR.type}
时代：${WORLD_ANCHOR.era}
文化背景：${WORLD_ANCHOR.culture}
人文细节：${WORLD_ANCHOR.humanity}
硬性约束：${WORLD_ANCHOR.constraints}`;

const CHARACTER_CONSTRAINT = '继姐，冷萌大学生，与{{user}}同住';

describe.skipIf(!VOLCENGINE_API_KEY)('End-to-End Full Flow Simulation (Step 1-9)', () => {
  let draft: WizardDraft;
  let finalCard: any;

  beforeAll(() => {
    // Initialize empty draft (Step 0)
    draft = createEmptyDraft();
  }, 10000);

  it('Step 1: Set card name and tags', () => {
    draft.cardName = CARD_NAME;
    draft.tags = TAGS;
    
    expect(draft.cardName).toBe(CARD_NAME);
    expect(draft.tags).toEqual(TAGS);
    console.log(`✓ Step 1: Card name="${CARD_NAME}", tags=[${TAGS.join(', ')}]`);
  });

  it('Step 2: Generate world anchor entries', async () => {
    const prompts = WORLD_ANCHOR_EXPAND_PROMPT(CARD_NAME, WORLD_ANCHOR_TEXT, '', NSFW, 'zh');
    const text = await callVolcengineAPI(prompts.system, prompts.user, 8000, 0.8);
    
    const aiEntries = parseAIJson(text) as AIGeneratedLorebookEntry[] | null;
    expect(aiEntries).not.toBeNull();
    expect(Array.isArray(aiEntries)).toBe(true);
    
    if (aiEntries) {
      // Convert AI entries to LorebookEntry format
      const anchorEntries = aiEntries.map(aiEntryToLorebookEntry);
      draft.lorebookEntries = [...draft.lorebookEntries, ...anchorEntries];
      
      console.log(`✓ Step 2: Generated ${anchorEntries.length} world anchor entries`);
      console.log(`  - First entry: "${anchorEntries[0]?.name}" (constant=${anchorEntries[0]?.constant})`);
      expect(anchorEntries.length).toBeGreaterThanOrEqual(3);
    }
  }, 180000);

  it('Step 3: Generate character description', async () => {
    const prompts = CHARACTER_GENERATE_PROMPT(CARD_NAME, CHARACTER_CONSTRAINT, undefined, undefined, NSFW, 'zh');
    const description = await callVolcengineAPI(prompts.system, prompts.user, 12000, 0.85);
    
    expect(description.length).toBeGreaterThan(1000);
    
    // Create character
    const character: WizardCharacter = {
      id: generateId(),
      name: '张楚怡',
      description: description,
      constant: true,
    };
    
    draft.characters = [character];
    
    // Sync character to lorebook entries (like WizardPage does)
    const syncResult = syncCharacterToEntries(character, draft.lorebookEntries);
    draft.lorebookEntries = syncResult.entries;
    draft.characters = [syncResult.character];
    
    console.log(`✓ Step 3: Generated character "${character.name}" (${description.length} chars)`);
    console.log(`  - Synced to lorebook entry: "${draft.lorebookEntries[draft.lorebookEntries.length - 1]?.name}"`);
    expect(draft.characters[0].entryIds).toBeDefined();
    expect(draft.characters[0].entryIds!.length).toBeGreaterThan(0);
  }, 180000);

  it('Step 4: Generate world book entries (multiple batches, target 20-30)', async () => {
    const characterContext = draft.characters.map(c => `${c.name}: ${c.description}`).join('\n\n');
    const topic = '人物关系深化与日常场景扩展';
    let totalGenerated = 0;
    
    // Batch 1: Core world entries (8 entries)
    try {
      console.log('  Generating batch 1 (core entries)...');
      const batch1Prompts = LOREBOOK_GENERATE_PROMPT(
        CARD_NAME,
        characterContext,
        topic,
        8, // batchCount
        NSFW,
        WORLD_ANCHOR_TEXT,
        'zh',
        undefined,
        undefined,
        6, // minBatchCount
      );
      const batch1Text = await callVolcengineAPI(batch1Prompts.system, batch1Prompts.user, 12000, 0.8);
      const batch1Entries = parseAIJson(batch1Text) as AIGeneratedLorebookEntry[] | null;
      
      if (batch1Entries) {
        const converted = batch1Entries.map(aiEntryToLorebookEntry);
        draft.lorebookEntries = [...draft.lorebookEntries, ...converted];
        totalGenerated += converted.length;
        console.log(`  ✓ Batch 1: ${converted.length} entries`);
      }
    } catch (err) {
      console.warn(`  ⚠ Batch 1 failed: ${(err as Error).message}`);
    }
    
    // Batch 2: Additional entries (8 entries) - with existing context
    try {
      console.log('  Generating batch 2 (additional entries)...');
      const existingContext = draft.lorebookEntries
        .map(e => `- ${e.name}: keys=[${e.keys.join(', ')}], constant=${e.constant}, ${e.content.slice(0, 100)}...`)
        .join('\n');
      
      const batch2Prompts = LOREBOOK_GENERATE_PROMPT(
        CARD_NAME,
        characterContext,
        '地点、物品、经济系统、社会规则',
        8, // batchCount
        NSFW,
        WORLD_ANCHOR_TEXT,
        'zh',
        existingContext,
        undefined,
        6, // minBatchCount
      );
      const batch2Text = await callVolcengineAPI(batch2Prompts.system, batch2Prompts.user, 12000, 0.8);
      const batch2Entries = parseAIJson(batch2Text) as AIGeneratedLorebookEntry[] | null;
      
      if (batch2Entries) {
        const converted = batch2Entries.map(aiEntryToLorebookEntry);
        draft.lorebookEntries = [...draft.lorebookEntries, ...converted];
        totalGenerated += converted.length;
        console.log(`  ✓ Batch 2: ${converted.length} entries`);
      }
    } catch (err) {
      console.warn(`  ⚠ Batch 2 failed: ${(err as Error).message}`);
    }
    
    // Batch 3: Final entries (8 entries) - relationship and event focus
    try {
      console.log('  Generating batch 3 (relationship & events)...');
      const existingContext2 = draft.lorebookEntries
        .map(e => `- ${e.name}: keys=[${e.keys.join(', ')}], ${e.content.slice(0, 80)}...`)
        .join('\n');
      
      const batch3Prompts = LOREBOOK_GENERATE_PROMPT(
        CARD_NAME,
        characterContext,
        '关系网络、历史事件、能力体系',
        8, // batchCount
        NSFW,
        WORLD_ANCHOR_TEXT,
        'zh',
        existingContext2,
        undefined,
        6, // minBatchCount
      );
      const batch3Text = await callVolcengineAPI(batch3Prompts.system, batch3Prompts.user, 12000, 0.8);
      const batch3Entries = parseAIJson(batch3Text) as AIGeneratedLorebookEntry[] | null;
      
      if (batch3Entries) {
        const converted = batch3Entries.map(aiEntryToLorebookEntry);
        draft.lorebookEntries = [...draft.lorebookEntries, ...converted];
        totalGenerated += converted.length;
        console.log(`  ✓ Batch 3: ${converted.length} entries`);
      }
    } catch (err) {
      console.warn(`  ⚠ Batch 3 failed: ${(err as Error).message}`);
    }
    
    // Update draft with worldbook topic and batch count
    draft.worldbookTopic = topic;
    draft.worldbookBatchCount = 8;
    
    console.log(`✓ Step 4: Total ${draft.lorebookEntries.length} lorebook entries (${totalGenerated} generated in this step)`);
    console.log(`  - Constant entries: ${draft.lorebookEntries.filter(e => e.constant).length}`);
    console.log(`  - Keyword-triggered entries: ${draft.lorebookEntries.filter(e => !e.constant).length}`);
    
    // Should have at least 10 entries (anchor + character + some generated)
    // Target is 20-30 but API failures may reduce this
    expect(draft.lorebookEntries.length).toBeGreaterThanOrEqual(10);
  }, 600000); // 10 minutes for 3 batches

  it('Step 5: MVU variables (modern template)', () => {
    // Use the "modern" (都市日常) beginner template — matches our card theme
    const modernTemplate = getBeginnerTemplateById('modern');
    expect(modernTemplate).toBeDefined();
    
    const schemaSections = modernTemplate!.buildSections();
    const updateRules = modernTemplate!.buildRules();
    
    // Fill in some initial values to simulate AI-generated content
    // 人物档案
    const profileSection = schemaSections.find(s => s.name === '人物档案');
    expect(profileSection).toBeDefined();
    const nameVar = profileSection!.variables.find(v => v.path === '档案.姓名');
    if (nameVar) nameVar.initialValue = '张楚怡';
    const jobVar = profileSection!.variables.find(v => v.path === '档案.职业');
    if (jobVar) jobVar.initialValue = '大学生/兼职模特';
    const personalityVar = profileSection!.variables.find(v => v.path === '档案.性格');
    if (personalityVar) personalityVar.initialValue = '外冷内热，嘴硬心软，表面高冷实则容易害羞';
    const secretVar = profileSection!.variables.find(v => v.path === '档案.秘密');
    if (secretVar) secretVar.initialValue = ' secretly has a crush on {{user}} but would never admit it';
    
    // 社交关系
    const socialSection = schemaSections.find(s => s.name === '社交关系');
    expect(socialSection).toBeDefined();
    const affinityVar = socialSection!.variables.find(v => v.path === '社交.好感度');
    if (affinityVar) affinityVar.initialValue = 20;
    const relationVar = socialSection!.variables.find(v => v.path === '社交.关系');
    if (relationVar) relationVar.initialValue = '点头之交';
    
    // 生活指标
    const statsSection = schemaSections.find(s => s.name === '生活指标');
    expect(statsSection).toBeDefined();
    const moodVar = statsSection!.variables.find(v => v.path === '指标.心情');
    if (moodVar) moodVar.initialValue = 60;
    const energyVar = statsSection!.variables.find(v => v.path === '指标.精力');
    if (energyVar) energyVar.initialValue = 80;
    const walletVar = statsSection!.variables.find(v => v.path === '指标.钱包');
    if (walletVar) walletVar.initialValue = 3000;
    
    // Apply to draft
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
        title: modernTemplate!.statusBarTitle,
        density: 'compact',
      },
    };
    draft.useMvuExport = true;
    
    console.log(`✓ Step 5: MVU enabled with modern template`);
    console.log(`  - Schema sections: ${schemaSections.length}`);
    console.log(`  - Total variables: ${schemaSections.reduce((sum, s) => sum + s.variables.length, 0)}`);
    console.log(`  - Update rules: ${updateRules.length}`);
    console.log(`  - Status bar title: "${modernTemplate!.statusBarTitle}"`);
    
    expect(draft.mvu.enabled).toBe(true);
    expect(schemaSections.length).toBe(4);
    expect(updateRules.length).toBeGreaterThan(0);
  });

  it('Step 6: Staged mode (relationship stages)', () => {
    // Configure staged mode for the main character's relationship axis
    const bookName = resolveBookName(draft);
    const dispatcherName = '张楚怡分阶段人设';
    
    // Build staged lorebook entries using the relationship enum axis
    const stagedEntries = buildStagedLorebookEntries({
      axisPath: '社交.关系',
      axisType: 'enum',
      bookName,
      dispatcherName,
      stages: [
        {
          name: '陌生人',
          condition: `=== '陌生人'`,
          content: `# 张楚怡 — 陌生人阶段
- 态度：冷淡、疏离、礼貌但保持距离
- 对话风格：简短回复，不主动展开话题
- 行为：避免眼神接触，做自己的事
- 内心：对{{user}}好奇但防备心强`,
        },
        {
          name: '点头之交',
          condition: `=== '点头之交'`,
          content: `# 张楚怡 — 点头之交阶段
- 态度：稍微放松，偶尔主动搭话
- 对话风格：会回应玩笑，但不会深入
- 行为：偶尔分享零食，开始记住{{user}}的习惯
- 内心：觉得{{user}}还不错，但不想表现得太明显`,
        },
        {
          name: '朋友',
          condition: `=== '朋友'`,
          content: `# 张楚怡 — 朋友阶段
- 态度：自然、放松，会吐槽和开玩笑
- 对话风格：话变多，会主动找{{user}}聊天
- 行为：一起吃饭、逛街，分享日常琐事
- 内心：开始依赖{{user}}的陪伴，但否认有特殊感情`,
        },
        {
          name: '暧昧',
          condition: `=== '暧昧'`,
          content: `# 张楚怡 — 暧昧阶段
- 态度：害羞、嘴硬，明明在意却装作无所谓
- 对话风格：会脸红、结巴，偶尔说出真心话又立刻否认
- 行为：开始在意{{user}}的看法，偷偷打扮
- 内心：已经喜欢上{{user}}，但害怕被拒绝不敢表白`,
        },
        {
          name: '恋人',
          condition: `=== '恋人'`,
          content: `# 张楚怡 — 恋人阶段
- 态度：温柔、撒娇，偶尔展现出依赖的一面
- 对话风格：甜蜜、直接表达感情，会叫昵称
- 行为：牵手、拥抱，主动分享内心想法
- 内心：完全信任{{user}}，愿意展现脆弱的一面`,
        },
      ],
      position: 'after_char',
      dispatcherOrder: 150,
      childOrder: 151,
    });
    
    // Add staged entries to lorebookEntries
    draft.lorebookEntries = [...draft.lorebookEntries, ...stagedEntries];
    
    // Configure staged mode on draft
    draft.stagedMode = {
      enabled: true,
      templateId: 'pure-love',
      dispatcherPrefix: '分阶段人设',
      characters: [
        {
          name: '张楚怡',
          summary: '冷萌大学生，{{user}}的继姐',
          axisPath: '社交.关系',
          axisType: 'enum',
          stages: [
            { name: '陌生人', condition: `=== '陌生人'`, annotation: '冷淡疏离，保持距离' },
            { name: '点头之交', condition: `=== '点头之交'`, annotation: '稍微放松，偶尔互动' },
            { name: '朋友', condition: `=== '朋友'`, annotation: '自然放松，主动交流' },
            { name: '暧昧', condition: `=== '暧昧'`, annotation: '害羞嘴硬，暗藏心意' },
            { name: '恋人', condition: `=== '恋人'`, annotation: '温柔撒娇，展现依赖' },
          ],
        },
      ],
    };
    
    console.log(`✓ Step 6: Staged mode enabled`);
    console.log(`  - Dispatcher: "${dispatcherName}"`);
    console.log(`  - Axis: 社交.关系 (enum)`);
    console.log(`  - Stages: ${stagedEntries.length - 1} (1 dispatcher + ${stagedEntries.length - 1} children)`);
    console.log(`  - Total staged entries added: ${stagedEntries.length}`);
    
    expect(stagedEntries.length).toBe(6); // 1 dispatcher + 5 stages
    expect(stagedEntries[0].constant).toBe(true);
    expect(stagedEntries[0].enabled).toBe(true);
    expect(stagedEntries[0].content).toContain('getWorldInfo');
    // Child entries should be disabled (pulled by getWorldInfo only)
    expect(stagedEntries[1].enabled).toBe(false);
    expect(stagedEntries[1].constant).toBe(false);
  });

  it('Step 7: Generate first message', async () => {
    const characterDescriptions = draft.characters.map(c => c.description).join('\n\n');
    const sceneHint = '周六早晨，{{user}}在客厅拼高达模型';
    
    const prompts = FIRST_MESSAGE_PROMPT(
      CARD_NAME,
      characterDescriptions,
      sceneHint,
      1500, // targetWordCount
      undefined, // worldbookContext
      undefined, // writingRequirements
      'zh',
    );
    
    const firstMessage = await callVolcengineAPI(prompts.system, prompts.user, 12000, 0.9);
    
    expect(firstMessage.length).toBeGreaterThan(1000);
    draft.firstMessage = firstMessage;
    
    console.log(`✓ Step 7: Generated first message (${firstMessage.length} chars)`);
  }, 180000);

  it('Step 8: Live stream chat panel', () => {
    // Generate live chat HTML using the template system
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
    
    expect(liveChatHtml.length).toBeGreaterThan(500);
    expect(liveChatHtml).toContain('```html');
    expect(liveChatHtml).toContain('lc-root');
    
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
    
    console.log(`✓ Step 8: Live stream chat enabled`);
    console.log(`  - Theme: terminal`);
    console.log(`  - Title: "危城直播间"`);
    console.log(`  - Initial comments: 5`);
    console.log(`  - HTML length: ${liveChatHtml.length} chars`);
    
    expect(draft.liveStreamChat.enabled).toBe(true);
    expect(draft.liveStreamChat.html).toContain('lc-root');
  });

  it('Step 9: Assemble card and validate export', () => {
    // Set remaining required fields
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
    
    // Assemble the card
    finalCard = assembleCard(draft);
    
    console.log('✓ Step 9: Card assembled successfully');
    console.log(`  - spec: ${finalCard.spec}`);
    console.log(`  - spec_version: ${finalCard.spec_version}`);
    console.log(`  - name: ${finalCard.name}`);
    console.log(`  - character_book.entries: ${Object.keys(finalCard.data.character_book.entries).length}`);
    console.log(`  - first_mes length: ${finalCard.data.first_mes.length}`);
    console.log(`  - tags: [${finalCard.data.tags.join(', ')}]`);
    
    // Validate card structure
    expect(finalCard.spec).toBe('chara_card_v3');
    expect(finalCard.spec_version).toBe('3.0');
    expect(finalCard.name).toBe(CARD_NAME);
    expect(finalCard.data.name).toBe(CARD_NAME);
    expect(finalCard.data.tags).toEqual(TAGS);
    expect(finalCard.data.first_mes).toBeDefined();
    expect(finalCard.data.first_mes.length).toBeGreaterThan(1000);
    
    // Validate character_book
    expect(finalCard.data.character_book).toBeDefined();
    expect(finalCard.data.character_book.name).toBeDefined();
    expect(finalCard.data.character_book.entries).toBeDefined();
    
    const entries = finalCard.data.character_book.entries;
    const entryList = Object.values(entries) as any[];
    const entryCount = entryList.length;
    expect(entryCount).toBeGreaterThanOrEqual(15); // At least 15 entries (target 20-30 + MVU + staged)
    
    // ── Validate MVU entries ──────────────────────────────────────────────
    // These entries are always created when MVU is enabled with schema sections
    const mvuEntryNames = [
      '[mvu_update]变量更新规则',
      'MVU 变量列表',
      'MVU 变量输出格式',
    ];
    for (const name of mvuEntryNames) {
      const found = entryList.find((e: any) => e.name === name);
      expect(found).toBeDefined();
      if (found) {
        expect(found.content.length).toBeGreaterThan(0);
        expect(found.constant).toBe(true);
      }
    }
    // EJS预处理 is only created when ejsConfigs is non-empty (we have none)
    // [InitVar]请勿打开 is created as disabled fallback
    console.log(`  - MVU entries: ${mvuEntryNames.length} core entries found`);
    
    // Validate MVU extensions (scripts)
    const extensions = finalCard.data.extensions;
    expect(extensions).toHaveProperty('tavern_helper');
    const tavernHelper = extensions.tavern_helper as any;
    expect(tavernHelper).toHaveProperty('scripts');
    // Should have schema.ts content
    expect(tavernHelper.scripts).toBeDefined();
    
    // ── Validate staged entries ───────────────────────────────────────────
    const stagedDispatcher = entryList.find((e: any) => e.name === '张楚怡分阶段人设');
    expect(stagedDispatcher).toBeDefined();
    if (stagedDispatcher) {
      expect(stagedDispatcher.constant).toBe(true);
      expect(stagedDispatcher.enabled).toBe(true);
      expect(stagedDispatcher.content).toContain('getWorldInfo');
      expect(stagedDispatcher.content).toContain('社交.关系');
    }
    
    // Check child entries (5 stages)
    const stagedChildren = entryList.filter((e: any) => 
      e.comment?.includes('张楚怡分阶段人设') && e.name !== '张楚怡分阶段人设'
    );
    expect(stagedChildren.length).toBe(5);
    console.log(`  - Staged entries: 1 dispatcher + ${stagedChildren.length} children`);
    
    // ── Validate live stream chat ─────────────────────────────────────────
    // Live chat should inject regex scripts
    expect(extensions).toHaveProperty('regex_scripts');
    const regexScripts = extensions.regex_scripts as any[];
    expect(Array.isArray(regexScripts)).toBe(true);
    
    // Should have the live chat regex script
    const liveChatScript = regexScripts.find((s: any) => s.scriptName === '直播间界面');
    expect(liveChatScript).toBeDefined();
    if (liveChatScript) {
      expect(liveChatScript.replaceString).toContain('lc-root');
      expect(liveChatScript.markdownOnly).toBe(true);
    }
    
    // Should also have the "hide from AI" script
    const hideScript = regexScripts.find((s: any) => s.scriptName === '对AI隐藏直播间');
    expect(hideScript).toBeDefined();
    if (hideScript) {
      expect(hideScript.promptOnly).toBe(true);
    }
    
    // Live chat extension metadata
    expect(extensions).toHaveProperty('live_stream_chat');
    const liveChatExt = extensions.live_stream_chat as any;
    expect(liveChatExt.enabled).toBe(true);
    expect(liveChatExt.title).toBe('危城直播间');
    expect(liveChatExt.initialComments.length).toBe(5);
    console.log(`  - Live stream chat: enabled, ${regexScripts.length} regex scripts`);
    
    // ── Validate first_mes has live chat placeholder ──────────────────────
    expect(finalCard.data.first_mes).toContain('<LiveStreamChatImpl/>');
    
    console.log(`\n✅ Full flow completed successfully!`);
    console.log(`   Total lorebook entries: ${entryCount}`);
    console.log(`   MVU: enabled (modern template)`);
    console.log(`   Staged mode: enabled (5 relationship stages)`);
    console.log(`   Live stream chat: enabled`);
    console.log(`   Card structure: Valid SillyTavern V3`);
  }, 60000);

  it('Validate exported card JSON structure', () => {
    expect(finalCard).toBeDefined();
    
    // Validate V3 envelope
    expect(finalCard).toHaveProperty('spec', 'chara_card_v3');
    expect(finalCard).toHaveProperty('spec_version', '3.0');
    expect(finalCard).toHaveProperty('data');
    expect(finalCard).toHaveProperty('_meta');
    
    // Validate data fields
    const data = finalCard.data;
    expect(data).toHaveProperty('name', CARD_NAME);
    expect(data).toHaveProperty('description');
    expect(data).toHaveProperty('first_mes');
    expect(data).toHaveProperty('character_book');
    expect(data).toHaveProperty('tags');
    expect(data).toHaveProperty('extensions');
    
    // Validate character_book structure
    const book = data.character_book;
    expect(book).toHaveProperty('name');
    expect(book).toHaveProperty('entries');
    expect(book).toHaveProperty('scan_depth');
    expect(book).toHaveProperty('token_budget');
    
    // Validate each entry has required fields
    const entries = book.entries;
    for (const [_id, entry] of Object.entries(entries)) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('keys');
      expect(entry).toHaveProperty('content');
      expect(entry).toHaveProperty('enabled');
      expect(entry).toHaveProperty('constant');
      expect(entry).toHaveProperty('insertion_order');
      expect(entry).toHaveProperty('position');
      expect(Array.isArray((entry as any).keys)).toBe(true);
    }
    
    // Validate extensions
    expect(data.extensions).toHaveProperty('world');
    expect(data.extensions.world).toBe(book.name);
    
    console.log('✅ Card JSON structure validation passed');
    console.log(`   - V3 envelope: Valid`);
    console.log(`   - Data fields: Complete`);
    console.log(`   - Character book: ${Object.keys(entries).length} entries`);
    console.log(`   - Extensions: Valid`);
  });

  it('Compare with reference card metrics', () => {
    const entries = Object.values(finalCard.data.character_book.entries) as any[];
    
    const avgContentLength = entries.reduce((sum: number, e: any) => sum + (e.content?.length || 0), 0) / entries.length;
    const avgKeyCount = entries.reduce((sum: number, e: any) => sum + (e.keys?.length || 0), 0) / entries.length;
    const constantCount = entries.filter((e: any) => e.constant).length;
    const constantRatio = constantCount / entries.length;
    
    console.log('\n📊 Generated Card Metrics:');
    console.log(`   Entry count: ${entries.length}`);
    console.log(`   Avg content length: ${avgContentLength.toFixed(0)} chars`);
    console.log(`   Avg key count: ${avgKeyCount.toFixed(2)}`);
    console.log(`   Constant entries: ${constantCount} (${(constantRatio * 100).toFixed(1)}%)`);
    
    // Reference card (二十一人会) metrics for comparison:
    // - Entry count: 32
    // - Avg content length: 1536
    // - Avg key count: 1.125
    // - Constant ratio: 59.375%
    
    console.log('\n📊 Reference Card (二十一人会) Metrics:');
    console.log(`   Entry count: 32`);
    console.log(`   Avg content length: 1536 chars`);
    console.log(`   Avg key count: 1.125`);
    console.log(`   Constant entries: 19 (59.4%)`);
    
    // Assertions (with tolerance for AI variability and API failures)
    // With MVU + staged entries, total should be higher than before
    expect(entries.length).toBeGreaterThanOrEqual(15); // At least 15 entries (was 10 without MVU/staged)
    expect(avgContentLength).toBeGreaterThan(300); // At least 300 chars average (lowered because staged child entries have ~200 chars)
    expect(avgKeyCount).toBeGreaterThanOrEqual(0.5); // At least 0.5 keys average
    
    console.log('\n✅ Metrics comparison completed');
  });
});
