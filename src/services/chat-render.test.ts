import { describe, it, expect } from 'vitest';
import {
  applyRegexScripts,
  extractRegexScripts,
  segmentRenderedMessage,
  messageContainsHtml,
  buildSandboxSrcDoc,
  parseChatFrameMessage,
  CHAT_FRAME_MESSAGE_KEY,
  type CardRegexScript,
} from './chat-render';

const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';

/** 与 card-exporter 生成的「状态栏界面」脚本同形：findRegex 是纯字符串字面量 */
function statusBarScript(overrides: Partial<CardRegexScript> = {}): CardRegexScript {
  return {
    scriptName: '状态栏界面',
    findRegex: STATUS_PLACEHOLDER,
    replaceString: '```html\n<div class="bar">HP</div>\n```',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    ...overrides,
  };
}

/** 与 card-exporter 生成的「对AI隐藏状态栏」脚本同形 */
function hideFromPromptScript(): CardRegexScript {
  return {
    scriptName: '对AI隐藏状态栏',
    findRegex: STATUS_PLACEHOLDER,
    replaceString: '',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
  };
}

describe('extractRegexScripts', () => {
  it('从卡片 data.extensions.regex_scripts 取出脚本', () => {
    const card = { data: { extensions: { regex_scripts: [statusBarScript()] } } };
    expect(extractRegexScripts(card)).toHaveLength(1);
  });

  it('结构缺失时返回空数组而不抛错', () => {
    expect(extractRegexScripts(null)).toEqual([]);
    expect(extractRegexScripts({})).toEqual([]);
    expect(extractRegexScripts({ data: {} })).toEqual([]);
    expect(extractRegexScripts({ data: { extensions: { regex_scripts: 'nope' } } })).toEqual([]);
  });
});

describe('applyRegexScripts — 字面量 findRegex', () => {
  it('把状态栏占位符替换成面板 HTML', () => {
    const out = applyRegexScripts(`她笑了。\n${STATUS_PLACEHOLDER}`, [statusBarScript()], {
      pass: 'display',
      role: 'assistant',
    });
    expect(out).toContain('<div class="bar">HP</div>');
    expect(out).not.toContain(STATUS_PLACEHOLDER);
  });

  it('替换文本里的 $ 序列不被 JS 的 replace 语义吃掉', () => {
    const script = statusBarScript({ replaceString: 'cost: $$100 $& $\'' });
    const out = applyRegexScripts(STATUS_PLACEHOLDER, [script], { pass: 'display', role: 'assistant' });
    expect(out).toBe("cost: $$100 $& $'");
  });

  it('占位符出现多次时全部替换', () => {
    const out = applyRegexScripts(`${STATUS_PLACEHOLDER}x${STATUS_PLACEHOLDER}`, [
      statusBarScript({ replaceString: 'BAR' }),
    ]);
    expect(out).toBe('BARxBAR');
  });
});

describe('applyRegexScripts — /pattern/flags findRegex', () => {
  const updateScript: CardRegexScript = {
    scriptName: '对AI隐藏变量更新',
    findRegex: '/<(update(?:variable)?)>[\\s\\S]*?<\\/\\1>/gi',
    replaceString: '',
    markdownOnly: false,
    promptOnly: true,
  };

  it('正则写法被解析并全局替换', () => {
    const text = '前<update>a=1</update>中<update>b=2</update>后';
    const out = applyRegexScripts(text, [updateScript], { pass: 'prompt', role: 'assistant' });
    expect(out).toBe('前中后');
  });

  it('replaceString 支持 $1 捕获组', () => {
    const script: CardRegexScript = {
      findRegex: '/<b>(.+?)<\\/b>/g',
      replaceString: '【$1】',
    };
    expect(applyRegexScripts('说<b>你好</b>了', [script])).toBe('说【你好】了');
  });

  it('replaceString 支持 {{match}}', () => {
    const script: CardRegexScript = { findRegex: '/\\d+/g', replaceString: '[{{match}}]' };
    expect(applyRegexScripts('有 42 个', [script])).toBe('有 [42] 个');
  });

  it('trimStrings 在替换前从命中文本里剔除', () => {
    const script: CardRegexScript = {
      findRegex: '/<note>[\\s\\S]*?<\\/note>/g',
      replaceString: '{{match}}',
      trimStrings: ['<note>', '</note>'],
    };
    expect(applyRegexScripts('a<note>hi</note>b', [script])).toBe('ahib');
  });

  it('裸写（不带斜杠）的正则也按正则编译 —— 参考卡「二十一人会」的界面脚本就是这种写法', () => {
    const script: CardRegexScript = {
      scriptName: '[界面]初始光谱设定',
      findRegex: '<initial_setup>[\\s\\S]*?<\\/initial_setup>',
      replaceString: '<div>面板</div>',
      placement: [1, 2],
      markdownOnly: true,
    };
    const out = applyRegexScripts('开场\n<initial_setup>\n一堆设定\n</initial_setup>', [script]);
    expect(out).toBe('开场\n<div>面板</div>');
  });

  it('非法正则退化为字面量匹配，不影响其它脚本', () => {
    const bad: CardRegexScript = { findRegex: '/(unclosed/g', replaceString: 'X' };
    const good: CardRegexScript = { findRegex: 'keep', replaceString: 'KEPT' };
    expect(applyRegexScripts('keep me', [bad, good])).toBe('KEPT me');
  });
});

describe('applyRegexScripts — 通道与 placement 过滤', () => {
  it('display 通道跳过 promptOnly 脚本', () => {
    const out = applyRegexScripts(STATUS_PLACEHOLDER, [hideFromPromptScript()], {
      pass: 'display',
      role: 'assistant',
    });
    expect(out).toBe(STATUS_PLACEHOLDER);
  });

  it('prompt 通道跳过 markdownOnly 脚本，但执行 promptOnly 脚本', () => {
    const out = applyRegexScripts(`你好${STATUS_PLACEHOLDER}`, [statusBarScript(), hideFromPromptScript()], {
      pass: 'prompt',
      role: 'assistant',
    });
    expect(out).toBe('你好');
  });

  it('disabled 脚本不执行', () => {
    const out = applyRegexScripts(STATUS_PLACEHOLDER, [statusBarScript({ disabled: true })]);
    expect(out).toBe(STATUS_PLACEHOLDER);
  });

  it('placement=[2] 的脚本不作用于用户消息', () => {
    const out = applyRegexScripts(STATUS_PLACEHOLDER, [statusBarScript()], {
      pass: 'display',
      role: 'user',
    });
    expect(out).toBe(STATUS_PLACEHOLDER);
  });

  it('placement 缺省时用户与 AI 消息都作用', () => {
    const script = statusBarScript({ placement: undefined, replaceString: 'BAR' });
    expect(applyRegexScripts(STATUS_PLACEHOLDER, [script], { role: 'user' })).toBe('BAR');
    expect(applyRegexScripts(STATUS_PLACEHOLDER, [script], { role: 'assistant' })).toBe('BAR');
  });

  it('多个脚本按顺序串联', () => {
    const a: CardRegexScript = { findRegex: 'A', replaceString: 'B' };
    const b: CardRegexScript = { findRegex: 'B', replaceString: 'C' };
    expect(applyRegexScripts('A', [a, b])).toBe('C');
  });

  it('空文本 / 空脚本表原样返回', () => {
    expect(applyRegexScripts('', [statusBarScript()])).toBe('');
    expect(applyRegexScripts('hi', [])).toBe('hi');
  });
});

describe('segmentRenderedMessage', () => {
  it('把 ```html 围栏切成 html 段，其余为文本段', () => {
    const segs = segmentRenderedMessage('她笑了。\n```html\n<div>面板</div>\n```\n结束');
    expect(segs.map((s) => s.type)).toEqual(['text', 'html', 'text']);
    expect(segs[1].content).toContain('<div>面板</div>');
    expect(segs[0].content).toBe('她笑了。');
  });

  it('未闭合的围栏（回复被截断）仍按 HTML 渲染，不把围栏标记露出来', () => {
    const segs = segmentRenderedMessage('开场\n```html\n<div>还没');
    expect(segs.map((s) => s.type)).toEqual(['text', 'html']);
    expect(segs[0].content).toBe('开场');
    expect(segs[1].content).toBe('<div>还没');
    expect(segs.some((s) => s.content.includes('```'))).toBe(false);
  });

  it('无围栏的裸 HTML 块也识别为 html 段', () => {
    const segs = segmentRenderedMessage('<div class="bar">HP 100</div>');
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('html');
  });

  it('普通角色扮演文本里的尖括号不被误判为 HTML', () => {
    const segs = segmentRenderedMessage('*她皱眉* <你在说什么？>');
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('text');
  });

  it('空串返回空数组', () => {
    expect(segmentRenderedMessage('')).toEqual([]);
  });
});

describe('messageContainsHtml', () => {
  it('识别 html 围栏与裸 HTML 块', () => {
    expect(messageContainsHtml('```html\n<div></div>\n```')).toBe(true);
    expect(messageContainsHtml('<style>a{}</style>')).toBe(true);
    expect(messageContainsHtml('普通文本')).toBe(false);
    expect(messageContainsHtml('')).toBe(false);
  });
});

describe('buildSandboxSrcDoc', () => {
  it('片段 HTML 被包进最小文档，并带上高度回传脚本', () => {
    const doc = buildSandboxSrcDoc('<div id="x">hi</div>', 'cf-1');
    expect(doc).toContain('<div id="x">hi</div>');
    expect(doc).toContain('"cf-1"');
    expect(doc).toContain(CHAT_FRAME_MESSAGE_KEY);
    expect(doc.startsWith('<!doctype html>')).toBe(true);
  });

  it('卡内已是完整文档时不再套一层，只注入高度脚本', () => {
    const full = '<!doctype html>\n<html lang="zh-CN"><head><style>body{color:red}</style></head><body><div>面板</div></body></html>';
    const doc = buildSandboxSrcDoc(full, 'cf-2');
    // 只有一份 <html>，说明没有嵌套包裹
    expect(doc.match(/<html/gi)).toHaveLength(1);
    expect(doc).toContain('body{color:red}');
    expect(doc.indexOf('cf-2')).toBeLessThan(doc.lastIndexOf('</body>'));
  });

  it('完整文档缺少 </body> 时脚本追加到末尾', () => {
    const doc = buildSandboxSrcDoc('<html><body><div>面板</div>', 'cf-3');
    expect(doc).toContain('cf-3');
    expect(doc.indexOf('<div>面板</div>')).toBeLessThan(doc.indexOf('cf-3'));
  });
});

describe('parseChatFrameMessage', () => {
  it('解析合法的高度消息', () => {
    const parsed = parseChatFrameMessage({ [CHAT_FRAME_MESSAGE_KEY]: 'cf-1', height: 210.4 });
    expect(parsed).toEqual({ frameId: 'cf-1', height: 211 });
  });

  it('过滤无关 postMessage', () => {
    expect(parseChatFrameMessage(null)).toBeNull();
    expect(parseChatFrameMessage('hello')).toBeNull();
    expect(parseChatFrameMessage({ height: 100 })).toBeNull();
    expect(parseChatFrameMessage({ [CHAT_FRAME_MESSAGE_KEY]: 'cf-1' })).toBeNull();
    expect(parseChatFrameMessage({ [CHAT_FRAME_MESSAGE_KEY]: 'cf-1', height: -5 })).toBeNull();
  });

  it('高度上限防止畸形内容撑爆页面', () => {
    const parsed = parseChatFrameMessage({ [CHAT_FRAME_MESSAGE_KEY]: 'cf-1', height: 999999 });
    expect(parsed?.height).toBe(4000);
  });
});
