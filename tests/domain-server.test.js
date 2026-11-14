import { describe, it, expect } from 'vitest';
import { createViewerServer } from '../server/index.mjs';

function request(server, path, method = 'GET', incomingHeaders = {}) {
  return new Promise(resolve => {
    const headers = {};
    let status;
    server.emit('request', { url: path, method, headers: incomingHeaders }, {
      setHeader(key, value) { headers[key] = value; },
      writeHead(code) { status = code; },
      end(body) { resolve({ status, headers, body: JSON.parse(body) }); },
    });
  });
}
describe('Arena service authorization boundary', () => {
  it('reports unconfigured and never falls back to fixtures', async () => {
    const server = createViewerServer();
    const status = await request(server, '/api/viewer/v1/status?workspaceId=w');
    expect(status.status).toBe(200); expect(status.body).toMatchObject({ configured: false, transport: 'mcp', state: 'unconfigured', readOnly: true });
    const bom = await request(server, '/api/viewer/v1/bom?workspaceId=w&itemId=i&revision=A');
    expect(bom.status).toBe(503); expect(bom.body.occurrences).toBeUndefined();
    expect(bom.headers['Cache-Control']).toBe('no-store');
  });
  it('checks human identity and workspace before resolving files or schema', async () => {
    let called = false;
    const provider = { authorize: async () => null, getSchema: async () => { called = true; } };
    expect((await request(createViewerServer(provider), '/api/viewer/v1/schema?workspaceId=w')).status).toBe(401);
    provider.authorize = async () => ({ userId: 'user', workspaceId: 'another' });
    expect((await request(createViewerServer(provider), '/api/viewer/v1/schema?workspaceId=w')).status).toBe(403);
    expect(called).toBe(false);
  });
  it('requires an exact revision and forwards configuration identity', async () => {
    let received;
    const server = createViewerServer({
      authorize: async () => ({ userId: 'human', workspaceId: 'w', connectionId: 'verified-connection-generation' }),
      resolveBom: async (context, query) => { received = { context, query }; return { id: 'frozen' }; },
    });
    expect((await request(server, '/api/viewer/v1/bom?workspaceId=w&itemId=i')).status).toBe(400);
    const response = await request(server, '/api/viewer/v1/bom?workspaceId=w&itemId=i&revision=B&configurationId=frozen-id');
    expect(response.status).toBe(200);
    expect(received).toEqual({ context: { userId: 'human', workspaceId: 'w', connectionId: 'verified-connection-generation' }, query: { itemId: 'i', revision: 'B', configurationId: 'frozen-id' } });
    expect(response.headers['X-Viewer-Connection']).toBe('verified-connection-generation');
  });
  it('redacts upstream error details and rejects unimplemented writes', async () => {
    const server = createViewerServer({ authorize: async () => { throw new Error('session-secret-123'); } });
    const failure = await request(server, '/api/viewer/v1/status?workspaceId=w');
    expect(failure.status).toBe(502); expect(JSON.stringify(failure.body)).not.toContain('session-secret');
    expect((await request(server, '/api/viewer/v1/reviews', 'PUT')).status).toBe(405);
  });
  it.each([
    '/schema?workspaceId=w&workspaceId=another',
    '/bom?workspaceId=w&itemId=i&revision=A&revision=B',
    '/bom?workspaceId=w&itemId=i&revision=%00',
    '/schema?workspaceId=%E0%A4%A',
    '/schema?workspaceId=%20w',
    '/schema?workspaceId=w&tool=delete',
    '/schema?workspaceId=w&upstreamUrl=https%3A%2F%2Fexample.test',
    '/schema?workspaceId=',
  ])('rejects malformed or ambiguous requests before authorization: %s', async path => {
    let called = false;
    const server = createViewerServer({ authorize: async () => { called = true; } });
    expect((await request(server, `/api/viewer/v1${path}`)).status).toBe(400);
    expect(called).toBe(false);
  });
  it('rejects stale connection guards and does not resolve source data', async () => {
    let called = false;
    const provider = { authorize: async () => ({ userId: 'human', workspaceId: 'w', connectionId: 'verified-connection-generation' }), getSchema: async () => { called = true; } };
    const response = await request(createViewerServer(provider), '/api/viewer/v1/schema?workspaceId=w', 'GET', { 'x-viewer-connection': 'other-connection-generation' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONNECTION_CHANGED');
    expect(called).toBe(false);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('does not expose write operations (%s)', async method => {
    const response = await request(createViewerServer(), '/api/viewer/v1/reviews', method);
    expect(response.status).toBe(405);
    expect(response.headers.Allow).toBe('GET');
    expect(response.body.code).toBe('METHOD_NOT_ALLOWED');
  });
  it('reports unsupported supplier mappings explicitly', async () => {
    const provider = { authorize: async () => ({ userId: 'human', workspaceId: 'w', connectionId: 'verified-connection-generation' }) };
    const response = await request(createViewerServer(provider), '/api/viewer/v1/supplier-items?workspaceId=w&itemId=i&revision=A');
    expect(response.status).toBe(501);
    expect(response.body.code).toBe('UNSUPPORTED');
  });
  it('reports the separate OAuth setup state without requiring MCP bindings', async () => {
    const response = await request(createViewerServer(), '/api/viewer/v1/auth/status');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: false, connected: false, state: 'unconfigured' });
    expect((await request(createViewerServer(), '/api/viewer/v1/auth/login')).status).toBe(503);
  });
  it('delegates exact OAuth paths before the read-only data gate, including logout POST', async () => {
    const received = [];
    const provider = { configured: false, oauthAuth: { async handleRequest(req, res) {
      received.push({ path: req.url, method: req.method });
      res.writeHead(200);
      res.end(JSON.stringify({ configured: true, connected: false }));
      return true;
    } } };
    const server = createViewerServer(provider);
    expect((await request(server, '/api/viewer/v1/auth/status')).body.configured).toBe(true);
    expect((await request(server, '/api/viewer/v1/auth/logout', 'POST')).status).toBe(200);
    expect(received).toEqual([{ path: '/api/viewer/v1/auth/status', method: 'GET' }, { path: '/api/viewer/v1/auth/logout', method: 'POST' }]);
    expect((await request(server, '/api/viewer/v1/auth/arbitrary')).status).toBe(404);
    expect(received).toHaveLength(2);
    expect((await request(server, '/api/viewer/v1/reviews', 'POST')).status).toBe(405);
  });
});
