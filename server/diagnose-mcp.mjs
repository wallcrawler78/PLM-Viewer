/** Public, credential-free discovery diagnostic. Never logs a response body or a token. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function publicHttpsUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('INVALID_URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('INVALID_URL');
  return url;
}
async function smallJson(response, maxBytes = 65536) {
  if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error('INVALID_METADATA');
  const chunks = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('INVALID_METADATA');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
function publicStrings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== 'string' || item.length > 256 || /[\u0000-\u001f\u007f]/.test(item))) throw new Error('INVALID_METADATA');
  return value;
}

/**
 * GET endpoint -> 401 challenge -> protected-resource metadata only.
 * Does not discover clients, start OAuth, fetch a token or enumerate private tools.
 * Cross-origin resource metadata is refused unless its origin is explicitly allowed.
 */
export async function diagnoseMcpEndpoint(endpoint, { fetch: fetcher = globalThis.fetch, timeoutMs = 8000, allowedMetadataOrigins = [] } = {}) {
  let target;
  try { target = publicHttpsUrl(endpoint); } catch { return { ok: false, code: 'INVALID_ENDPOINT', message: 'Supply an explicit HTTPS MCP endpoint without credentials, a query or fragment.' }; }
  const result = { endpoint: target.href, authenticated: false };
  const approved = new Set([target.origin]);
  try { for (const origin of allowedMetadataOrigins) { const url = publicHttpsUrl(origin); if (url.pathname !== '/') throw new Error('INVALID_ORIGIN'); approved.add(url.origin); } }
  catch { return { ...result, ok: false, code: 'INVALID_ORIGIN', message: 'Metadata origins must be explicit HTTPS origins.' }; }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return { ...result, ok: false, code: 'INVALID_TIMEOUT', message: 'Diagnostic timeout must be between 1 and 30000 milliseconds.' };
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async url => {
    const response = await fetcher(url.href, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' }, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal });
    if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url.href)) {
      await response.body?.cancel().catch(() => {});
      throw new Error('UNEXPECTED_REDIRECT');
    }
    return response;
  };
  try {
    const challenge = await get(target);
    result.mcpStatus = challenge.status;
    const header = challenge.headers.get('www-authenticate') ?? '';
    await challenge.body?.cancel().catch(() => {});
    if (challenge.status !== 401) return { ...result, ok: false, code: 'EXPECTED_AUTH_CHALLENGE', message: 'No expected 401 discovery challenge was returned. No authenticated request was attempted.' };
    if (header.length > 8192) throw new Error('INVALID_METADATA');
    const locations = [...header.matchAll(/\bresource_metadata\s*=\s*"([^"\r\n]+)"/gi)].map(match => match[1]);
    if (locations.length !== 1) return { ...result, ok: false, code: 'DISCOVERY_HEADER_UNAVAILABLE', message: 'The 401 response did not contain one unambiguous resource_metadata discovery URL.' };
    const metadataUrl = publicHttpsUrl(locations[0]);
    if (!approved.has(metadataUrl.origin)) return { ...result, ok: false, code: 'METADATA_ORIGIN_NOT_APPROVED', message: 'The challenge points to another metadata origin. Review and explicitly approve it before retrying.' };
    result.resourceMetadataUrl = metadataUrl.href;
    const metadataResponse = await get(metadataUrl);
    result.resourceMetadataStatus = metadataResponse.status;
    if (!metadataResponse.ok) {
      await metadataResponse.body?.cancel().catch(() => {});
      return { ...result, ok: false, code: 'METADATA_UNAVAILABLE', message: 'Protected-resource metadata could not be retrieved.' };
    }
    const data = await smallJson(metadataResponse);
    publicHttpsUrl(data.resource);
    const resource = data.resource; // OAuth audience/resource identifiers are compared exactly.
    if (!Array.isArray(data.authorization_servers) || !data.authorization_servers.length || data.authorization_servers.length > 16) throw new Error('INVALID_METADATA');
    const authorizationServers = data.authorization_servers.map(value => { publicHttpsUrl(value); return value; });
    return { ...result, ok: true, resource, authorizationServers, scopesSupported: publicStrings(data.scopes_supported), bearerMethodsSupported: publicStrings(data.bearer_methods_supported), message: 'Public resource discovery completed. Authorization-server discovery, user login and private tool access have not been tested.' };
  } catch {
    return { ...result, ok: false, code: signal.aborted ? 'DISCOVERY_TIMEOUT' : 'DISCOVERY_FAILED', message: signal.aborted ? 'Public discovery timed out. No authenticated request was attempted.' : 'Public discovery failed validation or could not be completed. No response body or credentials were recorded.' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const endpoint = args.find(value => !value.startsWith('--'));
  const allowedMetadataOrigins = args.filter(value => value.startsWith('--allow-metadata-origin=')).map(value => value.slice('--allow-metadata-origin='.length));
  const invalid = args.some(value => value !== endpoint && !value.startsWith('--allow-metadata-origin='));
  const result = invalid ? { ok: false, code: 'INVALID_ARGUMENTS', message: 'Use: node server/diagnose-mcp.mjs HTTPS_MCP_ENDPOINT [--allow-metadata-origin=HTTPS_ORIGIN]' } : await diagnoseMcpEndpoint(endpoint, { allowedMetadataOrigins });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
