import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaAdapter } from '../src/integrations/arenaAdapter';
import { readArenaAuthStatus } from '../src/integrations/arenaAuth';
import { fetchViewerContent } from '../src/integrations/protectedContent';

const disconnected = { configured: true, connected: false, state: 'disconnected', loginPath: '/api/viewer/v1/auth/login' };
const encoder = new TextEncoder();
const jsonHeaders = { 'Content-Type': 'application/json' };
const contentUrl = '/api/viewer/v1/content?workspaceId=workspace&itemId=item&revision=3&fileId=file&edition=1&sourceHash=' + 'a'.repeat(64) + '&kind=pdf&connectionId=connection-alice';

function stalledJson(cancel: () => void | PromiseLike<void> = () => {}) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('{"configured":')); },
    cancel,
  }), { headers: jsonHeaders });
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser response limits and complete-request deadlines', () => {
  it('keeps the auth deadline active after headers while a JSON body stalls', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const outcome = readArenaAuthStatus(undefined, async () => stalledJson(cancel)).catch(error => error);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-progress auth body when the source changes, even if a custom stream ignores fetch abort', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const outcome = readArenaAuthStatus(controller.signal, async () => stalledJson(cancel)).catch(error => error);
    await Promise.resolve();
    controller.abort(new DOMException('The source changed', 'AbortError'));
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts Unicode identity data split across network chunks', async () => {
    const body = { ...disconnected, connected: true, state: 'connected', user: { id: 'user', displayName: 'Åsa 中 🔩' }, workspaceId: 'workspace', logoutPath: '/api/viewer/v1/auth/logout' };
    const bytes = encoder.encode(JSON.stringify(body));
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: jsonHeaders });
    expect(await readArenaAuthStatus(undefined, async () => response)).toMatchObject({ user: body.user });
  });

  it('bounds a chunked auth response without trusting Content-Length', async () => {
    const response = new Response(JSON.stringify({ ...disconnected, extra: 'x'.repeat(64 * 1024) }), { headers: { ...jsonHeaders, 'Content-Length': '10' } });
    await expect(readArenaAuthStatus(undefined, async () => response)).rejects.toThrow('too large');
  });

  it.each([undefined, '1'])('bounds metadata streams with Content-Length=%s by bytes actually read', async length => {
    const cancel = vi.fn();
    const chunk = encoder.encode('x'.repeat(1024 * 1024));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"provider":"arena","configured":false,"extra":"'));
        for (let i = 0; i < 17; i++) controller.enqueue(chunk);
        controller.enqueue(encoder.encode('"}'));
        controller.close();
      }, cancel,
    }), { headers: { ...jsonHeaders, ...(length ? { 'Content-Length': length } : {}) } });
    const adapter = new ArenaAdapter({ workspaceId: 'workspace', itemId: 'item' }, async () => response);
    await expect(adapter.connectionStatus()).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a stalled metadata body as a timeout instead of invalid JSON', async () => {
    vi.useFakeTimers();
    const adapter = new ArenaAdapter({ workspaceId: 'workspace', itemId: 'item' }, async () => stalledJson());
    const outcome = adapter.connectionStatus().catch(error => error);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
  });

  it('clears denied content even if optional error details and stream cancellation never finish', async () => {
    vi.useFakeTimers();
    const events: CustomEvent[] = [];
    vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => events.push(event) });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode('{"code":')); }, cancel }), { status: 403, headers: jsonHeaders });
    const outcome = fetchViewerContent(contentUrl, undefined, async () => response).catch(error => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await outcome).toBeInstanceOf(Error);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ code: 'FORBIDDEN', connectionId: 'connection-alice' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
