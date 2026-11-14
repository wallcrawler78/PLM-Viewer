/** User-bound backend OAuth. No browser token storage, decoded-JWT identity guesses or service account. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { exchangeAuthorization, refreshAuthorization, startAuthorization, validateAuthorizationResponseIssuer } from '@modelcontextprotocol/client';
import { ViewerError, identityText, safeError } from '../errors.mjs';
import { createOAuthFetch, discoverArenaOAuth, httpsUrl } from './discovery.mjs';
export { createDevelopmentMemoryStore } from './store.mjs';
export { discoverArenaOAuth } from './discovery.mjs';

const PREFIX = '/api/viewer/v1/auth/';
const SESSION_COOKIE = '__Host-arena-viewer', FLOW_COOKIE = '__Host-arena-oauth';
const IDENTITY_FIELDS = ['userId', 'arenaUserId', 'workspaceId'];
const RETURN_PARAMS = new Set(['mode', 'workspaceId', 'itemId', 'revision', 'fileId', 'parentItemId', 'parentRevision', 'configurationId', 'baselineRevision', 'baselineConfigurationId', 'edition', 'sourceHash', 'view', 'compare']);
const randomId = () => randomBytes(32).toString('base64url');
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function abortable(work, signal) {
  signal?.throwIfAborted();
  if (!signal) return work;
  let onAbort;
  try { return await Promise.race([work, new Promise((_, reject) => { onAbort = () => reject(signal.reason ?? new ViewerError('TIMEOUT')); signal.addEventListener('abort', onAbort, { once: true }); })]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function sanitizeReturnTo(value = '/', viewerOrigin) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || /[\\\s#\u0000-\u001f\u007f]/.test(value)) throw new ViewerError('BAD_REQUEST');
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new ViewerError('BAD_REQUEST'); }
  if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) throw new ViewerError('BAD_REQUEST');
  const url = new URL(value, viewerOrigin);
  if (url.origin !== viewerOrigin || url.pathname.startsWith('/api/viewer/') || new URL(decoded, viewerOrigin).pathname.startsWith('/api/viewer/')) throw new ViewerError('BAD_REQUEST');
  for (const [key, field] of url.searchParams) if (!RETURN_PARAMS.has(key) || url.searchParams.getAll(key).length !== 1 || field.length > 512) throw new ViewerError('BAD_REQUEST');
  return `${url.pathname}${url.search}`;
}
function cookieValue(request, name) {
  const header = request.headers?.cookie;
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || header.length > 16384) throw new ViewerError('BAD_REQUEST');
  const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (matches.length > 1) throw new ViewerError('BAD_REQUEST');
  return matches[0]?.slice(name.length + 1);
}
function identityFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ViewerError('UNAUTHENTICATED');
  const identity = Object.fromEntries(IDENTITY_FIELDS.map(key => [key, identityText(value[key], 512, 'UNAUTHENTICATED')]));
  if (value.displayName !== undefined) identity.displayName = identityText(value.displayName, 200, 'UNAUTHENTICATED');
  return identity;
}
function tokenRecord(tokens, now, verified) {
  if (!tokens || typeof tokens !== 'object' || tokens.token_type?.toLowerCase() !== 'bearer') throw new ViewerError('UNAUTHENTICATED');
  const accessToken = identityText(tokens.access_token, 16384, 'UNAUTHENTICATED');
  if (/\s/.test(accessToken)) throw new ViewerError('UNAUTHENTICATED');
  const expiresAt = Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? now + tokens.expires_in * 1000 : verified?.expiresAt;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new ViewerError('UNAUTHENTICATED');
  if (tokens.refresh_token !== undefined) identityText(tokens.refresh_token, 32768, 'UNAUTHENTICATED');
  return { tokens: structuredClone(tokens), expiresAt };
}

/**
 * Required options: mcpEndpoint, exact HTTPS redirectUri ending in this callback route,
 * allowedOrigins (explicit HTTPS origin strings), client, store, resolveIdentity.
 * client = {mode:'manual',clientId,clientSecret,tokenEndpointAuthMethod?}
 *       or {mode:'cimd',clientId:publicHTTPSMetadataUrl}; no secret for CIMD.
 * resolveIdentity(tokens, discovery, {signal}) MUST verify token issuer/audience,
 * Arena subject and selected workspace using the vendor's verified identity contract.
 * It returns {userId,arenaUserId,workspaceId,displayName?,expiresAt?}; expiresAt is
 * optional verified token expiry when expires_in is absent. Never decode claims unchecked.
 *
 * store: async get(key), set(key,value,expiresAt), delete(key), consume(key),
 * withLock(key,asyncOperation). consume is atomic get-and-delete; withLock must
 * serialize refresh/logout across all deployment replicas. Values contain tokens.
 * Production requires store.productionReady/encrypted/shared === true plus a stable
 * cookieKey (32+ secret bytes). Its deployment owns encryption/key rotation/expiry.
 * createDevelopmentMemoryStore is allowed ONLY with development:true; an ephemeral
 * cookieKey may then be generated. This is intentionally unsuitable for production.
 *
 * Optional discovery policy: authorizationServer (choose one advertised issuer),
 * allowedResources (reviewed non-prefix resource IDs), approvedScopes (no expansion).
 */
export function createArenaOAuth(options = {}) {
  const { mcpEndpoint, redirectUri, client, store, resolveIdentity, allowedOrigins, development = false, now = Date.now } = options;
  const required = Boolean(mcpEndpoint && redirectUri && client?.clientId && store && typeof resolveIdentity === 'function' && Array.isArray(allowedOrigins) && allowedOrigins.length);
  let configured = required, origin, redirect, key, namespace, clientInformation, authMethod;
  const timeoutMs = options.timeoutMs ?? 15000, flowTtlMs = options.flowTtlMs ?? 10 * 60_000, sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000, refreshLeewayMs = options.refreshLeewayMs ?? 30_000;
  for (const value of [timeoutMs, flowTtlMs, sessionTtlMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 30 * 24 * 60 * 60_000) throw new ViewerError('BAD_REQUEST');
  if (!Number.isSafeInteger(refreshLeewayMs) || refreshLeewayMs < 0) throw new ViewerError('BAD_REQUEST');
  if (required) {
    const endpoint = httpsUrl(mcpEndpoint); redirect = httpsUrl(redirectUri); origin = redirect.origin;
    if (endpoint.search || redirect.pathname !== `${PREFIX}callback` || redirect.search || !allowedOrigins.every(value => httpsUrl(value).origin === value)) throw new ViewerError('BAD_REQUEST');
    if (!allowedOrigins.includes(endpoint.origin)) throw new ViewerError('FORBIDDEN');
    if (!['get', 'set', 'delete', 'consume', 'withLock'].every(name => typeof store[name] === 'function')) throw new ViewerError('BAD_REQUEST');
    if (!development && (store.productionReady !== true || store.encrypted !== true || store.shared !== true || !options.cookieKey)) throw new ViewerError('UNCONFIGURED');
    if (store.kind === 'development-memory' && !development) throw new ViewerError('UNCONFIGURED');
    key = options.cookieKey ?? randomBytes(32);
    if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new ViewerError('BAD_REQUEST');
    key = Buffer.from(key);
    const clientId = identityText(client.clientId, 2048);
    if (client.mode === 'manual') {
      if (!client.clientSecret) configured = false;
      else {
        const clientSecret = identityText(client.clientSecret, 16384);
        authMethod = client.tokenEndpointAuthMethod ?? 'client_secret_basic';
        if (!['client_secret_basic', 'client_secret_post'].includes(authMethod)) throw new ViewerError('BAD_REQUEST');
        clientInformation = { client_id: clientId, client_secret: clientSecret, token_endpoint_auth_method: authMethod };
      }
    } else if (client.mode === 'cimd') {
      if (client.clientSecret !== undefined) throw new ViewerError('BAD_REQUEST');
      httpsUrl(clientId); authMethod = 'none';
      clientInformation = { client_id: clientId, token_endpoint_auth_method: 'none' };
    } else throw new ViewerError('BAD_REQUEST');
    namespace = createHash('sha256').update(JSON.stringify([endpoint.href, redirect.href, clientId])).digest('hex');
  }
  const storageKey = (kind, id) => `arena-oauth:${namespace}:${kind}:${id}`;
  const sign = (id, name) => `${id}.${createHmac('sha256', key).update(`${name}:${id}`).digest('base64url')}`;
  function signedId(request, name) {
    const value = cookieValue(request, name);
    if (!value || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    const id = value.split('.')[0];
    return sameText(value, sign(id, name)) ? id : undefined;
  }
  const makeCookie = (name, id, maxAge) => `${name}=${id ? sign(id, name) : ''}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  const discoveryOptions = signal => ({ mcpEndpoint, allowedOrigins, authorizationServer: options.authorizationServer, allowedResources: options.allowedResources, approvedScopes: options.approvedScopes, fetch: options.fetch, signal, timeoutMs });
  function checkClient(discovery) {
    const supported = discovery.metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (!supported.includes(authMethod) || client.mode === 'cimd' && discovery.metadata.client_id_metadata_document_supported !== true) throw new ViewerError('UNSUPPORTED');
  }
  // Explicit configured method: never silently downgrade a confidential client to public auth.
  function addClientAuthentication(headers, params) {
    if (authMethod === 'client_secret_basic') {
      const encode = value => new URLSearchParams({ v: value }).toString().slice(2);
      headers.set('Authorization', `Basic ${Buffer.from(`${encode(clientInformation.client_id)}:${encode(clientInformation.client_secret)}`).toString('base64')}`);
    } else {
      params.set('client_id', clientInformation.client_id);
      if (authMethod === 'client_secret_post') params.set('client_secret', clientInformation.client_secret);
    }
  }
  const tokenOptions = (discovery, signal) => ({ metadata: discovery.metadata, clientInformation, resource: discovery.resource, addClientAuthentication, fetchFn: createOAuthFetch({ allowedOrigins, allowedUrls: [discovery.metadata.token_endpoint], fetch: options.fetch, signal, timeoutMs }) });
  async function verifiedTokens(tokens, discovery, signal) {
    signal?.throwIfAborted();
    const verified = await abortable(Promise.resolve().then(() => resolveIdentity(structuredClone(tokens), structuredClone(discovery), { signal })), signal);
    signal?.throwIfAborted();
    return { identity: identityFrom(verified), ...tokenRecord(tokens, now(), verified) };
  }
  async function sessionRecord(id) {
    const record = id && await store.get(storageKey('session', id));
    if (!record || record.sessionExpiresAt <= now()) return undefined;
    return record;
  }
  async function freshGrant(id, expected, signal) {
    return store.withLock(storageKey('session', id), async () => {
      let record = await sessionRecord(id);
      if (!record) throw new ViewerError('UNAUTHENTICATED');
      if (IDENTITY_FIELDS.some(field => record.identity[field] !== expected[field])) throw new ViewerError('CONNECTION_CHANGED');
      if (record.expiresAt <= now() + refreshLeewayMs) {
        if (!record.tokens.refresh_token) { await store.delete(storageKey('session', id)); throw new ViewerError('UNAUTHENTICATED'); }
        try {
          const tokens = await refreshAuthorization(record.discovery.issuer, { ...tokenOptions(record.discovery, signal), refreshToken: record.tokens.refresh_token });
          const refreshed = await verifiedTokens({ ...tokens, refresh_token: tokens.refresh_token ?? record.tokens.refresh_token }, record.discovery, signal);
          if (IDENTITY_FIELDS.some(field => refreshed.identity[field] !== record.identity[field])) throw new ViewerError('CONNECTION_CHANGED');
          record = { ...record, ...refreshed };
          signal?.throwIfAborted();
          await store.set(storageKey('session', id), record, record.sessionExpiresAt);
        } catch (error) {
          await store.delete(storageKey('session', id));
          throw error instanceof ViewerError && error.code === 'CONNECTION_CHANGED' ? error : new ViewerError('UNAUTHENTICATED');
        }
      }
      signal?.throwIfAborted();
      return { ...record.identity, sessionId: id, expiresAt: Math.min(record.expiresAt, record.sessionExpiresAt), accessToken: record.tokens.access_token };
    });
  }
  async function resolveSession(request, { signal } = {}) {
    if (!configured) return null;
    const id = signedId(request, SESSION_COOKIE), record = await sessionRecord(id);
    if (!record) return null;
    const identity = { ...record.identity };
    return { ...identity, sessionId: id, expiresAt: record.sessionExpiresAt, getAccessToken: () => freshGrant(id, identity, signal) };
  }
  /** A consumed code still has a cancellable flow until any resulting session expires. */
  async function cancelFlow(id) {
    if (!id) return;
    const controlKey = storageKey('flow-control', id);
    await store.withLock(controlKey, async () => {
      const control = await store.get(controlKey);
      await store.delete(storageKey('flow', id));
      if (control?.sessionId) await store.withLock(storageKey('session', control.sessionId), () => store.delete(storageKey('session', control.sessionId)));
      await store.delete(controlKey);
    });
  }

  async function handleRequest(request, response) {
    const raw = request.url ?? '/';
    const path = raw.split('?')[0];
    if (!path.startsWith(PREFIX)) return false;
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Pragma', 'no-cache');
    response.setHeader('Vary', 'Cookie'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const cookies = [];
    const finish = (status, body, location) => {
      if (response.writableEnded || response.destroyed || controller.signal.aborted && status < 400) return;
      if (cookies.length) response.setHeader('Set-Cookie', cookies);
      if (location) response.setHeader('Location', location);
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.writeHead(status); response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const controller = new AbortController();
    const onAbort = () => controller.abort(new ViewerError('TIMEOUT'));
    request.once?.('aborted', onAbort);
    const timer = setTimeout(onAbort, timeoutMs); timer.unref?.();
    const signal = controller.signal;
    const execute = async () => { try {
      if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 8192 || /[\\\s#\u0000-\u001f\u007f]/.test(raw)) throw new ViewerError('BAD_REQUEST');
      try { decodeURIComponent(raw); } catch { throw new ViewerError('BAD_REQUEST'); }
      const url = new URL(raw, origin ?? 'https://viewer.invalid'), route = url.pathname.slice(PREFIX.length);
      if (!['status', 'login', 'callback', 'logout'].includes(route)) throw new ViewerError('NOT_FOUND');
      if (request.method !== (route === 'logout' ? 'POST' : 'GET')) throw new ViewerError('METHOD_NOT_ALLOWED');
      for (const name of url.searchParams.keys()) if (url.searchParams.getAll(name).length !== 1) throw new ViewerError('BAD_REQUEST');
      if (route === 'status') {
        if (url.search) throw new ViewerError('BAD_REQUEST');
        if (!configured) { finish(200, { configured: false, connected: false, state: 'unconfigured', message: 'Arena sign-in is not configured. Ask your Arena administrator to finish setup.' }); return; }
        const session = await resolveSession(request, { signal });
        finish(200, { configured: true, connected: !!session, state: session ? 'connected' : 'disconnected', loginPath: `${PREFIX}login`, logoutPath: `${PREFIX}logout`, ...(session ? { user: { id: session.userId, ...(session.displayName ? { displayName: session.displayName } : {}) }, workspaceId: session.workspaceId } : {}) });
      } else {
        if (!configured) throw new ViewerError('UNCONFIGURED');
        if (route === 'login') {
          if ([...url.searchParams.keys()].some(name => name !== 'returnTo')) throw new ViewerError('BAD_REQUEST');
          const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo') ?? '/', origin);
          const discovery = await discoverArenaOAuth(discoveryOptions(signal)); checkClient(discovery);
          const state = randomId(), flowId = randomId();
          const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.issuer, { metadata: discovery.metadata, clientInformation, redirectUrl: redirect.href, state, resource: discovery.resource, scope: discovery.scope });
          signal.throwIfAborted();
          const previous = signedId(request, FLOW_COOKIE);
          if (previous) await cancelFlow(previous);
          signal.throwIfAborted();
          const expiresAt = now() + flowTtlMs;
          // Keep the opaque cancellation handle through the latest possible session
          // expiry. State/code validity still ends at expiresAt, not at cookie expiry.
          const controlExpiresAt = expiresAt + timeoutMs + sessionTtlMs;
          await store.set(storageKey('flow-control', flowId), { status: 'active', expiresAt: controlExpiresAt }, controlExpiresAt);
          await store.set(storageKey('flow', flowId), { state, codeVerifier, returnTo, discovery, expiresAt }, expiresAt);
          if (signal.aborted) { await cancelFlow(flowId); signal.throwIfAborted(); }
          cookies.push(makeCookie(FLOW_COOKIE, flowId, Math.ceil((flowTtlMs + timeoutMs + sessionTtlMs) / 1000)));
          finish(302, undefined, authorizationUrl.href);
        } else if (route === 'callback') {
          if ([...url.searchParams.keys()].some(name => !['code', 'state', 'iss', 'error', 'error_description', 'error_uri'].includes(name))) throw new ViewerError('BAD_REQUEST');
          const flowId = signedId(request, FLOW_COOKIE);
          const pending = flowId && await store.get(storageKey('flow', flowId));
          if (!pending || pending.expiresAt <= now() || !sameText(url.searchParams.get('state'), pending.state)) throw new ViewerError('BAD_REQUEST');
          const flow = await store.consume(storageKey('flow', flowId));
          if (!flow || !sameText(flow.state, pending.state)) throw new ViewerError('BAD_REQUEST');
          cookies.push(makeCookie(FLOW_COOKIE, undefined, 0));
          validateAuthorizationResponseIssuer({ iss: url.searchParams.get('iss') ?? undefined, expectedIssuer: flow.discovery.issuer, issParameterSupported: flow.discovery.metadata.authorization_response_iss_parameter_supported === true });
          if (url.searchParams.has('error')) throw new ViewerError('UNAUTHENTICATED');
          const code = identityText(url.searchParams.get('code'), 8192);
          const tokens = await exchangeAuthorization(flow.discovery.issuer, { ...tokenOptions(flow.discovery, signal), authorizationCode: code, codeVerifier: flow.codeVerifier, redirectUri: redirect.href, iss: url.searchParams.get('iss') ?? undefined });
          const verified = await verifiedTokens(tokens, flow.discovery, signal), id = randomId();
          const record = { ...verified, discovery: flow.discovery, sessionExpiresAt: now() + sessionTtlMs };
          const controlKey = storageKey('flow-control', flowId);
          await store.withLock(controlKey, async () => {
            signal.throwIfAborted();
            const control = await store.get(controlKey);
            if (!control || control.status !== 'active' || control.expiresAt <= now()) throw new ViewerError('UNAUTHENTICATED');
            try {
              await store.set(storageKey('session', id), record, record.sessionExpiresAt);
              signal.throwIfAborted();
              await store.set(controlKey, { ...control, status: 'committed', sessionId: id }, control.expiresAt);
              const previous = signedId(request, SESSION_COOKIE);
              if (previous) await store.withLock(storageKey('session', previous), () => store.delete(storageKey('session', previous)));
              signal.throwIfAborted();
              cookies.push(makeCookie(SESSION_COOKIE, id, Math.ceil(sessionTtlMs / 1000)));
              finish(302, undefined, sanitizeReturnTo(flow.returnTo, origin));
            } catch (error) { await store.delete(storageKey('session', id)); throw error; }
          });
        } else if (route === 'logout') {
          if (url.search || request.headers?.origin !== origin) throw new ViewerError('FORBIDDEN');
          const id = signedId(request, SESSION_COOKIE), flowId = signedId(request, FLOW_COOKIE);
          if (flowId) await cancelFlow(flowId);
          if (id) await store.withLock(storageKey('session', id), () => store.delete(storageKey('session', id)));
          cookies.push(makeCookie(SESSION_COOKIE, undefined, 0), makeCookie(FLOW_COOKIE, undefined, 0));
          finish(204);
        }
      }
    } catch (error) {
      const failure = safeError(error);
      finish(failure.status, failure.body);
    } };
    try { await abortable(execute(), signal); }
    catch (error) { const failure = safeError(error); finish(failure.status, failure.body); }
    finally { clearTimeout(timer); request.off?.('aborted', onAbort); }
    return true;
  }
  // Configuration evidence only. No discovery, store operations, identity lookup,
  // or user authorization occurs here. Store flags are deployment declarations.
  const readiness = Object.freeze({
    version: 1, scope: 'configuration-only', configured,
    clientMode: ['manual', 'cimd'].includes(client?.mode) ? client.mode : 'unconfigured',
    development: Boolean(development),
    required: Object.freeze({
      endpoint: Boolean(mcpEndpoint), callback: Boolean(redirectUri),
      clientIdentity: Boolean(client?.clientId),
      clientAuthentication: Boolean(client?.mode === 'cimd' || client?.mode === 'manual' && client?.clientSecret),
      identityResolver: typeof resolveIdentity === 'function',
      approvedOrigins: Array.isArray(allowedOrigins) && allowedOrigins.length > 0,
      sessionStore: Boolean(store && ['get', 'set', 'delete', 'consume', 'withLock'].every(name => typeof store[name] === 'function')),
    }),
    deployment: Object.freeze({
      cookieKeyProvided: options.cookieKey instanceof Uint8Array && options.cookieKey.byteLength >= 32,
      productionStoreDeclared: store?.productionReady === true && store?.kind !== 'development-memory',
      encryptedStoreDeclared: store?.encrypted === true,
      sharedStoreDeclared: store?.shared === true,
    }),
  });
  return Object.freeze({ configured, readiness, handleRequest, resolveSession });
}
