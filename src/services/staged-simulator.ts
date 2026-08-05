/**
 * staged-simulator — 分阶段调度模拟器（纯函数）。
 *
 * 解决的问题：用户在 SillyTavern 里发现「阶段不切换」时，工具内没有任何排查手段
 * ——调度条目是一段 EJS if/else-if 链，只有在 ST 运行时才会求值。本模块在工具内
 * 复现同一套判定，让用户拖动轴值就能看到「当前命中哪个阶段、为什么其它阶段没命中」。
 *
 * 判定语义与 buildDispatcherContent 生成的 EJS 严格对应：
 *   1. 轴变量 undefined → 报错分支（ST 里输出错误注释）
 *   2. 按 stages 顺序逐个 else-if，**首个条件为真者胜出**
 *   3. 全部不匹配 → 兜底 else（ST 里输出警告注释）
 *
 * 安全：条件表达式用受限解析器求值，**不使用 eval / new Function**
 * ——条件串可能来自 AI 生成或用户手写，不能当代码执行。
 */
import type { StageDefinition, StageAxisType, NumericDirection } from './staged-lorebook-builder';
import { autoCondition, sortStagesByDirection } from './staged-lorebook-builder';

export type StageDispatchOutcome = 'matched' | 'undefined-axis' | 'no-match';

export interface StageEvaluation {
  stage: StageDefinition;
  /** 实际参与求值的条件表达式（含自动生成的） */
  condition: string;
  /** 该条件是否为真 */
  passed: boolean;
  /** 是否是最终胜出者（首个为真者） */
  winner: boolean;
  /** 条件无法解析时的说明（此时 passed 恒为 false） */
  parseError?: string;
}

export interface StageDispatchResult {
  outcome: StageDispatchOutcome;
  /** 命中的阶段（outcome !== 'matched' 时为 null） */
  matchedStage: StageDefinition | null;
  matchedIndex: number;
  /** 逐阶段求值明细，供 UI 解释「为什么没命中」 */
  evaluations: StageEvaluation[];
}

/** 反转 escapeEjsSingleQuoted：把条件里的字面量还原成原始字符串。 */
function unescapeEjsSingleQuoted(literal: string): string {
  let out = '';
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i];
    if (ch !== '\\' || i === literal.length - 1) {
      out += ch;
      continue;
    }
    const next = literal[i + 1];
    i++;
    switch (next) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '>': out += '>'; break; // 来自 `%>` → `%\>`
      case 'u': {
        const hex = literal.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += 'u';
        }
        break;
      }
      default: out += next; break;
    }
  }
  return out;
}

/**
 * 求值单个条件表达式（左操作数是轴值）。
 * 支持：`=== '字面量'` / `!== '字面量'` / `>= N` / `<= N` / `> N` / `< N` / `=== N` / `!== N`
 * 返回 null 表示无法解析（调用方按「不通过」处理并展示 parseError）。
 */
export function evaluateStageCondition(axisValue: string | number, condition: string): boolean | null {
  const expr = (condition || '').trim();
  if (!expr) return null;

  // 字符串字面量比较
  const strMatch = expr.match(/^(===|!==|==|!=)\s*'([\s\S]*)'$/);
  if (strMatch) {
    const expected = unescapeEjsSingleQuoted(strMatch[2]);
    const actual = String(axisValue);
    const eq = actual === expected;
    return strMatch[1].startsWith('!') ? !eq : eq;
  }

  // 数值比较
  const numMatch = expr.match(/^(>=|<=|>|<|===|!==|==|!=)\s*(-?\d+(?:\.\d+)?)$/);
  if (numMatch) {
    const threshold = Number(numMatch[2]);
    const actual = Number(axisValue);
    // 轴值不是数字：数值比较无意义，视为不通过（而非 NaN 比较的隐式 false）
    if (!Number.isFinite(actual)) return false;
    switch (numMatch[1]) {
      case '>=': return actual >= threshold;
      case '<=': return actual <= threshold;
      case '>': return actual > threshold;
      case '<': return actual < threshold;
      case '===':
      case '==': return actual === threshold;
      case '!==':
      case '!=': return actual !== threshold;
      default: return null;
    }
  }

  return null;
}

export interface SimulateStageDispatchInput {
  stages: StageDefinition[];
  axisType: StageAxisType;
  numericDirection?: NumericDirection;
  /** 轴当前值；undefined 模拟「变量未定义」 */
  axisValue: string | number | undefined;
}

/**
 * 模拟一次调度：给定轴值，返回命中的阶段与逐条求值明细。
 * 与 buildDispatcherContent 的 if/else-if 顺序、条件生成规则保持一致。
 */
export function simulateStageDispatch(input: SimulateStageDispatchInput): StageDispatchResult {
  const { stages: rawStages, axisType, numericDirection, axisValue } = input;

  // 必须与导出前的顺序一致：StepStagedMode.handleApply 会先 sortStagesByDirection
  // 再交给 buildDispatcherContent 生成 if/else-if 链。模拟器若按原始数组顺序求值，
  // 在阶段乱序时会判出与实际卡片不同的胜出阶段——那正好是模拟器唯一要回答的问题。
  const stages = sortStagesByDirection(rawStages, axisType, numericDirection);

  const resolveCondition = (stage: StageDefinition): string =>
    stage.condition
    || autoCondition(
      axisType,
      axisType === 'enum' ? stage.name : (stage as { threshold?: number }).threshold ?? 0,
      numericDirection,
    );

  // 轴变量未定义：EJS 的第一个 if 分支（=== undefined）直接短路，任何阶段都不会被求值。
  // 必须与 EJS 严格对齐：null/'' 在 ST 运行时会进入阶段匹配（通常落兜底 else），
  // 模拟器若也短路会给出与运行时不一致的诊断结论。
  if (axisValue === undefined) {
    return {
      outcome: 'undefined-axis',
      matchedStage: null,
      matchedIndex: -1,
      evaluations: stages.map((stage) => ({
        stage,
        condition: resolveCondition(stage),
        passed: false,
        winner: false,
      })),
    };
  }

  const evaluations: StageEvaluation[] = [];
  let matchedIndex = -1;

  stages.forEach((stage, i) => {
    const condition = resolveCondition(stage);
    const result = evaluateStageCondition(axisValue, condition);
    const passed = result === true;
    // 首个为真者胜出；后续即便为真也不会被 ST 执行（else-if 链）
    const winner = passed && matchedIndex === -1;
    if (winner) matchedIndex = i;
    evaluations.push({
      stage,
      condition,
      passed,
      winner,
      ...(result === null ? { parseError: '条件表达式无法解析，请检查写法' } : {}),
    });
  });

  return {
    outcome: matchedIndex >= 0 ? 'matched' : 'no-match',
    matchedStage: matchedIndex >= 0 ? stages[matchedIndex] : null,
    matchedIndex,
    evaluations,
  };
}

/**
 * 为数值轴推导一个合理的滑杆范围（覆盖全部阈值并留出余量）。
 * 阶段全部无数值阈值时回退到 0-100。
 */
export function deriveNumericAxisRange(
  stages: StageDefinition[],
  numericDirection: NumericDirection = '>=',
): { min: number; max: number; step: number } {
  const thresholds: number[] = [];
  for (const stage of stages) {
    // 只采信「真实存在」的阈值：既无 condition 也无 threshold 的阶段（典型是枚举轴）
    // 不能用 autoCondition 合成一个 0——那会让「没有阈值」与「阈值都是 0」无法区分，
    // 推出 -1~1 这种没有可用行程的滑杆范围。
    let raw: string | number | undefined;
    if (stage.condition) {
      raw = stage.condition;
    } else if (Number.isFinite((stage as { threshold?: number }).threshold)) {
      raw = autoCondition('number', (stage as { threshold?: number }).threshold!, numericDirection);
    } else {
      continue;
    }
    const m = String(raw).match(/(-?\d+(?:\.\d+)?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) thresholds.push(n);
    }
  }
  if (thresholds.length === 0) return { min: 0, max: 100, step: 1 };

  const lo = Math.min(...thresholds);
  const hi = Math.max(...thresholds);
  // 只有单个（或全部相同）阈值时按其量级给出可用行程，避免退化成 ±1
  const span = hi > lo ? hi - lo : Math.max(Math.abs(lo), 10);
  const pad = Math.max(Math.ceil(span * 0.2), 1);
  const min = Math.floor(lo - pad);
  const max = Math.ceil(hi + pad);
  // 小数阈值时用更细的步长
  const hasFraction = thresholds.some((n) => !Number.isInteger(n));
  return { min, max, step: hasFraction ? 0.1 : 1 };
}
