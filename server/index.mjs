/** Same-origin read-only BFF. Run: node server/index.mjs. No provider means no live data. */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ViewerError, identityText, safeError } from './errors.mjs';
import { validateContentIdentity, validateContentResult } from './content.mjs';

const PREFIX = '/api/viewer/v1/';
const AUTH_PREFIX = `${PREFIX}auth/`;
const AUTH_ROUTES = new Set(['status', 'login', 'callback', 'logout']);
const OAUTH_UNCONFIGURED = Object.freeze({ configured: false, connected: false, state: 'unconfigured', message: 'Arena sign-in is not configured for this viewer. Ask your administrator to finish the connection setup.' });
const ROUTES = Object.freeze({
  status: ['workspaceId'],
  schema: ['workspaceId'],
  revisions: ['workspaceId', 'itemId'],
  bom: ['workspaceId', 'itemId', 'revision', 'configurationId'],
  attachments: ['workspaceId', 'itemId', 'revision'],
  'supplier-items': ['workspaceId', 'itemId', 'revision'],
  content: ['workspaceId', 'itemId', 'revision', 'fileId', 'edition', 'sourceHash', 'kind', 'contentHash', 'connectionId'],
});
const UNCONFIGURED = Object.freeze({ configured: false, provider: 'arena', transport: 'mcp', state: 'unconfigured', readOnly: true, message: 'The Arena connection is not ready. Ask your administrator to finish setup. Preview is available separately.' });

function parseRequestUrl(request) {
  const raw = request.url ?? '/';
  if (raw.length > 8192 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\s#\u0000-\u001f\u007f]/.test(raw)) throw new ViewerError('BAD_REQUEST');
  // URLSearchParams tolerates invalid percent sequences and UTF-8. Reject ambiguity first.
  try { decodeURIComponent(raw.replace(/\+/g, '%20')); } catch { throw new ViewerError('BAD_REQUEST'); }
  return new URL(raw, 'https://viewer.invalid');
}

function parseRequest(request) {
  const url = parseRequestUrl(request);
  if (!url.pathname.startsWith(PREFIX)) throw new ViewerError('NOT_FOUND');
  const route = url.pathname.slice(PREFIX.length);
  if (!Object.hasOwn(ROUTES, route)) throw new ViewerError('NOT_FOUND');
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (!ROUTES[route].includes(key) || url.searchParams.getAll(key).length !== 1) throw new ViewerError('BAD_REQUEST');
    query[key] = identityText(value, key === 'revision' ? 100 : key === 'connectionId' ? 128 : 512);
  }
  if (route !== 'status' && !query.workspaceId) throw new ViewerError('BAD_REQUEST');
  if (!['status', 'schema'].includes(route) && !query.itemId) throw new ViewerError('BAD_REQUEST');
  if (['bom', 'attachments', 'supplier-items', 'content'].includes(route) && !query.revision) throw new ViewerError('BAD_REQUEST');
  if (route === 'content') {
    validateContentIdentity(query);
    if (!query.connectionId || !/^[A-Za-z0-9_-]{16,128}$/.test(query.connectionId)) throw new ViewerError('BAD_REQUEST');
  }
  const header = request.headers?.['x-viewer-connection'];
  if (header !== undefined && (typeof header !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(header))) throw new ViewerError('BAD_REQUEST');
  if (request.rawHeaders) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index].toLowerCase() === 'x-viewer-connection') count++;
    if (count > 1) throw new ViewerError('BAD_REQUEST');
  }
  return { route, query, expectedConnection: header };
}

export function createViewerServer(provider = null) {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Vary', 'Cookie, Authorization, X-Viewer-Connection');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once?.('aborted', abort);
    const closed = () => { if (!response.writableEnded) abort(); };
    response.once?.('close', closed);
    try {
      const requestUrl = parseRequestUrl(request);
      // OAuth is a separately configured application connection. It must remain
      // reachable while MCP operation bindings are still intentionally unset.
      if (requestUrl.pathname.startsWith(AUTH_PREFIX)) {
        const authRoute = requestUrl.pathname.slice(AUTH_PREFIX.length);
        if (!AUTH_ROUTES.has(authRoute)) throw new ViewerError('NOT_FOUND');
        if (typeof provider?.oauthAuth?.handleRequest === 'function') {
          if (await provider.oauthAuth.handleRequest(request, response)) return;
          throw new ViewerError('NOT_FOUND');
        }
        if (request.method === 'GET' && authRoute === 'status') {
          if ([...requestUrl.searchParams].length) throw new ViewerError('BAD_REQUEST');
          return send(200, OAUTH_UNCONFIGURED);
        }
        throw new ViewerError('UNCONFIGURED');
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        throw new ViewerError('METHOD_NOT_ALLOWED');
      }
      const { route, query, expectedConnection } = parseRequest(request);
      if (!provider || provider.configured === false) {
        if (route === 'status') return send(200, UNCONFIGURED);
        throw new ViewerError('UNCONFIGURED');
      }
      const context = await provider.authorize(request, { signal: controller.signal });
      if (!context?.userId || !context?.workspaceId) throw new ViewerError('UNAUTHENTICATED');
      if (query.workspaceId && query.workspaceId !== context.workspaceId) throw new ViewerError('FORBIDDEN');
      if (typeof context.connectionId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(context.connectionId)) throw new ViewerError('UPSTREAM_ERROR');
      response.setHeader('X-Viewer-Connection', context.connectionId);
      if ((expectedConnection && expectedConnection !== context.connectionId) || (query.connectionId && query.connectionId !== context.connectionId)) throw new ViewerError('CONNECTION_CHANGED');
      if (route === 'status') {
        if (typeof provider.status === 'function') return send(200, await provider.status(context));
        return send(200, { configured: true, provider: 'arena', transport: provider.transport ?? 'mcp', state: 'ready', readOnly: true, workspaceId: context.workspaceId, connectionId: context.connectionId, user: { id: context.userId, ...(context.displayName ? { displayName: context.displayName } : {}) }, capabilities: { annotations: false, conditionalWrites: false, sourceConversion: Boolean(provider.sourceConversion), supplierItems: typeof provider.listSupplierItems === 'function' } });
      }
      if (route === 'schema') return send(200, await provider.getSchema(context));
      const { itemId, revision, configurationId } = query;
      if (route === 'revisions') return send(200, await provider.listRevisions(context, { itemId }));
      if (route === 'bom') return send(200, await provider.resolveBom(context, { itemId, revision, ...(configurationId ? { configurationId } : {}) }));
      if (route === 'attachments') return send(200, await provider.listAttachments(context, { itemId, revision }));
      if (route === 'supplier-items') {
        if (typeof provider.listSupplierItems !== 'function' || provider.capabilities?.supplierItems === false) throw new ViewerError('UNSUPPORTED');
        return send(200, await provider.listSupplierItems(context, { itemId, revision }));
      }
      if (route === 'content') {
        if (typeof provider.readContent !== 'function') throw new ViewerError('UNSUPPORTED');
        const identity = validateContentIdentity(query);
        // Custom providers receive the same identity/byte validation as the MCP provider.
        const content = validateContentResult(await provider.readContent(context, identity), identity, provider.maxContentBytes);
        response.setHeader('Content-Type', content.contentType);
        response.setHeader('Content-Length', String(content.bytes.length));
        response.setHeader('Content-Disposition', `inline; filename="source.${identity.kind === 'mesh' ? 'json' : identity.kind}"; filename*=UTF-8''${encodeURIComponent(content.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`);
        response.writeHead(200);
        response.end(content.bytes);
      }
    } catch (error) {
      if (!response.writableEnded && !response.destroyed && !response.headersSent) {
        const failure = safeError(error);
        send(failure.status, failure.body);
      } else if (!response.writableEnded && !response.destroyed) {
        response.destroy?.();
      }
    } finally {
      request.off?.('aborted', abort);
      response.off?.('close', closed);
    }
  });
}

/** Trusted deployment path only; never accept a module path from an HTTP request. */
export async function loadConfiguredProvider(modulePath = process.env.ARENA_PROVIDER_MODULE) {
  if (!modulePath) return null;
  const module = await import(pathToFileURL(resolve(modulePath)).href);
  const provider = await module.createProvider();
  for (const method of ['authorize', 'getSchema', 'resolveBom', 'listRevisions', 'listAttachments']) {
    if (typeof provider?.[method] !== 'function') throw new Error(`Arena provider is missing ${method}.`);
  }
  return provider;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const provider = await loadConfiguredProvider();
  const port = Number(process.env.VIEWER_API_PORT ?? '4100');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VIEWER_API_PORT.');
  createViewerServer(provider).listen(port, '127.0.0.1', () => console.log(`Viewer service listening on 127.0.0.1:${port}; Arena ${provider?.configured !== false && provider ? 'provider installed' : 'not configured'}.`));
}
