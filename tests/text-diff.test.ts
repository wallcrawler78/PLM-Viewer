import { describe, expect, it } from 'vitest';
import { compareText } from '../src/text-diff';
describe('document text comparison', () => {
  it('finds a changed tolerance and preserves unchanged requirements', () => {
    const result = compareText('Mounting width: 125 mm\nTorque: 4 Nm', 'Mounting width: 140 mm\nTorque: 4 Nm');
    expect(result).toContainEqual({ kind: 'removed', text: 'Mounting width: 125 mm' });
    expect(result).toContainEqual({ kind: 'added', text: 'Mounting width: 140 mm' });
    expect(result).toContainEqual({ kind: 'equal', text: 'Torque: 4 Nm' });
  });
  it('normalizes visual whitespace without inventing content changes', () => {
    expect(compareText('A  B\r\n\nC', 'A B\nC').every(x => x.kind === 'equal')).toBe(true);
  });
  it('handles an empty or entirely replaced document', () => {
    expect(compareText('', 'New requirement')).toEqual([{ kind: 'added', text: 'New requirement' }]);
    expect(compareText('Removed', '')).toEqual([{ kind: 'removed', text: 'Removed' }]);
  });
});
