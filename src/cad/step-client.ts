import { fetchViewerContent } from '../integrations/protectedContent';
import { discardResponse, withAbort } from '../integrations/responseBody';
import { CadImportError, validateStepMapping } from './step-mapping';
import { STEP_LIMITS } from './step-types';
import type { CadSourceToPart, StepImportResult, StepWorkerRequest, StepWorkerResponse } from './step-types';

/** One active import bounds simultaneous source buffers and WASM heaps per tab. */
export class StepImportQueue {
  private active = false;
  private waiting: { start: () => void; cancel: () => void }[] = [];

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    if (this.waiting.length >= STEP_LIMITS.maxQueuedImports) return Promise.reject(new CadImportError('Too many STEP files are waiting for import. Load a smaller set of BOM components.'));
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const clean = () => signal?.removeEventListener('abort', entry.cancel);
      const entry = {
        start: () => {
          started = true; this.active = true;
          void Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); }).then(resolve, reject).finally(() => {
            clean(); this.active = false; this.pump();
          });
        },
        cancel: () => {
          clean();
          if (!started) this.waiting = this.waiting.filter(candidate => candidate !== entry);
          reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
        },
      };
      signal?.addEventListener('abort', entry.cancel, { once: true });
      this.waiting.push(entry); this.pump();
    });
  }

  private pump() { if (!this.active) this.waiting.shift()?.start(); }
}

export interface CadWorker {
  onmessage: ((event: MessageEvent<StepWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: StepWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

type WorkerOptions = {
  signal?: AbortSignal;
  expectedHash?: string;
  cadNodePath?: number[];
  sourceToPart?: CadSourceToPart;
  timeoutMs?: number;
  createWorker?: () => CadWorker;
};

export async function runStepWorker(bytes: ArrayBuffer, options: WorkerOptions = {}): Promise<StepImportResult> {
  const { signal, expectedHash } = options;
  const { cadNodePath, sourceToPart } = validateStepMapping(options.cadNodePath, options.sourceToPart);
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
  if (!bytes.byteLength || bytes.byteLength > STEP_LIMITS.maxSourceBytes) return Promise.reject(new CadImportError('This STEP exceeds the 32 MiB local import limit or is empty.'));
  return new Promise((resolve, reject) => {
    let worker: CadWorker;
    try {
      worker = options.createWorker ? options.createWorker() : new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' }) as unknown as CadWorker;
    } catch { reject(new CadImportError('This browser could not start the local STEP worker. Check the installed viewer assets.')); return; }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
    };
    const finish = (result?: StepImportResult, error?: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(undefined, signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(undefined, new CadImportError('Local STEP import reached its two-minute limit. Use a smaller assembly or retry.')), options.timeoutMs ?? STEP_LIMITS.importTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      if (event.data?.type === 'step-error') { finish(undefined, new CadImportError(event.data.message)); return; }
      if (event.data?.type !== 'step-result') { finish(undefined, new CadImportError('The local CAD worker returned an invalid response.')); return; }
      const result = event.data.result;
      if (!(result?.positions instanceof Float32Array) || !(result?.normals instanceof Float32Array) || !(result?.indices instanceof Uint32Array)
        || !result.positions.length || result.positions.length > STEP_LIMITS.maxVertices * 3 || result.normals.length !== result.positions.length
        || !result.indices.length || result.indices.length > STEP_LIMITS.maxTriangles * 3 || result.units !== 'mm'
        || !Array.isArray(result.meshRanges) || !Array.isArray(result.warnings) || !result.warnings.every(message => typeof message === 'string')
        || !/^[a-f0-9]{64}$/.test(result.sourceHash) || (expectedHash && result.sourceHash !== expectedHash)
        || JSON.stringify(result.cadNodePath) !== JSON.stringify(cadNodePath)
        || JSON.stringify(result.sourceToPart) !== JSON.stringify(sourceToPart)) {
        finish(undefined, new CadImportError('The imported geometry does not match this STEP source or component mapping.')); return;
      }
      finish(result);
    };
    worker.onerror = event => { event.preventDefault?.(); finish(undefined, new CadImportError('The local CAD worker failed. The source may exceed browser memory or use unsupported geometry.')); };
    worker.onmessageerror = () => finish(undefined, new CadImportError('The browser could not transfer the imported geometry.'));
    try { worker.postMessage({ type: 'import-step', bytes, expectedHash, cadNodePath, sourceToPart }, [bytes]); }
    catch { finish(undefined, new CadImportError('The browser could not transfer this STEP to its local worker.')); }
    if (signal?.aborted) abort();
  });
}

/** Read actual chunks, not just Content-Length, before transferring one buffer. */
export async function readStepResponse(response: Response, signal?: AbortSignal): Promise<ArrayBuffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > STEP_LIMITS.maxSourceBytes)) {
    discardResponse(response); throw new CadImportError('This STEP exceeds the local file limit or has an invalid length.');
  }
  if (!response.body) throw new CadImportError('The STEP attachment is empty.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, complete = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > STEP_LIMITS.maxSourceBytes) throw new CadImportError('This STEP exceeds the 32 MiB local file limit.');
      chunks.push(value);
    }
    if (!size) throw new CadImportError('The STEP attachment is empty.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const imports = new StepImportQueue();

export async function importStepUrl(url: string, expectedHash?: string, signal?: AbortSignal, cadNodePath?: number[], sourceToPart?: CadSourceToPart): Promise<StepImportResult> {
  // Reject an unbound frame before fetching source bytes or joining the queue.
  const mapping = validateStepMapping(cadNodePath, sourceToPart);
  return imports.run(async () => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new CadImportError('The STEP source took too long to arrive. Retry the attachment.')), STEP_LIMITS.fetchTimeoutMs);
    const fetchSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let bytes: ArrayBuffer;
    try {
      const pending = fetchViewerContent(url, fetchSignal).then(response => {
        // A non-cooperative transport can deliver headers after cancellation.
        // Discard its newly owned body without delaying the settled import.
        if (fetchSignal.aborted) { discardResponse(response); fetchSignal.throwIfAborted(); }
        return response;
      });
      const response = await withAbort(pending, fetchSignal);
      if (!response.ok) { discardResponse(response); throw new CadImportError(`STEP attachment unavailable (HTTP ${response.status}).`); }
      bytes = await readStepResponse(response, fetchSignal);
    } finally { clearTimeout(timer); }
    signal?.throwIfAborted();
    return runStepWorker(bytes, { signal, expectedHash, ...mapping });
  }, signal);
}
