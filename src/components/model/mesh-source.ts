import { discardResponse, readBoundedJson, ResponseBodyError, withAbort } from '../../integrations/responseBody';
import { validateMesh } from './geometry';

export const MESH_SOURCE_LIMITS = { maxBytes: 32 * 1024 * 1024, fetchTimeoutMs: 30_000 } as const;

/** A prepared derivative has the same transport bounds as an original source.
 * Keep the deadline active through headers and body, including custom transports
 * that ignore abort, before allocating GPU attributes from the decoded JSON.
 */
export async function readMeshSource(
  fetchSource: (signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ positions: number[]; indices: number[]; normals?: number[] }> {
  signal.throwIfAborted();
  const maxBytes = options.maxBytes ?? MESH_SOURCE_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? MESH_SOURCE_LIMITS.fetchTimeoutMs;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MESH_SOURCE_LIMITS.maxBytes
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MESH_SOURCE_LIMITS.fetchTimeoutMs) {
    throw new Error('The model loading limits are invalid.');
  }
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new Error('The model source took too long to arrive. Retry the attachment.')), timeoutMs);
  let response: Response | undefined, complete = false;
  try {
    const pending = fetchSource(combined).then(value => {
      // A late custom response still owns a stream that must be discarded.
      if (combined.aborted) { discardResponse(value); combined.throwIfAborted(); }
      return value;
    });
    response = await withAbort(pending, combined);
    if (!response.ok) throw new Error(`Model asset unavailable (HTTP ${response.status}).`);
    let value: unknown;
    try { value = await readBoundedJson(response, maxBytes, combined); }
    catch (error) {
      combined.throwIfAborted();
      if (error instanceof ResponseBodyError && error.code === 'TOO_LARGE') throw new Error('This model source exceeds the local file size limit. Load a smaller model.');
      if (error instanceof ResponseBodyError || error instanceof SyntaxError || error instanceof TypeError) throw new Error('The model source is not valid mesh JSON.');
      throw error;
    }
    validateMesh(value);
    combined.throwIfAborted();
    complete = true;
    return value;
  } finally {
    clearTimeout(timer);
    discardResponse(response);
    if (!complete) deadline.abort();
  }
}
