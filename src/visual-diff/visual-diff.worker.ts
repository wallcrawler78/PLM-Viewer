import { compareRasterPages } from './algorithm';
import type { VisualDiffWorkerRequest, VisualDiffWorkerResponse } from './types';
import { VisualDiffError } from './validation';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<VisualDiffWorkerRequest>) => void) | null;
  postMessage(message: VisualDiffWorkerResponse, transfer?: Transferable[]): void;
};

let started = false;
scope.onmessage = event => {
  if (started || event.data?.type !== 'compare-visual-pages') return;
  started = true;
  const request = event.data;
  if (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 100) return;
  try {
    const result = compareRasterPages(request.input);
    scope.postMessage({ type: 'visual-diff-result', requestId: request.requestId, result }, [result.mask.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ type: 'visual-diff-error', requestId: request.requestId, message: error instanceof VisualDiffError ? error.message : 'The local visual comparison could not process these page rasters.' });
  }
};
