import { describe, it, expect } from 'vitest';
import type { QualityReport, CheckResult } from './quality-checker';
import type { HardFail } from './card-validator';
import type { ChangeProposal, ProposedChange } from './card-chat-optimizer';
import {
  buildProjectManifest,
  isPublishable,
  isReady,
  summarizeManifest,
  collectBlockers,
  type BlockerReason,
} from './project-manifest';

// ─── 测试夹具 ────────────────────────────────────────────────────────────────

function makeCheckResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: 'test',
    category: 'basic',
    label: '测试项',
    weight: 1,
    severity: 'critical',
    passed: true,
    applicable: true,
    actual: '',
    threshold: '',
    fixHint: '',
    ...overrides,
  };
}

function makeReport(overrides: Partial<QualityReport> = {}): QualityReport {
  const results: CheckResult[] = [];
  return {
    results,
    score: 100,
    passedCount: 0,
    failedCount: 0,
    applicableCount: 0,
    hardFails: [],
    ...overrides,
  };
}

function makeHardFail(overrides: Partial<HardFail> = {}): HardFail {
  return {
    code: 'book_name_mismatch',
    message: '世界书名不一致',
    fixHint: '统一书名',
    ...overrides,
  };
}

function makeProposal(
  approvalState: ChangeProposal['approvalState'],
  changes: ProposedChange[] = [],
): ChangeProposal {
  return {
    changes,
    targetPaths: [],
    approvalState,
    createdAt: 1000,
  };
}

// 一个 ready 报告：满分、无失败、无硬失败
function readyReport(): QualityReport {
  return makeReport({
    score: 100,
    passedCount: 5,
    failedCount: 0,
    applicableCount: 5,
    hardFails: [],
    results: [makeCheckResult({ passed: true })],
  });
}

// 一个 improvable 报告：有 suggestion 失败
function improvableReport(): QualityReport {
  const failedSuggestion = makeCheckResult({
    id: 'tags',
    severity: 'suggestion',
    passed: false,
    applicable: true,
  });
  return makeReport({
    score: 80,
    passedCount: 4,
    failedCount: 1,
    applicableCount: 5,
    hardFails: [],
    results: [makeCheckResult({ passed: true }), failedSuggestion],
  });
}

// 一个 critical 报告：有 critical 失败
function criticalReport(): QualityReport {
  const failedCritical = makeCheckResult({
    id: 'cardName',
    severity: 'critical',
    passed: false,
    applicable: true,
  });
  return makeReport({
    score: 50,
    passedCount: 4,
    failedCount: 1,
    applicableCount: 5,
    hardFails: [],
    results: [makeCheckResult({ passed: true }), failedCritical],
  });
}

// 一个硬失败报告
function hardFailReport(): QualityReport {
  return makeReport({
    score: 90,
    passedCount: 5,
    failedCount: 0,
    applicableCount: 5,
    hardFails: [makeHardFail()],
    results: [makeCheckResult({ passed: true })],
  });
}

// ════════════════════════════════════════════════════════════════════════════
// buildProjectManifest
// ════════════════════════════════════════════════════════════════════════════

describe('buildProjectManifest - 状态计算', () => {
  it('满分无失败无硬失败 → ready', () => {
    const manifest = buildProjectManifest(readyReport());
    expect(manifest.status).toBe('ready');
    expect(manifest.qualityScore).toBe(100);
    expect(manifest.hardFails).toHaveLength(0);
    expect(manifest.criticalCount).toBe(0);
    expect(manifest.suggestionCount).toBe(0);
    expect(manifest.optionalCount).toBe(0);
  });

  it('有 suggestion 失败 → improvable', () => {
    const manifest = buildProjectManifest(improvableReport());
    expect(manifest.status).toBe('improvable');
    expect(manifest.suggestionCount).toBe(1);
    expect(manifest.criticalCount).toBe(0);
  });

  it('有 critical 失败 → blocked', () => {
    const manifest = buildProjectManifest(criticalReport());
    expect(manifest.status).toBe('blocked');
    expect(manifest.criticalCount).toBe(1);
  });

  it('有硬失败 → blocked（即使评分高）', () => {
    const manifest = buildProjectManifest(hardFailReport());
    expect(manifest.status).toBe('blocked');
    expect(manifest.hardFails).toHaveLength(1);
    expect(manifest.qualityScore).toBe(90); // 评分与硬失败解耦
  });

  it('不适用（not applicable）的检查项不计入 critical/suggestion 统计', () => {
    const notApplicable = makeCheckResult({
      id: 'mvu',
      severity: 'critical',
      passed: false,
      applicable: false,
    });
    const report = makeReport({
      results: [makeCheckResult({ passed: true }), notApplicable],
      applicableCount: 1,
      passedCount: 1,
      failedCount: 0,
    });
    const manifest = buildProjectManifest(report);
    expect(manifest.criticalCount).toBe(0);
    expect(manifest.status).toBe('ready');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// governed-write 审计集成
// ════════════════════════════════════════════════════════════════════════════

describe('buildProjectManifest - governed-write 审计', () => {
  it('无 proposals 时 governance 为空', () => {
    const manifest = buildProjectManifest(readyReport());
    expect(manifest.governance.pendingCount).toBe(0);
    expect(manifest.governance.approvedCount).toBe(0);
    expect(manifest.governance.rejectedCount).toBe(0);
    expect(manifest.governance.totalCount).toBe(0);
  });

  it('有待审批 proposals 时 → blocked（即使质量满分）', () => {
    const proposals = [
      makeProposal('pending'),
      makeProposal('approved'),
      makeProposal('rejected'),
    ];
    const manifest = buildProjectManifest(readyReport(), proposals);
    // 质量满分但有待审批改稿 → 仍然 blocked
    expect(manifest.status).toBe('blocked');
    expect(manifest.qualityScore).toBe(100);
    expect(manifest.governance.pendingCount).toBe(1);
    expect(manifest.governance.approvedCount).toBe(1);
    expect(manifest.governance.rejectedCount).toBe(1);
    expect(manifest.governance.totalCount).toBe(3);
  });

  it('所有 proposals 已审批（无 pending）→ 不阻断发布', () => {
    const proposals = [
      makeProposal('approved'),
      makeProposal('rejected'),
    ];
    const manifest = buildProjectManifest(readyReport(), proposals);
    expect(manifest.status).toBe('ready');
    expect(manifest.governance.pendingCount).toBe(0);
    expect(manifest.governance.totalCount).toBe(2);
  });

  it('空 proposals 数组等价于 undefined', () => {
    const m1 = buildProjectManifest(readyReport(), []);
    const m2 = buildProjectManifest(readyReport(), undefined);
    expect(m1.status).toBe(m2.status);
    expect(m1.governance).toEqual(m2.governance);
  });

  it('待审批改稿优先级高于 critical 失败（headline 体现待审批）', () => {
    // 同时有硬失败和待审批：硬失败优先
    const proposals = [makeProposal('pending')];
    const manifest = buildProjectManifest(hardFailReport(), proposals);
    expect(manifest.status).toBe('blocked');
    expect(manifest.headline).toContain('致命错误');
  });

  it('无硬失败但有 pending 改稿：headline 体现待审批', () => {
    const proposals = [makeProposal('pending'), makeProposal('pending')];
    const manifest = buildProjectManifest(readyReport(), proposals);
    expect(manifest.headline).toContain('2 项 AI 改稿待审批');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// headline 生成
// ════════════════════════════════════════════════════════════════════════════

describe('buildProjectManifest - headline', () => {
  it('ready 状态有就绪标题', () => {
    const manifest = buildProjectManifest(readyReport());
    expect(manifest.headline).toBe('结构完整，适合导出发布');
  });

  it('硬失败标题包含数量', () => {
    const report = makeReport({
      score: 90,
      hardFails: [makeHardFail(), makeHardFail({ code: 'mvu_missing_initvar' })],
    });
    const manifest = buildProjectManifest(report);
    expect(manifest.headline).toContain('2 项致命错误');
  });

  it('critical 标题包含数量', () => {
    const manifest = buildProjectManifest(criticalReport());
    expect(manifest.headline).toContain('1 项必须修复');
  });

  it('improvable 标题包含 suggestion 数量', () => {
    const manifest = buildProjectManifest(improvableReport());
    expect(manifest.headline).toContain('1 项建议优化');
  });

  it('computedAt 是数字时间戳', () => {
    const manifest = buildProjectManifest(readyReport());
    expect(typeof manifest.computedAt).toBe('number');
    expect(manifest.computedAt).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// isPublishable / isReady
// ════════════════════════════════════════════════════════════════════════════

describe('isPublishable', () => {
  it('ready → 可发布', () => {
    expect(isPublishable(buildProjectManifest(readyReport()))).toBe(true);
  });

  it('improvable → 可发布（有优化空间但不阻断）', () => {
    expect(isPublishable(buildProjectManifest(improvableReport()))).toBe(true);
  });

  it('blocked (critical) → 不可发布', () => {
    expect(isPublishable(buildProjectManifest(criticalReport()))).toBe(false);
  });

  it('blocked (硬失败) → 不可发布', () => {
    expect(isPublishable(buildProjectManifest(hardFailReport()))).toBe(false);
  });

  it('blocked (待审批改稿) → 不可发布', () => {
    const manifest = buildProjectManifest(readyReport(), [makeProposal('pending')]);
    expect(isPublishable(manifest)).toBe(false);
  });
});

describe('isReady', () => {
  it('ready → true', () => {
    expect(isReady(buildProjectManifest(readyReport()))).toBe(true);
  });

  it('improvable → false（不是完美就绪）', () => {
    expect(isReady(buildProjectManifest(improvableReport()))).toBe(false);
  });

  it('blocked → false', () => {
    expect(isReady(buildProjectManifest(hardFailReport()))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// summarizeManifest
// ════════════════════════════════════════════════════════════════════════════

describe('summarizeManifest', () => {
  it('ready 状态带 [就绪] 标签', () => {
    const summary = summarizeManifest(buildProjectManifest(readyReport()));
    expect(summary).toContain('[就绪]');
    expect(summary).toContain('100');
  });

  it('improvable 状态带 [可优化] 标签', () => {
    const summary = summarizeManifest(buildProjectManifest(improvableReport()));
    expect(summary).toContain('[可优化]');
  });

  it('blocked 状态带 [阻断] 标签', () => {
    const summary = summarizeManifest(buildProjectManifest(hardFailReport()));
    expect(summary).toContain('[阻断]');
  });

  it('摘要包含评分', () => {
    const manifest = buildProjectManifest(improvableReport());
    expect(summarizeManifest(manifest)).toContain('80');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// collectBlockers
// ════════════════════════════════════════════════════════════════════════════

describe('collectBlockers', () => {
  it('ready 状态无阻断原因', () => {
    const manifest = buildProjectManifest(readyReport());
    expect(collectBlockers(manifest)).toHaveLength(0);
  });

  it('improvable 状态无阻断原因（suggestion 不算 blocker）', () => {
    const manifest = buildProjectManifest(improvableReport());
    expect(collectBlockers(manifest)).toHaveLength(0);
  });

  it('硬失败产生 hard_fail 类型的 blocker', () => {
    const manifest = buildProjectManifest(hardFailReport());
    const blockers = collectBlockers(manifest);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].kind).toBe('hard_fail');
    expect(blockers[0].message).toContain('世界书名不一致');
    expect(blockers[0].fixHint).toContain('统一书名');
  });

  it('critical 失败产生 critical_check 类型的 blocker', () => {
    const manifest = buildProjectManifest(criticalReport());
    const blockers = collectBlockers(manifest);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].kind).toBe('critical_check');
  });

  it('待审批改稿产生 pending_governance 类型的 blocker', () => {
    const manifest = buildProjectManifest(readyReport(), [makeProposal('pending')]);
    const blockers = collectBlockers(manifest);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].kind).toBe('pending_governance');
  });

  it('多种阻断同时存在时全部收集', () => {
    // 同时有硬失败 + critical + 待审批
    const failedCritical = makeCheckResult({
      id: 'cardName',
      severity: 'critical',
      passed: false,
      applicable: true,
    });
    const report = makeReport({
      score: 30,
      passedCount: 0,
      failedCount: 1,
      applicableCount: 1,
      hardFails: [makeHardFail()],
      results: [failedCritical],
    });
    const manifest = buildProjectManifest(report, [makeProposal('pending')]);
    const blockers = collectBlockers(manifest);
    expect(blockers).toHaveLength(3);
    const kinds = blockers.map((b) => b.kind);
    // 硬失败排第一
    expect(kinds[0]).toBe('hard_fail');
    expect(kinds[1]).toBe('pending_governance');
    expect(kinds[2]).toBe('critical_check');
  });

  it('每个 blocker 都有 message 和 fixHint', () => {
    const manifest = buildProjectManifest(hardFailReport(), [makeProposal('pending')]);
    const blockers = collectBlockers(manifest);
    for (const b of blockers) {
      expect(typeof b.message).toBe('string');
      expect(b.message.length).toBeGreaterThan(0);
      expect(typeof b.fixHint).toBe('string');
      expect(b.fixHint.length).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 纯函数性：相同输入产生相同输出（仅 computedAt 不同）
// ════════════════════════════════════════════════════════════════════════════

describe('纯函数性', () => {
  it('相同 report 两次构建产生相同的 status/score/counts', () => {
    const report = improvableReport();
    const m1 = buildProjectManifest(report);
    const m2 = buildProjectManifest(report);
    expect(m1.status).toBe(m2.status);
    expect(m1.qualityScore).toBe(m2.qualityScore);
    expect(m1.criticalCount).toBe(m2.criticalCount);
    expect(m1.suggestionCount).toBe(m2.suggestionCount);
    expect(m1.governance).toEqual(m2.governance);
    // computedAt 可能不同（时间戳），但其他字段必须一致
  });

  it('BlockerReason 类型断言：所有 kind 都被覆盖', () => {
    const allKinds: BlockerReason['kind'][] = ['hard_fail', 'pending_governance', 'critical_check'];
    // 通过构造三种 blocker 验证 kind 联合类型完整
    const manifest = buildProjectManifest(
      makeReport({
        hardFails: [makeHardFail()],
        results: [makeCheckResult({ severity: 'critical', passed: false, applicable: true })],
        passedCount: 0,
        failedCount: 1,
        applicableCount: 1,
      }),
      [makeProposal('pending')],
    );
    const blockers = collectBlockers(manifest);
    const actualKinds = blockers.map((b) => b.kind);
    for (const kind of allKinds) {
      expect(actualKinds).toContain(kind);
    }
  });
});
