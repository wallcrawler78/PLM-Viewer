import { processTextComparisonRequest } from './processor';
import type { TextComparisonWorkerResponse } from './types';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: TextComparisonWorkerResponse): void;
};
let started = false;
scope.onmessage = event => {
  if (started) return;
  started = true;
  const response = processTextComparisonRequest(event.data);
  if (response) scope.postMessage(response);
};
