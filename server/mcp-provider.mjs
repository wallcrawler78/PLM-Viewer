/**
 * Server-only MCP provider. Arena's endpoint, tool names and response mappings must
 * come from the vendor and a reviewed tenant module; none are guessed here.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { normalizeBomPlacements } from '../shared/bom-placements.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ViewerError, identityText, safeError } from './errors.mjs';
import { buildContentUrl, assertProtectedContentUrl, validateContentIdentity, validateContentResult, MAX_CONTENT_BYTES } from './content.mjs';

const REQUIRED_BINDINGS = ['getSchema', 'resolveBom', 'listRevisions', 'listAttachments', 'readContent'];
const IDENTITY_KEYS = ['userId', 'arenaUserId', 'workspaceId', 'sessionId'];
const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 20000, maxPages: 50, maxTools: 2000, maxItems: 100000, maxJsonBytes: 16 * 1024 * 1024, maxContentBytes: MAX_CONTENT_BYTES, maxMcpResponseBytes: 48 * 1024 * 1024 });

function bindingError(error) { return error instanceof ViewerError ? error : new ViewerError(safeError(error).body.code); }
function validExpiry(expiresAt, now) { if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new ViewerError('UNAUTHENTICATED'); }
function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Configure a valid HTTPS MCP endpoint.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('The MCP endpoint must use HTTPS without credentials, query parameters or a fragment.');
  return url;
}

async function isFeatureNotEnabled(response) {
  // Arena documents this exact failure code. Do not infer it from free text,
  // inspect arbitrary error bodies, or return upstream messages to the browser.
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentType) || !response.body) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) return false;
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body?.code === 'feature_not_enabled' || body?.error === 'feature_not_enabled' || body?.error?.code === 'feature_not_enabled';
  } catch { return false; }
  finally { await reader.cancel().catch(() => {}); }
}

/** Unwrap data without assuming structuredContent is an object. No prose/JSON guessing. */
export function unwrapToolResult(result) {
  if (!result || typeof result !== 'object' || result.isError || result.type === 'input_required' || result.resultType === 'input_required') throw new ViewerError('UPSTREAM_ERROR');
  if (Object.hasOwn(result, 'structuredContent')) return result.structuredContent;
  if (Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === 'text') {
    try { return JSON.parse(result.content[0].text); } catch { throw new ViewerError('UPSTREAM_ERROR'); }
  }
  throw new ViewerError('UPSTREAM_ERROR');
}

/** Reusable for vendor data pagination. Reaching a bound is an error, never a partial BOM. */
export async function collectPages(fetchPage, { maxPages = 50, maxItems = 100000, signal } = {}) {
  const values = [], seen = new Set();
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted();
    const result = await fetchPage(cursor);
    if (!result || !Array.isArray(result.items) || values.length + result.items.length > maxItems) throw new ViewerError('UPSTREAM_ERROR');
    values.push(...result.items);
    if (result.nextCursor === undefined || result.nextCursor === null) {
      if (result.complete === false || (result.total !== undefined && result.total !== values.length)) throw new ViewerError('UPSTREAM_ERROR');
      return values;
    }
    if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096) throw new ViewerError('UPSTREAM_ERROR');
    cursor = result.nextCursor; // MCP cursors are opaque; even the empty string is valid.
    if (seen.has(cursor)) throw new ViewerError('UPSTREAM_ERROR');
    seen.add(cursor);
  }
  throw new ViewerError('UPSTREAM_ERROR');
}

/** Token-bearing SDK requests may only visit the configured endpoint, without redirects. */
export function createGuardedMcpFetch(endpoint, fetcher = globalThis.fetch, { signal, maxBytes = DEFAULT_LIMITS.maxMcpResponseBytes } = {}) {
  const target = validateEndpoint(endpoint).href;
  return async (input, init = {}) => {
    signal?.throwIfAborted();
    const requestUrl = input instanceof Request ? input.url : String(input);
    if (new URL(requestUrl).href !== target) throw new ViewerError('FORBIDDEN');
    const signals = [signal, init.signal, input instanceof Request ? input.signal : undefined].filter(Boolean);
    const response = await fetcher(input, { ...init, signal: signals.length ? AbortSignal.any(signals) : undefined, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== target)) {
      await response.body?.cancel().catch(() => {});
      throw new ViewerError('FORBIDDEN');
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new ViewerError('UNAUTHENTICATED');
    }
    if (response.status === 403) {
      throw new ViewerError(await isFeatureNotEnabled(response) ? 'FEATURE_NOT_ENABLED' : 'FORBIDDEN');
    }
    if (response.status === 429) {
      // Do not parse or expose the upstream body/header values, or retry a throttled
      // operation here. Preserve its actionable state through SDK wrapping.
      void response.body?.cancel().catch(() => {});
      throw new ViewerError('RATE_LIMITED');
    }
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel().catch(() => {});
      throw new ViewerError('CONTENT_TOO_LARGE');
    }
    if (!response.body) return response;
    let received = 0;
    const bounded = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) throw new ViewerError('CONTENT_TOO_LARGE');
        controller.enqueue(chunk);
      },
    }));
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function assertResultBoundary(operation, data, context, query, limits) {
  let json;
  try { json = JSON.stringify(data); } catch { throw new ViewerError('UPSTREAM_ERROR'); }
  if (typeof json !== 'string' || Buffer.byteLength(json) > limits.maxJsonBytes) throw new ViewerError('UPSTREAM_ERROR');
  // Bindings are trusted normalization code. This last gate prevents accidentally
  // returning SDK envelopes, credentials, or upstream download locations to a browser.
  const scan = (value, depth = 0) => {
    if (depth > 40) throw new ViewerError('UPSTREAM_ERROR');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(access_?token|refresh_?token|authorization|client_?secret|sessionId)$/i.test(key)) throw new ViewerError('UPSTREAM_ERROR');
      if (key !== 'attributes') scan(child, depth + 1); // Attribute GUIDs/values are tenant data, not an SDK envelope.
    }
  };
  scan(data);
  const fields = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ViewerError('UPSTREAM_ERROR');
  };
  const attachment = (file, exact) => {
    fields(file, ['id', 'seriesId', 'itemId', 'revision', 'kind', 'name', 'url', 'edition', 'sourceHash', 'text']);
    if (!file || (exact && (file.itemId !== exact.itemId || file.revision !== exact.revision))) throw new ViewerError('SOURCE_CHANGED');
    const identity = validateContentIdentity({ ...file, fileId: file.id }, 'UPSTREAM_ERROR');
    if (!['pdf', 'docx', 'doc'].includes(identity.kind)) throw new ViewerError('UPSTREAM_ERROR');
    assertProtectedContentUrl(file.url, context, identity);
  };
  if (operation === 'getSchema') {
    fields(data, ['workspaceId', 'name', 'preset', 'version', 'attributes']);
    if (data.workspaceId !== context.workspaceId || !Array.isArray(data.attributes)) throw new ViewerError('UPSTREAM_ERROR');
    for (const attribute of data.attributes) fields(attribute, ['id', 'label', 'type', 'scope', 'unit', 'options', 'defaultVisible']);
  }
  if (operation === 'listRevisions') {
    if (!Array.isArray(data)) throw new ViewerError('UPSTREAM_ERROR');
    data.forEach(revision => fields(revision, ['id', 'label', 'lifecycle']));
  }
  if (operation === 'listAttachments') {
    if (!Array.isArray(data)) throw new ViewerError('UPSTREAM_ERROR');
    data.forEach(file => attachment(file, query));
  }
  if (operation === 'listSupplierItems') {
    if (!Array.isArray(data)) throw new ViewerError('UPSTREAM_ERROR');
    for (const item of data) {
      fields(item, ['id', 'itemId', 'supplierId', 'supplierName', 'partNumber', 'name', 'attributes', 'attachments']);
      if (item?.itemId !== query.itemId) throw new ViewerError('SOURCE_CHANGED');
      if (item.attachments !== undefined) {
        if (!Array.isArray(item.attachments)) throw new ViewerError('UPSTREAM_ERROR');
        item.attachments.forEach(file => attachment(file));
      }
    }
  }
  if (operation === 'resolveBom') {
    fields(data, ['id', 'workspaceId', 'rootItemId', 'rootItemNumber', 'title', 'revision', 'configurationId', 'units', 'upAxis', 'placementSpace', 'capturedAt', 'parts', 'occurrences', 'documents', 'attributes', 'assemblyStepUrl', 'modelSources']);
    if (data.placementSpace !== undefined && !['world', 'parent'].includes(data.placementSpace)) throw new ViewerError('UPSTREAM_ERROR');
    if (!data || data.workspaceId !== context.workspaceId || data.rootItemId !== query.itemId || data.revision !== query.revision || (query.configurationId && data.configurationId !== query.configurationId)) throw new ViewerError('SOURCE_CHANGED');
    if (!Array.isArray(data.parts) || !Array.isArray(data.documents) || !Array.isArray(data.occurrences)) throw new ViewerError('UPSTREAM_ERROR');
    const sources = data.modelSources ?? [];
    if (!Array.isArray(sources)) throw new ViewerError('UPSTREAM_ERROR');
    sources.forEach(source => fields(source, ['id', 'itemId', 'revision', 'edition', 'sourceHash', 'occurrenceIds']));
    data.occurrences.forEach(occurrence => fields(occurrence, ['id', 'parentId', 'partId', 'partRevision', 'itemNumber', 'name', 'position', 'rotation', 'quantity', 'attributes', 'modelState']));
    const rawSources = new Map();
    for (const part of data.parts) {
      fields(part, ['id', 'itemNumber', 'name', 'revision', 'stepUrl', 'meshUrl', 'displaySource', 'cadNodePath', 'sourceToPart', 'sourceHash', 'color', 'material', 'bbox', 'volumeMm3', 'attributes']);
      if (part.displaySource !== undefined && !['step', 'mesh'].includes(part.displaySource) || part.displaySource === 'mesh' && !part.meshUrl) throw new ViewerError('UPSTREAM_ERROR');
      if (part.cadNodePath !== undefined && (!Array.isArray(part.cadNodePath) || part.cadNodePath.length > 64 || Array.from(part.cadNodePath).some(index => !Number.isSafeInteger(index) || index < 0 || index >= 20000) || part.displaySource === 'mesh')) throw new ViewerError('UPSTREAM_ERROR');
      if (part.sourceToPart !== undefined) {
        fields(part.sourceToPart, ['position', 'rotation']);
        const finiteVector = value => Array.isArray(value) && value.length === 3 && [0, 1, 2].every(index => Number.isFinite(value[index]));
        if (part.displaySource === 'mesh' || !finiteVector(part.sourceToPart.position) || !finiteVector(part.sourceToPart.rotation)) throw new ViewerError('UPSTREAM_ERROR');
      }
      // OCCT retains source assembly placements. Explicitly map those points into
      // part space (mm, right-handed XYZ Euler radians) before the occurrence pose.
      if (part.cadNodePath !== undefined && part.sourceToPart === undefined) throw new ViewerError('UPSTREAM_ERROR');
      assertProtectedContentUrl(part.stepUrl, context, { kind: 'step', sourceHash: part.sourceHash });
      const step = validateContentIdentity(Object.fromEntries(new URL(part.stepUrl, 'https://viewer.invalid').searchParams));
      if (part.meshUrl !== undefined) assertProtectedContentUrl(part.meshUrl, context, { kind: 'mesh', fileId: step.fileId, itemId: step.itemId, revision: step.revision, edition: step.edition, sourceHash: step.sourceHash });
      if (part.displaySource !== 'mesh') {
        if ((step.itemId !== part.id || step.revision !== part.revision) && part.cadNodePath === undefined) throw new ViewerError('UPSTREAM_ERROR');
        const key = JSON.stringify([step.fileId, step.itemId, step.revision, step.edition, step.sourceHash]);
        const paths = rawSources.get(key) ?? [];
        const path = part.cadNodePath ?? [];
        if (paths.some(previous => previous.slice(0, Math.min(previous.length, path.length)).every((value, index) => value === path[index]))) throw new ViewerError('UPSTREAM_ERROR');
        rawSources.set(key, [...paths, path]);
      }
      const matches = sources.filter(source => source.id === step.fileId && source.itemId === step.itemId && source.revision === step.revision && source.edition === step.edition && source.sourceHash === step.sourceHash);
      if (matches.length !== 1 || !Array.isArray(matches[0].occurrenceIds)) throw new ViewerError('SOURCE_CHANGED');
      // A root assembly STEP may legitimately supply meshes for many logical parts.
      const occurrences = data.occurrences.filter(occurrence => occurrence.partId === part.id && occurrence.partRevision === part.revision);
      if (occurrences.some(occurrence => !matches[0].occurrenceIds.includes(occurrence.id))) throw new ViewerError('SOURCE_CHANGED');
    }
    if (data.assemblyStepUrl) assertProtectedContentUrl(data.assemblyStepUrl, context, { kind: 'step', itemId: query.itemId, revision: query.revision });
    data.documents.forEach(file => attachment(file));
    if (data.placementSpace === 'parent') {
      try { return normalizeBomPlacements(data); }
      catch { throw new ViewerError('UPSTREAM_ERROR'); }
    }
  }
  return data;
}

/**
 * Trusted session resolver contract (server session/OAuth bridge, never caller headers):
 * {userId,arenaUserId,workspaceId,sessionId,expiresAt,displayName?,accessToken?}
 * or getAccessToken(): Promise<{...same identity fields,expiresAt,accessToken}>.
 * expiresAt is epoch milliseconds; every fresh grant must retain the bound identity.
 *
 * Each binding: async (readApi, query, publicContext) => normalized domain value.
 * Optional binding: listSupplierItems. Required readContent returns exact identity,
 * bytes (Uint8Array), contentType and optional name. A reviewed sourceConversion flag
 * may be set only when readContent actually supplies validated STEP derivatives.
 */
export function createArenaMcpProvider(options = {}) {
  const { endpoint, resolveSession, bindings: suppliedBindings = {}, approvedReadTools = [], approvedResourceUri, sourceConversion = false, fetch: fetcher = globalThis.fetch, now = Date.now } = options;
  // Deployment configuration is a construction-time contract. A caller cannot
  // replace a checked function or mutate a secret key behind the static report.
  const bindings = Object.freeze({ ...suppliedBindings });
  const url = endpoint ? validateEndpoint(endpoint) : undefined;
  if (!Array.isArray(approvedReadTools) || approvedReadTools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.:/-]{1,256}$/.test(name)) || new Set(approvedReadTools).size !== approvedReadTools.length) throw new Error('Provide explicit unique reviewed MCP read-tool names.');
  if (approvedResourceUri !== undefined && typeof approvedResourceUri !== 'function') throw new Error('Resource access requires a trusted URI approval function.');
  const allowlist = new Set(approvedReadTools);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) if (!Object.hasOwn(DEFAULT_LIMITS, name) || !Number.isSafeInteger(value) || value < 1 || value > 512 * 1024 * 1024) throw new Error('Invalid MCP provider limits.');
  Object.freeze(limits);
  const suppliedKey = options.connectionKey ?? randomBytes(32);
  if (!(suppliedKey instanceof Uint8Array) || suppliedKey.byteLength < 32) throw new Error('Use at least 32 secret bytes for the connection identity key.');
  const connectionKey = Buffer.from(suppliedKey);
  const sessions = new WeakMap();
  const required = Object.freeze({
    endpoint: Boolean(url),
    sessionResolver: typeof resolveSession === 'function',
    approvedReadTools: allowlist.size > 0,
    ...Object.fromEntries(REQUIRED_BINDINGS.map(name => [name, typeof bindings[name] === 'function'])),
  });
  const configured = Object.values(required).every(Boolean);
  // Presence checks only: no resolver, binding, network, or customer data is read.
  // This report is not evidence of verified Arena permissions or mapping fidelity.
  const readiness = Object.freeze({
    version: 1, scope: 'configuration-only', configured, required,
    deployment: Object.freeze({ connectionKeyProvided: options.connectionKey instanceof Uint8Array }),
    limits,
  });
  const capabilities = Object.freeze({ annotations: false, conditionalWrites: false, sourceConversion: Boolean(sourceConversion && typeof bindings.readContent === 'function'), supplierItems: typeof bindings.listSupplierItems === 'function' });

  async function authorize(request, { signal } = {}) {
    if (!configured) throw new ViewerError('UNCONFIGURED');
    signal?.throwIfAborted();
    let supplied;
    const authSignal = AbortSignal.any([AbortSignal.timeout(limits.timeoutMs), ...(signal ? [signal] : [])]);
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new ViewerError('TIMEOUT'));
      authSignal.addEventListener('abort', onAbort, { once: true });
    });
    try { supplied = await Promise.race([resolveSession(request, { signal: authSignal }), interrupted]); }
    catch (error) { throw bindingError(error); }
    finally { authSignal.removeEventListener('abort', onAbort); }
    if (!supplied || typeof supplied !== 'object') throw new ViewerError('UNAUTHENTICATED');
    const identity = {};
    for (const key of IDENTITY_KEYS) identity[key] = identityText(supplied[key], 512, 'UNAUTHENTICATED');
    validExpiry(supplied.expiresAt, now());
    if (typeof supplied.accessToken !== 'string' && typeof supplied.getAccessToken !== 'function') throw new ViewerError('UNAUTHENTICATED');
    const connectionId = createHmac('sha256', connectionKey).update(JSON.stringify(IDENTITY_KEYS.map(key => identity[key]))).digest('base64url');
    const context = Object.freeze({ userId: identity.userId, arenaUserId: identity.arenaUserId, workspaceId: identity.workspaceId, connectionId, ...(supplied.displayName ? { displayName: identityText(supplied.displayName, 200, 'UNAUTHENTICATED') } : {}) });
    // Snapshot the grant; a mutable resolver object cannot switch identities after authorization.
    const session = { ...identity, expiresAt: supplied.expiresAt, accessToken: supplied.accessToken, getAccessToken: supplied.getAccessToken, signal };
    sessions.set(context, session);
    return context;
  }

  async function withReadApi(context, operation) {
    const session = sessions.get(context);
    if (!configured) throw new ViewerError('UNCONFIGURED');
    if (!session) throw new ViewerError('UNAUTHENTICATED');
    const controller = new AbortController();
    const signal = session.signal ? AbortSignal.any([session.signal, controller.signal]) : controller.signal;
    let timeout;
    const getToken = async () => {
      signal.throwIfAborted();
      validExpiry(session.expiresAt, now());
      const grant = session.getAccessToken ? await session.getAccessToken() : session;
      if (!grant || IDENTITY_KEYS.some(key => grant[key] !== session[key])) throw new ViewerError('CONNECTION_CHANGED');
      validExpiry(grant.expiresAt, now());
      const accessToken = identityText(grant.accessToken, 16384, 'UNAUTHENTICATED');
      if (/\s/.test(accessToken)) throw new ViewerError('UNAUTHENTICATED');
      return accessToken;
    };
    const guardedFetch = createGuardedMcpFetch(url.href, fetcher, { signal, maxBytes: limits.maxMcpResponseBytes });
    const client = new Client({ name: 'arena-review-viewer', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: false }, listMaxPages: limits.maxPages });
    const transport = new StreamableHTTPClientTransport(url, { authProvider: { token: getToken }, onInsufficientScope: 'throw', fetch: guardedFetch });
    let catalogPromise;
    const catalog = () => catalogPromise ??= collectPages(async cursor => {
      signal.throwIfAborted();
      // SDK listTools() auto-aggregates and treats identical repeated pages as a
      // terminal condition. Walk raw typed requests so a loop never looks complete.
      const page = await client.request({ method: 'tools/list', params: cursor !== undefined ? { cursor } : {} }, { signal, timeout: limits.timeoutMs });
      if (!page || !Array.isArray(page.tools)) throw new ViewerError('UPSTREAM_ERROR');
      return { items: page.tools, nextCursor: page.nextCursor };
    }, { maxPages: limits.maxPages, maxItems: limits.maxTools, signal }).then(tools => {
      const names = new Set();
      for (const tool of tools) {
        if (!tool?.name || names.has(tool.name)) throw new ViewerError('UPSTREAM_ERROR');
        names.add(tool.name);
      }
      // Tool-directed HTTP header mappings need a separately verified vendor policy.
      // Until then exclude them, including otherwise allowlisted read tools.
      return tools.filter(tool => allowlist.has(tool.name) && tool.annotations?.readOnlyHint !== false && tool.annotations?.destructiveHint !== true && !JSON.stringify(tool.inputSchema).includes('"x-mcp-header"'));
    });
    const api = Object.freeze({
      signal,
      async listTools() { return structuredClone(await catalog()); },
      async callTool(name, args = {}) {
        signal.throwIfAborted();
        if (!allowlist.has(name)) throw new ViewerError('FORBIDDEN');
        const toolDefinition = (await catalog()).find(tool => tool.name === name);
        if (!toolDefinition) throw new ViewerError('FORBIDDEN');
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ViewerError('UPSTREAM_ERROR');
        const result = await client.callTool({ name, arguments: args }, { signal, timeout: limits.timeoutMs, toolDefinition });
        if (!result || result.isError || result.type === 'input_required' || result.resultType === 'input_required') throw new ViewerError('UPSTREAM_ERROR');
        return result;
      },
      async readResource(uri) {
        signal.throwIfAborted();
        identityText(uri, 4096, 'UPSTREAM_ERROR');
        if (!approvedResourceUri || await approvedResourceUri(uri, context) !== true) throw new ViewerError('FORBIDDEN');
        const result = await client.readResource({ uri }, { signal, timeout: limits.timeoutMs });
        if (!result || !Array.isArray(result.contents) || result.contents.some(content => content.uri !== uri)) throw new ViewerError('UPSTREAM_ERROR');
        return result;
      },
      collectPages: fetchPage => collectPages(fetchPage, { maxPages: limits.maxPages, maxItems: limits.maxItems, signal }),
      contentUrl: source => buildContentUrl(context, source),
      data: unwrapToolResult,
    });
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => { const error = new ViewerError('TIMEOUT'); controller.abort(error); reject(error); }, limits.timeoutMs);
      timeout.unref?.();
    });
    try {
      return await Promise.race([(async () => {
        await getToken();
        await client.connect(transport);
        const result = await operation(api);
        signal.throwIfAborted();
        validExpiry(session.expiresAt, now());
        return result;
      })(), timedOut]);
    } catch (error) { throw bindingError(error); }
    finally {
      clearTimeout(timeout);
      controller.abort();
      await client.close().catch(() => {});
    }
  }

  const invoke = (name, context, query = {}) => {
    if (typeof bindings[name] !== 'function') throw new ViewerError('UNSUPPORTED');
    return withReadApi(context, async api => {
      const result = await bindings[name](api, Object.freeze({ ...query }), context);
      return name === 'readContent' ? validateContentResult(result, query, limits.maxContentBytes) : assertResultBoundary(name, result, context, query, limits);
    });
  };
  return Object.freeze({
    configured, transport: 'mcp', readOnly: true, capabilities, readiness, maxContentBytes: limits.maxContentBytes,
    sourceConversion: capabilities.sourceConversion,
    authorize,
    async status(context) {
      return withReadApi(context, async api => {
        if (!(await api.listTools()).length) throw new ViewerError('FORBIDDEN');
        return { configured: true, provider: 'arena', transport: 'mcp', state: 'ready', readOnly: true, workspaceId: context.workspaceId, connectionId: context.connectionId, user: { id: context.userId, ...(context.displayName ? { displayName: context.displayName } : {}) }, capabilities, readiness };
      });
    },
    getSchema: context => invoke('getSchema', context),
    resolveBom: (context, query) => invoke('resolveBom', context, query),
    listRevisions: (context, query) => invoke('listRevisions', context, query),
    listAttachments: (context, query) => invoke('listAttachments', context, query),
    listSupplierItems: (context, query) => invoke('listSupplierItems', context, query),
    readContent: (context, query) => {
      if (query?.kind === 'mesh' && !capabilities.sourceConversion) throw new ViewerError('UNSUPPORTED');
      return invoke('readContent', context, validateContentIdentity(query));
    },
  });
}
