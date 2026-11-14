import { describe, expect, it } from 'vitest';
import { emptyReview, LocalReviewStore, ReviewConflictError } from '../src/data/reviewStore';
import type { StoragePort } from '../src/data/reviewStore';

class MemoryStorage implements StoragePort {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const backup = () => JSON.stringify({ ...emptyReview('w'), comments: [{ id: 'n1', body: 'Retain this review.', author: 'Preview reviewer', createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z', status: 'open', replies: [], source: { workspaceId: 'w', snapshotId: 's', itemId: 'i', revision: 'A' }, anchor: { kind: 'general' } }] });

describe('explicit local review recovery', () => {
  it('restores a valid backup only against the exact corrupt payload originally inspected', () => {
    const storage = new MemoryStorage(), store = new LocalReviewStore('w', storage);
    storage.setItem(store.key, '{broken');
    const token = store.captureRecovery()!;
    expect(token.rawValue).toBe('{broken');
    expect(storage.getItem(store.key)).toBe('{broken');
    const recovered = store.recoverFromBackup(backup(), token);
    expect(recovered.comments[0].body).toBe('Retain this review.');
    expect(recovered.revision).toBe(1);
    expect(store.load()).toEqual(recovered);
  });

  it('refuses recovery if another tab changed or repaired the original data', () => {
    const storage = new MemoryStorage(), store = new LocalReviewStore('w', storage);
    storage.setItem(store.key, '{broken');
    const token = store.captureRecovery()!;
    for (const replacement of ['{different broken payload', backup()]) {
      storage.setItem(store.key, replacement);
      expect(() => store.recoverFromBackup(backup(), token)).toThrow(ReviewConflictError);
      expect(storage.getItem(store.key)).toBe(replacement);
    }
  });

  it('preserves corrupt bytes when the incoming backup is invalid, oversized, or from another workspace', () => {
    const storage = new MemoryStorage(), store = new LocalReviewStore('w', storage);
    storage.setItem(store.key, '{broken');
    const token = store.captureRecovery()!;
    for (const json of ['{invalid backup', ' '.repeat(2 * 1024 * 1024 + 1), JSON.stringify(emptyReview('other'))]) {
      expect(() => store.recoverFromBackup(json, token)).toThrow();
      expect(storage.getItem(store.key)).toBe('{broken');
    }
  });

  it('preserves the old bytes if the recovery write exceeds storage quota', () => {
    const storage: StoragePort = { getItem: () => '{broken', setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    const store = new LocalReviewStore('w', storage), token = store.captureRecovery()!;
    expect(() => store.recoverFromBackup(backup(), token)).toThrow('original saved data was preserved');
    expect(store.captureRecovery()?.rawValue).toBe('{broken');
  });

  it('does not create a recovery token for missing or valid data and reports inaccessible storage', () => {
    const storage = new MemoryStorage(), store = new LocalReviewStore('w', storage);
    expect(store.captureRecovery()).toBeNull();
    storage.setItem(store.key, backup());
    expect(store.captureRecovery()).toBeNull();
    const unavailable = new LocalReviewStore('w', { getItem: () => { throw new Error('blocked'); }, setItem: () => {}, removeItem: () => {} });
    expect(() => unavailable.captureRecovery()).toThrow('unavailable');
  });
});
