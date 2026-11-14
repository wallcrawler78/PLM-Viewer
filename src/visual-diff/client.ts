import { VISUAL_DIFF_LIMITS } from './types';
import type { RasterPage, VisualDiffInput, VisualDiffResult, VisualDiffWorkerRequest, VisualDiffWorkerResponse } from './types';
import { normalizeVisualDiffInput, validateVisualDiffResult, VisualDiffError } from './validation';

export interface VisualDiffWorker {
  onmessage: ((event: MessageEvent<VisualDiffWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: VisualDiffWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface VisualDiffOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable worker boundary for deterministic lifecycle tests. */
  createWorker?: () => VisualDiffWorker;
}

function copyPage(page: RasterPage | null): RasterPage | null {
  return page ? { sourceKey: page.sourceKey, page: page.page, width: page.width, height: page.height, pixelsPerPoint: page.pixelsPerPoint, data: new Uint8ClampedArray(page.data) } : null;
}

/**
 * Work belongs to this request and is terminated on every completion path.
 * Source buffers are copied before transfer so the page UI retains its raster.
 * Callers cancel their prior request before choosing another source/page pair.
 */
export async function compareVisualPages(rawInput: VisualDiffInput, options: VisualDiffOptions = {}): Promise<VisualDiffResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const normalized = normalizeVisualDiffInput(rawInput);
  // Snapshot metadata now: later mutations of a caller-owned raster descriptor
  // cannot rebind this in-flight request to a different file/page.
  const input: Required<VisualDiffInput> = { ...normalized, before: normalized.before ? { ...normalized.before } : null, after: normalized.after ? { ...normalized.after } : null };
  const timeoutMs = options.timeoutMs ?? VISUAL_DIFF_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > VISUAL_DIFF_LIMITS.maxTimeoutMs) {
    throw new VisualDiffError('The visual comparison deadline is invalid.');
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let worker: VisualDiffWorker;
    try { worker = options.createWorker ? options.createWorker() : new Worker(new URL('./visual-diff.worker.ts', import.meta.url), { type: 'module' }) as unknown as VisualDiffWorker; }
    catch { reject(new VisualDiffError('The browser could not start the local visual comparison worker. Check the viewer package.')); return; }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate();
    };
    const finish = (result?: VisualDiffResult, error?: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(undefined, signal?.reason ?? new DOMException('Visual comparison cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(undefined, new VisualDiffError('Local visual comparison reached its time limit. Try a lower page resolution.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      if (settled) return;
      const message = event.data;
      if (!message || message.requestId !== requestId) { finish(undefined, new VisualDiffError('The visual worker returned a result for another source request.')); return; }
      if (message.type === 'visual-diff-error') { finish(undefined, new VisualDiffError(typeof message.message === 'string' ? message.message.slice(0, 500) : 'Local visual comparison failed.')); return; }
      if (message.type !== 'visual-diff-result') { finish(undefined, new VisualDiffError('The visual worker returned an invalid response.')); return; }
      try { validateVisualDiffResult(message.result, input); }
      catch (error) { finish(undefined, error); return; }
      finish(message.result);
    };
    worker.onerror = event => { event.preventDefault?.(); finish(undefined, new VisualDiffError('The local visual comparison worker could not process these page rasters.')); };
    worker.onmessageerror = () => finish(undefined, new VisualDiffError('The browser could not transfer the visual comparison result.'));
    try {
      const before = copyPage(input.before), after = copyPage(input.after);
      const buffers = [before?.data.buffer, after?.data.buffer].filter((value): value is ArrayBuffer => value instanceof ArrayBuffer);
      worker.postMessage({ type: 'compare-visual-pages', requestId, input: { before, after, tolerance: input.tolerance } }, buffers);
    } catch { finish(undefined, new VisualDiffError('The browser could not transfer these page rasters for local comparison.')); }
    if (signal?.aborted) abort();
  });
}
