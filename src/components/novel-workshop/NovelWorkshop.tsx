/**
 * NovelWorkshop - Main entry component
 * Migrated from .temp_statusbar.astro
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNovelState } from './hooks/useNovelState';
import { HeaderBanner } from './panels/HeaderBanner';
import { ImportPanel } from './panels/ImportPanel';
import { ConfigPanel } from './panels/ConfigPanel';
import { PipelinePanel } from './panels/PipelinePanel';
import { ManagerPanel } from './panels/ManagerPanel';
import { NovelStatusBar } from './shared/NovelStatusBar';
import { extractNovelChunk, mergeNovelPackages, mergePackagesLocally, emptyPackage } from '../../services/novel-workshop-service';
import { saveWorkshopLorebookImport, revealFlagsToVariableBlueprints } from '../../services/novel-workshop-bridge';
import { splitTextIntoChunks, buildCallEstimate, assertWorkflowAffordable, hashString } from './utils';
import { MERGE_BATCH_SIZE } from './types';
import type { NovelPackage, Checkpoint, GeneratedEntry, VariableBlueprint, EntityIndex, NovelWorkshopState } from './types';
import { THEME_TOKENS } from '../../constants/theme';
import './novel-workshop.css';

/**
 * Conservatively sync entityIndex with generatedEntries.
 * Only updates name/category for entities whose id matches an entry's entityId.
 * Does not remove entities or rewrite summaries to avoid losing AI-generated context.
 */
function syncEntityIndex(entities: EntityIndex[], entries: GeneratedEntry[]): EntityIndex[] {
  const entityMap = new Map<string, GeneratedEntry>();
  for (const entry of entries) {
    if (!entry.entityId) continue;
    if (!['character', 'location', 'faction'].includes(entry.category)) continue;
    if (!entityMap.has(entry.entityId)) {
      entityMap.set(entry.entityId, entry);
    }
  }

  return entities.map((entity) => {
    const matched = entityMap.get(entity.id);
    if (!matched) return entity;
    return {
      ...entity,
      name: matched.name,
      category: matched.category,
    };
  });
}

function packageEntriesToGeneratedEntries(
  entries: NovelPackage['entries'],
  stageOrder: string[],
): GeneratedEntry[] {
  return (entries || []).map((e, i) => ({
    id: e.id || `entry_${i}`,
    entityId: e.entity_id || e.entityId || `entity_${i}`,
    category: (e.category || 'rule') as GeneratedEntry['category'],
    name: e.name || e.title || '未命名条目',
    aspect: e.aspect || e.slot || '',
    content: e.content || '',
    keys: e.keys || [],
    stage: e.stage || stageOrder[0] || '公开',
    requiredFlags: e.required_flags || e.requiredFlags || [],
    strategy: ((e.strategy || 'selective').toLowerCase() === 'constant' ? 'constant' : 'selective') as GeneratedEntry['strategy'],
    priority: e.priority || 700,
  }));
}

function packageVariablesToBlueprints(variables: NovelPackage['variables']): VariableBlueprint[] {
  return (variables || []).filter((v): v is VariableBlueprint => !!v && !!v.path);
}

/** 影响提取结果的运行配置指纹 —— 生成与「重试失败段」必须算出同一签名才能续接。 */
type RunConfigFields = Pick<
  NovelWorkshopState,
  'gateMode' | 'narrativeMode' | 'focus' | 'entryBudget' | 'chunkCharLimit' | 'contextText'
>;

function computeRunSignature(source: string, config: RunConfigFields): string {
  const configFingerprint = JSON.stringify({
    gateMode: config.gateMode,
    narrativeMode: config.narrativeMode,
    focus: [...config.focus].sort(),
    entryBudget: config.entryBudget,
    chunkCharLimit: config.chunkCharLimit,
    contextText: config.contextText.slice(0, 200),
  });
  return hashString(source + '|' + source.length + '|' + configFingerprint);
}

type ExtractRunConfig = {
  gateMode: NovelWorkshopState['gateMode'];
  narrativeMode: NovelWorkshopState['narrativeMode'];
  focus: NovelWorkshopState['focus'];
  stageOrder: string[];
  entryBudget: number;
  contextText: string;
};

/**
 * 单段提取 + 一次即时重试（生成主流程与「重试失败段」共用同一套重试参数）。
 * 两次都失败返回 null，由调用方记入 failedChunks。
 */
async function extractChunkWithRetry(
  chunk: string,
  index: number,
  total: number,
  config: ExtractRunConfig,
  updateStatus: (text: string, color: string) => void,
): Promise<NovelPackage | null> {
  try {
    return await extractNovelChunk(chunk, index, total, config, (piece) => {
      updateStatus(`正在提取第 ${index + 1}/${total} 段：${piece.slice(-40)}`, THEME_TOKENS.info);
    });
  } catch {
    updateStatus(`⚠️ 第 ${index + 1} 段提取失败，正在重试…`, THEME_TOKENS.warning);
    try {
      return await extractNovelChunk(chunk, index, total, config, () => {});
    } catch {
      return null;
    }
  }
}

export function NovelWorkshop() {
  const {
    state,
    importedFileMeta,
    workflowRunState,
    statusText,
    statusColor,
    updateState,
    syncInputsIntoState,
    setWorkflowRunState,
    setStatus,
    saveCheckpoint,
    loadCheckpoint,
    clearCheckpoint,
    handleFileImport,
    clearFile,
    getCombinedSourceText,
    resetWorkshop,
  } = useNovelState();

  const navigate = useNavigate();
  const [isGenerating, setIsGenerating] = useState(false);
  const [stallWarning, setStallWarning] = useState(false);
  const [stallCritical, setStallCritical] = useState(false);
  const lastStatusUpdateRef = useRef<number>(Date.now());
  const shouldAbortRef = useRef(false);

  useEffect(() => {
    if (!isGenerating) {
      setStallWarning(false);
      setStallCritical(false);
      return;
    }
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastStatusUpdateRef.current;
      if (elapsed > 120000) {
        setStallCritical(true);
      } else if (elapsed > 60000) {
        setStallWarning(true);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isGenerating]);

  const handleAbort = () => {
    shouldAbortRef.current = true;
  };

  // Memoize combined source so PipelinePanel's estimate isn't recomputed on
  // every unrelated render (e.g. status/stall updates during generation).
  const combinedSource = useMemo(() => getCombinedSourceText(), [getCombinedSourceText]);

  /** 当前原文+配置的运行签名；与持久化检查点比对，决定「重试失败段」是否可用 */
  const runSignature = useMemo(
    () =>
      combinedSource
        ? computeRunSignature(combinedSource, {
            gateMode: state.gateMode,
            narrativeMode: state.narrativeMode,
            focus: state.focus,
            entryBudget: state.entryBudget,
            chunkCharLimit: state.chunkCharLimit,
            contextText: state.contextText,
          })
        : '',
    [combinedSource, state.gateMode, state.narrativeMode, state.focus, state.entryBudget, state.chunkCharLimit, state.contextText],
  );

  /** 上次已按签名评估过的运行，避免重复 setState 抖动 */
  const restoredSignatureRef = useRef<string>('');

  // 恢复会话：按「签名」评估是否存在带失败段的 done 检查点，据此点亮/熄灭
  // 「重试失败段」按钮。必须双向——只点亮不熄灭的话，用户改了分段字数/焦点/原文
  // 之后按钮仍亮着且报着旧的失败段号，点下去只会恒定报「找不到匹配的失败段记录」。
  useEffect(() => {
    if (isGenerating) return;
    if (restoredSignatureRef.current === runSignature) return;
    restoredSignatureRef.current = runSignature;
    const cp = runSignature ? loadCheckpoint(runSignature) : null;
    if (cp?.phase === 'done' && cp.failedChunks && cp.failedChunks.length > 0) {
      const failed = cp.failedChunks;
      setWorkflowRunState(prev => ({
        ...prev,
        phase: 'done',
        extractionTotal: cp.totalChunks,
        extractionDone: cp.totalChunks - failed.length,
        failedChunks: [...failed],
      }));
    } else {
      // 只收窄到「亮着的 done」，绝不影响 extract / merge 相位
      setWorkflowRunState(prev =>
        prev.phase === 'done' && prev.failedChunks.length > 0
          ? { ...prev, phase: 'idle', failedChunks: [] }
          : prev,
      );
    }
  }, [isGenerating, runSignature, loadCheckpoint, setWorkflowRunState]);

  /**
   * 把最终包写入工坊状态与 sessionStorage 桥（生成主流程与「重试失败段」共用）。
   * 返回成功导入的条目数；是否跳转到向导由调用方决定。
   */
  const commitFinalPackage = (
    finalPackage: NovelPackage,
    warnings: string[],
    updateStatus: (text: string, color: string) => void,
    /** 调用方是否会紧接着跳转向导——决定成功文案说不说「正在跳转」 */
    willNavigate: boolean,
  ): number => {
    const stageOrderForState = finalPackage.stage_order.length ? finalPackage.stage_order : state.stageOrder;
    updateState(prev => ({
      ...prev,
      summary: finalPackage.summary,
      stageOrder: stageOrderForState,
      flags: (finalPackage.reveal_flags || []).map((f, i) => ({
        id: f.id || `flag_${i}`,
        label: f.label || f.name || `标记${i + 1}`,
        description: f.description || f.desc || '',
        value: f.default === true,
      })),
      entityIndex: (finalPackage.entity_index || []).map((e, i) => ({
        id: e.id || `entity_${i}`,
        name: e.name || '未命名实体',
        category: (e.category || 'character') as 'character' | 'location' | 'faction' | 'rule' | 'item' | 'event',
        aliases: e.aliases || [],
        summary: e.public_summary || e.summary || '',
      })),
      generatedEntries: packageEntriesToGeneratedEntries(finalPackage.entries, stageOrderForState),
      generatedVariables: packageVariablesToBlueprints(finalPackage.variables),
      generatedAt: new Date().toISOString(),
    }));

    // Convert reveal_flags into 开关.{id} MVU booleans so requiredFlags-gated
    // entries have their corresponding EJS guards resolve correctly.
    const generatedEntries = packageEntriesToGeneratedEntries(finalPackage.entries, stageOrderForState);
    const generatedVariables = packageVariablesToBlueprints(finalPackage.variables);
    const flagBlueprints = revealFlagsToVariableBlueprints(
      (finalPackage.reveal_flags || []).map((f, i) => ({
        id: f.id || `flag_${i}`,
        label: f.label || f.name || `标记${i + 1}`,
        description: f.description || f.desc || '',
        value: f.default === true,
      })),
    );
    const mergedVariableBlueprints = [...generatedVariables, ...flagBlueprints];
    const entryCount = (finalPackage.entries || []).length;

    const importedEntries = entryCount > 0
      ? saveWorkshopLorebookImport(
          state.lastFileName || '小说世界书',
          generatedEntries,
          mergedVariableBlueprints,
          finalPackage.summary || '',
          stageOrderForState,
        )
      : [];

    const warningSuffix = warnings.length ? `（注意：${warnings.join('，')}）` : '';
    if (importedEntries.length > 0) {
      const tail = willNavigate ? '正在跳转到创建向导…' : '已暂存，可先补跑失败段，或点下方按钮前往创建向导。';
      updateStatus(`已生成 ${importedEntries.length} 条世界书条目，${tail}${warningSuffix}`, THEME_TOKENS.success);
    } else if (entryCount > 0) {
      updateStatus(`生成完成但所有条目内容为空，未导入${warningSuffix}`, THEME_TOKENS.warning);
    } else {
      updateStatus(`生成完成但未产出有效条目${warningSuffix}`, THEME_TOKENS.warning);
    }
    return importedEntries.length;
  };

  const handleGenerate = async () => {
    if (isGenerating) return;

    const source = getCombinedSourceText();
    if (!source) {
      setStatus('请先导入或粘贴小说文本', THEME_TOKENS.danger);
      return;
    }

    let estimate;
    try {
      estimate = buildCallEstimate(source, state.chunkCharLimit);
      assertWorkflowAffordable(estimate);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '调用预算检查失败', THEME_TOKENS.danger);
      return;
    }

    const chunks = splitTextIntoChunks(source, state.chunkCharLimit);
    if (!chunks.length) {
      setStatus('文本分段为空，无法生成', THEME_TOKENS.danger);
      return;
    }

    const total = chunks.length;
    const signature = computeRunSignature(source, state);
    const existingCp = loadCheckpoint(signature);

    let partials: NovelPackage[] = [];
    let skipToMerge = false;
    let resumedMergeDone = 0;
    const failedChunks: number[] = [];
    let mergeFallbacks = 0;
    // done 相位（带失败段的已完成运行）不在这里续接——重新点「生成」即全量重跑，
    // 补跑失败段走 PipelinePanel 的「重试失败段」按钮。
    if (existingCp && existingCp.phase !== 'done' && Array.isArray(existingCp.partials)) {
      // 中止的运行里已跳过的失败段也要接回来，否则续跑起点会错位、完成后清单丢失
      failedChunks.push(...(existingCp.failedChunks ?? []));
      if (existingCp.phase === 'merge' && Array.isArray(existingCp.pending) && existingCp.pending.length > 0) {
        partials = [...existingCp.pending];
        skipToMerge = true;
        resumedMergeDone = existingCp.mergeDone || 0;
        setStatus(`检测到上次未完成的进度，跳过提取直接进入合并（剩余 ${partials.length} 批待合并）`, THEME_TOKENS.info);
      } else if (existingCp.partials.length > 0) {
        partials = [...existingCp.partials];
        setStatus(`检测到上次未完成的进度，从第 ${partials.length + failedChunks.length + 1} 段继续提取`, THEME_TOKENS.info);
      }
    }

    shouldAbortRef.current = false;
    lastStatusUpdateRef.current = Date.now();
    setStallWarning(false);
    setStallCritical(false);

    const updateStatus = (text: string, color: string) => {
      lastStatusUpdateRef.current = Date.now();
      setStallWarning(false);
      setStallCritical(false);
      setStatus(text, color);
    };

    setIsGenerating(true);
    setWorkflowRunState({
      phase: 'extract',
      extractionDone: partials.length + failedChunks.length,
      extractionTotal: total,
      mergeDone: 0,
      mergeTotal: 0,
      failedChunks: [...failedChunks],
      mergeFallbacks: 0,
    });

    try {
      const config = {
        gateMode: state.gateMode,
        narrativeMode: state.narrativeMode,
        focus: state.focus,
        stageOrder: state.stageOrder,
        entryBudget: state.entryBudget,
        contextText: state.contextText,
      };

      // ── Extract phase (with per-chunk fallback) ──
      let aborted = false;
      if (!skipToMerge) {
        // 续跑起点 = 已成功段数 + 已失败段数（两者都是顺序推进时被消费的下标）
        for (let i = partials.length + failedChunks.length; i < total; i++) {
          if (shouldAbortRef.current) {
            aborted = true;
            break;
          }
          updateStatus(`正在提取第 ${i + 1}/${total} 段…`, THEME_TOKENS.info);
          const pkg = await extractChunkWithRetry(chunks[i], i, total, config, updateStatus);
          if (pkg) {
            partials.push(pkg);
          } else {
            failedChunks.push(i);
            updateStatus(`⚠️ 第 ${i + 1} 段提取失败已跳过，继续处理下一段`, THEME_TOKENS.warning);
          }
          // 成功、失败都落盘：失败清单必须与 partials 同步持久化，
          // 否则「最后一段失败后中止」会让续跑起点与清单错位
          saveCheckpoint({
            signature,
            sourceHash: signature,
            chunkSize: state.chunkCharLimit,
            totalChunks: total,
            phase: 'extract',
            partials,
            failedChunks: [...failedChunks],
            updatedAt: new Date().toISOString(),
          });
          setWorkflowRunState(prev => ({
            ...prev,
            extractionDone: i + 1,
            failedChunks: [...failedChunks],
          }));
        }

        if (aborted) {
          updateStatus('⏹️ 已中止生成。已保存当前进度，下次点击生成会从断点继续。', THEME_TOKENS.warning);
          setWorkflowRunState(prev => ({ ...prev, phase: 'idle' }));
          return;
        }

        if (partials.length === 0) {
          throw new Error('所有片段提取均失败，无法继续。请检查网络连接或 API 设置后重试。');
        }
        if (failedChunks.length > 0) {
          updateStatus(`⚠️ 有 ${failedChunks.length} 段提取失败已跳过，将基于成功的 ${partials.length} 段继续合并`, THEME_TOKENS.warning);
        }
      }

      // ── Merge phase ──
      let finalPackage: NovelPackage;
      if (partials.length <= 1) {
        finalPackage = partials[0] || emptyPackage();
      } else {
        const mergeTotal = estimate.mergeCalls || (partials.length - 1);
        setWorkflowRunState({
          phase: 'merge',
          extractionDone: total,
          extractionTotal: total,
          mergeDone: resumedMergeDone,
          mergeTotal,
          failedChunks: [...failedChunks],
          mergeFallbacks,
        });

        let current = [...partials];
        let mergeDone = resumedMergeDone;

        while (current.length > 1) {
          if (shouldAbortRef.current) {
            aborted = true;
            break;
          }

          // Save the full list of packages that still need merging at the start
          // of each round. If the user aborts mid-round, the next run resumes
          // from this exact snapshot instead of a partially-processed batch,
          // which would drop the unprocessed batches.
          const cp: Checkpoint = {
            signature,
            sourceHash: signature,
            chunkSize: state.chunkCharLimit,
            totalChunks: total,
            phase: 'merge',
            partials: [],
            pending: current,
            mergeDone,
            mergeTotal,
            failedChunks: [...failedChunks],
            updatedAt: new Date().toISOString(),
          };
          saveCheckpoint(cp);

          if (current.length <= 2) {
            current = [mergePackagesLocally(current)];
            break;
          }
          const batches: NovelPackage[][] = [];
          for (let i = 0; i < current.length; i += MERGE_BATCH_SIZE) {
            batches.push(current.slice(i, i + MERGE_BATCH_SIZE));
          }
          const merged: NovelPackage[] = [];
          for (const batch of batches) {
            if (shouldAbortRef.current) {
              aborted = true;
              break;
            }
            if (batch.length <= 1) {
              merged.push(batch[0] || emptyPackage());
            } else {
              updateStatus(`正在合并 ${mergeDone + 1}/${mergeTotal}…`, THEME_TOKENS.purple);
              let result: NovelPackage;
              try {
                result = await mergeNovelPackages(batch, mergeDone, mergeTotal, () => {});
              } catch {
                mergeFallbacks++;
                updateStatus(`⚠️ 第 ${mergeDone + 1} 次合并失败，改用本地合并`, THEME_TOKENS.warning);
                result = mergePackagesLocally(batch);
              }
              merged.push(result);
              mergeDone++;
              setWorkflowRunState(prev => ({ ...prev, mergeDone, mergeFallbacks }));
            }
          }
          if (aborted) break;
          current = merged;
        }

        if (aborted) {
          updateStatus('⏹️ 已中止生成。已保存当前进度，下次点击生成会从断点继续。', THEME_TOKENS.warning);
          setWorkflowRunState(prev => ({ ...prev, phase: 'idle' }));
          return;
        }

        finalPackage = current[0] || emptyPackage();
      }

      const warnings: string[] = [];
      if (failedChunks.length > 0) {
        warnings.push(`${failedChunks.length} 段提取失败已跳过，可在「处理步骤」面板一键重试`);
      }
      if (mergeFallbacks > 0) {
        warnings.push(`${mergeFallbacks} 次合并改用了本地合并`);
      }
      const importedCount = commitFinalPackage(finalPackage, warnings, updateStatus, failedChunks.length === 0);

      if (failedChunks.length > 0) {
        // 有失败段：保留 done 相位检查点（带最终包），供「重试失败段」把补跑结果并入
        saveCheckpoint({
          signature,
          sourceHash: signature,
          chunkSize: state.chunkCharLimit,
          totalChunks: total,
          phase: 'done',
          partials: [],
          pending: [finalPackage],
          failedChunks: [...failedChunks],
          updatedAt: new Date().toISOString(),
        });
      } else {
        clearCheckpoint();
      }
      // 恢复 effect 靠签名去重，这里把它标记为「已评估」，避免刚落盘就被它重算一遍
      restoredSignatureRef.current = signature;
      setWorkflowRunState(prev => ({ ...prev, phase: 'done', failedChunks: [...failedChunks] }));

      // 有失败段时**不自动跳转**：导入文件的全文只在内存里（importedFileText 不落盘），
      // 一旦跳走工坊组件卸载，回来时原文没了 → 签名算不出来 → 「重试失败段」按钮
      // 再也不会出现，用户只能重新导入逐字节相同的文件。留在工坊由用户自己决定。
      if (importedCount > 0 && failedChunks.length === 0) {
        navigate('/wizard?fromWorkshop=1');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '生成过程出错';
      setStatus(`❌ ${msg}`, THEME_TOKENS.danger);
      setWorkflowRunState(prev => ({ ...prev, phase: 'idle' }));
    } finally {
      setIsGenerating(false);
    }
  };

  /**
   * 重试失败段：只重跑 done 检查点里记录的失败段（复用单段提取与同一套重试参数），
   * 成功的包用本地合并（first-wins，已有结果优先）并入最终包；再失败的留在清单可再点。
   */
  const handleRetryFailed = async () => {
    if (isGenerating) return;

    const source = getCombinedSourceText();
    if (!source) {
      setStatus('请先重新导入或粘贴与上次相同的原文（重试需要原始文本）', THEME_TOKENS.danger);
      return;
    }
    const signature = computeRunSignature(source, state);
    const cp = loadCheckpoint(signature);
    if (!cp || cp.phase !== 'done' || !cp.failedChunks?.length || !cp.pending?.[0]) {
      setStatus('找不到匹配的失败段记录：原文或配置可能已变更，请重新生成', THEME_TOKENS.warning);
      return;
    }
    const chunks = splitTextIntoChunks(source, state.chunkCharLimit);
    const failedList = cp.failedChunks.filter((idx) => idx >= 0 && idx < chunks.length);
    if (failedList.length === 0) {
      setStatus('失败段下标与当前分段不匹配，请重新生成', THEME_TOKENS.warning);
      clearCheckpoint();
      setWorkflowRunState(prev => ({ ...prev, failedChunks: [] }));
      return;
    }

    shouldAbortRef.current = false;
    lastStatusUpdateRef.current = Date.now();
    setStallWarning(false);
    setStallCritical(false);

    const updateStatus = (text: string, color: string) => {
      lastStatusUpdateRef.current = Date.now();
      setStallWarning(false);
      setStallCritical(false);
      setStatus(text, color);
    };

    setIsGenerating(true);
    // 进度条按「本次重试批次」计数（extractionTotal = 失败段数），状态栏文案报原始段号
    setWorkflowRunState(prev => ({
      ...prev,
      phase: 'extract',
      extractionDone: 0,
      extractionTotal: failedList.length,
      failedChunks: [],
    }));

    try {
      const config = {
        gateMode: state.gateMode,
        narrativeMode: state.narrativeMode,
        focus: state.focus,
        stageOrder: state.stageOrder,
        entryBudget: state.entryBudget,
        contextText: state.contextText,
      };

      const recovered: NovelPackage[] = [];
      const stillFailed: number[] = [];
      let aborted = false;
      let attempted = 0;
      for (let k = 0; k < failedList.length; k++) {
        if (shouldAbortRef.current) {
          // 中止：未处理的段原样留在失败清单里
          aborted = true;
          stillFailed.push(...failedList.slice(k));
          break;
        }
        attempted += 1;
        const idx = failedList[k];
        updateStatus(`正在重试第 ${idx + 1}/${cp.totalChunks} 段（${k + 1}/${failedList.length}）…`, THEME_TOKENS.info);
        const pkg = await extractChunkWithRetry(chunks[idx], idx, cp.totalChunks, config, updateStatus);
        if (pkg) {
          recovered.push(pkg);
        } else {
          stillFailed.push(idx);
          updateStatus(`⚠️ 第 ${idx + 1} 段重试仍然失败`, THEME_TOKENS.warning);
        }
        setWorkflowRunState(prev => ({ ...prev, extractionDone: k + 1 }));
      }

      // 中止后仍然并入已补跑成功的段（那些 API 调用已经花掉了），但不跳转
      const willNavigate = !aborted && recovered.length > 0 && stillFailed.length === 0;
      let importedCount = 0;
      let finalPackage = cp.pending[0];
      if (recovered.length > 0) {
        // first-wins：已有最终包在前，补跑结果并入（沿用现有本地合并语义，不重新设计）
        finalPackage = mergePackagesLocally([finalPackage, ...recovered]);
        const warnings: string[] = [];
        if (stillFailed.length > 0) {
          warnings.push(`${stillFailed.length} 段仍然失败，可再次重试`);
        }
        importedCount = commitFinalPackage(finalPackage, warnings, updateStatus, willNavigate);
      } else if (!aborted) {
        // 只报「实际尝试过」的段数——中止时没跑到的段不算失败
        updateStatus(`⚠️ ${attempted} 段重试全部失败，未产生新内容。请检查网络或 API 设置后再试。`, THEME_TOKENS.warning);
      }

      if (stillFailed.length > 0) {
        saveCheckpoint({
          signature,
          sourceHash: signature,
          chunkSize: state.chunkCharLimit,
          totalChunks: cp.totalChunks,
          phase: 'done',
          partials: [],
          pending: [finalPackage],
          failedChunks: stillFailed,
          updatedAt: new Date().toISOString(),
        });
      } else {
        clearCheckpoint();
      }
      restoredSignatureRef.current = signature;
      setWorkflowRunState(prev => ({
        ...prev,
        phase: 'done',
        extractionTotal: cp.totalChunks,
        extractionDone: cp.totalChunks - stillFailed.length,
        failedChunks: stillFailed,
      }));

      if (aborted) {
        // 与生成主流程的中止契约一致：不跳转、留在工坊、进度已落盘
        updateStatus(
          `⏹️ 已中止重试。${recovered.length > 0 ? `已并入 ${recovered.length} 段补跑结果，` : ''}剩余 ${stillFailed.length} 段仍在失败清单里，可再次点击「重试失败段」。`,
          THEME_TOKENS.warning,
        );
        return;
      }

      // 仍有失败段时不跳转：跳走会丢掉内存里的导入原文，按钮再也回不来
      if (importedCount > 0 && stillFailed.length === 0) {
        navigate('/wizard?fromWorkshop=1');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '重试过程出错';
      setStatus(`❌ ${msg}`, THEME_TOKENS.danger);
      setWorkflowRunState(prev => ({ ...prev, phase: 'done', failedChunks: [...failedList] }));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSyncVariables = () => {
    if (!state.generatedEntries.length) {
      setStatus('没有可导出的条目和变量', THEME_TOKENS.danger);
      return;
    }
    try {
      const flagBlueprints = revealFlagsToVariableBlueprints(state.flags);
      const mergedVariableBlueprints = [...state.generatedVariables, ...flagBlueprints];
      const imported = saveWorkshopLorebookImport(
        state.lastFileName || '小说世界书',
        state.generatedEntries,
        mergedVariableBlueprints,
        state.summary || '',
        state.stageOrder,
      );
      if (imported.length === 0) {
        setStatus('导出失败：所有条目内容为空', THEME_TOKENS.warning);
        return;
      }
      setStatus(`已导出 ${imported.length} 条条目，正在跳转到创建向导…`, THEME_TOKENS.success);
      navigate('/wizard?fromWorkshop=1&step=4');
    } catch (err) {
      setStatus(`导出失败：${err instanceof Error ? err.message : '未知错误'}`, THEME_TOKENS.danger);
    }
  };

  const handleDeleteGeneratedEntry = (entryId: string) => {
    updateState((prev) => {
      const nextEntries = prev.generatedEntries.filter((entry) => entry.id !== entryId);
      return { ...prev, generatedEntries: nextEntries, entityIndex: syncEntityIndex(prev.entityIndex, nextEntries) };
    });
  };

  const handleDeleteGeneratedEntries = (entryIds: string[]) => {
    const idSet = new Set(entryIds);
    updateState((prev) => {
      const nextEntries = prev.generatedEntries.filter((entry) => !idSet.has(entry.id));
      return { ...prev, generatedEntries: nextEntries, entityIndex: syncEntityIndex(prev.entityIndex, nextEntries) };
    });
  };

  const handleUpdateGeneratedEntry = (entryId: string, updates: Partial<GeneratedEntry>) => {
    updateState((prev) => {
      const nextEntries = prev.generatedEntries.map((entry) =>
        entry.id === entryId ? { ...entry, ...updates } : entry,
      );
      return { ...prev, generatedEntries: nextEntries, entityIndex: syncEntityIndex(prev.entityIndex, nextEntries) };
    });
  };

  const handleUpdateGeneratedEntries = (entryIds: string[], updates: Partial<GeneratedEntry>) => {
    const idSet = new Set(entryIds);
    updateState((prev) => {
      const nextEntries = prev.generatedEntries.map((entry) =>
        idSet.has(entry.id) ? { ...entry, ...updates } : entry,
      );
      return { ...prev, generatedEntries: nextEntries, entityIndex: syncEntityIndex(prev.entityIndex, nextEntries) };
    });
  };

  const handleAddGeneratedEntry = (entry: GeneratedEntry) => {
    updateState((prev) => {
      const nextEntries = [...prev.generatedEntries, entry];
      return { ...prev, generatedEntries: nextEntries, entityIndex: syncEntityIndex(prev.entityIndex, nextEntries) };
    });
  };

  const handleAddGeneratedEntries = (entries: GeneratedEntry[]) => {
    updateState((prev) => {
      const nextEntries = [...prev.generatedEntries, ...entries];
      return { ...prev, generatedEntries: nextEntries, entityIndex: syncEntityIndex(prev.entityIndex, nextEntries) };
    });
  };

  const handleReorderGeneratedEntries = (entryIds: string[]) => {
    updateState((prev) => {
      const idToEntry = new Map(prev.generatedEntries.map((e) => [e.id, e]));
      const nextEntries = entryIds.map((id) => idToEntry.get(id)).filter((e): e is GeneratedEntry => Boolean(e));
      // Append any entries missing from the provided order at the end to avoid data loss
      const seenIds = new Set(entryIds);
      for (const entry of prev.generatedEntries) {
        if (!seenIds.has(entry.id)) nextEntries.push(entry);
      }
      return { ...prev, generatedEntries: nextEntries };
    });
  };

  const handleImportGeneratedEntries = (entries: GeneratedEntry[]) => {
    updateState((prev) => {
      const nextEntries = [...prev.generatedEntries, ...entries];
      return { ...prev, generatedEntries: nextEntries, entityIndex: syncEntityIndex(prev.entityIndex, nextEntries) };
    });
  };

  return (
    <div className="novel-workshop-panel">
      <HeaderBanner
        summary={state.summary}
        generatedEntries={state.generatedEntries}
        entityIndex={state.entityIndex}
        flags={state.flags}
        generatedVariables={state.generatedVariables}
      />

      <ImportPanel
        sourceText={state.sourceText}
        contextText={state.contextText}
        importedFileMeta={importedFileMeta}
        onSourceTextChange={(text) => syncInputsIntoState({ sourceText: text })}
        onContextTextChange={(text) => syncInputsIntoState({ contextText: text })}
        onFileImport={handleFileImport}
        onClearFile={clearFile}
      />

      {isGenerating && stallCritical && (
        <div className="rounded-lg border p-3 flex items-center justify-between gap-3" style={{ borderColor: 'color-mix(in srgb, var(--color-status-danger) 35%, transparent)', backgroundColor: 'color-mix(in srgb, var(--color-status-danger) 12%, transparent)' }}>
          <span className="text-sm" style={{ color: 'var(--color-status-danger)' }}>
            🔴 AI 已超过 120 秒没有新内容输出，建议中止以节省时间和费用。已完成的段落会自动保存。
          </span>
          <button
            type="button"
            onClick={handleAbort}
            className="rounded-lg px-3 py-1.5 text-sm font-bold text-white whitespace-nowrap"
            style={{ backgroundColor: 'var(--color-status-danger)' }}
          >
            中止生成
          </button>
        </div>
      )}
      {isGenerating && stallWarning && !stallCritical && (
        <div className="rounded-lg border p-3 text-sm" style={{ borderColor: 'color-mix(in srgb, var(--color-status-warning) 35%, transparent)', backgroundColor: 'color-mix(in srgb, var(--color-status-warning) 12%, transparent)', color: 'var(--color-status-warning)' }}>
          ⚠️ AI 已超过 60 秒没有新内容输出，可能卡住了。请耐心等待，或等到 120 秒后可以中止。
        </div>
      )}

      <PipelinePanel
        source={combinedSource}
        chunkCharLimit={state.chunkCharLimit}
        gateMode={state.gateMode}
        narrativeMode={state.narrativeMode}
        entryBudget={state.entryBudget}
        workflowRunState={workflowRunState}
        onRetryFailed={handleRetryFailed}
        onSkipRetry={() => navigate('/wizard?fromWorkshop=1')}
        retryDisabled={isGenerating}
      />

      <ConfigPanel
        gateMode={state.gateMode}
        narrativeMode={state.narrativeMode}
        entryBudget={state.entryBudget}
        chunkCharLimit={state.chunkCharLimit}
        focus={state.focus}
        stageOrder={state.stageOrder}
        currentStage={state.currentStage}
        isGenerating={isGenerating}
        onGateModeChange={(mode) => syncInputsIntoState({ gateMode: mode })}
        onNarrativeModeChange={(mode) => syncInputsIntoState({ narrativeMode: mode })}
        onEntryBudgetChange={(budget) => syncInputsIntoState({ entryBudget: budget })}
        onChunkCharLimitChange={(limit) => syncInputsIntoState({ chunkCharLimit: limit })}
        onFocusChange={(focus) => syncInputsIntoState({ focus })}
        onGenerate={handleGenerate}
        onReset={resetWorkshop}
      />

      <ManagerPanel
        visible={state.generatedEntries.length > 0}
        summary={state.summary}
        stageOrder={state.stageOrder}
        currentStage={state.currentStage}
        flags={state.flags}
        entityIndex={state.entityIndex}
        generatedEntries={state.generatedEntries}
        onStageChange={(stage) => {
          updateState(prev => ({ ...prev, currentStage: stage }));
        }}
        onFlagToggle={(flagId, value) => {
          updateState(prev => ({
            ...prev,
            flags: prev.flags.map(f => f.id === flagId ? { ...f, value } : f),
          }));
        }}
        onSyncVariables={handleSyncVariables}
        onDeleteEntry={handleDeleteGeneratedEntry}
        onDeleteEntries={handleDeleteGeneratedEntries}
        onUpdateEntry={handleUpdateGeneratedEntry}
        onUpdateEntries={handleUpdateGeneratedEntries}
        onAddEntry={handleAddGeneratedEntry}
        onAddEntries={handleAddGeneratedEntries}
        onReorderEntries={handleReorderGeneratedEntries}
        onImportEntries={handleImportGeneratedEntries}
      />

      <NovelStatusBar text={statusText} color={statusColor} />
    </div>
  );
}
