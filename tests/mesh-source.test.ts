import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESH_SOURCE_LIMITS, readMeshSource } from '../src/components/model/mesh-source';
import { fetchViewerContent } from '../src/integrations/protectedContent';

const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
const encoder = new TextEncoder();
const contentUrl = '/api/viewer/v1/content?kind=mesh&connectionId=connection-alice';

function stalledBody(cancel: () => void | PromiseLike<void> = () => {}) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('{"positions":')); }, cancel,
  }));
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('prepared model source acquisition', () => {
  it('reads a valid chunked derivative and releases the deadline after completion', async () => {
    vi.useFakeTimers();
    const source = new AbortController();
    const bytes = encoder.encode(JSON.stringify(mesh));
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }));
    const fetchSource = vi.fn(async (_signal: AbortSignal) => response);
    expect(await readMeshSource(fetchSource, source.signal)).toEqual(mesh);
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchSource.mock.calls[0][0].aborted).toBe(false);
    source.abort();
    expect(fetchSource.mock.calls[0][0].aborted).toBe(true);
  });

  it('times out before headers and discards a late response even when its cancellation stalls', async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const fetchSource = vi.fn((_signal: AbortSignal) => new Promise<Response>(resolve => { deliver = resolve; }));
    const outcome = readMeshSource(fetchSource, new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(MESH_SOURCE_LIMITS.fetchTimeoutMs + 1);
    expect(await outcome).toMatchObject({ message: expect.stringContaining('too long') });
    expect(fetchSource.mock.calls[0][0].aborted).toBe(true);
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    deliver(stalledBody(cancel));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline through a stalled body and releases its reader without waiting for cancellation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = stalledBody(cancel);
    const fetchSource = vi.fn(async (_signal: AbortSignal) => response);
    const outcome = readMeshSource(fetchSource, new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(MESH_SOURCE_LIMITS.fetchTimeoutMs + 1);
    expect(await outcome).toMatchObject({ message: expect.stringContaining('too long') });
    expect(fetchSource.mock.calls[0][0].aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('cancels obsolete bodies promptly and preserves the source-change reason', async () => {
    vi.useFakeTimers();
    const source = new AbortController(), cancel = vi.fn();
    const response = stalledBody(cancel);
    const fetchSource = vi.fn(async (_signal: AbortSignal) => response);
    const outcome = readMeshSource(fetchSource, source.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const reason = new DOMException('The selected revision changed.', 'AbortError');
    source.abort(reason);
    expect(await outcome).toBe(reason);
    expect(fetchSource.mock.calls[0][0].aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not request a source that has already been cancelled', async () => {
    const source = new AbortController(), fetchSource = vi.fn();
    source.abort();
    await expect(readMeshSource(fetchSource, source.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it.each([undefined, '1'])('limits actual chunked bytes with Content-Length=%s', async length => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify(mesh)));
      controller.enqueue(encoder.encode(' '.repeat(256)));
    }, cancel }), { headers: length ? { 'Content-Length': length } : {} });
    await expect(readMeshSource(async () => response, new AbortController().signal, { maxBytes: 128 })).rejects.toThrow('size limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each([String(MESH_SOURCE_LIMITS.maxBytes + 1), '-1', 'unknown'])('rejects an unacceptable declared length of %s before decoding', async length => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Length': length } });
    await expect(readMeshSource(async () => response, new AbortController().signal)).rejects.toThrow(/size limit|valid mesh JSON/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('discards unsuccessful response bodies and does not expose their contents', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode('private upstream diagnostic'));
    }, cancel }), { status: 502 });
    await expect(readMeshSource(async () => response, new AbortController().signal)).rejects.toThrow('Model asset unavailable (HTTP 502).');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reports malformed JSON without leaking its raw contents', async () => {
    await expect(readMeshSource(async () => new Response('private upstream diagnostic'), new AbortController().signal)).rejects.toThrow('The model source is not valid mesh JSON.');
  });

  it('validates decoded geometry before it reaches the renderer', async () => {
    await expect(readMeshSource(async () => new Response(JSON.stringify({ ...mesh, indices: [0, 1, 99] })), new AbortController().signal)).rejects.toThrow('triangle references');
  });

  it.each([401, 403, 409])('preserves whole-session invalidation after a protected HTTP %s', async status => {
    const events: CustomEvent[] = [];
    vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => events.push(event) });
    await expect(readMeshSource(signal => fetchViewerContent(contentUrl, signal, async () => new Response(null, { status })), new AbortController().signal)).rejects.toThrow(/Arena|connected/);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ connectionId: 'connection-alice', code: status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' : 'CONNECTION_CHANGED' });
  });

  it('rejects a protected derivative from a different user connection', async () => {
    const events: CustomEvent[] = [];
    vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => events.push(event) });
    await expect(readMeshSource(signal => fetchViewerContent(contentUrl, signal, async () => new Response(JSON.stringify(mesh), { headers: { 'X-Viewer-Connection': 'connection-bob' } })), new AbortController().signal)).rejects.toThrow('different or unverified');
    expect(events[0].detail).toMatchObject({ code: 'CONNECTION_CHANGED', connectionId: 'connection-alice' });
  });
});
