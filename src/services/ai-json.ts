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
 * Attempt to fix unescaped double quotes inside JSON string values.
 * Handles the common AI mistake of generating:
 *   "description": "He said "hello" and left"
 * where the inner quotes should be escaped as \".
 *
 * Strategy: walk the text tracking JSON structure. When inside a string and we
 * encounter a `"`, check if it's a legitimate string terminator by looking ahead.
 * If the next non-whitespace character is NOT a JSON structural character (: , } ]),
 * the quote is likely unescaped content — escape it.
 */
export function fixUnescapedQuotesInStrings(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (!inString) {
      result += ch;
      if (ch === '"') inString = true;
      continue;
    }

    // Inside a string
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

    if (ch !== '"') {
      // Escape raw control characters that would break JSON
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
      if (ch < ' ') continue;
      result += ch;
      continue;
    }

    // ch === '"' — is this the real end of the string?
    // Look ahead past whitespace to find the next significant character.
    let j = i + 1;
    while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j++;

    const nextSig = j < raw.length ? raw[j] : '';

    if (nextSig === ',') {
      // 深层 lookahead：逗号后应该是 JSON key（"..."）或闭合括号才算终止符。
      // 否则可能是内容中未转义引号后跟逗号，如 `绰号"小白",因为...`
      let k = j + 1;
      while (k < raw.length && (raw[k] === ' ' || raw[k] === '\t' || raw[k] === '\n' || raw[k] === '\r')) k++;
      const afterComma = k < raw.length ? raw[k] : '';
      if (afterComma === '"' || afterComma === '}' || afterComma === ']' || afterComma === '') {
        // Real end of string
        result += ch;
        inString = false;
      } else {
        // Unescaped quote inside string content — escape it
        result += '\\"';
      }
      continue;
    }

    // A legitimate string terminator is followed by: } ] : or end of input
    if (nextSig === '}' || nextSig === ']' || nextSig === ':' || nextSig === '') {
      // Real end of string
      result += ch;
      inString = false;
    } else {
      // Unescaped quote inside string content — escape it
      result += '\\"';
    }
  }

  return result;
}

/**
 * Extract the value of a specific string field from raw (possibly truncated or
 * malformed) JSON text. Uses structural walking to find the field, then tracks
 * bracket depth to determine where the string value ends — handling unescaped
 * quotes that would defeat a simple regex.
 *
 * Returns null if the field is not found.
 */
export function extractStringFieldFromRaw(text: string, fieldName: string): string | null {
  // Locate the field name as a JSON key: "fieldName" followed by optional whitespace and colon
  const keyPattern = new RegExp(`"${fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
  const keyMatch = keyPattern.exec(text);
  if (!keyMatch) return null;

  // Find the opening quote of the value
  let pos = keyMatch.index + keyMatch[0].length;
  while (pos < text.length && text[pos] !== '"' && text[pos] !== '{' && text[pos] !== '[') pos++;
  if (pos >= text.length || text[pos] !== '"') return null;
  pos++; // skip opening quote

  // Walk forward tracking escape sequences. Collect the string value.
  let value = '';
  let escaped = false;

  for (let i = pos; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      // Process escape sequence
      switch (ch) {
        case 'n': value += '\n'; break;
        case 't': value += '\t'; break;
        case 'r': value += '\r'; break;
        case '"': value += '"'; break;
        case '\\': value += '\\'; break;
        case '/': value += '/'; break;
        case 'b': value += '\b'; break;
        case 'f': value += '\f'; break;
        case 'u': {
          const hex = text.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            value += ch;
          }
          break;
        }
        default: value += ch;
      }
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      // Is this the real end of the string?
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const nextSig = j < text.length ? text[j] : '';

      if (nextSig === ',') {
        // 深层 lookahead：逗号后应该是 JSON key（"..."）或闭合括号才算终止符。
        // 否则可能是内容中未转义引号后跟逗号，如 `绰号"小白",因为...`
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k])) k++;
        const afterComma = k < text.length ? text[k] : '';
        if (afterComma === '"' || afterComma === '}' || afterComma === ']' || afterComma === '') {
          return value.trim();
        }
        // 不是合法终止符 — 视为内容中的未转义引号
        value += '"';
        continue;
      }

      if (nextSig === '}' || nextSig === ']' || nextSig === '') {
        // Legitimate end of string
        return value.trim();
      }
      // Unescaped quote inside content — include it
      value += '"';
      continue;
    }

    value += ch;
  }

  // Reached end of text without finding closing quote (truncated)
  return value.trim() || null;
}

/**
 * Attempt to parse AI response as JSON with multi-layer fallback.
 *
 * Strategy:
 * 1. Strip markdown fences, direct parse
 * 2. Sanitize common AI quirks (trailing commas, single quotes), retry
 * 3. Fix unescaped quotes inside string values, retry
 * 4. Extract first JSON object/array substring, sanitize and retry
 * 5. Try to find multiple JSON objects/arrays and return the largest
 * 6. Return null if all attempts fail
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

  // Attempt 3: Fix unescaped quotes (common AI mistake) and retry
  const fixedQuotes = fixUnescapedQuotesInStrings(cleaned);
  if (fixedQuotes !== cleaned) {
    const fixedResult = tryParseJson(fixedQuotes);
    if (fixedResult !== null) return fixedResult;
    // Also try sanitize after fixing quotes
    const fixedSanitized = sanitizeJsonString(fixedQuotes);
    const fixedSanitizedResult = tryParseJson(fixedSanitized);
    if (fixedSanitizedResult !== null) return fixedSanitizedResult;
  }

  // Attempt 4: Prefer JSON inside code fences, then balanced object/array spans.
  const allMatches = [
    ...extractFencedJsonCandidates(cleaned),
    ...extractBalancedJsonCandidates(cleaned),
  ];

  for (const m of allMatches.slice(0, 5)) {
    const parsed = tryParseJson(m);
    if (parsed !== null) return parsed;
    // Also try with quote fix on each candidate
    const fixedM = fixUnescapedQuotesInStrings(m);
    if (fixedM !== m) {
      const fixedParsed = tryParseJson(fixedM);
      if (fixedParsed !== null) return fixedParsed;
    }
  }

  return null;
}
