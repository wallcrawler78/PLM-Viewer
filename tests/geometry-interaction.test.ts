import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, BufferGeometry, DirectionalLight, EventDispatcher, PerspectiveCamera, Scene, Vector3, WebGLRenderTarget } from 'three';
import { ViewerEngine } from '../src/components/model/engine';
import type { ModelViewportProps, ScenePart } from '../src/components/model/types';
import { MESH_SOURCE_LIMITS } from '../src/components/model/mesh-source';

const renderProbe = vi.hoisted(() => ({ draw: vi.fn(), pixelRatio: vi.fn(), size: vi.fn(), cameraChanged: () => {} }));
const stepProbe = vi.hoisted(() => ({ import: vi.fn() }));
vi.mock('../src/cad/step-client', () => ({ importStepUrl: stepProbe.import }));
// Only replace the GPU adapter: scene geometry, transforms, and raycasting stay
// real. This checks when the engine submits GPU work without requiring a GPU.
vi.mock('three', async importOriginal => ({
  ...await importOriginal<typeof import('three')>(),
  WebGLRenderer: class {
    domElement: HTMLCanvasElement;
    shadowMap = { enabled: false, type: 0 };
    constructor({ canvas }: { canvas: HTMLCanvasElement }) { this.domElement = canvas; }
    setPixelRatio(value: number) { renderProbe.pixelRatio(value); }
    setSize(width: number, height: number, updateStyle: boolean) { renderProbe.size(width, height, updateStyle); }
    setScissorTest() {} setViewport() {} setScissor() {} clear() {} dispose() {}
    render(scene: Scene, camera: PerspectiveCamera) { renderProbe.draw(scene, camera); }
  },
}));

// Exercise the real scene geometry and raycaster through canvas input events.
// Camera navigation itself belongs to Three.js; this keeps DOM/GPU setup out of
// these regression checks for source transitions and accidental picking.
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class extends EventDispatcher {
    target = new Vector3();
    constructor(private camera: PerspectiveCamera) { super(); renderProbe.cameraChanged = () => this.dispatchEvent({ type: 'change' } as never); }
    update() { this.camera.lookAt(this.target); this.camera.updateMatrixWorld(true); }
    dispose() {}
  },
}));

const engines: ViewerEngine[] = [];
afterEach(() => {
  engines.splice(0).forEach(engine => engine.dispose());
  vi.restoreAllMocks();
  stepProbe.import.mockReset();
  renderProbe.draw.mockClear(); renderProbe.pixelRatio.mockClear(); renderProbe.size.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function harness(overrides: Partial<ModelViewportProps> = {}, rendererMode: 'software' | 'webgl' = 'software', devicePixelRatio = 1) {
  const strokes: { color: string; opacity: number; viewportX: number }[] = [];
  let viewportX = 0;
  const context = {
    strokeStyle: '', globalAlpha: 1,
    setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, rect(x: number) { viewportX = x; }, clip() {}, fillRect() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {}, setLineDash() {},
    stroke() { strokes.push({ color: this.strokeStyle, opacity: this.globalAlpha, viewportX }); },
  };
  class Canvas {
    dataset = {}; style: Record<string, string> = {}; tabIndex = 0;
    width = 0; height = 0;
    listeners = new Map<string, Set<EventListener>>();
    getContext() { return context; }
    setAttribute() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    addEventListener(name: string, listener: EventListener) {
      const entries = this.listeners.get(name) ?? new Set(); entries.add(listener); this.listeners.set(name, entries);
    }
    removeEventListener(name: string, listener: EventListener) { this.listeners.get(name)?.delete(listener); }
    remove() {}
    dispatch(name: string, values: Partial<PointerEvent> = {}) {
      const event = { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: name === 'pointerup' ? 0 : 1,
        clientX: 400, clientY: 300, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...values };
      this.listeners.get(name)?.forEach(listener => listener(event as PointerEvent));
    }
  }
  let nextFrame: (() => void) | undefined;
  let resize = (_width: number, _height: number) => {};
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time += 100);
  vi.stubGlobal('document', { createElement: () => new Canvas() });
  vi.stubGlobal('window', { location: { search: rendererMode === 'software' ? '?renderer=software' : '' }, devicePixelRatio });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() {
      resize = (width, height) => this.callback([{ contentRect: { width, height } }] as ResizeObserverEntry[], this as unknown as ResizeObserver);
      resize(800, 600);
    }
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { nextFrame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const geometry = new BoxGeometry(20, 20, 20);
  const mesh = { positions: Array.from(geometry.getAttribute('position').array), indices: Array.from(geometry.getIndex()!.array) };
  geometry.dispose();
  const response = () => new Response(JSON.stringify(mesh), { status: 200 });
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', fetch);
  const part: ScenePart = { id: 'occ-part', itemId: 'part', itemNumber: 'PART-1', name: 'Test part', revision: 'A', color: '#8899aa', meshUrl: '/part-a.json', position: [0, 0, 0], bbox: { min: [-10, -10, -10], max: [10, 10, 10] } };
  const props: ModelViewportProps = { parts: [part], mode: 'single', selectedIds: [], hiddenIds: [], opacityById: {}, explode: 0,
    section: { enabled: false, axis: 'z', offset: 0 }, measurementMode: false, onSelect: vi.fn(), onAnchor: vi.fn(), onMeasure: vi.fn(), onBoundsChange: vi.fn(), onCameraChange: vi.fn(), ...overrides };
  const engine = new ViewerEngine({ appendChild() {} } as unknown as HTMLDivElement, props, () => {});
  engines.push(engine);
  const canvas = engine.canvas as unknown as Canvas;
  const click = () => { canvas.dispatch('pointerdown'); canvas.dispatch('pointerup'); };
  return { engine, canvas, props, part, mesh, fetch, response, click, strokes, resize, frame: () => nextFrame?.() };
}

function imported(mesh: { positions: number[]; indices: number[] }) {
  return { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices), normals: new Float32Array(mesh.positions.length),
    hierarchy: { name: 'source', meshIndices: [0], children: [] }, meshRanges: [], warnings: [],
  };
}

describe('model picking and source transitions', () => {
  it('imports raw STEP once for repeated occurrences and does not request its derivative', async () => {
    const { engine, props, part, mesh, fetch, click } = harness();
    stepProbe.import.mockResolvedValue(imported(mesh));
    const raw: ScenePart = { ...part, stepUrl: '/source.step', sourceHash: 'a'.repeat(64), cadNodePath: [0], sourceToPart: { position: [0, 0, 0], rotation: [0, 0, 0] }, bbox: undefined };
    const repeated = { ...raw, id: 'occ-repeated', position: [30, 0, 0] as [number, number, number] };
    await engine.setParts([raw, repeated]);
    expect(stepProbe.import).toHaveBeenCalledOnce();
    expect(stepProbe.import).toHaveBeenCalledWith('/source.step', 'a'.repeat(64), expect.any(AbortSignal), [0], raw.sourceToPart);
    expect(fetch).not.toHaveBeenCalled();
    expect(props.onBoundsChange).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'tessellated-bounds', size: [50, 20, 20] }));
    click(); expect(props.onSelect).toHaveBeenCalled();
  });

  it('fails a raw source closed instead of falling back to a stale mesh derivative', async () => {
    const { engine, props, part, fetch } = harness();
    stepProbe.import.mockRejectedValue(new Error('The STEP bytes do not match this source edition.'));
    await engine.setParts([{ ...part, stepUrl: '/changed.step', sourceHash: 'a'.repeat(64) }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(props.onBoundsChange).toHaveBeenLastCalledWith(null);
  });

  it('invalidates cached CAD geometry when its exact component path changes and cancels stale import', async () => {
    const onReady = vi.fn();
    const { engine, props, part, mesh } = harness({ onReady });
    let release!: (result: ReturnType<typeof imported>) => void;
    stepProbe.import.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(imported(mesh));
    const raw: ScenePart = { ...part, stepUrl: '/assembly.step', sourceHash: 'a'.repeat(64), cadNodePath: [0, 0], sourceToPart: { position: [0, 0, 0], rotation: [0, 0, 0] } };
    const first = engine.setParts([raw]);
    const oldSignal = stepProbe.import.mock.calls[0][2] as AbortSignal;
    const next = { ...raw, cadNodePath: [0, 1], position: [50, 0, 0] as [number, number, number] };
    engine.update({ ...props, parts: [next] }); await engine.setParts([next]);
    expect(oldSignal.aborted).toBe(true);
    expect(stepProbe.import).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(expect.objectContaining({ min: [40, -10, -10], max: [60, 10, 10] }));
    release(imported(mesh)); await first;
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('does not reuse geometry after the source-to-part frame changes for the same STEP and subtree', async () => {
    const { engine, props, part, mesh } = harness();
    stepProbe.import.mockResolvedValueOnce(imported(mesh)).mockResolvedValueOnce(imported({ ...mesh, positions: mesh.positions.map((value, index) => value + (index % 3 === 0 ? 100 : 0)) }));
    const raw: ScenePart = { ...part, stepUrl: '/assembly.step', sourceHash: 'a'.repeat(64), cadNodePath: [0, 2], sourceToPart: { position: [0, 0, 0], rotation: [0, 0, 0] }, bbox: undefined };
    await engine.setParts([raw]);
    const oldSignal = stepProbe.import.mock.calls[0][2] as AbortSignal;
    const next: ScenePart = { ...raw, sourceToPart: { position: [100, 0, 0], rotation: [0, 0, 0] } };
    engine.update({ ...props, parts: [next] }); await engine.setParts([next]);
    expect(oldSignal.aborted).toBe(true);
    expect(stepProbe.import).toHaveBeenCalledTimes(2);
    expect(stepProbe.import).toHaveBeenLastCalledWith(next.stepUrl, next.sourceHash, expect.any(AbortSignal), next.cadNodePath, next.sourceToPart);
    expect(props.onBoundsChange).toHaveBeenLastCalledWith(expect.objectContaining({ min: [90, -10, -10], max: [110, 10, 10], source: 'tessellated-bounds' }));
  });

  it('does not restore measured endpoints against a changed source-to-part frame', async () => {
    const raw: ScenePart = { id: 'occ-part', itemId: 'part', itemNumber: 'PART-1', name: 'Test part', revision: 'A', color: '#8899aa', stepUrl: '/assembly.step', sourceHash: 'a'.repeat(64), cadNodePath: [0], sourceToPart: { position: [0, 0, 0], rotation: [0, 0, 0] }, position: [0, 0, 0] };
    const restoredMeasurement = { distance: 5, a: [0, 0, 10] as [number, number, number], b: [5, 0, 10] as [number, number, number], occurrenceA: raw.id, occurrenceB: raw.id };
    const { engine, props, mesh } = harness({ parts: [raw], restoredMeasurement });
    stepProbe.import.mockResolvedValue(imported(mesh));
    const next: ScenePart = { ...raw, sourceToPart: { position: [10, 20, 30], rotation: [0.2, 0.3, 0.4] } };
    engine.update({ ...props, parts: [next] }); await engine.setParts([next]);
    expect(props.onMeasure).toHaveBeenLastCalledWith(null);
    expect(props.onMeasure).not.toHaveBeenCalledWith(expect.objectContaining({ distance: 5 }));
  });

  it('selects real geometry on a click but not after orbiting away and back to the starting point', async () => {
    const { engine, props, canvas, click } = harness();
    await engine.setParts(props.parts);
    click(); expect(props.onSelect).toHaveBeenCalledWith('occ-part', false);
    vi.mocked(props.onSelect).mockClear();
    canvas.dispatch('pointerdown');
    canvas.dispatch('pointermove', { clientX: 450 });
    canvas.dispatch('pointermove', { clientX: 400 });
    canvas.dispatch('pointerup');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('does not turn a pinch or cancelled gesture into a selection', async () => {
    const { engine, props, canvas, click } = harness();
    await engine.setParts(props.parts);
    canvas.dispatch('pointerdown', { pointerType: 'touch' });
    canvas.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: false });
    canvas.dispatch('pointerup', { pointerId: 2, pointerType: 'touch', isPrimary: false });
    canvas.dispatch('pointerup', { pointerType: 'touch' });
    canvas.dispatch('pointerdown'); canvas.dispatch('pointercancel'); canvas.dispatch('pointerup');
    expect(props.onSelect).not.toHaveBeenCalled();
    click(); expect(props.onSelect).toHaveBeenCalledOnce();
  });

  it('blocks stale geometry anchors while a new revision is loading', async () => {
    const { engine, props, part, canvas, fetch, response, click } = harness();
    await engine.setParts(props.parts);
    engine.update({ ...props, anchorMode: true });
    canvas.dispatch('pointerdown');
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const nextPart = { ...part, revision: 'B', meshUrl: '/part-b.json' };
    engine.update({ ...props, parts: [nextPart], anchorMode: true });
    const loading = engine.setParts([nextPart]);
    click(); expect(props.onAnchor).not.toHaveBeenCalled();
    resolve(response()); await loading;
    canvas.dispatch('pointerup'); expect(props.onAnchor).not.toHaveBeenCalled();
    click(); expect(props.onAnchor).toHaveBeenCalledWith(expect.objectContaining({ occurrenceId: 'occ-part' }));
  });

  it('discards a gesture begun on a different source even if the new geometry is ready on release', async () => {
    const { engine, props, part, canvas, click } = harness();
    await engine.setParts(props.parts);
    engine.update({ ...props, anchorMode: true });
    canvas.dispatch('pointerdown');
    const nextPart = { ...part, revision: 'B', meshUrl: '/part-b.json' };
    engine.update({ ...props, parts: [nextPart], anchorMode: true });
    await engine.setParts([nextPart]);
    canvas.dispatch('pointerup'); expect(props.onAnchor).not.toHaveBeenCalled();
    click(); expect(props.onAnchor).toHaveBeenCalledOnce();
  });

  it('clears a completed measurement when the next pair begins or geometry resets', async () => {
    const { engine, props, click } = harness();
    await engine.setParts(props.parts);
    engine.update({ ...props, measurementMode: true });
    click(); click();
    expect(props.onMeasure).toHaveBeenLastCalledWith(expect.objectContaining({ distance: 0, occurrenceA: 'occ-part', occurrenceB: 'occ-part' }));
    click(); expect(props.onMeasure).toHaveBeenLastCalledWith(null);
    click(); expect(props.onMeasure).toHaveBeenLastCalledWith(expect.objectContaining({ distance: 0 }));
    await engine.setParts([]); expect(props.onMeasure).toHaveBeenLastCalledWith(null);
  });

  it('makes selected edge strokes disappear when overlay opacity reaches zero', async () => {
    const { engine, props, strokes, frame } = harness();
    await engine.setParts(props.parts);
    engine.update({ ...props, mode: 'overlay', selectedIds: ['occ-part'], overlayOpacity: { a: 0, b: 1 } });
    frame();
    expect(strokes.some(stroke => stroke.color === 'rgb(0,123,118)' && stroke.opacity > 0)).toBe(true);
    strokes.splice(0);
    engine.update({ ...props, mode: 'overlay', selectedIds: ['occ-part'], overlayOpacity: { a: 0, b: 0 } });
    frame();
    expect(strokes.some(stroke => stroke.color === 'rgb(0,123,118)')).toBe(false);
  });

  it('publishes the latest standard-view camera before a document transition can unmount the viewer', async () => {
    const { engine, props } = harness();
    await engine.setParts(props.parts);
    const initialCamera = vi.mocked(props.onCameraChange!).mock.lastCall?.[0];
    expect(initialCamera).toBeDefined();
    vi.mocked(props.onCameraChange!).mockClear();
    engine.update({ ...props, viewCommand: { type: 'top', nonce: 1 } });
    const topCamera = vi.mocked(props.onCameraChange!).mock.lastCall?.[0];
    expect(topCamera).toBeDefined();
    expect(topCamera).not.toEqual(initialCamera);
    expect(Math.abs(topCamera!.position[0] - topCamera!.target[0])).toBeLessThan(1);
    expect(topCamera!.position[2]).toBeGreaterThan(topCamera!.target[2]);
    // No debounce interval or later frame is required before saving this state.
  });

  it('measures and displays removed-component bounds in the baseline comparison pane', async () => {
    const { engine, props, part, strokes, frame } = harness();
    const removed: ScenePart = { ...part, id: 'occ-removed', position: [25, 0, 0], bbox: { min: [-3, -4, -5], max: [3, 4, 5] } };
    const comparing: ModelViewportProps = { ...props, mode: 'split', comparisonParts: [removed], selectedIds: [removed.id], showBoundingBox: true };
    engine.update(comparing);
    await engine.setParts(props.parts, [removed]);
    expect(props.onBoundsChange).toHaveBeenLastCalledWith(expect.objectContaining({
      comparisonSource: 'baseline', min: [22, -4, -5], max: [28, 4, 5], size: [6, 8, 10], occurrenceIds: [removed.id],
    }));
    frame();
    const boundsStrokes = strokes.filter(stroke => stroke.color === 'rgb(212,161,62)');
    expect(boundsStrokes.length).toBeGreaterThan(0);
    expect(boundsStrokes.every(stroke => stroke.viewportX === 0)).toBe(true);
    engine.update({ ...comparing, hiddenIds: [removed.id] });
    expect(props.onBoundsChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps linked current-revision selection bounds distinct from the baseline geometry', async () => {
    const { engine, props, part } = harness();
    const baseline = { ...part, bbox: { min: [-30, -40, -50], max: [30, 40, 50] } };
    const comparing: ModelViewportProps = { ...props, mode: 'overlay', comparisonParts: [baseline], selectedIds: [part.id] };
    engine.update(comparing);
    await engine.setParts(props.parts, [baseline]);
    expect(props.onBoundsChange).toHaveBeenLastCalledWith(expect.objectContaining({ comparisonSource: 'current', size: [20, 20, 20] }));
    engine.update({ ...comparing, hiddenIds: [part.id] });
    expect(props.onBoundsChange).toHaveBeenLastCalledWith(null);
  });

  it('restores a completed measurement and its visible line after remounting for the same source', async () => {
    const restoredMeasurement = { distance: 999, a: [0, 0, 10] as [number, number, number], b: [5, 0, 10] as [number, number, number], occurrenceA: 'occ-part', occurrenceB: 'occ-part' };
    const { engine, props, strokes, frame } = harness({ restoredMeasurement, measurementResetKey: 3 });
    await engine.setParts(props.parts);
    // Recompute from the retained assembled endpoints instead of trusting a
    // stale display value, then rebuild both surface markers and the line.
    expect(props.onMeasure).toHaveBeenLastCalledWith({ ...restoredMeasurement, distance: 5 });
    frame();
    expect(strokes.some(stroke => stroke.color === 'rgb(171,118,37)')).toBe(true);
    engine.update({ ...props, measurementResetKey: 4 });
    expect(props.onMeasure).toHaveBeenLastCalledWith(null);
    strokes.splice(0);
    engine.update({ ...props, measurementResetKey: 4, restoredMeasurement });
    frame();
    expect(strokes.some(stroke => stroke.color === 'rgb(171,118,37)')).toBe(false);
    expect(props.onMeasure).toHaveBeenLastCalledWith(null);
  });

  it('does not restore endpoints after an explicit reset, a source revision change, or hiding the measured occurrence', async () => {
    const restoredMeasurement = { distance: 5, a: [0, 0, 10] as [number, number, number], b: [5, 0, 10] as [number, number, number], occurrenceA: 'occ-part', occurrenceB: 'occ-part' };
    const reset = harness({ restoredMeasurement, measurementResetKey: 1 });
    reset.engine.update({ ...reset.props, measurementResetKey: 2 });
    await reset.engine.setParts(reset.props.parts);
    expect(reset.props.onMeasure).toHaveBeenLastCalledWith(null);

    const changed = harness({ restoredMeasurement });
    const revised = { ...changed.part, revision: 'B', meshUrl: '/part-b.json' };
    changed.engine.update({ ...changed.props, parts: [revised] });
    await changed.engine.setParts([revised]);
    expect(changed.props.onMeasure).toHaveBeenLastCalledWith(null);

    const hidden = harness({ restoredMeasurement, hiddenIds: ['occ-part'] });
    await hidden.engine.setParts(hidden.props.parts);
    expect(hidden.props.onMeasure).toHaveBeenLastCalledWith(null);
  });

  it('reuses one asset for repeated occurrences and releases it when no requested occurrence needs it', async () => {
    const { engine, props, part, fetch } = harness();
    const repeated = { ...part, id: 'occ-repeated', position: [30, 0, 0] as [number, number, number] };
    await engine.setParts([part, repeated]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0][1]?.signal;
    await engine.setParts([part]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await engine.setParts([]);
    expect(signal?.aborted).toBe(true);
    await engine.setParts(props.parts);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('clears old envelopes immediately and cancels obsolete source work without publishing a stale scene', async () => {
    const onReady = vi.fn();
    const { engine, props, part, fetch, response } = harness({ onReady });
    await engine.setParts(props.parts);
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const second = { ...part, revision: 'B', meshUrl: '/part-b.json' };
    engine.update({ ...props, parts: [second] });
    const pending = engine.setParts([second]);
    expect(props.onBoundsChange).toHaveBeenLastCalledWith(null);
    const obsoleteSignal = fetch.mock.calls[1][1]?.signal;
    const third = { ...part, revision: 'C', meshUrl: '/part-c.json', position: [50, 0, 0] as [number, number, number] };
    engine.update({ ...props, parts: [third] });
    await engine.setParts([third]);
    expect(obsoleteSignal?.aborted).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(expect.objectContaining({ min: [40, -10, -10], max: [60, 10, 10] }));
    resolve(response()); await pending;
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('includes mesh-derived envelopes and excludes failed geometry from the prepared scene bounds', async () => {
    const onReady = vi.fn(), onError = vi.fn();
    const { engine, part, fetch, response } = harness({ onReady, onError });
    const derived = { ...part, id: 'occ-derived', meshUrl: '/derived.json', bbox: undefined, position: [100, 0, 0] as [number, number, number] };
    const missing = { ...part, id: 'occ-missing', meshUrl: '/missing.json', position: [1000, 0, 0] as [number, number, number] };
    fetch.mockImplementation(async url => String(url) === '/missing.json' ? new Response(null, { status: 404 }) : response());
    await engine.setParts([part, derived, missing]);
    expect(onReady).toHaveBeenLastCalledWith(expect.objectContaining({ min: [-10, -10, -10], max: [110, 10, 10], size: [120, 20, 20], source: 'tessellated-bounds', occurrenceIds: [part.id, derived.id] }));
    await engine.setParts([missing]);
    expect(onReady).toHaveBeenLastCalledWith(null);
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('No model geometry is available.'));
  });

  it('finishes a mixed assembly after a derivative stalls and keeps healthy parts usable', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn(), onError = vi.fn();
    const { engine, props, part, fetch, response, click } = harness({ onReady, onError });
    const stalled = { ...part, id: 'occ-stalled', meshUrl: '/stalled.json', position: [1000, 0, 0] as [number, number, number] };
    fetch.mockImplementation(url => String(url) === '/stalled.json' ? new Promise<Response>(() => {}) : Promise.resolve(response()));
    const pending = engine.setParts([part, stalled]);
    await vi.advanceTimersByTimeAsync(MESH_SOURCE_LIMITS.fetchTimeoutMs + 1);
    await pending;
    expect(onReady).toHaveBeenLastCalledWith(expect.objectContaining({ min: [-10, -10, -10], max: [10, 10, 10], occurrenceIds: [part.id] }));
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('too long'));
    expect(fetch.mock.calls.find(([url]) => url === '/stalled.json')?.[1]?.signal?.aborted).toBe(true);
    click();
    expect(props.onSelect).toHaveBeenCalledWith(part.id, false);
  });

  it('excludes unsafe world placements while preserving the shared geometry for healthy occurrences', async () => {
    const onReady = vi.fn(), onError = vi.fn();
    const { engine, props, part, fetch, click } = harness({ onReady, onError });
    const invalid = { ...part, id: 'occ-invalid', position: [1e40, 0, 0] as [number, number, number] };
    await engine.setParts([part, invalid]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenLastCalledWith(expect.objectContaining({ min: [-10, -10, -10], max: [10, 10, 10], occurrenceIds: [part.id] }));
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('model placement exceeds the local review range'));
    click(); expect(props.onSelect).toHaveBeenCalledWith(part.id, false);
  });

  it('releases a loaded source when every occurrence fails placement validation', async () => {
    const onReady = vi.fn(), onError = vi.fn();
    const { engine, props, part, fetch, click } = harness({ onReady, onError });
    const dispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    // The pose itself is finite and in range; only the loaded geometry proves
    // that this occurrence extends beyond the supported world envelope.
    const invalid = { ...part, position: [1e9 - 5, 0, 0] as [number, number, number] };
    await engine.setParts([invalid]);
    expect(onReady).toHaveBeenLastCalledWith(null);
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('transformed model envelope'));
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(dispose.mock.contexts.some(geometry => geometry instanceof BufferGeometry && geometry.index?.count === 36 && geometry.getAttribute('position')?.count === 24)).toBe(true);

    await engine.setParts([part]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(expect.objectContaining({ occurrenceIds: [part.id] }));
    click(); expect(props.onSelect).toHaveBeenCalledWith(part.id, false);
  });

  it('keeps a shared source until its last healthy occurrence is removed', async () => {
    const { engine, part, fetch } = harness();
    const invalid = { ...part, id: 'occ-invalid', position: [1e9 - 5, 0, 0] as [number, number, number] };
    await engine.setParts([part], [invalid]);
    const signal = fetch.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    await engine.setParts([], [invalid]);
    expect(signal?.aborted).toBe(true);
  });

  it('preserves unchanged overlay geometry on unrelated UI updates and refreshes it when explosion changes', async () => {
    const { engine, props, click, frame, strokes } = harness();
    await engine.setParts(props.parts);
    const active: ModelViewportProps = { ...props, measurementMode: true, showBoundingBox: true, anchors: [{ id: 'note-1', occurrenceId: 'occ-part', localPoint: [0, 0, 10] }] };
    engine.update(active); click(); click(); frame();
    const dispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    engine.update({ ...active, onSelect: vi.fn() }); frame();
    expect(dispose).not.toHaveBeenCalled();
    engine.update({ ...active, explode: 0.5 }); frame();
    expect(dispose).toHaveBeenCalled();
    expect(strokes.some(stroke => stroke.color === 'rgb(171,118,37)')).toBe(true);
  });

  it('submits no idle GPU frames while preserving camera, resize, scene and context-restoration redraws', async () => {
    const { engine, props, canvas, frame, resize } = harness({}, 'webgl');
    await engine.setParts(props.parts);
    renderProbe.draw.mockClear(); frame();
    expect(renderProbe.draw).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 12; index++) frame();
    expect(renderProbe.draw).toHaveBeenCalledTimes(1);
    renderProbe.cameraChanged(); frame();
    expect(renderProbe.draw).toHaveBeenCalledTimes(2);
    resize(700, 500); frame();
    expect(renderProbe.draw).toHaveBeenCalledTimes(3);
    engine.update({ ...props, showBoundingBox: true }); frame();
    expect(renderProbe.draw).toHaveBeenCalledTimes(4);
    canvas.dispatch('webglcontextrestored'); frame();
    expect(renderProbe.draw).toHaveBeenCalledTimes(5);
    frame(); expect(renderProbe.draw).toHaveBeenCalledTimes(5);
  });

  it('avoids scene walks and GPU redraws for callback-only/status renders while keeping event callbacks current', async () => {
    const { engine, props, frame, click } = harness({}, 'webgl');
    await engine.setParts(props.parts); frame();
    renderProbe.draw.mockClear();
    const boundsTransform = vi.spyOn(Box3.prototype, 'applyMatrix4');
    const onSelect = vi.fn();
    for (let index = 0; index < 20; index++) {
      engine.update({ ...props, onSelect, currentRevision: `label-${index}` }); frame();
    }
    expect(renderProbe.draw).not.toHaveBeenCalled();
    expect(boundsTransform).not.toHaveBeenCalled();
    click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('occ-part', false);
    expect(props.onSelect).not.toHaveBeenCalled();
    engine.update({ ...props, selectedIds: ['occ-part'], onSelect }); frame();
    expect(renderProbe.draw).toHaveBeenCalledOnce();
    expect(boundsTransform).toHaveBeenCalled();
  });

  it('applies visibility to newly imported models after an intermediate loading-status update', async () => {
    const { engine, props, fetch, response, click } = harness({ hiddenIds: ['occ-part'] });
    let release!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = engine.setParts(props.parts);
    engine.update(props);
    release(response()); await pending;
    click();
    expect(props.onSelect).not.toHaveBeenCalled();
    engine.update({ ...props, hiddenIds: [] });
    click();
    expect(props.onSelect).toHaveBeenCalledOnce();
  });

  it('changes only the backing raster resolution for economy mode and preserves resize, bounds and picking', async () => {
    const { engine, props, canvas, fetch, resize, click } = harness({ renderQuality: 'standard' }, 'software', 2);
    await engine.setParts(props.parts);
    expect([canvas.width, canvas.height]).toEqual([1200, 900]); // Existing software cap is 1.5.
    const bounds = vi.mocked(props.onBoundsChange!).mock.lastCall![0];
    const economy = { ...props, renderQuality: 'economy' as const };
    engine.update(economy);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(vi.mocked(props.onBoundsChange!).mock.lastCall![0]).toEqual(bounds);
    click(); expect(props.onSelect).toHaveBeenLastCalledWith('occ-part', false);
    resize(1000, 500);
    expect([canvas.width, canvas.height]).toEqual([1000, 500]);
    engine.update({ ...economy, renderQuality: 'standard' });
    expect([canvas.width, canvas.height]).toEqual([1500, 750]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('caps the accelerated raster at one device pixel per CSS pixel in economy mode', async () => {
    const { engine, props, resize, frame } = harness({ renderQuality: 'standard' }, 'webgl', 3);
    await engine.setParts(props.parts); frame();
    expect(renderProbe.pixelRatio).toHaveBeenLastCalledWith(2);
    renderProbe.draw.mockClear();
    engine.update({ ...props, renderQuality: 'economy' }); frame();
    expect(renderProbe.pixelRatio).toHaveBeenLastCalledWith(1);
    expect(renderProbe.size).toHaveBeenLastCalledWith(800, 600, false);
    expect(renderProbe.draw).toHaveBeenCalledOnce();
    resize(640, 480); frame();
    expect(renderProbe.size).toHaveBeenLastCalledWith(640, 480, false);
    engine.update(props); frame();
    expect(renderProbe.pixelRatio).toHaveBeenLastCalledWith(2);
    expect(renderProbe.size).toHaveBeenLastCalledWith(640, 480, false);
  });

  it('releases allocated light shadow targets once when the model workspace is disposed', async () => {
    const { engine, props, frame } = harness({}, 'webgl');
    await engine.setParts(props.parts); frame();
    const scene = renderProbe.draw.mock.lastCall![0] as Scene;
    const light = scene.children.find(object => object instanceof DirectionalLight && object.castShadow) as DirectionalLight;
    const target = new WebGLRenderTarget(4, 4);
    const released = vi.fn(); target.addEventListener('dispose', released);
    light.shadow.map = target;
    engine.dispose(); engine.dispose();
    expect(released).toHaveBeenCalledOnce();
  });
});
