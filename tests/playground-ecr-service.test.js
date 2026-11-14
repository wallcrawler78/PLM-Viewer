import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createEcrDraftService } from '../server/playground-ecr.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const files = [{ name: 'changes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from('synthetic attachment bytes') }];
  const manifest = { source: { workspaceId: 'w', sourceMode: 'arena', snapshotId: 's', revision: 'B' }, proposalId: 'p', proposalVersion: 2, title: 'Move bracket', description: 'Move bracket upward for clearance.', affectedItems: [{ itemId: 'item1', itemNumber: '100-1', revision: 'B', occurrenceIds: ['occ1'] }], attachments: files.map(file => ({ name: file.name, mimeType: file.mimeType, byteLength: file.bytes.length, sha256: sha(file.bytes) })) };
  const review = { formatVersion: 1, kind: 'playground-ecr-review', manifest, captures: [], digest: sha(JSON.stringify([manifest, []])) };
  const entries = new Map();
  // An in-memory durable-store stand-in used only to test the required journal interface.
  const journal = { durable: true, runExclusive: async (_key, operation) => operation(), get: async key => entries.get(key), put: async (key, value) => { entries.set(key, structuredClone(value)); } };
  let draft;
  const provider = {
    verifiedEcrBindings: true,
    authorize: vi.fn(async () => ({ userId: 'u', workspaceId: 'w', connectionId: 'current-connection' })),
    validateReview: vi.fn(async () => true),
    findDraft: vi.fn(async () => draft ? { id: draft.id, digest: review.digest } : null),
    createDraft: vi.fn(async () => { draft = { id: 'ecr1', number: 'ECR-001', status: 'draft', workspaceId: 'w', title: manifest.title, description: manifest.description, affectedItems: [], attachments: [], url: 'https://app.bom.com/change/ecr1' }; return { id: draft.id, digest: review.digest }; }),
    setAffectedItems: vi.fn(async (_context, { items }) => { draft.affectedItems = structuredClone(items); }),
    attachFile: vi.fn(async (_context, { file }) => { if (!draft.attachments.some(value => value.sha256 === file.sha256)) draft.attachments.push({ name: file.name, sha256: file.sha256 }); }),
    readDraft: vi.fn(async () => structuredClone(draft)),
  };
  const service = createEcrDraftService({ provider, journal, arenaOrigins: ['https://app.bom.com'] });
  const req = { headers: { 'x-viewer-connection': 'current-connection' } }, options = { idempotencyKey: 'one-reviewed-request-123' };
  return { files, review, provider, journal, service, req, options, getDraft: () => draft };
}

describe('future trusted ECR binding seam', () => {
  it('requires reviewed bindings and a durable journal; no automatic in-memory live fallback', () => {
    expect(() => createEcrDraftService({ provider: {} })).toThrow('UNCONFIGURED_BINDINGS');
    const { provider } = fixture();
    expect(() => createEcrDraftService({ provider, journal: { durable: false } })).toThrow('DURABLE_JOURNAL_REQUIRED');
  });
  it('creates draft, items, attachments and reads back the real URL; retry reauthorizes and reads back', async () => {
    const f = fixture();
    const first = await f.service.createDraft(f.req, f.review, f.files, f.options);
    const again = await f.service.createDraft(f.req, f.review, f.files, f.options);
    expect(first).toMatchObject({ mode: 'arena', number: 'ECR-001', status: 'draft', url: 'https://app.bom.com/change/ecr1', attachmentNames: ['changes.docx'] });
    expect(again).toEqual(first);
    expect(f.provider.createDraft).toHaveBeenCalledTimes(1);
    expect(f.provider.attachFile).toHaveBeenCalledTimes(1);
    expect(f.provider.authorize).toHaveBeenCalledTimes(2);
    expect(f.provider.readDraft).toHaveBeenCalledTimes(2);
  });
  it('recovers an uncertain create response by finding the same request key', async () => {
    const f = fixture(), create = f.provider.createDraft.getMockImplementation();
    f.provider.createDraft.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('network response lost'); });
    await expect(f.service.createDraft(f.req, f.review, f.files, f.options)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    const receipt = await f.service.createDraft(f.req, f.review, f.files, f.options);
    expect(receipt.number).toBe('ECR-001');
    expect(f.provider.createDraft).toHaveBeenCalledTimes(1);
    expect(f.provider.findDraft).toHaveBeenCalledTimes(2);
  });
  it('blocks changed bytes, revoked access and mismatched readback links without a success receipt', async () => {
    const f = fixture();
    await expect(f.service.createDraft(f.req, f.review, [{ ...f.files[0], bytes: Buffer.from('changed') }], f.options)).rejects.toMatchObject({ code: 'ATTACHMENT_CHANGED' });
    f.provider.validateReview.mockResolvedValueOnce(false);
    await expect(f.service.createDraft(f.req, f.review, f.files, f.options)).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
    expect(f.provider.createDraft).not.toHaveBeenCalled();
    const read = f.provider.readDraft.getMockImplementation();
    f.provider.readDraft.mockImplementationOnce(async () => ({ ...await read(), url: 'https://untrusted.example/ecr1' }));
    await expect(f.service.createDraft(f.req, f.review, f.files, f.options)).rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
  });
  it('rejects reuse of a request key with changed review content', async () => {
    const f = fixture();
    await f.service.createDraft(f.req, f.review, f.files, f.options);
    f.review.manifest.title = 'Different request';
    f.review.digest = sha(JSON.stringify([f.review.manifest, f.review.captures]));
    await expect(f.service.createDraft(f.req, f.review, f.files, f.options)).rejects.toMatchObject({ code: 'REQUEST_KEY_REUSED' });
  });
});
