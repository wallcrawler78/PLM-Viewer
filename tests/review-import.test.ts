import { describe, expect, it, vi } from 'vitest';
import { ReviewImportController } from '../src/data/reviewImport';
import { emptyReview, LocalReviewStore, ReviewConflictError } from '../src/data/reviewStore';
import type { StoragePort } from '../src/data/reviewStore';

class MemoryStorage implements StoragePort {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
function delayedFile() {
  let resolve!: (text: string) => void, reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { file: { text: () => promise }, resolve, reject };
}
const backup = (workspaceId: string) => JSON.stringify(emptyReview(workspaceId));
const request = (store: LocalReviewStore) => ({ store, expectedRevision: 0, recoveryToken: null });

describe('asynchronous review import isolation', () => {
  it('lets only the newest overlapping file read write storage or apply UI state', async () => {
    const storage = new MemoryStorage(), store = new LocalReviewStore('w', storage), controller = new ReviewImportController();
    const first = delayedFile(), second = delayedFile(), apply = vi.fn();
    const older = controller.readAndImport(first.file, request(store), apply);
    const newer = controller.readAndImport(second.file, request(store), apply);
    first.resolve(backup('w'));
    expect(await older).toBeNull();
    expect(storage.getItem(store.key)).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    second.resolve(backup('w'));
    expect((await newer)?.workspaceId).toBe('w');
    expect(store.load().revision).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('cancels old-workspace reads before any write when the workspace changes', async () => {
    const storage = new MemoryStorage(), oldStore = new LocalReviewStore('old', storage), newStore = new LocalReviewStore('new', storage), controller = new ReviewImportController();
    const delayed = delayedFile(), apply = vi.fn();
    const oldImport = controller.readAndImport(delayed.file, request(oldStore), apply);
    controller.cancel();
    await controller.readAndImport({ text: async () => backup('new') }, request(newStore), apply);
    delayed.resolve(backup('old'));
    expect(await oldImport).toBeNull();
    expect(storage.getItem(oldStore.key)).toBeNull();
    expect(newStore.load().workspaceId).toBe('new');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].workspaceId).toBe('new');
  });

  it('ignores a stale read failure after cancellation or unmount', async () => {
    const store = new LocalReviewStore('w', new MemoryStorage()), controller = new ReviewImportController(), delayed = delayedFile(), apply = vi.fn();
    const pending = controller.readAndImport(delayed.file, request(store), apply);
    controller.cancel();
    delayed.reject(new Error('old file read failed'));
    await expect(pending).resolves.toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(store.load().revision).toBe(0);
  });

  it('captures the recovery token and store revision before reading a file', async () => {
    const storage = new MemoryStorage(), store = new LocalReviewStore('w', storage), controller = new ReviewImportController(), delayed = delayedFile();
    storage.setItem(store.key, '{corrupt original');
    const context = { store, expectedRevision: 0, recoveryToken: store.captureRecovery() };
    const pending = controller.readAndImport(delayed.file, context, () => {});
    context.recoveryToken = null;
    context.expectedRevision = 100;
    delayed.resolve(backup('w'));
    expect((await pending)?.revision).toBe(1);
    expect(store.load().workspaceId).toBe('w');
  });

  it('preserves a concurrent saved edit instead of importing with a newly observed revision', async () => {
    const store = new LocalReviewStore('w', new MemoryStorage()), controller = new ReviewImportController(), delayed = delayedFile(), apply = vi.fn();
    const context = request(store);
    const pending = controller.readAndImport(delayed.file, context, apply);
    store.save(emptyReview('w'), 0);
    context.expectedRevision = 1;
    delayed.resolve(backup('w'));
    await expect(pending).rejects.toThrow(ReviewConflictError);
    expect(store.load().revision).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });
});
