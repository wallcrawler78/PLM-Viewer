import type { DocumentComparisonResult, DocumentTextBlock } from '../document-review';
import { DOCUMENT_COMPARISON_LIMITS } from '../document-review';

/** The transport remains bounded even before the comparison's finer limits apply. */
export const TEXT_COMPARISON_LIMITS = Object.freeze({
  sourceKey: 16_384,
  blockId: 128,
  pages: 300,
  blocks: DOCUMENT_COMPARISON_LIMITS.scannedBlocks,
  // PDF text extraction inserts separators between text items. Those separators
  // can double the retained source-character count before comparison is limited.
  characters: DOCUMENT_COMPARISON_LIMITS.characters * 2,
  changes: DOCUMENT_COMPARISON_LIMITS.blocks * 2,
  runs: 200_000,
  timeoutMs: 15_000,
  maxTimeoutMs: 60_000,
});

export interface TextComparisonSource { sourceKey: string; blocks: DocumentTextBlock[] }
export interface TextComparisonInput { before: TextComparisonSource; after: TextComparisonSource }
export interface TextComparisonResult extends DocumentComparisonResult { beforeKey: string; afterKey: string }
export interface TextComparisonWorkerRequest { type: 'compare-document-text'; requestId: string; input: TextComparisonInput }
export type TextComparisonWorkerResponse =
  | { type: 'document-text-result'; requestId: string; result: TextComparisonResult }
  | { type: 'document-text-error'; requestId: string; code: 'invalid-input' | 'comparison-failed' };
