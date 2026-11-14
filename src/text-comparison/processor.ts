import { compareDocumentBlocks } from '../document-review';
import type { TextComparisonWorkerResponse } from './types';
import { normalizeTextComparisonInput, validateTextComparisonResult } from './validation';

/** Runs only in the packaged worker; exported for protocol tests without a DOM. */
export function processTextComparisonRequest(value: unknown): TextComparisonWorkerResponse | null {
  if (typeof value !== 'object' || value === null || !('requestId' in value) || typeof value.requestId !== 'string' || !value.requestId.length || value.requestId.length > 100) return null;
  const requestId = value.requestId;
  let input;
  try {
    if (!('type' in value) || value.type !== 'compare-document-text' || !('input' in value) || Object.keys(value).length !== 3) throw new Error();
    input = normalizeTextComparisonInput(value.input);
  } catch { return { type: 'document-text-error', requestId, code: 'invalid-input' }; }
  try {
    const result = validateTextComparisonResult({ ...compareDocumentBlocks(input.before.blocks, input.after.blocks), beforeKey: input.before.sourceKey, afterKey: input.after.sourceKey }, input);
    return { type: 'document-text-result', requestId, result };
  } catch { return { type: 'document-text-error', requestId, code: 'comparison-failed' }; }
}
