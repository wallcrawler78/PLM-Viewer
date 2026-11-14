import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { createPdfRasterSource, PDF_VISUAL_LIMITS, planPdfComparison, visualRegionPoint } from '../src/pdf-visual-raster';

function pdfFixture({ width = 8, height = 6, renderPromise = Promise.resolve() }: { width?: number; height?: number; renderPromise?: Promise<void> } = {}) {
  const cancel = vi.fn();
  const cleanup = vi.fn(() => true);
  const documentCleanup = vi.fn(), documentDestroy = vi.fn();
  const render = vi.fn(() => ({ promise: renderPromise, cancel } as unknown as RenderTask));
  const sheet = { getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale })), render, cleanup } as unknown as PDFPageProxy;
  const getPage = vi.fn(async (_page: number) => sheet);
  const pdf = { numPages: 3, getPage, cleanup: documentCleanup, destroy: documentDestroy } as unknown as PDFDocumentProxy;
  const context = { getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) })) };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
  const createCanvas = vi.fn(() => canvas);
  return { pdf, getPage, sheet, render, cancel, cleanup, documentCleanup, documentDestroy, context, canvas, createCanvas };
}

afterEach(() => vi.useRealTimers());

describe('physical page scale for local PDF visual comparison', () => {
  it('keeps differently sized pages at one physical scale instead of fitting them separately', () => {
    const plan = planPdfComparison({ width: 612, height: 792 }, { width: 720, height: 540 });
    expect(plan).toEqual({ pixelsPerPoint: 1.5, width: 1080, height: 1188, downsampled: false });
    expect(612 * plan.pixelsPerPoint).toBe(918);
    expect(720 * plan.pixelsPerPoint).toBe(1080);
  });

  it('bounds the common canvas, including cross-oriented engineering sheets and ceil rounding', () => {
    for (const [left, right] of [
      [{ width: 3000, height: 500 }, { width: 500, height: 3000 }],
      [{ width: 1200.1, height: 1831.4 }, { width: 1200.2, height: 1831.5 }],
      [{ width: 10_000_000, height: 1 }, null],
      [{ width: 10_000_000, height: 10_000_000 }, null],
    ] as const) {
      const plan = planPdfComparison(left, right);
      expect(plan.width * plan.height).toBeLessThanOrEqual(PDF_VISUAL_LIMITS.maxPixels);
      expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(PDF_VISUAL_LIMITS.maxDimension);
      expect(plan.pixelsPerPoint).toBeGreaterThan(0);
      expect(plan.pixelsPerPoint).toBeLessThan(PDF_VISUAL_LIMITS.targetPixelsPerPoint);
      expect(plan.downsampled).toBe(true);
    }
  });

  it('permits a deliberate blank counterpart and rejects two missing or invalid pages', () => {
    expect(planPdfComparison(null, { width: 612, height: 792 })).toEqual(planPdfComparison({ width: 612, height: 792 }, null));
    expect(() => planPdfComparison(null, null)).toThrow('Select at least one source page');
    for (const width of [0, -1, NaN, Infinity, 10_000_001]) expect(() => planPdfComparison({ width, height: 792 }, null)).toThrow('unsupported dimensions');
  });
});

describe('reader-owned PDF raster lifetime', () => {
  it('renders the selected page through the existing proxy and preserves exact source identity', async () => {
    const fixture = pdfFixture();
    const provider = createPdfRasterSource(fixture.pdf, 'file-17/revision-B/edition-2/hash-123', { createCanvas: fixture.createCanvas });
    const signal = new AbortController().signal;
    expect(await provider.source.dimensions(2, signal)).toEqual({ width: 8, height: 6 });
    const page = await provider.source.render(2, 1.5, signal);
    expect(fixture.getPage.mock.calls.map(call => call[0])).toEqual([2, 2]);
    expect(page).toMatchObject({ width: 12, height: 9, page: 2, pixelsPerPoint: 1.5, sourceKey: 'file-17/revision-B/edition-2/hash-123' });
    expect(page.data).toHaveLength(12 * 9 * 4);
    expect(fixture.render).toHaveBeenCalledWith(expect.objectContaining({ background: 'rgb(255,255,255)', intent: 'display', viewport: { width: 12, height: 9 } }));
    expect(fixture.canvas.width).toBe(0); expect(fixture.canvas.height).toBe(0);
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.documentCleanup).not.toHaveBeenCalled();
    expect(fixture.documentDestroy).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('rejects non-existent pages and unsafe allocations before creating a canvas', async () => {
    const fixture = pdfFixture({ width: 4000, height: 4000 });
    const provider = createPdfRasterSource(fixture.pdf, 'file', { createCanvas: fixture.createCanvas });
    const signal = new AbortController().signal;
    for (const page of [0, 4, 1.5, NaN]) await expect(provider.source.render(page, 1, signal)).rejects.toThrow('Select a page');
    expect(fixture.getPage).not.toHaveBeenCalled();
    await expect(provider.source.render(1, 2, signal)).rejects.toThrow('invalid rendering scale');
    await expect(provider.source.render(1, 1, signal)).rejects.toThrow('pixel limit');
    expect(fixture.createCanvas).not.toHaveBeenCalled();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    provider.dispose();
  });

  it('cancels an obsolete page render and releases its canvas before a late renderer settles', async () => {
    let finish!: () => void;
    const fixture = pdfFixture({ renderPromise: new Promise(resolve => { finish = resolve; }) });
    const provider = createPdfRasterSource(fixture.pdf, 'before', { createCanvas: fixture.createCanvas });
    const abort = new AbortController();
    const pending = provider.source.render(1, 1, abort.signal);
    await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce());
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await rejection;
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.canvas.width).toBe(0); expect(fixture.canvas.height).toBe(0);
    expect(fixture.context.getImageData).not.toHaveBeenCalled();
    finish(); provider.dispose();
  });

  it('closes every consumer on source replacement without destroying the shared reader proxy', async () => {
    const fixture = pdfFixture({ renderPromise: new Promise(() => {}) });
    const provider = createPdfRasterSource(fixture.pdf, 'file-edition-1', { createCanvas: fixture.createCanvas });
    const signal = new AbortController().signal;
    const pending = provider.source.render(1, 1, signal);
    await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce());
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    provider.dispose(); await rejection;
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    await expect(provider.source.dimensions(2, signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.getPage).toHaveBeenCalledOnce();
  });

  it('bounds stalled page acquisition and rendering with a real abort, not only a status timeout', async () => {
    vi.useFakeTimers();
    const fixture = pdfFixture({ renderPromise: new Promise(() => {}) });
    const provider = createPdfRasterSource(fixture.pdf, 'file', { createCanvas: fixture.createCanvas, timeoutMs: 10 });
    const render = provider.source.render(1, 1, new AbortController().signal);
    const rejection = expect(render).rejects.toThrow('visual rendering time limit');
    await vi.advanceTimersByTimeAsync(11); await rejection;
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.canvas.width).toBe(0); expect(fixture.canvas.height).toBe(0);
    provider.dispose();
    const waiting = createPdfRasterSource({ numPages: 1, getPage: () => new Promise(() => {}) }, 'stalled-page', { timeoutMs: 10 });
    const lookup = waiting.source.dimensions(1, new AbortController().signal);
    const failedLookup = expect(lookup).rejects.toThrow('visual rendering time limit');
    await vi.advanceTimersByTimeAsync(11); await failedLookup;
    waiting.dispose();
  });

  it('requests only cooperative page cleanup while another reader still owns the shared page', async () => {
    let finish!: () => void;
    const fixture = pdfFixture({ renderPromise: new Promise(resolve => { finish = resolve; }) });
    // PDF.js reports false and retains pending cleanup while another consumer renders.
    fixture.cleanup.mockReturnValue(false);
    const provider = createPdfRasterSource(fixture.pdf, 'shared-page', { createCanvas: fixture.createCanvas });
    const pending = provider.source.render(1, 1, new AbortController().signal);
    await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce());
    expect(fixture.cleanup).not.toHaveBeenCalled();
    finish();
    expect(await pending).toMatchObject({ page: 1, sourceKey: 'shared-page' });
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.documentCleanup).not.toHaveBeenCalled();
    expect(fixture.documentDestroy).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('releases page caches after raster failure without replacing the authored rendering error', async () => {
    const fixture = pdfFixture();
    fixture.render.mockImplementation(() => { throw new Error('broken renderer'); });
    fixture.cleanup.mockImplementation(() => { throw new Error('source already closing'); });
    const provider = createPdfRasterSource(fixture.pdf, 'failed-page', { createCanvas: fixture.createCanvas });
    await expect(provider.source.render(1, 1, new AbortController().signal)).rejects.toThrow('could not be rendered for visual comparison');
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.canvas.width).toBe(0); expect(fixture.canvas.height).toBe(0);
    expect(fixture.documentCleanup).not.toHaveBeenCalled();
    provider.dispose();
  });
});

describe('visual review note coordinates', () => {
  it('normalizes to the actual source page and clips partial regions at its edge', () => {
    const region = { x: 90, y: 30, width: 40, height: 20 };
    expect(visualRegionPoint(region, { width: 100, height: 200 })).toEqual({ x: 0.95, y: 0.2 });
    expect(visualRegionPoint(region, { width: 200, height: 100 })).toEqual({ x: 0.55, y: 0.4 });
  });

  it('never binds a source-page note to empty common-canvas padding', () => {
    expect(visualRegionPoint({ x: 100, y: 0, width: 20, height: 10 }, { width: 100, height: 200 })).toBeNull();
    expect(visualRegionPoint({ x: 0, y: 200, width: 20, height: 10 }, { width: 100, height: 200 })).toBeNull();
  });
});
