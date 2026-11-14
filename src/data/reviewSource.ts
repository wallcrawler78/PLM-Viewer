import type { Attachment, BomOccurrence, BomSnapshot, ReviewComment } from '../domain';
import { attachmentIdentityKey, resolvePart } from '../domain';

export class ReviewSourceUnavailableError extends Error { override name = 'ReviewSourceUnavailableError'; }
function sameAttachment(a: Attachment, b: Attachment): boolean {
  return attachmentIdentityKey(a) === attachmentIdentityKey(b);
}

/** Prefer the current assembly when an unchanged child file occurs in several snapshots. */
export function pickSnapshotForAttachment(file: Attachment, current: BomSnapshot, snapshots: BomSnapshot[]): BomSnapshot {
  if (current.documents.some(candidate => sameAttachment(candidate, file))) return current;
  const owner = snapshots.find(snapshot => snapshot.documents.some(candidate => sameAttachment(candidate, file)));
  if (!owner) throw new ReviewSourceUnavailableError('This document edition is not available in the loaded configurations.');
  return owner;
}

export interface LocatedReviewSource { snapshot: BomSnapshot; occurrence?: BomOccurrence; attachment?: Attachment; }
/** Never interpret an old/imported pin against a different source merely because IDs look familiar. */
export function resolveCommentSource(comment: ReviewComment, snapshots: BomSnapshot[]): LocatedReviewSource {
  const unavailable = () => new ReviewSourceUnavailableError('The original source for this note is unavailable or has changed. The note is preserved; load its exact configuration and file edition to locate it.');
  const source = comment.source;
  const snapshot = snapshots.find(candidate => candidate.id === source.snapshotId && candidate.workspaceId === source.workspaceId);
  if (!snapshot) throw unavailable();
  if (comment.anchor.kind === 'model') {
    const occurrenceId = comment.anchor.occurrenceId;
    const occurrence = snapshot.occurrences.find(candidate => candidate.id === occurrenceId);
    const part = occurrence && resolvePart(snapshot, occurrence);
    if (!occurrence || !part || part.id !== source.itemId || part.revision !== source.revision || !source.sourceHash || part.sourceHash !== source.sourceHash) throw unavailable();
    return { snapshot, occurrence };
  }
  if (comment.anchor.kind === 'document') {
    const documentId = comment.anchor.documentId;
    const attachments = snapshot.documents.filter(candidate => candidate.id === documentId && source.fileId === candidate.id && source.itemId === candidate.itemId && source.revision === candidate.revision && source.edition === candidate.edition && !!source.sourceHash && source.sourceHash === candidate.sourceHash);
    if (attachments.length !== 1) throw unavailable();
    const attachment = attachments[0];
    return { snapshot, attachment };
  }
  if (source.itemId !== snapshot.rootItemId || source.revision !== snapshot.revision) throw unavailable();
  return { snapshot };
}
