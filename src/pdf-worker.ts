import { PDFWorker } from 'pdfjs-dist';
import packagedWorkerPath from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Compare the scheme and host: extension URLs can have an opaque URL.origin. */
export function localPdfWorkerUrl(pageUrl: string, workerPath = packagedWorkerPath): URL {
  const page = new URL(pageUrl), worker = new URL(workerPath, page);
  if (!['https:', 'http:', 'chrome-extension:'].includes(page.protocol)
    || worker.protocol !== page.protocol || worker.host !== page.host
    || worker.username || worker.password) throw new Error('PDF processing must use a worker packaged with the viewer.');
  return worker;
}

/**
 * Own the native worker explicitly, in both the reader and the runtime checks.
 * PDF.js's implicit worker path can wrap a URL in a blob and silently fall back
 * to main-thread parsing. Neither behavior qualifies the extension's self-only
 * worker policy. Supplying a native port keeps parsing off the UI thread and
 * makes an unavailable worker fail through the reader's bounded load operation.
 */
export function createLocalPdfWorker(pageUrl = location.href) {
  const nativeWorker = new Worker(localPdfWorkerUrl(pageUrl), { type: 'module', name: 'review-pdf' });
  let worker: PDFWorker;
  try { worker = PDFWorker.create({ port: nativeWorker, verbosity: 0 }); }
  catch (failure) { nativeWorker.terminate(); throw failure; }
  let disposed = false;
  return {
    worker,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { worker.destroy(); }
      finally { nativeWorker.terminate(); }
    },
  };
}
