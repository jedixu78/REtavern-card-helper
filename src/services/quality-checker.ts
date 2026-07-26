/**
 * Quality Checker — rule-based card quality assessment with weighted scoring.
 *
 * Runs a set of checks against a WizardDraft and produces a 0-100 score.
 * Conditional checks (MVU / stagedMode) are excluded from the denominator
 * when the feature is disabled, so an unused feature never drags the score.
 *
 * AI deep diagnosis (diagnoseCard) is intentionally NOT here — it's async,
 * costs tokens, and is invoked separately from the UI panel.
 */
import type { WizardDraft } from '../constants/defaults';
import { validateCard } from './card-validator';
import { assembleCard } from './card-exporter';
import { findStagedLorebookEntryIndices, isProtectedLorebookEntry } from './lorebook-predicates';
import {
  analyzeCardTokenBudget,
  describeTokenBudgetAdvice,
  TOKEN_BUDGET_HEALTHY_MAX,
  TOKEN_BUDGET_LEVEL_LABEL,
} from './token-budget';

/** 每次 runQualityCheck 调用期间的 assembleCard 缓存，避免重复计算 */
let _cachedCard: Record<string, unknown> | null = null;
let _cachedDraftRef: WizardDraft | null = null;
function getAssembledCard(d: WizardDraft): Record<string, unknown> {
  if (_cachedDraftRef !== d || _cachedCard === null) {
    _cachedDraftRef = d;
    _cachedCard = assembleCard(d) as unknown as Record<string, unknown>;
  }
  return _cachedCard;
}

export type CheckCategory =
  | 'basic'
  | 'character'
  | 'firstMessage'
  | 'lorebook'
  | 'mvu'
  | 'stagedMode'
  | 'spec';

export type CheckSeverity = 'critical' | 'suggestion' | 'optional';

export interface CheckResult {
  id: string;
  category: CheckCategory;
  label: string;
  weight: number;
  severity: CheckSeverity;
  passed: boolean;
  applicable: boolean;
  actual: string;
  threshold: string;
  fixHint: string;
  /** Wizard step to jump to for manual fix (1-based). */
  jumpStep?: number;
  /** Field keys to preselect in the AI optimize modal. */
  optimizeFields?: string[];
}

export interface QualityReport {
  results: CheckResult[];
  score: number;
  passedCount: number;
  failedCount: number;
  applicableCount: number;
}

interface CheckItem {
  id: string;
  category: CheckCategory;
  label: string;
  weight: number;
  severity: CheckSeverity;
  jumpStep?: number;
  optimizeFields?: string[];
  /** Returns false when the feature isn't enabled — item is skipped entirely. */
  applicable: (draft: WizardDraft) => boolean;
  check: (draft: WizardDraft) => { passed: boolean; actual: string; fixHint: string };
  threshold: string;
}

const DEFAULT_CARD_NAMES = new Set(['新卡片', '新建卡片', '未命名', 'Untitled', '']);

/**
 * Special-format system entries (MVU + staged) are excluded from normal
 * lorebook quality checks via the shared `isProtectedLorebookEntry` helper.
 * Excluding these prevents false positives like "空内容条目" on an [InitVar]
 * that's intentionally empty during setup, or "缺少触发词" on a staged child
 * entry that's activated by the dispatcher's EJS logic.
 */

/** Build the set of staged-mode entry indices (only when staged mode is on). */
function getStagedIndices(draft: WizardDraft): Set<number> {
  if (!draft.stagedMode?.enabled) return new Set();
  try {
    return findStagedLorebookEntryIndices(draft.lorebookEntries || []);
  } catch {
    return new Set();
  }
}

const CHECK_ITEMS: CheckItem[] = [
  {
    id: 'cardName',
    category: 'basic',
    label: '卡片名称',
    weight: 8,
    severity: 'critical',
    jumpStep: 1,
    optimizeFields: ['cardName'],
    threshold: '≥2 字符且非默认',
    applicable: () => true,
    check: (d) => {
      const name = (d.cardName || '').trim();
      const passed = name.length >= 2 && !DEFAULT_CARD_NAMES.has(name);
      return {
        passed,
        actual: name ? `${name.length} 字` : '空',
        fixHint: passed ? '' : '请填写一个简洁有力的卡片名称（至少 2 个字符）',
      };
    },
  },
  {
    id: 'tags',
    category: 'basic',
    label: '标签数量',
    weight: 6,
    severity: 'suggestion',
    jumpStep: 1,
    optimizeFields: ['tags'],
    threshold: '≥3 个',
    applicable: () => true,
    check: (d) => {
      const count = (d.tags || []).filter(Boolean).length;
      return {
        passed: count >= 3,
        actual: `${count} 个`,
        fixHint: count >= 3 ? '' : `当前 ${count} 个标签，建议补充至 3 个以上以便分类检索`,
      };
    },
  },
  {
    id: 'characters',
    category: 'character',
    label: '命名角色',
    weight: 8,
    severity: 'critical',
    jumpStep: 3,
    threshold: '≥1 个有名称和描述',
    applicable: () => true,
    check: (d) => {
      const named = (d.characters || []).filter((c) => c.name?.trim() && c.description?.trim());
      return {
        passed: named.length >= 1,
        actual: `${named.length} 个`,
        fixHint: named.length >= 1 ? '' : '请在第 3 步添加至少一个有名称和描述的角色',
      };
    },
  },
  {
    id: 'firstMessage',
    category: 'firstMessage',
    label: '开场白字数',
    weight: 12,
    severity: 'suggestion',
    jumpStep: 7,
    optimizeFields: ['firstMessage'],
    threshold: '200~3000 字',
    applicable: () => true,
    check: (d) => {
      const len = (d.firstMessage || '').length;
      const passed = len >= 200 && len <= 3000;
      let fixHint = '';
      if (len < 200) fixHint = `当前 ${len} 字偏短，建议扩充至 200 字以上的沉浸式开场叙事`;
      else if (len > 3000) fixHint = `当前 ${len} 字偏长，建议精简至 3000 字以内控制 token 成本`;
      return { passed, actual: `${len} 字`, fixHint };
    },
  },
  {
    id: 'lorebookCount',
    category: 'lorebook',
    label: '世界书条目数',
    weight: 10,
    severity: 'suggestion',
    jumpStep: 4,
    optimizeFields: ['lorebookEntries'],
    threshold: '≥5 条',
    applicable: () => true,
    check: (d) => {
      const stagedIndices = getStagedIndices(d);
      const count = (d.lorebookEntries || []).filter(
        (e, idx) => e.enabled && !isProtectedLorebookEntry(e, idx, stagedIndices),
      ).length;
      return {
        passed: count >= 5,
        actual: `${count} 条`,
        fixHint: count >= 5 ? '' : `当前 ${count} 条用户条目（已排除 MVU/分阶段系统条目），建议补充至 5 条以上以丰富世界观`,
      };
    },
  },
  {
    id: 'lorebookEmpty',
    category: 'lorebook',
    label: '空内容条目',
    weight: 8,
    severity: 'critical',
    jumpStep: 4,
    optimizeFields: ['lorebookEntries'],
    threshold: '0 条空内容',
    applicable: () => true,
    check: (d) => {
      const stagedIndices = getStagedIndices(d);
      const empty = (d.lorebookEntries || []).filter(
        (e, idx) => e.enabled && !isProtectedLorebookEntry(e, idx, stagedIndices) && !(e.content || '').trim(),
      );
      return {
        passed: empty.length === 0,
        actual: `${empty.length} 条空`,
        fixHint: empty.length === 0 ? '' : `${empty.length} 条启用条目内容为空，请补充或禁用`,
      };
    },
  },
  {
    id: 'lorebookKeys',
    category: 'lorebook',
    label: '触发词覆盖',
    weight: 8,
    severity: 'critical',
    jumpStep: 4,
    optimizeFields: ['lorebookEntries'],
    threshold: '非蓝灯条目都有触发词',
    applicable: () => true,
    check: (d) => {
      const stagedIndices = getStagedIndices(d);
      const noKeys = (d.lorebookEntries || []).filter(
        (e, idx) =>
          e.enabled && !isProtectedLorebookEntry(e, idx, stagedIndices) && !e.constant && (e.keys || []).length === 0,
      );
      return {
        passed: noKeys.length === 0,
        actual: `${noKeys.length} 条缺触发词`,
        fixHint: noKeys.length === 0 ? '' : `${noKeys.length} 条非蓝灯条目没有触发词，将无法被激活`,
      };
    },
  },
  {
    // Token 预算维度：结构计数看不出「这张卡每轮固定烧多少 token」。
    // 蓝灯（常驻）条目每轮都会进提示词，社区长期缺少这个计数器，
    // 一张卡可能在对话开始前就吃掉几千 token 而作者毫无感知。
    // 归入 lorebook 类别（而非新开一类）：常驻开销的可操作抓手就在世界书里，
    // 同时也避免给 groupByCategory 的类别顺序引入破坏性变更。
    id: 'tokenBudget',
    category: 'lorebook',
    label: '常驻 Token 开销',
    weight: 10,
    severity: 'suggestion',
    jumpStep: 4,
    optimizeFields: ['lorebookEntries'],
    threshold: `≤${TOKEN_BUDGET_HEALTHY_MAX} token/轮`,
    applicable: () => true,
    check: (d) => {
      const budget = analyzeCardTokenBudget(d);
      const passed = budget.level === 'healthy';
      return {
        passed,
        actual: `${budget.perTurnFixed} token/轮（${TOKEN_BUDGET_LEVEL_LABEL[budget.level]}）`,
        fixHint: passed ? '' : describeTokenBudgetAdvice(budget),
      };
    },
  },
  {
    id: 'mvuVars',
    category: 'mvu',
    label: 'MVU 变量',
    weight: 8,
    severity: 'critical',
    jumpStep: 5,
    optimizeFields: ['mvu.schemaSections'],
    threshold: '≥1 个变量',
    applicable: (d) => !!d.mvu?.enabled,
    check: (d) => {
      const sections = d.mvu?.schemaSections;
      const count = Array.isArray(sections)
        ? sections.reduce((sum, s) => sum + (Array.isArray(s?.variables) ? s.variables.length : 0), 0)
        : 0;
      return {
        passed: count >= 1,
        actual: `${count} 个`,
        fixHint: count >= 1 ? '' : 'MVU 已启用但未定义变量，请到第 5 步（MVU变量）添加变量，或在第 6 步（分阶段模式）选择剧情模板',
      };
    },
  },
  {
    id: 'stagedContent',
    category: 'stagedMode',
    label: '分阶段内容',
    weight: 4,
    severity: 'critical',
    jumpStep: 6,
    threshold: '所有阶段有内容',
    applicable: (d) => !!d.stagedMode?.enabled,
    check: (d) => {
      const chars = d.stagedMode?.characters;
      const emptyStages = Array.isArray(chars)
        ? chars.flatMap((c) => {
            if (!c || !Array.isArray(c.stages)) return [];
            return c.stages.filter((s) => !s || !(s.content || '').trim());
          })
        : [];
      return {
        passed: emptyStages.length === 0,
        actual: emptyStages.length === 0 ? '全部已填' : `${emptyStages.length} 个空阶段`,
        fixHint: emptyStages.length === 0 ? '' : `${emptyStages.length} 个阶段缺少内容，请到第 6 步补充`,
      };
    },
  },
  {
    id: 'specErrors',
    category: 'spec',
    label: '卡片规范错误',
    weight: 16,
    severity: 'critical',
    optimizeFields: ['cardName', 'firstMessage'],
    threshold: '0 个错误',
    applicable: () => true,
    check: (d) => {
      try {
        const card = getAssembledCard(d);
        const stagedIndices = d.stagedMode?.enabled ? findStagedLorebookEntryIndices(d.lorebookEntries) : undefined;
        const result = validateCard(card, { stagedLorebookEntryIndices: stagedIndices });
        return {
          passed: result.errors.length === 0,
          actual: `${result.errors.length} 个错误`,
          fixHint:
            result.errors.length === 0
              ? ''
              : `存在 ${result.errors.length} 个规范错误：${result.errors.slice(0, 3).join('；')}`,
        };
      } catch {
        return {
          passed: false,
          actual: '校验异常',
          fixHint: '卡片数据异常，无法完成卡片规范校验，请检查各步骤数据完整性',
        };
      }
    },
  },
  {
    id: 'specWarnings',
    category: 'spec',
    label: 'V2 规范警告',
    weight: 8,
    severity: 'suggestion',
    optimizeFields: ['firstMessage', 'lorebookEntries'],
    threshold: '0 个警告',
    applicable: () => true,
    check: (d) => {
      try {
        const card = getAssembledCard(d);
        const stagedIndices = d.stagedMode?.enabled ? findStagedLorebookEntryIndices(d.lorebookEntries) : undefined;
        const result = validateCard(card, { stagedLorebookEntryIndices: stagedIndices });
        return {
          passed: result.warnings.length === 0,
          actual: `${result.warnings.length} 个警告`,
          fixHint:
            result.warnings.length === 0
              ? ''
              : `存在 ${result.warnings.length} 个警告：${result.warnings.slice(0, 3).join('；')}`,
        };
      } catch {
        return {
          passed: false,
          actual: '校验异常',
          fixHint: '卡片数据异常，无法完成 V2 规范校验，请检查各步骤数据完整性',
        };
      }
    },
  },
];

export function runQualityCheck(draft: WizardDraft): QualityReport {
  const results: CheckResult[] = CHECK_ITEMS.map((item) => {
    const applicable = item.applicable(draft);
    if (!applicable) {
      return {
        id: item.id,
        category: item.category,
        label: item.label,
        weight: item.weight,
        severity: item.severity,
        passed: false,
        applicable: false,
        actual: '不适用',
        threshold: item.threshold,
        fixHint: '',
        jumpStep: item.jumpStep,
        optimizeFields: item.optimizeFields,
      };
    }
    const r = (() => {
      try {
        return item.check(draft);
      } catch {
        return {
          passed: false,
          actual: '检查异常',
          fixHint: '该项检查执行异常，请检查卡片数据完整性',
        };
      }
    })();
    return {
      id: item.id,
      category: item.category,
      label: item.label,
      weight: item.weight,
      severity: item.severity,
      passed: r.passed,
      applicable: true,
      actual: r.actual,
      threshold: item.threshold,
      fixHint: r.fixHint,
      jumpStep: item.jumpStep,
      optimizeFields: item.optimizeFields,
    };
  });

  const applicableResults = results.filter((r) => r.applicable);
  const totalWeight = applicableResults.reduce((sum, r) => sum + r.weight, 0);
  const passedWeight = applicableResults
    .filter((r) => r.passed)
    .reduce((sum, r) => sum + r.weight, 0);
  const score = totalWeight === 0 ? 0 : Math.round((passedWeight / totalWeight) * 100);
  const passedCount = applicableResults.filter((r) => r.passed).length;
  const failedCount = applicableResults.filter((r) => !r.passed).length;

  return {
    results,
    score,
    passedCount,
    failedCount,
    applicableCount: applicableResults.length,
  };
}

/** Group results by category for UI rendering. Preserves CHECK_ITEMS order. */
export function groupByCategory(results: CheckResult[]): { category: CheckCategory; items: CheckResult[] }[] {
  const order: CheckCategory[] = ['basic', 'character', 'firstMessage', 'lorebook', 'mvu', 'stagedMode', 'spec'];
  return order
    .map((category) => ({
      category,
      items: results.filter((r) => r.category === category && r.applicable),
    }))
    .filter((g) => g.items.length > 0);
}

export interface QualityGuidance {
  status: 'blocked' | 'improvable' | 'ready';
  headline: string;
  nextActions: CheckResult[];
  criticalCount: number;
  suggestionCount: number;
  optionalCount: number;
}

export function buildQualityGuidance(report: QualityReport): QualityGuidance {
  const failed = report.results.filter((r) => r.applicable && !r.passed);
  const critical = failed.filter((r) => r.severity === 'critical');
  const suggestions = failed.filter((r) => r.severity === 'suggestion');
  const optional = failed.filter((r) => r.severity === 'optional');
  const nextActions = [...critical, ...suggestions, ...optional].slice(0, 3);
  if (critical.length > 0) {
    return {
      status: 'blocked',
      headline: '存在必须修复项，建议先处理红色风险再导出',
      nextActions,
      criticalCount: critical.length,
      suggestionCount: suggestions.length,
      optionalCount: optional.length,
    };
  }
  if (suggestions.length > 0 || optional.length > 0) {
    return {
      status: 'improvable',
      headline: '卡片可导出，继续优化可提升发布质量',
      nextActions,
      criticalCount: 0,
      suggestionCount: suggestions.length,
      optionalCount: optional.length,
    };
  }
  return {
    status: 'ready',
    headline: '结构完整，适合导出发布',
    nextActions: [],
    criticalCount: 0,
    suggestionCount: 0,
    optionalCount: 0,
  };
}

/** Score → color token. */
export function scoreColor(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}
