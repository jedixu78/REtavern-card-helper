/**
 * WizardShell - Step indicator bar with Previous/Next navigation.
 * Wraps wizard step content and handles step transitions.
 * Mobile: scrollable step indicator, stacked navigation buttons.
 */
import { WIZARD_STEPS } from '../../constants/defaults';
import { Button } from '../shared/Button';
import { Check } from 'lucide-react';
import { useTranslation } from '../../i18n/I18nContext';
import { themeAlpha } from '../../constants/theme';

interface WizardShellProps {
  currentStep: number;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
  /** 步骤圆点点击跳转（向前跳由调用方逐步校验，向后跳直接放行）。 */
  onStepClick?: (step: number) => void;
  /** 编辑模式下每一步都显示「保存」——编辑模式没有自动保存，这是中途持久化的唯一入口。 */
  alwaysShowSave?: boolean;
  onSaveDraft?: () => void;
  onClear?: () => void;
  stepError: string | null;
  saving: boolean;
  extraActions?: React.ReactNode;
  hideBottomNav?: boolean;
  children: React.ReactNode;
}

export function WizardShell({ currentStep, onPrev, onNext, onStepClick, onSave, alwaysShowSave, onSaveDraft, onClear, stepError, saving, extraActions, hideBottomNav, children }: WizardShellProps) {
  const { t } = useTranslation();
  const isFirst = currentStep === 1;
  const isLast = currentStep === WIZARD_STEPS.length;
  const stepKeys = ['wizard.stepName','wizard.stepWorldSkeleton','wizard.stepCharacters','wizard.stepWorldBook','wizard.stepMvu','wizard.stepStagedMode','wizard.stepFirstMessage','wizard.stepLiveStreamChat','wizard.stepExport'];

  return (
    <div className="relative flex flex-col flex-1 min-h-0">
      {/* Layer 1 — Background layer (z-0): lowest layer, no interaction */}
      <div className="absolute inset-0 z-0 pointer-events-none" aria-hidden="true" />

      {/* Layer 2 — Step indicator + content layer (z-10): editable content, scrolls internally */}
      <div className="relative z-10 flex flex-col flex-1 min-h-0">
        {/* Step indicator bar */}
        <div className="mb-4 sm:mb-8 shrink-0">
          <div className="overflow-x-auto scrollbar-none -mx-3 sm:mx-0 px-3 sm:px-0 pb-2 sm:pb-0">
            <div className="flex items-center justify-between min-w-[360px] sm:min-w-0">
              {WIZARD_STEPS.map((step, i) => {
                const isCompleted = step.id < currentStep;
                const isCurrent = step.id === currentStep;

                return (
                  <div key={step.id} className="flex items-center shrink-0">
                    <div className="flex flex-col items-center">
                      <button
                        type="button"
                        onClick={onStepClick ? () => onStepClick(step.id) : undefined}
                        disabled={!onStepClick || isCurrent}
                        aria-label={t(stepKeys[step.id - 1])}
                        aria-current={isCurrent ? 'step' : undefined}
                        className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs sm:text-sm font-semibold transition-all duration-300
                          ${onStepClick && !isCurrent ? 'cursor-pointer hover:scale-110 hover:shadow-md' : ''}
                          ${isCurrent
                            ? 'bg-gradient-primary text-inverse shadow-lg shadow-primary-glow scale-110'
                            : isCompleted
                              ? 'bg-gradient-success text-inverse shadow-md'
                              : 'text-[var(--color-text-muted)]'
                          }`}
                        style={!isCurrent && !isCompleted ? { backgroundColor: 'color-mix(in srgb, var(--color-surface-elevated) 60%, transparent)' } : undefined}
                      >
                        {isCompleted ? <Check size={12} strokeWidth={3} /> : step.id}
                      </button>
                      <span
                        className={`hidden md:block mt-1 sm:mt-1.5 text-[10px] sm:text-[11px] font-medium whitespace-nowrap transition-colors duration-200 ${isCurrent ? 'text-primary-bright' : ''}`}
                        style={{ color: isCurrent ? undefined : isCompleted ? 'color-mix(in srgb, var(--color-status-success) 70%, transparent)' : 'var(--color-text-muted)' }}
                      >
                        {t(stepKeys[step.id - 1])}
                      </span>
                    </div>
                    {i < WIZARD_STEPS.length - 1 && (
                      <div
                        className="flex-1 h-[2px] mx-1.5 sm:mx-2 min-w-[12px] sm:min-w-[16px] rounded-full transition-colors duration-500"
                        style={{ backgroundColor: isCompleted ? themeAlpha('success', 50) : 'color-mix(in srgb, var(--color-border-default) 40%, transparent)' }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Step content — internal scroll area, extra bottom padding prevents content being hidden under the transparent nav */}
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1 pb-20 sm:pb-24">
          <div className="min-h-[200px] sm:min-h-[280px]">
            {children}
          </div>

          {/* Error display */}
          {stepError && (
            <div
              className="mt-3 rounded-lg px-4 py-2.5 text-sm animate-scale-in"
              style={{ backgroundColor: themeAlpha('danger', 20), border: `1px solid ${themeAlpha('danger', 30)}`, color: 'var(--color-status-danger)' }}
            >
              {stepError}
            </div>
          )}
        </div>
      </div>

      {/* Layer 3 — Navigation bar (z-30): transparent overlay, only buttons receive pointer events */}
      {!hideBottomNav && (
        <div
          className="absolute bottom-0 left-0 right-0 z-30 pointer-events-none"
          aria-label={t('wizard.navigation')}
        >
          {/* 移动端：单行，按钮均匀分布，窄屏自动换行 */}
          <div className="sm:hidden flex items-center justify-between flex-wrap gap-1.5 pt-2">
            <Button variant="ghost" size="sm" onClick={onPrev} disabled={isFirst} className="pointer-events-auto">
              &larr; {t('common.previous')}
            </Button>
            {onClear && (
              <Button variant="ghost" size="sm" onClick={onClear} disabled={saving} className="pointer-events-auto">
                {t('wizard.clearDraft')}
              </Button>
            )}
            {onSaveDraft && (
              <Button variant="secondary" size="sm" onClick={() => onSaveDraft()} disabled={saving} className="pointer-events-auto">
                {t('wizard.saveDraft')}
              </Button>
            )}
            {extraActions && <span className="pointer-events-auto inline-flex">{extraActions}</span>}
            {alwaysShowSave && !isLast && (
              <Button variant="secondary" size="sm" onClick={onSave} disabled={saving} className="pointer-events-auto">
                {saving ? t('common.saving') : t('wizard.saveCard')}
              </Button>
            )}
            {isLast ? (
              <Button size="sm" onClick={onSave} disabled={saving} className="pointer-events-auto">
                {saving ? t('common.saving') : t('wizard.saveCard')}
              </Button>
            ) : (
              <Button size="sm" onClick={onNext} className="pointer-events-auto">
                {t('common.next')} &rarr;
              </Button>
            )}
          </div>

          {/* 桌面端：单行。上一步在左，次要操作 + 下一步在右，统一尺寸 */}
          <div className="hidden sm:flex items-center justify-between gap-3 pt-4">
            <Button variant="ghost" onClick={onPrev} disabled={isFirst} className="pointer-events-auto">
              &larr; {t('common.previous')}
            </Button>
            <div className="flex items-center gap-3">
              {onClear && (
                <Button variant="ghost" onClick={onClear} disabled={saving} className="pointer-events-auto">
                  {t('wizard.clearDraft')}
                </Button>
              )}
              {onSaveDraft && (
                <Button variant="secondary" onClick={() => onSaveDraft()} disabled={saving} className="pointer-events-auto">
                  {t('wizard.saveDraft')}
                </Button>
              )}
              {extraActions && <span className="pointer-events-auto inline-flex">{extraActions}</span>}
              {alwaysShowSave && !isLast && (
                <Button variant="secondary" onClick={onSave} disabled={saving} className="pointer-events-auto">
                  {saving ? t('common.saving') : t('wizard.saveCard')}
                </Button>
              )}
              {isLast ? (
                <Button onClick={onSave} disabled={saving} className="pointer-events-auto">
                  {saving ? t('common.saving') : t('wizard.saveCard')}
                </Button>
              ) : (
                <Button onClick={onNext} className="pointer-events-auto">
                  {t('common.next')} &rarr;
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {hideBottomNav && (
        <div
          className="absolute bottom-0 left-0 right-0 z-30 pointer-events-none"
          aria-label={t('wizard.navigation')}
        >
          <div className="flex justify-start pt-3 sm:pt-4">
            <Button variant="ghost" onClick={onPrev} disabled={isFirst} className="pointer-events-auto">
              &larr; {t('common.previous')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
