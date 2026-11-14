/** Public error vocabulary. Upstream messages, response bodies and credentials never cross the BFF. */
export const PUBLIC_ERRORS = Object.freeze({
  BAD_REQUEST: [400, 'The viewer request is invalid.'],
  UNAUTHENTICATED: [401, 'Sign in to the viewer with your authorized Arena account.'],
  FORBIDDEN: [403, 'Your Arena account does not have access to this source.'],
  FEATURE_NOT_ENABLED: [403, 'MCP access is not enabled for this Arena workspace. Ask your Arena administrator to check workspace eligibility.'],
  NOT_FOUND: [404, 'The requested source is unavailable.'],
  METHOD_NOT_ALLOWED: [405, 'This viewer connection is read-only.'],
  CONNECTION_CHANGED: [409, 'Your Arena connection changed. Reopen the source to verify access.'],
  SOURCE_CHANGED: [409, 'The requested source edition or content has changed.'],
  CONTENT_TOO_LARGE: [413, 'This source exceeds the configured viewer size limit.'],
  RATE_LIMITED: [429, 'Arena is receiving too many requests. Please try again shortly.'],
  UNSUPPORTED: [501, 'This source operation is not mapped for the Arena connection.'],
  UNCONFIGURED: [503, 'The Arena connection is not configured. Ask your administrator to finish setup.'],
  UPSTREAM_ERROR: [502, 'The Arena connection could not complete this request.'],
  TIMEOUT: [504, 'The Arena connection did not complete this request in time.'],
});

export class ViewerError extends Error {
  constructor(code, options) {
    super(PUBLIC_ERRORS[code]?.[1] ?? PUBLIC_ERRORS.UPSTREAM_ERROR[1], options);
    this.name = 'ViewerError';
    this.code = Object.hasOwn(PUBLIC_ERRORS, code) ? code : 'UPSTREAM_ERROR';
  }
}

export function safeError(error) {
  // The SDK can wrap a transport/authentication failure while negotiating versions.
  // Inspect typed causes only, never a response message or arbitrary message substring.
  for (let cause = error?.cause, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (cause instanceof ViewerError) { error = cause; break; }
  }
  let code = error instanceof ViewerError ? error.code : 'UPSTREAM_ERROR';
  // SDK transports expose HTTP status separately from their potentially sensitive message.
  if (!(error instanceof ViewerError)) {
    if (error?.status === 401 || error?.statusCode === 401 || error?.name === 'UnauthorizedError') code = 'UNAUTHENTICATED';
    else if (error?.status === 403 || error?.statusCode === 403 || error?.name === 'InsufficientScopeError') code = 'FORBIDDEN';
    else if (error?.status === 429 || error?.statusCode === 429) code = 'RATE_LIMITED';
    else if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'REQUEST_TIMEOUT') code = 'TIMEOUT';
  }
  return { status: PUBLIC_ERRORS[code][0], body: { code, error: PUBLIC_ERRORS[code][1] } };
}

export function identityText(value, maximum = 512, code = 'BAD_REQUEST') {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum || value.isWellFormed?.() === false || /[\u0000-\u001f\u007f]/.test(value)) throw new ViewerError(code);
  return value;
}
