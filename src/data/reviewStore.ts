import type { ReviewAnchor, ReviewComment, ReviewDocument, SavedReviewView, SourceReference } from '../domain';

export class ReviewStorageError extends Error { override name = 'ReviewStorageError'; }
export class ReviewConflictError extends ReviewStorageError { override name = 'ReviewConflictError'; }
export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }
/** Capture only after a failed load; a backup may replace exactly these corrupt bytes. */
export interface ReviewRecoveryToken { readonly workspaceId: string; readonly rawValue: string; }
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_COMMENTS = 2000;
const MAX_VIEWS = 100;
const MAX_TEXT = 10000;

/** Local preview persistence. Revision checks detect stale editors; they are not a server transaction. */
export class LocalReviewStore {
  readonly key: string;
  constructor(readonly workspaceId: string, private readonly storage: StoragePort = localStorage) {
    if (!workspaceId) throw new ReviewStorageError('A workspace is required for review storage.');
    this.key = `assembly-review:v1:${workspaceId}`;
  }
  load(): ReviewDocument {
    let raw: string | null;
    try { raw = this.storage.getItem(this.key); } catch { throw new ReviewStorageError('Browser storage is unavailable. Review changes cannot be persisted.'); }
    if (raw === null) return emptyReview(this.workspaceId);
    return parseReview(raw, this.workspaceId);
  }
  save(next: ReviewDocument, expectedRevision: number): ReviewDocument {
    const current = this.load();
    if (current.revision !== expectedRevision) throw new ReviewConflictError('This review changed in another tab. Reload the review before saving; your draft has not been applied.');
    if (next.workspaceId !== this.workspaceId || next.formatVersion !== 1) throw new ReviewStorageError('Review workspace or format does not match this store.');
    const result: ReviewDocument = { ...next, formatVersion: 1, workspaceId: this.workspaceId, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    let raw: string;
    try { raw = JSON.stringify(result); } catch { throw new ReviewStorageError('Review contains values that cannot be serialized. Existing data was preserved.'); }
    const checked = parseReview(raw, this.workspaceId);
    try { this.storage.setItem(this.key, raw); } catch { throw new ReviewStorageError('Review could not be saved. Browser storage may be full or disabled. Export your review to keep a copy.'); }
    return checked;
  }
  export(): string { return JSON.stringify(this.load(), null, 2); }
  import(json: string, expectedRevision: number): ReviewDocument {
    const incoming = parseReview(json, this.workspaceId);
    return this.save(incoming, expectedRevision);
  }
  captureRecovery(): ReviewRecoveryToken | null {
    let raw: string | null;
    try { raw = this.storage.getItem(this.key); } catch { throw new ReviewStorageError('Browser storage is unavailable. The existing review cannot be inspected or replaced.'); }
    if (raw === null) return null;
    try { parseReview(raw, this.workspaceId); return null; }
    catch { return { workspaceId: this.workspaceId, rawValue: raw }; }
  }
  /** Explicit recovery, never automatic initialization or an unconditional import overwrite. */
  recoverFromBackup(json: string, token: ReviewRecoveryToken): ReviewDocument {
    const incoming = parseReview(json, this.workspaceId);
    if (token.workspaceId !== this.workspaceId) throw new ReviewStorageError('This recovery belongs to a different workspace.');
    const current = this.captureRecovery();
    if (!current || current.rawValue !== token.rawValue) throw new ReviewConflictError('The saved review changed after the recovery warning. Reload before importing; the existing data was preserved.');
    const recovered: ReviewDocument = { ...incoming, revision: 1, updatedAt: new Date().toISOString() };
    const raw = JSON.stringify(recovered);
    const checked = parseReview(raw, this.workspaceId);
    try { this.storage.setItem(this.key, raw); }
    catch { throw new ReviewStorageError('The backup could not be restored. Browser storage may be full or disabled. The original saved data was preserved.'); }
    return checked;
  }
  reset(expectedRevision: number): ReviewDocument { return this.save(emptyReview(this.workspaceId), expectedRevision); }
}
export function emptyReview(workspaceId: string): ReviewDocument {
  return { formatVersion: 1, workspaceId, revision: 0, updatedAt: new Date().toISOString(), comments: [], views: [] };
}
export function parseReview(json: string, workspaceId: string): ReviewDocument {
  if (new TextEncoder().encode(json).length > MAX_BYTES) throw new ReviewStorageError('Review data exceeds the 2 MB preview limit.');
  let value: unknown;
  try {
    value = JSON.parse(json, (key, item) => { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Reserved key'); return item; });
  } catch { throw new ReviewStorageError('Review data is not valid JSON. Existing data was preserved.'); }
  if (!record(value) || value.formatVersion !== 1) throw new ReviewStorageError('Unsupported review format. Expected version 1.');
  if (value.workspaceId !== workspaceId) throw new ReviewStorageError('This review belongs to a different workspace.');
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !isDate(value.updatedAt) || !Array.isArray(value.comments) || !Array.isArray(value.views)) throw new ReviewStorageError('Review data is missing required fields.');
  if (value.comments.length > MAX_COMMENTS || value.views.length > MAX_VIEWS) throw new ReviewStorageError('Review data exceeds preview record limits.');
  const ids = new Set<string>();
  for (const comment of value.comments) {
    if (!validComment(comment, workspaceId) || ids.has(comment.id)) throw new ReviewStorageError('Review contains an invalid or duplicate comment.');
    ids.add(comment.id);
  }
  for (const view of value.views) {
    if (!validView(view, workspaceId) || ids.has(view.id)) throw new ReviewStorageError('Review contains an invalid or duplicate saved view.');
    ids.add(view.id);
  }
  return value as unknown as ReviewDocument;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max = MAX_TEXT): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function isDate(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }
function validSource(value: unknown, workspaceId: string): value is SourceReference {
  return record(value) && value.workspaceId === workspaceId && text(value.snapshotId, 500) && text(value.itemId, 500) && text(value.revision, 100)
    && ['fileId', 'edition', 'sourceHash'].every(key => value[key] === undefined || text(value[key], 500));
}
function validAnchor(value: unknown): value is ReviewAnchor {
  if (!record(value)) return false;
  if (value.kind === 'general') return true;
  if (value.kind === 'model') return text(value.occurrenceId, 500) && value.units === 'mm' && (value.localPoint === undefined || Array.isArray(value.localPoint) && value.localPoint.length === 3 && value.localPoint.every(n => typeof n === 'number' && Number.isFinite(n)));
  if (value.kind === 'document') return text(value.documentId, 500)
    && (value.page === undefined || Number.isInteger(value.page) && Number(value.page) > 0)
    && (value.quote === undefined || text(value.quote))
    && (value.rectangle === undefined || Array.isArray(value.rectangle) && value.rectangle.length === 4 && value.rectangle.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1));
  return false;
}
function validComment(value: unknown, workspaceId: string): value is ReviewComment {
  if (!record(value) || !text(value.id, 200) || !text(value.body) || !text(value.author, 200) || !isDate(value.createdAt) || !isDate(value.updatedAt) || !['open', 'resolved'].includes(String(value.status)) || !validSource(value.source, workspaceId) || !validAnchor(value.anchor) || !Array.isArray(value.replies) || value.replies.length > 200) return false;
  const ids = new Set<string>();
  for (const reply of value.replies) {
    if (!record(reply) || !text(reply.id, 200) || ids.has(reply.id) || !text(reply.body) || !text(reply.author, 200) || !isDate(reply.createdAt)) return false;
    ids.add(reply.id);
  }
  return true;
}
function validView(value: unknown, workspaceId: string): value is SavedReviewView {
  return record(value) && text(value.id, 200) && text(value.name, 160) && isDate(value.createdAt) && validSource(value.source, workspaceId) && record(value.state);
}

/** A pin only reappears on the source configuration it was created against. */
export function commentsForSnapshot(review: ReviewDocument, snapshotId: string): ReviewComment[] {
  return review.comments.filter(comment => comment.source.snapshotId === snapshotId);
}
