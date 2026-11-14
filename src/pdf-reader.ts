import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import type { PDFPageProxy } from 'pdfjs-dist';
import { DOCUMENT_PROCESSING_LIMITS } from './document-extraction';
import { withAbort } from './integrations/responseBody';

export const PDF_READER_LIMITS = Object.freeze({
  taskMs: 20_000,
  textItems: DOCUMENT_PROCESSING_LIMITS.extractionItemsPerPage,
  textCharacters: DOCUMENT_PROCESSING_LIMITS.extractionCharacters,
  textStyles: 4_096,
});

export class PdfReaderError extends Error { override name = 'PdfReaderError'; }

/**
 * PDF.js defers page cleanup while another renderer/operator-list consumer is
 * active. Do not destroy the shared page or clean up document fonts here.
 */
export function requestPdfPageCleanup(page?: Pick<PDFPageProxy, 'cleanup'>): boolean {
  try { return page?.cleanup() ?? false; }
  catch { return false; } // Source teardown must not replace a render result/error.
}

/** A reader deadline also cancels its owned render, rather than just changing the UI. */
export async function boundedPdfReaderTask<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, options: { timeoutMs?: number; cancel?: () => void } = {}): Promise<T> {
  const deadline = new AbortController();
  const joined = AbortSignal.any([signal, deadline.signal]);
  joined.throwIfAborted();
  const cancel = () => options.cancel?.();
  joined.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => deadline.abort(new PdfReaderError('This page reached the rendering time limit. Try another page or retry the document.')), options.timeoutMs ?? PDF_READER_LIMITS.taskMs);
  try {
    const result = await withAbort(run(joined), joined);
    joined.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timeout);
    joined.removeEventListener('abort', cancel);
  }
}

/** Bound the selectable text too; getTextContent() otherwise buffers an entire page. */
export async function readPdfSelectionText(stream: ReadableStream<TextContent>, signal: AbortSignal, limits: { textItems: number; textCharacters: number; textStyles: number } = PDF_READER_LIMITS): Promise<TextContent> {
  signal.throwIfAborted();
  const reader = stream.getReader();
  const content: TextContent = { items: [], styles: Object.create(null) as TextContent['styles'], lang: null };
  let characters = 0, styles = 0, complete = false, cancelled = false;
  const cancel = () => {
    if (cancelled || complete) return;
    cancelled = true;
    // A broken stream's cancel hook can itself stall; never await it on the UI path.
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await withAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) { complete = true; return content; }
      if (content.items.length + value.items.length > limits.textItems) throw new PdfReaderError('This page exceeds the text-selection limit.');
      for (const item of value.items) {
        if ('str' in item) characters += item.str.length;
        if (characters > limits.textCharacters) throw new PdfReaderError('This page exceeds the text-selection limit.');
        content.items.push(item);
      }
      for (const [name, style] of Object.entries(value.styles)) {
        if (!Object.hasOwn(content.styles, name) && ++styles > limits.textStyles) throw new PdfReaderError('This page exceeds the text-selection limit.');
        content.styles[name] = style;
      }
      content.lang ??= value.lang;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
