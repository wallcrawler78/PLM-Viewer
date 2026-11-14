import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { RasterPage, VisualDiffRegion } from './visual-diff/types';
import { withAbort } from './integrations/responseBody';
import { requestPdfPageCleanup } from './pdf-reader';

export const PDF_VISUAL_LIMITS = Object.freeze({ maxPixels: 2_000_000, maxDimension: 8192, targetPixelsPerPoint: 1.5, renderMs: 20_000 });
export interface PdfPageDimensions { width: number; height: number }
export interface PdfRasterSource {
  sourceKey: string;
  pages: number;
  dimensions(page: number, signal: AbortSignal): Promise<PdfPageDimensions>;
  render(page: number, pixelsPerPoint: number, signal: AbortSignal): Promise<RasterPage>;
}
export type PdfRasterAvailability = { status: 'loading' } | { status: 'unavailable'; message: string } | { status: 'ready'; source: PdfRasterSource };
export class PdfVisualError extends Error { override name = 'PdfVisualError'; }

/** Region anchors use the actual source page, never common-canvas padding. */
export function visualRegionPoint(region: Pick<VisualDiffRegion, 'x' | 'y' | 'width' | 'height'>, source: Pick<RasterPage, 'width' | 'height'>) {
  const left = Math.max(0, region.x), top = Math.max(0, region.y);
  const right = Math.min(source.width, region.x + region.width), bottom = Math.min(source.height, region.y + region.height);
  if (right <= left || bottom <= top) return null;
  return { x: (left + right) / 2 / source.width, y: (top + bottom) / 2 / source.height };
}

function validDimensions(value: PdfPageDimensions) {
  if (!Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0 || value.width > 10_000_000 || value.height > 10_000_000) throw new PdfVisualError('This PDF page has unsupported dimensions.');
  return value;
}

/** One physical scale for both pages: never fit each source independently. */
export function planPdfComparison(before: PdfPageDimensions | null, after: PdfPageDimensions | null) {
  if (!before && !after) throw new PdfVisualError('Select at least one source page.');
  if (before) validDimensions(before);
  if (after) validDimensions(after);
  const width = Math.max(before?.width ?? 0, after?.width ?? 0), height = Math.max(before?.height ?? 0, after?.height ?? 0);
  let pixelsPerPoint = Math.min(PDF_VISUAL_LIMITS.targetPixelsPerPoint, PDF_VISUAL_LIMITS.maxDimension / width, PDF_VISUAL_LIMITS.maxDimension / height, Math.sqrt(PDF_VISUAL_LIMITS.maxPixels / (width * height)));
  // Ceil dimensions as PDF.js does. Reserve rounding space at the common edge.
  while (Math.ceil(width * pixelsPerPoint) * Math.ceil(height * pixelsPerPoint) > PDF_VISUAL_LIMITS.maxPixels || Math.ceil(width * pixelsPerPoint) > PDF_VISUAL_LIMITS.maxDimension || Math.ceil(height * pixelsPerPoint) > PDF_VISUAL_LIMITS.maxDimension) pixelsPerPoint *= 0.999;
  return { pixelsPerPoint, width: Math.ceil(width * pixelsPerPoint), height: Math.ceil(height * pixelsPerPoint), downsampled: pixelsPerPoint < PDF_VISUAL_LIMITS.targetPixelsPerPoint - 0.001 };
}

type RasterDocument = Pick<PDFDocumentProxy, 'numPages'> & { getPage(page: number): Promise<PDFPageProxy> };
type RasterOptions = { createCanvas?: () => HTMLCanvasElement; timeoutMs?: number };

/** Uses the reader's existing PDF proxy; it performs no source fetch or upload. */
export function createPdfRasterSource(pdf: RasterDocument, sourceKey: string, options: RasterOptions = {}) {
  if (!sourceKey || !Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new PdfVisualError('The PDF source is unavailable for visual comparison.');
  const lifetime = new AbortController();
  const timeoutMs = options.timeoutMs ?? PDF_VISUAL_LIMITS.renderMs;
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));

  const checkPage = (page: number) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > pdf.numPages) throw new PdfVisualError('Select a page that exists in this PDF.');
  };
  async function bounded<T>(signal: AbortSignal, run: (joined: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new AbortController();
    const joined = AbortSignal.any([signal, lifetime.signal, deadline.signal]);
    joined.throwIfAborted();
    const timer = setTimeout(() => deadline.abort(new PdfVisualError('This page reached the visual rendering time limit. Try another page.')), timeoutMs);
    try { return await run(joined); } finally { clearTimeout(timer); }
  }
  const source: PdfRasterSource = {
    sourceKey,
    pages: pdf.numPages,
    async dimensions(page, signal) {
      checkPage(page);
      return bounded(signal, async joined => {
        const sheet = await withAbort(pdf.getPage(page), joined);
        joined.throwIfAborted();
        const natural = sheet.getViewport({ scale: 1 });
        return validDimensions({ width: natural.width, height: natural.height });
      });
    },
    async render(page, pixelsPerPoint, signal) {
      checkPage(page);
      if (!Number.isFinite(pixelsPerPoint) || pixelsPerPoint <= 0 || pixelsPerPoint > PDF_VISUAL_LIMITS.targetPixelsPerPoint) throw new PdfVisualError('This page comparison has an invalid rendering scale.');
      return bounded(signal, async joined => {
        const sheet = await withAbort(pdf.getPage(page), joined);
        let canvas: HTMLCanvasElement | undefined;
        let task: RenderTask | undefined;
        const cancel = () => task?.cancel();
        joined.addEventListener('abort', cancel, { once: true });
        try {
          joined.throwIfAborted();
          const natural = sheet.getViewport({ scale: 1 });
          validDimensions({ width: natural.width, height: natural.height });
          const viewport = sheet.getViewport({ scale: pixelsPerPoint });
          const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > PDF_VISUAL_LIMITS.maxDimension || height > PDF_VISUAL_LIMITS.maxDimension || width * height > PDF_VISUAL_LIMITS.maxPixels) throw new PdfVisualError('This page exceeds the visual comparison pixel limit.');
          canvas = createCanvas();
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new PdfVisualError('Canvas rendering is unavailable in this browser.');
          task = sheet.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)', intent: 'display' });
          if (joined.aborted) cancel();
          await withAbort(task.promise, joined);
          joined.throwIfAborted();
          const image = context.getImageData(0, 0, width, height);
          return { width, height, data: image.data, pixelsPerPoint, sourceKey, page };
        } catch (failure) {
          if (joined.aborted) throw joined.reason;
          if (failure instanceof PdfVisualError) throw failure;
          throw new PdfVisualError('This PDF page could not be rendered for visual comparison. Try another page or reopen the source.');
        } finally {
          joined.removeEventListener('abort', cancel);
          // An aborted render cannot retain its canvas backing store.
          if (canvas) { canvas.width = 0; canvas.height = 0; }
          // Cooperative cleanup also releases per-page operator/image caches.
          // PDF.js defers it if the ordinary reader is still rendering this page.
          requestPdfPageCleanup(sheet);
        }
      });
    },
  };
  return { source, dispose: () => lifetime.abort(new DOMException('PDF source closed.', 'AbortError')) };
}
