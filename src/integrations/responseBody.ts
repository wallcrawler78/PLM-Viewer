/** Bound metadata while reading the actual stream, including chunked responses. */
export class ResponseBodyError extends Error {
  override name = 'ResponseBodyError';
  constructor(readonly code: 'TOO_LARGE' | 'INVALID_LENGTH') { super('The response body could not be accepted.'); }
}

export function discardResponse(response: Response | undefined): void {
  if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

/** Observe late promise rejection too, even when a deadline wins first. */
export function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

export async function readBoundedJson<T>(response: Response, maxBytes: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    discardResponse(response);
    throw new ResponseBodyError('INVALID_LENGTH');
  }
  if (length !== null && Number(length) > maxBytes) {
    discardResponse(response);
    throw new ResponseBodyError('TOO_LARGE');
  }
  if (!response.body) throw new SyntaxError('The JSON response is empty.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0, complete = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await withAbort(reader.read(), signal);
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new ResponseBodyError('TOO_LARGE');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    signal?.throwIfAborted();
    return JSON.parse(chunks.join('')) as T;
  } finally {
    // A broken stream's cancel hook can itself stall. Never await it on the UI path.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
