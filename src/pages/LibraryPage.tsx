/**
 * LibraryPage - Character card library management.
 * Lists all saved cards as a responsive card grid with search, sort,
 * edit, delete, JSON/PNG export/import, and replaceable card covers.
 */
import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCardLibrary } from '../hooks/useCardLibrary';
import { useViewPrefs } from '../hooks/useViewPrefs';
import { db } from '../db/database';
import { useToast } from '../components/shared/Toast';
import { Button } from '../components/shared/Button';
import { TextInput } from '../components/shared/TextInput';
import { Modal } from '../components/shared/Modal';
import { CardCover } from '../components/shared/CardCover';
import { ViewToolbar } from '../components/shared/ViewToolbar';
import { useTranslation } from '../i18n/I18nContext';
import { WIZARD_DRAFT_VERSION } from '../constants/defaults';
import { cardToDraft, assembleCard, exportAsJson, exportAsPng, importFromPng } from '../services/card-exporter';
import { resizeImageToPngBuffer } from '../services/image-processing';
import { saveVersion, listVersions, rollbackToVersion, deleteVersion } from '../services/version-service';
import type { CardVersion } from '../db/database';
import { Trash2, Edit2, MoreVertical, Image as ImageIcon } from 'lucide-react';

export function LibraryPage() {
  const { t } = useTranslation();
  const { cards, trashCards, loading, deleteCard, restoreCard, permanentDelete, emptyTrash, loadCards, updateCardCover } = useCardLibrary();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updatedAt' | 'name'>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [permanentDeleteConfirm, setPermanentDeleteConfirm] = useState<number | null>(null);
  const [exportMenuCard, setExportMenuCard] = useState<Record<string, unknown> | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [versionHistoryCardId, setVersionHistoryCardId] = useState<number | null>(null);
  const [versions, setVersions] = useState<CardVersion[]>([]);
  const [versionLoading, setVersionLoading] = useState(false);
  const { mode: viewMode, size: viewSize, setMode: setViewMode, setSize: setViewSize } = useViewPrefs('library');

  // Grid column classes per size — bigger size = fewer columns.
  const gridColsBySize = {
    sm: 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8',
    md: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6',
    lg: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
  } as const;

  const filteredCards = useMemo(() => {
    let result = [...cards];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) => ((c.name as string) || '').toLowerCase().includes(q));
    }
    result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') {
        const aName = (a.name as string) || '';
        const bName = (b.name as string) || '';
        cmp = aName.localeCompare(bName);
      } else {
        cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return result;
  }, [cards, searchQuery, sortBy, sortDir]);

  const handleDelete = async (id: number) => {
    await deleteCard(id);
    addToast('success', t('library.trashed'));
    setDeleteConfirm(null);
  };

  const handleRestore = async (id: number) => {
    await restoreCard(id);
    addToast('success', t('library.restored'));
  };

  const handlePermanentDelete = async (id: number) => {
    await permanentDelete(id);
    addToast('success', t('library.permanentDeleteSuccess'));
    setPermanentDeleteConfirm(null);
  };

  const handleEmptyTrash = async () => {
    if (confirm(t('library.deleteConfirmPrompt'))) {
      await emptyTrash();
      addToast('success', t('library.trashCleared'));
    }
  };

  // ── 版本历史 ──────────────────────────────────────────────────────────
  const SOURCE_LABELS: Record<string, string> = {
    wizard: '向导保存',
    editor: '编辑室保存',
    import: '导入',
    rollback: '回滚保底',
    'library-edit': '库内编辑',
  };

  const handleOpenVersionHistory = useCallback(async (cardId: number) => {
    setExportMenuCard(null);
    setVersionHistoryCardId(cardId);
    setVersionLoading(true);
    try {
      const list = await listVersions(cardId);
      setVersions(list);
    } catch {
      setVersions([]);
    } finally {
      setVersionLoading(false);
    }
  }, []);

  const handleRollbackVersion = useCallback(async (versionId: number) => {
    if (!confirm('确定回滚到此版本？当前状态会自动保存一条保底版本，随时可再回滚。')) return;
    try {
      await rollbackToVersion(versionId);
      await loadCards();
      // 刷新版本列表（回滚会产生新版本）
      if (versionHistoryCardId) {
        const list = await listVersions(versionHistoryCardId);
        setVersions(list);
      }
      addToast('success', '已回滚到历史版本');
    } catch {
      addToast('error', '回滚失败');
    }
  }, [versionHistoryCardId, loadCards, addToast]);

  const handleDeleteVersion = useCallback(async (versionId: number) => {
    try {
      await deleteVersion(versionId);
      if (versionHistoryCardId) {
        const list = await listVersions(versionHistoryCardId);
        setVersions(list);
      }
      addToast('success', '已删除版本');
    } catch {
      addToast('error', '删除版本失败');
    }
  }, [versionHistoryCardId, addToast]);

  /** 就地编辑原卡：直达 /wizard/:id 编辑模式，保存会更新库中原卡片，不触碰创建流程的自动草稿。 */
  const handleEditInPlace = (cardId: number) => {
    navigate(`/wizard/${cardId}`);
  };

  const handleEditAsNewDraft = async (card: Record<string, unknown>) => {
    if (!confirm(t('library.editAsDraftConfirm'))) return;

    try {
      await db.wizard_drafts.put({
        id: 'new',
        data: cardToDraft(card),
        currentStep: 3,
        version: WIZARD_DRAFT_VERSION,
        updatedAt: new Date(),
      });
      addToast('success', t('library.editAsDraftSuccess'));
      navigate('/wizard');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      addToast('error', t('library.editAsDraftError', { message: msg }));
    }
  };

  const handleExportJson = (card: Record<string, unknown>) => {
    try {
      exportAsJson(card as Parameters<typeof exportAsJson>[0]);
      addToast('success', t('library.exportJsonSuccess'));
    } catch {
      addToast('error', t('library.exportJsonError'));
    }
    setExportMenuCard(null);
  };

  const handleExportPng = async (card: Record<string, unknown>) => {
    try {
      await exportAsPng(card as Parameters<typeof exportAsPng>[0]);
      addToast('success', t('library.exportPngSuccess'));
    } catch {
      addToast('error', t('library.exportPngError'));
    }
    setExportMenuCard(null);
  };

  const handleExportPngWithImage = async (card: Record<string, unknown>) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,image/png';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const buffer = await resizeImageToPngBuffer(file);
        await exportAsPng(card as Parameters<typeof exportAsPng>[0], buffer);
        addToast('success', t('library.exportPngCustomSuccess'));
      } catch (err) {
        addToast('error', err instanceof Error ? err.message : t('library.exportPngError'));
      }
    };
    input.click();
    setExportMenuCard(null);
  };

  const handleChangeCover = useCallback(async (id: number) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const buffer = await resizeImageToPngBuffer(file, { maxDimension: 600 });
        const blob = new Blob([buffer], { type: 'image/png' });
        await updateCardCover(id, blob);
        addToast('success', t('library.coverUpdated'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('library.coverUpdateFailed');
        addToast('error', msg);
      }
    };
    input.click();
  }, [updateCardCover, addToast, t]);

  const handleRemoveCover = useCallback(async (id: number) => {
    try {
      await updateCardCover(id, null);
      addToast('info', t('library.coverRemoved'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('library.coverUpdateFailed');
      addToast('error', msg);
    }
  }, [updateCardCover, addToast, t]);

  const handleImport = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.png,image/png';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        let cardData: Record<string, unknown>;
        let coverBlob: Blob | null = null;
        if (file.name.endsWith('.png') || file.type === 'image/png') {
          const buffer = await file.arrayBuffer();
          const extracted = await importFromPng(buffer);
          if (!extracted) {
            addToast('error', t('library.importPngError'));
            return;
          }
          cardData = extracted;
          // Use the imported PNG itself as the cover image (downsized for grid display).
          try {
            const resized = await resizeImageToPngBuffer(file, { maxDimension: 600 });
            coverBlob = new Blob([resized], { type: 'image/png' });
          } catch {
            coverBlob = null;
          }
        } else {
          const text = await file.text();
          cardData = JSON.parse(text);
        }
        // 通过 cardToDraft + assembleCard 规范化数据：清理失效 _meta entryIds、
        // 重建角色设定条目、统一卡片结构，避免导入后重复或残留旧条目。
        const draft = cardToDraft(cardData);
        const card = assembleCard(draft);
        const cardToSave = {
          ...card,
          name: card.data.name || card.name || t('library.importedCardName'),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(coverBlob ? { coverImageBlob: coverBlob } : {}),
        };
        const newId = await db.cards.add(cardToSave as Record<string, unknown>);
        try {
          await saveVersion(newId as number, cardToSave as Record<string, unknown>, 'import');
        } catch { /* 版本快照失败不影响导入 */ }
        await loadCards();
        addToast('success', t('library.importSuccess', { name: String(cardToSave.name) }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : t('common.unknownError');
        addToast('error', t('library.importError', { message: msg }));
      }
    };
    input.click();
  };

  const formatDate = (date: Date | string) => {
    try {
      return new Date(date).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return 'Unknown';
    }
  };

  const mutedText = 'color-mix(in srgb, var(--text-color) 60%, transparent)';
  const faintText = 'color-mix(in srgb, var(--text-color) 40%, transparent)';
  const borderColor = 'var(--color-border-default)';
  const surfaceBg = 'rgba(var(--card-bg-r), var(--card-bg-g), var(--card-bg-b), 0.5)';

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-color)' }}>
            {showTrash ? t('library.trashTitle') : t('library.title')}
          </h1>
          <p className="text-sm mt-1" style={{ color: mutedText }}>
            {showTrash
              ? t('library.trashCount', { count: String(trashCards.length) })
              : t('library.cardCount', { count: String(cards.length) })}
          </p>
        </div>
        <div className="flex gap-2">
          {!showTrash && (
            <>
              <Button variant="secondary" onClick={handleImport}>📥 {t('library.importButton')}</Button>
              <Button onClick={() => navigate('/wizard')}>✨ {t('library.createNewCard')}</Button>
            </>
          )}
          <Button
            variant={showTrash ? 'secondary' : 'ghost'}
            onClick={() => setShowTrash(!showTrash)}
          >
            {showTrash ? `📚 ${t('library.backToLibrary')}` : `🗑️ ${t('common.trash')} (${trashCards.length})`}
          </Button>
        </div>
      </div>

      {!showTrash && (
        <p className="text-xs mb-4 -mt-3" style={{ color: faintText }}>
          {t('library.importHint')}
        </p>
      )}

      {/* Trash view */}
      {showTrash && (
        <div className="mb-6">
          {trashCards.length > 0 && (
            <div className="flex items-center gap-3 mb-4">
              <Button variant="danger" size="sm" onClick={handleEmptyTrash}>
                🗑️ {t('library.emptyTrash')}
              </Button>
              <span className="text-xs" style={{ color: faintText }}>{t('library.trashHint')}</span>
            </div>
          )}
          {trashCards.length === 0 && !loading && (
            <div className="text-center py-16 border border-dashed rounded-xl" style={{ borderColor }}>
              <p className="text-lg mb-2" style={{ color: mutedText }}>{t('library.trashEmptyTitle')}</p>
              <p className="text-sm" style={{ color: faintText }}>{t('library.trashEmptySubtitle')}</p>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {trashCards.map((card) => (
              <div
                key={card.id}
                className="rounded-xl border overflow-hidden opacity-70 flex flex-col"
                style={{ borderColor, backgroundColor: surfaceBg }}
              >
                <CardCover
                  blob={card.coverImageBlob ?? null}
                  name={(card.name as string) || t('library.untitled')}
                />
                <div className="p-3 flex-1 flex flex-col">
                  <h3 className="text-sm font-semibold truncate" style={{ color: mutedText }}>
                    {card.name || t('library.untitled')}
                  </h3>
                  <p className="text-[10px] mt-1" style={{ color: faintText }}>
                    {t('library.deletedAt')}: {formatDate(card.deletedAt || card.updatedAt)}
                  </p>
                  <div className="flex items-center gap-1.5 mt-3 pt-2 border-t" style={{ borderColor: 'color-mix(in srgb, var(--color-border-default) 50%, transparent)' }}>
                    <Button variant="secondary" size="sm" className="flex-1 text-xs" onClick={() => handleRestore(card.id!)}>
                      ♻️ {t('library.restore')}
                    </Button>
                    <Button variant="danger" size="sm" className="text-xs px-2" onClick={() => setPermanentDeleteConfirm(card.id!)} title={t('library.permanentDelete')}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Normal card view */}
      {!showTrash && (<>

      {/* Search and sort bar */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="flex-1 min-w-[180px]">
          <TextInput
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('library.searchPlaceholder')}
          />
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'updatedAt' | 'name')}
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor, backgroundColor: 'var(--input-bg)', color: 'var(--text-color)' }}
        >
          <option value="updatedAt">{t('library.sortByDate')}</option>
          <option value="name">{t('library.sortByName')}</option>
        </select>
        <Button variant="ghost" size="sm" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>
          {sortDir === 'asc' ? '↑' : '↓'}
        </Button>
        <ViewToolbar
          mode={viewMode}
          size={viewSize}
          onModeChange={setViewMode}
          onSizeChange={setViewSize}
        />
      </div>

      {/* Loading state */}
      {loading && (
        <div className="text-center py-12" style={{ color: faintText }}>{t('library.loading')}</div>
      )}

      {/* Empty state */}
      {!loading && filteredCards.length === 0 && (
        <div className="text-center py-16 border border-dashed rounded-xl" style={{ borderColor }}>
          <p className="text-lg mb-2" style={{ color: mutedText }}>
            {searchQuery ? t('library.emptySearchTitle') : t('library.emptyLibraryTitle')}
          </p>
          <p className="text-sm mb-4" style={{ color: faintText }}>
            {searchQuery ? t('library.emptySearchSubtitle') : t('library.emptyLibrarySubtitle')}
          </p>
          {!searchQuery && (
            <Button onClick={() => navigate('/wizard')}>✨ {t('library.createFirstCard')}</Button>
          )}
        </div>
      )}

      {/* Card grid (grid mode) */}
      {viewMode === 'grid' && (
      <div className={`grid ${gridColsBySize[viewSize]} gap-4`}>
        {filteredCards.map((card) => {
          const data = (card.data || {}) as Record<string, unknown>;
          const cardTags = (data.tags as string[]) || [];
          const cardId = card.id as number;
          const cardName = (card.name as string) || t('library.untitled');
          const hasCustomCover = !!card.coverImageBlob;

          return (
            <div
              key={card.id}
              className="group rounded-xl border overflow-hidden flex flex-col transition-transform hover:-translate-y-0.5 hover:shadow-lg"
              style={{ borderColor, backgroundColor: surfaceBg }}
            >
              {/* Cover with hover actions */}
              <div className="relative">
                <CardCover blob={card.coverImageBlob ?? null} name={cardName} />

                {/* Top-right quick actions */}
                <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => setExportMenuCard(
                      exportMenuCard?.id === card.id ? null : (card as unknown as Record<string, unknown>),
                    )}
                    title={t('library.exportButton')}
                    className="w-7 h-7 rounded-md backdrop-blur-sm bg-black/55 text-white flex items-center justify-center hover:bg-black/75 transition-colors"
                  >
                    <MoreVertical size={14} />
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(cardId)}
                    title={t('common.delete')}
                    className="w-7 h-7 rounded-md backdrop-blur-sm bg-black/55 text-white flex items-center justify-center hover:bg-red-600/80 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Bottom cover-replace action */}
                <div className="absolute bottom-1.5 left-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleChangeCover(cardId)}
                    title={t('library.changeCover')}
                    className="flex-1 h-7 rounded-md backdrop-blur-sm bg-black/55 text-white text-[11px] flex items-center justify-center gap-1 hover:bg-black/75 transition-colors"
                  >
                    <ImageIcon size={12} />
                    {t('library.changeCover')}
                  </button>
                  {hasCustomCover && (
                    <button
                      onClick={() => handleRemoveCover(cardId)}
                      title={t('library.removeCover')}
                      className="w-7 h-7 rounded-md backdrop-blur-sm bg-black/55 text-white flex items-center justify-center hover:bg-black/75 transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                {/* Export dropdown */}
                {exportMenuCard?.id === card.id && (
                  <div
                    className="absolute right-1.5 top-9 w-44 rounded-lg border shadow-xl z-20 py-1"
                    style={{ borderColor, backgroundColor: 'var(--color-surface-raised)' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                      style={{ color: 'var(--text-color)' }}
                      onClick={() => {
                        setExportMenuCard(null);
                        handleEditAsNewDraft(card as unknown as Record<string, unknown>);
                      }}
                    >
                      📝 {t('library.forkAsDraft')}
                    </button>
                    <button
                      className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                      style={{ color: 'var(--text-color)' }}
                      onClick={() => handleExportJson(card as unknown as Record<string, unknown>)}
                    >
                      📄 {t('library.exportJson')}
                    </button>
                    <button
                      className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                      style={{ color: 'var(--text-color)' }}
                      onClick={() => handleExportPng(card as unknown as Record<string, unknown>)}
                    >
                      🖼️ {t('library.exportPngAuto')}
                    </button>
                    <button
                      className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                      style={{ color: 'var(--text-color)' }}
                      onClick={() => handleExportPngWithImage(card as unknown as Record<string, unknown>)}
                    >
                      🎨 {t('library.exportPngChoose')}
                    </button>
                    <button
                      className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                      style={{ color: 'var(--text-color)' }}
                      onClick={() => handleOpenVersionHistory(cardId)}
                    >
                      📜 历史版本
                    </button>
                  </div>
                )}
              </div>

              {/* Body */}
              <div className="p-3 flex-1 flex flex-col">
                <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-color)' }} title={cardName}>
                  {cardName}
                </h3>
                <div className="text-[10px] mt-1 truncate" style={{ color: faintText }}>
                  🕐 {formatDate(card.updatedAt)}
                </div>
                {cardTags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {cardTags.slice(0, 3).map((tag, i) => (
                      <span
                        key={i}
                        className="px-1.5 py-0.5 text-[10px] rounded"
                        style={{
                          backgroundColor: 'color-mix(in srgb, var(--color-text-secondary) 16%, transparent)',
                          color: mutedText,
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                    {cardTags.length > 3 && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded" style={{ color: faintText }}>
                        +{cardTags.length - 3}
                      </span>
                    )}
                  </div>
                )}
                {(data.description as string) && (
                  <p className="mt-2 text-xs line-clamp-2" style={{ color: mutedText }}>
                    {data.description as string}
                  </p>
                )}

                {/* Bottom action — mt-auto so short cards don't show blank body background */}
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-auto pt-2 text-xs w-full"
                  onClick={() => handleEditInPlace(cardId)}
                >
                  <Edit2 size={12} className="mr-1" />
                  {t('common.edit')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* List view (list mode) */}
      {viewMode === 'list' && (
      <div className="flex flex-col gap-2">
        {filteredCards.map((card) => {
          const data = (card.data || {}) as Record<string, unknown>;
          const cardTags = (data.tags as string[]) || [];
          const cardId = card.id as number;
          const cardName = (card.name as string) || t('library.untitled');
          const hasCustomCover = !!card.coverImageBlob;
          // Size affects row thumbnail size and padding
          const thumbSize = viewSize === 'sm' ? 'w-10 h-12' : viewSize === 'lg' ? 'w-16 h-20' : 'w-12 h-16';
          const rowPad = viewSize === 'sm' ? 'p-2' : viewSize === 'lg' ? 'p-3.5' : 'p-3';

          return (
            <div
              key={card.id}
              className="group relative rounded-xl border flex items-center gap-3 transition-colors hover:shadow-md"
              style={{ borderColor, backgroundColor: surfaceBg }}
            >
              {/* Thumbnail */}
              <div className="relative shrink-0">
                <CardCover
                  blob={card.coverImageBlob ?? null}
                  name={cardName}
                  aspectClass={thumbSize}
                  roundedClass="rounded-lg"
                />
                <div className="absolute inset-0 flex gap-1 items-start justify-end p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleChangeCover(cardId)}
                    title={t('library.changeCover')}
                    className="w-5 h-5 rounded backdrop-blur-sm bg-black/55 text-white flex items-center justify-center hover:bg-black/75"
                  >
                    <ImageIcon size={10} />
                  </button>
                  {hasCustomCover && (
                    <button
                      onClick={() => handleRemoveCover(cardId)}
                      title={t('library.removeCover')}
                      className="w-5 h-5 rounded backdrop-blur-sm bg-black/55 text-white flex items-center justify-center hover:bg-black/75"
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              </div>

              {/* Main content */}
              <div className={`min-w-0 flex-1 ${rowPad} flex items-center gap-3`}>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-color)' }} title={cardName}>
                    {cardName}
                  </h3>
                  <div className="text-[10px] mt-0.5 truncate" style={{ color: faintText }}>
                    🕐 {formatDate(card.updatedAt)}
                  </div>
                  {cardTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {cardTags.slice(0, 4).map((tag, i) => (
                        <span key={i} className="px-1.5 py-0.5 text-[10px] rounded" style={{ backgroundColor: 'color-mix(in srgb, var(--color-text-secondary) 16%, transparent)', color: mutedText }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {(data.description as string) && viewSize !== 'sm' && (
                    <p className="mt-1 text-xs line-clamp-1" style={{ color: mutedText }}>
                      {data.description as string}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setExportMenuCard(
                      exportMenuCard?.id === card.id ? null : (card as unknown as Record<string, unknown>),
                    )}
                    title={t('library.exportButton')}
                    className="w-7 h-7 rounded-md border flex items-center justify-center transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_6%,transparent)]"
                    style={{ borderColor, color: mutedText }}
                  >
                    <MoreVertical size={14} />
                  </button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="text-xs"
                    onClick={() => handleEditInPlace(cardId)}
                  >
                    <Edit2 size={12} className="mr-1" />
                    {t('common.edit')}
                  </Button>
                  <button
                    onClick={() => setDeleteConfirm(cardId)}
                    title={t('common.delete')}
                    className="w-7 h-7 rounded-md border flex items-center justify-center transition-colors hover:bg-red-600/10 hover:border-red-500/50"
                    style={{ borderColor, color: mutedText }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Inline export dropdown */}
              {exportMenuCard?.id === card.id && (
                <div
                  className="absolute right-4 top-12 w-44 rounded-lg border shadow-xl z-20 py-1"
                  style={{ borderColor, backgroundColor: 'var(--color-surface-raised)' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                    style={{ color: 'var(--text-color)' }}
                    onClick={() => {
                      setExportMenuCard(null);
                      handleEditAsNewDraft(card as unknown as Record<string, unknown>);
                    }}
                  >
                    📝 {t('library.forkAsDraft')}
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                    style={{ color: 'var(--text-color)' }}
                    onClick={() => handleExportJson(card as unknown as Record<string, unknown>)}
                  >
                    📄 {t('library.exportJson')}
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                    style={{ color: 'var(--text-color)' }}
                    onClick={() => handleExportPng(card as unknown as Record<string, unknown>)}
                  >
                    🖼️ {t('library.exportPngAuto')}
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                    style={{ color: 'var(--text-color)' }}
                    onClick={() => handleExportPngWithImage(card as unknown as Record<string, unknown>)}
                  >
                    🎨 {t('library.exportPngChoose')}
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text-color)_5%,transparent)]"
                    style={{ color: 'var(--text-color)' }}
                    onClick={() => handleOpenVersionHistory(cardId)}
                  >
                    📜 历史版本
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}

      </>)}

      {/* Click-away handler for export menu */}
      {exportMenuCard && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setExportMenuCard(null)}
        />
      )}

      {/* Delete confirmation modal */}
      <Modal isOpen={deleteConfirm !== null} onClose={() => setDeleteConfirm(null)} title={t('library.deleteTitle')}>
        <p className="mb-4" style={{ color: mutedText }}>
          {t('library.deleteConfirm')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>{t('library.deleteAction')}</Button>
        </div>
      </Modal>

      {/* Permanent delete confirmation modal */}
      <Modal isOpen={permanentDeleteConfirm !== null} onClose={() => setPermanentDeleteConfirm(null)} title={t('library.permanentDeleteTitle')}>
        <p className="mb-4" style={{ color: 'var(--color-status-danger)' }}>
          {t('library.permanentDeleteConfirm')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPermanentDeleteConfirm(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => permanentDeleteConfirm && handlePermanentDelete(permanentDeleteConfirm)}>{t('library.permanentDelete')}</Button>
        </div>
      </Modal>

      {/* 版本历史 modal */}
      <Modal
        isOpen={versionHistoryCardId !== null}
        onClose={() => { setVersionHistoryCardId(null); setVersions([]); }}
        title="历史版本"
      >
        {versionLoading ? (
          <p className="py-8 text-center" style={{ color: mutedText }}>加载中…</p>
        ) : versions.length === 0 ? (
          <p className="py-8 text-center" style={{ color: mutedText }}>暂无历史版本</p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto space-y-2">
            {versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-3 p-3 rounded-lg border"
                style={{ borderColor, backgroundColor: surfaceBg }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate" style={{ color: 'var(--text-color)' }}>
                    {v.name || '(未命名)'}
                  </div>
                  <div className="text-[11px] mt-0.5 flex items-center gap-2" style={{ color: faintText }}>
                    <span>{formatDate(v.createdAt)}</span>
                    <span className="px-1.5 py-0.5 rounded" style={{ backgroundColor: 'color-mix(in srgb, var(--color-text-secondary) 16%, transparent)' }}>
                      {SOURCE_LABELS[v.source] || v.source}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => v.id && handleRollbackVersion(v.id)}
                  >
                    回滚
                  </Button>
                  <button
                    onClick={() => v.id && handleDeleteVersion(v.id)}
                    className="w-7 h-7 rounded-md flex items-center justify-center transition-colors hover:bg-red-600/20"
                    style={{ color: 'var(--color-status-danger)' }}
                    title="删除此版本"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={() => { setVersionHistoryCardId(null); setVersions([]); }}>
            {t('common.close')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
