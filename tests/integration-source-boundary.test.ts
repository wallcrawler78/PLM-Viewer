import { describe, expect, it } from 'vitest';
import manifest from '../public/fixtures/manifest.json';
import type { Attachment, ReviewComment } from '../src/domain';
import { attachmentIdentityKey, resolveAttachmentReference, toAttachmentReference, validateAttachment, validateSnapshot } from '../src/domain';
import { PreviewAdapter } from '../src/data/previewAdapter';
import { resolveCommentSource } from '../src/data/reviewSource';
import { ArenaAdapter, parseArenaLaunchContext } from '../src/integrations/arenaAdapter';
import { parseViewerState, resolveViewDocuments } from '../src/view-state';

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const preview = () => new PreviewAdapter('precision', async () => response(manifest));
const transport = (body: unknown): typeof fetch => async input => response(String(input).includes('/status?') ? { configured: true, provider: 'arena', workspaceId: 'preview-precision' } : body);
const adapter = (body: unknown, configurationId?: string) => new ArenaAdapter({ workspaceId: 'preview-precision', itemId: 'assembly', configurationId }, transport(body));
const state = { revision: 'B', mode: 'single', selectedIds: [], hiddenIds: [], loadedIds: [], opacityById: {}, explode: 0, section: { enabled: false, axis: 'z', offset: 0 }, documentId: 'file', pinned: true, panelOpen: false };

describe('exact attachment identity and saved source references', () => {
  it('rejects non-scalar imported enum values before they reach renderer controls', () => {
    for (const [field, value] of [['revision', ['B']], ['mode', ['single']], ['panel', ['reference']], ['workspaceView', ['documents']]]) {
      expect(() => parseViewerState({ ...state, [String(field)]: value }), String(field)).toThrow();
    }
    expect(() => parseViewerState({ ...state, section: { ...state.section, enabled: true, axis: ['z'] } })).toThrow('section plane');
    expect(() => parseViewerState({ ...state, section: { ...state.section, axis: { toString: () => 'z' } } })).toThrow('section plane');
  });

  it('distinguishes editions sharing a file GUID while ignoring delivery URL rotation', async () => {
    const file = (await preview().loadBom('B')).documents[0];
    const next = { ...file, edition: '2', sourceHash: 'new-content' };
    expect(attachmentIdentityKey(file)).not.toBe(attachmentIdentityKey(next));
    expect(attachmentIdentityKey(file)).toBe(attachmentIdentityKey({ ...file, url: '/rotated-delivery-url' } as Attachment));
    expect(resolveAttachmentReference(toAttachmentReference(file), [next, file])).toBe(file);
    expect(resolveAttachmentReference(toAttachmentReference(next), [file, next])).toBe(next);
    expect(() => resolveAttachmentReference(toAttachmentReference(file), [next])).toThrow('No other edition');
    expect(() => resolveAttachmentReference(toAttachmentReference(file), [file, { ...file }])).toThrow('ambiguous');
  });

  it('retains a pinned document and baseline reference in saved views and rejects incomplete identities', async () => {
    const file = (await preview().loadBom('B')).documents[0];
    const baseline = { ...file, revision: 'A', edition: '1', sourceHash: 'baseline-content' };
    const view = { ...state, documentId: file.id, documentSource: toAttachmentReference(file), documentBaselineSource: toAttachmentReference(baseline) };
    expect(parseViewerState(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(() => parseViewerState({ ...view, documentSource: { ...view.documentSource, sourceHash: undefined } })).toThrow('exact file');
    expect(() => parseViewerState({ ...view, documentId: 'another-file' })).toThrow('does not match');
    expect(() => parseViewerState({ ...view, documentBaselineSource: { ...view.documentBaselineSource, kind: ['pdf'] } })).toThrow('format');
    expect(() => parseViewerState({ ...view, documentSource: null })).toThrow('declares no document');
  });

  it('resolves saved exact sources before restore and preserves an intentionally empty baseline', async () => {
    const api = preview(), a = await api.loadBom('A'), b = await api.loadBom('B');
    const document = b.documents.find(file => file.id === 'atlas-spec-B-pdf')!, baseline = a.documents.find(file => file.id === 'atlas-spec-A-pdf')!;
    const saved = parseViewerState({ ...state, documentId: document.id, documentSource: toAttachmentReference(document), documentBaselineSource: toAttachmentReference(baseline), documentCompare: false });
    expect(resolveViewDocuments(saved, [...a.documents, ...b.documents])).toEqual({ document, baseline, legacy: false });
    expect(resolveViewDocuments({ ...saved, documentBaselineSource: null }, b.documents).baseline).toBeNull();
    expect(() => resolveViewDocuments(saved, b.documents)).toThrow('original document edition');
    expect(() => resolveViewDocuments({ ...saved, documentBaselineSource: toAttachmentReference(document) }, b.documents)).toThrow('different source');
    const unrelated = b.documents.find(file => file.itemId === 'base')!;
    expect(() => resolveViewDocuments({ ...saved, documentBaselineSource: toAttachmentReference(unrelated) }, [...a.documents, ...b.documents])).toThrow('same item');
    expect(resolveViewDocuments(parseViewerState({ ...state, documentId: null, documentSource: null, documentBaselineSource: null }), []).document).toBeNull();
  });

  it('opens an older ID-only saved view only when its available source is unambiguous', async () => {
    const file = (await preview().loadBom('B')).documents[0];
    const legacy = parseViewerState({ ...state, documentId: file.id });
    const rotated = { ...file, url: '/new-signed-delivery-url' };
    expect(resolveViewDocuments(legacy, [file, rotated])).toEqual({ document: rotated, baseline: null, legacy: true });
    expect(() => resolveViewDocuments(legacy, [file, { ...file, edition: '2', sourceHash: 'new-content' }])).toThrow('unique document edition');
    expect(() => resolveViewDocuments(legacy, [])).toThrow('unavailable');
  });

  it('locates a note by its full edition and hash when the same GUID occurs twice', async () => {
    const snapshot = await preview().loadBom('B');
    const original = snapshot.documents[0];
    const later = { ...original, edition: '2', sourceHash: 'later-content' };
    snapshot.documents.unshift(later);
    const comment: ReviewComment = { id: 'note', body: 'Check this exact edition.', author: 'Preview reviewer', createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z', status: 'open', replies: [],
      source: { workspaceId: snapshot.workspaceId, snapshotId: snapshot.id, itemId: original.itemId, revision: original.revision, fileId: original.id, edition: original.edition, sourceHash: original.sourceHash },
      anchor: { kind: 'document', documentId: original.id, page: 1 } };
    expect(resolveCommentSource(comment, [snapshot]).attachment).toBe(original);
    snapshot.documents = [later];
    expect(() => resolveCommentSource(comment, [snapshot])).toThrow('unavailable');
  });
});

describe('adapter source metadata boundary', () => {
  it('rejects incomplete file metadata before a reader can use it', async () => {
    const snapshot = await preview().loadBom('B');
    for (const field of ['id', 'name', 'kind', 'edition', 'sourceHash']) {
      const broken = { ...snapshot.documents[0], [field]: undefined };
      expect(() => validateAttachment(broken), field).toThrow();
      expect(() => validateSnapshot({ ...snapshot, documents: [broken] } as never), field).toThrow();
      await expect(adapter([broken]).listAttachments(broken.itemId, broken.revision)).rejects.toThrow();
    }
    await expect(adapter([null]).listAttachments('assembly', 'B')).rejects.toThrow('attachment metadata');
  });

  it('permits separate editions but refuses duplicate exact identities', async () => {
    const snapshot = await preview().loadBom('B');
    const file = snapshot.documents.find(file => file.itemId === 'assembly')!;
    const files = [file, { ...file, edition: '2', sourceHash: 'second-edition' }];
    expect(validateSnapshot({ ...snapshot, documents: files }).documents).toEqual(files);
    expect(await adapter(files).listAttachments(file.itemId, file.revision)).toEqual(files);
    expect(() => validateSnapshot({ ...snapshot, documents: [file, file] })).toThrow('unique');
    await expect(adapter([file, file]).listAttachments(file.itemId, file.revision)).rejects.toThrow('duplicate');
  });

  it('rejects a substituted frozen configuration even when item and revision match', async () => {
    const snapshot = await preview().loadBom('B');
    await expect(adapter(snapshot, 'another-frozen-configuration').loadBom('B')).rejects.toThrow('different frozen configuration');
    expect((await adapter(snapshot, snapshot.configurationId).loadBom('B')).id).toBe(snapshot.id);
  });

  it('rejects paths browsers normalize into another origin before any network request', () => {
    for (const baseUrl of ['/\\outside.example', '/\t/outside.example', '//outside.example', 'https://outside.example', '/api#fragment', '/api?query=1']) {
      expect(() => new ArenaAdapter({ workspaceId: 'w', itemId: 'i', baseUrl }), baseUrl).toThrow('same-origin');
    }
    expect(() => new ArenaAdapter({ workspaceId: 'w', itemId: 'i', baseUrl: '/api/viewer/v1/' })).not.toThrow();
  });

  it('never silently drops ambiguous or oversized context from the legacy Arena launcher', () => {
    const prefix = '?mode=arena&workspaceId=w&itemId=i';
    expect(parseArenaLaunchContext(`${prefix}&revision=B&fileId=f&parentItemId=parent`)).toEqual({ mode: 'arena', workspaceId: 'w', itemId: 'i', revision: 'B', fileId: 'f', parentItemId: 'parent' });
    expect(parseArenaLaunchContext('?mode=preview')).toBeNull();
    for (const parameter of ['revision', 'fileId', 'parentItemId']) {
      expect(() => parseArenaLaunchContext(`${prefix}&${parameter}=one&${parameter}=two`), parameter).toThrow();
      expect(() => parseArenaLaunchContext(`${prefix}&${parameter}=${'x'.repeat(201)}`), parameter).toThrow();
      expect(() => parseArenaLaunchContext(`${prefix}&${parameter}=%20%00`), parameter).toThrow();
    }
    expect(() => parseArenaLaunchContext('?mode=preview&mode=arena&workspaceId=w&itemId=i')).toThrow('more than one mode');
  });
});
