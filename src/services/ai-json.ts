/**
 * ai-json — 解析 AI 返回文本中的 JSON。
 *
 * 从 constants/prompts.ts 抽出：这些函数与提示词常量零耦合，却被 ~6 个模块
 * 依赖。留在 prompts.ts 里会让「只想解析 JSON」的调用方连带引入 1300 行提示词
 * 以及 prompts.ts 自身对 staged-templates → mvu-builder 的依赖链。
 *
 * 解析策略（逐层降级，见 parseAIJson）：直接解析 → 清洗后解析 →
 * 提取代码围栏内的 JSON → 提取括号配对的最大 JSON 片段。
 */

/**
 * Utility: strip markdown code fences from AI responses.
 * AI models often wrap JSON in ```json ... ``` blocks.
 */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fullFence = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/i);
  return (fullFence?.[1] || trimmed).trim();
}

/**
 * Sanitize common JSON issues in AI responses before parsing:
 * - Trailing commas before } or ]
 * - Single quotes instead of double quotes (simple heuristic)
 * - Unescaped newlines / tabs / control characters inside string values
 */
function sanitizeJsonString(raw: string): string {
  let s = raw.trim().replace(/^\uFEFF/, '');
  // Remove trailing commas: ,} or ,]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Replace single-quoted keys/values with double-quoted (simple cases)
  // Only if the string has no double quotes at all (heuristic to avoid breaking valid JSON)
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'([^']*)'/g, '"$1"');
  }

  // Walk through the text and fix unescaped whitespace/control chars inside JSON strings.
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inString) {
      result += ch;
      if (ch === '"') {
        inString = true;
        escaped = false;
      }
      continue;
    }
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      result += ch;
      inString = false;
      continue;
    }
    // Inside a JSON string value: escape raw whitespace/control characters.
    if (ch === '\n') { result += '\\n'; continue; }
    if (ch === '\r') { result += '\\r'; continue; }
    if (ch === '\t') { result += '\\t'; continue; }
    if (ch < ' ') {
      // Drop other control characters (e.g. 0x00-0x08, 0x0b-0x0c, 0x0e-0x1f)
      continue;
    }
    result += ch;
  }
  return result;
}

function tryParseJson(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch { /* continue */ }

  try {
    return JSON.parse(sanitizeJsonString(candidate));
  } catch {
    return null;
  }
}

function extractFencedJsonCandidates(text: string): string[] {
  return Array.from(text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g))
    .map(match => match[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
}

function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      if (stack.length > 0) inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (stack.length === 0) start = i;
      stack.push(ch === '{' ? '}' : ']');
      continue;
    }

    if (ch !== '}' && ch !== ']') continue;
    if (stack.length === 0) continue;

    const expected = stack[stack.length - 1];
    if (ch !== expected) {
      stack.length = 0;
      start = -1;
      inString = false;
      escaped = false;
      continue;
    }

    stack.pop();
    if (stack.length === 0 && start >= 0) {
      candidates.push(text.slice(start, i + 1));
      start = -1;
    }
  }

  return Array.from(new Set(candidates)).sort((a, b) => b.length - a.length);
}

/**
 * Attempt to parse AI response as JSON with multi-layer fallback.
 *
 * Strategy:
 * 1. Strip markdown fences, direct parse
 * 2. Sanitize common AI quirks (trailing commas, single quotes), retry
 * 3. Extract first JSON object/array substring, sanitize and retry
 * 4. Try to find multiple JSON objects/arrays and return the largest
 * 5. Return null if all attempts fail
 */
export function parseAIJson(text: string): unknown | null {
  const cleaned = stripMarkdownFences(text);

  // Attempt 1: Direct parse
  const direct = tryParseJson(cleaned);
  if (direct !== null) return direct;

  // Attempt 2: Sanitize and retry
  const sanitized = sanitizeJsonString(cleaned);
  const sanitizedResult = tryParseJson(sanitized);
  if (sanitizedResult !== null) return sanitizedResult;

  // Attempt 3: Prefer JSON inside code fences, then balanced object/array spans.
  const allMatches = [
    ...extractFencedJsonCandidates(cleaned),
    ...extractBalancedJsonCandidates(cleaned),
  ];

  for (const m of allMatches.slice(0, 5)) {
    const parsed = tryParseJson(m);
    if (parsed !== null) return parsed;
  }

  return null;
}
