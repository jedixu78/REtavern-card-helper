/**
 * StageDispatchSimulator — 分阶段调度模拟器。
 *
 * 用户在 SillyTavern 里遇到「阶段不切换」时，此前工具内没有任何排查手段
 * （调度条目是 EJS if/else-if 链，只在 ST 运行时求值）。这里拖动轴值即可看到
 * 当前命中哪个阶段、每条条件是否成立、以及为什么某个阶段没轮到它。
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { simulateStageDispatch, deriveNumericAxisRange } from '../../services/staged-simulator';
import type { StagedModeCharacter } from '../../constants/defaults';
import { useTranslation } from '../../i18n/I18nContext';

interface StageDispatchSimulatorProps {
  character: StagedModeCharacter;
}

const mutedText = 'color-mix(in srgb, var(--text-color) 60%, transparent)';
const faintText = 'color-mix(in srgb, var(--text-color) 45%, transparent)';

export function StageDispatchSimulator({ character }: StageDispatchSimulatorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isNumeric = character.axisType === 'number';

  const range = useMemo(
    () => deriveNumericAxisRange(character.stages, character.numericDirection),
    [character.stages, character.numericDirection],
  );

  // 数值轴默认取范围中点；枚举轴默认取首个阶段名。
  // 这里存的是「用户是否手动调过」——阶段增删/改阈值后 range 会重算，
  // 若把轴值固化在 useState 初值里，滑杆显示值会脱离新范围并给出假的「不匹配」结论。
  const [numericOverride, setNumericOverride] = useState<number | null>(null);
  const [enumOverride, setEnumOverride] = useState<string | null>(null);

  const numericValue = numericOverride !== null && numericOverride >= range.min && numericOverride <= range.max
    ? numericOverride
    : Math.round((range.min + range.max) / 2);
  const stageNames = character.stages.map((s) => s.name);
  const enumValue = enumOverride !== null && stageNames.includes(enumOverride)
    ? enumOverride
    : (stageNames[0] ?? '');
  const setNumericValue = setNumericOverride;
  const setEnumValue = setEnumOverride;
  /** 模拟「变量未定义」——这是真实故障里最常见的一种 */
  const [simulateUndefined, setSimulateUndefined] = useState(false);

  const axisValue = simulateUndefined ? undefined : (isNumeric ? numericValue : enumValue);

  const result = useMemo(
    () => simulateStageDispatch({
      stages: character.stages,
      axisType: character.axisType,
      numericDirection: character.numericDirection,
      axisValue,
    }),
    [character.stages, character.axisType, character.numericDirection, axisValue],
  );

  if (character.stages.length === 0) return null;

  return (
    <div className="rounded border border-[color-mix(in_srgb,var(--color-border-default)_40%,transparent)] mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium"
        style={{ color: mutedText }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        🎚 {t('stagedMode.simulatorTitle')}
        {!open && (
          <span className="ml-auto" style={{ color: faintText }}>
            {t('stagedMode.simulatorCollapsedHint')}
          </span>
        )}
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-2">
          {/* 轴值控制 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono" style={{ color: faintText }}>
              {character.axisPath || t('stagedMode.simulatorNoAxis')}
            </span>
            <label className="flex items-center gap-1 text-[10px] ml-auto" style={{ color: mutedText }}>
              <input
                type="checkbox"
                checked={simulateUndefined}
                onChange={(e) => setSimulateUndefined(e.target.checked)}
              />
              {t('stagedMode.simulatorUndefined')}
            </label>
          </div>

          {!simulateUndefined && (isNumeric ? (
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={range.min}
                max={range.max}
                step={range.step}
                value={numericValue}
                onChange={(e) => setNumericValue(Number(e.target.value))}
                className="flex-1"
              />
              <input
                type="number"
                value={numericValue}
                step={range.step}
                onChange={(e) => setNumericValue(Number(e.target.value))}
                className="w-20 text-xs px-1.5 py-1 rounded border"
                style={{
                  backgroundColor: 'var(--input-bg)',
                  borderColor: 'var(--input-border)',
                  color: 'var(--text-color)',
                }}
              />
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {character.stages.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setEnumValue(s.name)}
                  className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                    enumValue === s.name ? 'border-[var(--color-primary)]' : ''
                  }`}
                  style={{
                    color: enumValue === s.name ? 'var(--color-primary)' : mutedText,
                    borderColor: enumValue === s.name ? undefined : 'color-mix(in srgb, var(--color-border-default) 40%, transparent)',
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          ))}

          {/* 判定结论 */}
          <div className="text-[11px] rounded px-2 py-1.5" style={{
            backgroundColor: result.outcome === 'matched'
              ? 'color-mix(in srgb, var(--color-status-success) 14%, transparent)'
              : 'color-mix(in srgb, var(--color-status-warning) 14%, transparent)',
            color: result.outcome === 'matched' ? 'var(--color-status-success)' : 'var(--color-status-warning)',
          }}>
            {result.outcome === 'matched' && t('stagedMode.simulatorMatched', { name: result.matchedStage?.name ?? '' })}
            {result.outcome === 'no-match' && t('stagedMode.simulatorNoMatch')}
            {result.outcome === 'undefined-axis' && t('stagedMode.simulatorUndefinedResult')}
          </div>

          {/* 逐条求值明细 */}
          <div className="space-y-0.5">
            {result.evaluations.map((ev, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: ev.winner ? 'color-mix(in srgb, var(--color-status-success) 12%, transparent)' : undefined,
                  color: ev.winner ? 'var(--color-status-success)' : ev.passed ? mutedText : faintText,
                }}
              >
                <span className="w-3 shrink-0">{ev.winner ? '▶' : ev.passed ? '·' : ''}</span>
                <span className="shrink-0">{ev.stage.name}</span>
                <span className="font-mono" style={{ color: faintText }}>{ev.condition}</span>
                {ev.parseError && (
                  <span style={{ color: 'var(--color-status-danger)' }}>⚠ {ev.parseError}</span>
                )}
                {/* 条件为真但没轮到它：else-if 链已被前面的阶段截胡 */}
                {ev.passed && !ev.winner && (
                  <span className="ml-auto" style={{ color: faintText }}>{t('stagedMode.simulatorShadowed')}</span>
                )}
              </div>
            ))}
          </div>

          <p className="text-[10px]" style={{ color: faintText }}>
            {t('stagedMode.simulatorDisclaimer')}
          </p>
        </div>
      )}
    </div>
  );
}
