import { discardResponse, readBoundedJson, ResponseBodyError, withAbort } from './responseBody';

const AUTH_STATUS = '/api/viewer/v1/auth/status';
const AUTH_LOGIN = '/api/viewer/v1/auth/login';
const AUTH_LOGOUT = '/api/viewer/v1/auth/logout';
const RETURN_PARAMETERS = new Set(['mode', 'workspaceId', 'itemId', 'revision', 'fileId', 'parentItemId', 'parentRevision', 'configurationId', 'baselineRevision', 'baselineConfigurationId', 'edition', 'sourceHash', 'view', 'compare']);

export interface ArenaAuthStatus {
  configured: boolean;
  connected: boolean;
  state: 'unconfigured' | 'disconnected' | 'connected';
  loginPath?: typeof AUTH_LOGIN;
  logoutPath?: typeof AUTH_LOGOUT;
  user?: { id: string; displayName?: string };
  workspaceId?: string;
  message?: string;
}

export class ArenaAuthError extends Error {
  override name = 'ArenaAuthError';
  constructor(message: string, readonly code = 'AUTH_UNAVAILABLE') { super(message); }
}

const identity = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

/** Auth status exposes only verified session metadata, never tokens or issuer endpoints. */
export function parseArenaAuthStatus(value: unknown): ArenaAuthStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArenaAuthError('The viewer returned an invalid sign-in status.');
  const input = value as Record<string, unknown>;
  if (typeof input.configured !== 'boolean' || typeof input.connected !== 'boolean' || (input.connected && !input.configured)) throw new ArenaAuthError('The viewer returned an invalid sign-in status.');
  const state = !input.configured ? 'unconfigured' : input.connected ? 'connected' : 'disconnected';
  if (input.state !== undefined && input.state !== state) throw new ArenaAuthError('The viewer returned conflicting sign-in state.');
  if (input.loginPath !== undefined && input.loginPath !== AUTH_LOGIN || input.logoutPath !== undefined && input.logoutPath !== AUTH_LOGOUT) throw new ArenaAuthError('The viewer returned an unsupported sign-in route.');
  if (input.configured && !input.connected && input.loginPath !== AUTH_LOGIN) throw new ArenaAuthError('The configured viewer has not supplied its sign-in route.');
  const result: ArenaAuthStatus = { configured: input.configured, connected: input.connected, state };
  if (input.configured && input.loginPath === AUTH_LOGIN) result.loginPath = AUTH_LOGIN;
  if (typeof input.message === 'string' && input.message.length <= 2000) result.message = input.message;
  if (input.connected) {
    const user = input.user && typeof input.user === 'object' && !Array.isArray(input.user) ? input.user as Record<string, unknown> : undefined;
    if (!user || !identity(user.id) || !identity(input.workspaceId) || input.logoutPath !== AUTH_LOGOUT) throw new ArenaAuthError('The viewer has not verified the connected Arena user and workspace.');
    result.user = { id: user.id, ...(identity(user.displayName) ? { displayName: user.displayName } : {}) };
    result.workspaceId = input.workspaceId;result.logoutPath = AUTH_LOGOUT;
  }
  return result;
}

async function authRequest<T>(path: typeof AUTH_STATUS | typeof AUTH_LOGOUT, method: 'GET' | 'POST', consume: (response: Response, signal: AbortSignal) => Promise<T>, signal?: AbortSignal, fetcher: typeof fetch = (...args) => globalThis.fetch(...args)): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response | undefined;
  try {
    return await withAbort((async () => {
      response = await fetcher(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (controller.signal.aborted) { discardResponse(response); controller.signal.throwIfAborted(); }
      return consume(response, controller.signal);
    })(), controller.signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (controller.signal.aborted) throw new ArenaAuthError('The Arena sign-in request timed out. Please try again.', 'TIMEOUT');
    if (error instanceof ArenaAuthError) throw error;
    throw new ArenaAuthError('Arena sign-in could not be reached. Check the viewer connection and try again.');
  } finally { discardResponse(response);clearTimeout(timer);signal?.removeEventListener('abort', abort); }
}

/** Called only for an explicitly requested live workspace. */
export async function readArenaAuthStatus(signal?: AbortSignal, fetcher?: typeof fetch): Promise<ArenaAuthStatus> {
  return authRequest(AUTH_STATUS, 'GET', async (response, requestSignal) => {
    if ([404, 501, 503].includes(response.status) || response.ok && !(response.headers.get('content-type') ?? '').includes('application/json')) {
      return { configured: false, connected: false, state: 'unconfigured', message: 'Arena sign-in is not configured on this viewer server.' };
    }
    if (!response.ok) throw new ArenaAuthError('Arena sign-in status could not be verified. Try again.');
    let value: unknown;
    try { value = await readBoundedJson(response, 64 * 1024, requestSignal); }
    catch (error) {
      requestSignal.throwIfAborted();
      if (error instanceof ResponseBodyError && error.code === 'TOO_LARGE') throw new ArenaAuthError('The viewer sign-in status response is too large.');
      throw new ArenaAuthError('The viewer returned an invalid sign-in status.');
    }
    return parseArenaAuthStatus(value);
  }, signal, fetcher);
}

/** Retain exact viewer context without accepting external redirects or auth query data. */
export function safeArenaReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 8192 || /[\\\u0000-\u0020\u007f]/.test(value)) throw new ArenaAuthError('Reopen the item from the viewer before connecting to Arena.');
  const target = new URL(value, 'https://viewer.invalid');
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(target.pathname); } catch { throw new ArenaAuthError('The viewer return address is invalid.'); }
  if (target.origin !== 'https://viewer.invalid' || decodedPath.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decodedPath) || decodedPath.startsWith('/api/viewer/')) throw new ArenaAuthError('The viewer return address is invalid.');
  const query = new URLSearchParams();
  for (const [key, parameter] of target.searchParams) if (RETURN_PARAMETERS.has(key)) query.append(key, parameter);
  return `${target.pathname}${query.size ? `?${query}` : ''}`;
}

export function arenaLoginTarget(status: ArenaAuthStatus, returnTo: string): string {
  if (!status.configured || status.connected || status.loginPath !== AUTH_LOGIN) throw new ArenaAuthError('The Arena sign-in connection is not ready. Check its status and try again.');
  const query = new URLSearchParams({ returnTo: safeArenaReturnTo(returnTo) });
  return `${AUTH_LOGIN}?${query}`;
}

export async function disconnectArena(status: ArenaAuthStatus, signal?: AbortSignal, fetcher?: typeof fetch): Promise<void> {
  if (!status.configured || !status.connected || status.logoutPath !== AUTH_LOGOUT) throw new ArenaAuthError('No connected Arena session is available to disconnect.');
  // Chrome supplies Origin for this same-origin POST; the server verifies it.
  return authRequest(AUTH_LOGOUT, 'POST', async response => {
    if (!response.ok) throw new ArenaAuthError('Arena did not confirm the disconnect. Your open sources have been cleared; check the session and try again.', 'AUTH_DISCONNECT_FAILED');
    signal?.throwIfAborted();
  }, signal, fetcher);
}
