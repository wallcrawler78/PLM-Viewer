import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { buildDiscoveryUrls, checkResourceAllowed, discoverAuthorizationServerMetadata, extractWWWAuthenticateParams } from '@modelcontextprotocol/client';
import { ViewerError } from '../errors.mjs';

const MAX_BYTES = 1024 * 1024;
export function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ViewerError('BAD_REQUEST'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || /[\s\\\u0000-\u001f\u007f]/.test(String(value))) throw new ViewerError('BAD_REQUEST');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host)) throw new ViewerError('FORBIDDEN');
  return url;
}
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a >= 224 || a === 198 && (b === 18 || b === 19));
  }
  // IPv6 global unicast only; reject mapped IPv4, loopback, link-local and ULA.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !address.toLowerCase().startsWith('2001:db8:');
}
/** DNS addresses are checked in the actual socket lookup, avoiding a check/fetch DNS race. */
async function pinnedLookup(hostname, options, callback) {
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some(answer => !publicAddress(answer.address))) throw new ViewerError('FORBIDDEN');
    if (options?.all) callback(null, answers);
    else callback(null, answers[0].address, answers[0].family);
  } catch (error) { callback(error); }
}
/** Small HTTPS-only fetch used in production. It never follows redirects or shares cookies. */
function nodeHttpsFetch(input, init = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    const body = init.body === undefined ? undefined : String(init.body);
    const request = httpsRequest(input, { method: init.method ?? 'GET', headers, signal: init.signal, lookup: pinnedLookup }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(new ViewerError('CONTENT_TOO_LARGE'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        const status = response.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}
export function createOAuthFetch({ allowedOrigins, allowedUrls, fetch: fetcher = nodeHttpsFetch, signal, timeoutMs = 15000 }) {
  const origins = new Set(allowedOrigins.map(value => httpsUrl(value).origin));
  const exact = allowedUrls && new Set(allowedUrls.map(value => httpsUrl(value).href));
  return async (input, init = {}) => {
    const url = httpsUrl(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin) || exact && !exact.has(url.href)) throw new ViewerError('FORBIDDEN');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [signal, init.signal, timeout].filter(Boolean);
    try {
      const response = await fetcher(url.href, { ...init, signal: AbortSignal.any(signals), redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== url.href) { await response.body?.cancel(); throw new ViewerError('FORBIDDEN'); }
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) { await response.body?.cancel(); throw new ViewerError('CONTENT_TOO_LARGE'); }
      if (!response.body) return response;
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new ViewerError('CONTENT_TOO_LARGE');
          chunks.push(Buffer.from(value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (timeout.aborted || error?.name === 'TimeoutError') throw new ViewerError('TIMEOUT');
      throw error instanceof ViewerError ? error : new ViewerError('UPSTREAM_ERROR');
    }
  };
}

/** Discover from the actual MCP 401 challenge; never guess a resource metadata or token URL. */
export async function discoverArenaOAuth({ mcpEndpoint, allowedOrigins, authorizationServer, allowedResources, approvedScopes, fetch, signal, timeoutMs }) {
  const endpoint = httpsUrl(mcpEndpoint);
  if (endpoint.search) throw new ViewerError('BAD_REQUEST');
  const options = { allowedOrigins, fetch, signal, timeoutMs };
  const challengeResponse = await createOAuthFetch({ ...options, allowedUrls: [endpoint.href] })(endpoint.href, { headers: { Accept: 'application/json' } });
  if (challengeResponse.status !== 401) throw new ViewerError(challengeResponse.status === 403 ? 'FORBIDDEN' : 'UPSTREAM_ERROR');
  const challenge = extractWWWAuthenticateParams(challengeResponse);
  if (!challenge.resourceMetadataUrl) throw new ViewerError('UPSTREAM_ERROR');
  const metadataUrl = httpsUrl(challenge.resourceMetadataUrl);
  const resourceResponse = await createOAuthFetch({ ...options, allowedUrls: [metadataUrl.href] })(metadataUrl.href, { headers: { Accept: 'application/json' } });
  if (!resourceResponse.ok) throw new ViewerError('UPSTREAM_ERROR');
  const resourceMetadata = await resourceResponse.json();
  if (!resourceMetadata || typeof resourceMetadata.resource !== 'string' || !Array.isArray(resourceMetadata.authorization_servers) || !resourceMetadata.authorization_servers.length) throw new ViewerError('UPSTREAM_ERROR');
  const resource = resourceMetadata.resource;
  httpsUrl(resource);
  if (!checkResourceAllowed({ requestedResource: endpoint, configuredResource: resource }) && !allowedResources?.includes(resource)) throw new ViewerError('FORBIDDEN');
  const issuer = authorizationServer ?? (resourceMetadata.authorization_servers.length === 1 ? resourceMetadata.authorization_servers[0] : undefined);
  if (!issuer || !resourceMetadata.authorization_servers.includes(issuer)) throw new ViewerError('UPSTREAM_ERROR');
  const issuerUrl = httpsUrl(issuer);
  if (issuerUrl.search || !allowedOrigins.some(value => httpsUrl(value).origin === issuerUrl.origin)) throw new ViewerError('FORBIDDEN');
  const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: createOAuthFetch({ ...options, allowedUrls: buildDiscoveryUrls(issuer).map(row => row.url.href) }) });
  if (!metadata || metadata.issuer !== issuer || !metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.response_types_supported?.includes('code') || !metadata.code_challenge_methods_supported?.includes('S256')) throw new ViewerError('UPSTREAM_ERROR');
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) if (!allowedOrigins.some(value => httpsUrl(value).origin === httpsUrl(endpoint).origin)) throw new ViewerError('FORBIDDEN');
  // scopes_supported describes availability, not permission to request every scope.
  if (approvedScopes !== undefined && (!Array.isArray(approvedScopes) || approvedScopes.some(scope => typeof scope !== 'string' || !scope || /[\s\u0000-\u001f\u007f]/.test(scope)))) throw new ViewerError('BAD_REQUEST');
  if (approvedScopes && challenge.scope?.split(' ').filter(Boolean).some(scope => !approvedScopes.includes(scope))) throw new ViewerError('FORBIDDEN');
  const scope = challenge.scope ?? approvedScopes?.join(' ');
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > 4096 || /[\u0000-\u001f\u007f]/.test(scope))) throw new ViewerError('UPSTREAM_ERROR');
  return Object.freeze({ mcpEndpoint: endpoint.href, resource, resourceMetadataUrl: metadataUrl.href, resourceMetadata, issuer, metadata, ...(scope ? { scope } : {}) });
}
