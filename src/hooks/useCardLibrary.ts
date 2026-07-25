/**
 * useCardLibrary - CRUD operations for the character card library.
 * Uses Dexie.js (IndexedDB) for persistence.
 */
import { useState, useEffect, useCallback } from 'react';
import { db } from '../db/database';
import { assembleCard } from '../services/card-exporter';

interface CardRecord {
  id?: number;
  name: string;
  spec: string;
  spec_version: string;
  data: Record<string, unknown>;
  _meta: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  /** Optional cover image shown in the library grid (PNG blob). */
  coverImageBlob?: Blob;
  [key: string]: unknown;
}

export function useCardLibrary() {
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [trashCards, setTrashCards] = useState<CardRecord[]>([]);
  const [loading, setLoading] = useState(true);

  /** Load all cards from IndexedDB (active + trash) */
  const loadCards = useCallback(async () => {
    setLoading(true);
    try {
      const all = await db.cards.orderBy('updatedAt').reverse().toArray();
      const active = all.filter(c => !c.deletedAt) as CardRecord[];
      const trashed = all.filter(c => c.deletedAt) as CardRecord[];
      setCards(active);
      setTrashCards(trashed);
    } catch (err) {
      console.error('Failed to load cards:', err);
      setCards([]);
      setTrashCards([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCards();
  }, [loadCards]);

  /** Save a card (create or update) */
  const saveCard = useCallback(async (draft: Parameters<typeof assembleCard>[0], existingId?: number) => {
    const card = assembleCard(draft, existingId) as CardRecord;
    if (existingId) {
      const existing = (await db.cards.get(existingId)) as CardRecord;
      if (existing) {
        // Preserve original timestamps, soft-delete status, and custom cover image
        card.createdAt = existing.createdAt || new Date();
        card.deletedAt = existing.deletedAt ?? null;
        if (existing.coverImageBlob) card.coverImageBlob = existing.coverImageBlob;
      }
    }
    const id = await db.cards.put(card);
    await loadCards();
    return id;
  }, [loadCards]);

  /** Update the cover image of a saved card (null clears it). */
  const updateCardCover = useCallback(async (id: number, blob: Blob | null) => {
    if (blob) {
      await db.cards.update(id, { coverImageBlob: blob });
    } else {
      // Dexie's update can't unset fields by setting null for indexed fields,
      // but coverImageBlob isn't indexed — set to undefined via put merge.
      const existing = (await db.cards.get(id)) as CardRecord | undefined;
      if (existing) {
        delete existing.coverImageBlob;
        await db.cards.put(existing);
      }
    }
    await loadCards();
  }, [loadCards]);

  /** Get a card by ID */
  const getCard = useCallback(async (id: number): Promise<CardRecord | undefined> => {
    return (await db.cards.get(id)) as CardRecord | undefined;
  }, []);

  /** Soft delete a card (move to trash) */
  const deleteCard = useCallback(async (id: number) => {
    await db.cards.update(id, { deletedAt: new Date() });
    await loadCards();
  }, [loadCards]);

  /** Restore a card from trash */
  const restoreCard = useCallback(async (id: number) => {
    await db.cards.update(id, { deletedAt: null });
    await loadCards();
  }, [loadCards]);

  /** Permanently delete a card from trash */
  const permanentDelete = useCallback(async (id: number) => {
    await db.cards.delete(id);
    // Also delete associated chat sessions
    await db.chat_sessions.where('cardId').equals(id).delete();
    await loadCards();
  }, [loadCards]);

  /** Empty the trash (permanently delete all trashed cards) */
  const emptyTrash = useCallback(async () => {
    const trashed = await db.cards.where('deletedAt').above(new Date(0)).toArray();
    for (const card of trashed) {
      if (card.id) {
        await db.cards.delete(card.id);
        await db.chat_sessions.where('cardId').equals(card.id).delete();
      }
    }
    await loadCards();
  }, [loadCards]);

  /** Search cards by name */
  const searchCards = useCallback(async (query: string) => {
    const all = await db.cards.toArray();
    const filtered = all.filter((c: { name: string }) =>
      c.name.toLowerCase().includes(query.toLowerCase())
    );
    return filtered as CardRecord[];
  }, []);

  return { cards, trashCards, loading, saveCard, getCard, deleteCard, restoreCard, permanentDelete, emptyTrash, searchCards, loadCards, updateCardCover };
}
