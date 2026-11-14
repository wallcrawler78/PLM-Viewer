import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { compareDocumentBlocks } from '../src/document-review';
import { boundedDocumentTask, documentComparisonCoverage, documentExtraction, extractionCoverageMessage, failedDocumentExtraction, localPdfAssetUrls, readDocumentBytes, readDocumentSource, verifyDocumentSource } from '../src/document-extraction';
import { validateWordPackage, WORD_PACKAGE_LIMITS } from '../src/document-package';
import { validateWordSymbols } from '../src/document-rendering';

describe('document extraction coverage', () => {
  const text = [{ id: 'p1-b1', page: 1, text: 'Installation width shall be 140 mm.' }];
  const blank = documentExtraction([], [{ page: 1, status: 'empty' }], 1);
  const populated = documentExtraction(text, [{ page: 1, status: 'text' }], 1);

  it('permits all-added and all-removed revisions when the other source is genuinely blank', () => {
    expect(documentComparisonCoverage(blank, populated)).toEqual({ pending: false, unavailable: false, partial: false, canCompare: true });
    expect(compareDocumentBlocks(blank.blocks, populated.blocks).stats.added).toBe(1);
    expect(documentComparisonCoverage(populated, blank).canCompare).toBe(true);
    expect(compareDocumentBlocks(populated.blocks, blank.blocks).stats.removed).toBe(1);
    expect(documentComparisonCoverage(blank, blank).canCompare).toBe(true);
  });

  it('never treats scanned, failed or unfinished extraction as an empty revision', () => {
    const scanned = documentExtraction([], [{ page: 1, status: 'non-text' }], 1);
    for (const unavailable of [scanned, failedDocumentExtraction()]) {
      expect(documentComparisonCoverage(unavailable, populated)).toMatchObject({ unavailable: true, canCompare: false });
      expect(documentComparisonCoverage(populated, unavailable).canCompare).toBe(false);
    }
    expect(documentComparisonCoverage(null, populated)).toMatchObject({ pending: true, canCompare: false });
  });

  it('keeps useful extracted text while disclosing missing pages and extraction limits', () => {
    const partial = documentExtraction(text, [{ page: 1, status: 'text' }, { page: 2, status: 'non-text' }, { page: 3, status: 'failed' }, { page: 4, status: 'limited' }], 6, true);
    expect(documentComparisonCoverage(partial, populated)).toMatchObject({ canCompare: true, partial: true });
    const message = extractionCoverageMessage(partial);
    expect(message).toContain('No extractable text on page 2');
    expect(message).toContain('could not be read on page 3');
    expect(message).toContain('limit on page 4');
    expect(message).toContain('Pages 5–6 were not included');
    expect(extractionCoverageMessage(blank)).toBe('');
  });
});

describe('packaged PDF resources', () => {
  it('resolves all auxiliary assets inside hosted and extension package origins', () => {
    expect(localPdfAssetUrls('/', 'https://viewer.example/?mode=preview')).toEqual({
      cMapUrl: 'https://viewer.example/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: 'https://viewer.example/vendor/pdfjs/standard_fonts/', wasmUrl: 'https://viewer.example/vendor/pdfjs/wasm/',
    });
    expect(localPdfAssetUrls('./', 'chrome-extension://abcdefghijkl/index.html?mode=preview').cMapUrl).toBe('chrome-extension://abcdefghijkl/vendor/pdfjs/cmaps/');
    expect(() => localPdfAssetUrls('https://cdn.example/', 'https://viewer.example/')).toThrow('packaged');
  });

  it('extracts Japanese text using local resources from the installed PDF.js package', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const content = 'BT /F1 24 Tf 72 720 Td <65E5672C8A9E> Tj ET';
    const bodies = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>',
      '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>',
      '<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [-123 -257 1001 910] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 737 /StemV 80 >>',
    ];
    let source = '%PDF-1.7\n';
    const offsets = [0];
    bodies.forEach((body, index) => { offsets.push(source.length); source += `${index + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = source.length;
    source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const root = resolve('node_modules/pdfjs-dist');
    const task = getDocument({ data: new TextEncoder().encode(source), isEvalSupported: false, cMapUrl: `${root}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${root}/standard_fonts/`, wasmUrl: `${root}/wasm/`, useWorkerFetch: false, verbosity: 0 });
    try {
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const text = await page.getTextContent();
      expect(text.items.filter(item => 'str' in item).map(item => item.str).join('')).toBe('日本語');
    } finally { await task.destroy(); }
  }, 15_000);
});

describe('bounded document sources', () => {
  it('bounds actual streamed bytes even if Content-Length is absent or false', async () => {
    await expect(readDocumentBytes(new Response(new Uint8Array(9), { headers: { 'content-length': '1' } }), new AbortController().signal, 8)).rejects.toThrow('source limit');
    expect(new Uint8Array(await readDocumentBytes(new Response(new Uint8Array([1, 2, 3])), new AbortController().signal, 8))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('cancels source reading and bounds unfinished asynchronous processing', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const pending = readDocumentBytes(response, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
    await expect(boundedDocumentTask(new Promise(() => {}), new AbortController().signal, 5)).rejects.toThrow('time limit');
  });

  it('aborts a request that never returns headers and releases a response arriving after timeout', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      let cancelled = false;
      let deliver!: (response: Response) => void;
      const pending = readDocumentSource(signal => {
        signals.push(signal);
        return new Promise(resolve => { deliver = resolve; });
      }, new AbortController().signal, { timeoutMs: 100 });
      const rejected = expect(pending).rejects.toThrow('loading time limit');
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(signals[0].aborted).toBe(true);
      deliver(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('shares one acquisition deadline between delayed headers and a stalled response body', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      let cancelled = false, settled = false;
      const pending = readDocumentSource(signal => {
        signals.push(signal);
        return new Promise(resolve => setTimeout(() => resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }))), 60));
      }, new AbortController().signal, { timeoutMs: 100 }).finally(() => { settled = true; });
      const rejected = expect(pending).rejects.toThrow('loading time limit');
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(cancelled).toBe(true);
      expect(signals[0].aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('propagates source-change cancellation before headers and prevents transport start when already cancelled', async () => {
    const controller = new AbortController(), signals: AbortSignal[] = [];
    const pending = readDocumentSource(signal => {
      signals.push(signal);
      return new Promise(() => {});
    }, controller.signal);
    const rejected = expect(pending).rejects.toThrow('Source changed');
    controller.abort(new Error('Source changed'));
    await rejected;
    expect(signals[0].reason).toBe(controller.signal.reason);
    let started = false;
    await expect(readDocumentSource(async () => { started = true; return new Response(); }, controller.signal)).rejects.toThrow('Source changed');
    expect(started).toBe(false);
  });

  it('returns successful source bytes and releases error response bodies without losing their status', async () => {
    const controller = new AbortController();
    expect(new Uint8Array(await readDocumentSource(async () => new Response(new Uint8Array([4, 5, 6])), controller.signal))).toEqual(new Uint8Array([4, 5, 6]));
    let cancelled = false;
    await expect(readDocumentSource(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }), controller.signal)).rejects.toThrow('Document unavailable (403)');
    expect(cancelled).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });
});

async function wordZip(compression: 'STORE' | 'DEFLATE' = 'DEFLATE') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Requirement</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'arraybuffer', compression });
}

describe('Word ZIP validation before rendering', () => {
  it('accepts the actual fixture Word files and supported ZIP compression methods', async () => {
    for (const name of ['atlas-spec-A.docx', 'atlas-spec-B.docx']) {
      const bytes = await readFile(resolve('public/fixtures/documents', name));
      await expect(validateWordPackage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), new AbortController().signal)).resolves.toBeUndefined();
    }
    for (const method of ['STORE', 'DEFLATE'] as const) await expect(validateWordPackage(await wordZip(method), new AbortController().signal)).resolves.toBeUndefined();
  });

  it('rejects a declared expansion bomb before inflation', async () => {
    const data = await wordZip();
    const view = new DataView(data), bytes = new Uint8Array(data);
    for (let cursor = 0; cursor < bytes.length - 46; cursor++) if (view.getUint32(cursor, true) === 0x02014b50) {
      view.setUint32(cursor + 24, WORD_PACKAGE_LIMITS.entryBytes + 1, true); break;
    }
    await expect(validateWordPackage(data, new AbortController().signal)).rejects.toThrow('expanded-content limit');
  });

  it('checks actual inflation, so lying about the expanded size does not bypass limits', async () => {
    const data = await wordZip();
    const view = new DataView(data), bytes = new Uint8Array(data);
    for (let cursor = 0; cursor < bytes.length - 46; cursor++) if (view.getUint32(cursor, true) === 0x02014b50 && view.getUint32(cursor + 24, true) > 0) {
      view.setUint32(cursor + 24, 1, true); break;
    }
    await expect(validateWordPackage(data, new AbortController().signal)).rejects.toThrow('declared expanded-content');
  });

  it('rejects corrupt checksums, unsupported containers and cancelled work', async () => {
    const data = await wordZip();
    const view = new DataView(data), bytes = new Uint8Array(data);
    for (let cursor = 0; cursor < bytes.length - 46; cursor++) if (view.getUint32(cursor, true) === 0x02014b50) { view.setUint32(cursor + 16, 0, true); break; }
    await expect(validateWordPackage(data, new AbortController().signal)).rejects.toThrow('unsupported ZIP');
    await expect(validateWordPackage(new ArrayBuffer(100), new AbortController().signal)).rejects.toThrow('unsupported ZIP');
    const controller = new AbortController(); controller.abort();
    await expect(validateWordPackage(await wordZip(), controller.signal)).rejects.toThrow();
  });

  it('reports native revision/comment features without changing the symbol boundary', () => {
    const features = validateWordSymbols({ parts: [{ body: { children: [{ type: 'inserted' }, { type: 'deleted' }, { type: 'commentRangeStart' }, { type: 'altChunk' }] } }] });
    expect(features).toEqual({ trackedChanges: true, comments: true, altChunks: true });
    expect(validateWordSymbols({ parts: [{ body: { children: [] } }] })).toEqual({ trackedChanges: false, comments: false, altChunks: false });
  });
});

describe('document source verification', () => {
  it('opens only bytes that match the declared edition hash', async () => {
    const manifest = JSON.parse(await readFile(resolve('public/fixtures/manifest.json'), 'utf8'));
    const declared: { url: string; sourceHash: string }[] = [];
    const collect = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') {
        const row = value as Record<string, unknown>;
        if (typeof row.url === 'string' && typeof row.sourceHash === 'string' && row.url.startsWith('/fixtures/documents/')) declared.push({ url: row.url, sourceHash: row.sourceHash });
        Object.values(row).forEach(collect);
      }
    };
    collect(manifest);
    expect(declared.length).toBeGreaterThan(1);
    const bytes = async (url: string) => { const file = await readFile(resolve('public', url.slice(1))); return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer; };
    const [first, other] = [declared[0], declared.find(file => file.sourceHash !== declared[0].sourceHash)!];
    await expect(verifyDocumentSource(await bytes(first.url), first.sourceHash)).resolves.toBeUndefined();
    // Another edition served at the same location must not render under this identity.
    await expect(verifyDocumentSource(await bytes(other.url), first.sourceHash)).rejects.toThrow('do not match this source edition');
    for (const missing of [undefined, '', 'different-source', first.sourceHash.toUpperCase()]) {
      await expect(verifyDocumentSource(await bytes(first.url), missing), String(missing)).rejects.toThrow('cannot be verified');
    }
  });
});
