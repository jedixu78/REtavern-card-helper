/**
 * ai-json 单元测试 — 聚焦截断/未转义引号场景。
 *
 * 核心回归：AI 在 description 字符串值中生成未转义双引号且后跟逗号时
 * （如 `绰号"小白",因为...`），旧逻辑会把 `"` 误判为字符串终止符，
 * 导致提取到的 description 只有几十字。修复后应提取完整内容。
 */
import { describe, it, expect } from 'vitest';
import { parseAIJson, extractStringFieldFromRaw, fixUnescapedQuotesInStrings } from './ai-json';

describe('extractStringFieldFromRaw — 未转义引号后跟逗号', () => {
  it('内容含 `绰号"小白",因为` 时不应截断', () => {
    const raw = `{"name":"冯玉漱","description":"## 基本信息\\n绰号"小白",因为性格内向\\n## 外貌特征\\n身高168cm","constant":true}`;
    const desc = extractStringFieldFromRaw(raw, 'description');
    expect(desc).not.toBeNull();
    expect(desc!.length).toBeGreaterThan(30);
    expect(desc!).toContain('性格内向');
    expect(desc!).toContain('身高168cm');
  });

  it('内容含多个未转义引号+逗号时全部保留', () => {
    const raw = `{"description":"口头禅"啧",经常使用。人称"冷面",但其实很温柔","constant":false}`;
    const desc = extractStringFieldFromRaw(raw, 'description');
    expect(desc).not.toBeNull();
    expect(desc!).toContain('其实很温柔');
    expect(desc!).toContain('经常使用');
  });

  it('正常 JSON 的 description 仍能正确提取', () => {
    const raw = `{"name":"测试","description":"## 基本信息\\n姓名：测试\\n\\n## 外貌特征\\n身高180cm","constant":true}`;
    const desc = extractStringFieldFromRaw(raw, 'description');
    expect(desc).not.toBeNull();
    expect(desc!).toContain('身高180cm');
  });

  it('截断 JSON（无闭合引号）返回已有内容', () => {
    const raw = `{"description":"## 基本信息\\n姓名：测试\\n年龄：38岁`;
    const desc = extractStringFieldFromRaw(raw, 'description');
    expect(desc).not.toBeNull();
    expect(desc!).toContain('38岁');
  });

  it('description 后跟 } 时不误判', () => {
    const raw = `{"name":"测试","description":"内容 ending here"}`;
    const desc = extractStringFieldFromRaw(raw, 'description');
    expect(desc).toBe('内容 ending here');
  });
});

describe('fixUnescapedQuotesInStrings — 未转义引号后跟逗号', () => {
  it('内容含 `绰号"小白",因为` 时转义内部引号而非截断', () => {
    const raw = `{"name":"冯玉漱","description":"绰号"小白",因为性格内向","constant":true}`;
    const fixed = fixUnescapedQuotesInStrings(raw);
    // 修复后应能被 JSON.parse 解析
    const parsed = JSON.parse(fixed);
    expect((parsed as { description: string }).description).toContain('性格内向');
    expect((parsed as { description: string }).description).toContain('小白');
  });

  it('正常 JSON 不被改动', () => {
    const raw = `{"name":"测试","description":"正常内容","constant":true}`;
    const fixed = fixUnescapedQuotesInStrings(raw);
    expect(JSON.parse(fixed)).toEqual(JSON.parse(raw));
  });

  it('数组中字符串后的逗号仍正确识别为终止符', () => {
    const raw = `{"keys":["关键词一","关键词二"],"name":"测试"}`;
    const fixed = fixUnescapedQuotesInStrings(raw);
    expect(JSON.parse(fixed)).toEqual(JSON.parse(raw));
  });
});

describe('parseAIJson — 角色描述截断回归', () => {
  it('6000字描述含未转义引号时完整解析', () => {
    // 模拟 AI 输出：长描述中间有未转义引号+逗号
    const longDesc = '## 基本信息\\n姓名：冯玉漱\\n年龄：38岁\\n'
      + '绰号"小白",因为皮肤白皙\\n'
      + '## 外貌特征\\n身高168cm，骨架纤细\\n'
      + '## 性格调色盘\\n底色：内敛克制\\n'
      + '## 背景设定\\n出身寒微，12岁时被收养\\n'
      + '## 关系设定\\n与{{user}}：青梅竹马\\n'
      + '## 三面性\\n日常面：温和沉默\\n压力面：冷硬如铁\\n隐藏面：脆弱无助';
    const raw = `{"name":"冯玉漱","description":"${longDesc}","constant":true}`;
    const parsed = parseAIJson(raw) as { name: string; description: string; constant: boolean } | null;
    expect(parsed).not.toBeNull();
    expect(parsed!.description.length).toBeGreaterThan(100);
    expect(parsed!.description).toContain('小白');
    expect(parsed!.description).toContain('三面性');
    expect(parsed!.description).toContain('脆弱无助');
    expect(parsed!.constant).toBe(true);
  });

  it('parseAIJson 对正常 JSON 直接解析', () => {
    const raw = `{"name":"测试","description":"正常内容","constant":true}`;
    const parsed = parseAIJson(raw) as { name: string } | null;
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('测试');
  });
});
