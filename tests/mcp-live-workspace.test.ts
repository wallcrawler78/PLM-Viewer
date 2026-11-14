import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, BomSnapshot, WorkspaceSchema } from '../src/domain';
import { ArenaAdapter, ArenaConfigurationError } from '../src/integrations/arenaAdapter';
import { ArenaRevisionRequired, loadArenaWorkspace } from '../src/integrations/liveWorkspace';
import { fetchViewerContent } from '../src/integrations/protectedContent';

const hash = 'a'.repeat(64), meshHash = 'b'.repeat(64);
const status = (connectionId = 'connection-alice') => ({ configured: true, provider: 'arena', transport: 'mcp', readOnly: true, state: 'ready', workspaceId: 'workspace', connectionId, user: { id: connectionId, displayName: 'Connected reviewer' }, capabilities: { annotations: false, conditionalWrites: false, sourceConversion: false, supplierItems: true } });
const schema: WorkspaceSchema = { workspaceId: 'workspace', name: 'Customer workspace', version: '17', attributes: [{ id: 'custom-finish', label: 'Treatment', type: 'text', scope: 'item' }] };
function contentUrl(revision: string, kind = 'pdf', connectionId = 'connection-alice', extra: Record<string, string> = {}) {
  return `/api/viewer/v1/content?${new URLSearchParams({ workspaceId: 'workspace', itemId: 'item', revision, fileId: 'file-guid', edition: `edition-${revision}`, sourceHash: hash, kind, connectionId, ...(kind === 'mesh' ? { contentHash: meshHash } : {}), ...extra })}`;
}
function document(revision: string, connectionId = 'connection-alice'): Attachment {
  return { id: 'file-guid', itemId: 'item', revision, edition: `edition-${revision}`, sourceHash: hash, kind: 'pdf', name: 'Specification.pdf', seriesId: 'series', url: contentUrl(revision, 'pdf', connectionId) };
}
function snapshot(revision: string, connectionId = 'connection-alice'): BomSnapshot {
  return { id: `snapshot-${revision}`, workspaceId: 'workspace', rootItemId: 'item', rootItemNumber: 'PN-100', title: 'Customer assembly', revision, configurationId: `frozen-${revision}`, units: 'mm', upAxis: 'Z', capturedAt: '2026-11-13T00:00:00Z', parts: [], occurrences: [], documents: [document(revision, connectionId)], attributes: { 'custom-finish': 'Anodized' } };
}
const launch = '?mode=arena&workspaceId=workspace&itemId=item&revision=D37';
type Override = (path: string, query: URLSearchParams, call: number) => unknown | Response | undefined;
function service(override?: Override, connectionId = 'connection-alice') {
  const calls: { path: string; query: URLSearchParams; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'https://viewer.invalid');
    const path = url.pathname.split('/').at(-1)!;
    calls.push({ path, query: url.searchParams, init });
    const replacement = override?.(path, url.searchParams, calls.filter(call => call.path === path).length);
    if (replacement instanceof Response) return replacement;
    const revision = url.searchParams.get('revision') ?? 'D37';
    const defaults: Record<string, unknown> = { status: status(connectionId), schema, revisions: [{ id: 'D36', label: 'Revision D36', lifecycle: 'Released' }, { id: 'D37', label: 'Revision D37', lifecycle: 'In Review' }], bom: snapshot(revision, connectionId), attachments: [document(revision, connectionId)], 'supplier-items': [{ id: 'supplier-part', itemId: 'item', supplierId: 'supplier', supplierName: 'Acme', partNumber: 'SUP-7', name: 'Sourced part', attributes: { 'vendor-tier': 2, approved: true } }] };
    return new Response(JSON.stringify(replacement ?? defaults[path]), { headers: { 'Content-Type': 'application/json', 'X-Viewer-Connection': connectionId } });
  };
  return { calls, fetcher };
}
afterEach(() => vi.unstubAllGlobals());

describe('live MCP workspace loading', () => {
  it('opens a real revision label and exact document first, with an explicit baseline and schema attributes', async () => {
    const api = service();
    const result = await loadArenaWorkspace(`${launch}&fileId=file-guid&baselineRevision=D36&compare=true`, undefined, api.fetcher);
    expect(result.snapshots.A.revision).toBe('D36');
    expect(result.snapshots.B.revision).toBe('D37');
    expect(result.slot).toBe('B');
    expect(result.hasBaseline).toBe(true);
    expect(result.file?.edition).toBe('edition-D37');
    expect(result.workspaceView).toBe('documents');
    expect(result.compare).toBe(true);
    expect(result.schema.attributes[0].label).toBe('Treatment');
    expect(api.calls.every(call => call.init?.cache === 'no-store' && call.init.credentials === 'same-origin' && call.init.redirect === 'error')).toBe(true);
    expect(api.calls.filter(call => call.path !== 'status').every(call => new Headers(call.init?.headers).get('X-Viewer-Connection') === 'connection-alice')).toBe(true);
    expect(api.calls.some(call => String(call.query).includes('preview'))).toBe(false);
  });
  it('has one source without a baseline and never guesses a previous revision', async () => {
    const api = service();
    const result = await loadArenaWorkspace(launch, undefined, api.fetcher);
    expect(result.hasBaseline).toBe(false);
    expect(result.snapshots.A).toBe(result.snapshots.B);
    expect(api.calls.filter(call => call.path === 'bom').map(call => call.query.get('revision'))).toEqual(['D37']);
    await expect(loadArenaWorkspace(`${launch}&fileId=file-guid&compare=true`, undefined, api.fetcher)).rejects.toThrow('explicit baselineRevision');
  });
  it('returns accessible choices when the launch omits a revision without fetching an arbitrary BOM', async () => {
    const api = service();
    const error = await loadArenaWorkspace('?mode=arena&workspaceId=workspace&itemId=item', undefined, api.fetcher).catch(error => error);
    expect(error).toBeInstanceOf(ArenaRevisionRequired);
    expect(error.revisions.map((revision: { id: string }) => revision.id)).toEqual(['D36', 'D37']);
    expect(api.calls.some(call => call.path === 'bom' || call.path === 'attachments')).toBe(false);
  });
  it('rejects ambiguous file editions and accepts only the explicitly chosen edition/hash', async () => {
    const api = service(path => path === 'attachments' ? [document('D37'), { ...document('D37'), edition: 'second', url: contentUrl('D37', 'pdf', 'connection-alice', { edition: 'second' }) }] : undefined);
    await expect(loadArenaWorkspace(`${launch}&fileId=file-guid`, undefined, api.fetcher)).rejects.toThrow('more than one');
    const result = await loadArenaWorkspace(`${launch}&fileId=file-guid&edition=second&sourceHash=${hash}`, undefined, api.fetcher);
    expect(result.file?.edition).toBe('second');
    await expect(loadArenaWorkspace(`${launch}&fileId=missing`, undefined, api.fetcher)).rejects.toThrow('No other file');
  });
  it('does not substitute a current parent BOM or ignore duplicate identity parameters', async () => {
    const api = service();
    await expect(loadArenaWorkspace(`${launch}&parentItemId=parent`, undefined, api.fetcher)).rejects.toThrow('parentRevision');
    await expect(loadArenaWorkspace(`${launch}&edition=1&edition=2&fileId=file-guid`, undefined, api.fetcher)).rejects.toThrow('more than one edition');
    await expect(loadArenaWorkspace(`${launch}&baselineConfigurationId=configuration`, undefined, api.fetcher)).rejects.toThrow('exact revision');
    expect(api.calls).toHaveLength(0);
  });
  it('fails a live load on revoked access rather than returning a partial comparison or fixture', async () => {
    const api = service((path, query) => path === 'bom' && query.get('revision') === 'D36' ? new Response('Denied', { status: 403 }) : undefined);
    await expect(loadArenaWorkspace(`${launch}&baselineRevision=D36`, undefined, api.fetcher)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(api.calls.every(call => !call.path.includes('fixture'))).toBe(true);
  });
  it('rejects a principal switch before applying concurrently fetched source data', async () => {
    const api = service((path, _query, count) => path === 'status' && count > 1 ? { ...status(), user: { id: 'different-human' } } : undefined);
    await expect(loadArenaWorkspace(launch, undefined, api.fetcher)).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
  });
  it('keeps two users and their protected URLs isolated through concurrent loads', async () => {
    const alice = service(), bob = service(undefined, 'connection-bob');
    const [a, b] = await Promise.all([loadArenaWorkspace(launch, undefined, alice.fetcher), loadArenaWorkspace(launch, undefined, bob.fetcher)]);
    expect(a.status.connectionId).toBe('connection-alice');
    expect(b.status.connectionId).toBe('connection-bob');
    expect(a.file?.url).toContain('connection-alice');
    expect(b.file?.url).toContain('connection-bob');
    expect(bob.calls.filter(call => call.path !== 'status').every(call => new Headers(call.init?.headers).get('X-Viewer-Connection') === 'connection-bob')).toBe(true);
  });
  it('does not enable live mode for a legacy provider without a verified MCP connection', async () => {
    const api = service(path => path === 'status' ? { configured: true, provider: 'arena', workspaceId: 'workspace' } : undefined);
    await expect(loadArenaWorkspace(launch, undefined, api.fetcher)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(api.calls).toHaveLength(1);
  });
  it('distinguishes workspace MCP eligibility from ordinary permission denial without showing raw error text', async () => {
    const api = service(() => new Response(JSON.stringify({ code: 'FEATURE_NOT_ENABLED', error: 'Sensitive upstream details must stay hidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    const error = await loadArenaWorkspace(launch, undefined, api.fetcher).catch(error => error);
    expect(error.code).toBe('FEATURE_NOT_ENABLED');
    expect(error.message).toContain('workspace eligibility');
    expect(error.message).not.toContain('Sensitive');
  });
  it('returns an aborted load without an applyable workspace', async () => {
    const api = service();
    const controller = new AbortController();
    controller.abort(new DOMException('User changed the source', 'AbortError'));
    await expect(loadArenaWorkspace(launch, controller.signal, api.fetcher)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('protected source boundaries', () => {
  it('loads exact source-only STEP metadata without a conversion service or prepared properties', async () => {
    const model = snapshot('D37'); model.documents = [];
    model.occurrences = [{ id: 'occ-raw', partId: 'child', partRevision: '7', itemNumber: 'PN-CHILD', name: 'Raw part', position: [4, 5, 6], rotation: [0, 0, 0], quantity: 1, attributes: {}, modelState: 'loaded' }];
    model.parts = [{ id: 'child', revision: '7', itemNumber: 'PN-CHILD', name: 'Raw part', sourceHash: hash, stepUrl: contentUrl('7', 'step', 'connection-alice', { itemId: 'child', fileId: 'raw-step' }), color: '#aabbcc', material: 'Not supplied', attributes: {} }];
    model.modelSources = [{ id: 'raw-step', itemId: 'child', revision: '7', edition: 'edition-7', sourceHash: hash, occurrenceIds: ['occ-raw'] }];
    const api = service(path => path === 'bom' ? model : undefined);
    const adapter = new ArenaAdapter({ workspaceId: 'workspace', itemId: 'item' }, api.fetcher);
    const result = await adapter.loadBom('D37');
    expect(result.parts[0].meshUrl).toBeUndefined(); expect(result.parts[0].bbox).toBeUndefined();
    expect(result.parts[0].volumeMm3).toBeUndefined(); expect(result.occurrences[0].position).toEqual([4, 5, 6]);
    model.modelSources[0].edition = 'changed';
    await expect(adapter.loadBom('D37')).rejects.toThrow('same exact CAD attachment');
  });
  it('requires an explicit subtree when an assembly source supplies a child item', async () => {
    const model = snapshot('D37'); model.documents = [];
    model.occurrences = [{ id: 'occ-child', partId: 'child', partRevision: '7', itemNumber: 'PN-CHILD', name: 'Child', position: [0, 0, 0], rotation: [0, 0, 0], quantity: 1, attributes: {}, modelState: 'loaded' }];
    model.parts = [{ id: 'child', revision: '7', itemNumber: 'PN-CHILD', name: 'Child', sourceHash: hash, stepUrl: contentUrl('D37', 'step'), color: '#aabbcc', material: 'Not supplied', attributes: {} }];
    model.modelSources = [{ id: 'file-guid', itemId: 'item', revision: 'D37', edition: 'edition-D37', sourceHash: hash, occurrenceIds: ['occ-child'] }];
    const api = service(path => path === 'bom' ? model : undefined);
    const adapter = new ArenaAdapter({ workspaceId: 'workspace', itemId: 'item' }, api.fetcher);
    await expect(adapter.loadBom('D37')).rejects.toThrow('explicit CAD component path');
    model.parts[0].cadNodePath = [0, 2];
    await expect(adapter.loadBom('D37')).rejects.toThrow('explicit sourceToPart');
    model.parts[0].sourceToPart = { position: [-30, 20, 5], rotation: [0.1, -0.2, 0.3] };
    const resolved = await adapter.loadBom('D37');
    expect(resolved.parts[0].cadNodePath).toEqual([0, 2]);
    expect(resolved.parts[0].sourceToPart).toEqual(model.parts[0].sourceToPart);
    expect(resolved.occurrences[0].position).toEqual([0, 0, 0]);
  });
  it('rejects remote URLs, identity substitution, and another session before any reader fetch', async () => {
    for (const url of ['https://external.invalid/file.pdf', contentUrl('D36'), contentUrl('D37', 'pdf', 'connection-bob'), `${contentUrl('D37')}&fileId=other`, `${contentUrl('D37')}&access_token=private`]) {
      const api = service(path => path === 'attachments' ? [{ ...document('D37'), url }] : undefined);
      await expect(loadArenaWorkspace(launch, undefined, api.fetcher), url).rejects.toBeInstanceOf(ArenaConfigurationError);
    }
  });
  it('rejects documents from item revisions that are absent from the resolved BOM', async () => {
    const extra = { ...document('D37'), itemId: 'unrelated', url: contentUrl('D37', 'pdf', 'connection-alice', { itemId: 'unrelated' }) };
    const api = service(path => path === 'bom' ? { ...snapshot('D37'), documents: [extra] } : undefined);
    await expect(loadArenaWorkspace(launch, undefined, api.fetcher)).rejects.toThrow('resolved item revision');
  });
  it('requires source identity for both STEP and its mesh while allowing a root assembly source', async () => {
    const model = snapshot('D37');
    model.documents = [];
    model.occurrences = [{ id: 'occ-1', partId: 'child', partRevision: '7', itemNumber: 'PN-CHILD', name: 'Child', position: [0, 0, 0], rotation: [0, 0, 0], quantity: 1, attributes: {}, modelState: 'loaded' }];
    model.parts = [{ id: 'child', revision: '7', itemNumber: 'PN-CHILD', name: 'Child', sourceHash: hash, displaySource: 'mesh', meshUrl: contentUrl('D37', 'mesh'), stepUrl: contentUrl('D37', 'step'), color: '#aabbcc', material: 'Metal', bbox: { min: [0, 0, 0], max: [1, 1, 1] }, volumeMm3: 1, attributes: {} }];
    model.modelSources = [{ id: 'file-guid', itemId: 'item', revision: 'D37', edition: 'edition-D37', sourceHash: hash, occurrenceIds: ['occ-1'] }];
    const api = service(path => path === 'bom' ? model : path === 'attachments' ? [] : undefined);
    const workspace = await loadArenaWorkspace(`${launch}&fileId=file-guid`, undefined, api.fetcher);
    expect(workspace.selectedIds).toEqual(['occ-1']);
    expect(workspace.workspaceView).toBe('model');
    model.parts[0].meshUrl = contentUrl('D37', 'mesh', 'connection-alice', { edition: 'other-edition' });
    await expect(loadArenaWorkspace(launch, undefined, api.fetcher)).rejects.toThrow('same exact CAD attachment');
  });
  it('supports supplier item metadata without assuming customer attribute labels', async () => {
    const api = service();
    const adapter = new ArenaAdapter({ workspaceId: 'workspace', itemId: 'item' }, api.fetcher);
    const suppliers = await adapter.listSupplierItems('item', 'D37');
    expect(suppliers[0].attributes).toEqual({ 'vendor-tier': 2, approved: true });
    const disabled = service(path => path === 'status' ? { ...status(), capabilities: { ...status().capabilities, supplierItems: false } } : undefined);
    await expect(new ArenaAdapter({ workspaceId: 'workspace', itemId: 'item' }, disabled.fetcher).listSupplierItems('item', 'D37')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(disabled.calls.some(call => call.path === 'supplier-items')).toBe(false);
  });
  it('clears all live panes immediately on protected file denial or a mismatched success header', async () => {
    const events: CustomEvent[] = [];
    vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => events.push(event) });
    for (const code of [401, 403, 409, 200]) {
      await expect(fetchViewerContent(contentUrl('D37'), undefined, async () => new Response('file', { status: code }))).rejects.toThrow();
    }
    expect(events).toHaveLength(4);
    expect(events.map(event => event.detail.code)).toEqual(['AUTH_REQUIRED', 'FORBIDDEN', 'CONNECTION_CHANGED', 'CONNECTION_CHANGED']);
    expect(events.every(event => event.detail.connectionId === 'connection-alice')).toBe(true);
    await fetchViewerContent('/fixtures/example.pdf', undefined, async () => new Response('missing', { status: 403 }));
    expect(events).toHaveLength(4);
  });
  it('accepts protected bytes only with the expected connection header and passes no browser token', async () => {
    let request: RequestInit | undefined;
    const response = await fetchViewerContent(contentUrl('D37'), undefined, async (_url, init) => { request = init; return new Response('file', { headers: { 'X-Viewer-Connection': 'connection-alice' } }); });
    expect(await response.text()).toBe('file');
    expect(request).toMatchObject({ cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    expect(request?.headers).toBeUndefined();
  });
});
