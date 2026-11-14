import { describe, it, expect } from 'vitest';
import { LocalReviewStore, ReviewConflictError, commentsForSnapshot, parseReview } from '../src/data/reviewStore';
import type { StoragePort } from '../src/data/reviewStore';
import type { ReviewComment } from '../src/domain';
class MemoryStorage implements StoragePort {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const comment = (): ReviewComment => ({
  id: 'comment-1', body: 'Check bracket against section 4.', author: 'Preview reviewer', status: 'open', createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z',
  source: { workspaceId: 'w', snapshotId: 'snapshot-A', itemId: 'sensor', revision: 'A', sourceHash: 'source-one' },
  anchor: { kind: 'model', occurrenceId: 'occ-sensor', localPoint: [2, 4, 6], units: 'mm' }, replies: [],
});
describe('source-bound local review persistence', () => {
  it('round-trips comments, source identity and saved layout without mutating state', () => {
    const storage = new MemoryStorage(), store = new LocalReviewStore('w', storage);
    const initial = store.load(); initial.comments.push(comment());
    initial.views.push({ id: 'view-1', name: 'Sensor check', createdAt: '2026-11-10T12:00:00.000Z', source: comment().source, state: { layout: 'split', hidden: ['occ-cover'], camera: { position: [2, 4, 6] }, doc: { id: 'spec-A', edition: '1' } } });
    const saved = store.save(initial, 0); expect(saved.revision).toBe(1);
    const exported = store.export(); const other = new LocalReviewStore('w', new MemoryStorage());
    expect(other.import(exported, 0).comments).toEqual(saved.comments);
    expect(other.load().views[0].state).toEqual(saved.views[0].state);
    expect(commentsForSnapshot(saved, 'snapshot-A')).toHaveLength(1);
    expect(commentsForSnapshot(saved, 'snapshot-B')).toHaveLength(0);
  });
  it('detects stale editors and preserves the first successful edit', () => {
    const storage = new MemoryStorage(), a = new LocalReviewStore('w', storage), b = new LocalReviewStore('w', storage);
    const draftA = a.load(), draftB = b.load(); draftA.comments.push(comment());
    a.save(draftA, 0);
    expect(() => b.save(draftB, 0)).toThrow(ReviewConflictError);
    expect(a.load().comments).toHaveLength(1);
  });
  it('isolates workspaces and rejects mismatched imports', () => {
    const storage = new MemoryStorage(), a = new LocalReviewStore('w', storage), b = new LocalReviewStore('other', storage);
    const next = a.load(); next.comments.push(comment()); a.save(next, 0);
    expect(b.load().comments).toHaveLength(0);
    expect(() => b.import(a.export(), 0)).toThrow('different workspace');
    expect(() => b.save(a.load(), 0)).toThrow('does not match');
  });
  it('rejects corrupt and future-format data without silently resetting it', () => {
    const storage = new MemoryStorage(), store = new LocalReviewStore('w', storage);
    storage.setItem(store.key, '{broken');
    expect(() => store.load()).toThrow('valid JSON'); expect(storage.getItem(store.key)).toBe('{broken');
    expect(() => parseReview('{"formatVersion":2}', 'w')).toThrow('Unsupported');
  });
  it('validates anchors, duplicate IDs and author/body values', () => {
    const store = new LocalReviewStore('w', new MemoryStorage()); const next = store.load(); next.comments.push(comment());
    const duplicate = structuredClone(next); duplicate.comments.push(comment());
    expect(() => store.save(duplicate, 0)).toThrow('duplicate');
    const anchor = structuredClone(next); anchor.comments[0].anchor = { kind: 'model', occurrenceId: 'x', localPoint: [1, 2, Infinity], units: 'mm' };
    expect(() => store.save(anchor, 0)).toThrow('invalid');
    const blank = structuredClone(next); blank.comments[0].body = ' ';
    expect(() => store.save(blank, 0)).toThrow('invalid');
    expect(store.load().revision).toBe(0);
  });
  it('reports storage quota/read failures and rejects oversized payloads', () => {
    const full: StoragePort = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    const store = new LocalReviewStore('w', full); expect(() => store.save(store.load(), 0)).toThrow('full or disabled');
    const blocked: StoragePort = { ...full, getItem: () => { throw new Error('blocked'); } };
    expect(() => new LocalReviewStore('w', blocked).load()).toThrow('unavailable');
    expect(() => parseReview(' '.repeat(2 * 1024 * 1024 + 1), 'w')).toThrow('2 MB');
  });
});
