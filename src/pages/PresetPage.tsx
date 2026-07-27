/**
 * PresetPage - Standalone preset management page.
 * Import and manage SillyTavern prompt presets for AI generation guidance.
 */
import { useState, useRef, useCallback } from 'react';
import { Button } from '../components/shared/Button';
import {
  importPresetFile,
  loadSavedPreset,
  clearSavedPreset,
  togglePresetPrompt,
  resetToBuiltInPreset,
  selectBuiltinPreset,
  getSelectedBuiltinKey,
  isPrefillEnabled,
  setPrefillEnabled,
  BUILTIN_PRESET_KEYS,
  type LoadedPreset,
} from '../services/preset-service';
import { cleanAllApologies, type CleanupResult } from '../services/apology-cleanup';
import { useToast } from '../components/shared/Toast';
import { useTranslation } from '../i18n/I18nContext';
import { themeAlpha } from '../constants/theme';

const textPrimaryStyle = { color: 'var(--text-color)' };
const textSecondaryStyle = { color: 'var(--color-text-secondary)' };
const textMutedStyle = { color: 'var(--color-text-muted)' };
const borderColor = 'var(--color-border-default)';
const cardBgSemiTransparent = (alpha: number) =>
  `rgba(var(--card-bg-r), var(--card-bg-g), var(--card-bg-b), ${alpha})`;
const inputStyle = {
  backgroundColor: 'var(--input-bg)',
  borderColor: 'var(--input-border)',
  color: 'var(--text-color)',
};

export function PresetPage() {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<LoadedPreset | null>(() => loadSavedPreset());
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [prefillEnabled, setPrefillEnabledState] = useState<boolean>(() => isPrefillEnabled());
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { addToast } = useToast();

  const handleImport = useCallback(async () => {
    fileRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      const loaded = await importPresetFile(file);
      setPreset(loaded);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('preset.importError'));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [t]);

  const handleClear = useCallback(() => {
    clearSavedPreset();
    setPreset(null);
  }, []);

  const handleResetBuiltIn = useCallback(() => {
    const loaded = resetToBuiltInPreset();
    setPreset(loaded);
  }, []);

  const handleSelectBuiltin = useCallback((key: string) => {
    const loaded = selectBuiltinPreset(key);
    if (loaded) setPreset(loaded);
  }, []);

  const handleTogglePrefill = useCallback(() => {
    const next = !prefillEnabled;
    setPrefillEnabled(next);
    setPrefillEnabledState(next);
  }, [prefillEnabled]);

  const handleToggle = useCallback((index: number) => {
    const updated = togglePresetPrompt(index);
    setPreset(updated);
  }, []);

  const handleCleanApologies = useCallback(async () => {
    setCleaning(true);
    setCleanupResult(null);
    try {
      const result = await cleanAllApologies();
      setCleanupResult(result);
      if (result.fieldsCleaned > 0) {
        addToast('success', `已清理 ${result.cardsCleaned} 张卡片 + ${result.draftsCleaned} 个草稿中的 ${result.fieldsCleaned} 处道歉残留`);
      } else {
        addToast('info', `扫描完成：${result.cardsScanned} 张卡片 + ${result.draftsScanned} 个草稿，未发现道歉残留`);
      }
    } catch (err) {
      addToast('error', '清理失败：' + (err instanceof Error ? err.message : '未知错误'));
    } finally {
      setCleaning(false);
    }
  }, [addToast]);

  const currentBuiltinKey = preset?.isBuiltIn ? (preset.builtinKey ?? getSelectedBuiltinKey()) : null;

  const enabledCount = preset?.prompts.filter(p => p.enabled).length ?? 0;

  const typeLabel = (type: string) => {
    switch (type) {
      case 'example': return <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: themeAlpha('success', 30), color: 'var(--color-status-success)' }}>{t('preset.typeExample')}</span>;
      case 'jailbreak': return <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: themeAlpha('warning', 30), color: 'var(--color-status-warning)' }}>{t('preset.typeJailbreak')}</span>;
      default: return <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--color-surface-raised)', ...textMutedStyle }}>{t('preset.typeSystem')}</span>;
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 animate-fade-in">
      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Header */}
      <div className="mb-6 animate-slide-up">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-primary-tint-light animate-pulse-slow">
            <span className="text-xl">📋</span>
          </div>
          <h1 className="text-2xl font-bold" style={textPrimaryStyle}>{t('preset.title')}</h1>
        </div>
        <p className="text-sm ml-11" style={textMutedStyle}>
          {t('preset.subtitle')}
        </p>
      </div>

      {/* Action Bar */}
      <div className="flex flex-wrap items-center gap-3 mb-4 animate-slide-up animation-delay-100">
        <Button
          variant="primary"
          onClick={handleImport}
          disabled={importing}
          className="flex items-center gap-2 group"
        >
          <span className="text-lg transition-transform group-hover:rotate-12">📂</span>
          {importing ? t('preset.importing') : preset ? t('preset.importNew') : t('preset.importFile')}
        </Button>
        {preset ? (
          <Button 
            variant="danger" 
            onClick={handleClear}
            className="group hover:scale-105 transition-transform"
          >
            <span className="mr-1 group-hover:animate-bounce">✕</span>
            {t('preset.clearPreset')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={handleResetBuiltIn}
            className="group hover:scale-105 transition-transform"
          >
            <span className="mr-1">✨</span>
            恢复内置预设
          </Button>
        )}
        {preset && (
          <>
            <span className="text-sm animate-badge-pop" style={textMutedStyle}>
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary-tint text-primary-bright">
                <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: 'var(--color-status-success)' }}></span>
                {t('preset.enabledCount', { enabled: String(enabledCount), total: String(preset.prompts.length) })}
              </span>
            </span>
            {preset.isBuiltIn && (
              <span className="text-sm animate-badge-pop" style={{ color: 'var(--color-status-success)' }}>
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full" style={{ backgroundColor: themeAlpha('success', 50), color: 'var(--color-status-success)' }}>
                  ⭐ {preset.fileName}
                </span>
              </span>
            )}
          </>
        )}
      </div>

      {/* Built-in preset selector */}
      <div className="mb-4 p-4 rounded-lg animate-slide-up animation-delay-100" style={{ background: `linear-gradient(135deg, ${cardBgSemiTransparent(0.5)} 0%, ${cardBgSemiTransparent(0.45)} 100%)`, border: `1px solid ${borderColor}` }}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">⚡</span>
          <h3 className="text-sm font-medium" style={textPrimaryStyle}>模型专用破限预设</h3>
        </div>
        <p className="text-xs mb-3" style={textMutedStyle}>
          根据所使用的 AI 模型选择对应预设，可显著降低拒绝率与道德化倾向。选择后立即生效，覆盖当前预设。
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {BUILTIN_PRESET_KEYS.map(({ key, label, description }) => {
            const isActive = currentBuiltinKey === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleSelectBuiltin(key)}
                title={description}
                className={`text-left p-3 rounded-lg border transition-all duration-300 hover:scale-[1.02] ${
                  isActive ? 'border-primary shadow-lg shadow-primary-glow' : ''
                }`}
                style={{
                  backgroundColor: isActive
                    ? 'rgba(var(--primary-r), var(--primary-g), var(--primary-b), 0.15)'
                    : cardBgSemiTransparent(0.3),
                  borderColor: isActive ? 'var(--color-primary)' : borderColor,
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium" style={isActive ? { color: 'var(--color-primary)' } : textPrimaryStyle}>
                    {label}
                  </span>
                  {isActive && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ backgroundColor: 'var(--color-primary)', color: 'white' }}>
                      ✓
                    </span>
                  )}
                </div>
                <p className="text-xs line-clamp-2" style={textMutedStyle}>
                  {description}
                </p>
              </button>
            );
          })}
        </div>

        {/* Prefill toggle */}
        <div className="mt-3 p-3 rounded-lg flex items-start gap-3" style={{ backgroundColor: cardBgSemiTransparent(0.3), border: `1px solid ${borderColor}` }}>
          <label className="relative cursor-pointer flex-shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={prefillEnabled}
              onChange={handleTogglePrefill}
              className="sr-only"
            />
            <div className={`w-5 h-5 rounded border-2 transition-all duration-300 flex items-center justify-center ${
              prefillEnabled
                ? 'bg-primary border-primary-tint shadow-lg shadow-primary-glow'
                : ''
            }`} style={prefillEnabled ? {} : inputStyle}>
              {prefillEnabled && (
                <svg className="w-3 h-3" style={textPrimaryStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </div>
          </label>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium" style={textPrimaryStyle}>🔐 Assistant 预填充（破限承诺）</span>
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: prefillEnabled ? themeAlpha('success', 30) : 'var(--color-surface-raised)', color: prefillEnabled ? 'var(--color-status-success)' : 'var(--color-text-muted)' }}>
                {prefillEnabled ? '已开启' : '已关闭'}
              </span>
            </div>
            <p className="text-xs leading-relaxed" style={textMutedStyle}>
              开启后，Claude/Gemini/GLM 专用预设会在用户消息后插入一条 assistant "承诺"消息，让模型先答应破限规则再生成，显著降低拒绝率。
              <strong style={{ color: 'var(--color-status-warning)' }}>兼容性说明：</strong>
              Claude 原生 / Gemini / GLM / 大多数 OpenAI 兼容中转（one-api、new-api 等）<strong>支持</strong>；
              OpenAI 官方原生接口<strong>不支持</strong>真正的预填充续写（会把预填充当上下文），建议用「通用破限」预设或关闭本开关。
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              💡 若生成结果出现重复预填充文本、答非所问、或报错，请关闭本开关验证。
            </p>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg animate-shake" style={{ backgroundColor: themeAlpha('danger', 20), border: `1px solid ${themeAlpha('danger', 35)}` }}>
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--color-status-danger)' }}>⚠️</span>
            <p className="text-sm" style={{ color: 'var(--color-status-danger)' }}>{error}</p>
          </div>
        </div>
      )}

      {/* 道歉残留清理工具 */}
      <div className="mb-4 p-4 rounded-lg border backdrop-blur-sm animate-fade-in-up" style={{ borderColor: borderColor, backgroundColor: cardBgSemiTransparent(0.2) }}>
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg" style={{ backgroundColor: themeAlpha('warning', 20) }}>
            <span className="text-lg">🧹</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold mb-1" style={textPrimaryStyle}>清理已有卡片的道歉残留</h3>
            <p className="text-xs mb-3" style={textMutedStyle}>
              之前用道歉的 AI 生成的卡片可能残留"抱歉，我无法..."开头的道歉段落。
              点击下方按钮批量扫描所有卡片和草稿，自动剥离道歉内容。
            </p>
            <Button
              variant="secondary"
              onClick={handleCleanApologies}
              disabled={cleaning}
              className="group hover:scale-105 transition-transform"
            >
              <span className={`mr-1 ${cleaning ? 'animate-spin' : 'group-hover:animate-bounce'}`}>{cleaning ? '⏳' : '🧹'}</span>
              {cleaning ? '正在扫描...' : '开始扫描清理'}
            </Button>

            {/* 清理结果 */}
            {cleanupResult && (
              <div className="mt-3 p-3 rounded-lg text-xs animate-fade-in-up" style={{ backgroundColor: cardBgSemiTransparent(0.4) }}>
                {cleanupResult.fieldsCleaned > 0 ? (
                  <>
                    <p className="font-medium mb-2" style={{ color: 'var(--color-status-success)' }}>
                      ✅ 已清理 {cleanupResult.cardsCleaned}/{cleanupResult.cardsScanned} 张卡片 + {cleanupResult.draftsCleaned}/{cleanupResult.draftsScanned} 个草稿，共 {cleanupResult.fieldsCleaned} 处道歉残留
                    </p>
                    <div className="space-y-1 max-h-40 overflow-y-auto" style={textMutedStyle}>
                      {cleanupResult.details.slice(0, 20).map((d, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span style={{ color: 'var(--color-status-warning)' }}>•</span>
                          <span className="truncate">{d.card}</span>
                          <span>→</span>
                          <span className="truncate flex-1">{d.field}</span>
                          <span className="shrink-0" style={{ color: 'var(--color-status-warning)' }}>-{d.strippedChars}字</span>
                        </div>
                      ))}
                      {cleanupResult.details.length > 20 && (
                        <p className="text-center" style={textMutedStyle}>...还有 {cleanupResult.details.length - 20} 处</p>
                      )}
                    </div>
                  </>
                ) : (
                  <p style={{ color: 'var(--color-status-info)' }}>
                    ℹ️ 扫描了 {cleanupResult.cardsScanned} 张卡片 + {cleanupResult.draftsScanned} 个草稿，未发现道歉残留。
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Empty state */}
      {!preset && !error && (
        <div className="p-8 rounded-xl border border-dashed text-center animate-fade-in-up" style={{ borderColor: borderColor, backgroundColor: cardBgSemiTransparent(0.2) }}>
          <div className="relative inline-block mb-4">
            <div className="text-6xl animate-float">📋</div>
            <div className="absolute -top-2 -right-2 text-2xl animate-bounce">✨</div>
          </div>
          <h3 className="text-lg font-semibold mb-2" style={textPrimaryStyle}>{t('preset.emptyTitle')}</h3>
          <p className="text-sm max-w-md mx-auto" style={textMutedStyle}>
            {t('preset.emptyDescription')}
          </p>
          <div className="mt-6 p-4 rounded-lg text-left text-xs max-w-md mx-auto animate-slide-up animation-delay-200" style={{ backgroundColor: cardBgSemiTransparent(0.5) }}>
            <p className="font-medium mb-2" style={textMutedStyle}>{t('preset.supportedFormats')}</p>
            <ul className="list-disc list-inside space-y-1">
              <li className="transition-colors cursor-default text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">{t('preset.formatSillyTavern')}</li>
              <li className="transition-colors cursor-default text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">{t('preset.formatSystemPrompt')}</li>
              <li className="transition-colors cursor-default text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">{t('preset.formatPromptsArray')}</li>
            </ul>
          </div>
        </div>
      )}

      {/* Preset info + rule list */}
      {preset && (
        <div className="space-y-4 animate-fade-in-up">
          {/* Preset info */}
          <div className="p-4 rounded-lg backdrop-blur-sm" style={{ background: `linear-gradient(135deg, ${cardBgSemiTransparent(0.5)} 0%, ${cardBgSemiTransparent(0.45)} 100%)`, border: `1px solid ${borderColor}` }}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary-tint-light flex items-center justify-center">
                  <span className="text-sm">📁</span>
                </div>
                <h3 className="font-semibold" style={textPrimaryStyle}>{preset.fileName}</h3>
              </div>
              <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: cardBgSemiTransparent(0.5), ...textSecondaryStyle }}>
                {t('preset.totalRules', { count: String(preset.prompts.length) })}
              </span>
            </div>
            {preset.description && (
              <p className="text-sm ml-10" style={textMutedStyle}>{preset.description}</p>
            )}
          </div>

          {/* Rule list */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2" style={textSecondaryStyle}>
              <span className="w-1 h-4 rounded-full bg-primary"></span>
              {t('preset.rulesTitle')}
            </h4>
            <div className="rounded-lg overflow-hidden backdrop-blur-sm" style={{ border: `1px solid ${borderColor}`, backgroundColor: cardBgSemiTransparent(0.2) }}>
              {preset.prompts.map((p, i) => (
                <div
                  key={p.id}
                  className={`flex items-center gap-3 px-4 py-3
                    ${p.enabled ? '' : 'opacity-50'}
                    transition-all duration-300 animate-slide-in-left`}
                  style={{
                    animationDelay: `${i * 50}ms`,
                    borderBottom: i === (preset?.prompts.length ?? 0) - 1 ? undefined : `1px solid ${cardBgSemiTransparent(0.3)}`,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = cardBgSemiTransparent(0.2); }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  <label className="relative cursor-pointer">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={() => handleToggle(i)}
                      className="sr-only"
                    />
                    <div className={`w-5 h-5 rounded border-2 transition-all duration-300 ${
                      p.enabled
                        ? 'bg-primary border-primary-tint shadow-lg shadow-primary-glow'
                        : ''
                    }`} style={p.enabled ? {} : inputStyle}>
                      {p.enabled && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <svg className="w-3 h-3 animate-checkmark" style={textPrimaryStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      )}
                    </div>
                  </label>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium truncate transition-colors" style={p.enabled ? textPrimaryStyle : textMutedStyle}>
                        {p.name}
                      </span>
                      {typeLabel(p.type)}
                    </div>
                    <p className="text-xs line-clamp-2" style={textMutedStyle}>
                      {p.content}
                    </p>
                  </div>
                  <span className="text-xs shrink-0 transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
                    {t('preset.charCount', { count: String(p.content.length) })}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Tips */}
          <div className="p-4 rounded-lg border border-primary-tint-light backdrop-blur-sm animate-fade-in-up animation-delay-300" style={{ background: `linear-gradient(135deg, ${themeAlpha('info', 30)} 0%, ${themeAlpha('purple', 20)} 100%)` }}>
            <div className="flex items-start gap-2">
              <span className="text-lg mt-0.5">💡</span>
              <div>
                <h4 className="text-sm font-medium text-primary-bright mb-2">{t('preset.tipsTitle')}</h4>
                <ul className="text-xs space-y-1" style={textMutedStyle}>
                  <li className="flex items-start gap-2">
                    <span className="text-primary-muted">•</span>
                    <span>{t('preset.tip1')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary-muted">•</span>
                    <span>{t('preset.tip2')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary-muted">•</span>
                    <span>{t('preset.tip3')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary-muted">•</span>
                    <span>{t('preset.tip4')}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
