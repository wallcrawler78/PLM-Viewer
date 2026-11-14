import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareDocumentBlocks, DOCUMENT_COMPARISON_LIMITS } from '../src/document-review';
import { compareDocumentText } from '../src/text-comparison/client';
import type { TextComparisonWorker } from '../src/text-comparison/client';
import { processTextComparisonRequest } from '../src/text-comparison/processor';
import { TEXT_COMPARISON_LIMITS } from '../src/text-comparison/types';
import type { TextComparisonInput, TextComparisonResult, TextComparisonWorkerRequest } from '../src/text-comparison/types';
import { normalizeTextComparisonInput, validateTextComparisonResult } from '../src/text-comparison/validation';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function input(): TextComparisonInput {
  return {
    before: { sourceKey: '["attachment","item","A","1","hash-a","blob:baseline","pdf"]', blocks: [{ id: 'p1-b0', page: 1, text: 'Clamp torque 8 Nm.' }, { id: 'p2-b0', page: 2, text: 'Inspect every assembly.' }] },
    after: { sourceKey: '["attachment","item","B","2","hash-b","blob:current","pdf"]', blocks: [{ id: 'p2-b0', page: 2, text: 'Clamp torque 10 Nm.' }, { id: 'p3-b0', page: 3, text: 'Inspect every assembly.' }] },
  };
}
function worker(post?: (request: TextComparisonWorkerRequest) => void): TextComparisonWorker & { terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> } {
  return { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn((request: TextComparisonWorkerRequest) => post?.(request)), terminate: vi.fn(() => {}) };
}
function request(instance: ReturnType<typeof worker>): TextComparisonWorkerRequest { return instance.postMessage.mock.calls[0][0]; }
function result(sources: TextComparisonInput): TextComparisonResult {
  return { ...compareDocumentBlocks(sources.before.blocks, sources.after.blocks), beforeKey: sources.before.sourceKey, afterKey: sources.after.sourceKey };
}
function respond(instance: ReturnType<typeof worker>, value: unknown = processTextComparisonRequest(request(instance))) {
  instance.onmessage!({ data: value } as MessageEvent<unknown>);
}

describe('packaged local text comparison boundary', () => {
  it('returns the same bounded redlines with exact source identities, then terminates', async () => {
    const instance = worker(), sources = input();
    const pending = compareDocumentText(sources, { createWorker: () => instance });
    let completed = false; void pending.then(() => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false);
    expect(instance.postMessage).toHaveBeenCalledOnce();
    respond(instance);
    expect(await pending).toEqual(result(sources));
    expect(instance.terminate).toHaveBeenCalledOnce();
    expect(instance.onmessage).toBeNull(); expect(instance.onerror).toBeNull(); expect(instance.onmessageerror).toBeNull();
  });

  it('snapshots keys and blocks so caller mutations cannot rebind an in-flight pair', async () => {
    const sources = input(), original = structuredClone(sources), instance = worker();
    const pending = compareDocumentText(sources, { createWorker: () => instance });
    sources.before.sourceKey = 'changed'; sources.after.blocks[0].page = 9; sources.after.blocks[0].text = 'Replacement content';
    respond(instance);
    expect(await pending).toEqual(result(original));
  });

  it('rejects invalid input and deadlines before allocating a worker', async () => {
    const createWorker = vi.fn(() => worker());
    for (const bad of [
      { ...input(), before: { ...input().before, sourceKey: '' } },
      { ...input(), after: { ...input().after, sourceKey: 'x'.repeat(TEXT_COMPARISON_LIMITS.sourceKey + 1) } },
      { ...input(), before: { ...input().before, blocks: Array.from({ length: TEXT_COMPARISON_LIMITS.blocks + 1 }, (_, i) => ({ id: `b${i}`, page: 1, text: '' })) } },
      { ...input(), after: { ...input().after, blocks: [{ id: 'b', page: 1, text: 'x'.repeat(TEXT_COMPARISON_LIMITS.characters + 1) }] } },
      { ...input(), before: { ...input().before, blocks: [{ id: 'b', page: 1, text: 'first' }, { id: 'b', page: 2, text: 'duplicate identity' }] } },
      { ...input(), after: { ...input().after, blocks: [{ id: 'b', page: 301, text: 'outside extracted pages' }] } },
    ]) await expect(compareDocumentText(bad, { createWorker })).rejects.toBeInstanceOf(Error);
    for (const timeoutMs of [0, -1, Infinity, TEXT_COMPARISON_LIMITS.maxTimeoutMs + 1]) await expect(compareDocumentText(input(), { createWorker, timeoutMs })).rejects.toThrow('deadline');
    const controller = new AbortController(); controller.abort();
    await expect(compareDocumentText(input(), { createWorker, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('terminates cancellation, removes timers, and ignores late results', async () => {
    vi.useFakeTimers();
    const instance = worker(), controller = new AbortController();
    const pending = compareDocumentText(input(), { createWorker: () => instance, signal: controller.signal });
    const handler = instance.onmessage!, sent = request(instance);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    handler({ data: processTextComparisonRequest(sent) } as MessageEvent<unknown>);
    expect(instance.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send documents if the request is cancelled while starting its worker', async () => {
    const instance = worker(), controller = new AbortController();
    await expect(compareDocumentText(input(), { signal: controller.signal, createWorker: () => { controller.abort(); return instance; } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(instance.postMessage).not.toHaveBeenCalled(); expect(instance.terminate).toHaveBeenCalledOnce();
  });

  it('rejects falsy abort reasons instead of resolving an undefined comparison', async () => {
    for (const reason of [false, 0, '']) {
      const instance = worker(), controller = new AbortController();
      const pending = compareDocumentText(input(), { signal: controller.signal, createWorker: () => instance });
      const rejected = expect(pending).rejects.toBe(reason);
      controller.abort(reason); await rejected;
      expect(instance.terminate).toHaveBeenCalledOnce();
    }
  });

  it('expires a stalled worker without creating an empty successful result', async () => {
    vi.useFakeTimers();
    const instance = worker(), pending = compareDocumentText(input(), { createWorker: () => instance, timeoutMs: 25 });
    const rejected = expect(pending).rejects.toThrow('No complete text result is available');
    await vi.advanceTimersByTimeAsync(25); await rejected;
    expect(instance.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects another request or source edition even if all text happens to match', async () => {
    for (const patch of [
      (sent: TextComparisonWorkerRequest) => ({ type: 'document-text-result', requestId: 'stale-request', result: result(sent.input) }),
      (sent: TextComparisonWorkerRequest) => ({ type: 'document-text-result', requestId: sent.requestId, result: { ...result(sent.input), beforeKey: sent.input.after.sourceKey } }),
      (sent: TextComparisonWorkerRequest) => ({ type: 'document-text-result', requestId: sent.requestId, result: { ...result(sent.input), afterKey: sent.input.after.sourceKey.replace('blob:current', 'blob:other-session') } }),
    ]) {
      const instance = worker(), pending = compareDocumentText(input(), { createWorker: () => instance });
      respond(instance, patch(request(instance)));
      await expect(pending).rejects.toBeInstanceOf(Error); expect(instance.terminate).toHaveBeenCalledOnce();
    }
  });

  it('fails explicitly when the worker is unavailable; never computes on the caller thread', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(compareDocumentText(input())).rejects.toThrow('could not start the local text comparison worker');
    await expect(compareDocumentText(input(), { createWorker: () => { throw new Error('private source detail'); } })).rejects.toThrow('Check the viewer package');
  });

  it('cleans up worker errors, malformed replies, failed transfer, and unreadable messages without echoing private details', async () => {
    for (const mode of ['error', 'messageerror', 'failure', 'bad-type', 'private-error'] as const) {
      const instance = worker(), pending = compareDocumentText(input(), { createWorker: () => instance });
      if (mode === 'error') instance.onerror!({ message: 'secret source text', preventDefault() {} } as ErrorEvent);
      else if (mode === 'messageerror') instance.onmessageerror!();
      else respond(instance, { requestId: request(instance).requestId, type: mode === 'bad-type' ? 'other' : 'document-text-error', code: 'comparison-failed', ...(mode === 'private-error' ? { message: 'secret source text' } : {}) });
      await expect(pending).rejects.not.toThrow('secret source text'); expect(instance.terminate).toHaveBeenCalledOnce();
    }
    const instance = worker(() => { throw new Error('private text'); });
    await expect(compareDocumentText(input(), { createWorker: () => instance })).rejects.toThrow('could not send');
    expect(instance.terminate).toHaveBeenCalledOnce();
  });

  it('keeps concurrent source pairs distinct when results arrive out of order', async () => {
    const first = worker(), second = worker(), next = input(); next.after.sourceKey = 'another-edition';
    const firstPending = compareDocumentText(input(), { createWorker: () => first });
    const secondPending = compareDocumentText(next, { createWorker: () => second });
    expect(request(first).requestId).not.toBe(request(second).requestId);
    respond(second); respond(first);
    expect((await firstPending).afterKey).toBe(input().after.sourceKey); expect((await secondPending).afterKey).toBe(next.after.sourceKey);
  });
});

describe('text comparison protocol and result accounting', () => {
  it('validates again within the worker and reports only fixed failure codes', () => {
    expect(processTextComparisonRequest({ type: 'compare-document-text', requestId: 'r', input: { ...input(), after: { sourceKey: 'secret name', blocks: [{ id: 'b', page: -1, text: 'private text' }] } } })).toEqual({ type: 'document-text-error', requestId: 'r', code: 'invalid-input' });
    expect(processTextComparisonRequest({ type: 'other', requestId: 'r', input: input() })).toEqual({ type: 'document-text-error', requestId: 'r', code: 'invalid-input' });
    expect(processTextComparisonRequest({ requestId: 'x'.repeat(101) })).toBeNull();
  });

  it('accepts successful empty sources and exact repeated text while preserving page anchors', () => {
    const sources = input(); sources.before.blocks = []; sources.after.blocks = [];
    expect(validateTextComparisonResult(result(sources), normalizeTextComparisonInput(sources))).toMatchObject({ changes: [], truncated: false, stats: { unchanged: 0 } });
    sources.before.blocks = [{ id: 'a', page: 1, text: 'same' }, { id: 'b', page: 2, text: 'same' }];
    sources.after.blocks = [{ id: 'c', page: 2, text: 'same' }, { id: 'd', page: 3, text: 'added material' }, { id: 'e', page: 4, text: 'same' }];
    expect(validateTextComparisonResult(result(sources), sources)).toMatchObject({ stats: { added: 1, unchanged: 2 }, changes: [{ after: { id: 'd', page: 3 } }] });
  });

  it('preserves normalization, input limits and coarse comparison coverage', () => {
    for (const sources of [
      { before: { sourceKey: 'before', blocks: [{ id: 'blank', page: 1, text: '\n ' }, { id: 'text', page: 1, text: '  Torque\n 8 Nm. ' }] }, after: { sourceKey: 'after', blocks: [{ id: 'text', page: 2, text: 'Torque 10 Nm.' }] } },
      { before: { sourceKey: 'before', blocks: [{ id: 'long', page: 1, text: 'a'.repeat(DOCUMENT_COMPARISON_LIMITS.charactersPerBlock + 1) }] }, after: { sourceKey: 'after', blocks: [] } },
      { before: { sourceKey: 'before', blocks: Array.from({ length: DOCUMENT_COMPARISON_LIMITS.blocks + 1 }, (_, i) => ({ id: `b${i}`, page: 1, text: `Before ${i}` })) }, after: { sourceKey: 'after', blocks: Array.from({ length: DOCUMENT_COMPARISON_LIMITS.blocks + 1 }, (_, i) => ({ id: `a${i}`, page: 1, text: `After ${i}` })) } },
    ]) expect(validateTextComparisonResult(result(sources), normalizeTextComparisonInput(sources))).toEqual(result(sources));
  });

  it('rejects false zero, incorrect counts, source anchors, missing runs, and hidden truncation', () => {
    const sources = input();
    const good = result(sources);
    const invalid = [
      { ...good, changes: [], stats: { added: 0, removed: 0, modified: 0, unchanged: 2 } },
      { ...good, stats: { ...good.stats, modified: 0 } },
      { ...good, changes: [{ ...good.changes[0], before: { ...good.changes[0].before!, page: 9 } }] },
      { ...good, changes: [{ ...good.changes[0], after: { ...good.changes[0].after!, id: 'another-block' } }] },
      { ...good, changes: [{ ...good.changes[0], runs: [] }] },
      { ...good, changes: [{ ...good.changes[0], runs: [{ kind: 'equal', text: 'fabricated redline' }] }] },
      { ...good, changes: [good.changes[0], good.changes[0]] },
      { ...good, changes: [{ ...good.changes[0], runs: [{ kind: 'equal', text: 'x'.repeat(DOCUMENT_COMPARISON_LIMITS.charactersPerBlock + 1) }] }] },
    ];
    for (const bad of invalid) expect(() => validateTextComparisonResult(bad, sources)).toThrow('does not match');
    sources.before.blocks = [{ id: 'long', page: 1, text: 'x'.repeat(DOCUMENT_COMPARISON_LIMITS.charactersPerBlock + 1) }];
    sources.after.blocks = [];
    expect(() => validateTextComparisonResult({ ...result(sources), truncated: false }, sources)).toThrow('does not match');
  });
});
