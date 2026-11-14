import { attachmentIdentityKey } from './domain';
import type { DocumentAnchor, DocumentFile } from './components/Documents';

/** Legacy anchors may lack item/hash; supplied source fields must always match. */
export function matchesDocumentAnchor(anchor: DocumentAnchor | null | undefined, file: DocumentFile): anchor is DocumentAnchor {
  return !!anchor && anchor.fileId === file.id && anchor.revision === file.revision
    && anchor.edition === file.edition && anchor.kind === file.kind
    && (anchor.itemId === undefined || anchor.itemId === file.itemId)
    && (anchor.sourceHash === undefined || anchor.sourceHash === file.sourceHash);
}

/** A file GUID is not a revision/edition identity, and labels do not imply order. */
export function documentComparisonSources(file: DocumentFile, files: readonly DocumentFile[]) {
  const currentKey = attachmentIdentityKey(file);
  const candidates = Array.from(new Map(files
    .filter(candidate => candidate.itemId === file.itemId && candidate.kind === file.kind
      && attachmentIdentityKey(candidate) !== currentKey)
    .map(candidate => [attachmentIdentityKey(candidate), candidate])).values());
  const related = file.seriesId ? candidates.filter(candidate => candidate.seriesId === file.seriesId) : [];
  return { candidates, related, automaticKey: related.length === 1 ? attachmentIdentityKey(related[0]) : '' };
}
