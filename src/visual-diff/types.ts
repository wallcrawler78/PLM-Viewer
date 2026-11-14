/** Raster comparison is an observation of rendered pixels, not a semantic review. */
export const VISUAL_DIFF_LIMITS = Object.freeze({
  maxPixels: 2_000_000,
  maxDimension: 8192,
  maxRegions: 200,
  tileSize: 16,
  maxSourceKeyLength: 8192,
  timeoutMs: 15_000,
  maxTimeoutMs: 60_000,
  defaultTolerance: 18,
  maxTolerance: 64,
});

export interface RasterPageIdentity {
  sourceKey: string;
  page: number;
  width: number;
  height: number;
  /** Both sources must use the same physical scale. No independent fit/rescale. */
  pixelsPerPoint: number;
}

export interface RasterPage extends RasterPageIdentity {
  data: Uint8ClampedArray;
}

export interface VisualDiffInput {
  /** Null is an explicitly selected blank counterpart, never failed extraction. */
  before: RasterPage | null;
  after: RasterPage | null;
  /** Maximum allowed difference in any composited RGB channel, from 0 to 64. */
  tolerance?: number;
}

export type VisualDiffKind = 'added' | 'removed' | 'modified' | 'mixed';
export interface VisualDiffRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
  addedPixels: number;
  removedPixels: number;
  modifiedPixels: number;
  /** A coalesced raster region, not an identified text/object change. */
  kind: VisualDiffKind;
}

export interface VisualDiffResult {
  width: number;
  height: number;
  pixelsPerPoint: number;
  tolerance: number;
  before: RasterPageIdentity | null;
  after: RasterPageIdentity | null;
  pageSizeChanged: boolean;
  changedPixels: number;
  totalPixels: number;
  changedFraction: number;
  addedPixels: number;
  removedPixels: number;
  modifiedPixels: number;
  /** At most maxRegions coalesced regions. The mask still includes every change. */
  regions: VisualDiffRegion[];
  regionCount: number;
  truncated: boolean;
  /** Transparent on unchanged pixels; red/teal/amber mark removal/addition/modification. */
  mask: Uint8ClampedArray;
}

export interface VisualDiffWorkerRequest {
  type: 'compare-visual-pages';
  requestId: string;
  input: VisualDiffInput;
}

export type VisualDiffWorkerResponse =
  | { type: 'visual-diff-result'; requestId: string; result: VisualDiffResult }
  | { type: 'visual-diff-error'; requestId: string; message: string };
