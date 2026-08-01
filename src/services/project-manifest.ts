/**
 * Project Manifest — 单一项目状态对象（publishability snapshot）。
 *
 * 灵感来自 AFV 的 project-manifest：把分散的健康信号聚合成一个对象，
 * 让 UI / 导出流程 / 审计一眼看清「这张卡能不能发」「什么在挡它」「AI 改稿有没有待审」。
 *
 * 三个数据源汇入：
 *   1. QualityReport（评分 + 硬失败 + critical/suggestion 统计）
 *   2. ChangeProposal[] 列表（governed-write 审计：pending/approved/rejected 计数）
 *   3. 时间戳（便于缓存失效与审计）
 *
 * 状态优先级（高→低）：
 *   blocked   : 硬失败 OR critical 失败 OR 有待审批的 AI 改稿
 *   improvable: 可发布但有 suggestion/optional 可优化
 *   ready     : 结构完整，可直接发布
 *
 * 关键设计：待审批的 governed-write 补丁会阻断发布。
 *   理由：governed-write 的核心约束是「AI 改稿必须经用户确认才能落地」，
 *   若允许带着 pending 补丁发布，等于绕过了门禁——AI 越权改的字段可能已经
 *   被静默丢弃，但用户以为已经生效。所以 pending > 0 即 blocked。
 */

import type { QualityReport } from './quality-checker';
import type { HardFail } from './card-validator';
import type { ChangeProposal } from './card-chat-optimizer';

export type ProjectStatus = 'blocked' | 'improvable' | 'ready';

/** governed-write 审计摘要：按审批状态计数。 */
export interface GovernanceAudit {
  /** 等待用户审批的提案数（>0 即阻断发布） */
  pendingCount: number;
  /** 已批准的提案数 */
  approvedCount: number;
  /** 已拒绝的提案数 */
  rejectedCount: number;
  /** 提案总数 */
  totalCount: number;
}

/**
 * 项目状态快照。
 *
 * 这是一个纯数据对象——所有字段都可从 (QualityReport, ChangeProposal[]) 派生，
 * 不持有任何可变状态。UI 可以安全地 memoize 它，输入不变则输出不变。
 */
export interface ProjectManifest {
  /** 项目发布状态 */
  status: ProjectStatus;
  /** 质量评分 0-100（来自 QualityReport.score） */
  qualityScore: number;
  /** 硬失败列表（命中即不可发布，与评分解耦） */
  hardFails: HardFail[];
  /** 质量检查统计（来自 QualityReport） */
  criticalCount: number;
  suggestionCount: number;
  optionalCount: number;
  /** governed-write 审计摘要 */
  governance: GovernanceAudit;
  /** 面向用户的中文摘要标题 */
  headline: string;
  /** 计算时间戳（ms） */
  computedAt: number;
}

/** 空审计摘要（无任何 ChangeProposal 时使用）。 */
const EMPTY_AUDIT: GovernanceAudit = {
  pendingCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
  totalCount: 0,
};

/**
 * 从 ChangeProposal 列表汇总审计摘要。
 *
 * proposals 可能为 undefined（用户尚未触发过 AI 改稿），
 * 此时返回空审计。
 */
function summarizeGovernance(proposals: readonly ChangeProposal[] | undefined): GovernanceAudit {
  if (!proposals || proposals.length === 0) return EMPTY_AUDIT;
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  for (const p of proposals) {
    if (p.approvalState === 'pending') pending++;
    else if (p.approvalState === 'approved') approved++;
    else if (p.approvalState === 'rejected') rejected++;
  }
  return {
    pendingCount: pending,
    approvedCount: approved,
    rejectedCount: rejected,
    totalCount: proposals.length,
  };
}

/**
 * 计算发布状态。
 *
 * 优先级：硬失败 > 待审批改稿 > critical 失败 > suggestion/optional > ready。
 * 注意「待审批改稿」排在 critical 之前——即使卡片本身质量满分，
 * 只要有 pending 的 AI 补丁未确认，就不允许发布（governed-write 约束）。
 */
function computeStatus(
  hardFails: HardFail[],
  governance: GovernanceAudit,
  criticalCount: number,
  suggestionCount: number,
  optionalCount: number,
): ProjectStatus {
  if (hardFails.length > 0) return 'blocked';
  if (governance.pendingCount > 0) return 'blocked';
  if (criticalCount > 0) return 'blocked';
  if (suggestionCount > 0 || optionalCount > 0) return 'improvable';
  return 'ready';
}

/**
 * 生成面向用户的摘要标题。
 *
 * 按阻断原因排序：硬失败 > 待审批 > critical > suggestion > ready。
 * 每种原因给出一句可操作的中文说明。
 */
function buildHeadline(
  status: ProjectStatus,
  hardFails: HardFail[],
  governance: GovernanceAudit,
  criticalCount: number,
  suggestionCount: number,
  optionalCount: number,
): string {
  if (hardFails.length > 0) {
    return `存在 ${hardFails.length} 项致命错误，整卡不可发布`;
  }
  if (governance.pendingCount > 0) {
    return `有 ${governance.pendingCount} 项 AI 改稿待审批，发布前请先确认`;
  }
  if (criticalCount > 0) {
    return `存在 ${criticalCount} 项必须修复的问题，建议先处理再导出`;
  }
  if (status === 'improvable') {
    const parts: string[] = [];
    if (suggestionCount > 0) parts.push(`${suggestionCount} 项建议优化`);
    if (optionalCount > 0) parts.push(`${optionalCount} 项可选优化`);
    return `卡片可导出，继续优化可提升质量（${parts.join('，')}）`;
  }
  return '结构完整，适合导出发布';
}

/**
 * 构建项目状态快照。
 *
 * @param report   来自 runQualityCheck 的质量报告（必填）
 * @param proposals 来自 governed-write 流程的变更提案列表（可选）
 *
 * @example
 *   const report = runQualityCheck(draft);
 *   const manifest = buildProjectManifest(report, changeProposals);
 *   if (manifest.status === 'blocked') {
 *     showBlockerUI(manifest);
 *   }
 */
export function buildProjectManifest(
  report: QualityReport,
  proposals: readonly ChangeProposal[] | undefined = undefined,
): ProjectManifest {
  // 从 report.results 统计 critical/suggestion/optional（只数 applicable 且未通过的）
  const failed = report.results.filter((r) => r.applicable && !r.passed);
  const criticalCount = failed.filter((r) => r.severity === 'critical').length;
  const suggestionCount = failed.filter((r) => r.severity === 'suggestion').length;
  const optionalCount = failed.filter((r) => r.severity === 'optional').length;

  const governance = summarizeGovernance(proposals);
  const hardFails = report.hardFails;
  const status = computeStatus(hardFails, governance, criticalCount, suggestionCount, optionalCount);
  const headline = buildHeadline(status, hardFails, governance, criticalCount, suggestionCount, optionalCount);

  return {
    status,
    qualityScore: report.score,
    hardFails,
    criticalCount,
    suggestionCount,
    optionalCount,
    governance,
    headline,
    computedAt: Date.now(),
  };
}

/**
 * 是否可发布：status !== 'blocked'。
 *
 * 注意「可发布」不等于「完美」——improvable 也可发，只是有可优化空间。
 * 导出按钮的 disabled 状态应基于此函数。
 */
export function isPublishable(manifest: ProjectManifest): boolean {
  return manifest.status !== 'blocked';
}

/**
 * 是否处于「完美就绪」状态：status === 'ready'。
 *
 * 用于 UI 显示绿色「可导出」徽章——只有没有任何阻断或建议时才亮。
 */
export function isReady(manifest: ProjectManifest): boolean {
  return manifest.status === 'ready';
}

/**
 * 一行可读摘要：状态 emoji + 标题 + 评分。
 *
 * 用于导出按钮 tooltip、卡片列表项、审计日志等紧凑展示场景。
 * 注意：emoji 是状态指示符，不是装饰——导出流程依赖 status 字段做判断，
 * 此函数仅用于人类可读展示。
 */
export function summarizeManifest(manifest: ProjectManifest): string {
  const tag = manifest.status === 'ready' ? '[就绪]'
    : manifest.status === 'improvable' ? '[可优化]'
    : '[阻断]';
  return `${tag} ${manifest.headline}（评分 ${manifest.qualityScore}）`;
}

/**
 * 提取所有阻断原因（用于导出前诊断面板逐条展示）。
 *
 * 返回顺序：硬失败 > 待审批 > critical，每条带可操作的中文说明。
 * 若无阻断，返回空数组。
 */
export interface BlockerReason {
  /** 阻断类别 */
  kind: 'hard_fail' | 'pending_governance' | 'critical_check';
  /** 面向用户的中文说明 */
  message: string;
  /** 修复/处理提示 */
  fixHint: string;
}

export function collectBlockers(manifest: ProjectManifest): BlockerReason[] {
  const reasons: BlockerReason[] = [];
  for (const hf of manifest.hardFails) {
    reasons.push({
      kind: 'hard_fail',
      message: hf.message,
      fixHint: hf.fixHint,
    });
  }
  if (manifest.governance.pendingCount > 0) {
    reasons.push({
      kind: 'pending_governance',
      message: `有 ${manifest.governance.pendingCount} 项 AI 改稿待审批`,
      fixHint: '发布前请在改稿对话页面逐条审批（批准或拒绝）AI 提出的修改。',
    });
  }
  if (manifest.criticalCount > 0) {
    reasons.push({
      kind: 'critical_check',
      message: `存在 ${manifest.criticalCount} 项必须修复的质量问题`,
      fixHint: '请在质量检查面板处理所有标红的 critical 项后再导出。',
    });
  }
  return reasons;
}
