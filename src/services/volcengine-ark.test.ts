/**
 * Volcengine Ark API 集成测试
 * 验证 deepseek-v4-flash 模型在 /api/coding/v3 接口上的可用性
 */
import { describe, it, expect } from 'vitest';

const VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const VOLCENGINE_API_KEY = (import.meta.env.VOLCENGINE_API_KEY as string) || '';
const TEST_MODEL = 'deepseek-v4-flash';

async function callVolcengineArk(messages: Array<{ role: string; content: string }>, maxTokens = 100): Promise<any> {
  const response = await fetch(`${VOLCENGINE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${VOLCENGINE_API_KEY}`,
    },
    body: JSON.stringify({
      model: TEST_MODEL,
      messages,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 调用失败 (${response.status}): ${errorText}`);
  }

  return response.json();
}

describe.skipIf(!VOLCENGINE_API_KEY)('Volcengine Ark API - deepseek-v4-flash', () => {
  it('应该能成功调用聊天接口并返回响应', async () => {
    const result = await callVolcengineArk([
      { role: 'user', content: 'Say "test passed" in English.' },
    ]);

    expect(result).toBeDefined();
    expect(result.choices).toBeDefined();
    expect(result.choices.length).toBeGreaterThan(0);
    expect(result.choices[0].message).toBeDefined();
    expect(result.choices[0].message.content).toBeDefined();
    expect(result.model).toBe(TEST_MODEL);
  }, 30000);

  it('应该能处理中文内容', async () => {
    const result = await callVolcengineArk([
      { role: 'user', content: '用中文回复：测试通过' },
    ], 200);

    expect(result).toBeDefined();
    expect(result.choices[0].message.content).toContain('测试');
  }, 30000);

  it('应该能处理多轮对话', async () => {
    const result = await callVolcengineArk([
      { role: 'system', content: '你是一个 helpful assistant。' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮助你的吗？' },
      { role: 'user', content: '请告诉我今天的日期' },
    ], 150);

    expect(result).toBeDefined();
    expect(result.choices[0].message.content).toBeDefined();
  }, 30000);

  it('应该返回正确的 usage 统计', async () => {
    const result = await callVolcengineArk([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.usage).toBeDefined();
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBeGreaterThan(0);
  }, 30000);
});
