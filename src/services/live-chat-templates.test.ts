/**
 * Live chat panel template tests.
 * Covers the robustness fixes: static pre-rendered initial comments (so the panel
 * shows comments even if the runtime <script> doesn't execute in SillyTavern) and
 * </script> escaping in injected comments (so user comments can't break the HTML).
 */
import { describe, it, expect } from 'vitest';
import { generateLiveChatHtml } from './live-chat-templates';

describe('generateLiveChatHtml', () => {
  it('预渲染初始评论为静态 HTML，即使脚本未执行也能显示', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: ['开播了开播了！', '前排吃瓜'] });
    expect(html).toContain('<div class="lc-msg">');
    expect(html).toContain('开播了开播了！');
    expect(html).toContain('lc-text');
  });

  it('无初始评论时保留空态占位', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: [] });
    expect(html).toContain('等待直播开始');
    // 空态占位在 body 中，而非由脚本渲染
    expect(html).toContain('<div class="lc-empty">等待直播开始…</div>');
  });

  it('注入脚本中的初始评论转义 </script>，避免破坏 HTML', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: ['<script>alert(1)</script>'] });
    // 应被转义为 \u003c，而不是以字面量 </script> 形式出现在脚本里
    expect(html).toContain('\\u003c/script>');
    expect(html).not.toContain('"</script>"');
  });

  it('保留 ```html 围栏，供 SillyTavern 渲染为 HTML 元素', () => {
    const html = generateLiveChatHtml({ themeId: 'terminal', initialComments: ['测试'] });
    expect(html).toMatch(/^```html/i);
    expect(html).toContain('<script type="module">');
  });
});