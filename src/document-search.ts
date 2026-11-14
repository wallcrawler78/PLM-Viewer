import { DOCUMENT_PROCESSING_LIMITS } from './document-extraction';
import type { DocumentExtraction } from './document-extraction';
import type { DocumentTextBlock } from './document-review';

export const DOCUMENT_SEARCH_LIMITS = Object.freeze({
  blocks: DOCUMENT_PROCESSING_LIMITS.extractionBlocks,
  // PDF extraction may insert one separator for each retained source character.
  characters: DOCUMENT_PROCESSING_LIMITS.extractionCharacters * 2,
  queryCharacters: 500,
});

interface IndexedPassage { block: DocumentTextBlock; text: string }
export interface DocumentSearchIndex { passages: IndexedPassage[]; limited: boolean }
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');

/** Build once for an exact source's extracted blocks; searches reuse the index. */
export function createDocumentSearchIndex(blocks: readonly DocumentTextBlock[] | null): DocumentSearchIndex {
  const passages: IndexedPassage[] = [];
  let remaining = DOCUMENT_SEARCH_LIMITS.characters, limited = false;
  const end = Math.min(blocks?.length ?? 0, DOCUMENT_SEARCH_LIMITS.blocks);
  limited = (blocks?.length ?? 0) > end;
  for (let index = 0; index < end; index++) {
    if (!remaining) { limited = true; break; }
    const block = blocks![index];
    const sourceText = block.text;
    const raw = sourceText.slice(0, remaining);
    remaining -= raw.length;
    if (raw.length < sourceText.length) limited = true;
    const text = normalize(raw);
    if (text) passages.push({ block, text });
  }
  return { passages, limited };
}

/** The input enforces this same length limit before storing the query. */
export function normalizeDocumentSearchQuery(query: string): string {
  return normalize(query.slice(0, DOCUMENT_SEARCH_LIMITS.queryCharacters));
}

/** One hit is one source passage, even if its text repeats the search term. */
export function findDocumentPassages(index: DocumentSearchIndex, query: string): DocumentTextBlock[] {
  const text = normalizeDocumentSearchQuery(query);
  return text ? index.passages.filter(passage => passage.text.includes(text)).map(passage => passage.block) : [];
}

export function documentSearchStatus(extraction: DocumentExtraction | null, query: string, count: number, active: number, indexLimited = false): string {
  if (!extraction) return 'Reading text…';
  if (extraction.status === 'unavailable') return 'Search unavailable';
  const partial = extraction.status === 'partial' || extraction.limited || indexLimited;
  if (!normalizeDocumentSearchQuery(query)) return partial ? 'Partial text available' : '';
  if (!count) return partial ? 'No matches in available text · partial' : 'No matching passages';
  return `Passage ${Math.max(1, Math.min(count, active + 1))} of ${count}${partial ? ' · partial' : ''}`;
}

/** This recognizes the chord only; the reader also checks DOM/focus ownership. */
export function isDocumentFindShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean; isComposing?: boolean }): boolean {
  return !event.defaultPrevented && !event.isComposing && !event.shiftKey && !event.altKey && event.ctrlKey !== event.metaKey && event.key.toLowerCase() === 'f';
}
