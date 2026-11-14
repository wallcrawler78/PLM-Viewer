import { describe, expect, it } from 'vitest';
import { attachmentIdentityKey } from '../src/domain';
import { documentComparisonSources, matchesDocumentAnchor } from '../src/document-sources';
import type { DocumentAnchor, DocumentFile } from '../src/components/Documents';

const file = (values: Partial<DocumentFile> = {}): DocumentFile => ({
  id: 'same-file-guid', itemId: 'item-1', revision: 'B', edition: '2', kind: 'pdf',
  sourceHash: 'hash-2', name: 'Specification.pdf', url: '/files/edition-2.pdf', seriesId: 'spec', ...values,
});
const anchor = (values: Partial<DocumentAnchor> = {}): DocumentAnchor => ({
  fileId: 'same-file-guid', itemId: 'item-1', revision: 'B', edition: '2', kind: 'pdf',
  sourceHash: 'hash-2', page: 1, x: 0.25, y: 0.4, ...values,
});

describe('document source pairing', () => {
  it('compares distinct editions of the same file GUID instead of dropping its baseline', () => {
    const opened = file();
    const baseline = file({ revision: 'A', edition: '1', sourceHash: 'hash-1', url: '/files/edition-1.pdf' });
    const result = documentComparisonSources(opened, [baseline, opened]);
    expect(result.candidates).toEqual([baseline]);
    expect(result.automaticKey).toBe(attachmentIdentityKey(baseline));
  });

  it('does not mistake a renewed delivery URL for a different source edition', () => {
    const opened = file();
    const baseline = file({ edition: '1', sourceHash: 'hash-1' });
    const renewedBaseline = { ...baseline, url: '/renewed-delivery-url' };
    const result = documentComparisonSources(opened, [opened, { ...opened, url: '/renewed-open-url' }, baseline, renewedBaseline]);
    expect(result.candidates).toHaveLength(1);
    expect(result.automaticKey).toBe(attachmentIdentityKey(baseline));
  });

  it('requires deliberate selection when a family has several possible editions', () => {
    const result = documentComparisonSources(file(), [file(), file({ edition: '1' }), file({ revision: 'C', edition: '3' })]);
    expect(result.related).toHaveLength(2);
    expect(result.automaticKey).toBe('');
  });

  it('never pairs files from a different item, format, or unconfirmed family automatically', () => {
    const opened = file();
    const unrelated = file({ id: 'other-doc', seriesId: undefined });
    const result = documentComparisonSources(opened, [opened, file({ itemId: 'other-item' }), file({ kind: 'docx' }), unrelated]);
    expect(result.candidates).toEqual([unrelated]);
    expect(result.automaticKey).toBe('');
  });
});

describe('document anchor ownership', () => {
  it('rejects anchors on another revision, edition, item, hash, file, or format', () => {
    expect(matchesDocumentAnchor(anchor(), file())).toBe(true);
    for (const mismatch of [{ fileId: 'other' }, { revision: 'A' }, { edition: '1' }, { itemId: 'other' }, { sourceHash: 'changed' }, { kind: 'docx' as const }]) {
      expect(matchesDocumentAnchor(anchor(mismatch), file())).toBe(false);
    }
  });

  it('preserves legacy anchors while enforcing every identity field they contain', () => {
    expect(matchesDocumentAnchor(anchor({ itemId: undefined, sourceHash: undefined }), file())).toBe(true);
    expect(matchesDocumentAnchor(anchor({ itemId: undefined, sourceHash: undefined, edition: '1' }), file())).toBe(false);
    expect(matchesDocumentAnchor(null, file())).toBe(false);
  });
});
