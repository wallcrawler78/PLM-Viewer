import { describe, expect, it } from 'vitest';
import { compareRasterPages } from '../src/visual-diff/algorithm';
import { normalizeVisualDiffInput, validateVisualDiffResult } from '../src/visual-diff/validation';
import { VISUAL_DIFF_LIMITS } from '../src/visual-diff/types';
import type { RasterPage, VisualDiffInput } from '../src/visual-diff/types';

function raster(width = 40, height = 40, sourceKey = 'source:revB:edition1:hash', page = 1): RasterPage {
  return { width, height, sourceKey, page, pixelsPerPoint: 1.5, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}
function pixel(page: RasterPage, x: number, y: number, color: number[] = [0, 0, 0, 255]) {
  page.data.set(color, (y * page.width + x) * 4); return page;
}
function maskCount(mask: Uint8ClampedArray) { let count = 0; for (let index = 3; index < mask.length; index += 4) if (mask[index]) count++; return count; }

describe('local rendered-page comparison', () => {
  it('returns zero changes for identical content and retains exact file/page identities', () => {
    const before = pixel(raster(40, 40, 'baseline:edition1:hashA', 2), 3, 9), after = { ...before, sourceKey: 'open:edition2:hashB', data: before.data.slice() };
    const result = compareRasterPages({ before, after });
    expect(result).toMatchObject({ width: 40, height: 40, totalPixels: 1600, changedPixels: 0, changedFraction: 0, regionCount: 0, truncated: false, pageSizeChanged: false });
    expect(result.before).toMatchObject({ sourceKey: before.sourceKey, page: 2 });
    expect(result.after).toMatchObject({ sourceKey: after.sourceKey, page: 2 });
    expect(result.regions).toEqual([]); expect(maskCount(result.mask)).toBe(0);
    validateVisualDiffResult(result, normalizeVisualDiffInput({ before, after }));
  });

  it('finds additions/removals at their original page locations without text extraction', () => {
    const before = pixel(raster(100, 40, 'before'), 2, 3), after = pixel(raster(100, 40, 'after'), 83, 3);
    const result = compareRasterPages({ before, after });
    expect(result).toMatchObject({ changedPixels: 2, removedPixels: 1, addedPixels: 1, modifiedPixels: 0, regionCount: 2 });
    expect(result.regions).toEqual([
      expect.objectContaining({ x: 2, y: 3, width: 1, height: 1, pixels: 1, kind: 'removed' }),
      expect.objectContaining({ x: 83, y: 3, width: 1, height: 1, pixels: 1, kind: 'added' }),
    ]);
    expect(Array.from(result.mask.slice((3 * 100 + 2) * 4, (3 * 100 + 2) * 4 + 4))).toEqual([221, 78, 72, 180]);
    expect(Array.from(result.mask.slice((3 * 100 + 83) * 4, (3 * 100 + 83) * 4 + 4))).toEqual([10, 153, 131, 180]);
  });

  it('detects pure color changes even when average channel intensity is unchanged', () => {
    const before = pixel(raster(), 10, 10, [255, 0, 0, 255]);
    const after = pixel(raster(), 10, 10, [0, 0, 255, 255]);
    const result = compareRasterPages({ before, after });
    expect(result).toMatchObject({ changedPixels: 1, modifiedPixels: 1, addedPixels: 0, removedPixels: 0 });
    expect(result.regions[0].kind).toBe('modified');
  });

  it('composites alpha onto white before comparing and ignores invisible RGB payloads', () => {
    const before = pixel(pixel(raster(), 4, 5, [255, 0, 0, 0]), 8, 5, [0, 0, 0, 128]);
    const after = pixel(pixel(raster(), 4, 5, [0, 0, 255, 0]), 8, 5, [127, 127, 127, 255]);
    expect(compareRasterPages({ before, after, tolerance: 0 }).changedPixels).toBe(0);
  });

  it('applies an explicit RGB tolerance and still retains a single changed pixel', () => {
    const before = raster(), after = pixel(pixel(raster(), 2, 3, [238, 255, 255, 255]), 3, 3, [236, 255, 255, 255]);
    expect(compareRasterPages({ before, after, tolerance: 18 }).changedPixels).toBe(1);
    expect(compareRasterPages({ before, after, tolerance: 0 }).changedPixels).toBe(2);
    expect(compareRasterPages({ before, after, tolerance: 36 }).changedPixels).toBe(0);
  });

  it('treats an explicitly blank side as a page addition or removal', () => {
    const source = pixel(pixel(raster(20, 20), 1, 1), 2, 1, [20, 140, 80, 255]);
    const added = compareRasterPages({ before: null, after: source });
    const removed = compareRasterPages({ before: source, after: null });
    expect(added).toMatchObject({ changedPixels: 2, addedPixels: 2, removedPixels: 0, before: null });
    expect(removed).toMatchObject({ changedPixels: 2, removedPixels: 2, addedPixels: 0, after: null });
    expect(added.regions[0].kind).toBe('added'); expect(removed.regions[0].kind).toBe('removed');
  });

  it('pads a smaller page with white without scaling, cropping or centering source pixels', () => {
    const before = pixel(raster(4, 4), 0, 0);
    const after = pixel(pixel(raster(8, 4), 0, 0), 7, 0);
    const result = compareRasterPages({ before, after });
    expect(result).toMatchObject({ width: 8, height: 4, totalPixels: 32, changedPixels: 1, addedPixels: 1, pageSizeChanged: true });
    expect(result.regions[0]).toMatchObject({ x: 7, y: 0, width: 1, height: 1 });
    const emptySizeChange = compareRasterPages({ before: raster(4, 4), after: raster(8, 4) });
    expect(emptySizeChange.changedPixels).toBe(0); expect(emptySizeChange.pageSizeChanged).toBe(true);
  });

  it('coalesces nearby pixels into bounded review regions without inventing semantic objects', () => {
    const before = pixel(raster(100, 100), 1, 1);
    const after = pixel(pixel(raster(100, 100), 31, 31), 90, 90);
    const result = compareRasterPages({ before, after });
    expect(result.regionCount).toBe(2);
    expect(result.regions[0]).toMatchObject({ x: 1, y: 1, width: 31, height: 31, pixels: 2, kind: 'mixed', addedPixels: 1, removedPixels: 1 });
    expect(result.regions[1]).toMatchObject({ x: 90, y: 90, width: 1, height: 1, kind: 'added' });
    validateVisualDiffResult(result, normalizeVisualDiffInput({ before, after }));
  });

  it('caps the region list while preserving all changed pixels, counts and truncation disclosure', () => {
    const before = raster(720, 720), after = raster(720, 720);
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) pixel(after, x * 48, y * 48);
    const result = compareRasterPages({ before, after });
    expect(result).toMatchObject({ changedPixels: 225, regionCount: 225, truncated: true });
    expect(result.regions).toHaveLength(200); expect(maskCount(result.mask)).toBe(225);
    expect(result.regions[0].id).toBe('region-1'); expect(result.regions[199].id).toBe('region-200');
    validateVisualDiffResult(result, normalizeVisualDiffInput({ before, after }));
  });
});

describe('visual comparison bounds and input integrity', () => {
  it('rejects missing pages and unbound or malformed source identities', () => {
    expect(() => compareRasterPages({ before: null, after: null })).toThrow('actual page');
    for (const patch of [{ sourceKey: '' }, { sourceKey: 'x'.repeat(VISUAL_DIFF_LIMITS.maxSourceKeyLength + 1) }, { page: 0 }, { page: 1.5 }]) {
      expect(() => compareRasterPages({ before: null, after: { ...raster(), ...patch } })).toThrow('source identity');
    }
    expect(() => compareRasterPages({ before: undefined, after: raster() } as unknown as VisualDiffInput)).toThrow('invalid dimensions');
  });

  it('rejects different physical scales instead of silently normalizing away a size change', () => {
    expect(() => compareRasterPages({ before: raster(), after: { ...raster(), pixelsPerPoint: 1 } })).toThrow('same physical scale');
    for (const pixelsPerPoint of [0, -1, NaN, Infinity, 17]) expect(() => compareRasterPages({ before: null, after: { ...raster(), pixelsPerPoint } })).toThrow('physical scale');
  });

  it('rejects invalid channels, malformed dimensions and both source/common-canvas oversize', () => {
    for (const patch of [{ width: 0 }, { height: -1 }, { width: 3.5 }, { width: 8193 }, { width: 2001, height: 1000 }]) {
      expect(() => compareRasterPages({ before: null, after: { ...raster(), ...patch } })).toThrow('size limit');
    }
    for (const data of [new Uint8Array(40 * 40 * 4), new Uint8ClampedArray(1)]) {
      expect(() => compareRasterPages({ before: null, after: { ...raster(), data } as RasterPage })).toThrow('pixel format');
    }
    expect(() => compareRasterPages({ before: raster(8192, 1), after: raster(1, 8192) })).toThrow('combined page canvas');
  });

  it('accepts a valid typed-array subview without including bytes outside its raster', () => {
    const buffer = new Uint8ClampedArray(8).fill(0);
    buffer.set([255, 255, 255, 255], 4);
    expect(compareRasterPages({ before: null, after: { ...raster(1, 1), data: buffer.subarray(4) } }).changedPixels).toBe(0);
  });

  it('rejects tolerance values outside the bounded, deliberate sensitivity control', () => {
    for (const tolerance of [-1, 65, 0.5, NaN, Infinity]) expect(() => compareRasterPages({ before: null, after: raster(), tolerance })).toThrow('tolerance');
  });
});
