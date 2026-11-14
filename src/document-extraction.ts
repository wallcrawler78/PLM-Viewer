import type { DocumentTextBlock } from './document-review';

export const DOCUMENT_PROCESSING_LIMITS = Object.freeze({
  sourceBytes: 32 * 1024 * 1024,
  extractionPages: 300,
  extractionCharacters: 500_000,
  extractionBlocks: 6_000,
  extractionItemsPerPage: 100_000,
  extractionMs: 20_000,
  openMs: 30_000,
  wordPages: 300,
  wordElements: 200_000,
});

export type PageTextStatus = 'text' | 'empty' | 'non-text' | 'failed' | 'limited';
export interface DocumentPageCoverage { page: number; status: PageTextStatus }
/** Complete refers to text extraction, never visual/formatting equivalence. */
export interface DocumentExtraction {
  status: 'complete' | 'partial' | 'unavailable';
  blocks: DocumentTextBlock[];
  pages: DocumentPageCoverage[];
  totalPages: number;
  limited: boolean;
}

export function documentExtraction(blocks: DocumentTextBlock[], pages: DocumentPageCoverage[], totalPages: number, limited = false): DocumentExtraction {
  const incomplete = limited || pages.length < totalPages || pages.some(page => !['text', 'empty'].includes(page.status));
  return { status: incomplete ? blocks.length ? 'partial' : 'unavailable' : 'complete', blocks, pages, totalPages, limited };
}

export function failedDocumentExtraction(): DocumentExtraction {
  return { status: 'unavailable', blocks: [], pages: [], totalPages: 0, limited: false };
}

export function extractionCanCompare(value: DocumentExtraction | null): value is DocumentExtraction {
  // An honestly empty successful extraction is valid input. Unreadable/scanned
  // content must never become an invented all-added/all-removed revision.
  return value !== null && (value.status === 'complete' || value.blocks.length > 0);
}

export function documentComparisonCoverage(before: DocumentExtraction | null, after: DocumentExtraction | null) {
  const pending = before === null || after === null;
  const unavailable = !pending && (!extractionCanCompare(before) || !extractionCanCompare(after));
  const partial = !pending && !unavailable && (before.status !== 'complete' || after.status !== 'complete');
  return { pending, unavailable, partial, canCompare: !pending && !unavailable };
}

function pageList(pages: number[]): string {
  const shown = pages.slice(0, 8).join(', ');
  return `${shown}${pages.length > 8 ? ` and ${pages.length - 8} more` : ''}`;
}

export function extractionCoverageMessage(value: DocumentExtraction | null): string {
  if (!value || value.status === 'complete') return '';
  if (!value.totalPages) return 'Text extraction is unavailable for this file.';
  const messages: string[] = [];
  const nonText = value.pages.filter(page => page.status === 'non-text').map(page => page.page);
  const failed = value.pages.filter(page => page.status === 'failed').map(page => page.page);
  const limited = value.pages.filter(page => page.status === 'limited').map(page => page.page);
  if (nonText.length) messages.push(`No extractable text on ${nonText.length === 1 ? 'page' : 'pages'} ${pageList(nonText)}; review visually or use an OCR rendition.`);
  if (failed.length) messages.push(`Text could not be read on ${failed.length === 1 ? 'page' : 'pages'} ${pageList(failed)}.`);
  if (limited.length) messages.push(`Text extraction reached its limit on ${limited.length === 1 ? 'page' : 'pages'} ${pageList(limited)}.`);
  if (value.pages.length < value.totalPages) messages.push(`Pages ${value.pages.length + 1}–${value.totalPages} were not included in text extraction.`);
  if (value.limited && !limited.length && value.pages.length === value.totalPages) messages.push('Some text exceeds the extraction limit.');
  return messages.join(' ') || 'Some content is unavailable for text comparison.';
}

/** Extension and hosted builds use the same package-local PDF.js assets. */
export function localPdfAssetUrls(baseUrl: string, pageUrl: string) {
  const page = new URL(pageUrl);
  const base = new URL(baseUrl, page);
  if (base.protocol !== page.protocol || base.host !== page.host) throw new Error('PDF assets must be packaged with the viewer.');
  const root = new URL('vendor/pdfjs/', base);
  return { cMapUrl: new URL('cmaps/', root).href, cMapPacked: true, standardFontDataUrl: new URL('standard_fonts/', root).href, wasmUrl: new URL('wasm/', root).href };
}

export async function boundedDocumentTask<T>(operation: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  signal.throwIfAborted();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Document operation cancelled.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => reject(new Error('Document processing time limit reached.')), Math.max(1, milliseconds));
    })]);
  } finally {
    clearTimeout(timeout);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** Stream the source so an absent or false Content-Length cannot bypass the bound. */
export async function readDocumentBytes(response: Response, signal: AbortSignal, maxBytes = DOCUMENT_PROCESSING_LIMITS.sourceBytes): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('This document exceeds the 32 MiB source limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The document has no readable content.');
  const started = Date.now(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await boundedDocumentTask(reader.read(), signal, DOCUMENT_PROCESSING_LIMITS.openMs - (Date.now() - started));
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('This document exceeds the 32 MiB source limit.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Bound the whole source acquisition, including headers. The owned controller
 * aborts the actual transport and the body reader on timeout or source changes.
 */
export async function readDocumentSource(fetchSource: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? DOCUMENT_PROCESSING_LIMITS.openMs;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Document loading time limit reached. Retry, or choose a smaller file.')), timeoutMs);
  try {
    const responsePromise = fetchSource(controller.signal).then(response => {
      // A custom transport might not honor abort until after headers arrive.
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw controller.signal.reason;
      }
      return response;
    });
    const response = await boundedDocumentTask(responsePromise, controller.signal, timeoutMs);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Document unavailable (${response.status}). Retry, or choose another attachment.`);
    }
    return await readDocumentBytes(response, controller.signal, options.maxBytes);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
