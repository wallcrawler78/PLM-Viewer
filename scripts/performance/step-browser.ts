/// <reference types="vite/client" />
/** Development-only diagnostic entry. Never imported by the production app. */
import { ViewerEngine } from '../../src/components/model/engine';
import { openLocalFile, releaseLocalFiles } from '../../src/local-files';
import type { LocalReviewFile } from '../../src/local-files';
import type { ModelViewportProps, SceneBounds, ScenePart, ViewerStatus, ViewCommand } from '../../src/components/model/types';
import type { BufferGeometry, PerspectiveCamera, Scene } from 'three';

if (!import.meta.env.DEV) throw new Error('The STEP performance lab is available only in development.');

type RendererProbe = { domElement: HTMLCanvasElement; render(scene: Scene, camera: PerspectiveCamera): void };
type EngineProbe = { renderer: RendererProbe; geometryBytes: number; models: { mesh: { geometry: BufferGeometry }; }[] };
type Phase = { name: string; startMs: number; endMs?: number };
type RenderSample = { phase: string; modelReady: boolean; startMs: number; durationMs: number };
type MemorySnapshot = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } | null;
type CameraSample = { view: string; updateCpuMs: number; firstRenderWaitMs: number; firstRenderCpuMs: number };
type Report = {
  run: number; startedUtc: string; outcome: 'loading' | 'ready' | 'rejected' | 'cancelled' | 'closed';
  source: { name: string; bytes: number; sha256?: string }; quality: 'standard' | 'economy';
  environment: { userAgent: string; hardwareConcurrency: number; deviceMemoryGiBHint: number | null; devicePixelRatio: number; viewportCss: { width: number; height: number }; canvasPixels?: { width: number; height: number }; renderer?: string; };
  timings: { fileReadHashAndObjectUrlMs?: number; engineConstructionMs?: number; engineReadyFromLoadClickMs?: number; setPartsToReadyMs?: number; firstModelRenderCompletedFromLoadClickMs?: number; firstPostRenderAnimationFrameFromLoadClickMs?: number; rejectionFromLoadClickMs?: number; closedFromLoadClickMs?: number; };
  geometry?: { sceneMeshes: number; vertices: number; triangles: number; geometryAndEdgesBufferBytes: number; bounds: SceneBounds | null };
  status?: ViewerStatus; error?: string; phases: Phase[]; renders: RenderSample[]; droppedRenderSamples: number;
  longTaskSupport: boolean; longTasks: { startMs: number; durationMs: number }[]; droppedLongTasks: number;
  cameraRuns: { startedMs: number; completedMs?: number; error?: string; steps: CameraSample[] }[];
  memory: { before: MemorySnapshot; ready?: MemorySnapshot; latest?: MemorySnapshot; afterClose?: MemorySnapshot };
};
type Run = { report: Report; t0: number; controller: AbortController; file?: LocalReviewFile; engine?: ViewerEngine; props: ModelViewportProps; phase: string; ready: boolean; sequenceBusy: boolean; observer?: PerformanceObserver; renderWaiters: Set<(sample: RenderSample) => void>; firstFrameScheduled: boolean; };

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = el<HTMLInputElement>('source'), quality = el<HTMLSelectElement>('quality');
const viewport = el<HTMLDivElement>('viewport'), status = el<HTMLDivElement>('status');
const reportNode = el<HTMLPreElement>('report');
const history: Report[] = [];
let active: Run | undefined, ordinal = 0, nonce = 0;
const maxReports = 12, maxRenders = 512, maxLongTasks = 256, maxCameraRuns = 8;

const rounded = (value: number) => Math.round(value * 100) / 100;
const elapsed = (run: Run) => rounded(performance.now() - run.t0);
function memory(): MemorySnapshot {
  const value = (performance as Performance & { memory?: MemorySnapshot }).memory;
  return value ? { usedJSHeapSize: value.usedJSHeapSize, totalJSHeapSize: value.totalJSHeapSize, jsHeapSizeLimit: value.jsHeapSizeLimit } : null;
}
function message(text: string, bad = false) { status.textContent = text; status.classList.toggle('bad', bad); }
function controls(ready: boolean) {
  for (const id of ['sequence', 'fit', 'bounds', 'visibility', 'measure', 'opacity']) el<HTMLButtonElement>(id).disabled = !ready;
  el<HTMLButtonElement>('close').disabled = !active;
  quality.disabled = Boolean(active);
}
function phase(run: Run, name: string) {
  const previous = run.report.phases.at(-1);
  if (previous && previous.endMs === undefined) previous.endMs = elapsed(run);
  run.phase = name;
  if (run.report.phases.length < 80) run.report.phases.push({ name, startMs: elapsed(run) });
}
function collectLongTasks(run: Run, entries: PerformanceEntry[]) {
  for (const entry of entries) {
    if (entry.startTime < run.t0) continue;
    if (run.report.longTasks.length >= maxLongTasks) { run.report.droppedLongTasks++; continue; }
    run.report.longTasks.push({ startMs: rounded(entry.startTime - run.t0), durationMs: rounded(entry.duration) });
  }
}
function summarize(samples: number[]) {
  if (!samples.length) return { count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, medianMs: rounded(sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2), p95Ms: rounded(sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)]), maxMs: rounded(sorted.at(-1)!), totalMs: rounded(sorted.reduce((sum, value) => sum + value, 0)) };
}
function snapshot() {
  if (active) {
    collectLongTasks(active, active.observer?.takeRecords() ?? []);
    active.report.memory.latest = memory();
    const canvas = active.engine?.canvas;
    if (canvas) active.report.environment.canvasPixels = { width: canvas.width, height: canvas.height };
  }
  const value = {
    schema: 'review-studio-step-browser-performance-v1', capturedUtc: new Date().toISOString(),
    semantics: {
      loadStart: 'Click on Load selected STEP; native file chooser/transfer and page startup are excluded.',
      fileRead: 'Actual openLocalFile read, format check, SHA-256 and blob URL creation.',
      engineReady: 'Actual ViewerEngine setParts completed import, validation, scene/edge preparation and status; drawing may not yet have occurred.',
      firstModelDraw: 'Completion of first actual renderer.render after successful engine readiness.',
      postRenderFrame: 'Next requestAnimationFrame after first model draw; one paint opportunity, not a presentation guarantee.',
      renderCpu: 'Real per-instance renderer.render wall time; includes CPU rasterization in software mode, command submission only in WebGL. Not GPU execution or FPS.',
      longTasks: 'Main-thread PerformanceObserver longtask entries >=50ms, where supported; attribution omitted. Worker CPU time is not included.',
      memory: 'Optional performance.memory JS heap snapshots only; may be quantized/shared; excludes total WASM/GPU/process memory. No forced GC.',
      limits: 'Unchanged production source/import/geometry limits. Reports retain at most12 runs,512 render samples/run,256 long tasks/run,8 camera runs/run.',
      cameraSequence: 'Ten real view-command updates with model visible, opaque, unselected, bounds/measurement off; each waits for an actual render and a subsequent animation-frame opportunity. Additional actual renders are retained; none are suppressed.',
      instrumentation: 'Diagnostic calls, status/report rendering and observers add some overhead. It is not subtracted. Sampling is bounded; summaries say when samples were dropped.',
      geometry: 'Counts of rendered occurrence geometry. Buffer bytes are engine geometry/edge accounting, not total memory.',
    },
    runs: history.map(report => ({ ...report, renderSummary: summarize(report.renders.map(sample => sample.durationMs)), loadedRenderSummary: summarize(report.renders.filter(sample => sample.modelReady).map(sample => sample.durationMs)), cameraFirstRenderSummary: summarize(report.cameraRuns.flatMap(cameraRun => cameraRun.steps.map(step => step.firstRenderCpuMs))), longTaskSummary: summarize(report.longTasks.map(sample => sample.durationMs)) })),
  };
  reportNode.textContent = JSON.stringify(value, null, 2);
  return value;
}
function frame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    let id = 0;
    const abort = () => { cancelAnimationFrame(id); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    id = requestAnimationFrame(() => { signal.removeEventListener('abort', abort); resolve(); });
  });
}
function nextRender(run: Run): Promise<RenderSample> {
  return new Promise((resolve, reject) => {
    const signal = run.controller.signal;
    if (signal.aborted) { reject(signal.reason); return; }
    const clean = () => { clearTimeout(timer); run.renderWaiters.delete(done); signal.removeEventListener('abort', abort); };
    const done = (sample: RenderSample) => { clean(); resolve(sample); };
    const abort = () => { clean(); reject(signal.reason); };
    const timer = window.setTimeout(() => { clean(); reject(new Error('No renderer call observed within ten seconds.')); }, 10_000);
    signal.addEventListener('abort', abort, { once: true }); run.renderWaiters.add(done);
  });
}
function recordGeometry(run: Run, bounds: SceneBounds | null) {
  const probe = run.engine as unknown as EngineProbe;
  run.report.geometry = { sceneMeshes: probe.models.length, vertices: probe.models.reduce((sum, model) => sum + model.mesh.geometry.getAttribute('position').count, 0), triangles: probe.models.reduce((sum, model) => sum + (model.mesh.geometry.index?.count ?? model.mesh.geometry.getAttribute('position').count) / 3, 0), geometryAndEdgesBufferBytes: probe.geometryBytes, bounds };
}
function instrument(run: Run) {
  // Deliberate test-only access to this instance. No engine prototype/global patch.
  const renderer = (run.engine as unknown as EngineProbe).renderer;
  const original = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    const started = performance.now();
    try { original(scene, camera); }
    finally {
      const completed = performance.now();
      const sample = { phase: run.phase, modelReady: run.ready, startMs: rounded(started - run.t0), durationMs: rounded(completed - started) };
      if (run.report.renders.length < maxRenders) run.report.renders.push(sample); else run.report.droppedRenderSamples++;
      run.renderWaiters.forEach(waiter => waiter(sample));
      if (run.ready && !run.firstFrameScheduled) {
        run.firstFrameScheduled = true;
        run.report.timings.firstModelRenderCompletedFromLoadClickMs = rounded(completed - run.t0);
        void frame(run.controller.signal).then(() => {
          if (active !== run) return;
          run.report.timings.firstPostRenderAnimationFrameFromLoadClickMs = elapsed(run);
          phase(run, 'manual-interaction');
          controls(true); snapshot();
          message(`Ready · ${run.report.environment.renderer} · first model draw ${run.report.timings.firstModelRenderCompletedFromLoadClickMs} ms from load. ${run.report.status?.importNotice ?? ''}`);
        }).catch(() => {});
      }
    }
  };
}
function closeActive(reason = 'closed') {
  const run = active;
  if (!run) return;
  active = undefined;
  run.controller.abort(); run.engine?.dispose(); run.engine = undefined;
  if (run.file) releaseLocalFiles([run.file]); run.file = undefined;
  collectLongTasks(run, run.observer?.takeRecords() ?? []); run.observer?.disconnect();
  run.report.timings.closedFromLoadClickMs = elapsed(run);
  run.report.memory.afterClose = memory();
  if (run.report.outcome !== 'rejected') run.report.outcome = run.ready ? 'closed' : 'cancelled';
  phase(run, reason);
  viewport.replaceChildren(); controls(false); snapshot();
  el('renderer').textContent = 'Renderer: closed'; el('envelope').textContent = 'No source loaded'; el('measurement').textContent = '';
  message(run.ready ? 'Model closed. Geometry, worker and source URL owners released; garbage collection timing is browser-controlled.' : 'Import cancelled. Choose or reload a source to continue.');
}
async function load() {
  const selected = input.files?.[0];
  if (!selected) { message('Choose a STEP file first.', true); return; }
  if (!/\.(step|stp)$/i.test(selected.name)) { message('Choose a STEP or STP source.', true); return; }
  closeActive('replaced');
  const t0 = performance.now(), controller = new AbortController();
  const report: Report = { run: ++ordinal, startedUtc: new Date().toISOString(), outcome: 'loading', source: { name: selected.name, bytes: selected.size }, quality: quality.value === 'economy' ? 'economy' : 'standard', environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGiBHint: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null, devicePixelRatio: devicePixelRatio, viewportCss: { width: viewport.clientWidth, height: viewport.clientHeight } }, timings: {}, phases: [], renders: [], droppedRenderSamples: 0, longTaskSupport: typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask'), longTasks: [], droppedLongTasks: 0, cameraRuns: [], memory: { before: memory() } };
  const run: Run = { report, t0, controller, props: { parts: [], mode: 'single', sourcePresentation: 'local', renderQuality: report.quality, selectedIds: [], hiddenIds: [], opacityById: {}, explode: 0, section: { enabled: false, axis: 'z', offset: 0 }, measurementMode: false, onSelect: id => { if (active === run) update({ selectedIds: [id] }); }, onMeasure: result => { if (active === run) el('measurement').textContent = result ? `Approximate point distance: ${result.distance.toFixed(2)} mm` : ''; } }, phase: 'file-read', ready: false, sequenceBusy: false, renderWaiters: new Set(), firstFrameScheduled: false };
  active = run; history.push(report); if (history.length > maxReports) history.shift();
  phase(run, 'file-read'); controls(false);
  for (const id of ['bounds', 'visibility', 'measure']) el(id).setAttribute('aria-pressed', 'false');
  el('visibility').textContent = 'Hide model'; el<HTMLInputElement>('opacity').value = '1';
  if (report.longTaskSupport) { run.observer = new PerformanceObserver(list => collectLongTasks(run, list.getEntries())); run.observer.observe({ type: 'longtask' }); }
  message(`Reading and hashing ${selected.name}…`); snapshot();
  try {
    const readStarted = performance.now();
    run.file = await openLocalFile(selected, report.run, controller.signal);
    report.timings.fileReadHashAndObjectUrlMs = rounded(performance.now() - readStarted);
    controller.signal.throwIfAborted();
    report.source.sha256 = run.file.sourceHash;
    const part: ScenePart = { id: 'performance-model', itemId: 'local-performance', itemNumber: selected.name, name: selected.name, revision: `Run ${report.run}`, stepUrl: run.file.url, sourceHash: run.file.sourceHash, color: '#6f91aa', position: [0, 0, 0], rotation: [0, 0, 0] };
    run.props = { ...run.props, parts: [part], onReady: bounds => { if (active !== run) return; report.timings.engineReadyFromLoadClickMs = elapsed(run); report.timings.setPartsToReadyMs = rounded(performance.now() - partsStarted); report.memory.ready = memory(); recordGeometry(run, bounds); run.ready = Boolean(bounds && !report.status?.error); report.outcome = run.ready ? 'ready' : 'rejected'; if (!run.ready) { report.error = report.status?.error ?? 'No model geometry available.'; report.timings.rejectionFromLoadClickMs = elapsed(run); message(report.error, true); snapshot(); } }, onBoundsChange: bounds => { if (active === run) el('envelope').textContent = bounds ? `Mesh envelope: ${bounds.size.map(value => value.toFixed(2)).join(' × ')} mm` : 'No visible model envelope'; } };
    phase(run, 'engine-construction');
    const engineStarted = performance.now();
    let partsStarted = 0;
    run.engine = new ViewerEngine(viewport, run.props, value => {
      if (active !== run) return;
      report.status = { ...value }; report.environment.renderer = value.rendererMode;
      el('renderer').textContent = `Renderer: ${value.rendererMode ?? 'starting'}`;
      if (value.loading) message(`Importing ${selected.name} locally · ${value.loaded}/${value.total} completed`);
    });
    report.timings.engineConstructionMs = rounded(performance.now() - engineStarted);
    instrument(run); phase(run, 'import-and-first-draw'); partsStarted = performance.now();
    await run.engine.setParts([part]);
    if (active === run) snapshot();
  } catch (error) {
    if (controller.signal.aborted || active !== run) return;
    report.outcome = 'rejected'; report.error = error instanceof Error ? error.message : String(error);
    report.timings.rejectionFromLoadClickMs = elapsed(run);
    message(report.error, true); snapshot();
  }
}
function update(changes: Partial<ModelViewportProps>) {
  if (!active?.ready || !active.engine) return;
  active.props = { ...active.props, ...changes }; active.engine.update(active.props);
}
async function cameraSequence() {
  const run = active;
  if (!run?.ready || !run.engine || run.sequenceBusy) return;
  if (run.report.cameraRuns.length >= maxCameraRuns) { message('This run has reached its eight camera-sequence report limit. Close and reload to start a new run.'); return; }
  run.sequenceBusy = true; controls(false);
  const result: Report['cameraRuns'][number] = { startedMs: elapsed(run), steps: [] };
  run.report.cameraRuns.push(result);
  update({ hiddenIds: [], selectedIds: [], opacityById: {}, showBoundingBox: false, measurementMode: false });
  for (const id of ['bounds', 'visibility', 'measure']) el(id).setAttribute('aria-pressed', 'false');
  el('visibility').textContent = 'Hide model'; el<HTMLInputElement>('opacity').value = '1';
  const views: ViewCommand['type'][] = ['iso', 'top', 'front', 'right', 'iso', 'top', 'front', 'right', 'fit', 'iso'];
  try {
    for (const [index, view] of views.entries()) {
      run.controller.signal.throwIfAborted(); phase(run, `camera-${index + 1}:${view}`);
      message(`Camera view ${index + 1}/10 · ${view}`);
      const rendered = nextRender(run), started = performance.now();
      update({ viewCommand: { type: view, nonce: ++nonce } });
      const updateCpuMs = performance.now() - started;
      const sample = await rendered;
      result.steps.push({ view, updateCpuMs: rounded(updateCpuMs), firstRenderWaitMs: rounded(sample.startMs - (started - run.t0)), firstRenderCpuMs: sample.durationMs });
      await frame(run.controller.signal);
    }
    result.completedMs = elapsed(run);
    message('Completed ten actual camera views. Review CPU render timings and main-thread long tasks in the report.');
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); if (active === run) message(result.error, true); }
  finally { run.sequenceBusy = false; if (active === run) { phase(run, 'manual-interaction'); controls(true); snapshot(); } }
}

el('load').addEventListener('click', () => { void load(); });
el('close').addEventListener('click', () => closeActive());
input.addEventListener('change', () => { if (active) closeActive('source-changed'); });
el('sequence').addEventListener('click', () => { void cameraSequence(); });
el('fit').addEventListener('click', () => update({ viewCommand: { type: 'fit', nonce: ++nonce } }));
el('bounds').addEventListener('click', () => { const shown = !active?.props.showBoundingBox; update({ showBoundingBox: shown }); el('bounds').setAttribute('aria-pressed', String(shown)); });
el('visibility').addEventListener('click', () => { const hidden = !active?.props.hiddenIds.length; update({ hiddenIds: hidden ? ['performance-model'] : [] }); el('visibility').setAttribute('aria-pressed', String(hidden)); el('visibility').textContent = hidden ? 'Show model' : 'Hide model'; });
el('measure').addEventListener('click', () => { const enabled = !active?.props.measurementMode; update({ measurementMode: enabled }); el('measure').setAttribute('aria-pressed', String(enabled)); if (enabled) message('Pick two visible surface points for an approximate mesh distance.'); });
el('opacity').addEventListener('input', event => update({ opacityById: { 'performance-model': Number((event.target as HTMLInputElement).value) } }));
el('snapshot').addEventListener('click', snapshot);
el('download').addEventListener('click', () => {
  const bytes = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(bytes), link = document.createElement('a');
  link.href = url; link.download = 'step-browser-performance.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
window.addEventListener('pagehide', () => closeActive('page-hidden'));
controls(false);
