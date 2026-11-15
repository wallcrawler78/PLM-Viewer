import type { Attachment, BomSnapshot } from './domain';

export type WorkspaceView = 'documents' | 'model' | 'together';
export interface LaunchContext {
  mode: 'preview' | 'arena';
  workspaceId?: string;
  itemId?: string;
  /** Revision of the requested item/file, which can differ from its parent BOM. */
  revision?: string;
  fileId?: string;
  /** Exact file edition and SHA-256 pin. A launch that carries them must open that source or fail. */
  edition?: string;
  sourceHash?: string;
  view?: WorkspaceView;
  compare?: boolean;
}
export interface PreviewLaunch {
  snapshot: BomSnapshot;
  file: Attachment | null;
  workspaceView: WorkspaceView;
  selectedIds: string[];
  compare: boolean;
}

export class LaunchContextError extends Error { override name = 'LaunchContextError'; }

/** Parse only viewer-owned launch parameters; unknown integration metadata is ignored.
 * An edition or source hash is an exact-source pin and is never ignored. */
export function parseLaunchContext(search: string): LaunchContext {
  if (search.length > 8192) throw new LaunchContextError('The viewer launch URL is too long. Open the attachment again from its item.');
  const params = new URLSearchParams(search);
  function value(key: string): string | undefined {
    const values = params.getAll(key);
    if (values.length > 1) throw new LaunchContextError(`The viewer launch contains more than one ${key}. Open the attachment again from its item.`);
    if (!values.length) return undefined;
    const result = values[0];
    if (!result || result !== result.trim() || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) throw new LaunchContextError(`The viewer launch has an invalid ${key}.`);
    return result;
  }
  const mode = value('mode') ?? 'preview';
  if (mode !== 'preview' && mode !== 'arena') throw new LaunchContextError('The viewer launch mode is unsupported. Use Preview or a configured Arena launch.');
  const result: LaunchContext = { mode };
  for (const key of ['workspaceId', 'itemId', 'revision', 'fileId', 'edition', 'sourceHash'] as const) {
    const found = value(key);
    if (found !== undefined) result[key] = found;
  }
  if (result.sourceHash !== undefined && !/^[a-f0-9]{64}$/.test(result.sourceHash)) throw new LaunchContextError('The viewer launch has an invalid sourceHash. Use the exact lowercase SHA-256 of the source file.');
  const view = value('view');
  if (view !== undefined) {
    if (!['documents', 'model', 'together'].includes(view)) throw new LaunchContextError('The requested viewer layout is unsupported.');
    result.view = view as WorkspaceView;
  }
  const compare = value('compare');
  if (compare !== undefined) {
    if (!['true', 'false', '1', '0'].includes(compare)) throw new LaunchContextError('The comparison launch option is invalid.');
    result.compare = compare === 'true' || compare === '1';
  }
  return result;
}

/** Synthetic fixture identities only. Real providers must supply their source file GUIDs. */
export function previewModelFileId(itemId: string, revision: string): string {
  return `step:${encodeURIComponent(itemId)}:${encodeURIComponent(revision)}`;
}

function preferredSnapshot(snapshots: BomSnapshot[]): BomSnapshot {
  if (!snapshots.length) throw new LaunchContextError('The requested source is unavailable in this preview. No other revision has been substituted.');
  if (snapshots.length === 1) return snapshots[0];
  // These are the two explicitly supplied synthetic configurations, not a rule
  // for choosing the latest revision of a real PLM object.
  const proposed = snapshots.filter(snapshot => snapshot.revision === 'B');
  if (proposed.length === 1) return proposed[0];
  throw new LaunchContextError('The source belongs to more than one preview configuration. Open an exact file revision.');
}

function relatedDocument(snapshot: BomSnapshot, itemId: string): Attachment | null {
  const documents = snapshot.documents.filter(file => file.itemId === itemId);
  const pdfs = documents.filter(file => file.kind === 'pdf');
  if (pdfs.length === 1) return pdfs[0];
  if (documents.length === 1) return documents[0];
  if (!documents.length) return null;
  throw new LaunchContextError('This item has several possible documents. Open the intended attachment by its file ID.');
}

/** Resolve an exact Preview source. This function never reads or substitutes Arena content. */
export function resolvePreviewLaunch(context: LaunchContext, snapshots: BomSnapshot[]): PreviewLaunch {
  if (context.mode !== 'preview') throw new LaunchContextError('Arena launches require the configured Arena provider. Preview files cannot replace that source.');
  const available = snapshots.filter(snapshot => !context.workspaceId || snapshot.workspaceId === context.workspaceId);
  if (!available.length) throw new LaunchContextError('The requested preview workspace is unavailable.');
  if (new Set(available.map(snapshot => snapshot.workspaceId)).size !== 1 || new Set(available.map(snapshot => snapshot.rootItemId)).size !== 1) throw new LaunchContextError('The launch needs an exact workspace and assembly context.');
  if (new Set(available.map(snapshot => snapshot.id)).size !== available.length) throw new LaunchContextError('Preview configuration identifiers are ambiguous.');

  function finish(snapshot: BomSnapshot, file: Attachment | null, itemId: string, workspaceView: WorkspaceView): PreviewLaunch {
    if (context.compare && !file) throw new LaunchContextError('Open a document before requesting a document revision comparison.');
    return { snapshot, file, workspaceView, selectedIds: snapshot.occurrences.filter(occurrence => occurrence.partId === itemId).map(occurrence => occurrence.id), compare: !!context.compare };
  }
  function checkRequestedIdentity(itemId: string, revision: string, edition: string | undefined, sourceHash: string | undefined) {
    if (context.itemId && context.itemId !== itemId) throw new LaunchContextError('The requested file does not belong to the item in this launch. No different file has been opened.');
    if (context.revision && context.revision !== revision) throw new LaunchContextError('The requested file revision does not match this launch. No newer revision has been substituted.');
    if (context.edition && context.edition !== edition) throw new LaunchContextError('The requested file edition is unavailable in this preview. No other edition has been substituted.');
    if (context.sourceHash && context.sourceHash !== sourceHash) throw new LaunchContextError('The requested source hash does not match this file. No other edition has been substituted.');
  }
  if ((context.edition || context.sourceHash) && !context.fileId) throw new LaunchContextError('A file edition or source hash requires an exact file identifier.');

  if (context.fileId) {
    const documents = available.flatMap(snapshot => snapshot.documents.filter(file => file.id === context.fileId).map(file => ({ snapshot, file })));
    if (documents.length) {
      const file = documents[0].file;
      const identities = new Set(documents.map(({ file: candidate }) => JSON.stringify([candidate.itemId, candidate.revision, candidate.edition, candidate.sourceHash, candidate.kind, candidate.url])));
      if (identities.size !== 1) throw new LaunchContextError('This file ID resolves to conflicting editions. Open an exact source from the item.');
      checkRequestedIdentity(file.itemId, file.revision, file.edition, file.sourceHash);
      if (context.view === 'model') throw new LaunchContextError('A document launch needs the Documents or Together layout.');
      const snapshot = preferredSnapshot(documents.map(candidate => candidate.snapshot));
      return finish(snapshot, file, file.itemId, context.view ?? 'documents');
    }

    const models = available.flatMap(snapshot => [
      ...(snapshot.assemblyStepUrl ? [{ snapshot, itemId: snapshot.rootItemId, revision: snapshot.revision, sourceHash: undefined as string | undefined, identity: snapshot.assemblyStepUrl }] : []),
      ...snapshot.parts.filter(part => !!part.stepUrl && snapshot.occurrences.some(occurrence => occurrence.partId === part.id && occurrence.partRevision === part.revision && occurrence.modelState === 'loaded')).map(part => ({ snapshot, itemId: part.id, revision: part.revision, sourceHash: part.sourceHash as string | undefined, identity: JSON.stringify([part.stepUrl, part.sourceHash]) })),
    ]).filter(model => previewModelFileId(model.itemId, model.revision) === context.fileId);
    if (!models.length) throw new LaunchContextError('The requested file is unavailable in this preview. No other file has been substituted.');
    const model = models[0];
    if (new Set(models.map(candidate => candidate.identity)).size !== 1) throw new LaunchContextError('This model ID resolves to conflicting source editions.');
    // Preview models carry no edition, and the assembly STEP no hash: a pin on either cannot be honoured.
    checkRequestedIdentity(model.itemId, model.revision, undefined, model.sourceHash);
    if (context.view === 'documents') throw new LaunchContextError('A STEP launch needs the 3D or Together layout.');
    const snapshot = preferredSnapshot(models.map(candidate => candidate.snapshot));
    const view = context.view ?? 'model';
    return finish(snapshot, view === 'together' ? relatedDocument(snapshot, model.itemId) : null, model.itemId, view);
  }

  const itemId = context.itemId ?? available[0].rootItemId;
  const candidates = available.filter(snapshot => itemId === snapshot.rootItemId
    ? !context.revision || snapshot.revision === context.revision
    : snapshot.parts.some(part => part.id === itemId && (!context.revision || part.revision === context.revision)));
  const snapshot = preferredSnapshot(candidates);
  const view = context.view ?? (context.itemId ? 'model' : 'documents');
  const file = view === 'model' ? null : relatedDocument(snapshot, itemId);
  if (view === 'documents' && !file) throw new LaunchContextError('This item revision has no viewable document in the preview. Choose its 3D view or open another attachment.');
  return finish(snapshot, file, itemId, view);
}
