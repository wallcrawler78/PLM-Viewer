import { VISUAL_DIFF_LIMITS } from './types';
import type { RasterPage, RasterPageIdentity, VisualDiffInput, VisualDiffResult, VisualDiffRegion } from './types';

export class VisualDiffError extends Error {
  constructor(message: string) { super(message); this.name = 'VisualDiffError'; }
}

export function rasterIdentity(page: RasterPage | null): RasterPageIdentity | null {
  return page ? { sourceKey: page.sourceKey, page: page.page, width: page.width, height: page.height, pixelsPerPoint: page.pixelsPerPoint } : null;
}

function validateRaster(value: RasterPage | null): void {
  if (value === null) return;
  if (!value || typeof value !== 'object'
    || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > VISUAL_DIFF_LIMITS.maxDimension
    || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > VISUAL_DIFF_LIMITS.maxDimension
    || value.width * value.height > VISUAL_DIFF_LIMITS.maxPixels) {
    throw new VisualDiffError('A page raster exceeds the local visual comparison size limit or has invalid dimensions.');
  }
  if (!(value.data instanceof Uint8ClampedArray) || !(value.data.buffer instanceof ArrayBuffer)
    || value.data.length !== value.width * value.height * 4) {
    throw new VisualDiffError('The page raster is incomplete or has an invalid pixel format.');
  }
  if (typeof value.sourceKey !== 'string' || !value.sourceKey || value.sourceKey.length > VISUAL_DIFF_LIMITS.maxSourceKeyLength
    || !Number.isSafeInteger(value.page) || value.page < 1) {
    throw new VisualDiffError('The page raster has no valid exact source identity.');
  }
  if (!Number.isFinite(value.pixelsPerPoint) || value.pixelsPerPoint <= 0 || value.pixelsPerPoint > 16) {
    throw new VisualDiffError('The page raster has an invalid physical scale.');
  }
}

export function normalizeVisualDiffInput(input: VisualDiffInput): Required<VisualDiffInput> {
  if (!input || typeof input !== 'object') throw new VisualDiffError('Choose two page sources for visual comparison.');
  validateRaster(input.before); validateRaster(input.after);
  if (!input.before && !input.after) throw new VisualDiffError('At least one actual page is required for visual comparison.');
  if (input.before && input.after && input.before.pixelsPerPoint !== input.after.pixelsPerPoint) {
    throw new VisualDiffError('Render both pages at the same physical scale before comparing them.');
  }
  const width = Math.max(input.before?.width ?? 0, input.after?.width ?? 0);
  const height = Math.max(input.before?.height ?? 0, input.after?.height ?? 0);
  if (width * height > VISUAL_DIFF_LIMITS.maxPixels) {
    throw new VisualDiffError('The combined page canvas exceeds the local visual comparison size limit.');
  }
  const tolerance = input.tolerance ?? VISUAL_DIFF_LIMITS.defaultTolerance;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > VISUAL_DIFF_LIMITS.maxTolerance) {
    throw new VisualDiffError('Visual comparison tolerance must be an integer from 0 to 64.');
  }
  return { before: input.before, after: input.after, tolerance };
}

function nonnegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function matchesIdentity(value: RasterPageIdentity | null, expected: RasterPageIdentity | null): boolean {
  return expected === null ? value === null : !!value && value.sourceKey === expected.sourceKey && value.page === expected.page
    && value.width === expected.width && value.height === expected.height && value.pixelsPerPoint === expected.pixelsPerPoint;
}

export function regionKind(added: number, removed: number, modified: number): VisualDiffRegion['kind'] {
  return Number(added > 0) + Number(removed > 0) + Number(modified > 0) > 1 ? 'mixed' : added > 0 ? 'added' : removed > 0 ? 'removed' : 'modified';
}

/** Check the source envelope and bounded result before accepting a worker response. */
export function validateVisualDiffResult(value: VisualDiffResult, expected: Required<VisualDiffInput>): void {
  const width = Math.max(expected.before?.width ?? 0, expected.after?.width ?? 0);
  const height = Math.max(expected.before?.height ?? 0, expected.after?.height ?? 0);
  const total = width * height;
  const scale = (expected.before ?? expected.after)!.pixelsPerPoint;
  const pageSizeChanged = !!expected.before && !!expected.after && (expected.before.width !== expected.after.width || expected.before.height !== expected.after.height);
  if (!value || value.width !== width || value.height !== height || value.totalPixels !== total || value.pixelsPerPoint !== scale
    || value.tolerance !== expected.tolerance || value.pageSizeChanged !== pageSizeChanged
    || !matchesIdentity(value.before, rasterIdentity(expected.before)) || !matchesIdentity(value.after, rasterIdentity(expected.after))
    || !(value.mask instanceof Uint8ClampedArray) || !(value.mask.buffer instanceof ArrayBuffer) || value.mask.length !== total * 4
    || !nonnegativeInteger(value.changedPixels, total) || !nonnegativeInteger(value.addedPixels, total)
    || !nonnegativeInteger(value.removedPixels, total) || !nonnegativeInteger(value.modifiedPixels, total)
    || value.addedPixels + value.removedPixels + value.modifiedPixels !== value.changedPixels
    || value.changedFraction !== value.changedPixels / total
    || !Array.isArray(value.regions) || value.regions.length > VISUAL_DIFF_LIMITS.maxRegions
    || !nonnegativeInteger(value.regionCount, Math.ceil(width / VISUAL_DIFF_LIMITS.tileSize) * Math.ceil(height / VISUAL_DIFF_LIMITS.tileSize))
    || value.regions.length !== Math.min(value.regionCount, VISUAL_DIFF_LIMITS.maxRegions)
    || value.truncated !== (value.regionCount > VISUAL_DIFF_LIMITS.maxRegions)
    || (value.changedPixels === 0) !== (value.regionCount === 0)) {
    throw new VisualDiffError('The visual comparison result does not match the requested sources or limits.');
  }
  const ids = new Set<string>();
  let represented = 0;
  for (const region of value.regions) {
    if (!region || typeof region.id !== 'string' || !/^region-\d{1,3}$/.test(region.id) || ids.has(region.id)
      || !nonnegativeInteger(region.x, width - 1) || !nonnegativeInteger(region.y, height - 1)
      || !nonnegativeInteger(region.width, width - region.x) || !region.width
      || !nonnegativeInteger(region.height, height - region.y) || !region.height
      || !nonnegativeInteger(region.pixels, region.width * region.height) || !region.pixels
      || !nonnegativeInteger(region.addedPixels, region.pixels) || !nonnegativeInteger(region.removedPixels, region.pixels)
      || !nonnegativeInteger(region.modifiedPixels, region.pixels)
      || region.addedPixels + region.removedPixels + region.modifiedPixels !== region.pixels
      || region.kind !== regionKind(region.addedPixels, region.removedPixels, region.modifiedPixels)) {
      throw new VisualDiffError('The visual comparison returned an invalid change region.');
    }
    ids.add(region.id); represented += region.pixels;
  }
  if (represented > value.changedPixels || !value.truncated && represented !== value.changedPixels) {
    throw new VisualDiffError('The visual comparison returned incomplete region counts.');
  }
}
