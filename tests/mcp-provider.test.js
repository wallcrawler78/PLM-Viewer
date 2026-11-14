/** Controlled synthetic MCP server and trusted test sessions. Not an Arena catalog or production auth bypass. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createArenaMcpProvider, createGuardedMcpFetch, collectPages, unwrapToolResult } from '../server/mcp-provider.mjs';
import { createViewerServer } from '../server/index.mjs';
import { buildContentUrl, validateContentResult } from '../server/content.mjs';
import { ViewerError, safeError } from '../server/errors.mjs';
import { createProvider as exampleProvider } from '../server/provider.example.mjs';

const TRUSTED_TEST_SESSION = Symbol('test authentication result');
const endpoint = 'https://synthetic-mcp.invalid/mcp';
const bytes = Buffer.from('%PDF-1.7\nsynthetic test source\n%%EOF');
const hash = createHash('sha256').update(bytes).digest('hex');
const documentSource = { fileId: 'file-1', itemId: 'item-1', revision: 'A', edition: 'edition-1', sourceHash: hash, kind: 'pdf' };
const documentMetadata = { id: documentSource.fileId, itemId: documentSource.itemId, revision: documentSource.revision, edition: documentSource.edition, sourceHash: hash, kind: 'pdf', name: 'Synthetic.pdf' };
const tool = name => ({ name, inputSchema: { type: 'object', additionalProperties: true }, annotations: { readOnlyHint: true, destructiveHint: false } });
const initialTools = ['test.schema', 'test.revisions', 'test.attachments', 'test.bom', 'test.content', 'test.suppliers'].map(tool);

function session(user = 'alice', changes = {}) {
  return { userId: user, arenaUserId: `arena-${user}`, workspaceId: 'workspace-1', sessionId: `grant-${user}`, displayName: user.toUpperCase(), accessToken: `synthetic-token-${user}`, expiresAt: Date.now() + 60000, ...changes };
}
function fixture(options = {}) {
  const requests = [];
  const state = { tools: initialTools, status: 200, result: undefined, pages: undefined, ...options.state };
  const fetcher = async (url, init) => {
    const headers = new Headers(init.headers);
    const token = headers.get('authorization');
    const payload = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method: init.method, token, payload, redirect: init.redirect });
    if (state.status !== 200) return new Response('upstream private token=do-not-leak', { status: state.status });
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (!payload || payload.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (payload.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } };
    else if (payload.method === 'tools/list') {
      result = state.pages ? state.pages(payload.params?.cursor, token) : { tools: typeof state.tools === 'function' ? state.tools(token) : state.tools };
    } else if (payload.method === 'tools/call') {
      if (state.result) result = await state.result(payload.params, token);
      else {
        const name = payload.params.name;
        const user = token?.endsWith('bob') ? 'bob' : 'alice';
        const data = name === 'test.schema' ? { workspaceId: 'workspace-1', name: `Workspace for ${user}`, version: '1', attributes: [{ id: 'opaque-field', label: 'Enabled', type: 'boolean', scope: 'item' }] }
          : name === 'test.revisions' ? [{ id: 'A', label: 'A', lifecycle: 'Released' }]
          : name === 'test.content' ? { fileId: documentSource.fileId, user }
          : name === 'test.suppliers' ? [{ id: 'supplier-item-1', itemId: 'item-1', supplierId: 'supplier-1', supplierName: 'Synthetic supplier', partNumber: 'P-1', name: 'Supplier item', attributes: { zero: 0, enabled: false } }]
          : [];
        result = { structuredContent: data, content: [] };
      }
    } else if (payload.method === 'resources/read') result = { contents: [{ uri: payload.params.uri, mimeType: 'application/pdf', blob: bytes.toString('base64') }] };
    else throw new Error(`Unexpected synthetic method ${payload.method}`);
    const wireResult = { resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'synthetic-test-mcp', version: '1' } }, ...result };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: wireResult }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const bindings = {
    getSchema: async api => api.data(await api.callTool('test.schema')),
    listRevisions: async (api, query) => api.data(await api.callTool('test.revisions', query)),
    listAttachments: async (api, query) => {
      await api.callTool('test.attachments', query);
      return [{ ...documentMetadata, url: api.contentUrl(documentSource) }];
    },
    resolveBom: async () => ({ id: 'snapshot-1', workspaceId: 'workspace-1', rootItemId: 'item-1', revision: 'A', configurationId: 'frozen-A', parts: [], occurrences: [], documents: [] }),
    readContent: async (api, query, context) => {
      await api.callTool('test.content', query);
      if (context.userId !== 'alice') throw new ViewerError('FORBIDDEN');
      if (Object.keys(documentSource).some(key => documentSource[key] !== query[key])) throw new ViewerError('NOT_FOUND');
      return { identity: documentSource, bytes, contentType: 'application/pdf', name: 'Synthetic.pdf' };
    },
    ...options.bindings,
  };
  const provider = createArenaMcpProvider({
    endpoint, fetch: fetcher,
    resolveSession: request => request[TRUSTED_TEST_SESSION] ?? null,
    approvedReadTools: initialTools.map(value => value.name),
    bindings,
    ...options.provider,
  });
  return { provider, server: createViewerServer(provider), requests, state, bindings };
}
function request(server, path, { session: trusted = session(), headers: incomingHeaders = {}, method = 'GET' } = {}) {
  return new Promise(resolve => {
    const headers = {};
    let status;
    server.emit('request', { url: path, method, headers: incomingHeaders, [TRUSTED_TEST_SESSION]: trusted }, {
      setHeader(key, value) { headers[key] = value; },
      writeHead(code) { status = code; },
      end(body) { resolve({ status, headers, body: headers['Content-Type'].startsWith('application/json') ? JSON.parse(body) : Buffer.from(body) }); },
    });
  });
}
const statusPath = '/api/viewer/v1/status?workspaceId=workspace-1';
const schemaPath = '/api/viewer/v1/schema?workspaceId=workspace-1';
const attachmentsPath = '/api/viewer/v1/attachments?workspaceId=workspace-1&itemId=item-1&revision=A';

// All tests below execute the actual SDK Client + StreamableHTTPClientTransport over
// the controlled fetch implementation above. No live Arena calls or real accounts.
describe('per-user MCP transport and BFF', () => {
  it('normalizes explicitly parent-local placements before returning an authorized snapshot', async () => {
    const source = { ...documentSource, kind: 'step' };
    const inputRows = [
      { id: 'child', parentId: 'container', partId: 'item-1', partRevision: 'A', position: [10, 0, 0], rotation: [0, 0, 0] },
      { id: 'container', partId: 'item-1', partRevision: 'A', position: [100, 20, 30], rotation: [0, 0, Math.PI / 2], modelState: 'no-model' },
    ];
    const { server } = fixture({ bindings: { resolveBom: async api => ({
      id: 'nested-snapshot', workspaceId: 'workspace-1', rootItemId: 'item-1', revision: 'A', configurationId: 'frozen-A', placementSpace: 'parent',
      parts: [{ id: 'item-1', revision: 'A', sourceHash: hash, stepUrl: api.contentUrl(source) }],
      occurrences: inputRows, documents: [],
      modelSources: [{ id: source.fileId, itemId: source.itemId, revision: source.revision, edition: source.edition, sourceHash: hash, occurrenceIds: ['child', 'container'] }],
    }) } });
    const response = await request(server, '/api/viewer/v1/bom?workspaceId=workspace-1&itemId=item-1&revision=A');
    expect(response.status).toBe(200); expect(response.body.placementSpace).toBe('world');
    const child = response.body.occurrences[0];
    expect(child.parentId).toBe('container');
    expect(child.position[0]).toBeCloseTo(100); expect(child.position[1]).toBeCloseTo(30); expect(child.position[2]).toBeCloseTo(30);
    expect(child.rotation[2]).toBeCloseTo(Math.PI / 2);
    expect(inputRows[0].position).toEqual([10, 0, 0]);
    expect(response.headers['X-Viewer-Connection']).toBeDefined();
  });
  it.each(['unknown-frame', 'missing-parent', 'cycle', 'unresolved-parent'])('rejects invalid placement contracts without exposing upstream details: %s', async failure => {
    const occurrences = [
      { id: 'private-child', parentId: 'private-parent', position: [1, 2, 3], rotation: [0, 0, 0] },
      { id: 'private-parent', position: [10, 20, 30], rotation: [0, 0, 0] },
    ];
    if (failure === 'missing-parent') occurrences.pop();
    if (failure === 'cycle') occurrences[1].parentId = occurrences[0].id;
    if (failure === 'unresolved-parent') occurrences[1].modelState = 'placement-needed';
    const { server } = fixture({ bindings: { resolveBom: async () => ({ id: 'nested-snapshot', workspaceId: 'workspace-1', rootItemId: 'item-1', revision: 'A', configurationId: 'frozen-A', parts: [], documents: [], occurrences, placementSpace: failure === 'unknown-frame' ? 'guessed' : 'parent' }) } });
    const response = await request(server, '/api/viewer/v1/bom?workspaceId=workspace-1&itemId=item-1&revision=A');
    expect(response.status).toBe(502); expect(response.body.code).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(response.body)).not.toMatch(/private-child|private-parent|synthetic-token/);
  });
  it('delivers source-only STEP bytes while server conversion stays disabled', async () => {
    const stepBytes = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;');
    const stepHash = createHash('sha256').update(stepBytes).digest('hex');
    const source = { fileId: 'raw-step', itemId: 'item-1', revision: 'A', edition: 'step-edition-1', sourceHash: stepHash, kind: 'step' };
    const { server } = fixture({ bindings: {
      resolveBom: async api => ({ id: 'raw-snapshot', workspaceId: 'workspace-1', rootItemId: 'item-1', revision: 'A', configurationId: 'frozen-A',
        parts: [{ id: 'item-1', revision: 'A', sourceHash: stepHash, stepUrl: api.contentUrl(source) }],
        occurrences: [{ id: 'occ-raw', partId: 'item-1', partRevision: 'A' }], documents: [],
        modelSources: [{ id: source.fileId, itemId: source.itemId, revision: source.revision, edition: source.edition, sourceHash: stepHash, occurrenceIds: ['occ-raw'] }] }),
      readContent: async (_api, identity) => ({ identity, bytes: stepBytes, contentType: 'model/step', name: 'Raw.step' }),
    } });
    const status = await request(server, statusPath);
    expect(status.body.capabilities.sourceConversion).toBe(false);
    const metadata = await request(server, '/api/viewer/v1/bom?workspaceId=workspace-1&itemId=item-1&revision=A');
    expect(metadata.status).toBe(200); expect(metadata.body.parts[0].meshUrl).toBeUndefined();
    const file = await request(server, metadata.body.parts[0].stepUrl);
    expect(file.status).toBe(200); expect(file.body.equals(stepBytes)).toBe(true);
    const changed = metadata.body.parts[0].stepUrl.replace(stepHash, 'f'.repeat(64));
    expect((await request(server, changed)).status).not.toBe(200);
  });
  it('keeps the shipped example explicitly unconfigured', async () => {
    const provider = await exampleProvider();
    expect(provider.configured).toBe(false);
    const response = await request(createViewerServer(provider), statusPath);
    expect(response.body).toMatchObject({ configured: false, transport: 'mcp', readOnly: true, state: 'unconfigured' });
  });
  it('does not declare a metadata-only mapping configured for file viewing', async () => {
    const { provider, server, requests } = fixture({ bindings: { readContent: undefined } });
    expect(provider.configured).toBe(false);
    expect(provider.readiness).toMatchObject({
      version: 1, scope: 'configuration-only', configured: false,
      required: { endpoint: true, sessionResolver: true, approvedReadTools: true, getSchema: true, resolveBom: true, listRevisions: true, listAttachments: true, readContent: false },
    });
    const response = await request(server, statusPath);
    expect(response.body).toMatchObject({ configured: false, state: 'unconfigured' });
    expect((await request(server, attachmentsPath)).status).toBe(503);
    expect(requests).toHaveLength(0);
  });
  it('exposes configuration presence without invoking deployment callbacks or leaking values', () => {
    const calls = [];
    const uncalled = name => () => { calls.push(name); throw new Error('A configuration report must not probe a callback.'); };
    const secretKey = Buffer.alloc(32, 0x65);
    const provider = createArenaMcpProvider({
      endpoint, connectionKey: secretKey, approvedReadTools: ['private-tenant.read'],
      resolveSession: uncalled('session'), fetch: uncalled('network'),
      bindings: Object.fromEntries(['getSchema', 'resolveBom', 'listRevisions', 'listAttachments', 'readContent'].map(name => [name, uncalled(name)])),
      limits: { maxContentBytes: 1024 },
    });
    expect(provider.readiness).toMatchObject({ version: 1, scope: 'configuration-only', configured: true, deployment: { connectionKeyProvided: true }, limits: { maxContentBytes: 1024 } });
    expect(calls).toEqual([]);
    expect(JSON.stringify(provider.readiness)).not.toMatch(/synthetic-mcp|private-tenant|eeeeeeee|accessToken|sessionId/);
    expect(() => { provider.readiness.required.readContent = false; }).toThrow();
    expect(() => { provider.readiness.limits.maxContentBytes = 100000; }).toThrow();
    expect(provider.maxContentBytes).toBe(1024);
    expect(createArenaMcpProvider().readiness).toMatchObject({ configured: false, deployment: { connectionKeyProvided: false }, required: { endpoint: false, sessionResolver: false, approvedReadTools: false, readContent: false } });
  });
  it('keeps checked mappings and connection identities stable after caller-side configuration mutation', async () => {
    const key = Buffer.alloc(32, 3);
    const { provider, server, bindings } = fixture({ provider: { connectionKey: key } });
    const before = await request(server, statusPath);
    key.fill(7);
    bindings.getSchema = () => { throw new ViewerError('FORBIDDEN'); };
    bindings.readContent = undefined;
    const after = await request(server, statusPath);
    expect(after.body.connectionId).toBe(before.body.connectionId);
    expect(after.body.readiness).toEqual(provider.readiness);
    expect((await request(server, schemaPath)).status).toBe(200);
    const files = await request(server, attachmentsPath);
    expect((await request(server, files.body[0].url)).body).toEqual(bytes);
  });
  it.each(['http://localhost/mcp', 'https://user:secret@example.test/mcp', 'https://example.test/mcp?token=secret', 'file:///mcp'])('rejects unsafe MCP endpoints: %s', endpoint => {
    expect(() => createArenaMcpProvider({ endpoint })).toThrow();
  });
  it('reports a verified user and opaque connection identity without credentials', async () => {
    const { server, requests } = fixture();
    const response = await request(server, statusPath);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: true, transport: 'mcp', readOnly: true, state: 'ready', user: { id: 'alice' }, capabilities: { annotations: false, conditionalWrites: false, supplierItems: false, sourceConversion: false } });
    expect(response.headers['X-Viewer-Connection']).toBe(response.body.connectionId);
    expect(response.body.connectionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-token|grant-alice|arena-alice/);
    expect(requests.some(entry => entry.payload?.method === 'server/discover')).toBe(true);
    expect(requests.every(entry => entry.token === 'Bearer synthetic-token-alice')).toBe(true);
  });
  it('isolates simultaneous users, per-request catalogs and bearer grants', async () => {
    const { server, requests } = fixture({
      state: { tools: token => token.endsWith('bob') ? initialTools.filter(value => value.name !== 'test.suppliers') : initialTools },
      bindings: { listSupplierItems: async (api, query) => api.data(await api.callTool('test.suppliers', query)) },
    });
    const [alice, bob] = await Promise.all([request(server, schemaPath), request(server, schemaPath, { session: session('bob') })]);
    expect(alice.status).toBe(200); expect(bob.status).toBe(200);
    expect(alice.body.name).toBe('Workspace for alice'); expect(bob.body.name).toBe('Workspace for bob');
    expect(alice.headers['X-Viewer-Connection']).not.toBe(bob.headers['X-Viewer-Connection']);
    expect(requests.filter(value => value.payload?.method === 'server/discover')).toHaveLength(2);
    expect(requests.filter(value => value.payload?.method === 'tools/list').map(value => value.token).sort()).toEqual(['Bearer synthetic-token-alice', 'Bearer synthetic-token-bob']);
    const suppliers = '/api/viewer/v1/supplier-items?workspaceId=workspace-1&itemId=item-1&revision=A';
    const [aliceSuppliers, bobSuppliers] = await Promise.all([request(server, suppliers), request(server, suppliers, { session: session('bob') })]);
    expect(aliceSuppliers.status).toBe(200); expect(bobSuppliers.status).toBe(403);
  });
  it('does not treat browser identity headers as authentication', async () => {
    const { server, requests } = fixture();
    const response = await request(server, schemaPath, { session: null, headers: { 'x-user-id': 'alice', 'x-arena-user': 'arena-alice', 'x-workspace-id': 'workspace-1' } });
    expect(response.status).toBe(401); expect(requests).toHaveLength(0);
  });
  it('rejects expired sessions and wrong-workspace requests before MCP access', async () => {
    const { server, requests } = fixture();
    expect((await request(server, schemaPath, { session: session('alice', { expiresAt: Date.now() - 1 }) })).status).toBe(401);
    expect((await request(server, schemaPath, { session: session('alice', { workspaceId: 'another-workspace' }) })).status).toBe(403);
    expect(requests).toHaveLength(0);
  });
  it.each([401, 403])('maps upstream revoked/denied access safely (%s)', async status => {
    const { server } = fixture({ state: { status } });
    const response = await request(server, statusPath);
    expect(response.status).toBe(status);
    expect(JSON.stringify(response.body)).not.toMatch(/do-not-leak|private|token=/);
  });
  it('preserves upstream throttling through the SDK and BFF without an error-body leak', async () => {
    const { server } = fixture({ state: { status: 429 } });
    const response = await request(server, statusPath);
    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(JSON.stringify(response.body)).not.toMatch(/do-not-leak|private|token=/);
  });
  it('rejects a refreshed grant that changes subject or workspace', async () => {
    const { server, requests } = fixture();
    const trusted = session('alice', { accessToken: undefined, getAccessToken: async () => session('bob') });
    const response = await request(server, schemaPath, { session: trusted });
    expect(response.status).toBe(409); expect(response.body.code).toBe('CONNECTION_CHANGED'); expect(requests).toHaveLength(0);
  });
  it('refreshes tokens before each protocol request while retaining the trusted grant', async () => {
    const { server, requests } = fixture();
    let refreshes = 0;
    const trusted = session('alice', { accessToken: undefined, getAccessToken: async () => { refreshes++; return session('alice'); } });
    expect((await request(server, schemaPath, { session: trusted })).status).toBe(200);
    expect(refreshes).toBeGreaterThanOrEqual(requests.length);
  });
  it('blocks another user from reusing a connection guard or source URL', async () => {
    const { server, requests } = fixture();
    const aliceStatus = await request(server, statusPath);
    const before = requests.length;
    const bob = await request(server, schemaPath, { session: session('bob'), headers: { 'x-viewer-connection': aliceStatus.body.connectionId } });
    expect(bob.status).toBe(409); expect(requests).toHaveLength(before);
    const content = buildContentUrl({ workspaceId: 'workspace-1', connectionId: aliceStatus.body.connectionId }, documentSource);
    expect((await request(server, content, { session: session('bob') })).status).toBe(409);
  });
  it('allows only reviewed tools that are advertised to the current user', async () => {
    for (const state of [
      { tools: initialTools.filter(value => value.name !== 'test.schema') },
      { tools: initialTools.map(value => value.name === 'test.schema' ? { ...value, annotations: { readOnlyHint: false } } : value) },
      { tools: initialTools.map(value => value.name === 'test.schema' ? { ...value, annotations: { destructiveHint: true } } : value) },
      { tools: initialTools.map(value => value.name === 'test.schema' ? { ...value, inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', 'x-mcp-header': 'Authorization' } } } } : value) },
    ]) {
      const { server, requests } = fixture({ state });
      const response = await request(server, schemaPath);
      expect(response.status).toBe(403);
      expect(requests.some(value => value.payload?.method === 'tools/call')).toBe(false);
    }
    const { server } = fixture({ bindings: { getSchema: api => api.callTool('unreviewed-tool') } });
    expect((await request(server, schemaPath)).status).toBe(403);
  });
  it('redacts tool failure details and refuses interactive input requests', async () => {
    for (const result of [
      { isError: true, content: [{ type: 'text', text: 'private-token-secret' }] },
      { resultType: 'input_required', inputRequests: { x: { method: 'elicitation/create', params: { message: 'send secret', requestedSchema: { type: 'object', properties: {} } } } } },
    ]) {
      const { server, requests } = fixture({ state: { result: () => result } });
      const response = await request(server, schemaPath);
      expect(response.status).toBe(502); expect(JSON.stringify(response.body)).not.toMatch(/secret|send/);
      expect(requests.filter(value => value.payload?.method === 'tools/call')).toHaveLength(1);
    }
  });
  it('walks empty-string cursors and rejects a looping or oversized catalog', async () => {
    const { server, requests } = fixture({ state: { pages: cursor => cursor === undefined ? { tools: [tool('test.revisions')], nextCursor: '' } : { tools: [tool('test.schema')] } } });
    expect((await request(server, schemaPath)).status).toBe(200);
    expect(requests.filter(value => value.payload?.method === 'tools/list')[1].payload.params.cursor).toBe('');
    const loop = fixture({ state: { pages: () => ({ tools: [tool('test.schema')], nextCursor: '' }) }, provider: { limits: { maxPages: 2 } } });
    expect((await request(loop.server, schemaPath)).status).toBe(502);
    const oversized = fixture({ provider: { limits: { maxTools: 1 } } });
    expect((await request(oversized.server, schemaPath)).status).toBe(502);
  });
  it('maps optional supplier items and preserves false/zero attributes', async () => {
    const { server } = fixture({ bindings: { listSupplierItems: async (api, query) => api.data(await api.callTool('test.suppliers', query)) } });
    const status = await request(server, statusPath);
    expect(status.body.capabilities.supplierItems).toBe(true);
    const response = await request(server, '/api/viewer/v1/supplier-items?workspaceId=workspace-1&itemId=item-1&revision=A');
    expect(response.status).toBe(200); expect(response.body[0].attributes).toEqual({ zero: 0, enabled: false });
  });
  it('does not expose unnormalized upstream fields in successful metadata', async () => {
    const { server } = fixture({ bindings: { getSchema: async () => ({ workspaceId: 'workspace-1', name: 'Workspace', version: '1', attributes: [], upstreamDownload: 'https://private.invalid/?token=secret' }) } });
    const response = await request(server, schemaPath);
    expect(response.status).toBe(502); expect(JSON.stringify(response.body)).not.toMatch(/private.invalid|secret/);
  });
});

describe('protected source content', () => {
  it('returns same-origin exact-edition document links and no-store verified bytes', async () => {
    const { server } = fixture();
    const files = await request(server, attachmentsPath);
    expect(files.status).toBe(200);
    expect(files.body[0].url).toMatch(/^\/api\/viewer\/v1\/content\?/);
    const content = await request(server, files.body[0].url);
    expect(content.status).toBe(200); expect(content.body).toEqual(bytes);
    expect(content.headers['Cache-Control']).toBe('no-store');
    expect(content.headers['X-Viewer-Connection']).toBe(files.headers['X-Viewer-Connection']);
    expect(content.headers['Content-Type']).toBe('application/pdf');
  });
  it('reauthorizes current source access on every content request', async () => {
    const { server, state } = fixture();
    const files = await request(server, attachmentsPath);
    state.status = 403;
    expect((await request(server, files.body[0].url)).status).toBe(403);
    state.status = 200;
    expect((await request(server, files.body[0].url, { session: session('alice', { expiresAt: Date.now() - 1 }) })).status).toBe(401);
    const bobStatus = await request(server, statusPath, { session: session('bob') });
    const bobUrl = buildContentUrl({ workspaceId: 'workspace-1', connectionId: bobStatus.body.connectionId }, documentSource);
    expect((await request(server, bobUrl, { session: session('bob') })).status).toBe(403);
  });
  it('does not substitute a different file edition and rejects arbitrary upstream URLs', async () => {
    const { server } = fixture();
    const files = await request(server, attachmentsPath);
    const badEdition = files.body[0].url.replace('edition=edition-1', 'edition=edition-2');
    expect((await request(server, badEdition)).status).toBe(404);
    expect((await request(server, `${files.body[0].url}&upstreamUrl=https%3A%2F%2Fevil.invalid`)).status).toBe(400);
    expect((await request(server, files.body[0].url.replace(/&connectionId=[^&]+/, ''))).status).toBe(400);
  });
  it('rejects signed upstream document locations at the server boundary', async () => {
    const { server } = fixture({ bindings: { listAttachments: async () => [{ ...documentMetadata, url: 'https://private.invalid/file?token=secret' }] } });
    const response = await request(server, attachmentsPath);
    expect(response.status).toBe(502); expect(JSON.stringify(response.body)).not.toContain('secret');
  });
  it.each([
    [{ bytes: Buffer.from('%PDF-1.7\nchanged') }, 409],
    [{ identity: { ...documentSource, edition: 'another' } }, 409],
    [{ contentType: 'text/html' }, 502],
  ])('rejects mismatched bytes, identities and MIME types', async (change, status) => {
    const { server } = fixture({ bindings: { readContent: async () => ({ identity: documentSource, bytes, contentType: 'application/pdf', ...change }) } });
    const files = await request(server, attachmentsPath);
    expect((await request(server, files.body[0].url)).status).toBe(status);
  });
  it('enforces size limits and explicitly unavailable CAD conversion', async () => {
    const { server } = fixture({ provider: { limits: { maxContentBytes: 2 } } });
    const files = await request(server, attachmentsPath);
    expect((await request(server, files.body[0].url)).status).toBe(413);
    const mesh = files.body[0].url.replace('kind=pdf', `kind=mesh&contentHash=${hash}`);
    expect((await request(server, mesh)).status).toBe(501);
  });
  it('allows approved MCP resource reads only through the scoped client', async () => {
    const readContent = async (api, identity) => {
      const result = await api.readResource('arena-test://workspace-1/file-1/edition-1');
      return { identity, bytes: Buffer.from(result.contents[0].blob, 'base64'), contentType: result.contents[0].mimeType };
    };
    const denied = fixture({ bindings: { readContent } });
    const deniedFiles = await request(denied.server, attachmentsPath);
    expect((await request(denied.server, deniedFiles.body[0].url)).status).toBe(403);
    const allowed = fixture({ bindings: { readContent }, provider: { approvedResourceUri: (uri, context) => uri === 'arena-test://workspace-1/file-1/edition-1' && context.userId === 'alice' } });
    const allowedFiles = await request(allowed.server, attachmentsPath);
    expect((await request(allowed.server, allowedFiles.body[0].url)).status).toBe(200);
  });
  it('accepts child meshes derived from an exact root assembly source and rejects cross-file pairs', async () => {
    const stepBytes = Buffer.from('ISO-10303-21;\nEND-ISO-10303-21;');
    const sourceHash = createHash('sha256').update(stepBytes).digest('hex');
    const source = { fileId: 'assembly-step', itemId: 'item-1', revision: 'A', edition: 'step-edition-1', sourceHash, kind: 'step' };
    let wrongFile = false;
    const resolveBom = async (api, query) => ({
      id: 'snapshot-A', workspaceId: 'workspace-1', rootItemId: query.itemId, revision: query.revision, configurationId: 'frozen-A',
      parts: [{ id: 'child-item', revision: 'child-C', sourceHash, displaySource: 'mesh', stepUrl: api.contentUrl(source), meshUrl: api.contentUrl({ ...source, kind: 'mesh', contentHash: hash, fileId: wrongFile ? 'another-step' : source.fileId }) }],
      occurrences: [{ id: 'occurrence-1', partId: 'child-item', partRevision: 'child-C' }],
      documents: [], modelSources: [{ id: source.fileId, itemId: source.itemId, revision: source.revision, edition: source.edition, sourceHash, occurrenceIds: ['occurrence-1'] }],
    });
    const { server } = fixture({ bindings: { resolveBom } });
    const path = '/api/viewer/v1/bom?workspaceId=workspace-1&itemId=item-1&revision=A';
    expect((await request(server, path)).status).toBe(200);
    wrongFile = true;
    const response = await request(server, path);
    expect(response.status).toBe(409); expect(response.body.code).toBe('SOURCE_CHANGED');
  });
});

describe('raw STEP source-to-part mapping boundary', () => {
  const sourceHash = createHash('sha256').update('ISO-10303-21;\nEND-ISO-10303-21;').digest('hex');
  const source = { fileId: 'assembly-step', itemId: 'item-1', revision: 'A', edition: 'step-edition-1', sourceHash, kind: 'step' };
  const identity = { position: [0, 0, 0], rotation: [0, 0, 0] };
  const path = '/api/viewer/v1/bom?workspaceId=workspace-1&itemId=item-1&revision=A';
  function mappedRequest(overrides = [{}]) {
    const { server } = fixture({ bindings: { resolveBom: async api => ({
      id: 'mapped-snapshot', workspaceId: 'workspace-1', rootItemId: 'item-1', revision: 'A', configurationId: 'frozen-A',
      parts: overrides.map((changes, index) => ({
        id: `child-${index}`, revision: 'C', sourceHash, stepUrl: api.contentUrl(source),
        cadNodePath: [0, index], sourceToPart: identity,
        ...(changes.displaySource === 'mesh' ? { meshUrl: api.contentUrl({ ...source, kind: 'mesh', contentHash: hash }) } : {}),
        ...changes,
      })),
      occurrences: overrides.map((_, index) => ({ id: `occ-${index}`, partId: `child-${index}`, partRevision: 'C' })),
      documents: [], modelSources: [{ id: source.fileId, itemId: source.itemId, revision: source.revision, edition: source.edition, sourceHash, occurrenceIds: overrides.map((_, index) => `occ-${index}`) }],
    }) } });
    return request(server, path);
  }

  it.each([[], [0, 5]].map(cadNodePath => ({ cadNodePath })))('requires a source-to-part map for explicit CAD path %j', async ({ cadNodePath }) => {
    const response = await mappedRequest([{ cadNodePath, sourceToPart: undefined }]);
    expect(response.status).toBe(502); expect(response.body.code).toBe('UPSTREAM_ERROR');
  });
  it('still requires a CAD path when a raw source belongs to a different item', async () => {
    expect((await mappedRequest([{ cadNodePath: undefined }])).status).toBe(502);
  });
  it.each([
    { cadNodePath: [], sourceToPart: identity },
    { cadNodePath: [0, 5], sourceToPart: { position: [75, 45, -8], rotation: [0.2, -Math.PI / 2, Math.PI] } },
    { cadNodePath: [19999], sourceToPart: identity },
  ])('preserves an explicit finite mapping %j', async mapping => {
    const response = await mappedRequest([mapping]);
    expect(response.status).toBe(200);
    expect(response.body.parts[0].cadNodePath).toEqual(mapping.cadNodePath);
    expect(response.body.parts[0].sourceToPart).toEqual(mapping.sourceToPart);
    expect(response.body.parts[0].meshUrl).toBeUndefined();
  });
  it.each([
    null,
    { rotation: [0, 0, 0] },
    { position: [0, 0, 0] },
    { position: [0, 0], rotation: [0, 0, 0] },
    { position: [0, 0, 0], rotation: [0, 0, 0, 0] },
    { position: [0, '1', 0], rotation: [0, 0, 0] },
    { position: [0, NaN, 0], rotation: [0, 0, 0] },
    { position: [0, 0, 0], rotation: [0, Infinity, 0] },
    { position: new Array(3), rotation: [0, 0, 0] },
    { ...identity, scale: 1 },
    { ...identity, matrix: [1, 0, 0, 1] },
    { ...identity, units: 'mm' },
  ])('rejects invalid or ambiguous source frames %j', async sourceToPart => {
    const response = await mappedRequest([{ sourceToPart }]);
    expect(response.status).toBe(502); expect(response.body.code).toBe('UPSTREAM_ERROR');
  });
  it('rejects a source-frame transform on a precomputed mesh derivative', async () => {
    expect((await mappedRequest([{ displaySource: 'mesh', cadNodePath: undefined }])).status).toBe(502);
  });
  it.each([[20000], [-1], [0.5], Array(65).fill(0), new Array(1)].map(cadNodePath => ({ cadNodePath })))('rejects a CAD path outside the importer bounds %j', async ({ cadNodePath }) => {
    expect((await mappedRequest([{ cadNodePath }])).status).toBe(502);
  });
  it('accepts disjoint subtrees from one exact assembly source', async () => {
    expect((await mappedRequest([{ cadNodePath: [0, 1] }, { cadNodePath: [0, 2] }])).status).toBe(200);
  });
  it.each([
    [[0, 1], [0, 1]],
    [[0], [0, 1]],
    [[], [0, 1]],
  ])('continues rejecting overlapping subtrees %j', async (first, second) => {
    expect((await mappedRequest([{ cadNodePath: first }, { cadNodePath: second }])).status).toBe(502);
  });
});

describe('bounded transport helpers', () => {
  it('preserves typed throttling failures without inferring status from upstream prose', () => {
    for (const error of [{ status: 429, message: 'private retry token' }, { statusCode: 429, message: 'private retry token' }, new Error('SDK wrapper', { cause: new ViewerError('RATE_LIMITED') })]) {
      expect(safeError(error)).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
      expect(JSON.stringify(safeError(error))).not.toContain('private retry token');
    }
    expect(safeError(new Error('HTTP 429 private upstream message'))).toMatchObject({ status: 502, body: { code: 'UPSTREAM_ERROR' } });
  });
  it('returns throttling immediately even if cancelling its optional error body stalls', async () => {
    const response = new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 429 });
    const guarded = createGuardedMcpFetch(endpoint, async () => response);
    await expect(guarded(endpoint)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('distinguishes the documented workspace feature code without exposing upstream details', async () => {
    for (const body of [{ code: 'feature_not_enabled', message: 'private upstream detail' }, { error: 'feature_not_enabled' }, { error: { code: 'feature_not_enabled' } }]) {
      const guarded = createGuardedMcpFetch(endpoint, async () => new Response(JSON.stringify(body), { status: 403, headers: { 'Content-Type': 'application/json' } }));
      await expect(guarded(endpoint)).rejects.toMatchObject({ code: 'FEATURE_NOT_ENABLED' });
    }
    const prose = createGuardedMcpFetch(endpoint, async () => new Response('feature_not_enabled', { status: 403, headers: { 'Content-Type': 'text/plain' } }));
    await expect(prose(endpoint)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const oversized = createGuardedMcpFetch(endpoint, async () => new Response(JSON.stringify({ code: 'feature_not_enabled', detail: 'x'.repeat(17000) }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    await expect(oversized(endpoint)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('will not forward credentials to another URL or follow a redirect', async () => {
    let calls = 0;
    const guarded = createGuardedMcpFetch(endpoint, async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }); });
    await expect(guarded('https://elsewhere.invalid/', { headers: { Authorization: 'Bearer secret' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toBe(0);
    await expect(guarded(endpoint)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toBe(1);
  });
  it('bounds MCP response bytes even without Content-Length', async () => {
    const guarded = createGuardedMcpFetch(endpoint, async () => new Response('oversized content'), { maxBytes: 4 });
    const response = await guarded(endpoint);
    await expect(response.text()).rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' });
  });
  it('fails a bounded business-data walk instead of returning a partial BOM', async () => {
    const values = await collectPages(async cursor => cursor === undefined ? { items: [1], nextCursor: '' } : { items: [2], total: 2 });
    expect(values).toEqual([1, 2]);
    await expect(collectPages(async () => ({ items: [1], nextCursor: '' }))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    await expect(collectPages(async () => ({ items: [1], total: 2 }))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    await expect(collectPages(async () => ({ items: [1], complete: false }))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
  it('accepts structured arrays/scalars, while rejecting unstructured prose', () => {
    expect(unwrapToolResult({ structuredContent: [0, false], content: [] })).toEqual([0, false]);
    expect(unwrapToolResult({ structuredContent: false })).toBe(false);
    expect(unwrapToolResult({ content: [{ type: 'text', text: '[1,2]' }] })).toEqual([1, 2]);
    expect(() => unwrapToolResult({ content: [{ type: 'text', text: 'private prose' }] })).toThrow();
  });
  it('keeps original STEP and derivative hashes distinct', () => {
    const mesh = Buffer.from(JSON.stringify({ positions: [0, 0, 0] }));
    const contentHash = createHash('sha256').update(mesh).digest('hex');
    const identity = { ...documentSource, kind: 'mesh', contentHash };
    expect(validateContentResult({ identity, bytes: mesh, contentType: 'application/json' }, identity).bytes).toEqual(mesh);
    expect(() => buildContentUrl({ workspaceId: 'w', connectionId: 'verified-connection-generation' }, { ...identity, contentHash: undefined })).toThrow();
  });
});
