import type { PdfRasterSource } from './pdf-visual-raster';
import { PdfVisualError } from './pdf-visual-raster';
import { comparePdfPagePair, PDF_PAIR_TIMEOUT_MS } from './pdf-page-comparison';
import type { PdfPageComparisonOptions, PdfPagePair } from './pdf-page-comparison';
import { VISUAL_DIFF_LIMITS } from './visual-diff/types';

export const PDF_OVERVIEW_LIMITS = Object.freeze({ maxPairs: 300, pairsPerRun: 50, pixelsPerRun: 60_000_000, runMs: 120_000, pairMs: PDF_PAIR_TIMEOUT_MS });

export type PdfOverviewOutcome = 'changed' | 'no-detected-change' | 'extra-baseline' | 'extra-open-file' | 'unavailable';
export interface PdfOverviewPair extends PdfPagePair {
  number: number;
  outcome: PdfOverviewOutcome;
  /** Null means no usable raster comparison, not zero changed pixels. */
  changedPixels: number | null;
  totalPixels: number | null;
  changedFraction: number | null;
  pageSizeChanged: boolean;
  downsampled: boolean;
  dpi: number | null;
}
export type PdfOverviewStop = 'cancelled' | 'pair-budget' | 'pixel-budget' | 'time-budget' | 'document-limit';
export interface PdfVisualOverviewReport {
  key: string;
  totalPairs: number;
  scanLimit: number;
  pairs: PdfOverviewPair[];
  status: 'running' | 'complete' | 'paused';
  stop?: PdfOverviewStop;
}
export interface PdfOverviewOptions {
  signal: AbortSignal;
  resume?: PdfVisualOverviewReport | null;
  onProgress?: (report: PdfVisualOverviewReport) => void;
  /** Test hooks may only lower the production ceilings. */
  limits?: Partial<Record<'pairsPerRun' | 'pixelsPerRun' | 'runMs' | 'pairMs', number>>;
  compare?: PdfPageComparisonOptions['compare'];
}

function sourceIdentity(source: PdfRasterSource) {
  if (typeof source.sourceKey !== 'string' || !source.sourceKey || source.sourceKey.length > VISUAL_DIFF_LIMITS.maxSourceKeyLength || !Number.isSafeInteger(source.pages) || source.pages < 1) throw new PdfVisualError('The PDF source is unavailable for a page overview.');
  return [source.sourceKey, source.pages];
}

export function pdfOverviewKey(before: PdfRasterSource, after: PdfRasterSource, tolerance: number) {
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > VISUAL_DIFF_LIMITS.maxTolerance) throw new PdfVisualError('The visual comparison sensitivity is invalid.');
  return JSON.stringify(['page-number-pairs-v1', sourceIdentity(before), sourceIdentity(after), tolerance]);
}

export function pdfOverviewPair(number: number, beforePages: number, afterPages: number): PdfPagePair {
  return { beforePage: number <= beforePages ? number : 0, afterPage: number <= afterPages ? number : 0 };
}

class OverviewBudget extends Error { constructor(readonly stop: PdfOverviewStop) { super(stop); } }

function resumePairs(resume: PdfVisualOverviewReport | null | undefined, key: string, totalPairs: number, scanLimit: number, beforePages: number, afterPages: number) {
  if (!resume) return [];
  if (resume.key !== key || resume.totalPairs !== totalPairs || resume.scanLimit !== scanLimit || !Array.isArray(resume.pairs) || resume.pairs.length > scanLimit) throw new PdfVisualError('This overview belongs to different sources or sensitivity. Start a new scan.');
  return resume.pairs.map((pair, index) => {
    const expected = pdfOverviewPair(index + 1, beforePages, afterPages);
    const unavailable = pair.outcome === 'unavailable';
    const validCounts = unavailable ? pair.changedPixels === null && pair.totalPixels === null && pair.changedFraction === null && pair.dpi === null : Number.isSafeInteger(pair.changedPixels) && Number.isSafeInteger(pair.totalPixels) && pair.totalPixels! > 0 && pair.totalPixels! <= VISUAL_DIFF_LIMITS.maxPixels && pair.changedPixels! >= 0 && pair.changedPixels! <= pair.totalPixels! && pair.changedFraction === pair.changedPixels! / pair.totalPixels! && Number.isFinite(pair.dpi) && pair.dpi! > 0;
    const expectedOutcome = unavailable ? 'unavailable' : expected.beforePage === 0 ? 'extra-open-file' : expected.afterPage === 0 ? 'extra-baseline' : pair.changedPixels! > 0 || pair.pageSizeChanged ? 'changed' : 'no-detected-change';
    if (pair.number !== index + 1 || pair.beforePage !== expected.beforePage || pair.afterPage !== expected.afterPage || pair.outcome !== expectedOutcome || !validCounts || typeof pair.pageSizeChanged !== 'boolean' || typeof pair.downsampled !== 'boolean') throw new PdfVisualError('The previous page overview is incomplete or invalid. Start a new scan.');
    return {
      number: pair.number, beforePage: pair.beforePage, afterPage: pair.afterPage,
      outcome: pair.outcome, changedPixels: pair.changedPixels, totalPixels: pair.totalPixels,
      changedFraction: pair.changedFraction, pageSizeChanged: pair.pageSizeChanged,
      downsampled: pair.downsampled, dpi: pair.dpi,
    };
  });
}

/**
 * Only one page pair is alive at once. Raster/mask buffers leave scope after each
 * summary, and no source content is put in the report or persistent storage.
 * A failed pair is never represented as an unchanged or absent page.
 */
export async function scanPdfVisualOverview(before: PdfRasterSource, after: PdfRasterSource, tolerance: number, options: PdfOverviewOptions): Promise<PdfVisualOverviewReport> {
  const key = pdfOverviewKey(before, after, tolerance);
  const beforePages = before.pages, afterPages = after.pages;
  const totalPairs = Math.max(beforePages, afterPages), scanLimit = Math.min(totalPairs, PDF_OVERVIEW_LIMITS.maxPairs);
  const pairs = resumePairs(options.resume, key, totalPairs, scanLimit, beforePages, afterPages);
  const limits = { ...PDF_OVERVIEW_LIMITS, ...options.limits };
  for (const name of ['pairsPerRun', 'pixelsPerRun', 'runMs', 'pairMs'] as const) if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > PDF_OVERVIEW_LIMITS[name]) throw new PdfVisualError('The page overview limits are invalid.');
  const lifetime = new AbortController();
  const joined = AbortSignal.any([options.signal, lifetime.signal]);
  const timer = setTimeout(() => lifetime.abort(new OverviewBudget('time-budget')), limits.runMs);
  const snapshot = (status: PdfVisualOverviewReport['status'], stop?: PdfOverviewStop): PdfVisualOverviewReport => ({ key, totalPairs, scanLimit, pairs: pairs.map(pair => ({ ...pair })), status, ...(stop ? { stop } : {}) });
  let runPairs = 0, runPixels = 0;
  const pause = (stop: PdfOverviewStop) => snapshot('paused', stop);
  try {
    options.onProgress?.(snapshot('running'));
    while (pairs.length < scanLimit) {
      if (joined.aborted) return pause(options.signal.aborted ? 'cancelled' : 'time-budget');
      if (runPairs >= limits.pairsPerRun) return pause('pair-budget');
      if (pdfOverviewKey(before, after, tolerance) !== key) throw new PdfVisualError('The PDF source changed during this overview. Start a new scan.');
      const number = pairs.length + 1, pair = pdfOverviewPair(number, beforePages, afterPages);
      try {
        const completed = await comparePdfPagePair(before, after, pair, tolerance, {
          signal: joined, timeoutMs: limits.pairMs, compare: options.compare,
          beforeRender: plan => {
            const pixels = plan.width * plan.height;
            if (runPixels + pixels > limits.pixelsPerRun) throw new OverviewBudget('pixel-budget');
            // Count allocated attempts too; a failed render cannot evade the budget.
            runPixels += pixels;
          },
        });
        joined.throwIfAborted();
        const { result } = completed;
        const outcome: PdfOverviewOutcome = !pair.beforePage ? 'extra-open-file' : !pair.afterPage ? 'extra-baseline' : result.changedPixels > 0 || result.pageSizeChanged ? 'changed' : 'no-detected-change';
        pairs.push({ ...pair, number, outcome, changedPixels: result.changedPixels, totalPixels: result.totalPixels, changedFraction: result.changedFraction, pageSizeChanged: result.pageSizeChanged, downsampled: completed.downsampled, dpi: result.pixelsPerPoint * 72 });
      } catch (failure) {
        if (joined.aborted) return pause(options.signal.aborted ? 'cancelled' : 'time-budget');
        if (failure instanceof OverviewBudget) return pause(failure.stop);
        pairs.push({ ...pair, number, outcome: 'unavailable', changedPixels: null, totalPixels: null, changedFraction: null, pageSizeChanged: false, downsampled: false, dpi: null });
      }
      if (pdfOverviewKey(before, after, tolerance) !== key) throw new PdfVisualError('The PDF source changed during this overview. Start a new scan.');
      runPairs++;
      options.onProgress?.(snapshot('running'));
    }
    return pairs.length === totalPairs ? snapshot('complete') : pause('document-limit');
  } finally {
    clearTimeout(timer);
    lifetime.abort(new DOMException('PDF overview ended.', 'AbortError'));
  }
}
