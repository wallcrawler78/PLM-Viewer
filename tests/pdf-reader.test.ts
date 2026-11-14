import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TextContent, TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api';
import { boundedPdfReaderTask, readPdfSelectionText, requestPdfPageCleanup } from '../src/pdf-reader';
import { renderPdfLayers } from '../src/document-rendering';

const item = (str: string): TextItem => ({ str, dir: 'ltr', transform: [1, 0, 0, 1, 0, 0], width: str.length, height: 1, fontName: 'font', hasEOL: true });
const style: TextStyle = { fontFamily: 'sans-serif', ascent: 1, descent: 0, vertical: false };
const chunk = (text: string[], styles: TextContent['styles'] = { font: style }): TextContent => ({ items: text.map(item), styles, lang: 'en' });
const limits = { textItems: 3, textCharacters: 8, textStyles: 2 };

afterEach(() => vi.useRealTimers());

describe('reader-owned PDF page deadlines', () => {
  it('expires stalled page acquisition and cancels an owned raster task', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let joined!: AbortSignal;
    let finish!: () => void;
    const pending = boundedPdfReaderTask(signal => { joined = signal; return new Promise<void>(resolve => { finish = resolve; }); }, new AbortController().signal, { timeoutMs: 10, cancel });
    const rejected = expect(pending).rejects.toThrow('rendering time limit');
    await vi.advanceTimersByTimeAsync(11); await rejected;
    expect(joined.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    // Late renderer completion cannot turn the timed-out operation into success.
    finish();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an obsolete page immediately and never starts work for an already-closed page', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const run = vi.fn(() => new Promise<void>(() => {}));
    const pending = boundedPdfReaderTask(run, controller.signal, { cancel });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    await expect(boundedPdfReaderTask(run, controller.signal, { cancel })).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('releases the deadline and cancellation listener after successful rendering', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn();
    expect(await boundedPdfReaderTask(async () => 'page', controller.signal, { timeoutMs: 10, cancel })).toBe('page');
    controller.abort(); await vi.advanceTimersByTimeAsync(11);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a completed raster viewable when text extraction stalls, cancelling its stream', async () => {
    vi.useFakeTimers();
    const streamCancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<TextContent>({ cancel: streamCancel });
    const signal = new AbortController().signal;
    const pending = renderPdfLayers(async () => undefined, () => boundedPdfReaderTask(joined => readPdfSelectionText(stream, joined), signal, { timeoutMs: 10 }), () => signal.aborted);
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toBe('image-only');
    expect(streamCancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stalled text layer and falls back to the page image', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const signal = new AbortController().signal;
    const pending = renderPdfLayers(async () => undefined, () => boundedPdfReaderTask(() => new Promise(() => {}), signal, { timeoutMs: 10, cancel }), () => signal.aborted);
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toBe('image-only');
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('bounded selectable PDF page text', () => {
  it('retains item ordering, language and accumulated font styles across chunks', async () => {
    const stream = new ReadableStream<TextContent>({ start(controller) {
      controller.enqueue(chunk(['One']));
      controller.enqueue(chunk(['Two'], { other: style }));
      controller.close();
    } });
    const text = await readPdfSelectionText(stream, new AbortController().signal, limits);
    expect(text.items).toEqual([item('One'), item('Two')]);
    expect(text.styles).toEqual({ font: style, other: style });
    expect(text.lang).toBe('en');
    expect(stream.locked).toBe(false);
  });

  it.each([
    { name: 'items', content: chunk(['a', 'b', 'c', 'd']) },
    { name: 'characters', content: chunk(['ninechars']) },
    { name: 'font styles', content: chunk(['a'], { a: style, b: style, c: style }) },
  ])('cancels $name overflow instead of publishing a silently truncated selection layer', async ({ content }) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<TextContent>({ start(controller) { controller.enqueue(content); }, cancel });
    await expect(readPdfSelectionText(stream, new AbortController().signal, limits)).rejects.toThrow('text-selection limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('applies text budgets cumulatively across streamed chunks', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<TextContent>({ start(controller) {
      controller.enqueue(chunk(['four'])); controller.enqueue(chunk(['more'])); controller.enqueue(chunk(['x']));
    }, cancel });
    await expect(readPdfSelectionText(stream, new AbortController().signal, limits)).rejects.toThrow('text-selection limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('releases a stalled selection stream as soon as the source is replaced', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<TextContent>({ cancel });
    const controller = new AbortController();
    const pending = readPdfSelectionText(stream, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});

describe('cooperative PDF page resource release', () => {
  it('defers actual PDF.js operator cleanup, preserves concurrent text, and permits a fresh page read', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const root = resolve('node_modules/pdfjs-dist');
    const task = getDocument({ data: new Uint8Array(await readFile(resolve('public/fixtures/documents/atlas-spec-A.pdf'))), isEvalSupported: false, cMapUrl: `${root}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${root}/standard_fonts/`, wasmUrl: `${root}/wasm/`, useWorkerFetch: false, verbosity: 0 });
    try {
      const document = await task.promise;
      const page = await document.getPage(1);
      const operators = page.getOperatorList();
      // An unfinished operator-list consumer is tracked with active render tasks.
      expect(requestPdfPageCleanup(page)).toBe(false);
      const text = readPdfSelectionText(page.streamTextContent(), new AbortController().signal);
      expect((await operators).fnArray.length).toBeGreaterThan(0);
      const extracted = await text;
      expect(extracted.items.length).toBeGreaterThan(0);
      expect(requestPdfPageCleanup(page)).toBe(true);
      const repeated = await readPdfSelectionText(page.streamTextContent(), new AbortController().signal);
      expect(repeated.items).toEqual(extracted.items);
      expect((await page.getOperatorList()).fnArray.length).toBeGreaterThan(0);
      expect(requestPdfPageCleanup(page)).toBe(true);
    } finally { await task.destroy(); }
  }, 15_000);
});
