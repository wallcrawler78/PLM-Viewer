import { describe, expect, it } from 'vitest';
import { compareDocumentBlocks, DOCUMENT_COMPARISON_LIMITS } from '../src/document-review';
import type { DocumentTextBlock, DocumentTextChange } from '../src/document-review';

const blocks = (text: string[], prefix = 'source', page = 1): DocumentTextBlock[] => text.map((value, i) => ({ id: `${prefix}-${i}`, page, text: value }));
const reconstruct = (change: DocumentTextChange, side: 'before' | 'after') => change.runs.filter(run => run.kind !== (side === 'before' ? 'added' : 'removed')).map(run => run.text).join('');

describe('source-aware document redlines', () => {
  it('marks the changed number, keeps the unit, and retains exact source block/page identities', () => {
    const result = compareDocumentBlocks(blocks(['Maximum installed width: 125 mm'], 'A', 2), blocks(['Maximum installed width: 140 mm'], 'B', 3));
    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 1, unchanged: 0 });
    expect(result.changes[0]).toMatchObject({ before: { id: 'A-0', page: 2 }, after: { id: 'B-0', page: 3 } });
    expect(result.changes[0].runs).toContainEqual({ kind: 'removed', text: '125' });
    expect(result.changes[0].runs).toContainEqual({ kind: 'added', text: '140' });
    expect(reconstruct(result.changes[0], 'before')).toBe('Maximum installed width: 125 mm');
    expect(reconstruct(result.changes[0], 'after')).toBe('Maximum installed width: 140 mm');
    expect(result.truncated).toBe(false);
  });

  it('ignores whitespace and pagination changes without mutating the source blocks', () => {
    const before = blocks(['  Torque:  4\r\nN·m  ', '', 'Pass\tinspection'], 'A', 1);
    const original = structuredClone(before);
    const result = compareDocumentBlocks(before, blocks(['Torque: 4 N·m', 'Pass inspection'], 'B', 2));
    expect(result.changes).toEqual([]);
    expect(result.stats.unchanged).toBe(2);
    expect(before).toEqual(original);
  });

  it('does not turn an inserted requirement into changes to adjacent unchanged paragraphs', () => {
    const result = compareDocumentBlocks(blocks(['Scope', 'Torque: 4 N·m', 'Inspection']), blocks(['Scope', 'Torque: 4 N·m', 'Ground the enclosure before servicing.', 'Inspection']));
    expect(result.stats).toEqual({ added: 1, removed: 0, modified: 0, unchanged: 3 });
    expect(result.changes[0].after?.text).toBe('Ground the enclosure before servicing.');
  });

  it('pairs a modified requirement around a new unrelated paragraph', () => {
    const result = compareDocumentBlocks(blocks(['Requirements', 'Maximum width: 125 mm', 'Torque: 4 N·m', 'End']), blocks(['Requirements', 'Ground the enclosure before servicing.', 'Maximum width: 140 mm', 'Torque: 6 N·m', 'End']));
    expect(result.stats).toEqual({ added: 1, removed: 0, modified: 2, unchanged: 2 });
    expect(result.changes.filter(change => change.kind === 'modified').map(change => change.before?.text)).toEqual(['Maximum width: 125 mm', 'Torque: 4 N·m']);
  });

  it('keeps repeated paragraphs anchored to their actual occurrence', () => {
    const result = compareDocumentBlocks(blocks(['Start', 'Repeated label', 'Pressure: 10 bar', 'Repeated label', 'Finish'], 'A'), blocks(['Start', 'Repeated label', 'Pressure: 12 bar', 'Repeated label', 'Finish'], 'B'));
    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 1, unchanged: 4 });
    expect(result.changes[0].before?.id).toBe('A-2');
    expect(result.changes[0].after?.id).toBe('B-2');
    expect(new Set(result.changes.map(change => change.id)).size).toBe(result.changes.length);
  });

  it('keeps unrelated replacements as a removal and an addition', () => {
    const result = compareDocumentBlocks(blocks(['Lubricate the bearing before assembly.']), blocks(['Store packaging in a dry area.']));
    expect(result.stats).toEqual({ added: 1, removed: 1, modified: 0, unchanged: 0 });
    expect(result.changes.map(change => change.kind)).toEqual(['removed', 'added']);
  });

  it('compares numeric cells even when every digit changes', () => {
    const result = compareDocumentBlocks(blocks(['Width', '125.0 mm', 'Length']), blocks(['Width', '140.5 mm', 'Length']));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].kind).toBe('modified');
    expect(result.changes[0].runs).toContainEqual({ kind: 'removed', text: '125.0' });
    expect(result.changes[0].runs).toContainEqual({ kind: 'added', text: '140.5' });
  });

  it('preserves punctuation, signs, Unicode, decimals, and case in the redline', () => {
    const before = 'Δ Position: −61.0 ± 0.5 mm; status: Released.';
    const after = 'Δ Position: +65.5 ± 0.2 mm; status: released!';
    const change = compareDocumentBlocks(blocks([before]), blocks([after])).changes[0];
    expect(change.kind).toBe('modified');
    expect(reconstruct(change, 'before')).toBe(before);
    expect(reconstruct(change, 'after')).toBe(after);
    expect(change.runs.some(run => run.kind === 'removed' && run.text.includes('0.5'))).toBe(true);
    expect(change.runs.some(run => run.kind === 'added' && run.text.includes('0.2'))).toBe(true);
  });

  it('handles entirely added, entirely removed, and empty documents', () => {
    expect(compareDocumentBlocks([], []).stats).toEqual({ added: 0, removed: 0, modified: 0, unchanged: 0 });
    expect(compareDocumentBlocks([], blocks(['New requirement'])).changes[0]).toMatchObject({ kind: 'added', runs: [{ kind: 'added', text: 'New requirement' }] });
    expect(compareDocumentBlocks(blocks(['Withdrawn requirement']), []).changes[0]).toMatchObject({ kind: 'removed', runs: [{ kind: 'removed', text: 'Withdrawn requirement' }] });
  });

  it('returns deterministic change IDs and complete before/after runs across mixed edits', () => {
    const before = blocks(['Introduction', 'Pressure: 10 bar', 'Safety', 'Torque: 4 N·m', 'Finish'], 'A');
    const after = blocks(['Introduction', 'Pressure: 12 bar', 'Safety', 'Torque: 5 N·m', 'Electrical supply: 24 V', 'Finish'], 'B');
    const result = compareDocumentBlocks(before, after);
    expect(compareDocumentBlocks(before, after)).toEqual(result);
    for (const change of result.changes) {
      expect(reconstruct(change, 'before')).toBe(change.before?.text ?? '');
      expect(reconstruct(change, 'after')).toBe(change.after?.text ?? '');
    }
  });

  it('keeps a small edit precise inside a long paragraph', () => {
    const before = 'Requirement ' + Array.from({ length: 700 }, (_, i) => `word${i}`).join(' ');
    const after = before.replace('word200', 'updated200');
    const result = compareDocumentBlocks(blocks([before]), blocks([after]));
    expect(result.truncated).toBe(false);
    expect(result.changes[0].runs.filter(run => run.kind !== 'equal')).toEqual([{ kind: 'removed', text: 'word200' }, { kind: 'added', text: 'updated200' }]);
  });
});

describe('bounded comparison work', () => {
  it('discloses a source block limit instead of declaring a complete no-change result', () => {
    const before = blocks(Array.from({ length: DOCUMENT_COMPARISON_LIMITS.blocks + 1 }, (_, i) => `Requirement ${i}`));
    const after = structuredClone(before);
    after.at(-1)!.text = 'Changed beyond the comparison limit';
    const result = compareDocumentBlocks(before, after);
    expect(result.truncated).toBe(true);
    expect(result.stats.unchanged).toBe(DOCUMENT_COMPARISON_LIMITS.blocks);
  });

  it('bounds a single oversized block before normalization', () => {
    const oversized = 'A'.repeat(DOCUMENT_COMPARISON_LIMITS.charactersPerBlock + 100);
    const result = compareDocumentBlocks([], blocks([oversized]));
    expect(result.truncated).toBe(true);
    expect(result.changes[0].after?.text.length).toBe(DOCUMENT_COMPARISON_LIMITS.charactersPerBlock);
  });

  it('discloses coarse redlines while retaining both full bounded paragraph texts', () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
    const before = 'Requirement ' + words.join(' ');
    const after = 'Requirement ' + [...words].reverse().join(' ');
    const result = compareDocumentBlocks(blocks([before]), blocks([after]));
    expect(result.truncated).toBe(true);
    expect(result.changes[0].kind).toBe('modified');
    expect(reconstruct(result.changes[0], 'before')).toBe(before);
    expect(reconstruct(result.changes[0], 'after')).toBe(after);
  });

  it('does not omit changed blocks when a large replacement exceeds the pairing budget', () => {
    const before = blocks(Array.from({ length: 300 }, (_, i) => `Before requirement ${i}`), 'A');
    const after = blocks(Array.from({ length: 300 }, (_, i) => `After requirement ${i}`), 'B');
    const result = compareDocumentBlocks(before, after);
    expect(result.truncated).toBe(true);
    expect(result.stats.removed + result.stats.modified).toBe(before.length);
    expect(result.stats.added + result.stats.modified).toBe(after.length);
    expect(result.changes.every(change => change.before || change.after)).toBe(true);
  });

  it('bounds aggregate text and empty-block scanning', () => {
    const source = blocks(Array.from({ length: 100 }, () => 'x'.repeat(10_000)));
    const result = compareDocumentBlocks([], source);
    expect(result.truncated).toBe(true);
    expect(result.changes.reduce((length, change) => length + (change.after?.text.length ?? 0), 0)).toBe(DOCUMENT_COMPARISON_LIMITS.characters);
    const emptyPrefix = blocks(Array.from({ length: DOCUMENT_COMPARISON_LIMITS.scannedBlocks + 1 }, () => ''));
    emptyPrefix.at(-1)!.text = 'Beyond the scan limit';
    expect(compareDocumentBlocks([], emptyPrefix).truncated).toBe(true);
  });
});
