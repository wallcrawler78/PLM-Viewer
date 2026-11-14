import { afterEach, describe, expect, it, vi } from 'vitest';
import { comparePdfPagePair } from '../src/pdf-page-comparison';
import type { PdfRasterSource } from '../src/pdf-visual-raster';
import { PDF_OVERVIEW_LIMITS, scanPdfVisualOverview } from '../src/pdf-visual-overview';
import type { PdfVisualOverviewReport } from '../src/pdf-visual-overview';
import { compareRasterPages } from '../src/visual-diff/algorithm';
import type { VisualDiffInput } from '../src/visual-diff/types';

const signal = () => new AbortController().signal;
const compare = async (input: VisualDiffInput) => compareRasterPages(input);

function source(sourceKey: string, pages: number, { marked = [], widths = {} }: { marked?: number[]; widths?: Record<number, number> } = {}) {
  const dimensions = vi.fn(async (page: number, _signal: AbortSignal) => ({ width: widths[page] ?? 8, height: 6 }));
  const render = vi.fn(async (page: number, pixelsPerPoint: number, _signal: AbortSignal) => {
    const width = Math.ceil((widths[page] ?? 8) * pixelsPerPoint), height = Math.ceil(6 * pixelsPerPoint);
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    if (marked.includes(page)) data[0] = data[1] = data[2] = 0;
    return { sourceKey, page, width, height, pixelsPerPoint, data };
  });
  return { sourceKey, pages, dimensions, render } satisfies PdfRasterSource;
}

afterEach(() => vi.useRealTimers());

describe('source-bound PDF page pairs', () => {
  it('rejects a raster from another edition, page or physical scale', async () => {
    const before = source('edition-A', 2), after = source('edition-B', 2);
    const original = after.render;
    for (const wrong of [{ sourceKey: 'another-edition' }, { page: 2 }, { pixelsPerPoint: 1 }]) {
      const corrupted = { ...after, render: async (...args: Parameters<typeof original>) => ({ ...await original(...args), ...wrong }) };
      await expect(comparePdfPagePair(before, corrupted, { beforePage: 1, afterPage: 1 }, 18, { signal: signal(), compare })).rejects.toThrow('no longer matches');
    }
  });

  it('aborts the companion page when one side fails, even if its promise never settles', async () => {
    const before = source('A', 1), after = source('B', 1);
    let otherSignal!: AbortSignal;
    before.dimensions = vi.fn(async (_page, incoming) => { otherSignal = incoming; return new Promise(() => {}); });
    after.dimensions.mockRejectedValue(new Error('broken page'));
    await expect(comparePdfPagePair(before, after, { beforePage: 1, afterPage: 1 }, 18, { signal: signal(), compare })).rejects.toThrow('broken page');
    expect(otherSignal.aborted).toBe(true);
    expect(before.render).not.toHaveBeenCalled();
  });

  it('rejects a source replaced while the comparison worker is still busy', async () => {
    const before = source('A', 1), after = source('B', 1);
    const pendingCompare = vi.fn(async (input: VisualDiffInput) => { after.sourceKey = 'C'; return compareRasterPages(input); });
    await expect(comparePdfPagePair(before, after, { beforePage: 1, afterPage: 1 }, 18, { signal: signal(), compare: pendingCompare })).rejects.toThrow('source changed');
  });
});

describe('sequential PDF overview coverage', () => {
  it('records same-number pairs, pixel changes and a blank extra page without retaining raster content', async () => {
    const before = source('before-exact-hash', 2), after = source('after-exact-hash', 3, { marked: [2] });
    const progress: PdfVisualOverviewReport[] = [];
    const report = await scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, onProgress: value => progress.push(value) });
    expect(report.status).toBe('complete');
    expect(report.pairs.map(pair => pair.outcome)).toEqual(['no-detected-change', 'changed', 'extra-open-file']);
    expect(report.pairs[2]).toMatchObject({ beforePage: 0, afterPage: 3, changedPixels: 0, changedFraction: 0 });
    expect(before.render.mock.calls.map(call => call[0])).toEqual([1, 2]);
    expect(after.render.mock.calls.map(call => call[0])).toEqual([1, 2, 3]);
    expect(Object.keys(report.pairs[0])).not.toContain('data');
    expect(JSON.stringify(report)).not.toMatch(/mask|regions|data|data:|text/);
    expect(progress.map(value => value.pairs.length)).toEqual([0, 1, 2, 3]);
    expect(progress[0].pairs).toHaveLength(0);
  });

  it('retains page-size-only changes and blank surplus baseline pages', async () => {
    const report = await scanPdfVisualOverview(source('A', 2), source('B', 1, { widths: { 1: 10 } }), 18, { signal: signal(), compare });
    expect(report.pairs[0]).toMatchObject({ outcome: 'changed', pageSizeChanged: true, changedPixels: 0 });
    expect(report.pairs[1]).toMatchObject({ outcome: 'extra-baseline', beforePage: 2, afterPage: 0, changedPixels: 0 });
  });

  it('retains a physical page-size change when both pages round to identical raster dimensions', async () => {
    const before = source('A', 1, { widths: { 1: 8.1 } });
    const after = source('B', 1, { widths: { 1: 8.2 } });
    const pair = await comparePdfPagePair(before, after, { beforePage: 1, afterPage: 1 }, 18, { signal: signal(), compare });
    expect(pair.before!.width).toBe(pair.after!.width);
    expect(pair.before!.height).toBe(pair.after!.height);
    expect(pair.result).toMatchObject({ pageSizeChanged: true, changedPixels: 0 });
    const report = await scanPdfVisualOverview(before, after, 18, { signal: signal(), compare });
    expect(report.pairs[0]).toMatchObject({ outcome: 'changed', pageSizeChanged: true, changedPixels: 0 });
  });

  it('keeps failed pages as explicit coverage gaps and continues with the next pair', async () => {
    const before = source('A', 3), after = source('B', 3);
    after.dimensions.mockRejectedValueOnce(new Error('private failure detail'));
    const report = await scanPdfVisualOverview(before, after, 18, { signal: signal(), compare });
    expect(report.status).toBe('complete');
    expect(report.pairs.map(pair => pair.outcome)).toEqual(['unavailable', 'no-detected-change', 'no-detected-change']);
    expect(report.pairs[0]).toMatchObject({ changedPixels: null, totalPixels: null, changedFraction: null, dpi: null });
    expect(JSON.stringify(report)).not.toContain('private failure detail');
  });

  it('never begins the next pair while the current worker comparison is pending', async () => {
    const before = source('A', 2), after = source('B', 2);
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const localCompare = vi.fn(async (input: VisualDiffInput) => { if (input.before?.page === 1) await first; return compareRasterPages(input); });
    const pending = scanPdfVisualOverview(before, after, 18, { signal: signal(), compare: localCompare });
    await vi.waitFor(() => expect(localCompare).toHaveBeenCalledOnce());
    expect(before.dimensions.mock.calls.map(call => call[0])).toEqual([1]);
    expect(after.render.mock.calls.map(call => call[0])).toEqual([1]);
    release();
    expect((await pending).pairs).toHaveLength(2);
  });

  it('resumes a bounded run only with the same sources, page counts, sensitivity and contiguous summaries', async () => {
    const before = source('A', 3), after = source('B', 3);
    const first = await scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, limits: { pairsPerRun: 1 } });
    expect(first).toMatchObject({ status: 'paused', stop: 'pair-budget' });
    expect(first.pairs).toHaveLength(1);
    const withUnexpectedContent = { ...first, pairs: [{ ...first.pairs[0], data: new Uint8Array([1, 2]), privateText: 'not a summary' }] };
    const stripped = await scanPdfVisualOverview(before, after, 18, { signal: AbortSignal.abort(), compare, resume: withUnexpectedContent });
    expect(stripped.pairs[0]).not.toHaveProperty('data');
    expect(stripped.pairs[0]).not.toHaveProperty('privateText');
    const next = await scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, resume: first });
    expect(next.status).toBe('complete');
    expect(before.render.mock.calls.map(call => call[0])).toEqual([1, 2, 3]);
    expect(first.pairs).toHaveLength(1);
    for (const args of [[source('other', 3), after, 18], [before, source('B', 4), 18], [before, after, 6]] as const) {
      await expect(scanPdfVisualOverview(args[0], args[1], args[2], { signal: signal(), compare, resume: first })).rejects.toThrow('different sources or sensitivity');
    }
    await expect(scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, resume: { ...first, pairs: [{ ...first.pairs[0], number: 2 }] } })).rejects.toThrow('incomplete or invalid');
  });

  it('cancels a stalled current pair promptly and resumes it without calling it unchanged or unavailable', async () => {
    const before = source('A', 2), after = source('B', 2);
    const original = after.dimensions;
    let heldSignal!: AbortSignal;
    after.dimensions = vi.fn(async (page, incoming) => {
      if (page === 2) { heldSignal = incoming; return new Promise(() => {}); }
      return original(page, incoming);
    });
    const control = new AbortController();
    const pending = scanPdfVisualOverview(before, after, 18, { signal: control.signal, compare });
    await vi.waitFor(() => expect(after.dimensions).toHaveBeenCalledTimes(2));
    control.abort();
    const paused = await pending;
    expect(paused).toMatchObject({ status: 'paused', stop: 'cancelled' });
    expect(paused.pairs).toHaveLength(1);
    expect(heldSignal.aborted).toBe(true);
    after.dimensions = original;
    const complete = await scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, resume: paused });
    expect(complete.status).toBe('complete');
    expect(after.render.mock.calls.map(call => call[0])).toEqual([1, 2]);
  });

  it('counts attempted pixels before rendering and stops before the next allocation', async () => {
    const before = source('A', 2), after = source('B', 2);
    // Fixture page plan is 12 x 9 = 108 common pixels.
    const report = await scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, limits: { pixelsPerRun: 108 } });
    expect(report).toMatchObject({ status: 'paused', stop: 'pixel-budget' });
    expect(report.pairs).toHaveLength(1);
    expect(before.render).toHaveBeenCalledOnce();
    expect(after.render).toHaveBeenCalledOnce();
  });

  it('stops at the per-pair deadline with a coverage gap but the run deadline leaves the current pair unscanned', async () => {
    vi.useFakeTimers();
    const before = source('A', 1), after = source('B', 1);
    after.dimensions = vi.fn(() => new Promise(() => {}));
    const pairPending = scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, limits: { pairMs: 10 } });
    await vi.advanceTimersByTimeAsync(11);
    const pairReport = await pairPending;
    expect(pairReport.status).toBe('complete');
    expect(pairReport.pairs[0].outcome).toBe('unavailable');
    const runPending = scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, limits: { runMs: 10 } });
    await vi.advanceTimersByTimeAsync(11);
    expect(await runPending).toMatchObject({ status: 'paused', stop: 'time-budget', pairs: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discloses the document ceiling while allowing bounded runs to reach it', async () => {
    const before = source('A', 302), after = source('B', 301);
    let report: PdfVisualOverviewReport | null = null;
    for (let run = 0; run < 6; run++) report = await scanPdfVisualOverview(before, after, 18, { signal: signal(), compare, resume: report });
    expect(report).toMatchObject({ totalPairs: 302, scanLimit: PDF_OVERVIEW_LIMITS.maxPairs, status: 'paused', stop: 'document-limit' });
    expect(report!.pairs).toHaveLength(300);
    expect(after.render).toHaveBeenCalledTimes(300);
  });
});
