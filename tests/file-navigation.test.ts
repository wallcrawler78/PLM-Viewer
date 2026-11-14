import { describe, expect, it } from 'vitest';
import { attachmentIdentityKey } from '../src/domain';
import type { Attachment } from '../src/domain';
import { groupFileNavigation, indexFileNavigation } from '../src/file-navigation';

const attachment = (values: Partial<Attachment> = {}): Attachment => ({ id: 'file-1', itemId: 'part-1', revision: 'B', edition: '2', sourceHash: 'hash-b', kind: 'pdf', name: 'Specification.pdf', url: '/files/b.pdf', ...values });
const snapshot = (documents: Attachment[], name = 'Revised housing') => ({ rootItemId: 'root', rootItemNumber: 'ASM-1000', documents, parts: [{ id: 'part-1', name, itemNumber: 'HSG-2000' }] });

describe('file navigator source labels and filtering', () => {
  it('uses the active item label even when the earlier snapshot is listed first', () => {
    const current = attachment();
    const older = attachment({ revision: 'A', edition: '1', sourceHash: 'hash-a' });
    const active = snapshot([current]);
    const entries = indexFileNavigation(active, [snapshot([older], 'Old housing'), active], [older, current]);
    expect(entries.every(entry => entry.itemName === 'Revised housing')).toBe(true);
    expect(groupFileNavigation(entries, 'root', 'hsg-2000', false, null)[0].files.map(entry => entry.file)).toEqual([current]);
    expect(groupFileNavigation(entries, 'root', 'revised housing', false, null)).toHaveLength(1);
  });

  it('retains a pinned earlier edition and distinguishes duplicate filenames', () => {
    const current = attachment();
    const older = attachment({ revision: 'A', edition: '1', sourceHash: 'hash-a' });
    const active = snapshot([current]);
    const entries = indexFileNavigation(active, [], [older, current]);
    const groups = groupFileNavigation(entries, 'root', '', false, attachmentIdentityKey(older));
    expect(groups[0].files.map(entry => [entry.file.edition, entry.current, entry.duplicateName])).toEqual([['2', true, true], ['1', false, true]]);
    expect(groupFileNavigation(entries, 'root', '', false, null)[0].files).toHaveLength(1);
    expect(groupFileNavigation(entries, 'root', '', true, null)[0].files).toHaveLength(2);
  });

  it('preserves current-source classification when a protected delivery URL rotates', () => {
    const current = attachment();
    const renewed = { ...current, url: '/files/renewed-delivery' };
    const entries = indexFileNavigation(snapshot([current]), [], [renewed]);
    expect(entries[0].current).toBe(true);
    expect(groupFileNavigation(entries, 'root', '', false, null)[0].files[0].file.url).toBe(renewed.url);
  });

  it('groups the assembly first, keeps item identities distinct and does not mutate source order', () => {
    const documents = [attachment(), attachment({ id: 'file-2', itemId: 'other' }), attachment({ id: 'root-file', itemId: 'root' })];
    const source = snapshot(documents);
    const before = documents.slice();
    const entries = indexFileNavigation(source, [], documents);
    const groups = groupFileNavigation(entries, 'root', '', false, null);
    expect(groups[0].itemId).toBe('root');
    expect(groups.map(group => group.itemId)).toEqual(['root', 'part-1', 'other']);
    expect(documents).toEqual(before);
    expect(groupFileNavigation(entries, 'root', 'does not exist', true, null)).toEqual([]);
  });
});
