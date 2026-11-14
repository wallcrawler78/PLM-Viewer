import { discardResponse, readBoundedJson } from './responseBody';

/** Session failures must clear every live pane, not leave another protected file visible. */
export const VIEWER_SESSION_INVALID = 'viewer-session-invalid';
export interface ViewerSessionFailure { code: string; message: string; connectionId?: string; }
export function invalidateViewerSession(failure: ViewerSessionFailure): void {
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') window.dispatchEvent(new CustomEvent(VIEWER_SESSION_INVALID, { detail: failure }));
}

/** Read only a bounded, public BFF error code; upstream message text is never displayed. */
export async function featureUnavailable(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status !== 403 || !(response.headers.get('content-type') ?? '').includes('application/json') || !response.body) return false;
  // Eligibility detail is optional. A stalled error body must not retain protected
  // panes indefinitely after the server has already denied access in its headers.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 1000);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    return (await readBoundedJson<{ code?: string }>(response, 4096, combined))?.code === 'FEATURE_NOT_ENABLED';
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/** Preview URLs pass through unchanged. Live URLs carry only an opaque connection guard. */
export async function fetchViewerContent(url: string, signal?: AbortSignal, fetcher: typeof fetch = (...args) => globalThis.fetch(...args)): Promise<Response> {
  const response = await fetcher(url, { signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  // A full page URL also resolves local package/blob sources when an extension
  // runtime reports an opaque origin. "null" is not a valid URL base.
  const page = new URL(typeof location === 'undefined' ? 'https://viewer.invalid/' : location.href);
  const parsed = new URL(url, page);
  const connectionId = parsed.searchParams.get('connectionId');
  // Only a same-origin protected BFF route may invalidate live state. Fixture failures stay local.
  if (['http:', 'https:'].includes(page.protocol) && parsed.origin === page.origin && parsed.pathname.endsWith('/content') && connectionId) {
    if ([401, 403, 409].includes(response.status)) {
      const featureDisabled = await featureUnavailable(response, signal);
      const code = featureDisabled ? 'FEATURE_NOT_ENABLED' : response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN' : 'CONNECTION_CHANGED';
      const message = featureDisabled ? 'MCP access is not enabled for this Arena workspace. Ask your Arena administrator to check workspace eligibility.' : response.status === 401 ? 'Your Arena session has expired. Reconnect to continue.' : response.status === 403 ? 'Access to this Arena source is no longer available.' : 'The connected Arena user or workspace changed. Reopen this source.';
      discardResponse(response);
      invalidateViewerSession({ code, message, connectionId });
      throw new Error(message);
    }
    if (response.ok && response.headers.get('X-Viewer-Connection') !== connectionId) {
      const message = 'This file response belongs to a different or unverified Arena connection.';
      discardResponse(response);
      invalidateViewerSession({ code: 'CONNECTION_CHANGED', message, connectionId });
      throw new Error(message);
    }
  }
  return response;
}
