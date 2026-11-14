/** Actual SDK + transport regression tests over synthetic HTTP responses. No Arena endpoint is assumed. */
import { describe, expect, it } from 'vitest';
import { createArenaMcpProvider } from '../server/mcp-provider.mjs';

const ENDPOINT = 'https://sdk-wire-fixture.invalid/mcp';
const WORKSPACE = 'sdk-fixture-workspace';
const SCHEMA = { workspaceId: WORKSPACE, name: 'Synthetic schema', version: '1', attributes: [] };
const SERVER_INFO = { name: 'sdk-wire-fixture', version: '1' };

/** Uses the installed Client/StreamableHTTPClientTransport; deliberately does not inject clientFactory. */
function wireFixture(scenario = 'modern', limits = {}) {
  const state = { requests: [], tokenReads: 0, listCalls: 0, normalized: 0, aborted: false };
  const principal = {
    userId: 'viewer-fixture', arenaUserId: 'arena-fixture', workspaceId: WORKSPACE,
    sessionId: 'fixture-session', expiresAt: Date.now() + 60_000,
  };
  const fetcher = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    const method = init.method ?? request?.method ?? 'GET';
    const headers = new Headers(init.headers ?? request?.headers);
    expect(url).toBe(ENDPOINT);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(headers.get('authorization')).toMatch(/^Bearer fixture-token-\d+$/);
    if (method === 'GET') {
      state.requests.push({ method: 'HTTP GET', authorization: headers.get('authorization') });
      return new Response(null, { status: 405 });
    }
    const body = JSON.parse(init.body ?? await request.text());
    state.requests.push({ method: body.method, authorization: headers.get('authorization'), cursor: body.params?.cursor });
    const reply = result => new Response(JSON.stringify({
      jsonrpc: '2.0', id: body.id,
      result: scenario === 'legacy' ? result : {
        resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }, ...result,
      },
    }), { headers: { 'Content-Type': 'application/json' } });

    if (body.method === 'server/discover') {
      if (scenario === 'legacy') return new Response(null, { status: 404 });
      return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' });
    }
    if (body.method === 'initialize') {
      expect(scenario).toBe('legacy');
      return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') {
      state.listCalls++;
      const tool = {
        name: state.listCalls === 1 ? 'fixture.read' : `fixture.page.${state.listCalls}`,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', required: ['workspaceId', 'attributes'], properties: { workspaceId: { const: WORKSPACE }, attributes: { type: 'array' } } },
        annotations: { readOnlyHint: true, destructiveHint: false },
      };
      const page = { tools: [tool], ttlMs: 0, cacheScope: 'private' };
      if (scenario === 'pagination') {
        if (state.listCalls === 1) return reply({ ...page, nextCursor: '' });
        if (state.listCalls === 2) {
          expect(body.params.cursor).toBe('');
          return reply({ ...page, nextCursor: 'last-page' });
        }
        expect(body.params.cursor).toBe('last-page');
      }
      return reply(page);
    }
    if (body.method === 'tools/call') {
      expect(body.params.name).toBe('fixture.read');
      if (['unauthorized', 'forbidden', 'rate-limited'].includes(scenario)) {
        return new Response('private-upstream-body-must-not-leak', { status: { unauthorized: 401, forbidden: 403, 'rate-limited': 429 }[scenario] });
      }
      if (scenario === 'input-required') return reply({ resultType: 'input_required', requestState: 'opaque-fixture-state' });
      if (scenario === 'tool-error') return reply({ isError: true, content: [{ type: 'text', text: 'private-upstream-body-must-not-leak' }] });
      if (scenario === 'invalid-output') return reply({ content: [], structuredContent: { ...SCHEMA, attributes: 'invalid-output-shape' } });
      if (scenario === 'timeout') {
        return await new Promise((resolve, reject) => {
          // The slow response keeps an event-loop handle alive; the provider must abort it first.
          const timer = setTimeout(() => { init.signal.removeEventListener('abort', abort); resolve(reply({ content: [], structuredContent: SCHEMA })); }, 2_000);
          function abort() { clearTimeout(timer); state.aborted = true; reject(init.signal.reason); }
          if (init.signal.aborted) abort();
          else init.signal.addEventListener('abort', abort, { once: true });
        });
      }
      return reply({ content: [], structuredContent: SCHEMA });
    }
    throw new Error(`Unexpected synthetic MCP method: ${body.method}`);
  };
  const binding = async api => {
    const data = api.data(await api.callTool('fixture.read', {}));
    state.normalized++;
    return data;
  };
  const provider = createArenaMcpProvider({
    endpoint: ENDPOINT, fetch: fetcher,
    resolveSession: async () => ({
      ...principal,
      getAccessToken: async () => ({ ...principal, accessToken: `fixture-token-${++state.tokenReads}` }),
    }),
    approvedReadTools: ['fixture.read'],
    bindings: {
      getSchema: binding, resolveBom: binding, listRevisions: binding, listAttachments: binding,
      // This fixture exercises metadata transport only; file cases are in mcp-provider.test.js.
      readContent: async () => { throw new Error('This synthetic wire fixture has no file source.'); },
    },
    limits: { timeoutMs: 2_000, maxPages: 3, ...limits },
  });
  return {
    state,
    async load() { return provider.getSchema(await provider.authorize({})); },
  };
}

describe('installed MCP SDK wire compatibility', () => {
  it('negotiates the modern protocol and obtains a fresh token for every request', async () => {
    const { load, state } = wireFixture();
    await expect(load()).resolves.toEqual(SCHEMA);
    expect(state.requests.map(request => request.method)).toEqual(['server/discover', 'tools/list', 'tools/call']);
    expect(new Set(state.requests.map(request => request.authorization)).size).toBe(state.requests.length);
    expect(state.tokenReads).toBeGreaterThanOrEqual(state.requests.length);
    expect(state.normalized).toBe(1);
  });

  it('falls back to a legacy initialize handshake without changing the user token boundary', async () => {
    const { load, state } = wireFixture('legacy');
    await expect(load()).resolves.toEqual(SCHEMA);
    expect(state.requests.filter(request => request.method !== 'HTTP GET').map(request => request.method)).toEqual([
      'server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call',
    ]);
    expect(new Set(state.requests.map(request => request.authorization)).size).toBe(state.requests.length);
    expect(state.normalized).toBe(1);
  });

  it('walks a modern catalog through an opaque empty-string cursor', async () => {
    const { load, state } = wireFixture('pagination');
    await expect(load()).resolves.toEqual(SCHEMA);
    expect(state.requests.filter(request => request.method === 'tools/list').map(request => request.cursor)).toEqual([undefined, '', 'last-page']);
    expect(state.normalized).toBe(1);
  });

  it('caps catalog pagination before invoking a tool', async () => {
    const { load, state } = wireFixture('pagination', { maxPages: 2 });
    await expect(load()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(state.listCalls).toBe(2);
    expect(state.requests.some(request => request.method === 'tools/call')).toBe(false);
    expect(state.normalized).toBe(0);
  });

  it.each([
    ['unauthorized', 'UNAUTHENTICATED'],
    ['forbidden', 'FORBIDDEN'],
    ['rate-limited', 'RATE_LIMITED'],
    ['tool-error', 'UPSTREAM_ERROR'],
  ])('redacts %s responses before normalizing data', async (scenario, code) => {
    const { load, state } = wireFixture(scenario);
    const failure = await load().catch(error => error);
    expect(failure).toMatchObject({ code });
    expect(failure.message).not.toContain('private-upstream-body');
    expect(state.normalized).toBe(0);
    expect(state.requests.filter(request => request.method === 'tools/call')).toHaveLength(1);
  });

  it('rejects interactive input_required results without a hidden fulfillment or retry', async () => {
    const { load, state } = wireFixture('input-required');
    await expect(load()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(state.requests.filter(request => request.method === 'tools/call')).toHaveLength(1);
    expect(state.normalized).toBe(0);
  });

  it('validates structured output against the discovered tool schema', async () => {
    const { load, state } = wireFixture('invalid-output');
    await expect(load()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(state.normalized).toBe(0);
  });

  it('aborts a stalled wire request and returns the public timeout error', async () => {
    const { load, state } = wireFixture('timeout', { timeoutMs: 200 });
    await expect(load()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(state.aborted).toBe(true);
    expect(state.normalized).toBe(0);
  });
});
