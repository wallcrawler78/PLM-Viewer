import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchViewerContent } from '../src/integrations/protectedContent';

afterEach(() => vi.unstubAllGlobals());

describe('package and hosted content URL boundaries', () => {
  it.each(['/fixtures/documents/atlas-spec-B.pdf', 'blob:chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/local-file'])('keeps %s readable when the extension origin is opaque', async source => {
    vi.stubGlobal('location', { href: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/viewer.html?mode=preview', origin: 'null' });
    const response = new Response('local bytes');
    expect(await fetchViewerContent(source, undefined, async () => response)).toBe(response);
  });

  it('does not mistake a local package route for an authenticated BFF response', async () => {
    vi.stubGlobal('location', { href: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/viewer.html', origin: 'null' });
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const response = new Response('local response', { status: 403 });
    expect(await fetchViewerContent('/content?connectionId=local', undefined, async () => response)).toBe(response);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('continues clearing a denied same-origin hosted source and ignores foreign error pages', async () => {
    vi.stubGlobal('location', { href: 'https://viewer.example/nested/review?mode=arena', origin: 'https://viewer.example' });
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    await expect(fetchViewerContent('/api/viewer/v1/content?connectionId=alice', undefined, async () => new Response('', { status: 401 }))).rejects.toThrow('session has expired');
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const response = new Response('', { status: 401 });
    expect(await fetchViewerContent('https://other.example/content?connectionId=alice', undefined, async () => response)).toBe(response);
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
});
