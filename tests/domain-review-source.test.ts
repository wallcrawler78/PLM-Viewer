import { describe, it, expect } from 'vitest';
import fixtureManifest from '../public/fixtures/manifest.json';
import { PreviewAdapter } from '../src/data/previewAdapter';
import { pickSnapshotForAttachment, resolveCommentSource } from '../src/data/reviewSource';
import type { ReviewComment } from '../src/domain';

const api = new PreviewAdapter('precision', async () => new Response(JSON.stringify(fixtureManifest)));
async function sources() { return { a: await api.loadBom('A'), b: await api.loadBom('B') }; }
const note: Omit<ReviewComment, 'source' | 'anchor'> = { id: 'n1', body: 'Check the datum.', author: 'Preview reviewer', status: 'open', createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z', replies: [] };
describe('review source resolution', () => {
  it('keeps an unchanged document in the currently reviewed assembly context', async () => {
    const { a, b } = await sources();
    const shared = b.documents.find(d => d.itemId === 'gearbox')!;
    expect(pickSnapshotForAttachment(shared, b, [a, b]).id).toBe(b.id);
    expect(pickSnapshotForAttachment(shared, a, [a, b]).id).toBe(a.id);
  });
  it('retains the owner of a deliberately pinned document from another revision', async () => {
    const { a, b } = await sources();
    const pinned = b.documents.find(d => d.id === 'atlas-spec-B-pdf')!;
    expect(pickSnapshotForAttachment(pinned, a, [a, b]).id).toBe(b.id);
    expect(() => pickSnapshotForAttachment({ ...pinned, edition: 'another' }, a, [a, b])).toThrow('not available');
  });
  it('locates a model pin only in its exact snapshot and source hash', async () => {
    const { a, b } = await sources();
    const part = b.parts.find(p => p.id === 'sensor')!;
    const comment: ReviewComment = { ...note, source: { workspaceId: b.workspaceId, snapshotId: b.id, itemId: part.id, revision: part.revision, sourceHash: part.sourceHash }, anchor: { kind: 'model', occurrenceId: 'occ-sensor', localPoint: [0, 0, 14], units: 'mm' } };
    expect(resolveCommentSource(comment, [a, b]).occurrence?.id).toBe('occ-sensor');
    expect(() => resolveCommentSource({ ...comment, source: { ...comment.source, snapshotId: 'old-snapshot' } }, [a, b])).toThrow('unavailable');
    expect(() => resolveCommentSource({ ...comment, source: { ...comment.source, sourceHash: 'old-hash' } }, [a, b])).toThrow('unavailable');
    expect(() => resolveCommentSource({ ...comment, source: { ...comment.source, itemId: 'base' } }, [a, b])).toThrow('unavailable');
  });
  it('refuses a same-ID document with a different edition or hash', async () => {
    const { a, b } = await sources();
    const file = b.documents.find(d => d.id === 'atlas-spec-B-pdf')!;
    const comment: ReviewComment = { ...note, source: { workspaceId: b.workspaceId, snapshotId: b.id, itemId: file.itemId, revision: file.revision, fileId: file.id, edition: file.edition, sourceHash: file.sourceHash }, anchor: { kind: 'document', documentId: file.id, page: 1 } };
    expect(resolveCommentSource(comment, [a, b]).attachment?.id).toBe(file.id);
    expect(() => resolveCommentSource({ ...comment, source: { ...comment.source, edition: '2' } }, [a, b])).toThrow('unavailable');
    expect(() => resolveCommentSource({ ...comment, source: { ...comment.source, sourceHash: undefined } }, [a, b])).toThrow('unavailable');
  });
});
