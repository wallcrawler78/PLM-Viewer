import { afterEach, describe, expect, it, vi } from 'vitest';
import { importStepUrl, readStepResponse, runStepWorker, StepImportQueue } from '../src/cad/step-client';
import type { CadWorker } from '../src/cad/step-client';
import { STEP_LIMITS } from '../src/cad/step-types';
import type { StepImportResult, StepWorkerRequest, StepWorkerResponse } from '../src/cad/step-types';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function result(): StepImportResult {
  return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]),
    bounds: { min: [0, 0, 0], max: [1, 1, 0] }, hierarchy: { name: '', meshIndices: [0], children: [] }, meshRanges: [{ sourceMeshIndex: 0, name: '', firstTriangle: 0, triangleCount: 1 }],
    sourceHash: 'a'.repeat(64), units: 'mm', cadNodePath: [], sourceToPart: { position: [0, 0, 0], rotation: [0, 0, 0] }, warnings: [],
  };
}
function worker(): CadWorker & { terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> } {
  return { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn((_request: StepWorkerRequest, _transfer: Transferable[]) => {}), terminate: vi.fn(() => {}) };
}
const bytes = () => new TextEncoder().encode('ISO-10303-21;').buffer;

describe('local STEP worker lifetime', () => {
  it('transfers source bytes and terminates the worker immediately after its geometry result', async () => {
    const instance = worker(), data = bytes();
    const pending = runStepWorker(data, { expectedHash: 'a'.repeat(64), createWorker: () => instance });
    expect(instance.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'import-step', bytes: data }), [data]);
    const geometry = result();
    instance.onmessage!({ data: { type: 'step-result', result: geometry } } as MessageEvent<StepWorkerResponse>);
    expect(await pending).toBe(geometry);
    expect(instance.terminate).toHaveBeenCalledOnce(); expect(instance.onmessage).toBeNull();
  });

  it('rejects aborts and ignores a late result from the cancelled source', async () => {
    const instance = worker(), controller = new AbortController();
    const pending = runStepWorker(bytes(), { signal: controller.signal, createWorker: () => instance });
    const lateHandler = instance.onmessage!;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    lateHandler({ data: { type: 'step-result', result: result() } } as MessageEvent<StepWorkerResponse>);
    expect(instance.terminate).toHaveBeenCalledOnce();
  });

  it('terminates work that exceeds the import deadline', async () => {
    vi.useFakeTimers();
    const instance = worker();
    const pending = runStepWorker(bytes(), { timeoutMs: 25, createWorker: () => instance });
    const rejected = expect(pending).rejects.toThrow('limit');
    await vi.advanceTimersByTimeAsync(25); await rejected;
    expect(instance.terminate).toHaveBeenCalledOnce();
  });

  it('rejects geometry with a different source hash, component path or part frame', async () => {
    for (const different of [{ sourceHash: 'b'.repeat(64) }, { cadNodePath: [1] }, { sourceToPart: { position: [1, 0, 0], rotation: [0, 0, 0] } }]) {
      const instance = worker();
      const pending = runStepWorker(bytes(), { expectedHash: 'a'.repeat(64), createWorker: () => instance });
      instance.onmessage!({ data: { type: 'step-result', result: { ...result(), ...different } } } as MessageEvent<StepWorkerResponse>);
      await expect(pending).rejects.toThrow('does not match');
      expect(instance.terminate).toHaveBeenCalledOnce();
    }
  });

  it('requires an explicit frame before a subtree request can allocate a worker', async () => {
    const createWorker = vi.fn(() => worker());
    await expect(runStepWorker(bytes(), { cadNodePath: [0, 2], createWorker })).rejects.toThrow('explicit sourceToPart');
    await expect(runStepWorker(bytes(), { cadNodePath: [], createWorker })).rejects.toThrow('explicit sourceToPart');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('binds a subtree worker transfer to its finite source-to-part transform', async () => {
    const instance = worker(), data = bytes();
    const sourceToPart = { position: [10, -20, 30], rotation: [0.2, -0.3, 0.4] } as const;
    const transform = { position: [...sourceToPart.position] as [number, number, number], rotation: [...sourceToPart.rotation] as [number, number, number] };
    const pending = runStepWorker(data, { cadNodePath: [0, 2], sourceToPart: transform, createWorker: () => instance });
    expect(instance.postMessage).toHaveBeenCalledWith(expect.objectContaining({ cadNodePath: [0, 2], sourceToPart: transform }), [data]);
    const geometry = { ...result(), cadNodePath: [0, 2], sourceToPart: transform };
    instance.onmessage!({ data: { type: 'step-result', result: geometry } } as MessageEvent<StepWorkerResponse>);
    expect(await pending).toBe(geometry); expect(instance.terminate).toHaveBeenCalledOnce();
  });

  it('serializes imports and removes cancelled queued work before it allocates a worker', async () => {
    const queue = new StepImportQueue();
    let release!: () => void;
    const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController(), never = vi.fn(async () => 'cancelled');
    const second = queue.run(never, controller.signal);
    const thirdOperation = vi.fn(async () => 'third');
    const third = queue.run(thirdOperation);
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(never).not.toHaveBeenCalled(); expect(thirdOperation).not.toHaveBeenCalled();
    controller.abort(); await rejected;
    release(); await first;
    expect(await third).toBe('third'); expect(never).not.toHaveBeenCalled();
  });
});

describe('STEP source byte limits', () => {
  it.each(['deadline', 'source change'])('discards a response arriving after %s without waiting for its cancellation', async cause => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const fetch = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { deliver = resolve; }));
    const createWorker = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('Worker', createWorker);
    const controller = new AbortController();
    const outcome = importStepUrl('/late.step', undefined, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    if (cause === 'deadline') {
      await vi.advanceTimersByTimeAsync(STEP_LIMITS.fetchTimeoutMs + 1);
      expect(await outcome).toMatchObject({ message: expect.stringContaining('too long') });
    } else {
      const reason = new DOMException('The selected revision changed.', 'AbortError');
      controller.abort(reason);
      expect(await outcome).toBe(reason);
    }
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode('ISO-10303-21;')); }, cancel,
    }));
    deliver(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(createWorker).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects advertised oversize content before consuming its body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(33 * 1024 * 1024) } });
    await expect(readStepResponse(response)).rejects.toThrow('file limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a stalled body when source access or the caller is cancelled', async () => {
    const cancel = vi.fn(), controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = readStepResponse(response, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
