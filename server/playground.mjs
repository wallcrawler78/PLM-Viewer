import { randomUUID } from 'node:crypto';
import { ASSISTANT_LIMITS, PlaygroundError, assistantFailure, validateAssistantRequest, validateAssistantPlan, stampAssistantConcepts } from '../shared/playground-contract.mjs';
import { abortable, createAnthropicAssistant } from '../shared/playground-provider.mjs';

const PREFIX = '/api/viewer/v1/playground/';
const loopback = value => value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
const localHost = value => ['localhost', '127.0.0.1', '[::1]'].includes(value);
const UNCONFIGURED = Object.freeze({ configured: false, available: false, state: 'unconfigured', imagesAllowed: false, liveEcr: false, message: 'AI is not connected. Drawing, editing, comparison and Preview ECR tools work locally.' });

/** Trusted server configuration; the browser cannot choose a provider, endpoint or key. */
export function createPlaygroundGateway({ assistant, allowedOrigin, allowLocalPreview = false, allowImages = false, timeoutMs = ASSISTANT_LIMITS.timeoutMs, now = Date.now }) {
  if (!assistant || typeof assistant.propose !== 'function' || typeof assistant.model !== 'string') throw new Error('A Playground assistant adapter is required.');
  let origin;
  try { origin = new URL(allowedOrigin); } catch { throw new Error('Configure PLAYGROUND_ALLOWED_ORIGIN.'); }
  if (origin.origin !== allowedOrigin || origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) || (origin.protocol !== 'https:' && !localHost(origin.hostname))) throw new Error('Playground needs an exact HTTPS origin, or HTTP loopback for local development.');
  if (allowLocalPreview && !localHost(origin.hostname)) throw new Error('Anonymous Preview AI is restricted to an explicit loopback origin.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) throw new Error('Invalid Playground request timeout.');
  const active = new Set(), recent = new Map();
  return {
    assistant, allowedOrigin, allowLocalPreview, allowImages, timeoutMs,
    reserve(key) {
      const time = now();
      for (const [id, times] of recent) { const current = times.filter(value => time - value < 3_600_000); if (current.length) recent.set(id, current); else recent.delete(id); }
      const times = recent.get(key) ?? [];
      if (active.has(key) || active.size >= 4 || recent.size >= 5000 && !recent.has(key) || times.length >= 20 || times.filter(value => time - value < 60_000).length >= 6) throw new PlaygroundError('BUSY');
      active.add(key); recent.set(key, [...times, time]);
      return () => active.delete(key);
    },
  };
}

export function loadConfiguredPlayground(env = process.env) {
  if (env.PLAYGROUND_AI_ENABLED !== 'true') return null;
  return createPlaygroundGateway({
    assistant: createAnthropicAssistant({ apiKey: env.PLAYGROUND_ANTHROPIC_API_KEY, model: env.PLAYGROUND_MODEL || 'claude-fable-5-2' }),
    allowedOrigin: env.PLAYGROUND_ALLOWED_ORIGIN,
    allowLocalPreview: env.PLAYGROUND_ALLOW_LOCAL_PREVIEW === 'true',
    allowImages: env.PLAYGROUND_ALLOW_IMAGES === 'true',
  });
}

async function authorize(request, provider, gateway, sourceMode, workspaceId, details, signal) {
  if (sourceMode === 'preview') {
    if (!gateway.allowLocalPreview || !loopback(request.socket?.remoteAddress) || !localHost(new URL(gateway.allowedOrigin).hostname)) throw new PlaygroundError('FORBIDDEN');
    return { key: 'local-preview', imagesAllowed: gateway.allowImages };
  }
  if (sourceMode !== 'arena' || !provider || typeof provider.authorize !== 'function') throw new PlaygroundError('AUTH_REQUIRED');
  const context = await abortable(provider.authorize(request, { signal }), signal);
  if (!context?.userId || context.workspaceId !== workspaceId || typeof context.connectionId !== 'string') throw new PlaygroundError('FORBIDDEN');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(context.connectionId) || request.headers?.['x-viewer-connection'] !== context.connectionId) throw new PlaygroundError('CONNECTION_CHANGED');
  // Read access does not authorize sending engineering data to an external AI.
  if (typeof provider.authorizePlaygroundAI !== 'function') throw new PlaygroundError('FORBIDDEN');
  const permission = await abortable(provider.authorizePlaygroundAI(context, { ...details, signal }), signal);
  if (!permission || permission.allowed !== true) throw new PlaygroundError('FORBIDDEN');
  return { key: `${context.workspaceId}:${context.userId}`, connectionId: context.connectionId, imagesAllowed: gateway.allowImages && permission.allowImages === true };
}

async function readBody(request, signal) {
  const contentType = request.headers?.['content-type'] ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) throw new PlaygroundError('INVALID_REQUEST');
  if (request.headers?.['content-encoding']) throw new PlaygroundError('INVALID_REQUEST');
  const length = request.headers?.['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > ASSISTANT_LIMITS.requestBytes)) throw new PlaygroundError('TOO_LARGE');
  let size = 0;
  const chunks = [], iterator = request[Symbol.asyncIterator]();
  for (;;) {
    const { value, done } = await abortable(iterator.next(), signal);
    if (done) break;
    size += value.byteLength;
    if (size > ASSISTANT_LIMITS.requestBytes) { request.resume?.(); throw new PlaygroundError('TOO_LARGE'); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new PlaygroundError('INVALID_REQUEST'); }
}

/** This route proposes local scene data only. It cannot write an Arena record. */
export async function handlePlaygroundRequest(request, response, { url, provider, gateway, signal }) {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException('Assistant timed out', 'TimeoutError')), gateway?.timeoutMs ?? 15_000);
  let release;
  try {
    const route = url.pathname.slice(PREFIX.length);
    if (!['status', 'propose'].includes(route)) throw new PlaygroundError('NOT_FOUND');
    if (request.method !== (route === 'status' ? 'GET' : 'POST')) { response.setHeader('Allow', route === 'status' ? 'GET' : 'POST'); throw new PlaygroundError('METHOD_NOT_ALLOWED'); }
    if (route === 'status') {
      if ([...url.searchParams].some(([key]) => !['sourceMode', 'workspaceId'].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new PlaygroundError('INVALID_REQUEST');
      const sourceMode = url.searchParams.get('sourceMode'), workspaceId = url.searchParams.get('workspaceId');
      if (!['preview', 'arena'].includes(sourceMode) || !workspaceId || workspaceId.length > 512) throw new PlaygroundError('INVALID_REQUEST');
      if (!gateway) { send(200, UNCONFIGURED); return true; }
      let access;
      try { access = await authorize(request, provider, gateway, sourceMode, workspaceId, { phase: 'status' }, combined); }
      catch (error) {
        if (error instanceof PlaygroundError && error.code === 'FORBIDDEN') {
          send(200, { ...UNCONFIGURED, configured: true, state: 'restricted', provider: gateway.assistant.provider, model: gateway.assistant.model, message: 'AI sharing is not enabled for this user or workspace. Local tools remain available.' }); return true;
        }
        throw error;
      }
      if (access.connectionId) response.setHeader('X-Viewer-Connection', access.connectionId);
      send(200, { configured: true, available: true, state: 'ready', provider: gateway.assistant.provider, model: gateway.assistant.model, imagesAllowed: access.imagesAllowed, liveEcr: false, ...(access.connectionId ? { connectionId: access.connectionId } : {}), message: 'Requests send your prompt and compact scene/markup data to the configured AI provider. An image is included only when you choose to attach it.' });
      return true;
    }
    if ([...url.searchParams].length) throw new PlaygroundError('INVALID_REQUEST');
    if (!gateway) throw new PlaygroundError('UNCONFIGURED');
    // Explicit exact origin and a non-simple custom header prevent cookie-auth CSRF.
    if (request.headers?.origin !== gateway.allowedOrigin || request.headers?.['x-playground-request'] !== '1' || request.headers?.['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') throw new PlaygroundError('FORBIDDEN');
    const body = validateAssistantRequest(await readBody(request, combined));
    const access = await authorize(request, provider, gateway, body.context.sourceMode, body.context.workspaceId, { phase: 'propose', context: body.context, baseline: body.baseline, nodes: body.nodes, annotations: body.annotations, imageContext: body.imageContext, includesImage: body.image !== undefined }, combined);
    if (body.image && !access.imagesAllowed) throw new PlaygroundError('FORBIDDEN');
    release = gateway.reserve(access.key);
    const plan = stampAssistantConcepts(validateAssistantPlan(await abortable(gateway.assistant.propose(body, { signal: combined }), combined), body), body);
    combined.throwIfAborted();
    if (access.connectionId) response.setHeader('X-Viewer-Connection', access.connectionId);
    send(200, { requestId: randomUUID(), proposalId: body.proposalId, proposalVersion: body.proposalVersion, sourceKey: body.sourceKey, ...plan });
  } catch (error) {
    if (!response.headersSent && !response.writableEnded && !response.destroyed) { const failure = assistantFailure(error); send(failure.status, failure.body); }
  } finally { clearTimeout(timer); release?.(); }
  return true;
}
