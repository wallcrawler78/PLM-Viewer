import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVisualPages } from '../src/visual-diff/client';
import type { VisualDiffWorker } from '../src/visual-diff/client';
import { compareRasterPages } from '../src/visual-diff/algorithm';
import type { RasterPage, VisualDiffInput, VisualDiffResult, VisualDiffWorkerRequest, VisualDiffWorkerResponse } from '../src/visual-diff/types';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function raster(sourceKey: string): RasterPage {
  return { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255), sourceKey, page: 1, pixelsPerPoint: 1.5 };
}
function input(): VisualDiffInput { return { before: raster('baseline:revA:edition1:hashA'), after: raster('current:revB:edition1:hashB') }; }
function worker(transfer?: (request: VisualDiffWorkerRequest, transfer: Transferable[]) => void): VisualDiffWorker & { terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> } {
  return { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn((request: VisualDiffWorkerRequest, buffers: Transferable[]) => transfer?.(request, buffers)), terminate: vi.fn(() => {}) };
}
function request(instance: ReturnType<typeof worker>) { return instance.postMessage.mock.calls[0][0] as VisualDiffWorkerRequest; }
function complete(instance: ReturnType<typeof worker>, value?: VisualDiffResult) {
  const sent = request(instance);
  instance.onmessage!({ data: { type: 'visual-diff-result', requestId: sent.requestId, result: value ?? compareRasterPages(sent.input) } } as MessageEvent<VisualDiffWorkerResponse>);
}

describe('local visual comparison worker lifecycle', () => {
  it('transfers copies without detaching source rasters owned by the page UI', async () => {
    let received!: VisualDiffWorkerRequest;
    const instance = worker((message, buffers) => { received = structuredClone(message, { transfer: buffers }); });
    const sources = input(), pending = compareVisualPages(sources, { createWorker: () => instance });
    expect(sources.before!.data.byteLength).toBe(16); expect(sources.after!.data.byteLength).toBe(16);
    expect(received.input.before!.data.byteLength).toBe(16); expect(received.input.after!.data.byteLength).toBe(16);
    expect(instance.postMessage.mock.calls[0][1]).toHaveLength(2);
    const result = compareRasterPages(received.input);
    instance.onmessage!({ data: { type: 'visual-diff-result', requestId: received.requestId, result } } as MessageEvent<VisualDiffWorkerResponse>);
    expect(await pending).toBe(result); expect(instance.terminate).toHaveBeenCalledOnce();
    expect(instance.onmessage).toBeNull(); expect(instance.onerror).toBeNull(); expect(instance.onmessageerror).toBeNull();
  });

  it('binds an in-flight result to the original descriptor even if caller metadata changes', async () => {
    const instance = worker(), sources = input();
    const pending = compareVisualPages(sources, { createWorker: () => instance });
    sources.before!.sourceKey = 'different'; sources.after!.page = 7;
    complete(instance);
    expect((await pending).before?.sourceKey).toBe('baseline:revA:edition1:hashA');
  });

  it('terminates on cancellation and ignores late responses from an obsolete pair', async () => {
    const instance = worker(), controller = new AbortController();
    const pending = compareVisualPages(input(), { signal: controller.signal, createWorker: () => instance });
    const lateHandler = instance.onmessage!, sent = request(instance);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    lateHandler({ data: { type: 'visual-diff-result', requestId: sent.requestId, result: compareRasterPages(sent.input) } } as MessageEvent<VisualDiffWorkerResponse>);
    expect(instance.terminate).toHaveBeenCalledOnce();
  });

  it('rejects a cancelled request and invalid limits before allocating a worker', async () => {
    const createWorker = vi.fn(() => worker()), controller = new AbortController(); controller.abort();
    await expect(compareVisualPages(input(), { signal: controller.signal, createWorker })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(compareVisualPages({ before: null, after: null }, { createWorker })).rejects.toThrow('actual page');
    await expect(compareVisualPages(input(), { createWorker, timeoutMs: Infinity })).rejects.toThrow('deadline');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('terminates work when the deadline expires', async () => {
    vi.useFakeTimers();
    const instance = worker(), pending = compareVisualPages(input(), { createWorker: () => instance, timeoutMs: 25 });
    const rejected = expect(pending).rejects.toThrow('time limit');
    await vi.advanceTimersByTimeAsync(25); await rejected;
    expect(instance.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a response from another request even when its pixel dimensions match', async () => {
    const instance = worker(), pending = compareVisualPages(input(), { createWorker: () => instance });
    instance.onmessage!({ data: { type: 'visual-diff-result', requestId: 'stale', result: compareRasterPages(request(instance).input) } } as MessageEvent<VisualDiffWorkerResponse>);
    await expect(pending).rejects.toThrow('another source request'); expect(instance.terminate).toHaveBeenCalledOnce();
  });

  it('rejects mismatched source/page/scale, invalid masks and impossible change counts', async () => {
    for (const patch of [
      (result: VisualDiffResult) => ({ ...result, after: { ...result.after!, sourceKey: 'new-edition' } }),
      (result: VisualDiffResult) => ({ ...result, before: { ...result.before!, page: 2 } }),
      (result: VisualDiffResult) => ({ ...result, pixelsPerPoint: 2 }),
      (result: VisualDiffResult) => ({ ...result, tolerance: 36 }),
      (result: VisualDiffResult) => ({ ...result, mask: new Uint8ClampedArray(1) }),
      (result: VisualDiffResult) => ({ ...result, changedPixels: 17 }),
      (result: VisualDiffResult) => ({ ...result, regionCount: 1 }),
    ]) {
      const instance = worker(), pending = compareVisualPages(input(), { createWorker: () => instance });
      complete(instance, patch(compareRasterPages(request(instance).input)));
      await expect(pending).rejects.toThrow('does not match'); expect(instance.terminate).toHaveBeenCalledOnce();
    }
  });

  it('rejects an invalid region envelope rather than exposing a misleading review anchor', async () => {
    const instance = worker(), sources = input(); sources.after!.data.set([0, 0, 0, 255], 0);
    const pending = compareVisualPages(sources, { createWorker: () => instance });
    const result = compareRasterPages(request(instance).input); result.regions[0].x = 8;
    complete(instance, result);
    await expect(pending).rejects.toThrow('invalid change region'); expect(instance.terminate).toHaveBeenCalledOnce();
  });

  it('cleans up kernel errors, transfer failures and malformed response types', async () => {
    for (const mode of ['worker-error', 'message-error', 'returned-error', 'bad-type'] as const) {
      const instance = worker(), pending = compareVisualPages(input(), { createWorker: () => instance });
      if (mode === 'worker-error') instance.onerror!({ preventDefault() {} } as ErrorEvent);
      else if (mode === 'message-error') instance.onmessageerror!();
      else instance.onmessage!({ data: mode === 'returned-error' ? { type: 'visual-diff-error', requestId: request(instance).requestId, message: 'Invalid page pixels.' } : { type: 'unexpected', requestId: request(instance).requestId } } as unknown as MessageEvent<VisualDiffWorkerResponse>);
      await expect(pending).rejects.toBeInstanceOf(Error); expect(instance.terminate).toHaveBeenCalledOnce();
    }
    const failedTransfer = worker(() => { throw new Error('transfer'); });
    await expect(compareVisualPages(input(), { createWorker: () => failedTransfer })).rejects.toThrow('could not transfer');
    expect(failedTransfer.terminate).toHaveBeenCalledOnce();
    await expect(compareVisualPages(input(), { createWorker: () => { throw new Error('startup'); } })).rejects.toThrow('could not start');
  });

  it('keeps concurrent request identities distinct when results complete out of order', async () => {
    const first = worker(), second = worker();
    const firstPending = compareVisualPages(input(), { createWorker: () => first });
    const next = input(); next.after!.page = 2;
    const secondPending = compareVisualPages(next, { createWorker: () => second });
    expect(request(first).requestId).not.toBe(request(second).requestId);
    complete(second); complete(first);
    expect((await secondPending).after?.page).toBe(2); expect((await firstPending).after?.page).toBe(1);
  });
});
