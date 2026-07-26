/**
 * StepStagedMode - 分阶段模式（步骤6，可选启用）
 *
 * 参考卡「高考冲刺100天」的写卡流程：
 *   1. 选剧情模板（按大类→子模板两层选择：恋爱型/成长突破型/冒险剧情型/黑化堕落型/悬疑推理型）
 *   2. AI 读已有世界书 + MVU 变量 + 用户要求，为每个适合的角色剖析阶段框架
 *      （选阶段轴变量、划阈值区间、给每个阶段写人设/剧情注解）
 *   3. 用户可修改阈值、对单个阶段重 roll 注解
 *   4. AI 为每个阶段生成详细人设/剧情子条目内容
 *   5. 应用 → 生成参考卡风格的 EJS 调度条目 + N 个 disabled 子条目，合并到世界书
 *
 * 调度条目用 if/else if + getWorldInfo() 互斥拉取子条目，
 * 变量达到阈值开启对应阶段世界书，关闭过去阶段的世界书。
 */
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Button } from '../shared/Button';
import { Modal } from '../shared/Modal';
import { TextInput } from '../shared/TextInput';
import { TextArea } from '../shared/TextArea';
import { useToast } from '../shared/Toast';
import { useTranslation } from '../../i18n/I18nContext';
import { useAIGenerate } from '../../hooks/useAIGenerate';
import { AIProgressPanel, type AIProgressStatus } from '../shared/AIProgressPanel';
import {
  buildStagedLorebookEntries,
  sortStagesByDirection,
  type StagedLorebookConfig,
  type StageDefinition,
} from '../../services/staged-lorebook-builder';
import type {
  StagedModeConfig,
  StagedModeCharacter,
  StagedModeStage,
  MvuConfig,
  StatusBarOptions,
  LorebookEntry,
} from '../../constants/defaults';
// StatusBarOptions is now exported from defaults.ts (re-declared there to match this usage)
import { createEmptyMvuConfig } from '../../constants/defaults';
import {
  getStagedTemplateById,
  mergeStagedTemplate,
  mergeDiyStagedAxis,
  sanitizeStageName,
  STAGED_TEMPLATE_CATEGORIES,
  getTemplatesByCategory,
} from './staged-templates';
import {
  STATUS_BAR_TEMPLATES,
  STATUS_BAR_THEMES,
  generateStatusBarHtml,
} from '../../services/status-bar-templates';
import { MultiCharTemplateModal } from './MultiCharTemplateModal';
import { StageDispatchSimulator } from './StageDispatchSimulator';

interface StepStagedModeProps {
  stagedMode: StagedModeConfig;
  onChange: (config: StagedModeConfig) => void;
  cardName: string;
  /** 导出书名（resolveBookName 的结果）。调度条目 getWorldInfo 的第一个参数必须
   *  与导出的 character_book.name 一致，否则 ST 里「阶段不切换」。 */
  bookName: string;
  mvu?: MvuConfig;
  /** 分阶段步骤内部填充 MVU 变量配置（选中模板时调用，取代独立的 MVU 变量步骤） */
  onMvuChange?: (mvu: MvuConfig) => void;
  lorebookEntries: LorebookEntry[];
  onApplyEntries: (entries: LorebookEntry[]) => void;
  /** 多角色套模板时，将各角色阶段轴写入 stagedMode.characters（原第5步回调，现归属分阶段步骤） */
  onApplyStageAxes?: (axes: Array<{ characterName: string; axisPath: string }>, templateId: string) => void;
  nsfw?: boolean;
  onNsfwChange?: (nsfw: boolean) => void;
}

export function StepStagedMode({
  stagedMode, onChange, cardName, bookName, mvu, onMvuChange, lorebookEntries, onApplyEntries, onApplyStageAxes, nsfw = false, onNsfwChange,
}: StepStagedModeProps) {
  const { t } = useTranslation();
  const { analyzeStages, rerollStageAnnotation, generateStageEntries, rerollStage, autoGenerateStagedLorebook } = useAIGenerate();
  const { addToast } = useToast();

  const [userRequirement, setUserRequirement] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeStatus, setAnalyzeStatus] = useState<AIProgressStatus>('idle');
  const [diyGenerating, setDiyGenerating] = useState(false);
  const [diyStatus, setDiyStatus] = useState<AIProgressStatus>('idle');
  const [analyzingCharIdx, setAnalyzingCharIdx] = useState<number | null>(null);
  const [generatingEntries, setGeneratingEntries] = useState(false);
  const [genStatus, setGenStatus] = useState<AIProgressStatus>('idle');
  const [genProgress, setGenProgress] = useState('');
  const [rerollingAnnotationKey, setRerollingAnnotationKey] = useState<string | null>(null);
  const [rerollingContentKey, setRerollingContentKey] = useState<string | null>(null);
  const [rerollGuidance, setRerollGuidance] = useState<Record<string, string>>({});
  const [charGuidance, setCharGuidance] = useState<Record<number, string>>({});
  const [openCharacterGroups, setOpenCharacterGroups] = useState<Set<number>>(new Set());
  const [showMultiCharModal, setShowMultiCharModal] = useState(false);
  const [showStatusBarPreview, setShowStatusBarPreview] = useState(false);
  const [previewState, setPreviewState] = useState<'normal' | 'app' | 'notice' | 'settings'>('normal');
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(() => {
    const tpl = getStagedTemplateById(stagedMode.templateId as string);
    return tpl?.categoryId ?? 'romance';
  });

  // 当 templateId 外部变化时，同步大类选择
  useEffect(() => {
    const tpl = getStagedTemplateById(stagedMode.templateId as string);
    if (tpl && tpl.categoryId !== selectedCategoryId) {
      setSelectedCategoryId(tpl.categoryId);
    }
    // 故意只依赖 templateId，避免切大类时反向覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedMode.templateId]);

  /** 当前是否处于 DIY（AI 自选阶段轴）模式——此时没有模板，getStagedTemplateById 恒空 */
  const isDiyMode = stagedMode.templateId === 'diy';

  /** 切换大类：若当前 templateId 不属于该大类，自动选中该大类第一个模板 */
  const handleSelectCategory = (categoryId: string) => {
    setSelectedCategoryId(categoryId);
    // DIY 模式下只切换浏览用的大类，不改 templateId：否则「随手点一下大类标签」
    // 会静默把 DIY 换成模板，并往 MVU 注入一个用不上的模板轴变量
    if (isDiyMode) return;
    const catTemplates = getTemplatesByCategory(categoryId);
    if (catTemplates.length > 0) {
      const current = getStagedTemplateById(stagedMode.templateId as string);
      if (!current || current.categoryId !== categoryId) {
        selectTemplate(catTemplates[0].id, !stagedMode.enabled);
      }
    }
  };

  // ── 构造 MVU 变量上下文 ──────────────────────────────────
  const mvuVariablesContext = useMemo(() => {
    if (!mvu?.enabled || !mvu.schemaSections?.length) return '';
    return mvu.schemaSections
      .map((section) => {
        const vars = section.variables
          .map((v) => {
            const type = v.zodType.startsWith('z.enum(') ? 'enum' : v.zodType.includes('number') ? 'number' : 'string';
            const range = v.range ? ` [${v.range.min}~${v.range.max}]` : '';
            return `  - ${v.path} (${type}${range}): ${v.description}`;
          })
          .join('\n');
        return `[${section.name}]\n${vars}`;
      })
      .join('\n');
  }, [mvu]);

  // ── 构造已有世界书上下文 ──────────────────────────────────
  const existingWorldbookContext = useMemo(() => {
    if (!lorebookEntries?.length) return '';
    const lines = lorebookEntries
      .filter((e) => e.comment && e.content)
      .slice(0, 30)
      .map((e) => {
        const content = (e.content || '').slice(0, 200);
        return `【${e.comment}】\n${content}`;
      });
    return lines.join('\n---\n').slice(0, 4000);
  }, [lorebookEntries]);

  // ── 启用/禁用 ─────────────────────────────────────────────
  const toggleEnabled = () => onChange({ ...stagedMode, enabled: !stagedMode.enabled });

  // ── 选择分阶段模板：合并阶段轴变量进已有 MVU 配置（保留第5步定义的变量）──
  const selectTemplate = (templateId: string, enable = false) => {
    const template = getStagedTemplateById(templateId);
    if (template && onMvuChange) {
        // 分阶段模板只负责阶段轴变量；状态栏由 MVU 变量步骤统一管理，避免两条流程互相覆盖。
        const merged = mergeStagedTemplate(mvu ?? createEmptyMvuConfig(), template);
        onMvuChange(merged);
      }
    onChange({ ...stagedMode, templateId: templateId as StagedModeConfig['templateId'], enabled: enable ? true : stagedMode.enabled });
  };

  // ── 状态栏配置更新：切换模板/主题/选项并重生成 HTML ──
  const updateStatusBar = (patch: { style?: string; options?: Partial<StatusBarOptions>; html?: string }) => {
    if (!onMvuChange) return;
    const base = mvu ?? createEmptyMvuConfig();
    const style = patch.style ?? base.statusBarStyle ?? 'none';
    const options = { ...(base.statusBarOptions ?? {}), ...(patch.options ?? {}) };
    let html = patch.html ?? base.statusBarHtml ?? '';
    if (style && style !== 'none' && style !== 'ai-custom') {
      html = generateStatusBarHtml(style, base.schemaSections, options);
    } else if (style === 'none') {
      html = '';
    }
    onMvuChange({ ...base, statusBarStyle: style, statusBarOptions: options, statusBarHtml: html });
  };

  // ── 状态栏预览：独立窗口使用模拟状态覆盖实时刷新 ──
  const previewValues = useMemo(() => {
    const values: Record<string, unknown> = {};
    const vars = (mvu?.schemaSections ?? []).flatMap((s) => s.variables);
    vars.forEach((v, index) => {
      let value = v.initialValue;
      if (previewState === 'app' && v.range) {
        value = v.range.min + (v.range.max - v.range.min) * (index % 2 === 0 ? 0.72 : 0.38);
      } else if (previewState === 'settings' && v.zodType === 'z.boolean()') {
        value = true;
      } else if (previewState === 'settings' && v.zodType.startsWith('z.enum(') && v.enumValues?.length) {
        value = v.enumValues[v.enumValues.length - 1];
      }
      values[`stat_data.${v.path}`] = value;
    });
    return values;
  }, [mvu?.schemaSections, previewState]);

  const previewNotice = previewState === 'notice'
    ? '新通知'
    : previewState === 'app'
      ? '应用切换'
      : previewState === 'settings'
        ? '设置已更新'
        : '';

  const statusBarSrcDoc = useMemo(() => {
    const style = mvu?.statusBarStyle ?? 'none';
    if (style === 'none') return '';
    if (style === 'ai-custom') {
      const html = mvu?.statusBarHtml ?? '';
      return html.trim().replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
    }
    const options = {
      ...(mvu?.statusBarOptions ?? {}),
      previewValues,
      previewNotice,
    };
    return generateStatusBarHtml(style, mvu?.schemaSections ?? [], options)
      .trim().replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
  }, [mvu?.statusBarStyle, mvu?.statusBarHtml, mvu?.statusBarOptions, mvu?.schemaSections, previewValues, previewNotice]);

  const toggleCharacterGroup = (charIdx: number) => {
    setOpenCharacterGroups(prev => {
      const next = new Set(prev);
      if (next.has(charIdx)) next.delete(charIdx);
      else next.add(charIdx);
      return next;
    });
  };

  // ── Step 1: AI 剖析阶段框架 ────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (!mvuVariablesContext) {
      addToast('error', t('stagedMode.needMvu'));
      return;
    }
    if (!lorebookEntries?.length) {
      addToast('error', t('stagedMode.needWorldbook'));
      return;
    }
    setAnalyzing(true);
    setAnalyzeStatus('generating');
    try {
      const result = await analyzeStages(
        cardName, stagedMode.templateId, existingWorldbookContext, mvuVariablesContext, userRequirement.trim(),
      );
      if (!result || result.length === 0) {
        addToast('error', t('stagedMode.analyzeFailed'));
        setAnalyzeStatus('error');
        return;
      }
      const characters: StagedModeCharacter[] = result.map((c) => ({
        name: c.name,
        sourceComment: c.sourceComment,
        summary: c.summary,
        axisPath: c.axisPath,
        axisType: c.axisType,
        numericDirection: c.numericDirection,
        stages: c.stages.map((s) => ({ name: s.name, condition: s.condition, annotation: s.annotation })),
      }));
      onChange({ ...stagedMode, characters });
      setCharGuidance({});
      setAnalyzeStatus('done');
      addToast('success', t('stagedMode.analyzeDone', { count: String(characters.length) }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setAnalyzeStatus('error');
      addToast('error', t('stagedMode.analyzeFailed') + `: ${msg}`);
    } finally {
      setAnalyzing(false);
    }
  }, [analyzeStages, cardName, stagedMode, existingWorldbookContext, mvuVariablesContext, userRequirement, lorebookEntries, onChange, addToast, t]);

  // ── DIY：AI 自选阶段轴（不套模板，通读世界书自行设计变化轴与阶段内容）──
  // 这条管线（AUTO_STAGED_LOREBOOK_PROMPT + autoGenerateStagedLorebook）此前
  // 已完整实现但无任何调用者——阶段轴被 7 个模板硬编码占满。现在接上入口。
  const handleDiyGenerate = useCallback(async () => {
    setDiyGenerating(true);
    setDiyStatus('generating');
    try {
      const result = await autoGenerateStagedLorebook(
        cardName, '', existingWorldbookContext, userRequirement.trim(), nsfw,
      );
      if (!result || !result.stages.length) {
        setDiyStatus('error');
        addToast('error', t('stagedMode.diyFailed'));
        return;
      }
      // 阶段名先净化再分发到「枚举值」与「调度条件」两侧，避免半角逗号等字符
      // 打断 z.enum 字面量、让两侧的阶段名漂移（阶段永不命中）
      const sanitized = {
        ...result,
        stages: result.stages.map((s) => {
          const name = sanitizeStageName(s.name) || '阶段';
          return {
            ...s,
            name,
            // enum 轴的条件里嵌着阶段名，跟着一起净化；数值条件不含名字，原样保留
            condition: result.axisType === 'enum' ? `=== '${name.replace(/'/g, '')}'` : s.condition || '',
          };
        }),
      };
      // 轴变量并入 MVU（不覆盖已有变量）：没有它，真实运行时轴变量未初始化，
      // 调度条目永远走「变量未定义」分支
      if (onMvuChange) {
        onMvuChange(mergeDiyStagedAxis(mvu ?? createEmptyMvuConfig(), sanitized));
      }
      const diyCharacter: StagedModeCharacter = {
        name: cardName || 'DIY',
        summary: t('stagedMode.diySummary'),
        axisPath: sanitized.axisPath,
        axisType: sanitized.axisType,
        numericDirection: sanitized.numericDirection,
        stages: sanitized.stages.map((s) => ({
          name: s.name,
          condition: s.condition || '',
          annotation: '',
          content: s.content || '',
        })),
      };
      onChange({ ...stagedMode, templateId: 'diy', enabled: true, characters: [diyCharacter] });
      setCharGuidance({});
      setDiyStatus('done');
      addToast('success', t('stagedMode.diyDone', { axis: sanitized.axisPath, count: String(sanitized.stages.length) }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setDiyStatus('error');
      addToast('error', t('stagedMode.diyFailed') + `: ${msg}`);
    } finally {
      setDiyGenerating(false);
    }
  }, [autoGenerateStagedLorebook, cardName, existingWorldbookContext, userRequirement, nsfw, mvu, onMvuChange, stagedMode, onChange, addToast, t]);

  // ── 修改阶段阈值/名称 ─────────────────────────────────────
  const updateStage = (charIdx: number, stageIdx: number, patch: Partial<StagedModeStage>) => {
    const characters = stagedMode.characters.map((c, ci) => {
      if (ci !== charIdx) return c;
      return { ...c, stages: c.stages.map((s, si) => (si === stageIdx ? { ...s, ...patch } : s)) };
    });
    onChange({ ...stagedMode, characters });
  };

  // ── 重 roll 单个阶段注解 ──────────────────────────────────
  const handleRerollAnnotation = async (charIdx: number, stageIdx: number) => {
    const character = stagedMode.characters[charIdx];
    const stage = character.stages[stageIdx];
    const key = `${charIdx}-${stageIdx}`;
    setRerollingAnnotationKey(key);
    try {
      const guidance = (rerollGuidance[key] || '').trim();
      const newAnnotation = await rerollStageAnnotation(
        cardName, stagedMode.templateId, character.name, character.summary,
        character.axisPath, stage.name, stage.condition, existingWorldbookContext, guidance,
      );
      if (!newAnnotation) {
        addToast('error', t('stagedMode.rerollFailed'));
        return;
      }
      updateStage(charIdx, stageIdx, { annotation: newAnnotation });
      addToast('success', t('stagedMode.rerollAnnotationDone'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      addToast('error', t('stagedMode.rerollFailed') + `: ${msg}`);
    } finally {
      setRerollingAnnotationKey(null);
    }
  };

  // ── 重 roll 单个阶段世界书内容 ────────────────────────────
  const handleRerollContent = async (charIdx: number, stageIdx: number) => {
    const character = stagedMode.characters[charIdx];
    const stage = character.stages[stageIdx];
    const key = `${charIdx}-${stageIdx}`;
    setRerollingContentKey(key);
    try {
      const guidance = (rerollGuidance[key] || '').trim();
      const siblingStages = character.stages
        .filter((_, si) => si !== stageIdx)
        .map((s) => ({ name: s.name, content: s.content }));
      const newContent = await rerollStage(
        cardName, character.summary, character.axisPath, stage.name, stage.condition,
        siblingStages, existingWorldbookContext, guidance, nsfw,
      );
      if (!newContent) {
        addToast('error', t('stagedMode.rerollFailed'));
        return;
      }
      updateStage(charIdx, stageIdx, { content: newContent });
      addToast('success', t('stagedMode.rerollContentDone'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      addToast('error', t('stagedMode.rerollFailed') + `: ${msg}`);
    } finally {
      setRerollingContentKey(null);
    }
  };

  // ── Step 2: 为单个角色生成所有阶段的子条目内容 ─────────────
  const handleGenerateEntriesForChar = useCallback(async (charIdx: number) => {
    const character = stagedMode.characters[charIdx];
    if (!character || !character.stages.length) {
      addToast('error', t('stagedMode.needAnalyze'));
      return;
    }
    setGeneratingEntries(true);
    setGenStatus('generating');
    setAnalyzingCharIdx(charIdx);
    setGenProgress(character.name);
    try {
      const results = await generateStageEntries(
        cardName, stagedMode.templateId, character.name, character.summary,
        character.axisPath, character.stages, existingWorldbookContext, nsfw, (charGuidance[charIdx] || '').trim(),
      );
      const newStages = character.stages.map((s) => {
        const found = results.find((r) => r.stageName === s.name);
        return { ...s, content: found?.content || s.content || '' };
      });
      const characters = stagedMode.characters.map((c, ci) =>
        ci === charIdx ? { ...c, stages: newStages } : c,
      );
      onChange({ ...stagedMode, characters });
      setGenStatus('done');
      addToast('success', t('stagedMode.generateDone'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setGenStatus('error');
      addToast('error', t('stagedMode.generateFailed') + `: ${msg}`);
    } finally {
      setGeneratingEntries(false);
      setAnalyzingCharIdx(null);
      setGenProgress('');
    }
  }, [generateStageEntries, cardName, stagedMode, existingWorldbookContext, nsfw, charGuidance, onChange, addToast, t]);

  // ── Step 3: 应用 → 构建世界书条目 ────────────────────────
  const handleApply = useCallback(() => {
    const emptyStages = stagedMode.characters
      .flatMap((c) => c.stages.map((s) => ({ char: c.name, stage: s.name, hasContent: !!(s.content && s.content.trim()) })))
      .filter((x) => !x.hasContent);
    if (emptyStages.length > 0) {
      addToast('error', t('stagedMode.applyEmptyContent', { name: emptyStages[0].char, stage: emptyStages[0].stage }));
      return;
    }
    const allEntries: LorebookEntry[] = [];
    for (const character of stagedMode.characters) {
      const stages: StageDefinition[] = sortStagesByDirection(
        character.stages.map((s) => ({
          name: s.name.trim(),
          condition: s.condition.trim(),
          content: s.content,
        })),
        character.axisType,
        character.numericDirection || '>=',
      );
      const dispatcherName = `${character.name.trim()}${stagedMode.dispatcherPrefix.trim()}`;
      const config: StagedLorebookConfig = {
        axisPath: character.axisPath,
        axisType: character.axisType,
        numericDirection: character.numericDirection,
        // 必须用导出书名而非卡名：ST 的 loadWorldInfo 按 character_book.name 精确匹配
        bookName,
        dispatcherName,
        stages,
      };
      allEntries.push(...buildStagedLorebookEntries(config));
    }
    onApplyEntries(allEntries);
    addToast('success', t('stagedMode.applyDone', { count: String(allEntries.length) }));
  }, [stagedMode, bookName, onApplyEntries, addToast, t]);

  // ── 渲染：未启用 ──────────────────────────────────────────
  if (!stagedMode.enabled) {
    return (
      <div className="space-y-4">
        <div className="text-center py-10 border border-dashed border-[var(--color-border-default)] rounded-xl">
          <p className="text-[var(--color-text-secondary)] mb-2">{t('stagedMode.introDisabled')}</p>
          <p className="text-sm text-[var(--color-text-muted)]">{t('stagedMode.introHint')}</p>
        </div>
        {/* 选择剧情模板即启用（自包含：内部生成所需 MVU 变量） */}
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-surface-raised)_20%,transparent)] p-4">
          <h3 className="text-sm font-bold text-[var(--text-color)] mb-3">📋 选择剧情模板以启用分阶段模式</h3>
          {/* 大类选择 */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {STAGED_TEMPLATE_CATEGORIES.map((cat) => {
              const isActive = selectedCategoryId === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => handleSelectCategory(cat.id)}
                  title={cat.description}
                  className={`rounded-md border px-2.5 py-1 text-[11px] transition ${
                    isActive
                      ? 'border-[var(--color-primary)] text-[var(--text-color)] bg-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]'
                      : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] bg-[color-mix(in_srgb,var(--color-surface-raised)_30%,transparent)] hover:border-[color-mix(in_srgb,var(--color-border-default)_80%,transparent)]'
                  }`}
                >
                  {cat.icon} {cat.name}
                </button>
              );
            })}
          </div>
          {/* 子模板选择（当前大类下） */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {getTemplatesByCategory(selectedCategoryId).map((tmpl) => {
              const token = tmpl.colorToken;
              return (
                <button
                  key={tmpl.id}
                  onClick={() => selectTemplate(tmpl.id, true)}
                  className={`rounded-xl border p-3 text-left transition-all hover:border-[color-mix(in_srgb,var(--color-status-${token})_50%,transparent)] border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)]`}
                >
                  <div className="text-2xl mb-1">{tmpl.icon}</div>
                  <div className="text-sm font-medium text-[var(--text-color)]">{tmpl.name}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{tmpl.description}</div>
                </button>
              );
            })}
          </div>
          {/* DIY：不套模板，AI 自选阶段轴 */}
          <button
            type="button"
            onClick={() => onChange({ ...stagedMode, templateId: 'diy', enabled: true })}
            className="mt-2 w-full rounded-xl border border-dashed border-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] p-3 text-left transition-all hover:border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-surface-raised)_30%,transparent)]"
          >
            <div className="text-2xl mb-1">🎨</div>
            <div className="text-sm font-medium text-[var(--text-color)]">{t('stagedMode.diyTitle')}</div>
            <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{t('stagedMode.diyEnableHint')}</div>
          </button>
        </div>
      </div>
    );
  }

  const hasAnalyzed = stagedMode.characters.length > 0;
  const allHaveContent = hasAnalyzed && stagedMode.characters.every((c) => c.stages.every((s) => s.content));

  return (
    <div className="space-y-4">
      {/* 头部：禁用按钮 + NSFW 开关 */}
      <div className="mobile-stack-header flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-[var(--text-color)]">{t('stagedMode.title')}</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">{t('stagedMode.intro')}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={nsfw}
              onChange={(e) => onNsfwChange?.(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-[var(--color-surface-raised)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-[var(--text-color)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--text-color)] after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--color-status-danger)]" />
          </label>
          <span className="text-xs text-[var(--color-text-secondary)]">{t('common.nsfw')}</span>
          <Button variant="ghost" size="sm" onClick={toggleEnabled}>{t('stagedMode.disable')}</Button>
        </div>
      </div>

      {/* Step 1: 标签选择 + 用户要求 + AI 剖析 */}
      <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-surface-raised)_20%,transparent)] p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-[var(--text-color)]">📋 {t('stagedMode.step1Title')}</h3>
          <Button variant="ghost" size="sm" onClick={() => setShowMultiCharModal(true)}>👥 多角色套模板</Button>
        </div>
        {/* 大类选择 */}
        <div className="flex flex-wrap gap-1.5 mb-2">
          {STAGED_TEMPLATE_CATEGORIES.map((cat) => {
            const isActive = selectedCategoryId === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleSelectCategory(cat.id)}
                title={cat.description}
                className={`rounded-md border px-2.5 py-1 text-[11px] transition ${
                  isActive
                    ? 'border-[var(--color-primary)] text-[var(--text-color)] bg-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]'
                    : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] bg-[color-mix(in_srgb,var(--color-surface-raised)_30%,transparent)] hover:border-[color-mix(in_srgb,var(--color-border-default)_80%,transparent)]'
                }`}
              >
                {cat.icon} {cat.name}
              </button>
            );
          })}
        </div>
        {/* 子模板选择（当前大类下） */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
          {getTemplatesByCategory(selectedCategoryId).map((tmpl) => {
            const token = tmpl.colorToken;
            const isSelected = stagedMode.templateId === tmpl.id;
            return (
              <button
                key={tmpl.id}
                onClick={() => selectTemplate(tmpl.id)}
                className={`rounded-xl border p-3 text-left transition-all hover:border-[color-mix(in_srgb,var(--color-status-${token})_50%,transparent)] ${
                  isSelected
                    ? `border-[var(--color-status-${token})] bg-[color-mix(in_srgb,var(--color-status-${token})_30%,transparent)]`
                    : 'border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)]'
                }`}
              >
                <div className="text-2xl mb-1">{tmpl.icon}</div>
                <div className="text-sm font-medium text-[var(--text-color)]">{tmpl.name}</div>
                <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{tmpl.description}</div>
              </button>
            );
          })}
        </div>
        {isDiyMode && (
          <div
            className="mb-3 rounded-lg border border-dashed px-3 py-2 text-[11px]"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-primary) 50%, transparent)',
              color: 'var(--color-text-secondary)',
            }}
          >
            🎨 {t('stagedMode.diyActiveHint')}
          </div>
        )}
        <TextArea
          value={userRequirement}
          onChange={(e) => setUserRequirement(e.target.value)}
          placeholder={t('stagedMode.requirementPlaceholder')}
          rows={2}
          className="mb-3"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleAnalyze} disabled={analyzing || diyGenerating || isDiyMode} title={isDiyMode ? t('stagedMode.analyzeDisabledInDiy') : undefined}>
            {analyzing ? t('stagedMode.analyzing') : `🔍 ${t('stagedMode.analyzeButton')}`}
          </Button>
          <Button variant="secondary" onClick={handleDiyGenerate} disabled={analyzing || diyGenerating} title={t('stagedMode.diyButtonHint')}>
            {diyGenerating ? t('stagedMode.diyGenerating') : `🎨 ${t('stagedMode.diyButton')}`}
          </Button>
        </div>
        <p className="text-[10px] text-[var(--color-text-muted)] mt-1.5">{t('stagedMode.diyDescription')}</p>
        {analyzeStatus !== 'idle' && analyzeStatus !== 'done' && (
          <AIProgressPanel status={analyzeStatus} text="" />
        )}
        {diyStatus !== 'idle' && diyStatus !== 'done' && (
          <AIProgressPanel status={diyStatus} text="" />
        )}
      </div>

      {/* Step 2: 阶段框架展示与编辑 */}
      {hasAnalyzed && (
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-status-warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-status-warning)_20%,transparent)] p-4">
          <h3 className="text-sm font-bold text-[var(--color-status-warning)] mb-3">✏️ {t('stagedMode.step2Title')}</h3>
          <p className="text-xs text-[var(--color-status-warning)] mb-3">{t('stagedMode.step2Hint')}</p>
          <div className="space-y-3">
            {stagedMode.characters.map((character, ci) => {
              const charGenerating = generatingEntries && analyzingCharIdx === ci;
              const charHasStages = character.stages.length > 0;
              const charAllReady = charHasStages && character.stages.every((s) => s.content && s.content.trim());
              const groupOpen = openCharacterGroups.has(ci);
              return (
              <div key={ci} className="rounded-lg border border-[color-mix(in_srgb,var(--color-border-default)_50%,transparent)] p-3 bg-[color-mix(in_srgb,var(--input-bg)_30%,transparent)]">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => toggleCharacterGroup(ci)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className={`text-[10px] text-[var(--color-primary)] transition-transform ${groupOpen ? 'rotate-90' : ''}`}>&#x25B6;</span>
                    <span className="text-sm font-bold text-[var(--color-primary)] shrink-0">{character.name}</span>
                    <code className="text-[11px] text-[var(--color-info)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 rounded shrink-0">{character.axisPath}</code>
                    <span className="text-[10px] text-[var(--color-text-muted)] min-w-0 truncate">{character.summary}</span>
                  </button>
                  {charHasStages && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      charAllReady
                        ? 'bg-[color-mix(in_srgb,var(--color-status-success)_50%,transparent)] text-[var(--color-status-success)] border-[color-mix(in_srgb,var(--color-status-success)_40%,transparent)]'
                        : 'bg-[color-mix(in_srgb,var(--color-status-warning)_40%,transparent)] text-[var(--color-status-warning)] border-[color-mix(in_srgb,var(--color-status-warning)_40%,transparent)]'
                    }`}>
                      {charAllReady
                        ? t('stagedMode.charAllReady', { count: String(character.stages.length) })
                        : t('stagedMode.charPartial', { ready: String(character.stages.filter((s) => s.content && s.content.trim()).length), total: String(character.stages.length) })}
                    </span>
                  )}
                  <Button
                    size="sm"
                    onClick={() => handleGenerateEntriesForChar(ci)}
                    disabled={!charHasStages || generatingEntries}
                    title={charHasStages ? t('stagedMode.generateForCharHint') : t('stagedMode.needAnalyze')}
                  >
                    {charGenerating
                      ? `${t('stagedMode.generating')} ${character.name}...`
                      : `✨ ${t('stagedMode.generateForChar')}`}
                  </Button>
                </div>
                {groupOpen && (
                  <div className="mt-2">
                    <TextArea
                      value={charGuidance[ci] || ''}
                      onChange={(e) => setCharGuidance({ ...charGuidance, [ci]: e.target.value })}
                      placeholder={t('stagedMode.charGuidancePlaceholder')}
                      rows={2}
                      className="mb-2 text-[11px]"
                    />
                    <StageDispatchSimulator character={character} />
                    <div className="space-y-2">
                      {character.stages.map((stage, si) => {
                    const key = `${ci}-${si}`;
                    return (
                      <div key={si} className="rounded border border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)] p-2 bg-[color-mix(in_srgb,var(--input-bg)_50%,transparent)]">
                        <div className="mobile-stage-row flex items-center gap-2 mb-1">
                          <TextInput
                            value={stage.name}
                            onChange={(e) => updateStage(ci, si, { name: e.target.value })}
                            className="flex-1 text-xs min-w-0"
                          />
                          <TextInput
                            value={stage.condition}
                            onChange={(e) => updateStage(ci, si, { condition: e.target.value })}
                            className="w-28 text-xs font-mono shrink-0"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRerollAnnotation(ci, si)}
                            disabled={rerollingAnnotationKey === key}
                            title={t('stagedMode.rerollAnnotation')}
                          >
                            {rerollingAnnotationKey === key ? '...' : `📝 ${t('stagedMode.rerollAnnotation')}`}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRerollContent(ci, si)}
                            disabled={rerollingContentKey === key}
                            title={t('stagedMode.rerollContent')}
                          >
                            {rerollingContentKey === key ? '...' : `🎲 ${t('stagedMode.rerollContent')}`}
                          </Button>
                        </div>
                        <p className="text-[11px] text-[var(--color-text-secondary)]">{stage.annotation}</p>
                        <TextInput
                          value={rerollGuidance[key] || ''}
                          onChange={(e) => setRerollGuidance({ ...rerollGuidance, [key]: e.target.value })}
                          placeholder={t('stagedMode.rerollGuidancePlaceholder')}
                          className="mt-1 text-[11px]"
                        />
                        {/* 阶段世界书内容：状态徽章 + 可编辑 TextArea */}
                        <div className="mt-2 pt-2 border-t border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)]">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-[var(--color-text-muted)] font-medium">
                              {t('stagedMode.stageContent')}
                            </span>
                            {stage.content && stage.content.trim() ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--color-status-success)_50%,transparent)] text-[var(--color-status-success)] border border-[color-mix(in_srgb,var(--color-status-success)_40%,transparent)]">
                                {t('stagedMode.contentReady', { count: String(stage.content.length) })}
                              </span>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] border border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)]">
                                {t('stagedMode.contentEmpty')}
                              </span>
                            )}
                          </div>
                          <TextArea
                            value={stage.content || ''}
                            onChange={(e) => updateStage(ci, si, { content: e.target.value })}
                            placeholder={t('stagedMode.contentPlaceholder')}
                            rows={5}
                            className="text-[11px] font-mono"
                          />
                        </div>
                      </div>
                    );
                      })}
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
          {genStatus !== 'idle' && genStatus !== 'done' && (
            <AIProgressPanel status={genStatus} text={genProgress} />
          )}
        </div>
      )}

      {/* Step 3: 应用到世界书 */}
      {allHaveContent && (
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-info)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-info)_20%,transparent)] p-4">
          <h3 className="text-sm font-bold text-[var(--color-info)] mb-2">📦 {t('stagedMode.step3Title')}</h3>
          <p className="text-xs text-[var(--color-info)] mb-3">{t('stagedMode.step3Hint')}</p>
          <Button variant="primary" onClick={handleApply}>📦 {t('stagedMode.applyButton')}</Button>
        </div>
      )}

      {/* Step 4: 状态栏模板（可复用模板系统） */}
      <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] p-4">
        <h3 className="text-sm font-bold text-[var(--color-primary)] mb-1">🎨 状态栏模板（可选）</h3>
        <p className="text-xs text-[var(--color-text-secondary)] mb-3">
          基于参考卡逆向的可复用模板系统：schema 反射自动选型 + CSS 变量主题 + JS 运行时动态更新。
        </p>

        {/* 模板选择 */}
        <label className="text-xs font-medium text-[var(--color-text-secondary)] mb-1.5 block">模板类型</label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          <button
            onClick={() => updateStatusBar({ style: 'none' })}
            className={`rounded-lg border p-2 text-center transition-all ${
              (mvu?.statusBarStyle ?? 'none') === 'none'
                ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]'
                : 'border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)]'
            }`}
          >
            <div className="text-lg">🚫</div>
            <div className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">无状态栏</div>
          </button>
          {STATUS_BAR_TEMPLATES.map(tmpl => (
            <button
              key={tmpl.id}
              onClick={() => updateStatusBar({ style: tmpl.id, options: { themeId: mvu?.statusBarOptions?.themeId || tmpl.defaultTheme } })}
              title={tmpl.description}
              className={`rounded-lg border p-2 text-center transition-all ${
                mvu?.statusBarStyle === tmpl.id
                  ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]'
                  : 'border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)]'
              }`}
            >
              <div className="text-lg">{tmpl.icon}</div>
              <div className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">{tmpl.name}</div>
            </button>
          ))}
          <button
            onClick={() => updateStatusBar({ style: 'ai-custom' })}
            className={`rounded-lg border p-2 text-center transition-all ${
              mvu?.statusBarStyle === 'ai-custom'
                ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]'
                : 'border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)]'
            }`}
          >
            <div className="text-lg">🤖</div>
            <div className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">AI/手动</div>
          </button>
        </div>

        {/* 内置模板的主题与选项 */}
        {mvu?.statusBarStyle && mvu.statusBarStyle !== 'none' && mvu.statusBarStyle !== 'ai-custom' && (
          <div className="space-y-3 mb-3">
            <div>
              <label className="text-xs font-medium text-[var(--color-text-secondary)] mb-1.5 block">主题风格</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {STATUS_BAR_THEMES.map(theme => (
                  <button
                    key={theme.id}
                    onClick={() => updateStatusBar({ options: { themeId: theme.id } })}
                    title={theme.description}
                    className={`rounded-lg border p-2 text-center transition-all ${
                      (mvu.statusBarOptions?.themeId || STATUS_BAR_TEMPLATES.find(t => t.id === mvu.statusBarStyle)?.defaultTheme) === theme.id
                        ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]'
                        : 'border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-surface-raised)_50%,transparent)]'
                    }`}
                  >
                    <div className="text-lg">{theme.icon}</div>
                    <div className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">{theme.name}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--color-text-secondary)] mb-1 block">状态栏标题</label>
              <TextInput
                value={mvu.statusBarOptions?.title ?? ''}
                onChange={(e) => updateStatusBar({ options: { title: e.target.value } })}
                placeholder="例如：角色状态"
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  aria-label="显示头像徽章"
                  checked={mvu.statusBarOptions?.showAvatar ?? true}
                  onChange={(e) => updateStatusBar({ options: { showAvatar: e.target.checked } })}
                  className="accent-[var(--color-primary)] w-3.5 h-3.5"
                />
                <span className="text-xs text-[var(--color-text-secondary)]">显示头像徽章</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  aria-label="默认折叠分区"
                  checked={mvu.statusBarOptions?.collapseAll ?? false}
                  onChange={(e) => updateStatusBar({ options: { collapseAll: e.target.checked } })}
                  className="accent-[var(--color-primary)] w-3.5 h-3.5"
                />
                <span className="text-xs text-[var(--color-text-secondary)]">默认折叠分区</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <span className="text-xs text-[var(--color-text-secondary)]">透明度</span>
                <input
                  type="range"
                  min="0.7"
                  max="1"
                  step="0.05"
                  value={mvu.statusBarOptions?.opacity ?? 1}
                  onChange={(e) => updateStatusBar({ options: { opacity: Number(e.target.value) } })}
                  className="w-24 accent-[var(--color-primary)]"
                  aria-label="状态栏透明度"
                />
                <span className="text-[10px] text-[var(--color-text-muted)] w-8">{Math.round((mvu.statusBarOptions?.opacity ?? 1) * 100)}%</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <span className="text-xs text-[var(--color-text-secondary)]">密度</span>
                <select
                  value={mvu.statusBarOptions?.density ?? 'compact'}
                  onChange={(e) => updateStatusBar({ options: { density: e.target.value as StatusBarOptions['density'] } })}
                  className="rounded border border-[var(--color-border-default)] bg-[var(--color-surface-raised)] px-1.5 py-1 text-[11px] text-[var(--text-color)]"
                  aria-label="状态栏信息密度"
                >
                  <option value="compact">紧凑</option>
                  <option value="comfortable">舒适</option>
                </select>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={mvu.statusBarOptions?.animated ?? true}
                  onChange={(e) => updateStatusBar({ options: { animated: e.target.checked } })}
                  className="accent-[var(--color-primary)] w-3.5 h-3.5"
                  aria-label="启用状态栏动画"
                />
                <span className="text-xs text-[var(--color-text-secondary)]">动画过渡</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={mvu.statusBarOptions?.showIcons ?? true}
                  onChange={(e) => updateStatusBar({ options: { showIcons: e.target.checked } })}
                  className="accent-[var(--color-primary)] w-3.5 h-3.5"
                  aria-label="显示状态栏图标"
                />
                <span className="text-xs text-[var(--color-text-secondary)]">显示图标</span>
              </label>
            </div>
          </div>
        )}

        {/* AI/手动自定义 HTML */}
        {mvu?.statusBarStyle === 'ai-custom' && (
          <div className="mb-3">
            <label className="text-xs font-medium text-[var(--color-text-secondary)] mb-1 block">自定义状态栏 HTML（含 &lt;script&gt; 的完整文档，用变量宏或 getAllVariables 读取）</label>
            <TextArea
              value={mvu.statusBarHtml ?? ''}
              onChange={(e) => updateStatusBar({ style: 'ai-custom', html: e.target.value })}
              rows={6}
              placeholder={'```html\n<!doctype html>\n...\n```'}
              className="font-mono text-xs"
            />
          </div>
        )}

        {/* 独立实时预览入口 */}
        {statusBarSrcDoc && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-surface-raised)_45%,transparent)] px-3 py-2">
            <div>
              <p className="text-xs font-medium text-[var(--text-color)]">状态栏实时预览</p>
              <p className="text-[10px] text-[var(--color-text-muted)]">样式配置会即时同步；可演示应用切换、通知与设置变更。</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setShowStatusBarPreview(true)}>打开预览窗口</Button>
          </div>
        )}
      </div>

      <Modal
        isOpen={showStatusBarPreview}
        onClose={() => setShowStatusBarPreview(false)}
        title="状态栏实时预览"
        maxWidth="max-w-3xl"
      >
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-secondary)]">
            预览与当前配置实时同步。切换下方状态可模拟状态栏在应用切换、通知接收和系统设置变更时的表现。
          </p>
          <div className="flex flex-wrap gap-2">
            {([
              ['normal', '正常状态'],
              ['app', '应用切换'],
              ['notice', '通知接收'],
              ['settings', '设置变更'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setPreviewState(id)}
                className={`rounded-md border px-3 py-1.5 text-xs transition ${
                  previewState === id
                    ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_25%,transparent)] text-[var(--text-color)]'
                    : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="rounded-xl border border-[var(--color-border-default)] bg-[#151515] p-3 overflow-auto min-h-[300px]">
            {statusBarSrcDoc ? (
              <iframe
                ref={previewFrameRef}
                title="状态栏独立实时预览"
                srcDoc={statusBarSrcDoc}
                style={{ width: '100%', minHeight: '330px', border: 'none', background: 'transparent' }}
                sandbox="allow-scripts"
              />
            ) : (
              <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">请先选择一个内置状态栏模板。</p>
            )}
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowStatusBarPreview(false)}>关闭预览</Button>
          </div>
        </div>
      </Modal>

      {/* 多角色套模板弹窗（自第5步迁入） */}
      <MultiCharTemplateModal
        isOpen={showMultiCharModal}
        onClose={() => setShowMultiCharModal(false)}
        onApplyMvu={(mvuCfg) => onMvuChange?.({
          ...mvuCfg,
          statusBarHtml: mvu?.statusBarHtml ?? mvuCfg.statusBarHtml,
          statusBarStyle: mvu?.statusBarStyle ?? mvuCfg.statusBarStyle,
          statusBarOptions: mvu?.statusBarOptions ?? mvuCfg.statusBarOptions,
        })}
        onApplyStageAxes={onApplyStageAxes}
        cardName={cardName}
        lorebookEntries={lorebookEntries}
      />
    </div>
  );
}
