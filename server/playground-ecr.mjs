/**
 * Server-only integration seam for a future verified Arena write-MCP binding.
 * Not mounted as an HTTP route. No Arena endpoint/tool name is assumed here.
 * Requires a durable journal and provider-enforced idempotency before enabling.
 */
import { createHash } from 'node:crypto';
import { abortable } from './playground-provider.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = (value, maximum = 512) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const filename = value => text(value, 160) && !/[\\/]/.test(value) && !['.', '..'].includes(value);
const mimeTypes = new Set(['image/png', 'image/jpeg', 'application/json', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/markdown', 'text/plain']);
const required = ['authorize', 'validateReview', 'findDraft', 'createDraft', 'setAffectedItems', 'attachFile', 'readDraft'];
export class EcrIntegrationError extends Error {
  constructor(code) { super(code); this.name = 'EcrIntegrationError'; this.code = code; }
}

function normalizeFiles(review, incoming) {
  if (!Array.isArray(incoming) || incoming.length > 12) throw new EcrIntegrationError('INVALID_ATTACHMENTS');
  const files = incoming.map(file => {
    if (!file || !filename(file.name) || !mimeTypes.has(file.mimeType) || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength > 12 * 1024 * 1024) throw new EcrIntegrationError('INVALID_ATTACHMENTS');
    return { name: file.name, mimeType: file.mimeType, bytes: Buffer.from(file.bytes), sha256: hash(file.bytes) };
  });
  if (new Set(files.map(file => file.name)).size !== files.length) throw new EcrIntegrationError('INVALID_ATTACHMENTS');
  if (!Array.isArray(review.captures) || review.captures.length > 3 || !Array.isArray(review.manifest.attachments) || review.manifest.attachments.length !== files.length) throw new EcrIntegrationError('INVALID_ATTACHMENTS');
  for (const declared of review.manifest.attachments) {
    const actual = files.find(file => file.name === declared.name);
    if (!actual || declared.byteLength !== actual.bytes.byteLength || declared.mimeType !== actual.mimeType || declared.sha256 !== actual.sha256) throw new EcrIntegrationError('ATTACHMENT_CHANGED');
  }
  for (const capture of review.captures) {
    if (!filename(capture.name) || files.some(file => file.name === capture.name) || typeof capture.imageDataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(capture.imageDataUrl)) throw new EcrIntegrationError('INVALID_ATTACHMENTS');
    const bytes = Buffer.from(capture.imageDataUrl.split(',')[1], 'base64');
    if (bytes.byteLength > 2 * 1024 * 1024) throw new EcrIntegrationError('INVALID_ATTACHMENTS');
    files.push({ name: capture.name, mimeType: capture.imageDataUrl.startsWith('data:image/png;') ? 'image/png' : 'image/jpeg', bytes, sha256: hash(bytes) });
  }
  if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > 24 * 1024 * 1024) throw new EcrIntegrationError('INVALID_ATTACHMENTS');
  return files;
}

function verifyReadback(record, context, review, files, origins, draftId) {
  let url;
  try { url = new URL(record.url); } catch { throw new EcrIntegrationError('READBACK_MISMATCH'); }
  if (record.id !== draftId || record.workspaceId !== context.workspaceId || record.status !== 'draft' || !text(record.number, 100) || record.title !== review.manifest.title || record.description !== review.manifest.description || url.protocol !== 'https:' || url.username || url.password || !origins.includes(url.origin)) throw new EcrIntegrationError('READBACK_MISMATCH');
  if (!Array.isArray(record.affectedItems) || !Array.isArray(record.attachments)) throw new EcrIntegrationError('READBACK_MISMATCH');
  const requested = review.manifest.affectedItems.map(item => JSON.stringify([item.itemId, item.revision])).sort();
  const actual = record.affectedItems.map(item => JSON.stringify([item.itemId, item.revision])).sort();
  if (JSON.stringify(requested) !== JSON.stringify(actual)) throw new EcrIntegrationError('READBACK_MISMATCH');
  for (const file of files) if (!record.attachments.some(attachment => attachment.name === file.name && attachment.sha256 === file.sha256)) throw new EcrIntegrationError('READBACK_MISMATCH');
  return url.href;
}

/**
 * provider methods are viewer-owned contracts, mapped by an administrator to verified MCP tools.
 * journal.runExclusive/get/put must be durable, atomic and shared across server instances.
 * findDraft/createDraft and attachFile must implement the supplied operation keys idempotently.
 */
export function createEcrDraftService({ provider, journal, arenaOrigins, timeoutMs = 120_000 }) {
  if (provider?.verifiedEcrBindings !== true || required.some(method => typeof provider[method] !== 'function')) throw new EcrIntegrationError('UNCONFIGURED_BINDINGS');
  if (!journal || ['runExclusive', 'get', 'put'].some(method => typeof journal[method] !== 'function') || journal.durable !== true) throw new EcrIntegrationError('DURABLE_JOURNAL_REQUIRED');
  if (!Array.isArray(arenaOrigins) || !arenaOrigins.length || arenaOrigins.some(origin => { try { const u = new URL(origin); return u.origin !== origin || u.protocol !== 'https:' || u.username || u.password; } catch { return true; } })) throw new EcrIntegrationError('INVALID_ARENA_ORIGINS');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) throw new EcrIntegrationError('INVALID_TIMEOUT');
  return {
    async createDraft(request, review, attachments, { idempotencyKey, signal } = {}) {
      if (!text(idempotencyKey, 128) || idempotencyKey.length < 16) throw new EcrIntegrationError('INVALID_REQUEST_KEY');
      if (review?.formatVersion !== 1 || review.kind !== 'playground-ecr-review' || review.manifest?.source?.sourceMode !== 'arena' || !/^[a-f0-9]{64}$/.test(review.digest)) throw new EcrIntegrationError('INVALID_REVIEW');
      const payload = JSON.stringify([review.manifest, review.captures]);
      if (Buffer.byteLength(payload) > 12 * 1024 * 1024 || hash(payload) !== review.digest) throw new EcrIntegrationError('REVIEW_CHANGED');
      review = structuredClone(review);
      const files = normalizeFiles(review, attachments);
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new DOMException('ECR deadline', 'TimeoutError')), timeoutMs);
      const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const call = (method, ...args) => { combined.throwIfAborted(); return abortable(Promise.resolve(provider[method](...args, { signal: combined })), combined); };
      try {
        const context = await call('authorize', request);
        if (!text(context?.userId) || context.workspaceId !== review.manifest.source.workspaceId || !text(context.connectionId, 128) || context.connectionId !== request.headers?.['x-viewer-connection']) throw new EcrIntegrationError('AUTHORIZATION_FAILED');
        // The binding must resolve exact sources, validate all schema/content, and confirm draft/write/upload rights.
        if (await call('validateReview', context, { review, files }) !== true) throw new EcrIntegrationError('AUTHORIZATION_FAILED');
        const journalKey = hash(JSON.stringify([context.workspaceId, context.userId, idempotencyKey]));
        return await abortable(journal.runExclusive(journalKey, async () => {
          let checkpoint = await journal.get(journalKey);
          if (checkpoint && checkpoint.digest !== review.digest) throw new EcrIntegrationError('REQUEST_KEY_REUSED');
          if (!checkpoint) { checkpoint = { digest: review.digest, draftId: null, completed: [] }; await journal.put(journalKey, checkpoint); }
          if (!checkpoint.draftId) {
            // Finding by the same key resolves a lost create response without blindly creating another request.
            const found = await call('findDraft', context, { requestKey: journalKey, digest: review.digest });
            const draft = found ?? await call('createDraft', context, { requestKey: journalKey, digest: review.digest, title: review.manifest.title, description: review.manifest.description });
            if (!text(draft?.id) || draft.digest !== review.digest) throw new EcrIntegrationError('CREATE_NOT_VERIFIED');
            checkpoint = { ...checkpoint, draftId: draft.id }; await journal.put(journalKey, checkpoint);
          }
          const draftId = checkpoint.draftId;
          if (!checkpoint.completed.includes('items')) {
            await call('setAffectedItems', context, { draftId, items: review.manifest.affectedItems, requestKey: `${journalKey}:items` });
            checkpoint = { ...checkpoint, completed: [...checkpoint.completed, 'items'] }; await journal.put(journalKey, checkpoint);
          }
          for (const file of files) {
            const step = `file:${file.sha256}:${file.name}`;
            if (checkpoint.completed.includes(step)) continue;
            await call('attachFile', context, { draftId, file, requestKey: hash(`${journalKey}:${step}`) });
            checkpoint = { ...checkpoint, completed: [...checkpoint.completed, step] }; await journal.put(journalKey, checkpoint);
          }
          const record = await call('readDraft', context, { draftId });
          const url = verifyReadback(record, context, review, files, arenaOrigins, draftId);
          const receipt = { mode: 'arena', id: record.id, number: record.number, status: 'draft', proposalId: review.manifest.proposalId, proposalVersion: review.manifest.proposalVersion, digest: review.digest, createdAt: checkpoint.receipt?.createdAt ?? new Date().toISOString(), affectedItems: structuredClone(review.manifest.affectedItems), attachmentNames: files.map(file => file.name), url, message: 'Draft ECR, affected items and attachments were read back from the authorized Arena workspace.' };
          await journal.put(journalKey, { ...checkpoint, receipt });
          return receipt;
        }), combined);
      } catch (error) {
        if (error instanceof EcrIntegrationError) throw error;
        throw new EcrIntegrationError(combined.aborted ? 'REQUEST_INTERRUPTED' : 'UPSTREAM_ERROR');
      } finally { clearTimeout(timer); }
    },
  };
}
