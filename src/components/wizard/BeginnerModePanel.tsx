/**
 * BeginnerModePanel — MVU 新手模式面板
 *
 * "壳"架构：提供结构框架与 UI，玩家通过 API 调用填充内容。
 * 流程：选择模板 → 预览变量结构 → AI 一键生成/逐类生成 → 应用到 MvuConfig
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '../shared/Button';
import { TextInput } from '../shared/TextInput';
import type { MvuConfig } from '../../constants/defaults';
import {
  generateStatusBarHtml,
  getStatusBarPresetByTemplateId,
} from '../../services/status-bar-templates';
import {
  BEGINNER_TEMPLATES,
  applyBeginnerTemplate,
  buildTemplateAIBlueprint,
  type BeginnerTemplate,
  type TemplateSectionBlueprint,
} from '../../constants/beginner-templates';
import { callAIWithPromptStreaming } from '../../services/ai-service';
import { parseAIJson, stripMarkdownFences } from '../../services/ai-json';
import { StatusBarConfigPanel } from './StatusBarConfigPanel';

// ════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════

interface BeginnerModePanelProps {
  mvu: MvuConfig;
  onChange: (mvu: MvuConfig) => void;
  cardName: string;
  characterContext?: string;
  worldbookContext?: string;
}

type GenerationStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

interface SectionGenState {
  status: GenerationStatus;
  streamText: string;
  error: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 样式常量
// ════════════════════════════════════════════════════════════════════════════

const cardCls = 'rounded-xl border border-[color-mix(in_srgb,var(--color-border-default)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-surface-raised)_40%,transparent)] p-3';
const inputCls = 'w-full rounded-lg border border-[var(--input-border)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-sm text-[var(--text-color)] focus:border-[var(--color-border-focus)] focus:outline-none';

// ════════════════════════════════════════════════════════════════════════════
// 主组件
// ════════════════════════════════════════════════════════════════════════════

export function BeginnerModePanel({ mvu, onChange, cardName, characterContext, worldbookContext }: BeginnerModePanelProps) {
  // 查找模板：旧 staged-template id（pure-love/ntr/dual-route）不在新模板表中，需回退到选择界面
  const foundTemplate = mvu.beginnerTemplateId
    ? BEGINNER_TEMPLATES.find(t => t.id === mvu.beginnerTemplateId) ?? null
    : null;
  const [selectedTemplate, setSelectedTemplate] = useState<BeginnerTemplate | null>(foundTemplate);
  const [applied, setApplied] = useState(!!foundTemplate && mvu.schemaSections.length > 0);
  const [globalGenStatus, setGlobalGenStatus] = useState<GenerationStatus>('idle');
  const [globalStreamText, setGlobalStreamText] = useState('');
  const [globalError, setGlobalError] = useState('');
  const [sectionStates, setSectionStates] = useState<Record<string, SectionGenState>>({});
  const [userRequirement, setUserRequirement] = useState('');

  // 用 ref 追踪最新 mvu，防止 AI 流式生成期间闭包捕获旧值导致覆盖用户并发编辑
  const mvuRef = useRef(mvu);
  useEffect(() => { mvuRef.current = mvu; }, [mvu]);

  // ── 选择模板 ──────────────────────────────────────────────
  const handleSelectTemplate = useCallback((template: BeginnerTemplate) => {
    setSelectedTemplate(template);
    setApplied(false);
    setSectionStates({});
    setGlobalGenStatus('idle');
    setGlobalStreamText('');
    setGlobalError('');
  }, []);

  // ── 应用模板（仅结构，不生成内容）──────────────────────────
  const handleApplyTemplate = useCallback(() => {
    if (!selectedTemplate) return;
    const newMvu = applyBeginnerTemplate(selectedTemplate, mvu);
    const preset = getStatusBarPresetByTemplateId(selectedTemplate.id);
    if (preset) {
      const options = {
        ...(newMvu.statusBarOptions ?? {}),
        themeId: newMvu.statusBarOptions?.themeId ?? preset.themeId,
        title: newMvu.statusBarOptions?.title ?? preset.title,
      };
      newMvu.statusBarStyle = preset.statusTemplateId;
      newMvu.statusBarOptions = options;
      newMvu.statusBarHtml = generateStatusBarHtml(preset.statusTemplateId, newMvu.schemaSections, options);
    }
    onChange(newMvu);
    setApplied(true);
  }, [selectedTemplate, mvu, onChange]);

  // ── AI 一键生成全部变量内容 ────────────────────────────────
  const handleGenerateAll = useCallback(async () => {
    if (!selectedTemplate) return;
    setGlobalGenStatus('streaming');
    setGlobalStreamText('');
    setGlobalError('');

    const blueprint = buildTemplateAIBlueprint(selectedTemplate);
    const system = buildBeginnerGenSystem(selectedTemplate);
    const user = buildBeginnerGenUser(cardName, blueprint, userRequirement, characterContext, worldbookContext);

    try {
      const fullText = await callAIWithPromptStreaming(system, user, (_chunk, full) => {
        setGlobalStreamText(full);
      }, { temperature: 0.8, presetMode: 'force' });
      setGlobalStreamText(fullText);
      setGlobalGenStatus('done');

      // 尝试解析并填充到变量（使用 ref 获取最新 mvu，避免覆盖并发编辑）
      applyGeneratedContent(fullText, selectedTemplate, mvuRef.current, onChange);
    } catch (err) {
      setGlobalGenStatus('error');
      setGlobalError(err instanceof Error ? err.message : '生成失败，请重试');
    }
  }, [selectedTemplate, cardName, userRequirement, onChange, characterContext, worldbookContext]);

  // ── AI 逐分区生成 ─────────────────────────────────────────
  const handleGenerateSection = useCallback(async (section: TemplateSectionBlueprint) => {
    if (!selectedTemplate) return;
    setSectionStates(prev => ({ ...prev, [section.name]: { status: 'streaming', streamText: '', error: '' } }));

    const system = buildSectionGenSystem(selectedTemplate, section);
    const user = buildSectionGenUser(cardName, section, userRequirement, characterContext, worldbookContext);

    try {
      const fullText = await callAIWithPromptStreaming(system, user, (_chunk, full) => {
        setSectionStates(prev => ({ ...prev, [section.name]: { ...prev[section.name], streamText: full } }));
      }, { temperature: 0.8, presetMode: 'force' });
      setSectionStates(prev => ({ ...prev, [section.name]: { status: 'done', streamText: fullText, error: '' } }));

      // 解析并填充该分区（使用 ref 获取最新 mvu，避免覆盖并发编辑）
      applySectionContent(fullText, section, selectedTemplate, mvuRef.current, onChange);
    } catch (err) {
      setSectionStates(prev => ({
        ...prev,
        [section.name]: { status: 'error', streamText: '', error: err instanceof Error ? err.message : '生成失败' },
      }));
    }
  }, [selectedTemplate, cardName, userRequirement, onChange, characterContext, worldbookContext]);

  // ── 渲染 ─────────────────────────────────────────────────
  // 安全回退：applied=true 但 selectedTemplate 为空时（旧模板 id 残留），仍显示选择界面
  const showTemplateSelection = !applied || !selectedTemplate;

  return (
    <div className="space-y-5">
      {/* 模板选择区 */}
      {showTemplateSelection && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-bold text-[var(--text-color)] mb-1">选择主题模板</h3>
            <p className="text-xs text-[var(--color-text-secondary)]">
              选择一个风格模板，系统将自动创建对应的变量结构。之后可用 AI 一键填充内容。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {BEGINNER_TEMPLATES.map(template => {
              const isSelected = selectedTemplate?.id === template.id;
              return (
                <button
                  key={template.id}
                  onClick={() => handleSelectTemplate(template)}
                  className={`text-left rounded-xl border-2 p-4 transition-all duration-200 ${
                    isSelected
                      ? 'border-[var(--color-primary)] shadow-[0_0_12px_color-mix(in_srgb,var(--color-primary)_25%,transparent)]'
                      : 'border-[color-mix(in_srgb,var(--color-border-default)_60%,transparent)] hover:border-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]'
                  }`}
                  style={{ background: isSelected ? template.themeGradient : undefined }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-2xl">{template.icon}</span>
                    <span className="text-sm font-bold text-[var(--text-color)]">{template.name}</span>
                    {isSelected && <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-[var(--color-primary)] text-white">已选</span>}
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">{template.description}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {template.tags.map(tag => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] text-[var(--color-primary)]">
                        {tag}
                      </span>
                    ))}
                  </div>
                  {/* 变量预览 */}
                  <div className="mt-3 pt-2 border-t border-[color-mix(in_srgb,var(--color-border-default)_30%,transparent)]">
                    <div className="flex flex-wrap gap-1.5">
                      {template.sections.map(s => (
                        <span key={s.name} className="text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--color-surface-raised)_80%,transparent)] text-[var(--color-text-muted)] border border-[color-mix(in_srgb,var(--color-border-default)_30%,transparent)]">
                          {s.icon} {s.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* 应用按钮 */}
          {selectedTemplate && (
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="sm" onClick={handleApplyTemplate}>
                应用「{selectedTemplate.name}」模板
              </Button>
              <span className="text-xs text-[var(--color-text-muted)]">
                将创建 {selectedTemplate.sections.reduce((n, s) => n + s.variables.length, 0)} 个变量
              </span>
            </div>
          )}
        </div>
      )}

      {/* 已应用模板 → 显示变量结构 + AI 生成 */}
      {applied && selectedTemplate && (
        <div className="space-y-4">
          {/* 模板头部 */}
          <div className="flex items-center gap-3">
            <span className="text-2xl">{selectedTemplate.icon}</span>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-bold text-[var(--text-color)]">{selectedTemplate.name}</h3>
              <p className="text-xs text-[var(--color-text-secondary)]">{selectedTemplate.description}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setApplied(false); setSelectedTemplate(null); }}>
              切换模板
            </Button>
          </div>

          {/* 状态栏配置：MVU 变量步骤即可完成，无需进入分阶段模式 */}
          <StatusBarConfigPanel mvu={mvu} onChange={onChange} />

          {/* 创作需求输入 */}
          <div className={cardCls}>
            <label className="text-xs font-medium text-[var(--color-text-secondary)] mb-1.5 block">
              创作需求（可选）— 告诉 AI 你想要什么样的内容
            </label>
            <TextInput
              value={userRequirement}
              onChange={(e) => setUserRequirement(e.target.value)}
              className={inputCls}
              placeholder={`如：一个亦正亦邪的剑客，师从魔教但心存善念…`}
            />
          </div>

          {/* AI 一键生成全部 */}
          <div className={cardCls}>
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                onClick={handleGenerateAll}
                disabled={globalGenStatus === 'streaming' || globalGenStatus === 'loading'}
              >
                {globalGenStatus === 'streaming' ? '⏳ 生成中…' : '✨ AI 一键生成全部变量内容'}
              </Button>
              <span className="text-xs text-[var(--color-text-muted)]">
                根据模板结构 + 卡片名称，AI 自动填充所有变量初始值
              </span>
            </div>

            {/* 全局生成流式输出 */}
            {globalGenStatus === 'streaming' && globalStreamText && (
              <div className="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--input-bg)_50%,transparent)] border border-[color-mix(in_srgb,var(--color-border-default)_30%,transparent)] p-3 max-h-48 overflow-y-auto">
                <pre className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap font-mono leading-relaxed">{globalStreamText}</pre>
              </div>
            )}
            {globalGenStatus === 'done' && (
              <div className="mt-2 flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
                <span>✓</span> 生成完成，变量内容已自动填充
              </div>
            )}
            {globalGenStatus === 'error' && (
              <div className="mt-2 flex items-center gap-2 text-xs text-red-500">
                <span>✗</span> {globalError}
                <Button variant="ghost" size="sm" onClick={handleGenerateAll}>重试</Button>
              </div>
            )}
          </div>

          {/* 分区变量预览 + 逐区生成 */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-wide">变量结构预览</h4>
            {selectedTemplate.sections.map(section => {
              const state = sectionStates[section.name];
              return (
                <div key={section.name} className={cardCls}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">{section.icon}</span>
                    <span className="text-sm font-semibold text-[var(--text-color)]">{section.name}</span>
                    <span className="text-xs text-[var(--color-text-muted)]">{section.description}</span>
                    <div className="flex-1" />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleGenerateSection(section)}
                      disabled={state?.status === 'streaming'}
                    >
                      {state?.status === 'streaming' ? '生成中…' : '🤖 生成此区'}
                    </Button>
                  </div>

                  {/* 变量列表 */}
                  <div className="space-y-1">
                    {section.variables.map(v => (
                      <div key={v.path} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-[color-mix(in_srgb,var(--input-bg)_25%,transparent)]">
                        <span className="font-mono text-[var(--color-primary)]">{v.path}</span>
                        <span className="text-[var(--color-text-muted)]">—</span>
                        <span className="text-[var(--color-text-secondary)]">{v.label}</span>
                        {v.aiGeneratable && (
                          <span className="ml-auto text-[10px] px-1 py-0.5 rounded bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[var(--color-primary)]">
                            AI
                          </span>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* 分区生成流式输出 */}
                  {state?.status === 'streaming' && state.streamText && (
                    <div className="mt-2 rounded-lg bg-[color-mix(in_srgb,var(--input-bg)_50%,transparent)] border border-[color-mix(in_srgb,var(--color-border-default)_30%,transparent)] p-2 max-h-32 overflow-y-auto">
                      <pre className="text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap font-mono leading-relaxed">{state.streamText}</pre>
                    </div>
                  )}
                  {state?.status === 'done' && (
                    <div className="mt-1.5 text-xs text-green-600 dark:text-green-400">✓ 已生成并填充</div>
                  )}
                  {state?.status === 'error' && (
                    <div className="mt-1.5 flex items-center gap-2 text-xs text-red-500">
                      ✗ {state.error}
                      <Button variant="ghost" size="sm" onClick={() => handleGenerateSection(section)}>重试</Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 当前变量实际值预览 */}
          <div className={cardCls}>
            <h4 className="text-xs font-bold text-[var(--color-text-secondary)] mb-2">当前变量值（可手动修改）</h4>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {mvu.schemaSections.map((section, sIdx) => (
                <div key={sIdx}>
                  <div className="text-xs font-semibold text-[var(--text-color)] mb-1">{section.name}</div>
                  {section.variables.map((v, vIdx) => (
                    <div key={vIdx} className="flex items-center gap-2 text-xs py-0.5">
                      <span className="font-mono text-[var(--color-text-muted)] w-28 shrink-0 truncate">{v.path}</span>
                      <span className="text-[var(--color-text-secondary)] flex-1 truncate">
                        {typeof v.initialValue === 'object' ? JSON.stringify(v.initialValue) : String(v.initialValue ?? '（空）')}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// AI 提示词构建
// ════════════════════════════════════════════════════════════════════════════

function buildBeginnerGenSystem(template: BeginnerTemplate): string {
  return `你是一位专业的 SillyTavern 角色卡 MVU 变量系统内容生成器。
你的任务是为「${template.name}」风格的角色卡生成所有变量的初始内容。

要求：
1. 严格输出 JSON 格式，键为变量路径，值为对应内容
2. 内容必须贴合「${template.name}」风格（${template.description}）
3. **必须严格基于用户提供的角色设定与世界书内容生成变量**：变量值应从现有角色设定中提取或推导，不得凭空创造与原设定无关的新角色或新设定
4. 字符串变量直接给值；数值变量给合理初始值；record 变量给对象
5. 内容要有创意和细节，不要泛泛而谈
6. 所有文本使用中文
7. 输出纯 JSON，不要 markdown 代码块标记

## 性格描述方法（性格调色盘）
如果模板包含性格/人物描述类变量，必须使用「性格调色盘」结构而非抽象标签：
- 底色：角色最深层的核心特质（1-2个），这是角色的本质
- 主色调：日常最突出的特质（1-2个），这是别人眼中ta的样子
- 点缀：特定条件下才出现的隐藏特质（0-2个），这是反差和惊喜
- 衍生（关键！）：每个特质必须写3条具体行为衍生：
  - 衍生一：日常场景下的典型行为（自然流露）
  - 衍生二：压力/冲突场景下的反应（极端表现）
  - 衍生三：特定对象面前的隐藏表现（多面性）
示例：
  底色：内敛克制
  衍生一：被当众提问时会先沉默2秒，眼神向下看，然后才简短回答
  衍生二：即使内心愤怒到极点，声音也不会提高，只会让手指关节微微发白
  衍生三：只在深夜独处时才会对着镜子练习明天要说的话，反复调整语气

这种写法让AI能"解开"行为压缩包，在不同场景自动推导合理反应，远比"外冷内热"这样的标签有效。

输出格式示例：
{
  "简介.姓名": "叶孤城",
  "简介.称号": "天外飞仙",
  "简介.性格": "底色：孤高自许\\n衍生一：从不主动与人攀谈，独处时才会轻声哼曲\\n衍生二：被质疑剑法时不辩解，只是默默擦剑，眼神如霜\\n衍生三：对唯一认可的对手会露出极淡的笑意，主动邀其饮酒\\n主色调：重诺守信\\n衍生一：答应的事绝不食言，哪怕对方已忘记\\n衍生二：为守诺可以带伤赶路三天三夜\\n衍生三：对不理解自己的人的爽约会暗自失望，但绝不表露",
  "秘籍.列表": {"天外飞仙剑法": {"品阶": "天", "进度": "第七层", "效果": "剑气纵横三万里"}},
  "属性.武力": 75
}`;
}

function buildBeginnerGenUser(cardName: string, blueprint: string, requirement: string, characterContext?: string, worldbookContext?: string): string {
  let user = `卡片名称：${cardName}\n\n需要生成的变量蓝图：\n${blueprint}`;
  // 注入已有角色设定，确保 AI 基于现有设定生成而非创造新角色
  if (characterContext && characterContext.trim()) {
    user += `\n\n【已有角色设定】（生成的变量内容必须与以下角色设定保持一致，不得创造新角色）：\n${characterContext.trim()}`;
  }
  // 注入世界书内容，让变量值与世界观/设定条目关联
  if (worldbookContext && worldbookContext.trim()) {
    // 截断过长的世界书内容，避免超出 token 限制
    const trimmed = worldbookContext.trim().slice(0, 6000);
    user += `\n\n【世界书条目】（生成的变量内容应与以下世界书设定关联，如角色背景、地点、物品等需保持一致）：\n${trimmed}`;
  }
  if (requirement.trim()) {
    user += `\n\n用户创作需求：${requirement.trim()}`;
  }
  user += '\n\n请严格基于以上角色设定与世界书内容，生成所有变量的初始内容，输出纯 JSON。';
  return user;
}

function buildSectionGenSystem(template: BeginnerTemplate, section: TemplateSectionBlueprint): string {
  // Check if this section contains personality-related variables
  const hasPersonalityVar = section.variables.some(
    v => v.path.includes('性格') || v.path.includes('人设') || v.label.includes('性格')
  );
  const personalityInstruction = hasPersonalityVar
    ? `\n\n## 性格描述方法（性格调色盘）
该分区包含性格类变量，必须使用「性格调色盘」结构：
- 底色：核心特质（1-2个）+ 3条行为衍生（日常/压力/隐藏）
- 主色调：主导特质（1-2个）+ 3条行为衍生
- 点缀：隐藏特质（0-2个）+ 3条行为衍生
禁止只写抽象标签如"外冷内热"，必须写具体可感知的行为场景。`
    : '';

  return `你是一位专业的 SillyTavern 角色卡内容生成器，专精「${template.name}」风格。
现在需要为「${section.name}」分区生成变量内容。

要求：
1. 严格输出 JSON 格式，键为变量路径，值为对应内容
2. 内容贴合「${template.name}」风格
3. **必须严格基于用户提供的角色设定与世界书内容生成变量**：变量值应从现有设定中提取或推导，不得创造与原设定无关的新角色或新设定
4. 有创意、有细节、有画面感
5. 所有文本使用中文
6. 输出纯 JSON

该分区包含的变量：
${section.variables.map(v => `- ${v.path}（${v.label}）：${v.generationHint}`).join('\n')}${personalityInstruction}`;
}

function buildSectionGenUser(cardName: string, section: TemplateSectionBlueprint, requirement: string, characterContext?: string, worldbookContext?: string): string {
  let user = `卡片名称：${cardName}\n分区：${section.name}（${section.description}）`;
  if (characterContext && characterContext.trim()) {
    user += `\n\n【已有角色设定】（生成的变量内容必须与以下角色设定保持一致，不得创造新角色）：\n${characterContext.trim()}`;
  }
  if (worldbookContext && worldbookContext.trim()) {
    const trimmed = worldbookContext.trim().slice(0, 6000);
    user += `\n\n【世界书条目】（生成的变量内容应与以下世界书设定关联）：\n${trimmed}`;
  }
  if (requirement.trim()) {
    user += `\n用户创作需求：${requirement.trim()}`;
  }
  user += '\n\n请严格基于以上角色设定与世界书内容，生成该分区所有变量的内容，输出纯 JSON。';
  return user;
}

// ════════════════════════════════════════════════════════════════════════════
// 解析 AI 输出并填充到 MvuConfig
// ════════════════════════════════════════════════════════════════════════════

function applyGeneratedContent(
  rawText: string,
  _template: BeginnerTemplate,
  mvu: MvuConfig,
  onChange: (mvu: MvuConfig) => void,
) {
  const cleaned = stripMarkdownFences(rawText);
  const parsed = parseAIJson(cleaned) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return;

  const newSections = mvu.schemaSections.map(section => ({
    ...section,
    variables: section.variables.map(v => {
      const value = parsed[v.path];
      if (value === undefined) return v;
      return { ...v, initialValue: value };
    }),
  }));

  onChange({ ...mvu, schemaSections: newSections });
}

function applySectionContent(
  rawText: string,
  section: TemplateSectionBlueprint,
  _template: BeginnerTemplate,
  mvu: MvuConfig,
  onChange: (mvu: MvuConfig) => void,
) {
  const cleaned = stripMarkdownFences(rawText);
  const parsed = parseAIJson(cleaned) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return;

  const sectionVarPaths = new Set(section.variables.map(v => v.path));
  const newSections = mvu.schemaSections.map(s => ({
    ...s,
    variables: s.variables.map(v => {
      if (!sectionVarPaths.has(v.path)) return v;
      const value = parsed[v.path];
      if (value === undefined) return v;
      return { ...v, initialValue: value };
    }),
  }));

  onChange({ ...mvu, schemaSections: newSections });
}
