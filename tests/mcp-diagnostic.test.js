import { describe, expect, it } from 'vitest';
import { diagnoseMcpEndpoint } from '../server/diagnose-mcp.mjs';

const endpoint = 'https://mcp-development.invalid/sand26/mcp';
const metadataUrl = 'https://mcp-development.invalid/.well-known/oauth-protected-resource/sand26/mcp';
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('credential-free MCP diagnostic', () => {
  it('follows the supplied 401 metadata URL and emits selected public fields only', async () => {
    const requests = [];
    const result = await diagnoseMcpEndpoint(endpoint, { fetch: async (url, init) => {
      requests.push({ url, init });
      if (url === endpoint) return new Response('private body ignored', { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` } });
      return json({ resource: endpoint, authorization_servers: ['https://authorization.invalid:8261'], scopes_supported: [], bearer_methods_supported: ['header'], internal: 'private-data-not-copied', access_token: 'not-copied' });
    } });
    expect(result).toMatchObject({ ok: true, authenticated: false, mcpStatus: 401, resourceMetadataUrl: metadataUrl, resource: endpoint, authorizationServers: ['https://authorization.invalid:8261'] });
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.init.credentials === 'omit' && request.init.redirect === 'error')).toBe(true);
    expect(requests.every(request => new Headers(request.init.headers).get('Authorization') === null)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/not-copied|private-data|private body/);
  });
  it('does not probe unapproved off-origin metadata or follow redirects', async () => {
    let calls = 0;
    const result = await diagnoseMcpEndpoint(endpoint, { fetch: async () => { calls++; return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://different.invalid/metadata"' } }); } });
    expect(result.code).toBe('METADATA_ORIGIN_NOT_APPROVED'); expect(calls).toBe(1);
    const redirect = await diagnoseMcpEndpoint(endpoint, { fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://different.invalid/' } }) });
    expect(redirect.ok).toBe(false);
  });
  it('refuses credentials or guessed non-HTTPS endpoints', async () => {
    for (const url of ['http://localhost/mcp', 'https://user:secret@host.invalid/mcp', `${endpoint}?token=secret`]) {
      const result = await diagnoseMcpEndpoint(url, { fetch: async () => { throw new Error('Must not fetch'); } });
      expect(result.code).toBe('INVALID_ENDPOINT'); expect(JSON.stringify(result)).not.toContain('secret');
    }
  });
});
