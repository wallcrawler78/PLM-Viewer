/** Synthetic OAuth wire tests. No real Arena login, account, registered client or JWT claims. */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createArenaOAuth, createDevelopmentMemoryStore, sanitizeReturnTo } from '../server/oauth/index.mjs';

const MCP = 'https://mcp.fixture.test/sandbox/mcp', RESOURCE = 'https://mcp.fixture.test/sandbox';
const AS = 'https://identity.fixture.test', VIEWER = 'https://viewer.fixture.test';
const METADATA = 'https://mcp.fixture.test/metadata/resource', CALLBACK = `${VIEWER}/api/viewer/v1/auth/callback`;
const AUTH = '/api/viewer/v1/auth/', SECRET = 'private-client-secret';
const cookie = (response, name) => response.headers['Set-Cookie']?.find(value => value.startsWith(`${name}=`))?.split(';')[0];
function fixture(overrides = {}) {
  let clock = 1_800_000_000_000;
  const calls = [];
  const state = { subject: 'alice', refreshSubject: undefined, tokenCalls: 0, metadataUrl: METADATA, authorizationServer: AS, resource: RESOURCE, failToken: false, omitRefresh: false, challengedScope: undefined, response: undefined };
  const store = createDevelopmentMemoryStore({ now: () => clock });
  const metadata = { issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true };
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body ? new URLSearchParams(init.body) : undefined, redirect: init.redirect });
    expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit');
    const replacement = state.response?.(String(url), init);
    if (replacement) return replacement;
    const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (String(url) === MCP) return new Response(null, { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${state.metadataUrl}"${state.challengedScope ? `, scope="${state.challengedScope}"` : ''}` } });
    if (String(url) === METADATA) return json({ resource: state.resource, authorization_servers: [state.authorizationServer], scopes_supported: ['read', 'write'], bearer_methods_supported: ['header'] });
    if (String(url) === `${AS}/.well-known/oauth-authorization-server`) return json(metadata);
    if (String(url) === `${AS}/token`) {
      state.tokenCalls++;
      if (state.failToken) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: `${SECRET} private-upstream-message` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const params = new URLSearchParams(init.body), refresh = params.get('grant_type') === 'refresh_token';
      expect(params.get('resource')).toBe(state.resource);
      return json({ access_token: `access-${refresh ? state.refreshSubject ?? state.subject : state.subject}-${state.tokenCalls}`, token_type: 'Bearer', expires_in: 60, ...(!refresh || !state.omitRefresh ? { refresh_token: `refresh-${state.tokenCalls}` } : {}) });
    }
    throw new Error(`Unexpected synthetic URL: ${url}`);
  };
  const resolveIdentity = vi.fn(async (tokens, discovery) => {
    expect(discovery.resource).toBe(state.resource);
    // This controlled fixture stands in for the deployment's verified identity/profile mapper.
    const subject = tokens.access_token.split('-')[1];
    return { userId: subject, arenaUserId: `arena-${subject}`, workspaceId: 'verified-workspace', displayName: subject.toUpperCase() };
  });
  const options = { mcpEndpoint: MCP, redirectUri: CALLBACK, allowedOrigins: ['https://mcp.fixture.test', AS], client: { mode: 'manual', clientId: 'registered-client', clientSecret: SECRET }, store, resolveIdentity, development: true, cookieKey: Buffer.alloc(32, 7), fetch: fetcher, now: () => clock, refreshLeewayMs: 0, ...overrides };
  const oauth = createArenaOAuth(options);
  async function request(path, { method = 'GET', cookie: cookieHeader, origin } = {}) {
    const headers = {}, req = { url: path, method, headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...(origin ? { origin } : {}) } };
    const response = { headers, status: undefined, body: undefined, writableEnded: false,
      setHeader(name, value) { headers[name] = value; }, writeHead(status) { response.status = status; },
      end(body) { response.writableEnded = true; response.body = body === undefined ? undefined : JSON.parse(body); },
    };
    response.handled = await oauth.handleRequest(req, response);
    return response;
  }
  async function login(returnTo = '/?mode=arena&workspaceId=verified-workspace&itemId=item&revision=D') {
    const response = await request(`${AUTH}login?${new URLSearchParams({ returnTo })}`);
    return { response, url: response.headers.Location ? new URL(response.headers.Location) : undefined, cookie: cookie(response, '__Host-arena-oauth') };
  }
  async function complete(flow, extra = {}) {
    const params = new URLSearchParams({ code: 'synthetic-private-code', state: flow.url.searchParams.get('state'), iss: AS, ...extra });
    return request(`${AUTH}callback?${params}`, { cookie: flow.cookie });
  }
  return { oauth, request, login, complete, state, calls, metadata, store, resolveIdentity, options, advance: milliseconds => { clock += milliseconds; } };
}

describe('Arena OAuth runtime', () => {
  it('stays unconfigured without a verified identity mapper and does not start login from status', async () => {
    const f = fixture({ resolveIdentity: undefined });
    expect(f.oauth.configured).toBe(false);
    expect((await f.request(`${AUTH}status`)).body).toMatchObject({ configured: false, connected: false, state: 'unconfigured' });
    expect((await f.request(`${AUTH}login`)).status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });
  it('requires a production store and stable secret key unless development is explicit', () => {
    expect(() => fixture({ development: false })).toThrow();
    expect(() => fixture({ cookieKey: Buffer.alloc(8) })).toThrow();
  });
  it('discovers actual metadata, sends its exact audience, and keeps the secret/verifier off the redirect', async () => {
    const f = fixture(), flow = await f.login();
    expect(flow.response.status).toBe(302);
    expect(f.calls.map(call => call.url)).toEqual([MCP, METADATA, `${AS}/.well-known/oauth-authorization-server`]);
    expect(flow.url.origin).toBe(AS); expect(flow.url.pathname).toBe('/authorize');
    expect(flow.url.searchParams.get('resource')).toBe(RESOURCE);
    expect(flow.url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url.searchParams.get('scope')).toBeNull();
    expect(flow.url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.url.searchParams.has('code_verifier')).toBe(false);
    expect(flow.url.href).not.toContain(SECRET);
    expect(flow.response.headers['Set-Cookie'][0]).toContain('HttpOnly; Secure; SameSite=Lax');
    const callback = await f.complete(flow), token = f.calls.find(call => call.url === `${AS}/token`);
    expect(callback.status).toBe(302);
    expect(callback.headers.Location).toContain('/?mode=arena');
    expect(createHash('sha256').update(token.body.get('code_verifier')).digest('base64url')).toBe(flow.url.searchParams.get('code_challenge'));
    expect(token.body.get('redirect_uri')).toBe(CALLBACK);
    expect(token.headers.get('authorization')).toMatch(/^Basic /);
    expect(token.headers.has('X-PLATFORM-AUTH')).toBe(false);
    const sessionCookie = cookie(callback, '__Host-arena-viewer');
    const status = await f.request(`${AUTH}status`, { cookie: sessionCookie });
    expect(status.body).toMatchObject({ configured: true, connected: true, user: { id: 'alice' }, workspaceId: 'verified-workspace', logoutPath: `${AUTH}logout` });
    expect(JSON.stringify(status)).not.toMatch(/access-alice|refresh-1|private-client-secret/);
    const session = await f.oauth.resolveSession({ headers: { cookie: sessionCookie } });
    expect(await session.getAccessToken()).toMatchObject({ userId: 'alice', arenaUserId: 'arena-alice', workspaceId: 'verified-workspace', sessionId: session.sessionId, accessToken: 'access-alice-1' });
  });
  it('supports confidential client_secret_post and public CIMD without downgrading authentication', async () => {
    const post = fixture({ client: { mode: 'manual', clientId: 'registered-client', clientSecret: SECRET, tokenEndpointAuthMethod: 'client_secret_post' } });
    expect((await post.complete(await post.login())).status).toBe(302);
    const posted = post.calls.find(call => call.url === `${AS}/token`);
    expect(posted.headers.has('authorization')).toBe(false); expect(posted.body.get('client_secret')).toBe(SECRET);
    const publicClientId = `${VIEWER}/oauth-client.json`;
    const cimd = fixture({ client: { mode: 'cimd', clientId: publicClientId } });
    const flow = await cimd.login(); expect(flow.url.searchParams.get('client_id')).toBe(publicClientId);
    expect((await cimd.complete(flow)).status).toBe(302);
    const publicToken = cimd.calls.find(call => call.url === `${AS}/token`);
    expect(publicToken.headers.has('authorization')).toBe(false); expect(publicToken.body.get('client_secret')).toBeNull();
    expect(publicToken.body.get('client_id')).toBe(publicClientId);
    const unsupported = fixture(); unsupported.metadata.token_endpoint_auth_methods_supported = ['none'];
    expect((await unsupported.login()).response.status).toBe(501);
  });
  it('requires advertised S256 and CIMD support instead of guessing protocol capabilities', async () => {
    const noPkce = fixture(); noPkce.metadata.code_challenge_methods_supported = ['plain'];
    expect((await noPkce.login()).response.status).toBe(502);
    const noCimd = fixture({ client: { mode: 'cimd', clientId: `${VIEWER}/oauth-client.json` } }); noCimd.metadata.client_id_metadata_document_supported = false;
    expect((await noCimd.login()).response.status).toBe(501);
  });
  it('uses approved scope policy and never expands to all advertised scopes', async () => {
    const approved = fixture({ approvedScopes: ['read'] });
    expect((await approved.login()).url.searchParams.get('scope')).toBe('read');
    const challenged = fixture({ approvedScopes: ['read'] }); challenged.state.challengedScope = 'write';
    expect((await challenged.login()).response.status).toBe(403);
    expect(challenged.state.tokenCalls).toBe(0);
  });
  it('rejects wrong state, a different browser cookie, expiry and callback replay before token exchange', async () => {
    const f = fixture(), flow = await f.login();
    expect((await f.complete(flow, { state: 'wrong-state' })).status).toBe(400);
    expect((await f.complete({ ...flow, cookie: `${flow.cookie}x` })).status).toBe(400);
    expect(f.state.tokenCalls).toBe(0);
    expect((await f.complete(flow)).status).toBe(302);
    expect((await f.complete(flow)).status).toBe(400);
    expect(f.state.tokenCalls).toBe(1);
    const expired = fixture(), expiredFlow = await expired.login(); expired.advance(11 * 60_000);
    expect((await expired.complete(expiredFlow)).status).toBe(400);
    expect(expired.state.tokenCalls).toBe(0);
  });
  it('rejects missing or mismatched issuer before sending the authorization code', async () => {
    const mismatch = fixture(), flow = await mismatch.login();
    expect((await mismatch.complete(flow, { iss: 'https://wrong.fixture.test' })).status).toBe(502);
    expect(mismatch.state.tokenCalls).toBe(0);
    const absent = fixture(), another = await absent.login();
    expect((await absent.request(`${AUTH}callback?${new URLSearchParams({ state: another.url.searchParams.get('state'), code: 'code' })}`, { cookie: another.cookie })).status).toBe(502);
    expect(absent.state.tokenCalls).toBe(0);
  });
  it('redacts token errors and never creates a session from unverified identity', async () => {
    const f = fixture(), flow = await f.login(); f.state.failToken = true;
    const failed = await f.complete(flow);
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed)).not.toMatch(/private-client-secret|private-upstream-message|synthetic-private-code/);
    expect(cookie(failed, '__Host-arena-viewer')).toBeUndefined();
    const invalid = fixture({ resolveIdentity: async () => ({ userId: 'unverified' }) });
    expect((await invalid.complete(await invalid.login())).status).toBe(401);
  });
  it('serializes refresh, preserves an omitted refresh token, and keeps the same verified principal', async () => {
    const f = fixture(), callback = await f.complete(await f.login());
    const session = await f.oauth.resolveSession({ headers: { cookie: cookie(callback, '__Host-arena-viewer') } });
    f.state.omitRefresh = true; f.advance(61_000);
    const [a, b] = await Promise.all([session.getAccessToken(), session.getAccessToken()]);
    expect(a.accessToken).toBe('access-alice-2'); expect(b.accessToken).toBe(a.accessToken);
    expect(f.state.tokenCalls).toBe(2);
    f.advance(61_000); expect((await session.getAccessToken()).accessToken).toBe('access-alice-3');
    const refreshes = f.calls.filter(call => call.body?.get('grant_type') === 'refresh_token');
    expect(refreshes.map(call => call.body.get('refresh_token'))).toEqual(['refresh-1', 'refresh-1']);
    expect(refreshes.every(call => call.body.get('resource') === RESOURCE)).toBe(true);
  });
  it('revokes its session if refresh changes the verified subject', async () => {
    const f = fixture(), callback = await f.complete(await f.login()), sessionCookie = cookie(callback, '__Host-arena-viewer');
    const session = await f.oauth.resolveSession({ headers: { cookie: sessionCookie } });
    f.state.refreshSubject = 'bob'; f.advance(61_000);
    await expect(session.getAccessToken()).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' });
    expect(await f.oauth.resolveSession({ headers: { cookie: sessionCookie } })).toBeNull();
  });
  it('logs out only the current session and rejects cross-origin or GET logout', async () => {
    const f = fixture(), alice = cookie(await f.complete(await f.login()), '__Host-arena-viewer');
    f.state.subject = 'bob'; const bob = cookie(await f.complete(await f.login()), '__Host-arena-viewer');
    expect((await f.request(`${AUTH}logout`, { cookie: alice })).status).toBe(405);
    expect((await f.request(`${AUTH}logout`, { method: 'POST', cookie: alice, origin: 'https://other.fixture.test' })).status).toBe(403);
    expect(await f.oauth.resolveSession({ headers: { cookie: alice } })).not.toBeNull();
    expect((await f.request(`${AUTH}logout`, { method: 'POST', cookie: alice, origin: VIEWER })).status).toBe(204);
    expect(await f.oauth.resolveSession({ headers: { cookie: alice } })).toBeNull();
    expect((await f.oauth.resolveSession({ headers: { cookie: bob } })).userId).toBe('bob');
  });
  it('keeps logout effective when a consumed callback finishes identity verification afterward', async () => {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const f = fixture({ resolveIdentity: async tokens => {
      if (tokens.access_token.endsWith('-2')) {
        entered();
        await new Promise(resolve => { release = resolve; });
      }
      return { userId: 'alice', arenaUserId: 'arena-alice', workspaceId: 'verified-workspace' };
    } });
    const oldSession = cookie(await f.complete(await f.login()), '__Host-arena-viewer');
    const flow = await f.login(), browserCookies = `${oldSession}; ${flow.cookie}`;
    const callbackPending = f.complete({ ...flow, cookie: browserCookies });
    await waiting;
    expect((await f.request(`${AUTH}logout`, { method: 'POST', cookie: browserCookies, origin: VIEWER })).status).toBe(204);
    expect(await f.oauth.resolveSession({ headers: { cookie: oldSession } })).toBeNull();
    release();
    const callback = await callbackPending;
    expect(callback.status).toBe(401);
    expect(cookie(callback, '__Host-arena-viewer')).toBeUndefined();
    expect((await f.request(`${AUTH}status`, { cookie: browserCookies })).body.connected).toBe(false);
  });
  it('deletes a newly committed session when racing logout still carries the consumed flow cookie', async () => {
    const f = fixture(), oldSession = cookie(await f.complete(await f.login()), '__Host-arena-viewer');
    const flow = await f.login(), oldBrowserCookies = `${oldSession}; ${flow.cookie}`;
    const callback = await f.complete({ ...flow, cookie: oldBrowserCookies });
    const newSession = cookie(callback, '__Host-arena-viewer');
    expect(await f.oauth.resolveSession({ headers: { cookie: newSession } })).not.toBeNull();
    // This request was initiated before the callback's Set-Cookie reached the browser.
    expect((await f.request(`${AUTH}logout`, { method: 'POST', cookie: oldBrowserCookies, origin: VIEWER })).status).toBe(204);
    expect(await f.oauth.resolveSession({ headers: { cookie: newSession } })).toBeNull();
    expect(await f.oauth.resolveSession({ headers: { cookie: oldSession } })).toBeNull();
  });
  it.each(['https://127.0.0.1/private', 'http://metadata.fixture.test/private', 'https://unapproved.fixture.test/private'])('rejects an unsafe discovered metadata URL %s', async metadataUrl => {
    const f = fixture(); f.state.metadataUrl = metadataUrl;
    expect([400, 403]).toContain((await f.login()).response.status);
    expect(f.calls).toHaveLength(1);
  });
  it('rejects metadata redirects, unapproved authorization servers and token endpoints', async () => {
    const redirect = fixture(); redirect.state.response = url => url === METADATA ? new Response(null, { status: 302, headers: { Location: `${AS}/elsewhere` } }) : undefined;
    expect((await redirect.login()).response.status).toBe(403); expect(redirect.calls).toHaveLength(2);
    const issuer = fixture(); issuer.state.authorizationServer = 'https://unapproved.fixture.test';
    expect((await issuer.login()).response.status).toBe(403); expect(issuer.calls).toHaveLength(2);
    const token = fixture(); token.metadata.token_endpoint = 'https://unapproved.fixture.test/token';
    expect((await token.login()).response.status).toBe(403); expect(token.state.tokenCalls).toBe(0);
  });
  it.each(['//evil.fixture.test/', '/%2f%2fevil.fixture.test', '/api/viewer/v1/content?token=private', '/%61pi/viewer/v1/auth/login', '/?next=https://evil.fixture.test', '/?mode=arena&mode=preview', '/%0d%0aLocation:evil'])('rejects unsafe callback return path %s', value => {
    expect(() => sanitizeReturnTo(value, VIEWER)).toThrow();
  });
  it('enforces a deadline around a stalled identity mapper and prevents late session cookies', async () => {
    let release;
    const f = fixture({ timeoutMs: 80, resolveIdentity: () => new Promise(resolve => { release = resolve; }) });
    const flow = await f.login(), callback = await f.complete(flow);
    expect(callback.status).toBe(504); expect(cookie(callback, '__Host-arena-viewer')).toBeUndefined();
    release({ userId: 'alice', arenaUserId: 'arena-alice', workspaceId: 'verified-workspace' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(callback.status).toBe(504); expect(cookie(callback, '__Host-arena-viewer')).toBeUndefined();
  });
  it('enforces the status deadline even if a trusted session store ignores cancellation', async () => {
    const f = fixture({ timeoutMs: 80 });
    const callback = await f.complete(await f.login()), sessionCookie = cookie(callback, '__Host-arena-viewer');
    const stuck = createArenaOAuth({ ...f.options, store: { ...f.store, get: () => new Promise(() => {}) } });
    const headers = {}, result = { status: undefined, setHeader(name, value) { headers[name] = value; }, writeHead(status) { result.status = status; }, end() { result.writableEnded = true; } };
    await stuck.handleRequest({ url: `${AUTH}status`, method: 'GET', headers: { cookie: sessionCookie } }, result);
    expect(result.status).toBe(504);
  });
});
