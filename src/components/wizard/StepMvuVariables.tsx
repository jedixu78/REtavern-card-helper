/**
 * StepMvuVariables — MVU 变量系统步骤（向导第 5 步）
 *
 * MVU（变量追踪系统）三段式架构：
 *   - Model（模型）：在此定义变量 schema（含技能/功法等游戏元素）
 *   - View（视图）：状态栏模板（分阶段模式步骤配置）展示这些变量
 *   - Update（更新）：更新规则 + MVU 运行时让 AI 在聊天中追踪更新变量
 *
 * 本步骤与「分阶段模式」并存且都可选：此处定义的变量会与分阶段模板的变量合并。
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '../shared/Button';
import { TextInput } from '../shared/TextInput';
import { TextArea } from '../shared/TextArea';
import type { MvuConfig, MvuSchemaSection, MvuVariable, MvuUpdateRule, MvuPrefix } from '../../constants/defaults';
import { createEmptyMvuConfig } from '../../constants/defaults';
import { buildSchemaTs, buildInitvarYaml, buildUpdateRulesYaml, buildEjsPreprocess } from '../../services/mvu-builder';
import { BeginnerModePanel } from './BeginnerModePanel';
import { StatusBarConfigPanel } from './StatusBarConfigPanel';

// ════════════════════════════════════════════════════════════════════════════
// 游戏元素模型（技能 / 功法）—— 映射为 MVU record 变量
// ════════════════════════════════════════════════════════════════════════════

interface GameElement {
  name: string;
  icon: string;
  level: string;
  description: string;
}

interface GameElementCategory {
  key: '技能' | '功法';
  label: string;
  icon: string;
  levelLabel: string;
  sectionName: string;
  varPath: string;
  zodType: string;
}

const GAME_ELEMENT_CATEGORIES: GameElementCategory[] = [
  {
    key: '技能', label: '技能', icon: '⚔️', levelLabel: '等级/熟练度',
    sectionName: '技能', varPath: '技能.列表',
    zodType: 'z.record(z.string(), z.object({图标: z.string(), 等级: z.string(), 描述: z.string()}))',
  },
  {
    key: '功法', label: '功法', icon: '📿', levelLabel: '境界/层数',
    sectionName: '功法', varPath: '功法.列表',
    zodType: 'z.record(z.string(), z.object({图标: z.string(), 等级: z.string(), 描述: z.string()}))',
  },
];

function recordToElements(rec: unknown): GameElement[] {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return [];
  return Object.entries(rec as Record<string, unknown>).map(([name, v]) => {
    const obj = (v && typeof v === 'object') ? v as Record<string, unknown> : {};
    return { name, icon: String(obj['图标'] ?? ''), level: String(obj['等级'] ?? ''), description: String(obj['描述'] ?? '') };
  });
}

function elementsToRecord(elements: GameElement[]): Record<string, { 图标: string; 等级: string; 描述: string }> {
  const rec: Record<string, { 图标: string; 等级: string; 描述: string }> = {};
  for (const e of elements) {
    const name = e.name.trim();
    if (name) rec[name] = { 图标: e.icon, 等级: e.level, 描述: e.description };
  }
  return rec;
}

// ════════════════════════════════════════════════════════════════════════════
// 变量类型选项
// ════════════════════════════════════════════════════════════════════════════

const VAR_TYPE_OPTIONS = [
  { value: 'z.string()', label: '字符串' },
  { value: 'z.coerce.number()', label: '数值' },
  { value: 'z.enum()', label: '枚举' },
  { value: 'z.boolean()', label: '布尔' },
  { value: 'z.record()', label: '记录/列表' },
  { value: 'z.array()', label: '数组' },
];

function normalizeZodType(zodType: string): string {
  if (zodType.startsWith('z.enum(')) return 'z.enum()';
  if (zodType.startsWith('z.record(')) return 'z.record()';
  if (zodType.startsWith('z.array(')) return 'z.array()';
  return zodType;
}

const PREFIX_OPTIONS: { value: MvuPrefix; label: string }[] = [
  { value: '', label: '可见可更新' },
  { value: '_', label: '只读' },
  { value: '$', label: '隐藏' },
];

/** 路径格式校验：非空、无首尾/连续点。 */
function validatePathFormat(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return '路径不能为空';
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) return '路径不能以点开头或结尾';
  if (trimmed.includes('..')) return '路径段不能为空';
  return null;
}

/** 变量路径校验：格式 + 不与其它变量重名。 */
function validateVariablePath(path: string, allPaths: string[], currentPath: string): string | null {
  const formatError = validatePathFormat(path);
  if (formatError) return formatError;
  const trimmed = path.trim();
  const dupCount = allPaths.filter((p) => p === trimmed).length;
  if (dupCount > 1 || (dupCount === 1 && trimmed !== currentPath)) return '该路径已被其他变量使用';
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// 主组件
// ════════════════════════════════════════════════════════════════════════════

interface StepMvuVariablesProps {
  mvu?: MvuConfig;
  onChange: (mvu: MvuConfig) => void;
  cardName: string;
  characterContext?: string;
  worldbookContext?: string;
}

const inputCls = 'w-full rounded-lg border border-[var(--input-border)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-sm text-[var(--text-color)] focus:border-[var(--color-border-focus)] focus:outline-none';
const labelCls = 'text-xs font-medium text-[var(--color-text-secondary)] mb-1 block';
const cardCls = 'rounded-xl border border-[color-mix(in_srgb,var(--color-border-default)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-surface-raised)_40%,transparent)] p-3';

// Module-level constant: avoids creating a new empty config object on every render
const EMPTY_MVU_CONFIG = createEmptyMvuConfig();

export function StepMvuVariables({ mvu: mvuProp, onChange, cardName, characterContext, worldbookContext }: StepMvuVariablesProps) {
  const mvu = mvuProp ?? EMPTY_MVU_CONFIG;
  const [activeTab, setActiveTab] = useState<'variables' | 'elements' | 'rules' | 'statusBar'>('variables');

  // ── schema 自动生成（防抖）──────────────────────────────────
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => {
      const sections = mvu.schemaSections;
      const schemaTs = buildSchemaTs(sections);
      const initvarYaml = buildInitvarYaml(sections);
      const updateRulesYaml = buildUpdateRulesYaml(mvu.updateRules);
      const ejsPreprocess = buildEjsPreprocess([], sections);
      if (
        schemaTs !== mvu.schemaTsContent || initvarYaml !== mvu.initvarYamlContent ||
        updateRulesYaml !== mvu.updateRulesYamlContent || ejsPreprocess !== mvu.ejsPreprocessContent
      ) {
        onChange({ ...mvu, enabled: true, schemaTsContent: schemaTs, initvarYamlContent: initvarYaml, updateRulesYamlContent: updateRulesYaml, ejsPreprocessContent: ejsPreprocess });
      }
    }, 300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mvu.schemaSections, mvu.updateRules]);

  const setSections = (schemaSections: MvuSchemaSection[]) => onChange({ ...mvu, enabled: true, schemaSections });

  // ── 变量分区操作 ────────────────────────────────────────────
  const addSection = () => setSections([...mvu.schemaSections, { name: `分区${mvu.schemaSections.length + 1}`, variables: [] }]);
  const removeSection = (idx: number) => setSections(mvu.schemaSections.filter((_, i) => i !== idx));
  const updateSectionName = (idx: number, name: string) => setSections(mvu.schemaSections.map((s, i) => (i === idx ? { ...s, name } : s)));

  const addVariable = (sIdx: number) => {
    const v: MvuVariable = { path: `${mvu.schemaSections[sIdx].name}.新变量`, zodType: 'z.string()', description: '', prefix: '', initialValue: '' };
    setSections(mvu.schemaSections.map((s, i) => (i === sIdx ? { ...s, variables: [...s.variables, v] } : s)));
  };
  const updateVariable = (sIdx: number, vIdx: number, patch: Partial<MvuVariable>) => {
    setSections(mvu.schemaSections.map((s, i) => (i === sIdx ? { ...s, variables: s.variables.map((v, j) => (j === vIdx ? { ...v, ...patch } : v)) } : s)));
  };
  const removeVariable = (sIdx: number, vIdx: number) => {
    setSections(mvu.schemaSections.map((s, i) => (i === sIdx ? { ...s, variables: s.variables.filter((_, j) => j !== vIdx) } : s)));
  };

  // ── 更新规则操作 ────────────────────────────────────────────
  const setRules = (updateRules: MvuUpdateRule[]) => onChange({ ...mvu, enabled: true, updateRules });
  const addRule = () => setRules([...mvu.updateRules, { path: '', check: [''] }]);
  const updateRule = (idx: number, patch: Partial<MvuUpdateRule>) => setRules(mvu.updateRules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeRule = (idx: number) => setRules(mvu.updateRules.filter((_, i) => i !== idx));

  // ── 游戏元素操作（技能/功法 ↔ record 变量）──────────────────
  const getElements = (cat: GameElementCategory): GameElement[] => {
    const section = mvu.schemaSections.find(s => s.name === cat.sectionName);
    const variable = section?.variables.find(v => v.path === cat.varPath);
    return recordToElements(variable?.initialValue);
  };
  const setElements = (cat: GameElementCategory, elements: GameElement[]) => {
    const record = elementsToRecord(elements);
    const existingSections = mvu.schemaSections.filter(s => s.name !== cat.sectionName);
    const existingVars = (mvu.schemaSections.find(s => s.name === cat.sectionName)?.variables ?? []).filter(v => v.path !== cat.varPath);
    const gameVar: MvuVariable = {
      path: cat.varPath, zodType: cat.zodType, description: `${cat.label}列表（名称 → 图标/等级/描述）`,
      prefix: '', initialValue: record,
    };
    const section: MvuSchemaSection = { name: cat.sectionName, variables: [...existingVars, gameVar] };
    // 保持分区顺序：已存在则原位更新，否则追加
    const idx = mvu.schemaSections.findIndex(s => s.name === cat.sectionName);
    let next: MvuSchemaSection[];
    if (idx >= 0) {
      next = mvu.schemaSections.map((s, i) => (i === idx ? section : s));
    } else {
      next = [...existingSections, section];
    }
    setSections(next);
  };

  const totalVars = mvu.schemaSections.reduce((n, s) => n + s.variables.length, 0);
  const allPaths = useMemo(
    () => mvu.schemaSections.flatMap((s) => s.variables.map((v) => v.path)),
    [mvu.schemaSections],
  );
  const mode = mvu.mode ?? 'beginner';

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="mobile-stack-header flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-[var(--text-color)]">MVU 变量系统</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            定义角色卡追踪的变量（Model），配合状态栏展示（View）与更新规则（Update）。共 {totalVars} 个变量。
          </p>
        </div>
        <Button variant={mvu.enabled ? 'secondary' : 'ghost'} size="sm" onClick={() => onChange({ ...mvu, enabled: !mvu.enabled })}>
          {mvu.enabled ? '✓ 已启用' : '启用 MVU'}
        </Button>
      </div>

      {/* 模式切换：新手 / 专家 */}
      <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)] p-1 w-fit">
        <button
          onClick={() => onChange({ ...mvu, mode: 'beginner' })}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
            mode === 'beginner'
              ? 'bg-[var(--color-primary)] text-white shadow-sm'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
          }`}
        >
          🎯 新手模式
        </button>
        <button
          onClick={() => onChange({ ...mvu, mode: 'expert' })}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
            mode === 'expert'
              ? 'bg-[var(--color-primary)] text-white shadow-sm'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
          }`}
        >
          🔧 专家模式
        </button>
      </div>

      {/* ── 新手模式 ── */}
      {mode === 'beginner' && (
        <BeginnerModePanel mvu={mvu} onChange={onChange} cardName={cardName} characterContext={characterContext} worldbookContext={worldbookContext} />
      )}

      {/* ── 专家模式 ── */}
      {mode === 'expert' && (<>
      {/* Tab 切换 */}
      <div className="flex gap-2 border-b border-[var(--color-border-default)]">
        {([['variables', '📊 变量分区'], ['elements', '🎮 游戏元素'], ['rules', '📝 更新规则'], ['statusBar', '🖥️ 状态栏']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === key
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 变量路径下拉候选（变量分区与更新规则两个 tab 共用） */}
      <datalist id="mvu-variable-paths">
        {allPaths.map((p, i) => <option key={i} value={p} />)}
      </datalist>

      {/* ── Tab 1: 变量分区 ── */}
      {activeTab === 'variables' && (
        <div className="space-y-3">
          {mvu.schemaSections.map((section, sIdx) => (
            <div key={sIdx} className={cardCls}>
              <div className="flex items-center gap-2 mb-2">
                <TextInput value={section.name} onChange={(e) => updateSectionName(sIdx, e.target.value)} className={`${inputCls} max-w-[180px] font-semibold`} />
                <span className="text-xs text-[var(--color-text-muted)]">{section.variables.length} 个变量</span>
                <div className="flex-1" />
                <Button variant="danger" size="sm" onClick={() => removeSection(sIdx)}>删除分区</Button>
              </div>
              <div className="space-y-2">
                {section.variables.map((v, vIdx) => {
                  const typeKey = normalizeZodType(v.zodType);
                  return (
                    <div key={vIdx} className="rounded-lg border border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)] bg-[color-mix(in_srgb,var(--input-bg)_30%,transparent)] p-2.5">
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                        <div className="sm:col-span-4">
                          <label className={labelCls}>变量路径</label>
                          <TextInput
                            value={v.path}
                            onChange={(e) => updateVariable(sIdx, vIdx, { path: e.target.value })}
                            className={inputCls}
                            placeholder="角色.好感度"
                            list="mvu-variable-paths"
                            error={validateVariablePath(v.path, allPaths, v.path) ?? undefined}
                          />
                        </div>
                        <div className="sm:col-span-3">
                          <label className={labelCls}>类型</label>
                          <select
                            value={typeKey}
                            onChange={(e) => {
                              const val = e.target.value;
                              const patch: Partial<MvuVariable> = {};
                              if (val === 'z.coerce.number()') { patch.zodType = 'z.coerce.number()'; patch.range = v.range ?? { min: 0, max: 100 }; patch.initialValue = typeof v.initialValue === 'number' ? v.initialValue : 0; }
                              else if (val === 'z.enum()') { patch.zodType = 'z.enum(["选项1","选项2"])'; patch.enumValues = v.enumValues ?? ['选项1', '选项2']; patch.initialValue = v.enumValues?.[0] ?? '选项1'; }
                              else if (val === 'z.boolean()') { patch.zodType = 'z.boolean()'; patch.initialValue = false; }
                              else if (val === 'z.record()') { patch.zodType = 'z.record(z.string(), z.any())'; patch.initialValue = {}; }
                              else if (val === 'z.array()') { patch.zodType = 'z.array(z.string())'; patch.initialValue = []; }
                              else { patch.zodType = 'z.string()'; patch.initialValue = typeof v.initialValue === 'string' ? v.initialValue : ''; }
                              updateVariable(sIdx, vIdx, patch);
                            }}
                            className={inputCls}
                          >
                            {VAR_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                        <div className="sm:col-span-3">
                          <label className={labelCls}>初始值</label>
                          <TextInput
                            value={typeof v.initialValue === 'object' ? JSON.stringify(v.initialValue) : String(v.initialValue ?? '')}
                            onChange={(e) => {
                              let val: unknown = e.target.value;
                              if (v.zodType === 'z.coerce.number()') val = e.target.value === '' ? 0 : Number(e.target.value);
                              else if (v.zodType === 'z.boolean()') val = e.target.value === 'true';
                              updateVariable(sIdx, vIdx, { initialValue: val });
                            }}
                            className={inputCls}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className={labelCls}>可见性</label>
                          <select value={v.prefix} onChange={(e) => updateVariable(sIdx, vIdx, { prefix: e.target.value as MvuPrefix })} className={inputCls}>
                            {PREFIX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 mt-2">
                        <div className="sm:col-span-7">
                          <label className={labelCls}>描述</label>
                          <TextInput value={v.description} onChange={(e) => updateVariable(sIdx, vIdx, { description: e.target.value })} className={inputCls} placeholder="变量用途说明" />
                        </div>
                        {v.zodType === 'z.coerce.number()' && (
                          <div className="sm:col-span-3 flex items-end gap-2">
                            <div className="flex-1">
                              <label className={labelCls}>最小值</label>
                              <TextInput value={String(v.range?.min ?? 0)} onChange={(e) => updateVariable(sIdx, vIdx, { range: { min: Number(e.target.value), max: v.range?.max ?? 100 } })} className={inputCls} />
                            </div>
                            <div className="flex-1">
                              <label className={labelCls}>最大值</label>
                              <TextInput value={String(v.range?.max ?? 100)} onChange={(e) => updateVariable(sIdx, vIdx, { range: { min: v.range?.min ?? 0, max: Number(e.target.value) } })} className={inputCls} />
                            </div>
                          </div>
                        )}
                        {v.zodType.startsWith('z.enum(') && (
                          <div className="sm:col-span-3">
                            <label className={labelCls}>枚举值（逗号分隔）</label>
                            <TextInput
                              value={(v.enumValues ?? []).join(',')}
                              onChange={(e) => {
                                const values = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                                updateVariable(sIdx, vIdx, { enumValues: values, zodType: `z.enum(${JSON.stringify(values)})`, initialValue: values.includes(String(v.initialValue)) ? v.initialValue : values[0] ?? '' });
                              }}
                              className={inputCls}
                            />
                          </div>
                        )}
                        <div className="sm:col-span-2 flex items-end">
                          <Button variant="danger" size="sm" onClick={() => removeVariable(sIdx, vIdx)} className="w-full">删除</Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <Button variant="ghost" size="sm" onClick={() => addVariable(sIdx)}>+ 添加变量</Button>
              </div>
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={addSection}>+ 添加分区</Button>
        </div>
      )}

      {/* ── Tab 2: 游戏元素（技能/功法）── */}
      {activeTab === 'elements' && (
        <div className="space-y-4">
          <p className="text-xs text-[var(--color-text-secondary)]">
            以可视化方式管理技能、功法等游戏元素，自动映射为 MVU 记录变量，可在状态栏中展示并由 AI 追踪更新。
          </p>
          {GAME_ELEMENT_CATEGORIES.map(cat => (
            <GameElementEditor
              key={cat.key}
              category={cat}
              elements={getElements(cat)}
              onChange={(els) => setElements(cat, els)}
            />
          ))}
        </div>
      )}

      {/* ── Tab 3: 更新规则 ── */}
      {activeTab === 'rules' && (
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-secondary)]">告诉 AI 如何更新变量。自明变量（名称即说明更新方式）可不写规则。</p>
          {mvu.updateRules.map((rule, idx) => (
            <div key={idx} className={cardCls}>
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                <div className="sm:col-span-3">
                  <label className={labelCls}>变量路径</label>
                  <TextInput
                    value={rule.path}
                    onChange={(e) => updateRule(idx, { path: e.target.value })}
                    className={inputCls}
                    placeholder="角色.好感度"
                    list="mvu-variable-paths"
                    error={validatePathFormat(rule.path) ?? undefined}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelCls}>类型</label>
                  <TextInput value={rule.type ?? ''} onChange={(e) => updateRule(idx, { type: e.target.value })} className={inputCls} placeholder="number / string" />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelCls}>格式</label>
                  <TextInput value={rule.format ?? ''} onChange={(e) => updateRule(idx, { format: e.target.value })} className={inputCls} placeholder="replace / delta" />
                </div>
                <div className="sm:col-span-3">
                  <label className={labelCls}>范围</label>
                  <TextInput value={rule.range ?? ''} onChange={(e) => updateRule(idx, { range: e.target.value })} className={inputCls} placeholder="0~100" />
                </div>
                <div className="sm:col-span-2 flex items-end">
                  <Button variant="danger" size="sm" onClick={() => removeRule(idx)} className="w-full">删除</Button>
                </div>
              </div>
              <div className="mt-2">
                <label className={labelCls}>更新条件（每行一条）</label>
                <TextArea
                  value={(rule.check ?? []).join('\n')}
                  onChange={(e) => updateRule(idx, { check: e.target.value.split('\n') })}
                  rows={2}
                  className={inputCls}
                  placeholder="正面互动增加，负面互动减少&#10;单次变化 ±(3~8)"
                />
              </div>
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={addRule}>+ 添加规则</Button>
        </div>
      )}

      {/* ── Tab 4: 状态栏 ── */}
      {activeTab === 'statusBar' && (
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-secondary)]">
            基于当前变量分区生成实时状态栏，配置与新手模式共用，支持模板、主题与实时预览。
          </p>
          <StatusBarConfigPanel mvu={mvu} onChange={onChange} />
        </div>
      )}
      </>)}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 游戏元素编辑器子组件（技能/功法 增删改查 + 图标）
// ════════════════════════════════════════════════════════════════════════════

const EMOJI_PRESETS = ['⚔️', '🔥', '❄️', '⚡', '🌪️', '☠️', '✨', '🛡️', '🏹', '🗡️', '💫', '🌟', '📿', '🧿', '☯️', '🔮', '📜', '🎯'];

function GameElementEditor({ category, elements, onChange }: {
  category: GameElementCategory;
  elements: GameElement[];
  onChange: (els: GameElement[]) => void;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  const addElement = () => {
    const next = [...elements, { name: '', icon: category.icon, level: '', description: '' }];
    onChange(next);
    setEditingIdx(next.length - 1);
  };
  const updateElement = (idx: number, patch: Partial<GameElement>) => {
    onChange(elements.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };
  const removeElement = (idx: number) => {
    onChange(elements.filter((_, i) => i !== idx));
    if (editingIdx === idx) setEditingIdx(null);
  };

  return (
    <div className={cardCls}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">{category.icon}</span>
        <h3 className="text-sm font-bold text-[var(--text-color)]">{category.label}</h3>
        <span className="text-xs text-[var(--color-text-muted)]">{elements.length} 项</span>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={addElement}>+ 添加{category.label}</Button>
      </div>

      {elements.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)] py-2">暂无{category.label}，点击右上添加。</p>
      )}

      <div className="space-y-2">
        {elements.map((el, idx) => (
          <div key={idx} className="rounded-lg border border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)] bg-[color-mix(in_srgb,var(--input-bg)_30%,transparent)] p-2.5">
            {editingIdx === idx ? (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                  <div className="sm:col-span-4">
                    <label className={labelCls}>名称</label>
                    <TextInput value={el.name} onChange={(e) => updateElement(idx, { name: e.target.value })} className={inputCls} placeholder={`${category.label}名称`} />
                  </div>
                  <div className="sm:col-span-3">
                    <label className={labelCls}>{category.levelLabel}</label>
                    <TextInput value={el.level} onChange={(e) => updateElement(idx, { level: e.target.value })} className={inputCls} placeholder="如：Lv.3 / 筑基期" />
                  </div>
                  <div className="sm:col-span-5">
                    <label className={labelCls}>图标</label>
                    <div className="flex items-center gap-1.5">
                      <TextInput value={el.icon} onChange={(e) => updateElement(idx, { icon: e.target.value })} className={`${inputCls} w-16 text-center`} />
                      <div className="flex flex-wrap gap-0.5">
                        {EMOJI_PRESETS.slice(0, 8).map(em => (
                          <button key={em} onClick={() => updateElement(idx, { icon: em })} className="text-base hover:scale-125 transition-transform leading-none">{em}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
                <div>
                  <label className={labelCls}>描述 / 效果</label>
                  <TextArea value={el.description} onChange={(e) => updateElement(idx, { description: e.target.value })} rows={2} className={inputCls} placeholder="效果说明" />
                </div>
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" onClick={() => setEditingIdx(null)}>完成</Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-2xl leading-none w-8 text-center">{el.icon || category.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--text-color)]">{el.name || '（未命名）'}</span>
                    {el.level && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--color-primary)_20%,transparent)] text-[var(--color-primary)]">{el.level}</span>}
                  </div>
                  {el.description && <p className="text-xs text-[var(--color-text-muted)] mt-0.5 truncate">{el.description}</p>}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setEditingIdx(idx)}>编辑</Button>
                <Button variant="danger" size="sm" onClick={() => removeElement(idx)}>删除</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
