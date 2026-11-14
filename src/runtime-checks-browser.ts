import { version as viewerVersion, dependencies } from '../package.json';
import type { RenderTask } from 'pdfjs-dist';
import { runStepWorker } from './cad/step-client';
import { boundedDocumentTask, localPdfAssetUrls, readDocumentSource } from './document-extraction';
import { validateWordPackage } from './document-package';
import { sanitizeWordMarkup, validateWordSymbols } from './document-rendering';
import { matchesRuntimeFixtureText, packagedResourceUrl, RuntimeCheckIssue, verifyFixtureHash } from './runtime-checks';
import type { RuntimeCheckId, RuntimeEnvironment, RuntimeObservation } from './runtime-checks';

const FIXTURES = {
  step: { path: '/fixtures/step/base-B.step', id: 'base' },
  pdf: { path: '/fixtures/documents/atlas-spec-B.pdf', id: 'atlas-spec-B-pdf' },
  docx: { path: '/fixtures/documents/atlas-spec-B.docx', id: 'atlas-spec-B-docx' },
} as const;
type FixtureId = keyof typeof FIXTURES;
const sourceLimit = 4 * 1024 * 1024;

export function browserRuntimeEnvironment(): RuntimeEnvironment {
  const extension = location.protocol === 'chrome-extension:';
  let extensionVersion: string | null = null;
  if (extension) {
    try {
      const runtime = (globalThis as unknown as { chrome?: { runtime?: { getManifest(): { version?: string } } } }).chrome?.runtime;
      extensionVersion = runtime?.getManifest().version ?? null;
    } catch { /* The failed availability remains visible as a missing version. */ }
  }
  return {
    surface: extension ? 'chrome-extension' : 'hosted-preview', viewerVersion, extensionVersion,
    browserMajor: /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1] ?? null,
    packages: { pdf: dependencies['pdfjs-dist'], word: dependencies['docx-preview'], cad: dependencies['occt-import-js'], graphics: dependencies.three },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeCheckIssue('manifestInvalid');
  return value as Record<string, unknown>;
}

function readManifestEntries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new RuntimeCheckIssue('manifestInvalid');
  return value.map(object);
}

function validHashes(fixtureManifest: unknown): Record<FixtureId, string> {
  const manifest = object(fixtureManifest);
  if (manifest.synthetic !== true || manifest.units !== 'mm' || manifest.upAxis !== 'Z') throw new RuntimeCheckIssue('manifestInvalid');
  const parts = readManifestEntries(manifest.parts), docs = readManifestEntries(manifest.documents);
  const hashes = {} as Record<FixtureId, string>;
  for (const id of Object.keys(FIXTURES) as FixtureId[]) {
    const candidates = (id === 'step' ? parts : docs).filter(source => source.id === FIXTURES[id].id && source.revision === 'B');
    const source = candidates[0];
    if (candidates.length !== 1 || source[id === 'step' ? 'stepUrl' : 'url'] !== FIXTURES[id].path
      || typeof source.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceHash)) throw new RuntimeCheckIssue('manifestInvalid');
    hashes[id] = source.sourceHash;
  }
  return hashes;
}

function visiblePixelCount(canvas: HTMLCanvasElement): number {
  const context = canvas.getContext('2d');
  if (!context) throw new RuntimeCheckIssue('graphicsUnavailable', 'unavailable');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset + 3] > 0 && (pixels[offset] < 230 || pixels[offset + 1] < 230 || pixels[offset + 2] < 230)) count++;
  return count;
}

/** Count page text once, excluding the renderer's styles and embedded font data. */
function renderedWordText(pages: NodeListOf<Element>): string {
  return Array.from(pages, page => {
    const fragments: string[] = [];
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('style,script,noscript,template') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) fragments.push(walker.currentNode.textContent ?? '');
    return fragments.join('');
  }).join(' ').replace(/\s+/g, ' ').trim();
}

/** All URLs are fixed package paths. Neither a PLM identifier nor a user file enters here. */
export function createBrowserRuntimeChecks(environment: RuntimeEnvironment) {
  const pageUrl = location.href;
  const buffers = new Map<FixtureId, ArrayBuffer>();
  let hashes: Record<FixtureId, string> | undefined;

  async function readLocal(path: string, signal: AbortSignal, maxBytes = sourceLimit): Promise<ArrayBuffer> {
    try {
      return await readDocumentSource(owned => fetch(packagedResourceUrl(path, pageUrl), {
        signal: owned, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      }), signal, { maxBytes, timeoutMs: 12_000 });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof RuntimeCheckIssue) throw error;
      throw new RuntimeCheckIssue('sourceUnavailable');
    }
  }

  function takeFixture(id: FixtureId): { data: ArrayBuffer; hash: string } {
    const data = buffers.get(id);
    if (!hashes || !data) throw new RuntimeCheckIssue('missingDependency', 'unavailable');
    buffers.delete(id);
    return { data, hash: hashes[id] };
  }

  async function assets(signal: AbortSignal): Promise<RuntimeObservation> {
    buffers.clear(); hashes = undefined;
    try {
      const runtimeBytes = await readLocal('/vendor/runtime-assets.json', signal, 64 * 1024);
      const runtime = object(JSON.parse(new TextDecoder().decode(runtimeBytes)));
      if (runtime.formatVersion !== 1 || runtime.viewerVersion !== viewerVersion
        || (environment.surface === 'chrome-extension' && environment.extensionVersion !== viewerVersion)) throw new RuntimeCheckIssue('manifestInvalid');
      const assets = readManifestEntries(runtime.assets);
      for (const [name, directory] of [['pdfjs-dist', 'vendor/pdfjs'], ['occt-import-js', 'vendor/occt']] as const) {
        const candidates = assets.filter(asset => asset.package === name);
        if (candidates.length !== 1 || candidates[0].version !== dependencies[name] || candidates[0].directory !== directory) throw new RuntimeCheckIssue('manifestInvalid');
      }
      const fixtureBytes = await readLocal('/fixtures/manifest.json', signal, 512 * 1024);
      const validated = validHashes(JSON.parse(new TextDecoder().decode(fixtureBytes)));
      let sourceBytes = 0;
      for (const id of Object.keys(FIXTURES) as FixtureId[]) {
        const data = await readLocal(FIXTURES[id].path, signal);
        await verifyFixtureHash(data, validated[id]);
        signal.throwIfAborted();
        sourceBytes += data.byteLength;
        buffers.set(id, data);
      }
      hashes = validated;
      return { status: 'passed', code: 'assetsVerified', metrics: { sourceFiles: 3, sourceBytes } };
    } catch (error) {
      buffers.clear(); hashes = undefined;
      if (signal.aborted) throw signal.reason;
      if (error instanceof RuntimeCheckIssue) throw error;
      throw new RuntimeCheckIssue('manifestInvalid');
    }
  }

  async function step(signal: AbortSignal): Promise<RuntimeObservation> {
    const { data, hash } = takeFixture('step');
    const result = await runStepWorker(data, { signal, expectedHash: hash, timeoutMs: 44_000 });
    signal.throwIfAborted();
    const dimensions = result.bounds.max.map((max, axis) => max - result.bounds.min[axis]);
    if (result.units !== 'mm' || result.sourceHash !== hash || dimensions.some((size, axis) => !Number.isFinite(size) || Math.abs(size - [180, 136, 8][axis]) > .05)
      || result.positions.length % 3 || result.indices.length % 3 || !result.positions.every(Number.isFinite) || !result.normals.every(Number.isFinite)
      || !result.indices.every(index => index < result.positions.length / 3)) throw new RuntimeCheckIssue('unexpectedStep');
    return { status: 'passed', code: 'stepVerified', metrics: { vertices: result.positions.length / 3, triangles: result.indices.length / 3, widthMm: dimensions[0], depthMm: dimensions[1], heightMm: dimensions[2] } };
  }

  async function pdf(signal: AbortSignal): Promise<RuntimeObservation> {
    const { data } = takeFixture('pdf');
    const [{ getDocument, version }, { createLocalPdfWorker }] = await Promise.all([import('pdfjs-dist'), import('./pdf-worker')]);
    signal.throwIfAborted();
    if (version !== environment.packages.pdf) throw new RuntimeCheckIssue('manifestInvalid');
    // The normal reader and the qualification check exercise the same local worker path.
    const workerOwner = createLocalPdfWorker(pageUrl);
    let task: ReturnType<typeof getDocument> | undefined;
    let render: RenderTask | undefined;
    const canvas = document.createElement('canvas');
    const stop = () => {
      try { render?.cancel(); } catch { /* Already settled. */ }
      try { if (task) void task.destroy().catch(() => {}); } catch { /* Worker may already be gone. */ }
      try { workerOwner.dispose(); } catch { /* Native termination is guaranteed by the owner. */ }
      canvas.width = 0; canvas.height = 0;
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      task = getDocument({ data, worker: workerOwner.worker, isEvalSupported: false, verbosity: 0, ...localPdfAssetUrls(import.meta.env.BASE_URL, pageUrl) });
      const pdf = await boundedDocumentTask(task.promise, signal, 20_000);
      if (pdf.numPages !== 2) throw new RuntimeCheckIssue('unexpectedPdf');
      const first = await boundedDocumentTask(pdf.getPage(1), signal, 10_000);
      const text = await boundedDocumentTask(first.getTextContent(), signal, 10_000);
      const content = text.items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ');
      if (!matchesRuntimeFixtureText(content)) throw new RuntimeCheckIssue('unexpectedPdf');
      const viewport = first.getViewport({ scale: .65 });
      if (viewport.width * viewport.height > 1_000_000) throw new RuntimeCheckIssue('unexpectedPdf');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new RuntimeCheckIssue('graphicsUnavailable', 'unavailable');
      render = first.render({ canvasContext: context, viewport, background: '#ffffff' });
      await boundedDocumentTask(render.promise, signal, 10_000);
      const pixels = visiblePixelCount(canvas);
      if (pixels < 100) throw new RuntimeCheckIssue('unexpectedPdf');
      return { status: 'passed', code: 'pdfVerified', metrics: { pages: pdf.numPages, renderedPixels: pixels, textCharacters: content.length } };
    } finally { signal.removeEventListener('abort', stop); stop(); }
  }

  async function docx(signal: AbortSignal): Promise<RuntimeObservation> {
    const { data } = takeFixture('docx');
    await validateWordPackage(data, signal);
    const { parseAsync, renderDocument } = await import('docx-preview');
    signal.throwIfAborted();
    const className = 'runtime-check-word';
    const options = { inWrapper: true, ignoreWidth: false, ignoreHeight: false, className, breakPages: true, renderHeaders: true, renderFooters: true, renderAltChunks: false, renderChanges: false, renderComments: false, useBase64URL: true };
    const parsed = await boundedDocumentTask(parseAsync(data, options), signal, 15_000);
    validateWordSymbols(parsed);
    const stage = document.createElement('div');
    stage.className = 'runtime-check-word-stage';
    stage.setAttribute('aria-hidden', 'true'); stage.inert = true;
    const cleanup = () => { stage.remove(); stage.replaceChildren(); };
    signal.addEventListener('abort', cleanup, { once: true });
    try {
      const rendering = Promise.resolve(renderDocument(parsed, stage, undefined, options));
      // The library has no cancellation API. A late completion stays detached and is cleared.
      void rendering.then(() => { if (signal.aborted) cleanup(); }, () => cleanup());
      await boundedDocumentTask(rendering, signal, 15_000);
      signal.throwIfAborted();
      sanitizeWordMarkup(stage, className);
      document.body.append(stage);
      const pages = stage.querySelectorAll(`section.${className}`);
      const content = renderedWordText(pages);
      const count = stage.querySelectorAll('*').length;
      const firstPage = pages[0];
      if (!pages.length || pages.length > 10 || count > 10_000 || !matchesRuntimeFixtureText(content)
        || !firstPage || firstPage.getBoundingClientRect().width < 100
        || stage.querySelector('script,iframe,object,embed')) throw new RuntimeCheckIssue('unexpectedWord');
      return { status: 'passed', code: 'wordVerified', metrics: { pages: pages.length, wordElements: count, textCharacters: content.length } };
    } finally { signal.removeEventListener('abort', cleanup); cleanup(); }
  }

  async function graphics(signal: AbortSignal): Promise<RuntimeObservation> {
    const gpuCanvas = document.createElement('canvas');
    let webgl2 = false;
    try {
      const gl = gpuCanvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
      webgl2 = !!gl && !gl.isContextLost();
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* The software path is deliberately exercised below. */ }
    finally { gpuCanvas.width = 0; gpuCanvas.height = 0; }
    const [{ SoftwareRenderer }, { Scene, Color, BoxGeometry, MeshBasicMaterial, Mesh, PerspectiveCamera }] = await Promise.all([import('./components/model/SoftwareRenderer'), import('three')]);
    signal.throwIfAborted();
    let renderer: InstanceType<typeof SoftwareRenderer>;
    try { renderer = new SoftwareRenderer(); } catch { throw new RuntimeCheckIssue('graphicsUnavailable', 'unavailable'); }
    const geometry = new BoxGeometry(1, 1, 1), material = new MeshBasicMaterial({ color: '#18725d' });
    const scene = new Scene();
    try {
      scene.background = new Color('#ffffff'); scene.add(new Mesh(geometry, material));
      const camera = new PerspectiveCamera(45, 1, .1, 10); camera.position.set(2, 2, 3); camera.lookAt(0, 0, 0);
      renderer.setSize(96, 96); renderer.setViewport(0, 0, 96, 96); renderer.render(scene, camera);
      const pixels = visiblePixelCount(renderer.domElement);
      if (pixels < 50) throw new RuntimeCheckIssue('unexpectedGraphics');
      return { status: 'passed', code: webgl2 ? 'graphicsVerified' : 'softwareVerified', metrics: { webgl2, software: true, renderedPixels: pixels } };
    } finally { geometry.dispose(); material.dispose(); scene.clear(); renderer.dispose(); renderer.domElement.width = 0; renderer.domElement.height = 0; }
  }

  const operations: Record<RuntimeCheckId, (signal: AbortSignal) => Promise<RuntimeObservation>> = { assets, step, pdf, docx, graphics };
  return { operations, dispose() { buffers.clear(); hashes = undefined; } };
}
