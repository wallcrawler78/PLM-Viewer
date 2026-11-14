import { describe, expect, it, vi } from 'vitest';
import { documentCssSelector, documentCssValue, documentImageSource, documentLink, namespaceWordFonts, normalizedDocumentImage, PDF_RASTER_LIMITS, pdfRasterSize, renderPdfLayers, validateWordSymbols, wordFontKey } from '../src/document-rendering';

describe('links embedded in Word attachments', () => {
  it('rejects executable, local-file, relative and browser-normalized targets', () => {
    for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', '\u0000javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'blob:https://viewer.example/secret', '/api/viewer/v1/auth/login', '../other-source', '//outside.example', 'https:\\outside.example', 'https:outside.example', 'https://user:password@example.com', null]) {
      expect(documentLink(value), String(value)).toEqual({ kind: 'blocked' });
    }
  });

  it('preserves explicit web and contact links after URL normalization', () => {
    expect(documentLink(' https://EXAMPLE.com/spec?q=part%201#section ')).toEqual({ kind: 'external', href: 'https://example.com/spec?q=part%201#section' });
    expect(documentLink('http://example.com/spec')).toEqual({ kind: 'external', href: 'http://example.com/spec' });
    expect(documentLink('mailto:review@example.com')).toEqual({ kind: 'external', href: 'mailto:review@example.com' });
    expect(documentLink('tel:+15551234567')).toEqual({ kind: 'external', href: 'tel:+15551234567' });
  });

  it('keeps local bookmark identity without treating it as an external URL', () => {
    expect(documentLink('#Requirements%20Table')).toEqual({ kind: 'bookmark', bookmark: 'Requirements Table', href: '#Requirements%20Table' });
    expect(documentLink('#_Toc123')).toEqual({ kind: 'bookmark', bookmark: '_Toc123', href: '#_Toc123' });
    for (const value of ['#', '#bad%escape', '#%00hidden', '#'+ 'x'.repeat(2049)]) expect(documentLink(value)).toEqual({ kind: 'blocked' });
  });
});

describe('Word markup boundaries', () => {
  it('checks symbol codes in the body, headers, footers and notes before rendering', () => {
    const symbol = { type: 'symbol', char: 'F0FC' };
    const doc = { parts: [{ body: { children: [{ children: [symbol] }] } }, { rootElement: { children: [{ type: 'symbol', char: '1F600' }] } }, { notes: [{ children: [{ type: 'symbol', char: '0041' }] }] }] };
    expect(() => validateWordSymbols(doc)).not.toThrow();
    for (const char of ['0;<img src=x onerror=alert(1)>', '110000', '', undefined]) {
      symbol.char = char as string;
      expect(() => validateWordSymbols(doc)).toThrow('Unsupported Word symbol encoding');
    }
    expect(() => validateWordSymbols({ parts: [{ rootElement: { children: [{ type: 'symbol', char: '<svg>' }] } }] })).toThrow();
    expect(() => validateWordSymbols({ parts: [{ notes: [{ children: [{ type: 'symbol', char: '<img>' }] }] }] })).toThrow();
  });

  it('bounds render-tree scanning and tolerates parser parent references', () => {
    const node: { type: string; children: unknown[] } = { type: 'paragraph', children: [] };
    node.children.push(node);
    expect(() => validateWordSymbols({ parts: [{ body: node }] })).not.toThrow();
    expect(() => validateWordSymbols({})).toThrow('Unsupported Word document structure');
  });

  it('keeps attachment CSS scoped and rejects selectors that could affect viewer controls', () => {
    for (const selector of ['.docx-source-r1', 'section.docx-source-r1 p', '.docx-source-r1_Table>tbody>tr', '.docx-source-r1-wrapper, section.docx-source-r1']) expect(documentCssSelector(selector, 'docx-source-r1')).toBe(true);
    for (const selector of ['body', '.docx-source-r1, body', 'body:has(.docx-source-r1)', '.docx-source-r1 ~ .app-shell', ':is(.docx-source-r1,body)', '.docx-source-r2 p']) expect(documentCssSelector(selector, 'docx-source-r1')).toBe(false);
  });

  it('permits embedded assets and normal formatting while blocking remote or escaped CSS loads', () => {
    for (const value of ['14pt', 'rgb(30, 40, 50)', '"Calibri", sans-serif', 'url(data:image/png;base64,YWJjZA==)', 'url("data:font/woff2;base64,YWJjZA==")', 'url(#localFill)', 'counter(docx-source-num, decimal) ".\\9"', '"\\2022\\9"']) expect(documentCssValue(value), value).toBe(true);
    for (const value of ['url(https://outside.example/track)', 'url("//outside.example/track")', 'u\\72l(https://outside.example/track)', 'image-set("https://outside.example/track")', '"Font"; } body { display:none', 'expression(alert(1))', 'url(data:text/html;base64,YWJjZA==)']) expect(documentCssValue(value), value).toBe(false);
  });

  it('keeps image delivery within embedded attachment resources', () => {
    expect(documentImageSource('data:image/png;base64,YWJjZA==')).toBe(true);
    expect(documentImageSource('data:image/svg+xml;base64,YWJjZA==')).toBe(true);
    expect(documentImageSource('#drawing1')).toBe(true);
    for (const value of ['https://outside.example/track.png', '/api/viewer/v1/content', 'javascript:alert(1)', 'data:text/html;base64,YWJjZA==', 'undefined']) expect(documentImageSource(value)).toBe(false);
  });

  it('recovers PNG, JPEG and SVG images from the generic blobs emitted by JSZip', () => {
    for (const [head, mime] of [['\x89PNG\r\n\x1a\nrest', 'image/png'], ['\xff\xd8\xffrest', 'image/jpeg'], ['GIF89arest', 'image/gif'], ['RIFF1234WEBPrest', 'image/webp'], ['<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml']]) {
      const encoded = btoa(head);
      expect(normalizedDocumentImage(`data:application/octet-stream;base64,${encoded}`)).toBe(`data:${mime};base64,${encoded}`);
    }
    expect(normalizedDocumentImage(`data:application/octet-stream;base64,${btoa('<html>not an image</html>')}`)).toBeNull();
    expect(normalizedDocumentImage('data:application/octet-stream;base64,!!!')).toBeNull();
  });

  it('namespaces embedded font definitions and references independently for each source', () => {
    const left = new Map([['dm sans', 'docx-left-font-0'], ['family, with comma', 'docx-left-font-1']]);
    const right = new Map([['dm sans', 'docx-right-font-0']]);
    expect(wordFontKey('"DM\\20 Sans"')).toBe('dm sans');
    expect(namespaceWordFonts('"DM Sans", Arial, sans-serif', left)).toBe('"docx-left-font-0", Arial, sans-serif');
    expect(namespaceWordFonts('"DM Sans", Arial, sans-serif', right)).toBe('"docx-right-font-0", Arial, sans-serif');
    expect(namespaceWordFonts('"Family, with comma", "DM Sans"', left)).toBe('"docx-left-font-1", "docx-left-font-0"');
    expect(namespaceWordFonts('var(--docx-majorHAnsi-font, serif), "DM Sans"', left)).toBe('var(--docx-majorHAnsi-font, serif), "docx-left-font-0"');
    expect(namespaceWordFonts('DM Sans', left)).toBe('"docx-left-font-0"');
  });
});

describe('bounded PDF raster memory', () => {
  it('preserves ordinary display resolution without changing CSS page coordinates', () => {
    expect(pdfRasterSize(600, 800, 2)).toEqual({ width: 1200, height: 1600, ratio: 2 });
    expect(pdfRasterSize(600, 800, 1)).toEqual({ width: 600, height: 800, ratio: 1 });
  });

  it('caps memory for high-DPI maximum zoom and very tall engineering sheets', () => {
    for (const [width, height, dpr] of [[2250, 3182, 2], [900, 90_000, 3], [90_000, 900, 2], [100_000, 100_000, 2]]) {
      const raster = pdfRasterSize(width, height, dpr);
      expect(raster.width * raster.height).toBeLessThanOrEqual(PDF_RASTER_LIMITS.pixels);
      expect(Math.max(raster.width, raster.height)).toBeLessThanOrEqual(PDF_RASTER_LIMITS.edge);
      expect(raster.ratio).toBeGreaterThan(0);
      expect(Math.abs(raster.width - width * raster.ratio)).toBeLessThan(1);
      expect(Math.abs(raster.height - height * raster.ratio)).toBeLessThan(1);
    }
  });

  it('rejects invalid page dimensions before allocating a backing store', () => {
    for (const value of [0, -1, Infinity, NaN, 100_001]) expect(() => pdfRasterSize(value, 800, 2)).toThrow('Unsupported PDF page dimensions');
    expect(pdfRasterSize(600, 800, NaN).ratio).toBe(1);
  });
});

describe('PDF visual rendering when text is unavailable', () => {
  it('retains a successfully drawn page when text extraction or its selectable layer fails', async () => {
    const image = vi.fn(async () => undefined);
    const text = vi.fn(async () => { throw new Error('Broken PDF character map'); });
    expect(await renderPdfLayers(image, text, () => false)).toBe('image-only');
    expect(image).toHaveBeenCalledOnce(); expect(text).toHaveBeenCalledOnce();
  });

  it('does not hide an actual raster failure behind the text fallback', async () => {
    const text = vi.fn(async () => undefined);
    await expect(renderPdfLayers(async () => { throw new Error('Raster failed'); }, text, () => false)).rejects.toThrow('Raster failed');
    expect(text).not.toHaveBeenCalled();
  });

  it('does not publish stale text or a ready page after source cancellation', async () => {
    let cancelled = false;
    const text = vi.fn(async () => undefined);
    expect(await renderPdfLayers(async () => { cancelled = true; }, text, () => cancelled)).toBe('cancelled');
    expect(text).not.toHaveBeenCalled();
    cancelled = false;
    expect(await renderPdfLayers(async () => undefined, async () => { cancelled = true; throw new Error('Cancelled layer'); }, () => cancelled)).toBe('cancelled');
  });
});
