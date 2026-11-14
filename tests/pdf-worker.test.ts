import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalPdfWorker, localPdfWorkerUrl } from '../src/pdf-worker';

const adapter = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ PDFWorker: { create: adapter.create } }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min-local.mjs' }));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  adapter.create.mockReset(); adapter.destroy.mockReset();
  adapter.create.mockReturnValue({ destroy: adapter.destroy });
});

describe('one explicit packaged PDF worker path', () => {
  function workers() {
    const ports: { terminate: ReturnType<typeof vi.fn>; url: URL; options: WorkerOptions }[] = [];
    vi.stubGlobal('Worker', class {
      terminate = vi.fn();
      constructor(public url: URL, public options: WorkerOptions) { ports.push(this); }
    });
    return ports;
  }

  it.each(['https://viewer.example/review/', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/viewer.html'])('uses an actual local module worker for %s', page => {
    const ports = workers();
    const owner = createLocalPdfWorker(page);
    expect(ports).toHaveLength(1);
    expect(ports[0].url.href).toBe(new URL('/assets/pdf.worker.min-local.mjs', page).href);
    expect(ports[0].options.type).toBe('module');
    expect(adapter.create).toHaveBeenCalledWith({ port: ports[0], verbosity: 0 });
    expect(owner.worker).toEqual({ destroy: adapter.destroy });
    owner.dispose(); owner.dispose();
    expect(adapter.destroy).toHaveBeenCalledTimes(1);
    expect(ports[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects an external executable, blob wrapper, different extension and unsupported page scheme', () => {
    const page = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/viewer.html';
    for (const path of ['https://cdn.example/pdf.mjs', 'blob:null/worker', 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/assets/pdf.mjs']) {
      expect(() => localPdfWorkerUrl(page, path)).toThrow('packaged with the viewer');
    }
    expect(() => localPdfWorkerUrl('file:///tmp/viewer.html')).toThrow('packaged with the viewer');
  });

  it('terminates the native worker when PDF.js setup fails', () => {
    const ports = workers();
    adapter.create.mockImplementation(() => { throw new Error('setup failed'); });
    expect(() => createLocalPdfWorker('https://viewer.example/')).toThrow('setup failed');
    expect(ports[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates exactly once even if the PDF.js adapter fails while closing', () => {
    const ports = workers();
    const owner = createLocalPdfWorker('https://viewer.example/');
    adapter.destroy.mockImplementation(() => { throw new Error('adapter already closed'); });
    expect(() => owner.dispose()).toThrow('adapter already closed');
    owner.dispose();
    expect(ports[0].terminate).toHaveBeenCalledTimes(1);
  });
});
