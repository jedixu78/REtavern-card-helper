/**
 * AI API Proxy Route — OpenAI-compatible
 *
 * POST /api/ai/models       - List available models from the user's API endpoint
 * POST /api/ai/chat         - Proxy a chat completion request (non-streaming)
 * POST /api/ai/chat/stream  - Proxy a chat completion request (SSE streaming)
 *
 * Both endpoints accept a full API URL from the frontend (already normalized).
 * The backend acts purely as a CORS proxy — no keys are stored server-side.
 *
 * This module runs on both Cloudflare Workers (Web APIs) and Node.js (@hono/node-server).
 */
import { Hono } from 'hono';

const router = new Hono();

const MODEL_LIST_TIMEOUT_MS = 15_000;
const CHAT_TIMEOUT_BASE_MS = 120_000;
const STREAM_TIMEOUT_BASE_MS = 180_000;
const CHAT_TIMEOUT_MAX_MS = 10 * 60_000;
const STREAM_TIMEOUT_MAX_MS = 20 * 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 请求体上限 2MB

// ─── 防护层 1：SSRF 校验 ──────────────────────────────────────────────────────

/** IPv4 是否为回环段（127.0.0.0/8）。回环单独归类：本地自托管时默认放行。 */
function isLoopbackIPv4(a) {
  return a === 127;
}

/** IPv4 各段是否落在（回环之外）禁止访问的网段（入参为前两个八位组）。 */
function isForbiddenIPv4(a, b) {
  return (
    a === 10 ||                           // 私网 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||  // 私网 172.16.0.0/12
    (a === 192 && b === 168) ||           // 私网 192.168.0.0/16
    (a === 169 && b === 254) ||           // 链路本地 169.254.0.0/16（AWS/GCP 元数据 169.254.169.254）
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10（阿里云元数据 100.100.100.200）
    a === 0                               // 0.0.0.0/8（含 0.0.0.0）
  );
}

/**
 * SSRF 防护：校验前端传入的上游 API 地址，禁止代理访问内网/云元数据服务。
 * 返回中文错误信息字符串表示拒绝，返回 null 表示放行。
 *
 * 不做域名白名单——用户自带任意公网 AI 端点（中转站/自定义域名）是核心用例。
 *
 * 回环地址（localhost / 127.0.0.1 / ::1）**默认放行**：本地自托管时连接本机模型
 * （Oobabooga :5000、KoboldCPP :5001，见设置页内置预设）是一等用例。公网部署
 * 应设置环境变量 PROXY_BLOCK_LOOPBACK=1 把回环一并拦截（blockLoopback 参数）。
 * 其余内网段/元数据地址始终拦截——那才是 SSRF 的主要目标。
 *
 * 注意：WHATWG URL 解析器会把十进制/十六进制 IPv4 写法规范化为点分十进制
 * （如 http://2130706433/ → 127.0.0.1），IPv6 统一为小写压缩形式，
 * 所以按 url.hostname 检查即可覆盖这些变体。
 *
 * 局限：Cloudflare Workers 环境没有 node:dns，无法先解析域名再校验其真实 IP，
 * 因此只能按 hostname / IP 字面量拦截。公网域名解析到内网 IP（DNS rebinding）
 * 无法在此拦截，公网部署时建议配合网络层隔离（如容器网络策略）。
 */
function isForbiddenUpstream(rawUrl, blockLoopback = false) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'API 地址格式无效，请检查设置中的 API 地址';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '仅支持 http/https 协议的 API 地址';
  }

  // 去掉尾点（http://localhost./ 与 localhost 等价）后统一小写比较
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');

  // 回环类主机名：默认放行，PROXY_BLOCK_LOOPBACK 开启时拦截
  const isLoopbackHost = hostname === 'localhost' || hostname.endsWith('.localhost');
  if (isLoopbackHost) {
    return blockLoopback ? '本服务已禁止代理访问本机地址' : null;
  }

  // 始终禁止的主机名：mDNS/内网域名与云元数据域名
  if (
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    return '禁止代理访问内网地址';
  }

  // IPv4 字面量
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (isLoopbackIPv4(a)) {
      return blockLoopback ? '本服务已禁止代理访问本机地址' : null;
    }
    if (isForbiddenIPv4(a, b)) {
      return '禁止代理访问内网 IP 地址';
    }
  }

  // IPv6 字面量（URL.hostname 形如 "[::1]"）
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = hostname.slice(1, -1);
    // IPv4 映射地址：URL 解析器序列化为 ::ffff:7f00:1 这样的十六进制形式，
    // 还原出内嵌 IPv4 的前两个八位组后复用 IPv4 检查
    const mapped = ipv6.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      if (isLoopbackIPv4(high >> 8)) {
        return blockLoopback ? '本服务已禁止代理访问本机地址' : null;
      }
      if (isForbiddenIPv4(high >> 8, high & 0xff)) {
        return '禁止代理访问内网 IP 地址';
      }
    }
    if (ipv6 === '::1') {
      // IPv6 回环，与 127.0.0.1 同类
      return blockLoopback ? '本服务已禁止代理访问本机地址' : null;
    }
    if (
      ipv6 === '::' ||                                   // 未指定地址
      ipv6.startsWith('fc') || ipv6.startsWith('fd') ||  // 唯一本地 fc00::/7
      /^fe[89ab]/.test(ipv6)                             // 链路本地 fe80::/10
    ) {
      return '禁止代理访问内网 IP 地址';
    }
  }

  return null;
}

/** 从 Hono 上下文读取「是否连回环也拦截」的部署开关（公网部署应设 PROXY_BLOCK_LOOPBACK=1）。 */
function shouldBlockLoopback(c) {
  return Boolean(String(c.env?.PROXY_BLOCK_LOOPBACK ?? '').trim());
}

// ─── 防护层 3：请求体大小上限 ─────────────────────────────────────────────────

/**
 * 读取并解析 JSON 请求体，超过 MAX_BODY_BYTES 时拒绝（413）。
 * 先用 Content-Length 头预判（客户端可能不带该头），读取后再按实际字节数二次校验。
 * 返回 { ok: true, data } 或 { ok: false, response }。JSON 解析失败时抛出，
 * 由各路由的 catch 统一处理（与原先 c.req.json() 的行为一致）。
 */
async function readJsonBody(c) {
  const tooLarge = () => ({
    ok: false,
    response: c.json({ error: '请求体过大，上限 2MB' }, 413),
  });

  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return tooLarge();
  }

  // 流式累计读取并在超限即刻中止——不能先 arrayBuffer() 再检查长度：
  // chunked 请求（无 Content-Length）会在校验前就把任意大的 body 全部读进内存。
  const body = c.req.raw.body;
  if (!body) {
    // 空 body：与原 c.req.json() 行为一致，JSON.parse('') 抛错由路由 catch 统一处理
    return { ok: true, data: JSON.parse('') };
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* 忽略 */ }
      return tooLarge();
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, data: JSON.parse(new TextDecoder().decode(buffer)) };
}

// ─── 防护层 2：可选访问令牌 ───────────────────────────────────────────────────
// 设置了 PROXY_ACCESS_TOKEN 环境变量才启用（Node 侧 process.env 由 server/index.js
// 作为 env 传入，Workers 侧为 binding）；未设置时行为完全不变，自托管用户零影响。
// CORS 预检 OPTIONS 由 app.js 的 cors 中间件直接响应，不会走到这里。
router.use('*', async (c, next) => {
  const expected = (c.env?.PROXY_ACCESS_TOKEN || '').trim();
  if (expected && c.req.header('X-Proxy-Token') !== expected) {
    return c.json({ error: '访问令牌无效或缺失，请在请求头 X-Proxy-Token 中携带正确令牌' }, 401);
  }
  await next();
});

function timeoutForTokens(maxTokens, baseMs, maxMs) {
  const tokenBudget = Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : 2000;
  const scaledMs = Math.ceil(tokenBudget * 90);
  return Math.min(Math.max(baseMs, scaledMs), maxMs);
}

const MAX_REDIRECTS = 3;

/**
 * fetch with timeout — aborts if the upstream doesn't respond within timeoutMs.
 * The timeout covers time-to-first-byte only; streaming continues without timeout.
 *
 * 重定向手动跟随（redirect:'manual'）并对每一跳的目标重新做 SSRF 校验——
 * 否则第一跳校验通过的公网上游只要回一个 302 Location 指向内网/元数据地址，
 * 默认的 redirect:'follow' 就会替攻击者把请求带进去，整层防护被一次跳转绕过。
 * 说明：手动跟随对所有 3xx 保留原方法与 body（等同 307/308 语义）；
 * AI API 端点的重定向场景（尾斜杠、http→https）不受影响。
 */
async function fetchWithTimeout(url, options, timeoutMs, blockLoopback = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(currentUrl, {
        ...options,
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location || hop >= MAX_REDIRECTS) {
        return res; // 非重定向、无 Location、或超过跳数上限：原样交给上层处理
      }
      const nextUrl = new URL(location, currentUrl).toString();
      const forbidden = isForbiddenUpstream(nextUrl, blockLoopback);
      if (forbidden) {
        throw new Error(`上游返回的重定向目标被安全策略阻止（${forbidden}）`);
      }
      currentUrl = nextUrl;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Build upstream request headers. Trims the key and adds OpenRouter-specific headers. */
function buildUpstreamHeaders(apiKey, upstreamUrl, { includeContentType = true } = {}) {
  const key = (apiKey || '').trim();
  const headers = {};
  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  // OpenRouter recommends these headers for model ranking and identification.
  if (upstreamUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://tavern-card-helper.tavern-helper.workers.dev';
    headers['X-Title'] = 'Tavern Card Helper';
  }
  return headers;
}

/** Validate that OpenRouter always has a non-empty API key. */
function validateOpenRouterKey(apiKey, upstreamUrl) {
  const key = (apiKey || '').trim();
  if (upstreamUrl.includes('openrouter.ai') && !key) {
    return { ok: false, error: '使用 OpenRouter 必须填写 API 密钥，请先在设置中保存 Key' };
  }
  return { ok: true, key };
}

/** Return a JSON error response (used only for upstream errors or exceptions). */
function jsonError(c, message, details, status) {
  return c.json({ error: message, details }, status);
}

/**
 * Wrap an upstream fetch Response so Hono can safely mutate its headers
 * (e.g. for CORS). Directly returning upstream responses causes
 * "TypeError: immutable" on Node because undici Response headers are frozen.
 *
 * Also strips hop-by-hop headers (Connection, Keep-Alive, Transfer-Encoding)
 * to avoid confusing downstream proxies such as Vite's dev server.
 */
function passThrough(response) {
  const headers = new Headers(response.headers);
  // Hop-by-hop headers must not be forwarded by proxies.
  const hopByHop = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'upgrade'];
  hopByHop.forEach((name) => headers.delete(name));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─── POST /models ─────────────────────────────────────────────────────────────
// Fetch available models from the user's OpenAI-compatible endpoint.
// Body: { apiUrl, apiKey } — apiUrl is already the /models endpoint
// Returns: upstream /models JSON response, passed through unchanged.
//
// Passing the response body straight through avoids JSON.parse() inside the
// Worker, which is the main cause of CPU-time-limit errors on the free tier.
router.post('/models', async (c) => {
  try {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const { apiUrl, apiKey } = body.data;

    if (!apiUrl) {
      return c.json({ error: '请填写 API 地址' }, 400);
    }

    const forbidden = isForbiddenUpstream(apiUrl, shouldBlockLoopback(c));
    if (forbidden) {
      return c.json({ error: forbidden }, 400);
    }

    const validation = validateOpenRouterKey(apiKey, apiUrl);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    const hasKey = Boolean(validation.key);
    console.log(`[Models Proxy] ${apiUrl} (key=${hasKey ? 'present' : 'missing'}, contentType=false)`);

    const response = await fetchWithTimeout(apiUrl, {
      method: 'GET',
      headers: buildUpstreamHeaders(validation.key, apiUrl, { includeContentType: false }),
    }, MODEL_LIST_TIMEOUT_MS, shouldBlockLoopback(c));

    console.log(`[Models Proxy] ${apiUrl} -> status ${response.status}`);

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[Models Proxy] ${apiUrl} -> error body:`, responseText.slice(0, 1000));
      return jsonError(c, `API 返回错误 ${response.status}`, responseText, response.status);
    }

    return c.body(responseText, response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return c.json({ error: '请求超时，请检查 API 地址是否正确' }, 504);
    }
    console.error('[Models Error]', err.message);
    return c.json({ error: '获取模型列表失败', details: err.message }, 500);
  }
});

// ─── POST /chat ───────────────────────────────────────────────────────────────
// Proxy an OpenAI-compatible chat completion request (non-streaming).
// Body: { messages, apiUrl, apiKey, model, temperature, max_tokens }
// Returns: upstream /chat/completions JSON response, passed through unchanged.
router.post('/chat', async (c) => {
  try {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const { messages, apiUrl, apiKey, model, temperature, max_tokens } = body.data;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: '缺少 messages 数组' }, 400);
    }
    if (!apiUrl) {
      return c.json({ error: '请填写 API 地址' }, 400);
    }

    const forbidden = isForbiddenUpstream(apiUrl, shouldBlockLoopback(c));
    if (forbidden) {
      return c.json({ error: forbidden }, 400);
    }

    const validation = validateOpenRouterKey(apiKey, apiUrl);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    const requestBody = {
      model: model || 'gpt-3.5-turbo',
      messages,
      temperature: temperature ?? 0.8,
      max_tokens: max_tokens ?? 8000,
    };

    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: buildUpstreamHeaders(validation.key, apiUrl),
      body: JSON.stringify(requestBody),
    }, timeoutForTokens(max_tokens, CHAT_TIMEOUT_BASE_MS, CHAT_TIMEOUT_MAX_MS), shouldBlockLoopback(c));

    const responseText = await response.text();

    if (!response.ok) {
      return jsonError(c, `AI API 返回错误 ${response.status}`, responseText, response.status);
    }

    return c.body(responseText, response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return c.json({ error: 'AI API 请求超时' }, 504);
    }
    console.error('[AI Proxy Error]', err.message);
    return c.json({ error: 'AI 代理请求失败', details: err.message }, 500);
  }
});

// ─── POST /chat/stream ────────────────────────────────────────────────────────
// Streaming chat completion via Server-Sent Events.
// Same body as /chat, returns upstream SSE stream, passed through unchanged.
//
// We avoid Hono's stream() helper and manual heartbeat logic. The upstream SSE
// stream is returned directly, so the Worker does almost no per-chunk work.
router.post('/chat/stream', async (c) => {
  try {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const { messages, apiUrl, apiKey, model, temperature, max_tokens } = body.data;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: '缺少 messages 数组' }, 400);
    }
    if (!apiUrl) {
      return c.json({ error: '请填写 API 地址' }, 400);
    }

    const forbidden = isForbiddenUpstream(apiUrl, shouldBlockLoopback(c));
    if (forbidden) {
      return c.json({ error: forbidden }, 400);
    }

    const validation = validateOpenRouterKey(apiKey, apiUrl);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    const requestBody = {
      model: model || 'gpt-3.5-turbo',
      messages,
      temperature: temperature ?? 0.8,
      max_tokens: max_tokens ?? 8000,
      stream: true,
    };

    console.log(`[Stream Proxy] url=${apiUrl} model=${model} key=${validation.key ? 'present' : 'missing'} msgs=${messages.length}`);

    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: buildUpstreamHeaders(validation.key, apiUrl),
      body: JSON.stringify(requestBody),
    }, timeoutForTokens(max_tokens, STREAM_TIMEOUT_BASE_MS, STREAM_TIMEOUT_MAX_MS), shouldBlockLoopback(c));

    console.log(`[Stream Proxy] url=${apiUrl} -> status ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Stream Proxy] url=${apiUrl} -> error body:`, errorText.slice(0, 1000));
      return jsonError(c, `AI API 返回错误 ${response.status}`, errorText, response.status);
    }

    // Pass upstream SSE stream straight through.
    // The Worker only sets up the pipe; no per-chunk parsing or heartbeats.
    return passThrough(response);
  } catch (err) {
    if (err.name === 'AbortError') {
      return c.json({ error: 'AI API 请求超时' }, 504);
    }
    console.error('[AI Stream Proxy Error]', err.message);
    return c.json({ error: 'AI 代理流式请求失败', details: err.message }, 500);
  }
});

export default router;
