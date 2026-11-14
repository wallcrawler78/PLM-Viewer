import { attachmentIdentityKey, validateAttachment, validateSchema, validateSnapshot, validateSupplierItem } from '../domain';
import type { Attachment, BomSnapshot, PlmAdapter, RevisionDescriptor, SupplierItem, WorkspaceSchema } from '../domain';
import { parseLaunchContext } from '../launch-context';
import { featureUnavailable, invalidateViewerSession } from './protectedContent';
import { discardResponse, readBoundedJson, ResponseBodyError, withAbort } from './responseBody';

export interface ArenaConnectionOptions {
  /** Same-origin BFF path. Raw Arena credentials never enter the browser. */
  baseUrl?: string;
  workspaceId: string;
  itemId: string;
  configurationId?: string;
}
export interface ViewerServiceStatus {
  configured: boolean;
  provider: 'arena';
  transport?: 'mcp';
  state?: string;
  readOnly?: boolean;
  connectionId?: string;
  user?: { id: string; displayName?: string };
  workspaceId?: string;
  message?: string;
  capabilities?: { annotations: boolean; sourceConversion: boolean; conditionalWrites: boolean; supplierItems?: boolean };
}
export class ArenaConfigurationError extends Error {
  override name = 'ArenaConfigurationError';
  constructor(message: string, readonly code = 'INVALID_RESPONSE') { super(message); }
}
const identity = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
export class ArenaAdapter implements PlmAdapter {
  readonly mode = 'arena' as const;
  private readonly baseUrl: string;
  private status?: ViewerServiceStatus;
  constructor(private readonly options: ArenaConnectionOptions, private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {
    this.baseUrl = (options.baseUrl ?? '/api/viewer/v1').replace(/\/$/, '');
    if (!this.baseUrl.startsWith('/') || this.baseUrl.startsWith('//') || /[\\\s?#\u0000-\u001f\u007f]/.test(this.baseUrl) || new URL(this.baseUrl, 'https://viewer.invalid').origin !== 'https://viewer.invalid') throw new ArenaConfigurationError('Use a same-origin viewer service path. Do not send Arena credentials to the browser.', 'INVALID_CONFIGURATION');
    if (!identity(options.workspaceId) || !identity(options.itemId)) throw new ArenaConfigurationError('Arena launch requires a workspace and item identifier.', 'INVALID_CONTEXT');
  }
  async connectionStatus(signal?: AbortSignal): Promise<ViewerServiceStatus> {
    const { data, connectionId } = await this.readJson<ViewerServiceStatus>('status', undefined, signal);
    if (!data || data.provider !== 'arena' || typeof data.configured !== 'boolean') throw new ArenaConfigurationError('The configured URL is not a compatible Arena viewer service.');
    if (data.configured && data.workspaceId !== this.options.workspaceId) throw new ArenaConfigurationError('The viewer service is configured for a different workspace.', 'FORBIDDEN');
    if (data.configured && data.transport === 'mcp') {
      if (data.readOnly !== true || !identity(data.connectionId) || !data.user || !identity(data.user.id) || connectionId !== data.connectionId) throw new ArenaConfigurationError('The MCP viewer service did not return a verified user connection.');
      if (!data.capabilities || data.capabilities.annotations !== false || data.capabilities.conditionalWrites !== false || typeof data.capabilities.sourceConversion !== 'boolean' || typeof data.capabilities.supplierItems !== 'boolean') throw new ArenaConfigurationError('The MCP viewer service returned unsupported capabilities.');
    }
    if (this.status?.connectionId && (!data.configured || data.connectionId !== this.status.connectionId || data.user?.id !== this.status.user?.id || data.workspaceId !== this.status.workspaceId)) this.failSession('CONNECTION_CHANGED', 'The connected Arena user or workspace changed. Reopen this source.');
    this.status = data;
    return data;
  }
  private async configured(signal?: AbortSignal): Promise<void> {
    const status = this.status ?? await this.connectionStatus(signal);
    if (!status.configured) throw new ArenaConfigurationError(status.message ?? 'Arena MCP is not configured. An administrator must connect the server to Arena before live mode can open files.', 'UNCONFIGURED');
    if (status.workspaceId !== this.options.workspaceId) throw new ArenaConfigurationError('The viewer service is configured for a different workspace.', 'FORBIDDEN');
  }
  private failSession(code: string, message: string): never {
    invalidateViewerSession({ code, message, connectionId: this.status?.connectionId });
    throw new ArenaConfigurationError(message, code);
  }
  private async readJson<T>(path: string, query?: Record<string, string>, signal?: AbortSignal): Promise<{ data: T; connectionId: string | null }> {
    const params = new URLSearchParams({ workspaceId: this.options.workspaceId, ...query });
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new DOMException('Viewer service request timed out.', 'TimeoutError')), 20000);
    let response: Response | undefined;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.status?.connectionId) headers['X-Viewer-Connection'] = this.status.connectionId;
      response = await withAbort<Response>(this.fetcher(`${this.baseUrl}/${path}?${params}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers, signal: controller.signal }).then(value => {
        if (controller.signal.aborted) { discardResponse(value); controller.signal.throwIfAborted(); }
        return value;
      }), controller.signal);
      if (response.status === 401) this.failSession('AUTH_REQUIRED', 'Your Arena session has expired or is not connected. Reconnect to continue.');
      if (response.status === 403) {
        if (await featureUnavailable(response, controller.signal)) this.failSession('FEATURE_NOT_ENABLED', 'MCP access is not enabled for this Arena workspace. Ask your Arena administrator to check workspace eligibility.');
        this.failSession('FORBIDDEN', 'Your authenticated session does not have access to this Arena content.');
      }
      if (response.status === 409) this.failSession('CONNECTION_CHANGED', 'The connected Arena user, workspace, or source identity changed. Reopen this source.');
      if (!response.ok) {
        const errors: Record<number, [string, string]> = {
          404: ['UNAVAILABLE', 'The Arena viewer service or requested source is unavailable. Preview mode remains available.'],
          501: ['UNSUPPORTED', 'This Arena capability has not been configured for the viewer.'],
          503: ['UNCONFIGURED', 'The Arena MCP service is not configured or is temporarily unavailable.'],
          429: ['RATE_LIMITED', 'Arena is receiving too many requests. Please try again shortly.'],
        };
        const [code, message] = errors[response.status] ?? ['UPSTREAM_ERROR', `Arena viewer service returned ${response.status}.`];
        throw new ArenaConfigurationError(message, code);
      }
      const connectionId = response.headers.get('X-Viewer-Connection');
      if (this.status?.connectionId && connectionId !== this.status.connectionId) this.failSession('CONNECTION_CHANGED', 'The viewer response belongs to a different or unverified Arena connection.');
      if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new ArenaConfigurationError('Expected JSON from the viewer service. Configure the BFF before using live Arena mode.', 'UNCONFIGURED');
      let data: T;
      try { data = await readBoundedJson<T>(response, 16 * 1024 * 1024, controller.signal); }
      catch (error) {
        controller.signal.throwIfAborted();
        if (error instanceof ResponseBodyError && error.code === 'TOO_LARGE') throw new ArenaConfigurationError('The viewer metadata response is too large.');
        throw new ArenaConfigurationError('The viewer service returned invalid JSON.');
      }
      signal?.throwIfAborted();
      return { data, connectionId };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (error instanceof ArenaConfigurationError) throw error;
      if (controller.signal.aborted) throw new ArenaConfigurationError('The Arena request timed out. Please try again.', 'TIMEOUT');
      throw new ArenaConfigurationError('The Arena viewer service could not be reached. Check the server connection and try again.', 'UNAVAILABLE');
    } finally { discardResponse(response); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  private async request<T>(path: string, query?: Record<string, string>, signal?: AbortSignal): Promise<T> { return (await this.readJson<T>(path, query, signal)).data; }

  /** Only authenticated BFF URLs reach browser readers; remote URLs and bearer tokens stay server-side. */
  private protectedUrl(value: string, expected: Partial<Record<'fileId' | 'itemId' | 'revision' | 'edition' | 'sourceHash' | 'kind', string>>): void {
    if (this.status?.transport !== 'mcp') return;
    if (!value.startsWith('/') || value.startsWith('//') || /[\\\s#\u0000-\u001f\u007f]/.test(value)) throw new ArenaConfigurationError('Live files must use the authenticated viewer content route.');
    const url = new URL(value, 'https://viewer.invalid');
    const p = url.searchParams;
    if (url.origin !== 'https://viewer.invalid' || url.pathname !== `${this.baseUrl}/content`) throw new ArenaConfigurationError('Live files must use the authenticated viewer content route.');
    const allowed = ['workspaceId', 'itemId', 'revision', 'fileId', 'edition', 'sourceHash', 'kind', 'connectionId', 'contentHash'];
    if ([...p.keys()].some(key => !allowed.includes(key) || p.getAll(key).length !== 1) || allowed.filter(key => key !== 'contentHash').some(key => !identity(p.get(key)))) throw new ArenaConfigurationError('Protected file metadata is incomplete or ambiguous.');
    if (p.get('workspaceId') !== this.options.workspaceId || p.get('connectionId') !== this.status.connectionId) this.failSession('CONNECTION_CHANGED', 'A protected file belongs to a different Arena connection.');
    if (!['pdf', 'docx', 'doc', 'step', 'mesh'].includes(p.get('kind')!) || !digest(p.get('sourceHash')!)) throw new ArenaConfigurationError('Protected files need a supported format and exact SHA-256 source hash.');
    if ((p.get('kind') === 'mesh' && !digest(p.get('contentHash') ?? '')) || p.has('contentHash') && !digest(p.get('contentHash')!)) throw new ArenaConfigurationError('A converted mesh needs an exact SHA-256 content hash.');
    if (p.get('kind') !== 'mesh' && p.has('contentHash') && p.get('contentHash') !== p.get('sourceHash')) throw new ArenaConfigurationError('Original file and source hashes do not match.');
    if (Object.entries(expected).some(([key, value]) => p.get(key) !== value)) throw new ArenaConfigurationError('A protected URL does not match the exact requested source identity.');
  }
  private checkAttachment(file: Attachment): void {
    this.protectedUrl(file.url, { fileId: file.id, itemId: file.itemId, revision: file.revision, edition: file.edition, sourceHash: file.sourceHash, kind: file.kind });
  }
  async loadSchema(signal?: AbortSignal): Promise<WorkspaceSchema> {
    await this.configured(signal);
    const schema = validateSchema(await this.request<WorkspaceSchema>('schema', undefined, signal));
    if (schema.workspaceId !== this.options.workspaceId) throw new ArenaConfigurationError('Schema workspace mismatch.');
    return schema;
  }
  async loadBom(revision: string, signal?: AbortSignal): Promise<BomSnapshot> {
    await this.configured(signal);
    if (!identity(revision)) throw new ArenaConfigurationError('Choose an exact item revision.', 'INVALID_CONTEXT');
    const snapshot = validateSnapshot(await this.request<BomSnapshot>('bom', { itemId: this.options.itemId, revision, ...(this.options.configurationId ? { configurationId: this.options.configurationId } : {}) }, signal));
    if (snapshot.workspaceId !== this.options.workspaceId || snapshot.rootItemId !== this.options.itemId || snapshot.revision !== revision) throw new ArenaConfigurationError('The viewer service returned a different item, workspace, or revision than requested.');
    if (this.options.configurationId && snapshot.configurationId !== this.options.configurationId) throw new ArenaConfigurationError('The viewer service returned a different frozen configuration than requested. No substitute configuration was accepted.');
    snapshot.documents.forEach(file => this.checkAttachment(file));
    if (this.status?.transport === 'mcp' && snapshot.documents.some(file => !(file.itemId === snapshot.rootItemId && file.revision === snapshot.revision) && !snapshot.occurrences.some(row => row.partId === file.itemId && row.partRevision === file.revision))) throw new ArenaConfigurationError('A document does not belong to a resolved item revision in this BOM.');
    const sourceForUrl = (value: string) => {
      const params = new URL(value, 'https://viewer.invalid').searchParams;
      return snapshot.modelSources?.find(source => source.id === params.get('fileId') && source.itemId === params.get('itemId') && source.revision === params.get('revision') && source.edition === params.get('edition') && source.sourceHash === params.get('sourceHash'));
    };
    for (const part of snapshot.parts) {
      if (part.meshUrl !== undefined) this.protectedUrl(part.meshUrl, { sourceHash: part.sourceHash, kind: 'mesh' });
      this.protectedUrl(part.stepUrl, { sourceHash: part.sourceHash, kind: 'step' });
      if (this.status?.transport === 'mcp') {
        const source = sourceForUrl(part.stepUrl), meshSource = part.meshUrl === undefined ? undefined : sourceForUrl(part.meshUrl);
        if (!source || part.meshUrl !== undefined && source !== meshSource || !source.occurrenceIds.some(id => snapshot.occurrences.some(row => row.id === id && row.partId === part.id && row.partRevision === part.revision))) throw new ArenaConfigurationError('The STEP and any supplied mesh must refer to the same exact CAD attachment and BOM occurrence.');
        if (part.displaySource !== 'mesh' && (source.itemId !== part.id || source.revision !== part.revision) && part.cadNodePath === undefined) throw new ArenaConfigurationError('An assembly STEP needs an explicit CAD component path to display a child BOM item. No geometry mapping was guessed.');
      }
    }
    if (snapshot.assemblyStepUrl) {
      this.protectedUrl(snapshot.assemblyStepUrl, { itemId: snapshot.rootItemId, revision: snapshot.revision, kind: 'step' });
      if (this.status?.transport === 'mcp' && !sourceForUrl(snapshot.assemblyStepUrl)) throw new ArenaConfigurationError('The assembly STEP URL needs an exact root CAD source identity.');
    }
    return snapshot;
  }
  async listRevisions(signal?: AbortSignal): Promise<RevisionDescriptor[]> {
    await this.configured(signal);
    const data = await this.request<RevisionDescriptor[]>('revisions', { itemId: this.options.itemId }, signal);
    if (!Array.isArray(data) || data.some(row => !row || !identity(row.id) || !identity(row.label) || typeof row.lifecycle !== 'string') || new Set(data.map(row => row.id)).size !== data.length) throw new ArenaConfigurationError('Invalid revision response.');
    return data;
  }
  async listAttachments(itemId: string, revision: string, signal?: AbortSignal): Promise<Attachment[]> {
    await this.configured(signal);
    if (!identity(itemId) || !identity(revision)) throw new ArenaConfigurationError('Choose an exact item and revision.', 'INVALID_CONTEXT');
    const files = await this.request<Attachment[]>('attachments', { itemId, revision }, signal);
    if (!Array.isArray(files)) throw new ArenaConfigurationError('Invalid attachment response.');
    files.forEach(validateAttachment);
    if (files.some(file => file.itemId !== itemId || file.revision !== revision)) throw new ArenaConfigurationError('Attachment editions did not match the requested item revision.');
    if (new Set(files.map(attachmentIdentityKey)).size !== files.length) throw new ArenaConfigurationError('The attachment response contains duplicate source identities.');
    files.forEach(file => this.checkAttachment(file));
    return files;
  }
  async listSupplierItems(itemId: string, revision: string, signal?: AbortSignal): Promise<SupplierItem[]> {
    await this.configured(signal);
    if (!this.status?.capabilities?.supplierItems) throw new ArenaConfigurationError('Supplier items have not been enabled for this Arena connection.', 'UNSUPPORTED');
    if (!identity(itemId) || !identity(revision)) throw new ArenaConfigurationError('Choose an exact item and revision.', 'INVALID_CONTEXT');
    const rows = await this.request<SupplierItem[]>('supplier-items', { itemId, revision }, signal);
    if (!Array.isArray(rows)) throw new ArenaConfigurationError('Invalid supplier items response.');
    rows.forEach(validateSupplierItem);
    if (rows.some(row => row.itemId !== itemId) || new Set(rows.map(row => row.id)).size !== rows.length) throw new ArenaConfigurationError('Supplier items did not match the requested item or contain duplicate identifiers.');
    rows.forEach(row => row.attachments?.forEach(file => this.checkAttachment(file)));
    return rows;
  }
}

export interface ArenaLaunchContext { mode: 'arena'; workspaceId: string; itemId: string; revision?: string; fileId?: string; parentItemId?: string; }
export function parseArenaLaunchContext(search: string): ArenaLaunchContext | null {
  let launch;
  try { launch = parseLaunchContext(search); }
  catch (error) { throw new ArenaConfigurationError(error instanceof Error ? error.message : 'The Arena launch URL is invalid.', 'INVALID_CONTEXT'); }
  if (launch.mode !== 'arena') return null;
  const p = new URLSearchParams(search);
  const workspaceId = launch.workspaceId ?? '', itemId = launch.itemId ?? '';
  if (!workspaceId || !itemId || [workspaceId, itemId].some(v => v.length > 200)) throw new ArenaConfigurationError('Arena launch URL is missing valid workspace and item context.', 'INVALID_CONTEXT');
  const result: ArenaLaunchContext = { mode: 'arena', workspaceId, itemId };
  for (const key of ['revision', 'fileId', 'parentItemId'] as const) {
    const values = p.getAll(key);
    if (values.length > 1) throw new ArenaConfigurationError(`The Arena launch contains more than one ${key}.`, 'INVALID_CONTEXT');
    if (!values.length) continue;
    const value = values[0];
    if (!value || value !== value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ArenaConfigurationError(`The Arena launch has an invalid ${key}. Open the exact source again from its item.`, 'INVALID_CONTEXT');
    result[key] = value;
  }
  return result;
}
