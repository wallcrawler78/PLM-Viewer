import { withAbort } from './integrations/responseBody';
import { PdfVisualError, planPdfComparison } from './pdf-visual-raster';
import type { PdfRasterSource } from './pdf-visual-raster';
import { compareVisualPages } from './visual-diff/client';
import type { RasterPage } from './visual-diff/types';

export const PDF_PAIR_TIMEOUT_MS = 45_000;
export type PdfPairPlan = ReturnType<typeof planPdfComparison>;
export interface PdfPagePair { beforePage: number; afterPage: number }

export interface PdfPageComparisonOptions {
  signal: AbortSignal;
  /** Only lower deadlines are accepted. Used by deterministic lifecycle tests. */
  timeoutMs?: number;
  /** Allows a scan to stop before allocating the next pair's raster buffers. */
  beforeRender?: (plan: PdfPairPlan) => void;
  compare?: typeof compareVisualPages;
}

/** Shared by the detailed overlay and sequential overview; no file fetches. */
export async function comparePdfPagePair(before: PdfRasterSource, after: PdfRasterSource, pair: PdfPagePair, tolerance: number, options: PdfPageComparisonOptions) {
  const { signal } = options;
  signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? PDF_PAIR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PDF_PAIR_TIMEOUT_MS) throw new PdfVisualError('The PDF page comparison deadline is invalid.');
  for (const [source, page] of [[before, pair.beforePage], [after, pair.afterPage]] as const) {
    if (!source.sourceKey || !Number.isSafeInteger(page) || page < 0 || page > source.pages) throw new PdfVisualError('Select a page that exists in each source PDF.');
  }
  if (!pair.beforePage && !pair.afterPage) throw new PdfVisualError('Select at least one source page.');
  const beforeKey = before.sourceKey, afterKey = after.sourceKey, beforePages = before.pages, afterPages = after.pages;
  const lifetime = new AbortController();
  const joined = AbortSignal.any([signal, lifetime.signal]);
  const timer = setTimeout(() => lifetime.abort(new PdfVisualError('This page pair reached its comparison time limit.')), timeoutMs);
  try {
    const [leftDimensions, rightDimensions] = await withAbort(Promise.all([
      pair.beforePage ? before.dimensions(pair.beforePage, joined) : Promise.resolve(null),
      pair.afterPage ? after.dimensions(pair.afterPage, joined) : Promise.resolve(null),
    ]), joined);
    joined.throwIfAborted();
    const plan = planPdfComparison(leftDimensions, rightDimensions);
    options.beforeRender?.(plan);
    const [left, right] = await withAbort(Promise.all([
      pair.beforePage ? before.render(pair.beforePage, plan.pixelsPerPoint, joined) : Promise.resolve(null),
      pair.afterPage ? after.render(pair.afterPage, plan.pixelsPerPoint, joined) : Promise.resolve(null),
    ]), joined);
    joined.throwIfAborted();
    const correctPage = (raster: RasterPage | null, page: number, key: string) => page === 0 ? raster === null : raster?.page === page && raster.sourceKey === key && raster.pixelsPerPoint === plan.pixelsPerPoint;
    if (before.sourceKey !== beforeKey || after.sourceKey !== afterKey || before.pages !== beforePages || after.pages !== afterPages || !correctPage(left, pair.beforePage, beforeKey) || !correctPage(right, pair.afterPage, afterKey)) throw new PdfVisualError('The rendered page no longer matches this source request. Reopen the source documents.');
    const result = await withAbort((options.compare ?? compareVisualPages)({ before: left, after: right, tolerance }, { signal: joined }), joined);
    joined.throwIfAborted();
    if (before.sourceKey !== beforeKey || after.sourceKey !== afterKey || before.pages !== beforePages || after.pages !== afterPages) throw new PdfVisualError('The PDF source changed during comparison. Reopen the source documents.');
    // Raster rounding can hide a physical size change, especially for large
    // downsampled drawings. Preserve that source observation independently of
    // the worker's validated pixel-size/pixel-difference results.
    const physicalSizeChanged = !!leftDimensions && !!rightDimensions
      && (leftDimensions.width !== rightDimensions.width || leftDimensions.height !== rightDimensions.height);
    return { before: left, after: right, result: { ...result, pageSizeChanged: result.pageSizeChanged || physicalSizeChanged }, downsampled: plan.downsampled };
  } finally {
    clearTimeout(timer);
    // Stops the other source on a one-sided failure, including late render work.
    lifetime.abort(new DOMException('PDF page comparison ended.', 'AbortError'));
  }
}
