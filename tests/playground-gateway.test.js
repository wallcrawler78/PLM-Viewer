import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createViewerServer } from '../server/index.mjs';
import { createPlaygroundGateway, loadConfiguredPlayground } from '../server/playground.mjs';
import { validateAssistantRequest, validateAssistantPlan, ASSISTANT_PLAN_SCHEMA } from '../server/playground-contract.mjs';
import { createAnthropicAssistant } from '../server/playground-provider.mjs';

const source = { id: 'occ-a', name: 'Bracket', itemId: 'item-a', itemNumber: '100-01', revision: 'A', sourceHash: 'a'.repeat(64), sourceId: 'occ-a', kind: 'source', position: [0, 0, 0], rotation: [0, 0, 0], color: '#999999' };
const body = () => ({ proposalId: 'p1', proposalVersion: 0, sourceKey: 'source-key', context: { workspaceId: 'w', snapshotId: 'snap', rootItemId: 'assembly', itemNumber: '100', name: 'Assembly', revision: 'A', sourceMode: 'preview' }, prompt: 'Move selected bracket 10 mm upward', selectedId: 'occ-a', baseline: [structuredClone(source)], nodes: [structuredClone(source)], annotations: [] });
const plan = () => ({ summary: 'Move bracket up 10 mm.', commands: [{ type: 'transform', nodeId: 'occ-a', position: [0, 0, 10] }], assumptions: [], questions: [], display: {} });
const assistant = () => ({ provider: 'anthropic', model: 'claude-fable-5-2', propose: vi.fn(async () => plan()) });
const gateway = (a = assistant(), extra = {}) => createPlaygroundGateway({ assistant: a, allowedOrigin: 'http://localhost:5173', allowLocalPreview: true, ...extra });
function request(server, path, payload, extra = {}) {
  return new Promise(resolve => {
    const raw = payload === undefined ? [] : [Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))];
    const req = Readable.from(raw);
    Object.assign(req, { url: path, method: payload === undefined ? 'GET' : 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json', 'x-playground-request': '1', ...extra.headers }, socket: { remoteAddress: extra.remoteAddress ?? '127.0.0.1' } });
    const headers = {}, res = new EventEmitter(); let status;
    Object.assign(res, { setHeader(key, value) { headers[key] = value; }, writeHead(code) { status = code; this.headersSent = true; }, end(value) { this.writableEnded = true; resolve({ status, headers, body: JSON.parse(value) }); } });
    server.emit('request', req, res);
  });
}
const statusPath = '/api/viewer/v1/playground/status?sourceMode=preview&workspaceId=w';
const proposePath = '/api/viewer/v1/playground/propose';

describe('Playground optional gateway', () => {
  it('is unconfigured by default, reports no live ECR and does not call AI', async () => {
    const server = createViewerServer();
    expect((await request(server, statusPath)).body).toMatchObject({ configured: false, available: false, liveEcr: false });
    expect((await request(server, proposePath, body())).status).toBe(503);
    expect(loadConfiguredPlayground({ PLAYGROUND_ANTHROPIC_API_KEY: 'unused-test-key' })).toBeNull();
  });
  it('requires exact server origin and explicit loopback Preview opt-in', async () => {
    const a = assistant(), server = createViewerServer(null, gateway(a));
    for (const headers of [{ origin: 'https://other.test' }, { origin: undefined }, { 'x-playground-request': undefined }, { 'sec-fetch-site': 'cross-site' }]) expect((await request(server, proposePath, body(), { headers })).status).toBe(403);
    expect((await request(server, proposePath, body(), { remoteAddress: '10.2.3.4' })).status).toBe(403);
    expect((await request(createViewerServer(null, gateway(a, { allowLocalPreview: false })), proposePath, body())).status).toBe(403);
    expect(a.propose).not.toHaveBeenCalled();
    expect(() => gateway(a, { allowedOrigin: 'https://viewer.example', allowLocalPreview: true })).toThrow();
  });
  it('returns version-bound plans and separate display instructions', async () => {
    const a = assistant(), server = createViewerServer(null, gateway(a));
    const ready = await request(server, statusPath);
    expect(ready.body).toMatchObject({ available: true, model: 'claude-fable-5-2', imagesAllowed: false, liveEcr: false });
    a.propose.mockResolvedValueOnce({ summary: 'Explode for inspection.', commands: [], assumptions: [], questions: [], display: { explode: 1, labels: true } });
    const result = await request(server, proposePath, body());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ proposalId: 'p1', proposalVersion: 0, sourceKey: 'source-key', commands: [], display: { explode: 1 } });
    expect(result.body.requestId).toMatch(/^[a-f\d-]{36}$/);
  });
  it('requires current human/workspace and explicit external-AI sharing authorization for Arena', async () => {
    const a = assistant();
    const provider = { authorize: vi.fn(async () => ({ userId: 'u', workspaceId: 'w', connectionId: 'verified-user-connection' })) };
    const value = body(); value.context.sourceMode = 'arena';
    const server = createViewerServer(provider, gateway(a));
    expect((await request(server, proposePath, value)).status).toBe(409);
    const headers = { 'x-viewer-connection': 'verified-user-connection' };
    expect((await request(server, proposePath, value, { headers })).status).toBe(403);
    provider.authorizePlaygroundAI = vi.fn(async () => ({ allowed: true, allowImages: false }));
    expect((await request(server, proposePath, value, { headers })).status).toBe(200);
    expect(provider.authorizePlaygroundAI.mock.calls[0][1]).toMatchObject({ phase: 'propose', context: { rootItemId: 'assembly', revision: 'A' }, includesImage: false });
    value.context.workspaceId = 'other';
    expect((await request(server, proposePath, value, { headers })).status).toBe(403);
    expect(a.propose).toHaveBeenCalledTimes(1);
  });
  it('rejects scripts, unknown geometry, source-geometry resize and unresolved mixed plans', () => {
    for (const commands of [[{ type: 'eval', code: 'alert(1)' }], [{ type: 'transform', nodeId: 'missing', position: [0, 0, 1] }], [{ type: 'resize', nodeId: 'occ-a', dimensions: { width: 10, depth: 10, height: 3 } }]]) expect(() => validateAssistantPlan({ ...plan(), commands }, body())).toThrow('INVALID_PLAN');
    expect(() => validateAssistantPlan({ ...plan(), questions: ['How far?'] }, body())).toThrow('INVALID_PLAN');
    expect(() => validateAssistantRequest({ ...body(), endpoint: 'https://elsewhere.test' })).toThrow();
    expect(() => validateAssistantRequest({ ...body(), nodes: Array(201).fill(source) })).toThrow();
    expect(() => validateAssistantRequest({ ...body(), baseline: [{ ...source, revision: 'wrong' }] })).toThrow();
  });
  it('enforces bounded bodies before model calls and returns public errors only', async () => {
    const a = assistant(), server = createViewerServer(null, gateway(a));
    expect((await request(server, proposePath, body(), { headers: { 'content-length': '99999999' } })).status).toBe(413);
    expect((await request(server, proposePath, '{bad-json')).status).toBe(400);
    a.propose.mockRejectedValueOnce(new Error('secret-key-and-upstream-body'));
    const response = await request(server, proposePath, body());
    expect(response.status).toBe(502); expect(JSON.stringify(response)).not.toContain('secret-key');
  });
  it('bounds stalled providers and rejects simultaneous requests from the same user', async () => {
    const a = assistant(); a.propose.mockImplementation(() => new Promise(() => {}));
    const server = createViewerServer(null, gateway(a, { timeoutMs: 30 }));
    const pending = request(server, proposePath, body());
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await request(server, proposePath, body())).status).toBe(429);
    expect((await pending).status).toBe(504);
  });
  it('checks the explicit image policy and exact page context', async () => {
    const value = { ...body(), image: 'data:image/png;base64,iVBORw0KGgoAAAAA', imageContext: { kind: 'document', fileId: 'f', itemId: 'i', revision: 'A', edition: '1', sourceHash: 'a'.repeat(64), page: 2 } };
    const a = assistant();
    expect((await request(createViewerServer(null, gateway(a)), proposePath, value)).status).toBe(403);
    expect((await request(createViewerServer(null, gateway(a, { allowImages: true })), proposePath, value)).status).toBe(200);
    expect(a.propose.mock.calls[0][0].imageContext.page).toBe(2);
    expect(() => validateAssistantRequest({ ...value, imageContext: undefined })).toThrow();
  });
  it('stamps AI provenance and rejects shape properties that would be ignored by geometry', async () => {
    const a = assistant();
    const box = { id: 'concept-box', name: 'Concept enclosure', kind: 'box', color: '#33aa88', position: [0, 0, 0], rotation: [0, 0, 0], dimensions: { width: 50, depth: 30, height: 20 } };
    a.propose.mockResolvedValueOnce({ summary: 'Add a concept enclosure.', commands: [{ type: 'add', node: box }], assumptions: ['Dimensions are proposed for review.'], questions: [], display: {} });
    const response = await request(createViewerServer(null, gateway(a)), proposePath, body());
    expect(response.body.commands[0].node.provenance).toEqual({ kind: 'ai', assumptions: ['Dimensions are proposed for review.'] });
    expect(() => validateAssistantPlan({ ...plan(), commands: [{ type: 'add', node: { ...box, dimensions: { ...box.dimensions, holeDiameter: 5 } } }] }, body())).toThrow('INVALID_PLAN');
  });
  it('binds model screenshot presentation without treating explosion as an installed pose', () => {
    const value = { ...body(), image: 'data:image/png;base64,iVBORw0KGgoAAAAA', imageContext: { kind: 'model', camera: { position: [100, -100, 100], target: [0, 0, 0] }, presentation: { view: 'overlay', explode: 0.7, labels: true, hiddenIds: [], opacityById: { 'occ-a': 0.3 } } } };
    expect(validateAssistantRequest(value).imageContext.presentation.explode).toBe(0.7);
    expect(() => validateAssistantRequest({ ...value, imageContext: { ...value.imageContext, presentation: { hiddenIds: ['not-a-source'] } } })).toThrow();
  });
  it('preserves bounded scene and aspect identity for view-specific annotations', () => {
    const value = { ...body(), annotations: [{ id: 'mark-1', type: 'arrow', label: 'Move here', color: '#55aa88', points: [[0.1, 0.2], [0.3, 0.4]], target: { type: 'view', camera: { position: [100, -100, 100], target: [0, 0, 0], aspect: 1.5 }, sceneKey: 'exact-presentation-v1', geometryKey: 'mesh-shape-v1' }, createdAt: '2026-11-14T00:00:00.000Z' }] };
    expect(validateAssistantRequest(value).annotations[0].target.sceneKey).toBe('exact-presentation-v1');
    const invalid = structuredClone(value); invalid.annotations[0].target.camera.aspect = 0;
    expect(() => validateAssistantRequest(invalid)).toThrow();
    invalid.annotations[0].target.camera.aspect = 1; invalid.annotations[0].target.sceneKey = 'unsafe\nkey';
    expect(() => validateAssistantRequest(invalid)).toThrow();
  });
});

describe('Anthropic data-only adapter', () => {
  it('uses a fixed Messages endpoint, current structured-output shape and no executable tools', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(plan()) }] }), { headers: { 'content-type': 'application/json' } }));
    const adapter = createAnthropicAssistant({ apiKey: 'server-test-secret', fetcher });
    expect(await adapter.propose(body())).toMatchObject({ commands: plan().commands });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('server-test-secret');
    const sent = JSON.parse(options.body);
    expect(sent.model).toBe('claude-fable-5-2');
    expect(sent.output_config.format).toEqual({ type: 'json_schema', schema: ASSISTANT_PLAN_SCHEMA });
    for (const key of ['temperature', 'top_p', 'top_k', 'tools', 'tool_choice']) expect(sent[key]).toBeUndefined();
    expect(JSON.stringify(sent.messages)).not.toContain('server-test-secret');
    expect(JSON.stringify(sent.output_config)).not.toContain('maxItems');
  });
  it('rejects truncation, refusal, malformed output and unsafe upstream errors', async () => {
    for (const stop_reason of ['max_tokens', 'refusal']) {
      const adapter = createAnthropicAssistant({ apiKey: 'secret', fetcher: async () => new Response(JSON.stringify({ stop_reason, content: [{ type: 'text', text: JSON.stringify(plan()) }] }), { headers: { 'content-type': 'application/json' } }) });
      await expect(adapter.propose(body())).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    }
    const adapter = createAnthropicAssistant({ apiKey: 'secret', fetcher: async () => new Response('sensitive-provider-error', { status: 401 }) });
    await expect(adapter.propose(body())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
