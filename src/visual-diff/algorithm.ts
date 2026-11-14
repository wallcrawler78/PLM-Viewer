import { VISUAL_DIFF_LIMITS } from './types';
import type { RasterPage, VisualDiffInput, VisualDiffRegion, VisualDiffResult } from './types';
import { normalizeVisualDiffInput, rasterIdentity, regionKind } from './validation';

type Tile = { minX: number; minY: number; maxX: number; maxY: number; added: number; removed: number; modified: number };

/** RGB composited onto the same white page background, including transparent image pixels. */
function sample(page: RasterPage | null, x: number, y: number, output: number[]) {
  if (!page || x >= page.width || y >= page.height) { output[0] = output[1] = output[2] = 255; return; }
  const offset = (y * page.width + x) * 4;
  const alpha = page.data[offset + 3] / 255;
  output[0] = Math.round(255 + (page.data[offset] - 255) * alpha);
  output[1] = Math.round(255 + (page.data[offset + 1] - 255) * alpha);
  output[2] = Math.round(255 + (page.data[offset + 2] - 255) * alpha);
}

/**
 * Bounded O(pixels + tiles) comparison. The caller supplies one shared physical
 * scale; we never stretch, center or register pages to hide layout differences.
 * 16-pixel tile connectivity coalesces neighboring raster changes for review.
 * There is no semantic object recognition and no "unimportant" change filter.
 */
export function compareRasterPages(rawInput: VisualDiffInput): VisualDiffResult {
  const input = normalizeVisualDiffInput(rawInput), { before, after, tolerance } = input;
  const width = Math.max(before?.width ?? 0, after?.width ?? 0), height = Math.max(before?.height ?? 0, after?.height ?? 0);
  const totalPixels = width * height;
  const mask = new Uint8ClampedArray(totalPixels * 4);
  const tileSize = VISUAL_DIFF_LIMITS.tileSize, columns = Math.ceil(width / tileSize), rows = Math.ceil(height / tileSize);
  const tiles: (Tile | undefined)[] = new Array(columns * rows);
  const previous = [255, 255, 255], current = [255, 255, 255];
  let addedPixels = 0, removedPixels = 0, modifiedPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sample(before, x, y, previous); sample(after, x, y, current);
      if (Math.max(Math.abs(previous[0] - current[0]), Math.abs(previous[1] - current[1]), Math.abs(previous[2] - current[2])) <= tolerance) continue;
      const previousBlank = Math.min(previous[0], previous[1], previous[2]) >= 255 - tolerance;
      const currentBlank = Math.min(current[0], current[1], current[2]) >= 255 - tolerance;
      const kind = previousBlank && !currentBlank ? 'added' : currentBlank && !previousBlank ? 'removed' : 'modified';
      if (kind === 'added') addedPixels++; else if (kind === 'removed') removedPixels++; else modifiedPixels++;
      const pixel = (y * width + x) * 4;
      // Fixed colors retain a stable meaning across dark/light and source colors.
      if (kind === 'added') { mask[pixel] = 10; mask[pixel + 1] = 153; mask[pixel + 2] = 131; }
      else if (kind === 'removed') { mask[pixel] = 221; mask[pixel + 1] = 78; mask[pixel + 2] = 72; }
      else { mask[pixel] = 221; mask[pixel + 1] = 144; mask[pixel + 2] = 22; }
      mask[pixel + 3] = 180;
      const index = Math.floor(y / tileSize) * columns + Math.floor(x / tileSize);
      const tile = tiles[index] ?? (tiles[index] = { minX: x, minY: y, maxX: x, maxY: y, added: 0, removed: 0, modified: 0 });
      tile.minX = Math.min(tile.minX, x); tile.minY = Math.min(tile.minY, y);
      tile.maxX = Math.max(tile.maxX, x); tile.maxY = Math.max(tile.maxY, y);
      tile[kind]++;
    }
  }

  const visited = new Uint8Array(tiles.length), pending = new Int32Array(tiles.length);
  const allRegions: VisualDiffRegion[] = [];
  for (let start = 0; start < tiles.length; start++) {
    if (!tiles[start] || visited[start]) continue;
    let first = 0, last = 1, minX = width, minY = height, maxX = 0, maxY = 0, added = 0, removed = 0, modified = 0;
    pending[0] = start; visited[start] = 1;
    while (first < last) {
      const index = pending[first++], tile = tiles[index]!;
      minX = Math.min(minX, tile.minX); minY = Math.min(minY, tile.minY); maxX = Math.max(maxX, tile.maxX); maxY = Math.max(maxY, tile.maxY);
      added += tile.added; removed += tile.removed; modified += tile.modified;
      const tx = index % columns, ty = Math.floor(index / columns);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 || tx + dx < 0 || tx + dx >= columns || ty + dy < 0 || ty + dy >= rows) continue;
          const neighbor = (ty + dy) * columns + tx + dx;
          if (!visited[neighbor] && tiles[neighbor]) { visited[neighbor] = 1; pending[last++] = neighbor; }
        }
      }
    }
    allRegions.push({ id: '', x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1,
      pixels: added + removed + modified, addedPixels: added, removedPixels: removed, modifiedPixels: modified, kind: regionKind(added, removed, modified) });
  }
  const regionCount = allRegions.length;
  const truncated = regionCount > VISUAL_DIFF_LIMITS.maxRegions;
  // If listing is bounded, retain the largest regions, but the full mask/counts
  // remain available and the caller must disclose the unlisted region count.
  if (truncated) allRegions.sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
  const regions = allRegions.slice(0, VISUAL_DIFF_LIMITS.maxRegions).sort((a, b) => a.y - b.y || a.x - b.x);
  regions.forEach((region, index) => { region.id = `region-${index + 1}`; });
  const changedPixels = addedPixels + removedPixels + modifiedPixels;
  return {
    width, height, pixelsPerPoint: (before ?? after)!.pixelsPerPoint, tolerance,
    before: rasterIdentity(before), after: rasterIdentity(after),
    pageSizeChanged: !!before && !!after && (before.width !== after.width || before.height !== after.height),
    changedPixels, totalPixels, changedFraction: changedPixels / totalPixels,
    addedPixels, removedPixels, modifiedPixels, regions, regionCount, truncated, mask,
  };
}
