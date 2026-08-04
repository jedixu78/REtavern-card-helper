/**
 * StatusBarConfigPanel — MVU 状态栏共享配置面板
 *
 * 新手模式与专家模式复用同一套状态栏配置/预览 UI：
 *   - 模板选择（关闭 / 内置模板）
 *   - 主题、标题、头像/动画/图标、透明度
 *   - 实时预览（正常 / 应用切换 / 通知接收 / 设置变更）
 */
import { useCallback, useMemo, useState } from 'react';
import { Button } from '../shared/Button';
import { Modal } from '../shared/Modal';
import { TextInput } from '../shared/TextInput';
import type { MvuConfig, StatusBarOptions } from '../../constants/defaults';
import {
  STATUS_BAR_TEMPLATES,
  STATUS_BAR_THEMES,
  generateStatusBarHtml,
} from '../../services/status-bar-templates';

interface StatusBarConfigPanelProps {
  mvu: MvuConfig;
  onChange: (mvu: MvuConfig) => void;
}

const cardCls = 'rounded-xl border border-[color-mix(in_srgb,var(--color-border-default)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-surface-raised)_40%,transparent)] p-3';
const inputCls = 'w-full rounded-lg border border-[var(--input-border)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-sm text-[var(--text-color)] focus:border-[var(--color-border-focus)] focus:outline-none';

export function StatusBarConfigPanel({ mvu, onChange }: StatusBarConfigPanelProps) {
  const [showStatusBarPreview, setShowStatusBarPreview] = useState(false);
  const [previewState, setPreviewState] = useState<'normal' | 'app' | 'notice' | 'settings'>('normal');

  const updateStatusBar = useCallback((patch: Partial<StatusBarOptions> & { style?: string }) => {
    const style = patch.style ?? mvu.statusBarStyle ?? 'none';
    const options = { ...(mvu.statusBarOptions ?? {}), ...patch };
    delete (options as Partial<StatusBarOptions> & { style?: string }).style;
    const html = style !== 'none' && style !== 'ai-custom'
      ? generateStatusBarHtml(style, mvu.schemaSections, options)
      : style === 'none' ? '' : mvu.statusBarHtml;
    onChange({ ...mvu, statusBarStyle: style, statusBarOptions: options, statusBarHtml: html });
  }, [mvu, onChange]);

  const previewValues = useMemo(() => {
    const values: Record<string, unknown> = {};
    mvu.schemaSections.flatMap((s) => s.variables).forEach((v, index) => {
      let value = v.initialValue;
      if (previewState === 'app' && v.range) value = v.range.min + (v.range.max - v.range.min) * (index % 2 === 0 ? 0.72 : 0.38);
      if (previewState === 'settings' && v.zodType === 'z.boolean()') value = true;
      if (previewState === 'settings' && v.zodType.startsWith('z.enum(') && v.enumValues?.length) value = v.enumValues[v.enumValues.length - 1];
      values[`stat_data.${v.path}`] = value;
    });
    return values;
  }, [mvu.schemaSections, previewState]);

  const previewSrcDoc = useMemo(() => {
    const style = mvu.statusBarStyle ?? 'none';
    if (style === 'none') return '';
    if (style === 'ai-custom') return (mvu.statusBarHtml ?? '').replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
    const notice = previewState === 'notice' ? '新通知' : previewState === 'app' ? '应用切换' : previewState === 'settings' ? '设置已更新' : '';
    return generateStatusBarHtml(style, mvu.schemaSections, { ...(mvu.statusBarOptions ?? {}), previewValues, previewNotice: notice })
      .replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
  }, [mvu.statusBarStyle, mvu.statusBarHtml, mvu.statusBarOptions, mvu.schemaSections, previewState, previewValues]);

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <h4 className="text-xs font-bold text-[var(--text-color)]">实时状态栏</h4>
          <p className="text-[10px] text-[var(--color-text-muted)]">直接使用当前 MVU 变量生成状态栏，并支持实时预览。</p>
        </div>
        {previewSrcDoc && <Button variant="secondary" size="sm" onClick={() => setShowStatusBarPreview(true)}>打开预览</Button>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <button type="button" onClick={() => updateStatusBar({ style: 'none' })} className={`rounded-lg border p-2 text-xs ${(!mvu.statusBarStyle || mvu.statusBarStyle === 'none') ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_20%,transparent)]' : 'border-[var(--color-border-default)]'}`}>关闭状态栏</button>
        {STATUS_BAR_TEMPLATES.map((template) => (
          <button key={template.id} type="button" title={template.description} onClick={() => updateStatusBar({ style: template.id, themeId: mvu.statusBarOptions?.themeId ?? template.defaultTheme })} className={`rounded-lg border p-2 text-xs ${mvu.statusBarStyle === template.id ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_20%,transparent)]' : 'border-[var(--color-border-default)]'}`}>
            {template.icon} {template.name}
          </button>
        ))}
      </div>
      {mvu.statusBarStyle && mvu.statusBarStyle !== 'none' && mvu.statusBarStyle !== 'ai-custom' && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {STATUS_BAR_THEMES.map((theme) => (
              <button key={theme.id} type="button" title={theme.description} onClick={() => updateStatusBar({ themeId: theme.id })} className={`rounded-md border px-2 py-1 text-[11px] ${mvu.statusBarOptions?.themeId === theme.id ? 'border-[var(--color-primary)] text-[var(--text-color)]' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]'}`}>
                {theme.icon} {theme.name}
              </button>
            ))}
          </div>
          <TextInput value={mvu.statusBarOptions?.title ?? ''} onChange={(e) => updateStatusBar({ title: e.target.value })} placeholder="状态栏标题（可选）" className={inputCls} />
          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-secondary)]">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={mvu.statusBarOptions?.showAvatar ?? true} onChange={(e) => updateStatusBar({ showAvatar: e.target.checked })} />头像</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={mvu.statusBarOptions?.animated ?? true} onChange={(e) => updateStatusBar({ animated: e.target.checked })} />动画</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={mvu.statusBarOptions?.showIcons ?? true} onChange={(e) => updateStatusBar({ showIcons: e.target.checked })} />图标</label>
            <label className="flex items-center gap-1.5">透明度<input type="range" min="0.7" max="1" step="0.05" value={mvu.statusBarOptions?.opacity ?? 1} onChange={(e) => updateStatusBar({ opacity: Number(e.target.value) })} /></label>
          </div>
        </div>
      )}

      <Modal isOpen={showStatusBarPreview} onClose={() => setShowStatusBarPreview(false)} title="状态栏实时预览" maxWidth="max-w-3xl">
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-secondary)]">预览与 MVU 变量步骤的状态栏配置实时同步，可切换不同状态查看视觉表现。</p>
          <div className="flex flex-wrap gap-2">
            {([
              ['normal', '正常状态'],
              ['app', '应用切换'],
              ['notice', '通知接收'],
              ['settings', '设置变更'],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setPreviewState(id)} className={`rounded-md border px-3 py-1.5 text-xs ${previewState === id ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_25%,transparent)] text-[var(--text-color)]' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="rounded-xl border border-[var(--color-border-default)] bg-[#151515] p-3 overflow-auto min-h-[300px]">
            {previewSrcDoc ? (
              <iframe title="MVU 状态栏实时预览" srcDoc={previewSrcDoc} style={{ width: '100%', minHeight: '330px', border: 'none', background: 'transparent' }} sandbox="allow-scripts" />
            ) : (
              <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">请先选择一个状态栏模板。</p>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
