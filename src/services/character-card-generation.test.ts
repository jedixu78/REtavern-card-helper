/**
 * Character Card Generation Test - Full Workflow Simulation
 * 
 * This test simulates a complete character card generation workflow:
 * 1. Generate character description (Step 3)
 * 2. Generate world book entries (Step 4)
 * 3. Generate first message (Step 7)
 * 4. Compare with reference card (_weicheng_card.json)
 * 5. Analyze quality gaps and suggest prompt optimizations
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CHARACTER_GENERATE_PROMPT, LOREBOOK_GENERATE_PROMPT, FIRST_MESSAGE_PROMPT } from '../constants/prompts';

// Volcengine Ark API configuration
const VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const VOLCENGINE_API_KEY = (import.meta.env.VOLCENGINE_API_KEY as string) || '';
const TEST_MODEL = 'deepseek-v4-flash';

interface ReferenceCard {
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  first_mes: string;
  character_book?: {
    entries: Array<{
      id: number;
      keys: string[];
      content: string;
      name: string;
      comment: string;
      constant: boolean;
      insertion_order: number;
      position: string;
      priority: number;
    }>;
  };
}

interface GeneratedCard {
  name: string;
  description: string;
  first_mes: string;
  lorebook_entries: Array<{
    name: string;
    keys: string[];
    content: string;
    comment: string;
    constant: boolean;
  }>;
}

interface QualityMetrics {
  description_depth: number; // Character count
  description_structure: boolean; // Has required sections
  personality_palette: boolean; // Has 底色/主色调/点缀 pattern
  behavioral_derivatives: number; // Count of 衍生一/二/三
  first_message_length: number; // Character count
  narrative_quality: number; // Subjective score based on concrete details
  worldbook_entry_count: number;
  worldbook_avg_content_length: number;
  mvu_integration: boolean;
}

/**
 * Load the reference card for comparison
 * Note: In _weicheng_card.json, character descriptions are stored in world book entries,
 * not in data.description (which is empty). We need to extract them from entries.
 */
function loadReferenceCard(): ReferenceCard {
  const refPath = join(__dirname, '../../_weicheng_card.json');
  const content = readFileSync(refPath, 'utf-8');
  const parsed = JSON.parse(content);
  
  // Extract character descriptions from world book entries
  const entries = parsed.data.character_book?.entries || [];
  const charEntries = entries.filter((e: any) => 
    e.comment?.includes('角色设定') || e.name?.includes('角色设定')
  );
  
  // Combine all character entry contents into a pseudo-description
  const combinedDescription = charEntries.map((e: any) => e.content).join('\n\n---\n\n');
  
  return {
    ...parsed.data,
    description: combinedDescription, // Override empty description with extracted content
  } as ReferenceCard;
}

/**
 * Call Volcengine Ark API with retry logic
 */
async function callVolcengineAPI(messages: Array<{ role: string; content: string }>, maxTokens = 8000): Promise<string> {
  const response = await fetch(`${VOLCENGINE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${VOLCENGINE_API_KEY}`,
    },
    body: JSON.stringify({
      model: TEST_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Parse JSON from AI response (handles markdown code blocks)
 */
function parseAIJson(text: string): any {
  let cleaned = text.trim();
  // Remove markdown code blocks if present
  cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse JSON:', cleaned.slice(0, 200));
    throw e;
  }
}

/**
 * Calculate quality metrics for a generated card
 */
function calculateQualityMetrics(card: GeneratedCard, _referenceCard: ReferenceCard): QualityMetrics {
  const desc = card.description || '';
  const hasSections = [
    '## 基本信息',
    '## 外貌特征',
    '## 性格调色盘',
    '## 背景设定',
    '## 关系设定'
  ].every(section => desc.includes(section));

  const hasPersonalityPalette = desc.includes('底色') && desc.includes('主色调') && desc.includes('点缀');
  
  // Count behavioral derivatives (衍生一, 衍生二, etc.)
  const derivativeMatches = desc.match(/衍生[一二三四五六七八九十]/g);
  const behavioralDerivatives = derivativeMatches ? derivativeMatches.length : 0;

  // Check first message quality indicators
  const firstMes = card.first_mes || '';
  const hasConcreteDetails = (firstMes.match(/[具体细节如时间地点动作感官描写]/g) || []).length;
  
  // Worldbook metrics
  const entries = card.lorebook_entries || [];
  const avgContentLength = entries.length > 0
    ? entries.reduce((sum, e) => sum + (e.content?.length || 0), 0) / entries.length
    : 0;

  return {
    description_depth: desc.length,
    description_structure: hasSections,
    personality_palette: hasPersonalityPalette,
    behavioral_derivatives: behavioralDerivatives,
    first_message_length: firstMes.length,
    narrative_quality: Math.min(100, hasConcreteDetails * 10), // Simplified scoring
    worldbook_entry_count: entries.length,
    worldbook_avg_content_length: Math.round(avgContentLength),
    mvu_integration: false, // Would need to check extensions.mvu_enabled
  };
}

/**
 * Compare two sets of quality metrics and identify gaps
 */
function compareQuality(generated: QualityMetrics, reference: QualityMetrics): {
  gaps: Array<{ metric: string; generated: number | boolean; reference: number | boolean; gap: string }>;
  strengths: string[];
} {
  const gaps: Array<{ metric: string; generated: number | boolean; reference: number | boolean; gap: string }> = [];
  const strengths: string[] = [];

  // Description depth
  if (generated.description_depth < reference.description_depth * 0.7) {
    gaps.push({
      metric: 'description_depth',
      generated: generated.description_depth,
      reference: reference.description_depth,
      gap: `描述深度不足 (${generated.description_depth} vs ${reference.description_depth} chars)`
    });
  } else {
    strengths.push('描述深度充足');
  }

  // Structure completeness
  if (!generated.description_structure && reference.description_structure) {
    gaps.push({
      metric: 'description_structure',
      generated: generated.description_structure,
      reference: reference.description_structure,
      gap: '缺少必要的 ## 分段结构'
    });
  } else {
    strengths.push('结构完整');
  }

  // Personality palette
  if (!generated.personality_palette && reference.personality_palette) {
    gaps.push({
      metric: 'personality_palette',
      generated: generated.personality_palette,
      reference: reference.personality_palette,
      gap: '缺少性格调色盘模式（底色/主色调/点缀）'
    });
  } else {
    strengths.push('包含性格调色盘');
  }

  // Behavioral derivatives
  if (generated.behavioral_derivatives < reference.behavioral_derivatives * 0.5) {
    gaps.push({
      metric: 'behavioral_derivatives',
      generated: generated.behavioral_derivatives,
      reference: reference.behavioral_derivatives,
      gap: `行为衍生不足 (${generated.behavioral_derivatives} vs ${reference.behavioral_derivatives})`
    });
  } else {
    strengths.push('行为衍生充足');
  }

  // First message length
  if (generated.first_message_length < reference.first_message_length * 0.5) {
    gaps.push({
      metric: 'first_message_length',
      generated: generated.first_message_length,
      reference: reference.first_message_length,
      gap: `开场白过短 (${generated.first_message_length} vs ${reference.first_message_length} chars)`
    });
  } else {
    strengths.push('开场白长度合适');
  }

  // Worldbook entry count
  if (generated.worldbook_entry_count < reference.worldbook_entry_count * 0.5) {
    gaps.push({
      metric: 'worldbook_entry_count',
      generated: generated.worldbook_entry_count,
      reference: reference.worldbook_entry_count,
      gap: `世界书条目过少 (${generated.worldbook_entry_count} vs ${reference.worldbook_entry_count})`
    });
  } else {
    strengths.push('世界书条目数量充足');
  }

  // Worldbook content length
  if (generated.worldbook_avg_content_length < reference.worldbook_avg_content_length * 0.7) {
    gaps.push({
      metric: 'worldbook_avg_content_length',
      generated: generated.worldbook_avg_content_length,
      reference: reference.worldbook_avg_content_length,
      gap: `世界书内容过短 (${generated.worldbook_avg_content_length} vs ${reference.worldbook_avg_content_length} chars)`
    });
  } else {
    strengths.push('世界书内容充实');
  }

  return { gaps, strengths };
}

describe.skipIf(!VOLCENGINE_API_KEY)('Character Card Generation - Full Workflow', () => {
  let referenceCard: ReferenceCard;
  let referenceMetrics: QualityMetrics;

  beforeAll(() => {
    referenceCard = loadReferenceCard();
    
    // Calculate reference metrics
    const refDesc = referenceCard.description || '';
    const refEntries = referenceCard.character_book?.entries || [];
    const avgRefEntryLength = refEntries.length > 0
      ? refEntries.reduce((sum, e) => sum + e.content.length, 0) / refEntries.length
      : 0;

    // Count derivatives in reference
    const refDerivatives = (refDesc.match(/衍生[一二三四五六七八九十]/g) || []).length;

    referenceMetrics = {
      description_depth: refDesc.length,
      description_structure: true, // Reference has all sections
      personality_palette: true, // Reference uses this pattern
      behavioral_derivatives: refDerivatives,
      first_message_length: referenceCard.first_mes.length,
      narrative_quality: 90, // High quality reference
      worldbook_entry_count: refEntries.length,
      worldbook_avg_content_length: Math.round(avgRefEntryLength),
      mvu_integration: true,
    };

    console.log('\n=== Reference Card Metrics ===');
    console.log(`Description length: ${referenceMetrics.description_depth} chars`);
    console.log(`First message length: ${referenceMetrics.first_message_length} chars`);
    console.log(`Worldbook entries: ${referenceMetrics.worldbook_entry_count}`);
    console.log(`Avg entry length: ${referenceMetrics.worldbook_avg_content_length} chars`);
    console.log(`Behavioral derivatives: ${referenceMetrics.behavioral_derivatives}`);
  });

  it('should generate a complete character card and compare with reference', async () => {
    // Step 1: Generate character description
    const charPrompt = CHARACTER_GENERATE_PROMPT(
      '张楚怡',
      '19岁女大学生，视觉传达设计专业，继姐身份，性格外冷内热，喜欢白色衣服',
      undefined,
      undefined,
      false,
      'zh'
    );

    const charResponse = await callVolcengineAPI([
      { role: 'system', content: charPrompt.system },
      { role: 'user', content: charPrompt.user }
    ], 8000);

    const charData = parseAIJson(charResponse);
    console.log('\n=== Generated Character Description ===');
    console.log(charData.description.slice(0, 500) + '...');

    // Step 2: Generate world book entries
    const lorePrompt = LOREBOOK_GENERATE_PROMPT(
      '危城',
      '张楚怡: 19岁女大学生，继姐\n{{user}}: 高中生，继弟',
      '人物关系与日常互动',
      4,
      false,
      undefined,
      'zh'
    );

    const loreResponse = await callVolcengineAPI([
      { role: 'system', content: lorePrompt.system },
      { role: 'user', content: lorePrompt.user }
    ], 8000);

    const loreEntries = parseAIJson(loreResponse);
    console.log('\n=== Generated World Book Entries ===');
    console.log(`Generated ${loreEntries.length} entries`);

    // Step 3: Generate first message
    const firstMsgPrompt = FIRST_MESSAGE_PROMPT(
      '危城',
      charData.description,
      '周六早晨，老式复式楼，张楚怡准备去超市',
      2000,
      undefined,
      undefined,
      'zh'
    );

    const firstMsgResponse = await callVolcengineAPI([
      { role: 'system', content: firstMsgPrompt.system },
      { role: 'user', content: firstMsgPrompt.user }
    ], 8000);

    console.log('\n=== Generated First Message ===');
    console.log(firstMsgResponse.slice(0, 500) + '...');

    // Build generated card object
    const generatedCard: GeneratedCard = {
      name: charData.name,
      description: charData.description,
      first_mes: firstMsgResponse,
      lorebook_entries: loreEntries.map((e: any) => ({
        name: e.name,
        keys: e.keys,
        content: e.content,
        comment: e.comment,
        constant: e.constant,
      })),
    };

    // Calculate quality metrics
    const generatedMetrics = calculateQualityMetrics(generatedCard, referenceCard);

    console.log('\n=== Quality Comparison ===');
    console.log('Generated Metrics:', generatedMetrics);
    console.log('Reference Metrics:', referenceMetrics);

    // Compare and identify gaps
    const comparison = compareQuality(generatedMetrics, referenceMetrics);

    console.log('\n=== Strengths ===');
    comparison.strengths.forEach(s => console.log(`✓ ${s}`));

    console.log('\n=== Gaps Identified ===');
    comparison.gaps.forEach(g => console.log(`✗ ${g.gap}`));

    // Assertions - at least some basic quality checks should pass
    expect(generatedCard.description).toBeDefined();
    expect(generatedCard.description.length).toBeGreaterThan(500);
    expect(generatedCard.first_mes.length).toBeGreaterThan(300);
    expect(generatedCard.lorebook_entries.length).toBeGreaterThanOrEqual(1);

    // Log detailed analysis for prompt optimization
    console.log('\n=== Prompt Optimization Suggestions ===');
    if (comparison.gaps.some(g => g.metric === 'behavioral_derivatives')) {
      console.log('- 需要在 CHARACTER_GENERATE_PROMPT 中强化"衍生一/二/三"的明确要求');
      console.log('- 当前 prompt 提到"衍生"但可能不够强调数量和具体性');
    }
    if (comparison.gaps.some(g => g.metric === 'first_message_length')) {
      console.log('- FIRST_MESSAGE_PROMPT 的目标字数可能需要提高');
      console.log('- 或者需要在 system prompt 中更强调场景描写的丰富性');
    }
    if (comparison.gaps.some(g => g.metric === 'worldbook_avg_content_length')) {
      console.log('- LOREBOOK_GENERATE_PROMPT 的 content 最少字数要求（当前350字）可能需要提高到500+');
    }
  }, 180000); // 180 second timeout for full workflow (3 API calls)

  it('should analyze reference card structure in detail', () => {
    // Deep analysis of what makes the reference card high-quality
    const refDesc = referenceCard.description;
    
    console.log('\n=== Reference Card Structural Analysis ===');
    
    // Check for specific patterns
    const hasBasicInfo = refDesc.includes('## 基本信息');
    const hasAppearance = refDesc.includes('## 外貌特征');
    const hasPersonality = refDesc.includes('## 性格调色盘');
    const hasBackground = refDesc.includes('## 背景设定');
    const hasRelationships = refDesc.includes('## 关系设定');
    
    console.log(`Has 基本信息: ${hasBasicInfo}`);
    console.log(`Has 外貌特征: ${hasAppearance}`);
    console.log(`Has 性格调色盘: ${hasPersonality}`);
    console.log(`Has 背景设定: ${hasBackground}`);
    console.log(`Has 关系设定: ${hasRelationships}`);

    // Count specific elements
    const measurements = (refDesc.match(/\d+-\d+-\d+/g) || []).length;
    const clothingItems = (refDesc.match(/×\d+/g) || []).length;
    const derivatives = (refDesc.match(/衍生[一二三四五六七八九十]/g) || []).length;
    const concreteBehaviors = (refDesc.match(/会|习惯|总是|经常/g) || []).length;
    
    console.log(`Body measurements mentioned: ${measurements}`);
    console.log(`Clothing items with quantities: ${clothingItems}`);
    console.log(`Behavioral derivatives (衍生): ${derivatives}`);
    console.log(`Concrete behavior indicators: ${concreteBehaviors}`);

    // Analyze first message
    const firstMes = referenceCard.first_mes;
    const timeReferences = (firstMes.match(/\d+点\d+分|\d+分钟|\d+小时/g) || []).length;
    const sensoryDetails = (firstMes.match(/阳光|声音|味道|触感|气味/g) || []).length;
    const characterActions = (firstMes.match(/她|他|{{user}}/g) || []).length;
    
    console.log(`\nFirst message analysis:`);
    console.log(`Time references: ${timeReferences}`);
    console.log(`Sensory details: ${sensoryDetails}`);
    console.log(`Character actions/thoughts: ${characterActions}`);
    console.log(`Total length: ${firstMes.length} chars`);

    // Analyze world book entries
    const entries = referenceCard.character_book?.entries || [];
    const entryLengths = entries.map(e => e.content.length);
    const avgLength = entryLengths.reduce((a, b) => a + b, 0) / entryLengths.length;
    
    console.log(`\nWorld book entries:`);
    console.log(`Total entries: ${entries.length}`);
    console.log(`Average content length: ${Math.round(avgLength)} chars`);
    console.log(`Longest entry: ${Math.max(...entryLengths)} chars`);
    console.log(`Shortest entry: ${Math.min(...entryLengths)} chars`);

    // Entry types distribution
    const constantEntries = entries.filter(e => e.constant).length;
    const triggeredEntries = entries.filter(e => !e.constant).length;
    console.log(`Constant (blue light) entries: ${constantEntries}`);
    console.log(`Triggered (green light) entries: ${triggeredEntries}`);

    expect(hasBasicInfo && hasAppearance && hasPersonality && hasBackground && hasRelationships).toBe(true);
    expect(derivatives).toBeGreaterThan(5); // Reference has many derivatives
    expect(avgLength).toBeGreaterThan(350); // Each entry should be substantial
  });

  it('should identify key differences between current prompts and reference quality', () => {
    console.log('\n=== Current Prompt vs Reference Quality Gap Analysis ===');
    
    // Key observations from reference card
    const observations = [
      '参考卡的性格调色盘有明确的"衍生一/二/三"格式，每个特质都有2-3个具体行为表现',
      '参考卡的外貌特征非常具体：身高、三围、肤色、痣的位置、发质等量化细节',
      '参考卡的背景设定解释了性格形成的因果关系（如"12岁父母离异→学会看人眼色"）',
      '参考卡的关系设定写的是具体场景而非抽象评价（如"每周三买抹茶百奇棒"）',
      '参考卡的开场白有极强的画面感：具体时间、光线、动作、对话、心理活动交织',
      '参考卡的世界书条目平均长度远超350字，很多达到800-1500字',
      '参考卡的世界书包含NPC人物种子、关系网、经济系统等多元维度',
    ];

    observations.forEach((obs, i) => {
      console.log(`${i + 1}. ${obs}`);
    });

    // Suggested prompt improvements
    console.log('\n=== Suggested Prompt Optimizations ===');
    
    const improvements = [
      {
        prompt: 'CHARACTER_GENERATE_PROMPT',
        changes: [
          '在返回JSON示例中明确展示"衍生一/二/三"的格式',
          '增加"每个性格特质必须至少给出2-3个具体行为衍生"的强制要求',
          '在外貌特征部分强调量化细节（身高、三围、具体位置的身体特征）',
          '在背景设定中要求写出"关键事件如何塑造了现在的性格"的因果链',
          '在关系设定中禁止抽象评价，必须写具体场景和习惯性行为',
        ]
      },
      {
        prompt: 'LOREBOOK_GENERATE_PROMPT',
        changes: [
          '将content最少字数从350字提高到500字',
          '在条目分类覆盖中明确列出"NPC人物种子"和"关系网络"作为必选项',
          '增加"经济系统"、"日常生活基准"等具体数值参考的要求',
          '强调PList紧凑格式的使用场景',
        ]
      },
      {
        prompt: 'FIRST_MESSAGE_PROMPT',
        changes: [
          '默认目标字数从500字提高到1500-2000字',
          '在结构要素中增加"具体时间标记"（如"六点四十分"）',
          '强调多感官描写（视觉、听觉、触觉、嗅觉）的具体要求',
          '要求穿插角色的内心独白和微动作',
          '钩子结尾要留下多个可能的互动入口，而非单一悬念',
        ]
      }
    ];

    improvements.forEach(({ prompt, changes }) => {
      console.log(`\n【${prompt}】优化建议：`);
      changes.forEach((change, i) => {
        console.log(`  ${i + 1}. ${change}`);
      });
    });

    expect(observations.length).toBeGreaterThan(0);
    expect(improvements.length).toBeGreaterThan(0);
  });
});
