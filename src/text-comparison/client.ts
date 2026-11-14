import { TEXT_COMPARISON_LIMITS } from './types';
import type { TextComparisonInput, TextComparisonResult, TextComparisonWorkerRequest } from './types';
import { normalizeTextComparisonInput, TextComparisonError, validateTextComparisonResult } from './validation';

export interface TextComparisonWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: TextComparisonWorkerRequest): void;
  terminate(): void;
}
export interface TextComparisonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable local worker boundary for deterministic lifecycle tests. */
  createWorker?: () => TextComparisonWorker;
}

/** Each source pair owns a worker. There is deliberately no UI-thread fallback. */
export async function compareDocumentText(rawInput: TextComparisonInput, options: TextComparisonOptions = {}): Promise<TextComparisonResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const input = normalizeTextComparisonInput(rawInput);
  const timeoutMs = options.timeoutMs ?? TEXT_COMPARISON_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TEXT_COMPARISON_LIMITS.maxTimeoutMs) throw new TextComparisonError('The local text comparison deadline is invalid.');
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let worker: TextComparisonWorker;
    try { worker = options.createWorker ? options.createWorker() : new Worker(new URL('./text-comparison.worker.ts', import.meta.url), { type: 'module' }) as unknown as TextComparisonWorker; }
    catch { reject(new TextComparisonError('The browser could not start the local text comparison worker. Check the viewer package, then retry. Source pages remain available.')); return; }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
    };
    const finish = (result?: TextComparisonResult, error?: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      // Abort reasons may legally be false, 0 or an empty string. Only an
      // actual validated result can take the successful completion path.
      if (result === undefined) reject(error); else resolve(result);
    };
    const abort = () => finish(undefined, signal?.reason ?? new DOMException('Text comparison cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(undefined, new TextComparisonError('Local text comparison reached its time limit. Retry, or review the source pages. No complete text result is available.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      if (settled) return;
      const message = event.data;
      if (typeof message !== 'object' || message === null || !('requestId' in message) || message.requestId !== requestId) {
        finish(undefined, new TextComparisonError('The text worker returned a result for another source request. Retry the comparison.')); return;
      }
      if ('type' in message && message.type === 'document-text-error' && Object.keys(message).length === 3 && 'code' in message && ['invalid-input', 'comparison-failed'].includes(message.code as string)) {
        finish(undefined, new TextComparisonError(message.code === 'invalid-input' ? 'The extracted text could not be accepted for local comparison. Review the source pages or reopen the files.' : 'The local text comparison could not finish within its processing limits. Retry, or review the source pages.')); return;
      }
      if (!('type' in message) || message.type !== 'document-text-result' || !('result' in message) || Object.keys(message).length !== 3) {
        finish(undefined, new TextComparisonError('The local text worker returned an invalid response. Retry the comparison.')); return;
      }
      try { finish(validateTextComparisonResult(message.result, input)); }
      catch (error) { finish(undefined, error instanceof TextComparisonError ? error : new TextComparisonError('The local text comparison result could not be verified. Retry the comparison.')); }
    };
    worker.onerror = event => { event.preventDefault?.(); finish(undefined, new TextComparisonError('The local text comparison worker could not process these documents. Retry, or review the source pages.')); };
    worker.onmessageerror = () => finish(undefined, new TextComparisonError('The browser could not receive the local text comparison result. Retry the comparison.'));
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage({ type: 'compare-document-text', requestId, input }); }
    catch { finish(undefined, new TextComparisonError('The browser could not send these documents to the local text comparison worker. Retry the comparison.')); }
    if (signal?.aborted) abort();
  });
}
