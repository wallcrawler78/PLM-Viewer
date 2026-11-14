import { attachmentIdentityKey } from '../domain';
import type { Attachment, BomSnapshot, RevisionDescriptor, WorkspaceSchema } from '../domain';
import { parseLaunchContext } from '../launch-context';
import type { WorkspaceView } from '../launch-context';
import { ArenaAdapter, ArenaConfigurationError, parseArenaLaunchContext } from './arenaAdapter';
import type { ViewerServiceStatus } from './arenaAdapter';

export interface LiveWorkspace {
  adapter: ArenaAdapter;
  status: ViewerServiceStatus;
  schema: WorkspaceSchema;
  /** A/B are UI slots, never an assumption about Arena revision labels. */
  snapshots: { A: BomSnapshot; B: BomSnapshot };
  slot: 'A' | 'B';
  hasBaseline: boolean;
  file: Attachment | null;
  selectedIds: string[];
  workspaceView: WorkspaceView;
  compare: boolean;
  revisions: RevisionDescriptor[];
}
export class ArenaRevisionRequired extends ArenaConfigurationError {
  override name = 'ArenaRevisionRequired';
  constructor(readonly revisions: RevisionDescriptor[]) {
    super(revisions.length ? 'Choose an exact Arena revision before opening this item.' : 'No accessible revisions were returned for this item.', 'REVISION_REQUIRED');
  }
}

function extraParameter(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new ArenaConfigurationError(`The Arena launch contains more than one ${key}.`, 'INVALID_CONTEXT');
  if (!values.length) return undefined;
  const value = values[0];
  if (!value || value !== value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new ArenaConfigurationError(`The Arena launch has an invalid ${key}.`, 'INVALID_CONTEXT');
  return value;
}
function requireMcp(status: ViewerServiceStatus): void {
  if (!status.configured) throw new ArenaConfigurationError(status.message ?? 'Arena MCP is not configured. Preview remains available.', 'UNCONFIGURED');
  if (status.transport !== 'mcp' || status.readOnly !== true || !status.connectionId || !status.user?.id) throw new ArenaConfigurationError('Live mode requires the user-bound Arena MCP provider.', 'INVALID_CONFIGURATION');
}
function sameConnection(first: ViewerServiceStatus, next: ViewerServiceStatus): void {
  requireMcp(next);
  if (first.connectionId !== next.connectionId || first.user?.id !== next.user?.id || first.workspaceId !== next.workspaceId) throw new ArenaConfigurationError('The connected Arena user or workspace changed while loading. Reopen this source.', 'CONNECTION_CHANGED');
}
function mergeDocuments(snapshot: BomSnapshot, attachments: Attachment[]): BomSnapshot {
  const files = new Map(snapshot.documents.map(file => [attachmentIdentityKey(file), file]));
  for (const file of attachments) files.set(attachmentIdentityKey(file), file);
  return { ...snapshot, documents: [...files.values()] };
}
function revisionInSnapshot(snapshot: BomSnapshot, itemId: string): string[] {
  return itemId === snapshot.rootItemId ? [snapshot.revision] : [...new Set(snapshot.occurrences.filter(row => row.partId === itemId).map(row => row.partRevision))];
}

/** The only live bootstrap. It never creates a Preview adapter or local review store. */
export async function loadArenaWorkspace(search: string, signal?: AbortSignal, fetcher?: typeof fetch): Promise<LiveWorkspace> {
  const context = parseArenaLaunchContext(search);
  if (!context) throw new ArenaConfigurationError('Use an Arena launch to open live PLM content.', 'INVALID_CONTEXT');
  const launch = parseLaunchContext(search);
  const params = new URLSearchParams(search);
  const configurationId = extraParameter(params, 'configurationId');
  const baselineRevision = extraParameter(params, 'baselineRevision');
  const baselineConfigurationId = extraParameter(params, 'baselineConfigurationId');
  const parentRevision = extraParameter(params, 'parentRevision');
  const edition = extraParameter(params, 'edition');
  const sourceHash = extraParameter(params, 'sourceHash');
  if ((edition || sourceHash) && !context.fileId) throw new ArenaConfigurationError('A file edition or hash requires an exact file identifier.', 'INVALID_CONTEXT');
  if (baselineConfigurationId && !baselineRevision) throw new ArenaConfigurationError('A baseline configuration requires its exact revision.', 'INVALID_CONTEXT');
  const hasParent = !!context.parentItemId && context.parentItemId !== context.itemId;
  if (hasParent && !parentRevision) throw new ArenaConfigurationError('Opening this file within its parent BOM requires the exact parentRevision. No current BOM was substituted.', 'INVALID_CONTEXT');
  if (!hasParent && parentRevision) throw new ArenaConfigurationError('A parentRevision requires a different parent item.', 'INVALID_CONTEXT');
  const rootItemId = hasParent ? context.parentItemId! : context.itemId;
  const makeAdapter = (itemId: string, configuration?: string) => new ArenaAdapter({ workspaceId: context.workspaceId, itemId, configurationId: configuration }, fetcher);
  const adapter = makeAdapter(rootItemId, configurationId);
  const status = await adapter.connectionStatus(signal);
  requireMcp(status);
  if (!context.revision) {
    const selectionAdapter = hasParent ? makeAdapter(context.itemId) : adapter;
    if (selectionAdapter !== adapter) sameConnection(status, await selectionAdapter.connectionStatus(signal));
    throw new ArenaRevisionRequired(await selectionAdapter.listRevisions(signal));
  }
  const rootRevision = hasParent ? parentRevision! : context.revision;
  const [schema, currentSnapshot, revisions] = await Promise.all([
    adapter.loadSchema(signal), adapter.loadBom(rootRevision, signal), adapter.listRevisions(signal),
  ]);
  if (!revisionInSnapshot(currentSnapshot, context.itemId).includes(context.revision)) throw new ArenaConfigurationError('The requested item revision is not present in this exact BOM configuration.', 'UNAVAILABLE');
  let current = mergeDocuments(currentSnapshot, await adapter.listAttachments(context.itemId, context.revision, signal));
  let baseline = current;
  if (baselineRevision) {
    const baselineAdapter = makeAdapter(rootItemId, baselineConfigurationId);
    sameConnection(status, await baselineAdapter.connectionStatus(signal));
    baseline = await baselineAdapter.loadBom(baselineRevision, signal);
    const baselineItemRevisions = revisionInSnapshot(baseline, context.itemId);
    if (baselineItemRevisions.length === 1) baseline = mergeDocuments(baseline, await baselineAdapter.listAttachments(context.itemId, baselineItemRevisions[0], signal));
    sameConnection(status, await baselineAdapter.connectionStatus(signal));
  }
  const hasBaseline = baselineRevision !== undefined && baseline.id !== current.id;
  if (baselineRevision && !hasBaseline && (baseline.revision !== current.revision || baseline.configurationId !== current.configurationId)) throw new ArenaConfigurationError('Different Arena configurations returned the same snapshot identifier.');
  if (!hasBaseline) baseline = current;
  let file: Attachment | null = null;
  let selectedIds = current.occurrences.filter(row => row.partId === context.itemId && row.partRevision === context.revision).map(row => row.id);
  let defaultView: WorkspaceView = current.parts.length ? 'model' : 'documents';
  if (context.fileId) {
    const matchesIdentity = (source: { id: string; itemId: string; revision: string; edition: string; sourceHash: string }) => source.id === context.fileId && source.itemId === context.itemId && source.revision === context.revision && (!edition || source.edition === edition) && (!sourceHash || source.sourceHash === sourceHash);
    const documents = current.documents.filter(matchesIdentity);
    const models = (current.modelSources ?? []).filter(matchesIdentity);
    if (documents.length + models.length !== 1) throw new ArenaConfigurationError(documents.length + models.length ? 'This file has more than one accessible edition. Open the exact file edition and source hash.' : 'The exact requested file is unavailable in this item revision. No other file was substituted.', 'UNAVAILABLE');
    if (documents.length) { file = documents[0]; defaultView = 'documents'; }
    else { selectedIds = models[0].occurrenceIds; defaultView = 'model'; }
  } else if (defaultView === 'documents') {
    const documents = current.documents.filter(document => document.itemId === context.itemId && document.revision === context.revision);
    if (documents.length === 1) file = documents[0];
  }
  if (launch.compare && !hasBaseline) throw new ArenaConfigurationError('Choose an explicit baselineRevision to compare this source. No previous revision was guessed.', 'INVALID_CONTEXT');
  if (launch.compare && !file) throw new ArenaConfigurationError('Open an exact document before requesting document comparison. Use the model comparison controls for CAD.', 'INVALID_CONTEXT');
  sameConnection(status, await adapter.connectionStatus(signal));
  signal?.throwIfAborted();
  // Distinct slots preserve the current UI while the source carries real revision labels.
  return { adapter, status, schema, snapshots: { A: baseline, B: current }, slot: 'B', hasBaseline, file, selectedIds, workspaceView: launch.view ?? defaultView, compare: !!launch.compare, revisions };
}
