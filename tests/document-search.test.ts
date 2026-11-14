import { describe, expect, it } from 'vitest';
import { createDocumentSearchIndex, DOCUMENT_SEARCH_LIMITS, documentSearchStatus, findDocumentPassages, isDocumentFindShortcut, normalizeDocumentSearchQuery } from '../src/document-search';
import { documentExtraction, failedDocumentExtraction } from '../src/document-extraction';
import type { DocumentTextBlock } from '../src/document-review';

describe('source-scoped document passage search', () => {
  const blocks: DocumentTextBlock[] = [
    { id: 'p1-b0', page: 1, text: 'Clamp   torque\n\t10 Nm. Torque must be verified.' },
    { id: 'p2-b0', page: 2, text: 'Inspect the TORQUE label.' },
    { id: 'p3-b0', page: 3, text: 'Pack after inspection.' },
  ];

  it('finds words and normalized phrases across indexed pages without changing source anchors', () => {
    const index = createDocumentSearchIndex(blocks);
    expect(findDocumentPassages(index, '  TORQUE  ')).toEqual([blocks[0], blocks[1]]);
    expect(findDocumentPassages(index, 'clamp\n  TORQUE\t10 nm.')).toEqual([blocks[0]]);
    expect(findDocumentPassages(index, 'inspection')).toEqual([blocks[2]]);
    expect(findDocumentPassages(index, 'clamp torque 10 nm.')[0]).toBe(blocks[0]);
    expect(blocks[0].text).toContain('\n\t');
  });

  it('counts one passage for repeated occurrences and keeps existing substring semantics', () => {
    const index = createDocumentSearchIndex(blocks);
    expect(findDocumentPassages(index, 'torque')).toHaveLength(2);
    expect(findDocumentPassages(index, 'torq')).toHaveLength(2);
    expect(findDocumentPassages(index, '\n\t ')).toEqual([]);
    expect(findDocumentPassages(index, '')).toEqual([]);
    expect(findDocumentPassages(index, 'verified. inspect')).toEqual([]);
  });

  it('retains separate indexes for sources with overlapping block IDs and pages', () => {
    const baseline = createDocumentSearchIndex([{ id: 'p1-b0', page: 1, text: 'Alpha requirement' }]);
    const current = createDocumentSearchIndex([{ id: 'p1-b0', page: 1, text: 'Beta requirement' }]);
    expect(findDocumentPassages(baseline, 'alpha')).toHaveLength(1);
    expect(findDocumentPassages(current, 'alpha')).toEqual([]);
    expect(findDocumentPassages(createDocumentSearchIndex(null), 'alpha')).toEqual([]);
  });

  it('reuses normalized source strings without rereading them on every query', () => {
    let reads = 0;
    const source = { id: 'p1-b0', page: 1, get text() { reads++; return 'Clamp TORQUE'; } };
    const index = createDocumentSearchIndex([source]);
    const indexedReads = reads;
    findDocumentPassages(index, 'clamp'); findDocumentPassages(index, 'torque'); findDocumentPassages(index, 'missing');
    expect(reads).toBe(indexedReads);
  });

  it('bounds indexing and exposes limited coverage instead of silently claiming no match', () => {
    const countBound = createDocumentSearchIndex(Array.from({ length: DOCUMENT_SEARCH_LIMITS.blocks + 1 }, (_, i) => ({ id: `b${i}`, page: 1, text: i === DOCUMENT_SEARCH_LIMITS.blocks ? 'omitted' : 'included' })));
    expect(countBound.passages).toHaveLength(DOCUMENT_SEARCH_LIMITS.blocks); expect(countBound.limited).toBe(true);
    expect(findDocumentPassages(countBound, 'omitted')).toEqual([]);
    const characterBound = createDocumentSearchIndex([{ id: 'long', page: 1, text: 'x'.repeat(DOCUMENT_SEARCH_LIMITS.characters) + ' omitted' }]);
    expect(characterBound.limited).toBe(true); expect(findDocumentPassages(characterBound, 'omitted')).toEqual([]);
    const complete = documentExtraction(blocks, [{ page: 1, status: 'text' }, { page: 2, status: 'text' }, { page: 3, status: 'text' }], 3);
    expect(documentSearchStatus(complete, 'omitted', 0, 0, characterBound.limited)).toBe('No matches in available text · partial');
    expect(normalizeDocumentSearchQuery('T'.repeat(DOCUMENT_SEARCH_LIMITS.queryCharacters + 10))).toHaveLength(DOCUMENT_SEARCH_LIMITS.queryCharacters);
  });
});

describe('honest search coverage and navigation status', () => {
  const complete = documentExtraction([{ id: 'b', page: 1, text: 'Torque' }], [{ page: 1, status: 'text' }], 1);
  const partial = documentExtraction(complete.blocks, [{ page: 1, status: 'text' }], 3);

  it('distinguishes reading, unavailable/scanned content, and a complete no-match result', () => {
    expect(documentSearchStatus(null, 'torque', 0, 0)).toBe('Reading text…');
    expect(documentSearchStatus(failedDocumentExtraction(), 'torque', 0, 0)).toBe('Search unavailable');
    const scanned = documentExtraction([], [{ page: 1, status: 'non-text' }], 1);
    expect(documentSearchStatus(scanned, 'torque', 0, 0)).toBe('Search unavailable');
    expect(documentSearchStatus(complete, 'missing', 0, 0)).toBe('No matching passages');
    expect(documentSearchStatus(complete, ' \n ', 0, 0)).toBe('');
  });

  it('qualifies positive and zero results when extraction is partial', () => {
    expect(documentSearchStatus(partial, '', 0, 0)).toBe('Partial text available');
    expect(documentSearchStatus(partial, 'missing', 0, 0)).toBe('No matches in available text · partial');
    expect(documentSearchStatus(partial, 'torque', 2, 1)).toBe('Passage 2 of 2 · partial');
    expect(documentSearchStatus({ ...complete, limited: true }, 'missing', 0, 0)).toBe('No matches in available text · partial');
  });

  it('labels passages and prevents an old index from showing an impossible count', () => {
    expect(documentSearchStatus(complete, 'torque', 3, 1)).toBe('Passage 2 of 3');
    expect(documentSearchStatus(complete, 'torque', 1, 8)).toBe('Passage 1 of 1');
  });

  it('recognizes only the unclaimed Ctrl/Cmd+F chord, leaving modified/browser/editor shortcuts alone', () => {
    const event = { key: 'f', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
    expect(isDocumentFindShortcut(event)).toBe(true);
    expect(isDocumentFindShortcut({ ...event, ctrlKey: false, metaKey: true, key: 'F' })).toBe(true);
    for (const patch of [{ ctrlKey: false }, { shiftKey: true }, { altKey: true }, { metaKey: true }, { defaultPrevented: true }, { isComposing: true }, { key: 'g' }]) {
      expect(isDocumentFindShortcut({ ...event, ...patch })).toBe(false);
    }
  });
});
