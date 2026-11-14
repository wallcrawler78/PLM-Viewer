import { createHash, timingSafeEqual } from 'node:crypto';
import { ViewerError, identityText } from './errors.mjs';

export const CONTENT_ROUTE = '/api/viewer/v1/content';
export const CONTENT_KINDS = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  step: 'model/step',
  mesh: 'application/json',
});
export const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const SOURCE_FIELDS = ['itemId', 'revision', 'fileId', 'edition', 'sourceHash', 'kind'];

export function validateContentIdentity(input, code = 'BAD_REQUEST') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ViewerError(code);
  const identity = {};
  for (const key of SOURCE_FIELDS) identity[key] = identityText(input[key], key === 'revision' ? 100 : 512, code);
  if (!Object.hasOwn(CONTENT_KINDS, identity.kind) || !/^[a-f0-9]{64}$/.test(identity.sourceHash)) throw new ViewerError(code);
  if (input.contentHash !== undefined) {
    if (typeof input.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentHash)) throw new ViewerError(code);
    identity.contentHash = input.contentHash;
  }
  if (identity.kind === 'mesh' && !identity.contentHash) throw new ViewerError(code);
  if (identity.kind !== 'mesh' && identity.contentHash && identity.contentHash !== identity.sourceHash) throw new ViewerError(code);
  return Object.freeze(identity);
}

/** Same-origin URL only. connectionId is an opaque identity generation, never a credential. */
export function buildContentUrl(context, source) {
  const identity = validateContentIdentity(source, 'UPSTREAM_ERROR');
  const workspaceId = identityText(context?.workspaceId, 512, 'UPSTREAM_ERROR');
  const connectionId = identityText(context?.connectionId, 128, 'UPSTREAM_ERROR');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(connectionId)) throw new ViewerError('UPSTREAM_ERROR');
  return `${CONTENT_ROUTE}?${new URLSearchParams({ workspaceId, ...identity, connectionId })}`;
}

export function assertProtectedContentUrl(value, context, expected) {
  if (typeof value !== 'string' || !value.startsWith(`${CONTENT_ROUTE}?`) || /[\\\s#]/.test(value)) throw new ViewerError('UPSTREAM_ERROR');
  const url = new URL(value, 'https://viewer.invalid');
  if (url.origin !== 'https://viewer.invalid' || url.pathname !== CONTENT_ROUTE) throw new ViewerError('UPSTREAM_ERROR');
  const allowed = new Set(['workspaceId', ...SOURCE_FIELDS, 'contentHash', 'connectionId']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new ViewerError('UPSTREAM_ERROR');
  const source = validateContentIdentity(Object.fromEntries(url.searchParams), 'UPSTREAM_ERROR');
  if (url.searchParams.get('workspaceId') !== context.workspaceId || url.searchParams.get('connectionId') !== context.connectionId) throw new ViewerError('UPSTREAM_ERROR');
  if (expected) for (const [key, value] of Object.entries(expected)) if (source[key] !== value) throw new ViewerError('SOURCE_CHANGED');
  return value;
}

/** Validate complete bytes before delivery; do not stream an unverified edition to a reader. */
export function validateContentResult(result, requested, maxBytes = MAX_CONTENT_BYTES) {
  const expected = validateContentIdentity(requested);
  const actual = validateContentIdentity(result?.identity, 'UPSTREAM_ERROR');
  if ([...SOURCE_FIELDS, 'contentHash'].some(key => actual[key] !== expected[key])) throw new ViewerError('SOURCE_CHANGED');
  if (!(result.bytes instanceof Uint8Array)) throw new ViewerError('UPSTREAM_ERROR');
  if (!result.bytes.byteLength || result.bytes.byteLength > maxBytes) throw new ViewerError('CONTENT_TOO_LARGE');
  const bytes = Buffer.from(result.bytes);
  const wantedHash = Buffer.from(expected.contentHash ?? expected.sourceHash, 'hex');
  const actualHash = createHash('sha256').update(bytes).digest();
  if (!timingSafeEqual(actualHash, wantedHash)) throw new ViewerError('SOURCE_CHANGED');
  const contentType = typeof result.contentType === 'string' ? result.contentType.toLowerCase().split(';')[0].trim() : '';
  const acceptedStepMime = expected.kind === 'step' && ['model/step', 'application/step', 'application/octet-stream', 'text/plain'].includes(contentType);
  if (contentType !== CONTENT_KINDS[expected.kind] && !acceptedStepMime) throw new ViewerError('UPSTREAM_ERROR');
  // Prevent mislabeled HTML or obvious format swaps even when a normalizer supplied a hash.
  if (expected.kind === 'pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new ViewerError('UPSTREAM_ERROR');
  if (expected.kind === 'docx' && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new ViewerError('UPSTREAM_ERROR');
  if (expected.kind === 'doc' && !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw new ViewerError('UPSTREAM_ERROR');
  if (expected.kind === 'step' && !bytes.subarray(0, 4096).includes(Buffer.from('ISO-10303-21;'))) throw new ViewerError('UPSTREAM_ERROR');
  if (expected.kind === 'mesh') {
    try { if (!JSON.parse(bytes.toString('utf8')) || bytes.includes(0)) throw new Error(); }
    catch { throw new ViewerError('UPSTREAM_ERROR'); }
  }
  const name = result.name === undefined ? `source.${expected.kind === 'mesh' ? 'json' : expected.kind}` : identityText(result.name, 512, 'UPSTREAM_ERROR');
  return { identity: actual, bytes, contentType: CONTENT_KINDS[expected.kind], name };
}
