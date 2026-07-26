/**
 * MultiCharTemplateModal - 多角色套模板生成器
 *
 * 流程：
 *   1. 选择模板（纯爱 / NTR / 可纯爱可NTR）
 *   2. AI 读世界书识别候选角色
 *   3. 用户勾选确认要套用的角色
 *   4. 为每个角色套用模板，生成「角色名前缀」变量组 + 阶段轴预览
 *      - 支持 AI 生成
 *      - 也支持一键直接复制模板变量组
 *   5. 在预览中可修改变量路径、描述、初始值、范围
 *   6. 应用到 MVU 配置
 */
import { useState, useEffect } from 'react';
import { Modal } from '../shared/Modal';
import { Button } from '../shared/Button';
import { useToast } from '../shared/Toast';
import { useTranslation } from '../../i18n/I18nContext';
import { useAIGenerate } from '../../hooks/useAIGenerate';
import { themeAlpha } from '../../constants/theme';
import { AIProgressPanel, type AIProgressStatus } from '../shared/AIProgressPanel';
import {
  buildSchemaTs,
  buildInitvarYaml,
  buildUpdateRulesYaml,
  buildEjsPreprocess,
  parseRangeString,
} from '../../services/mvu-builder';
import type { MvuConfig, MvuSchemaSection, MvuVariable, MvuUpdateRule, MvuPrefix, LorebookEntry } from '../../constants/defaults';
import {
  STAGED_TEMPLATE_CATEGORIES,
  getTemplatesByCategory,
  getStagedTemplateById,
  buildSectionForChar,
  buildRulesForChar,
  buildTemplateBlueprint as buildTemplateBlueprintFromData,
  type BeginnerTemplate,
} from './staged-templates';

/** 语义化颜色常量 */
const C = {
  text: 'var(--text-color)',
  secondary: 'var(--color-text-secondary)',
  muted: 'var(--color-text-muted)',
  border: 'var(--color-border-default)',
  surface: 'var(--color-surface-raised)',
  primary: 'var(--color-primary)',
  info: 'var(--color-info)',
  success: 'var(--color-status-success)',
  warning: 'var(--color-status-warning)',
} as const;
const surfaceA = (n: number) => `color-mix(in srgb, ${C.surface} ${n}%, transparent)`;
const borderA = (n: number) => `color-mix(in srgb, ${C.border} ${n}%, transparent)`;

interface DetectedCharacter {
  name: string;
  comment: string;
  summary: string;
  suitable: boolean;
  /** 用户勾选确认 */
  selected: boolean;
}

interface MultiCharTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 应用生成的 MVU 配置 */
  onApplyMvu: (mvu: MvuConfig) => void;
  /** 应用预生成的阶段轴信息（每个角色的阶段轴，供后续分阶段世界书使用） */
  onApplyStageAxes?: (axes: Array<{ characterName: string; axisPath: string }>, templateId: string) => void;
  cardName: string;
  /** 已有世界书条目（用于 AI 识别角色） */
  lorebookEntries: LorebookEntry[];
}

/** 从 sections 中找出每个角色的阶段轴变量 */
function computeStageAxes(
  sections: MvuSchemaSection[],
  chars: Array<{ name: string }>,
  axisVariableName: string,
): Array<{ characterName: string; axisPath: string }> {
  return chars.map((c) => {
    const section = sections.find((s) => s.name === c.name);
    const stageVar = section?.variables.find((v) =>
      v.categories && v.categories.length > 0,
    ) || section?.variables.find((v) =>
      v.zodType.startsWith('z.enum(') && (v.path.includes('阶段') || v.path.includes('路线') || v.path.includes('堕落')),
    );
    return { characterName: c.name, axisPath: stageVar?.path || `${c.name}.${axisVariableName}` };
  });
}

/** 用 sections + rules 重新组装 MvuConfig，并同步生成衍生内容 */
function rebuildMvu(sections: MvuSchemaSection[], updateRules: MvuUpdateRule[], templateId: string, base?: MvuConfig): MvuConfig {
  const preserved = base ?? {
    enabled: true,
    mode: 'beginner' as const,
    ejsConfigs: [],
    statusBarHtml: '',
    statusBarStyle: 'none',
  };
  return {
    ...preserved,
    enabled: true,
    mode: 'beginner',
    beginnerTemplateId: templateId,
    schemaSections: sections,
    updateRules,
    ejsConfigs: preserved.ejsConfigs ?? [],
    ejsPreprocessContent: buildEjsPreprocess([], sections),
    schemaTsContent: buildSchemaTs(sections),
    initvarYamlContent: buildInitvarYaml(sections),
    updateRulesYamlContent: buildUpdateRulesYaml(updateRules),
  };
}

export function MultiCharTemplateModal({
  isOpen, onClose, onApplyMvu, onApplyStageAxes, cardName, lorebookEntries,
}: MultiCharTemplateModalProps) {
  const { t } = useTranslation();
  const { detectCharacters, generateMultiCharVariables } = useAIGenerate();
  const { addToast } = useToast();

  const [templateId, setTemplateId] = useState<string>('pure-love');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('romance');
  const [step, setStep] = useState<'select' | 'detect' | 'preview'>('select');
  const [detecting, setDetecting] = useState(false);
  const [detectStatus, setDetectStatus] = useState<AIProgressStatus>('idle');
  const [characters, setCharacters] = useState<DetectedCharacter[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState<AIProgressStatus>('idle');
  const [previewMvu, setPreviewMvu] = useState<MvuConfig | null>(null);
  const [previewAxes, setPreviewAxes] = useState<Array<{ characterName: string; axisPath: string }>>([]);

  const template = getStagedTemplateById(templateId) as BeginnerTemplate | undefined;
  const templateName = template?.name || '';

  // 模态框打开时，同步大类到当前 templateId 所属大类（处理重开后 templateId 残留的情况）
  useEffect(() => {
    if (isOpen && template && template.categoryId !== selectedCategoryId) {
      setSelectedCategoryId(template.categoryId);
    }
  }, [isOpen]); // 故意只依赖 isOpen，避免切换大类时反向覆盖

  /** 构造已有世界书上下文（comment + content 截断） */
  const existingWorldbookContext = (() => {
    if (!lorebookEntries?.length) return '';
    return lorebookEntries
      .map((e) => `【${e.comment || '未命名'}】\n${(e.content || '').slice(0, 200)}`)
      .join('\n\n')
      .slice(0, 4000);
  })();

  /** Step 1: AI 识别角色 */
  const handleDetect = async () => {
    if (!existingWorldbookContext.trim()) {
      addToast('error', t('multiCharTemplate.needWorldbook'));
      return;
    }
    setDetecting(true);
    setDetectStatus('generating');
    try {
      const result = await detectCharacters(cardName, existingWorldbookContext, templateId, templateName);
      if (result.length === 0) {
        addToast('error', t('multiCharTemplate.noCharacters'));
        setDetectStatus('error');
        return;
      }
      // 默认勾选 suitable 的
      setCharacters(result.map((c) => ({ ...c, selected: c.suitable })));
      setStep('detect');
      setDetectStatus('done');
      addToast('success', t('multiCharTemplate.detectDone', { count: String(result.length) }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setDetectStatus('error');
      addToast('error', t('multiCharTemplate.detectFailed') + `: ${msg}`);
    } finally {
      setDetecting(false);
    }
  };

  /** 一键直接套用模板（不调用 AI），为每个已选角色复制模板变量组 */
  const handleCopyTemplate = () => {
    const selected = characters.filter((c) => c.selected);
    if (selected.length === 0) {
      addToast('error', t('multiCharTemplate.needSelect'));
      return;
    }
    if (!template) return;

    const sections: MvuSchemaSection[] = selected.map((c) => buildSectionForChar(template, c.name));
    const updateRules: MvuUpdateRule[] = selected.flatMap((c) => buildRulesForChar(template, c.name));
    const mvu = rebuildMvu(sections, updateRules, templateId);

    setPreviewMvu(mvu);
    setPreviewAxes(computeStageAxes(sections, selected, template.axisVariableName));
    setStep('preview');
    addToast('success', t('multiCharTemplate.copyTemplateDone'));
  };

  /** Step 2: 生成多角色变量（AI 方式） */
  const handleGenerate = async () => {
    const selected = characters.filter((c) => c.selected);
    if (selected.length === 0) {
      addToast('error', t('multiCharTemplate.needSelect'));
      return;
    }
    setGenerating(true);
    setGenStatus('generating');
    try {
      if (!template) {
        addToast('error', t('multiCharTemplate.generateFailed'));
        setGenStatus('error');
        return;
      }
      const blueprint = buildTemplateBlueprintFromData(template);
      const result = await generateMultiCharVariables(
        cardName, templateId, templateName, blueprint,
        selected.map((c) => ({ name: c.name, summary: c.summary })),
        existingWorldbookContext,
      );
      if (!result) {
        addToast('error', t('multiCharTemplate.generateFailed'));
        setGenStatus('error');
        return;
      }
      // 解析 sections
      const sections: MvuSchemaSection[] = (result.sections as Array<Record<string, unknown>>).map((s) => ({
        name: String(s.name || ''),
        variables: ((s.variables as Array<Record<string, unknown>>) || []).map((v) => {
          const type = String(v.type || 'string');
          let zodType = 'z.string()';
          let enumValues: string[] | undefined;
          let range: { min: number; max: number } | undefined;
          let categories: Array<{ range: string; label: string }> | undefined;
          let initialValue: unknown = v.initialValue ?? '';
          if (type === 'number') {
            zodType = 'z.coerce.number()';
            const rm = v.rangeMin != null && v.rangeMax != null
              ? { min: Number(v.rangeMin), max: Number(v.rangeMax) }
              : parseRangeString(v.range);
            range = rm || { min: 0, max: 100 };
            initialValue = isNaN(Number(initialValue)) ? 0 : Number(initialValue);
            // 解析 categories（数值阈值型阶段轴的分段信息）
            if (Array.isArray(v.categories)) {
              categories = (v.categories as Array<Record<string, unknown>>)
                .map((c) => ({
                  range: String(c.range || ''),
                  label: String(c.label || ''),
                }))
                .filter((c) => c.range && c.label);
            }
          } else if (type === 'enum') {
            const ev = Array.isArray(v.enumValues) ? v.enumValues.map(String) : [];
            enumValues = ev;
            zodType = ev.length > 0 ? `z.enum(${JSON.stringify(ev)})` : 'z.string()';
            if (ev.length > 0 && !ev.includes(String(initialValue))) initialValue = ev[0];
          } else if (type === 'boolean') {
            zodType = 'z.boolean()';
            initialValue = initialValue === true || initialValue === 'true';
          }
          return {
            path: String(v.path || ''),
            zodType,
            description: String(v.description || ''),
            prefix: (String(v.prefix || '') as MvuPrefix) || ('' as MvuPrefix),
            initialValue,
            range,
            enumValues,
            categories,
          };
        }),
      }));
      // 解析 updateRules
      const updateRules: MvuUpdateRule[] = (result.updateRules as Array<Record<string, unknown>>).map((r) => ({
        path: String(r.path || ''),
        type: r.type ? String(r.type) : undefined,
        range: r.range ? String(r.range) : undefined,
        check: Array.isArray(r.check) ? r.check.map(String) : undefined,
      }));
      const mvu = rebuildMvu(sections, updateRules, templateId);
      setPreviewMvu(mvu);
      setPreviewAxes(computeStageAxes(sections, selected, template?.axisVariableName || '情感天平'));
      setStep('preview');
      setGenStatus('done');
      addToast('success', t('multiCharTemplate.generateDone'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setGenStatus('error');
      addToast('error', t('multiCharTemplate.generateFailed') + `: ${msg}`);
    } finally {
      setGenerating(false);
    }
  };

  /** 预览阶段：修改分区名称（同时同步该分区下所有变量路径与更新规则） */
  const updatePreviewSection = (idx: number, updates: Partial<MvuSchemaSection>) => {
    if (!previewMvu) return;
    const oldSection = previewMvu.schemaSections[idx];
    const newName = updates.name ?? oldSection.name;

    let newSections = previewMvu.schemaSections.map((s, i) => (i === idx ? { ...s, ...updates } : s));
    let newRules = previewMvu.updateRules;

    if (updates.name && oldSection.name !== newName) {
      newSections = newSections.map((s, i) => {
        if (i !== idx) return s;
        return {
          ...s,
          variables: s.variables.map((v) => {
            const suffix = v.path.startsWith(`${oldSection.name}.`)
              ? v.path.slice(oldSection.name.length + 1)
              : v.path;
            return { ...v, path: `${newName}.${suffix}` };
          }),
        };
      });
      newRules = previewMvu.updateRules.map((r) => {
        const suffix = r.path.startsWith(`${oldSection.name}.`)
          ? r.path.slice(oldSection.name.length + 1)
          : r.path;
        return { ...r, path: `${newName}.${suffix}` };
      });
    }

    setPreviewMvu(rebuildMvu(newSections, newRules, templateId));
    setPreviewAxes(computeStageAxes(newSections, characters.filter((c) => c.selected), template?.axisVariableName || '情感天平'));
  };

  /** 预览阶段：修改某个变量 */
  const updatePreviewVariable = (sectionIdx: number, varIdx: number, updates: Partial<MvuVariable>) => {
    if (!previewMvu) return;
    const oldVar = previewMvu.schemaSections[sectionIdx].variables[varIdx];

    const newSections = previewMvu.schemaSections.map((s, si) => {
      if (si !== sectionIdx) return s;
      return {
        ...s,
        variables: s.variables.map((v, vi) => (vi === varIdx ? { ...v, ...updates } : v)),
      };
    });

    let newRules = previewMvu.updateRules;
    if (updates.path && oldVar.path !== updates.path) {
      newRules = previewMvu.updateRules.map((r) =>
        r.path === oldVar.path ? { ...r, path: updates.path as string } : r,
      );
    }

    setPreviewMvu(rebuildMvu(newSections, newRules, templateId));
    setPreviewAxes(computeStageAxes(newSections, characters.filter((c) => c.selected), template?.axisVariableName || '情感天平'));
  };

  /** 预览阶段：删除某个变量 */
  const removePreviewVariable = (sectionIdx: number, varIdx: number) => {
    if (!previewMvu) return;
    const removed = previewMvu.schemaSections[sectionIdx].variables[varIdx];
    const newSections = previewMvu.schemaSections.map((s, si) => {
      if (si !== sectionIdx) return s;
      return { ...s, variables: s.variables.filter((_, vi) => vi !== varIdx) };
    });
    const newRules = previewMvu.updateRules.filter((r) => r.path !== removed.path);
    setPreviewMvu(rebuildMvu(newSections, newRules, templateId));
    setPreviewAxes(computeStageAxes(newSections, characters.filter((c) => c.selected), template?.axisVariableName || '情感天平'));
  };

  /** 应用到 MVU 配置 */
  const handleApply = () => {
    if (!previewMvu) return;
    onApplyMvu(previewMvu);
    if (onApplyStageAxes && previewAxes.length) {
      onApplyStageAxes(previewAxes, templateId);
    }
    addToast('success', t('multiCharTemplate.applyDone'));
    onClose();
    // 重置
    setStep('select');
    setCharacters([]);
    setPreviewMvu(null);
    setPreviewAxes([]);
  };

  const fieldCls = 'w-full rounded border border-[var(--input-border)] px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('multiCharTemplate.title')} maxWidth="max-w-3xl">
      <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
        {/* 说明 */}
        <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed" style={{ borderColor: themeAlpha('info', 40), backgroundColor: themeAlpha('info', 20), color: C.info }}>
          {t('multiCharTemplate.intro')}
        </div>

        {/* Step 1: 选模板 + AI 识别角色 */}
        <div className="rounded-lg border p-3 space-y-3" style={{ borderColor: borderA(50) }}>
          <p className="text-xs font-medium" style={{ color: C.text }}>{t('multiCharTemplate.step1Title')}</p>
          {/* 大类选择 */}
          <div className="flex flex-wrap gap-1.5">
            {STAGED_TEMPLATE_CATEGORIES.map((cat) => {
              const isActive = selectedCategoryId === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                  setSelectedCategoryId(cat.id);
                  // 若当前 templateId 不属于该大类，自动选中该大类第一个模板
                  const catTemplates = getTemplatesByCategory(cat.id);
                  if (catTemplates.length > 0 && !catTemplates.find(t => t.id === templateId)) {
                    setTemplateId(catTemplates[0].id);
                  }
                }}
                  className={`rounded-md border px-2.5 py-1 text-[11px] transition ${
                    isActive
                      ? 'border-[var(--color-primary)] text-[var(--text-color)]'
                      : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[color-mix(in_srgb,var(--color-border-default)_80%,transparent)]'
                  }`}
                  style={{ backgroundColor: isActive ? themeAlpha('primary', 30) : surfaceA(30) }}
                  title={cat.description}
                >
                  {cat.icon} {cat.name}
                </button>
              );
            })}
          </div>
          {/* 子模板选择（当前大类下） */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {getTemplatesByCategory(selectedCategoryId).map((tmpl) => (
              <button
                key={tmpl.id}
                type="button"
                onClick={() => setTemplateId(tmpl.id)}
                className={`rounded-lg border p-2.5 text-left transition ${
                  templateId === tmpl.id
                    ? 'border-[var(--color-primary)] text-[var(--text-color)]'
                    : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[color-mix(in_srgb,var(--color-border-default)_80%,transparent)]'
                }`}
                style={{ backgroundColor: templateId === tmpl.id ? themeAlpha('primary', 30) : surfaceA(30) }}
                title={tmpl.description}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-lg">{tmpl.icon}</span>
                  <span className="text-xs font-medium">{tmpl.name}</span>
                </div>
                <p className="text-[10px] mt-1" style={{ color: C.muted }}>{tmpl.description}</p>
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={handleDetect} disabled={detecting || generating}>
            {detecting ? t('multiCharTemplate.detecting') : `🔍 ${t('multiCharTemplate.detectButton')}`}
          </Button>
          {detectStatus !== 'idle' && detectStatus !== 'done' && (
            <AIProgressPanel status={detectStatus} text="" />
          )}
        </div>

        {/* Step 2: 角色确认 */}
        {step === 'detect' && characters.length > 0 && (
          <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: borderA(50) }}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium" style={{ color: C.text }}>{t('multiCharTemplate.step2Title')}</p>
              <span className="text-[10px]" style={{ color: C.muted }}>
                {t('multiCharTemplate.selectedCount', { count: String(characters.filter((c) => c.selected).length) })}
              </span>
            </div>
            <div className="space-y-1">
              {characters.map((c, idx) => (
                <label
                  key={idx}
                  className={`flex items-start gap-2 p-2 rounded border cursor-pointer ${
                    c.selected
                      ? 'border-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-primary)_20%,transparent)]'
                      : 'border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-surface-raised)_30%,transparent)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={c.selected}
                    onChange={(e) => setCharacters(characters.map((x, i) => i === idx ? { ...x, selected: e.target.checked } : x))}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium" style={{ color: C.text }}>{c.name}</span>
                      {!c.suitable && <span className="text-[10px]" style={{ color: C.warning }}>⚠ {t('multiCharTemplate.notSuitable')}</span>}
                    </div>
                    <p className="text-[11px]" style={{ color: C.secondary }}>{c.summary}</p>
                    {c.comment && <p className="text-[10px] mt-0.5" style={{ color: C.muted }}>来源：{c.comment}</p>}
                  </div>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={handleGenerate} disabled={generating}>
                {generating ? t('multiCharTemplate.generating') : `✨ ${t('multiCharTemplate.generateButton')}`}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCopyTemplate} disabled={generating}>
                📋 {t('multiCharTemplate.copyTemplateButton')}
              </Button>
              {genStatus !== 'idle' && genStatus !== 'done' && (
                <AIProgressPanel status={genStatus} text="" />
              )}
            </div>
            <p className="text-[10px]" style={{ color: C.muted }}>
              {t('multiCharTemplate.copyTemplateHint')}
            </p>
          </div>
        )}

        {/* Step 3: 预览 */}
        {step === 'preview' && previewMvu && (
          <div className="rounded-lg border p-3 space-y-3" style={{ borderColor: borderA(50) }}>
            <p className="text-xs font-medium" style={{ color: C.text }}>{t('multiCharTemplate.step3Title')}</p>
            <p className="text-[10px]" style={{ color: C.muted }}>
              {t('multiCharTemplate.editHint')}
            </p>
            {/* 变量预览 / 编辑 */}
            <div className="space-y-2">
              {previewMvu.schemaSections.map((section, sIdx) => (
                <div key={sIdx} className="rounded border p-2" style={{ borderColor: borderA(40), backgroundColor: surfaceA(30) }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px]" style={{ color: C.muted }}>角色分区</span>
                    <input
                      value={section.name}
                      onChange={(e) => updatePreviewSection(sIdx, { name: e.target.value })}
                      className={`${fieldCls} max-w-[200px]`}
                    />
                  </div>
                  <div className="space-y-1">
                    {section.variables.map((v, vIdx) => {
                      const isNumber = v.zodType === 'z.coerce.number()';
                      const isEnum = v.zodType.startsWith('z.enum(');
                      const isBoolean = v.zodType === 'z.boolean()';
                      const typeLabel = isNumber ? 'number' : isEnum ? 'enum' : isBoolean ? 'boolean' : 'string';
                      return (
                        <div key={vIdx} className="rounded border p-2" style={{ borderColor: borderA(30), backgroundColor: surfaceA(20) }}>
                          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                            <div className="sm:col-span-4">
                              <label className="text-[10px] block mb-0.5" style={{ color: C.muted }}>变量路径</label>
                              <input
                                value={v.path}
                                onChange={(e) => updatePreviewVariable(sIdx, vIdx, { path: e.target.value })}
                                className={fieldCls}
                              />
                            </div>
                            <div className="sm:col-span-5">
                              <label className="text-[10px] block mb-0.5" style={{ color: C.muted }}>描述</label>
                              <input
                                value={v.description}
                                onChange={(e) => updatePreviewVariable(sIdx, vIdx, { description: e.target.value })}
                                className={fieldCls}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="text-[10px] block mb-0.5" style={{ color: C.muted }}>初始值</label>
                              <input
                                value={String(v.initialValue ?? '')}
                                onChange={(e) => {
                                  let val: unknown = e.target.value;
                                  if (isNumber) {
                                    const parsed = e.target.value === '' ? 0 : Number(e.target.value);
                                    val = Number.isNaN(parsed) ? v.initialValue : parsed;
                                  } else if (isBoolean) val = e.target.value === 'true';
                                  updatePreviewVariable(sIdx, vIdx, { initialValue: val });
                                }}
                                className={fieldCls}
                              />
                            </div>
                            <div className="sm:col-span-1">
                              <Button variant="danger" size="sm" onClick={() => removePreviewVariable(sIdx, vIdx)}>×</Button>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 mt-1.5">
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: surfaceA(80), color: C.secondary }}>{typeLabel}</span>
                            {v.prefix && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: themeAlpha('warning', 40), color: C.warning }}>{v.prefix}前缀</span>}
                            {isNumber && v.range && (
                              <span className="text-[10px]" style={{ color: C.muted }}>
                                范围 {v.range.min}~{v.range.max}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {/* 阶段轴预览：展示每个角色的阶段轴变量及其 categories 阶段划分 */}
            {previewAxes.length > 0 && (
              <div className="rounded border p-2" style={{ borderColor: themeAlpha('success', 30), backgroundColor: themeAlpha('success', 10) }}>
                <p className="text-[11px] mb-1" style={{ color: C.success }}>{t('multiCharTemplate.stageAxesPreview')}</p>
                {previewAxes.map((a, i) => {
                  const section = previewMvu.schemaSections.find((s) => s.name === a.characterName);
                  const axisVar = section?.variables.find((v) => v.path === a.axisPath);
                  const cats = axisVar?.categories;
                  return (
                    <div key={i} className="text-[11px] mb-1.5" style={{ color: C.secondary }}>
                      <span style={{ color: C.text }}>{a.characterName}</span> → <code style={{ color: C.success }}>{a.axisPath}</code>
                      {axisVar?.range && (
                        <span className="ml-1" style={{ color: C.muted }}>[{axisVar.range.min}~{axisVar.range.max}]</span>
                      )}
                      {cats && cats.length > 0 && (
                        <div className="mt-0.5 ml-3 flex flex-wrap gap-1">
                          {cats.map((c, ci) => (
                            <span key={ci} className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: surfaceA(60) }}>
                              <code style={{ color: C.warning }}>{c.range}</code>
                              <span className="ml-1" style={{ color: C.secondary }}>{c.label}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[10px]" style={{ color: C.muted }}>{t('multiCharTemplate.previewHint')}</p>
          </div>
        )}

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t" style={{ borderColor: borderA(40) }}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={detecting || generating}>{t('common.cancel')}</Button>
          {step === 'preview' && (
            <Button variant="primary" size="sm" onClick={handleApply} disabled={detecting || generating}>
              {t('multiCharTemplate.applyButton')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
