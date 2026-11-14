import { describe, expect, it, vi } from 'vitest';
import { createArenaMcpProvider } from '../server/mcp-provider.mjs';
import { createArenaOAuth, createDevelopmentMemoryStore } from '../server/oauth/index.mjs';
import { buildArenaPreflight, formatArenaPreflight, readMcpReadiness, readOAuthReadiness } from '../server/readiness.mjs';
import { runArenaPreflight } from '../server/preflight.mjs';

function configuredFixture({ development = false, clientMode = 'manual', missingBinding, connectionKey = true, cookieKey = true } = {}) {
  const never = vi.fn(() => { throw new Error('private-callback-must-not-run'); });
  const bindings = Object.fromEntries(['getSchema', 'resolveBom', 'listRevisions', 'listAttachments', 'readContent'].map(name => [name, never]));
  if (missingBinding) delete bindings[missingBinding];
  const store = development ? createDevelopmentMemoryStore() : { productionReady: true, encrypted: true, shared: true, get: never, set: never, delete: never, consume: never, withLock: never };
  const options = {
    mcpEndpoint: 'https://mcp.private-fixture.test/tenant/mcp', redirectUri: 'https://viewer.private-fixture.test/api/viewer/v1/auth/callback',
    allowedOrigins: ['https://mcp.private-fixture.test'], resolveIdentity: never, store, development, fetch: never,
    ...(cookieKey ? { cookieKey: Buffer.alloc(32, 23) } : {}),
    client: clientMode === 'cimd' ? { mode: 'cimd', clientId: 'https://viewer.private-fixture.test/private-client.json' } : { mode: 'manual', clientId: 'private-client-identity', clientSecret: 'private-client-secret' },
  };
  const oauthAuth = createArenaOAuth(options);
  const mcp = createArenaMcpProvider({ endpoint: options.mcpEndpoint, resolveSession: oauthAuth.resolveSession, approvedReadTools: ['private-tenant-read-tool'], bindings, fetch: never, ...(connectionKey ? { connectionKey: Buffer.alloc(32, 29) } : {}) });
  return { provider: { ...mcp, oauthAuth }, never, options };
}

describe('Arena configuration preflight', () => {
  it('inspects real constructed components without calling operations, stores, login or a network probe', () => {
    const { provider, never } = configuredFixture();
    const report = buildArenaPreflight(provider);
    expect(report).toMatchObject({ schemaVersion: 1, scope: 'configuration-only', state: 'configuration-complete', liveAcceptance: 'not-tested', networkChecks: 'not-run', runtimePath: 'hosted-bff', clientMode: 'manual', blockers: [] });
    expect(report.acceptance).toHaveLength(6);
    expect(report.acceptance.every(gate => gate.status === 'not-run')).toBe(true);
    expect(report.limits.maxContentBytes).toBe(32 * 1024 * 1024);
    expect(never).not.toHaveBeenCalled();
    expect(Object.isFrozen(provider.oauthAuth.readiness.required)).toBe(true);
    const encoded = JSON.stringify(report);
    expect(encoded).not.toMatch(/private-fixture|private-client|private-tenant|private-callback/);
    expect(formatArenaPreflight(report)).toContain('not a live connection or production approval');
    expect(formatArenaPreflight(report)).toContain('Status\tCheck\tDetail');
  });

  it.each(['getSchema', 'resolveBom', 'listRevisions', 'listAttachments', 'readContent'])('blocks incomplete provider mapping: %s', missingBinding => {
    const { provider, never } = configuredFixture({ missingBinding });
    const report = buildArenaPreflight(provider);
    expect(provider.configured).toBe(false);
    expect(report.state).toBe('blocked');
    expect(report.blockers).toContain(`mcp.${missingBinding}`);
    expect(report.blockers).toContain('provider.configured');
    expect(never).not.toHaveBeenCalled();
  });

  it('does not treat development sessions or generated process keys as deployable configuration', () => {
    const { provider } = configuredFixture({ development: true, cookieKey: false, connectionKey: false });
    expect(provider.configured).toBe(true);
    expect(provider.oauthAuth.configured).toBe(true);
    const report = buildArenaPreflight(provider);
    expect(report.blockers).toEqual(expect.arrayContaining(['mcp.connectionKey', 'oauth.productionMode', 'oauth.cookieKeyProvided', 'oauth.productionStoreDeclared', 'oauth.encryptedStoreDeclared', 'oauth.sharedStoreDeclared']));
    expect(report.state).toBe('blocked');
  });

  it('keeps configured public CIMD distinct from verified direct extension authorization', () => {
    const { provider, never } = configuredFixture({ clientMode: 'cimd' });
    const report = buildArenaPreflight(provider);
    expect(report).toMatchObject({ state: 'configuration-complete', clientMode: 'cimd', runtimePath: 'hosted-bff', liveAcceptance: 'not-tested' });
    expect(report.notes.join(' ')).toContain('Direct extension-to-MCP authentication is not implemented');
    expect(never).not.toHaveBeenCalled();
  });

  it('keeps unavailable, custom and internally inconsistent reports blocked', () => {
    const { provider } = configuredFixture();
    expect(buildArenaPreflight(null).state).toBe('blocked');
    expect(buildArenaPreflight({ ...provider, readiness: undefined }).blockers).toContain('provider.report');
    expect(buildArenaPreflight({ ...provider, oauthAuth: undefined }).blockers).toContain('oauth.report');
    expect(buildArenaPreflight({ ...provider, configured: false }).blockers).toContain('provider.configured');
    expect(buildArenaPreflight({ ...provider, readContent: undefined }).blockers).toContain('mcp.readContent');
    const inconsistent = { ...provider.readiness, required: { ...provider.readiness.required, readContent: false } };
    expect(readMcpReadiness(inconsistent)).toBeUndefined();
    expect(buildArenaPreflight({ ...provider, readiness: inconsistent }).blockers).toContain('provider.report');
    expect(readOAuthReadiness({ ...provider.oauthAuth.readiness, clientMode: 'unknown-client-secret' })).toBeUndefined();
    expect(readOAuthReadiness({ ...provider.oauthAuth.readiness, required: { ...provider.oauthAuth.readiness.required, identityResolver: false } })).toBeUndefined();
  });

  it('drops unknown fields at every report boundary and rejects malformed known scalars', () => {
    const { provider } = configuredFixture();
    const secret = 'DO_NOT_EXPORT_PRIVATE_DEPLOYMENT_DATA';
    const mcp = { ...provider.readiness, secret, required: { ...provider.readiness.required, token: secret }, deployment: { ...provider.readiness.deployment, connectionKey: secret }, limits: { ...provider.readiness.limits, endpoint: secret } };
    const oauth = { ...provider.oauthAuth.readiness, token: secret, required: { ...provider.oauthAuth.readiness.required, redirectUri: secret }, deployment: { ...provider.oauthAuth.readiness.deployment, cookieKey: secret } };
    const report = buildArenaPreflight({ ...provider, readiness: mcp, oauthAuth: { ...provider.oauthAuth, readiness: oauth }, capabilities: { supplierItems: true, secret } });
    expect(report.state).toBe('configuration-complete');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(readMcpReadiness(mcp))).not.toContain(secret);
    expect(JSON.stringify(readOAuthReadiness(oauth))).not.toContain(secret);
    expect(readMcpReadiness({ ...mcp, limits: { ...mcp.limits, maxContentBytes: secret } })).toBeUndefined();
    expect(readMcpReadiness({ ...mcp, limits: { ...mcp.limits, maxItems: Infinity } })).toBeUndefined();
    expect(readOAuthReadiness({ ...oauth, deployment: { ...oauth.deployment, encryptedStoreDeclared: 'true' } })).toBeUndefined();
  });

  it('reports missing OAuth identity configuration without triggering a user or store lookup', () => {
    const { provider, options, never } = configuredFixture();
    const oauthAuth = createArenaOAuth({ ...options, resolveIdentity: undefined });
    const report = buildArenaPreflight({ ...provider, oauthAuth });
    expect(report.blockers).toEqual(expect.arrayContaining(['oauth.configured', 'oauth.identityResolver']));
    expect(report.state).toBe('blocked');
    expect(never).not.toHaveBeenCalled();
  });

  it('rejects accessor-based or out-of-contract reports without executing accessor code', () => {
    const { provider } = configuredFixture();
    const secretGetter = vi.fn(() => 'PRIVATE_ACCESSOR_DATA');
    const limits = { ...provider.readiness.limits };
    Object.defineProperty(limits, 'maxContentBytes', { get: secretGetter });
    expect(readMcpReadiness({ ...provider.readiness, limits })).toBeUndefined();
    const required = { ...provider.oauthAuth.readiness.required };
    Object.defineProperty(required, 'identityResolver', { get: secretGetter });
    expect(readOAuthReadiness({ ...provider.oauthAuth.readiness, required })).toBeUndefined();
    const header = { ...provider.readiness };
    Object.defineProperty(header, 'configured', { get: secretGetter });
    expect(readMcpReadiness(header)).toBeUndefined();
    expect(readMcpReadiness({ ...provider.readiness, limits: { ...provider.readiness.limits, timeoutMs: Number.MAX_SAFE_INTEGER } })).toBeUndefined();
    expect(secretGetter).not.toHaveBeenCalled();
  });
});

describe('server preflight command', () => {
  it('produces a blocked no-module JSON report without loading code or contacting Arena', async () => {
    const loadProvider = vi.fn();
    const result = await runArenaPreflight(['--json'], { env: {}, loadProvider });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({ state: 'blocked', liveAcceptance: 'not-tested', networkChecks: 'not-run' });
    expect(loadProvider).not.toHaveBeenCalled();
  });

  it('loads only the explicitly selected trusted module and keeps its path out of JSON', async () => {
    const { provider, never } = configuredFixture();
    const loadProvider = vi.fn(async () => provider);
    const result = await runArenaPreflight(['--provider', '/private/deployment/provider.mjs', '--json'], { env: { ARENA_PROVIDER_MODULE: '/unused/provider.mjs' }, loadProvider });
    expect(result.exitCode).toBe(0);
    expect(loadProvider).toHaveBeenCalledExactlyOnceWith('/private/deployment/provider.mjs');
    expect(result.output).not.toContain('/private/deployment');
    expect(JSON.parse(result.output).state).toBe('configuration-complete');
    expect(never).not.toHaveBeenCalled();
  });

  it('uses the server environment module explicitly and supports readable output', async () => {
    const { provider } = configuredFixture();
    const loadProvider = vi.fn(async () => provider);
    const result = await runArenaPreflight([], { env: { ARENA_PROVIDER_MODULE: '/private/provider.mjs' }, loadProvider });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Status\tCheck\tDetail');
    expect(loadProvider).toHaveBeenCalledExactlyOnceWith('/private/provider.mjs');
  });

  it.each([
    ['--provider'], ['--provider', 'https://private.fixture/provider.mjs'], ['--provider', 'file:///private/provider.mjs'],
    ['--provider', 'bad\npath'], ['--provider', '/one.mjs', '--provider', '/two.mjs'], ['--json', '--json'], ['--unknown', '--json'],
  ])('refuses ambiguous or nonlocal module arguments without loading code: %j', async (...args) => {
    const loadProvider = vi.fn();
    const result = await runArenaPreflight(args, { env: {}, loadProvider });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output).error.code).toBe('INVALID_ARGUMENTS');
    expect(loadProvider).not.toHaveBeenCalled();
  });

  it('redacts module errors and malformed report access without echoing secrets or paths', async () => {
    for (const loadProvider of [async () => { throw new Error('PRIVATE_TOKEN at /private/key.mjs'); }, async () => ({ get readiness() { throw new Error('PRIVATE_TOKEN'); } })]) {
      const result = await runArenaPreflight(['--provider', '/private/provider.mjs', '--json'], { env: {}, loadProvider });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output).error.code).toBe('PROVIDER_LOAD_FAILED');
      expect(result.output).not.toMatch(/PRIVATE_TOKEN|\/private/);
    }
  });

  it('runs the checked-in example as unconfigured without retrieving discovery or source data', async () => {
    const result = await runArenaPreflight(['--provider', new URL('../server/provider.example.mjs', import.meta.url).pathname, '--json'], { env: {} });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output).blockers).toContain('mcp.readContent');
    expect(result.report.liveAcceptance).toBe('not-tested');
  });
});
