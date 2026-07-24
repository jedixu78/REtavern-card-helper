/**
 * StepLiveStreamChat — 直播间评论面板（步骤8，可选）
 *
 * 独立于 MVU 系统，纯正则驱动：
 *   - 用户配置主题/标题/初始评论等选项
 *   - 通过 generateLiveChatHtml() 生成完整 HTML 文档
 *   - 导出时 card-exporter 将占位符 <LiveStreamChatImpl/> 追加到 first_mes，
 *     并通过 regex_scripts 替换为面板 HTML（markdownOnly）、从 AI prompt 移除（promptOnly）
 *
 * 面板运行时自包含：内置初始评论立即渲染，无需 MVU；
 * 若 MVU 运行时可用则订阅 VARIABLE_UPDATE_ENDED 事件实现动态更新。
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import { Button } from '../shared/Button';
import { TextInput } from '../shared/TextInput';
import { TextArea } from '../shared/TextArea';
import { generateLiveChatHtml } from '../../services/live-chat-templates';
import { STATUS_BAR_THEMES } from '../../services/status-bar-templates';
import type { LiveStreamChatConfig } from '../../constants/defaults';

interface StepLiveStreamChatProps {
  config: LiveStreamChatConfig;
  onChange: (config: LiveStreamChatConfig) => void;
}

const inputCls = 'w-full rounded-lg border border-[var(--input-border)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-sm text-[var(--text-color)] focus:border-[var(--color-border-focus)] focus:outline-none';
const labelCls = 'text-xs font-medium text-[var(--color-text-secondary)] mb-1 block';
const cardCls = 'rounded-xl border border-[color-mix(in_srgb,var(--color-border-default)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-surface-raised)_40%,transparent)] p-3';

const DEFAULT_COMMENTS = ['开播了开播了！', '前排吃瓜', '这次什么剧本？', '蹲一个', '主播冲鸭'];

export function StepLiveStreamChat({ config, onChange }: StepLiveStreamChatProps) {
  const [previewKey, setPreviewKey] = useState(0);
  const [localPreviewHtml, setLocalPreviewHtml] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enabled = config.enabled;
  const themeId = config.themeId || 'terminal';
  const title = config.title || '直播间';
  const maxVisible = config.maxVisible ?? 10;
  const initialComments = config.initialComments ?? [];

  // 根据 options 生成 HTML，并写回 config.html
  const regenerateHtml = (opts: Partial<LiveStreamChatConfig>) => {
    const merged: LiveStreamChatConfig = { ...config, ...opts };
    const html = generateLiveChatHtml({
      themeId: merged.themeId || 'terminal',
      title: merged.title || '直播间',
      maxVisible: merged.maxVisible ?? 10,
      initialComments: (merged.initialComments ?? []).filter((s) => s.trim()),
    });
    onChange({ ...merged, html });
    setPreviewKey((k) => k + 1);
  };

  // 首次启用时若 html 为空，自动生成
  useEffect(() => {
    if (enabled && !config.html.trim()) {
      regenerateHtml({});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // 防抖预览刷新：从当前配置值实时生成预览 HTML（不写回 draft，避免每次按键触发自动保存）
  const schedulePreviewRefresh = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const html = generateLiveChatHtml({
        themeId: config.themeId || 'terminal',
        title: config.title || '直播间',
        maxVisible: config.maxVisible ?? 10,
        initialComments: (config.initialComments ?? []).filter((s) => s.trim()),
      });
      setLocalPreviewHtml(html);
      setPreviewKey((k) => k + 1);
    }, 400);
  };
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  // 当 config.html 变化时（blur/regenerateHtml 触发），同步本地预览
  useEffect(() => {
    if (config.html.trim()) {
      setLocalPreviewHtml(config.html);
      setPreviewKey((k) => k + 1);
    }
  }, [config.html]);

  const toggleEnabled = () => {
    if (!enabled) {
      // 启用时自动生成 HTML
      const html = config.html.trim() || generateLiveChatHtml({
        themeId, title, maxVisible,
        initialComments: initialComments.filter((s) => s.trim()),
      });
      onChange({ ...config, enabled: true, html });
    } else {
      onChange({ ...config, enabled: false });
    }
  };

  const commentsText = useMemo(() => initialComments.join('\n'), [initialComments]);

  // 预览用的 HTML 文档（优先使用本地实时预览 HTML，回退到 config.html）
  const previewSrcDoc = useMemo(() => {
    const html = localPreviewHtml || config.html;
    if (!html.trim()) return '';
    return html.replace(/^```html\n/, '').replace(/\n```$/, '');
  }, [localPreviewHtml, config.html, previewKey]);

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="mobile-stack-header flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-[var(--text-color)]">📺 直播间评论面板</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            可选的直播弹幕面板，纯正则驱动，不依赖 MVU 系统。开播时立即渲染内置初始评论，若 MVU 可用则自动订阅动态更新。
          </p>
        </div>
        <Button variant={enabled ? 'secondary' : 'ghost'} size="sm" onClick={toggleEnabled}>
          {enabled ? '✓ 已启用' : '启用面板'}
        </Button>
      </div>

      {!enabled && (
        <div className={`${cardCls} text-center py-8`}>
          <p className="text-sm text-[var(--color-text-muted)]">
            面板未启用。点击右上「启用面板」开启直播间评论功能。
          </p>
        </div>
      )}

      {enabled && (
        <>
          {/* 配置区 */}
          <div className={cardCls}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* 主题选择 */}
              <div>
                <label className={labelCls}>主题风格</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {STATUS_BAR_THEMES.map((theme) => (
                    <button
                      key={theme.id}
                      onClick={() => regenerateHtml({ themeId: theme.id })}
                      className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs font-medium transition-all ${
                        themeId === theme.id
                          ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)] text-[var(--color-primary)]'
                          : 'border-[var(--color-border-default)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                      }`}
                    >
                      <span className="text-base">{theme.icon}</span>
                      <span className="truncate">{theme.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 标题 + 最大显示 */}
              <div className="space-y-3">
                <div>
                  <label className={labelCls}>面板标题</label>
                  <TextInput
                    value={title}
                    onChange={(e) => {
                      onChange({ ...config, title: e.target.value });
                      schedulePreviewRefresh();
                    }}
                    onBlur={() => regenerateHtml({ title })}
                    className={inputCls}
                    placeholder="直播间"
                  />
                </div>
                <div>
                  <label className={labelCls}>最大显示条数（超出滚动）</label>
                  <TextInput
                    type="number"
                    value={String(maxVisible)}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(50, Number(e.target.value) || 10));
                      onChange({ ...config, maxVisible: v });
                      schedulePreviewRefresh();
                    }}
                    onBlur={() => regenerateHtml({ maxVisible })}
                    className={inputCls}
                  />
                </div>
              </div>
            </div>

            {/* 初始评论编辑 */}
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <label className={labelCls}>内置初始评论（每行一条，开播时立即渲染）</label>
                <button
                  onClick={() => regenerateHtml({ initialComments: [...DEFAULT_COMMENTS] })}
                  className="text-xs text-[var(--color-primary)] hover:underline"
                >
                  填充默认评论
                </button>
              </div>
              <TextArea
                value={commentsText}
                onChange={(e) => {
                  const lines = e.target.value.split('\n');
                  onChange({ ...config, initialComments: lines });
                  schedulePreviewRefresh();
                }}
                onBlur={() => regenerateHtml({ initialComments: initialComments })}
                rows={5}
                className={inputCls}
                placeholder="开播了开播了！&#10;前排吃瓜&#10;这次什么剧本？"
              />
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                当前 {initialComments.filter((s) => s.trim()).length} 条评论。留空则使用默认 5 条。
              </p>
            </div>

            {/* 重新生成按钮 */}
            <div className="mt-3 flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => regenerateHtml({})}>
                🔄 重新生成 HTML
              </Button>
            </div>
          </div>

          {/* 实时预览 */}
          <div className={cardCls}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-[var(--text-color)]">实时预览</h3>
              <span className="text-xs text-[var(--color-text-muted)]">主题：{STATUS_BAR_THEMES.find((t) => t.id === themeId)?.name ?? themeId}</span>
            </div>
            {previewSrcDoc ? (
              <iframe
                key={previewKey}
                srcDoc={previewSrcDoc}
                title="直播面板预览"
                className="w-full rounded-lg border border-[var(--color-border-default)] bg-[var(--color-surface)]"
                style={{ height: '380px', minHeight: '380px' }}
                sandbox="allow-scripts"
              />
            ) : (
              <div className="text-center py-8 text-sm text-[var(--color-text-muted)]">
                点击「重新生成 HTML」生成预览
              </div>
            )}
          </div>

          {/* 说明 */}
          <div className={`${cardCls} text-xs text-[var(--color-text-secondary)] space-y-1`}>
            <p className="font-semibold text-[var(--color-text)]">工作原理</p>
            <p>• 导出时自动在开场白末尾追加占位符 <code className="px-1 rounded bg-[var(--color-surface-raised)]">&lt;LiveStreamChatImpl/&gt;</code></p>
            <p>• 通过正则脚本将占位符替换为面板 HTML（仅界面显示，AI 不可见）</p>
            <p>• 面板内置 JS 自包含运行，无需 MVU 即可展示初始弹幕</p>
            <p>• 若卡片同时启用了 MVU，面板会自动订阅变量更新事件，读取 <code className="px-1 rounded bg-[var(--color-surface-raised)]">stat_data.直播间.评论</code> 实现动态刷新</p>
          </div>
        </>
      )}
    </div>
  );
}
