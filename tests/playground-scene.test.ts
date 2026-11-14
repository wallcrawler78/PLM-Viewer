import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, BufferGeometry, EventDispatcher, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from 'three';
import { PlaygroundEngine } from '../src/playground/scene-engine';
import type { PlaygroundSceneStatus, PlaygroundViewportProps } from '../src/playground/scene-engine';
import type { ProposalNode } from '../src/playground/types';
import type { ScenePart } from '../src/components/model/types';

const probe = vi.hoisted(() => ({ render: vi.fn(), import: vi.fn() }));
vi.mock('../src/cad/step-client', () => ({ importStepUrl: probe.import }));
vi.mock('three', async original => ({
  ...await original<typeof import('three')>(),
  WebGLRenderer: class {
    domElement: HTMLCanvasElement; shadowMap = { enabled: false, type: 0 };
    constructor({ canvas }: { canvas: HTMLCanvasElement }) { this.domElement = canvas; }
    setPixelRatio() {} setSize() {} dispose() {}
    render(scene: Scene, camera: PerspectiveCamera) { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); probe.render(scene, camera); }
  },
}));
// Keep real Three geometry, raycasting and TransformControls; replace only GPU
// submission and browser-navigation plumbing to exercise our scene lifecycle.
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class extends EventDispatcher {
    target = new Vector3(); enabled = true;
    constructor(private camera: PerspectiveCamera) { super(); }
    update() { this.camera.lookAt(this.target); this.camera.updateMatrixWorld(true); }
    dispose() {}
  },
}));
const engines: PlaygroundEngine[] = [];
afterEach(() => { engines.splice(0).forEach(engine => engine.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); probe.import.mockReset(); probe.render.mockClear(); });

function imported() {
  const geometry = new BoxGeometry(20, 20, 20);
  const result = { positions: new Float32Array(geometry.getAttribute('position').array), normals: new Float32Array(geometry.getAttribute('normal').array),
    indices: new Uint32Array(geometry.index!.array), warnings: [] };
  geometry.dispose(); return result;
}
const source = (values: Partial<ScenePart> = {}): ScenePart => ({ id: 'occ-1', itemId: 'part', itemNumber: 'PN-1', name: 'Component', revision: 'A',
  color: '#8899aa', position: [0, 0, 0], stepUrl: '/source.step', sourceHash: 'a'.repeat(64), ...values });
const nodeFor = (part: ScenePart): ProposalNode => ({ id: part.id, sourceId: part.id, kind: 'source', name: part.name, itemId: part.itemId,
  itemNumber: part.itemNumber, revision: part.revision, sourceHash: part.sourceHash, position: [...part.position], rotation: [0, 0, 0], color: part.color });

function harness(overrides: Partial<PlaygroundViewportProps> = {}) {
  class Canvas {
    dataset = {}; style = {}; width = 800; height = 600; tabIndex = 0;
    listeners = new Map<string, Set<(event: never) => void>>();
    getContext() { return {}; } setAttribute() {} focus() {} remove() {} setPointerCapture() {} releasePointerCapture() {}
    addEventListener(name: string, listener: (event: never) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set); }
    removeEventListener(name: string, listener: (event: never) => void) { this.listeners.get(name)?.delete(listener); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    dispatch(name: string, values: Partial<PointerEvent> = {}) {
      const event = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: name === 'pointerup' ? 0 : 1, clientX: 400, clientY: 300, ...values };
      this.listeners.get(name)?.forEach(listener => listener(event as never));
    }
  }
  let nextFrame: FrameRequestCallback = () => {};
  let resize = (_width: number, _height: number) => {};
  vi.stubGlobal('document', { createElement: () => new Canvas(), pointerLockElement: null });
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { resize = (width, height) => this.callback([{ contentRect: { width, height } }] as ResizeObserverEntry[], this as unknown as ResizeObserver); resize(800, 600); }
    disconnect() {}
  });
  if (!probe.import.getMockImplementation()) probe.import.mockResolvedValue(imported());
  const part = source(), node = nodeFor(part);
  const props: PlaygroundViewportProps = { sources: [part], nodes: [node], baseline: [structuredClone(node)], selectedId: null,
    presentation: { view: 'proposed', explode: 0, labels: false, studio: true, hiddenIds: [], opacityById: {} }, interaction: 'orbit',
    onSelect: vi.fn(), onTransform: vi.fn(), onCameraChange: vi.fn(), onProjectionChange: vi.fn(), ...overrides };
  let status: PlaygroundSceneStatus | undefined;
  const engine = new PlaygroundEngine({ appendChild() {} } as unknown as HTMLDivElement, props, value => { status = value; }, () => {});
  engines.push(engine);
  const ready = async () => { await vi.waitFor(() => expect(status?.loading).toBe(false)); };
  const frame = () => nextFrame(1000);
  const meshes = () => { const found: Mesh[] = []; const scene = probe.render.mock.lastCall?.[0] as Scene; scene?.traverseVisible(object => { if (object instanceof Mesh && object.userData.nodeId) found.push(object); }); return found; };
  return { engine, props, part, node, ready, frame, resize, meshes, canvas: engine.canvas as unknown as Canvas, status: () => status };
}

describe('Playground incremental scene lifecycle', () => {
  it('imports one STEP for repeated occurrences and retains the same buffers across pose and appearance changes', async () => {
    const first = source(), second = source({ id: 'occ-2', position: [40, 0, 0] });
    const nodes = [nodeFor(first), nodeFor(second)];
    const h = harness({ sources: [first, second], nodes, baseline: structuredClone(nodes) }); await h.ready(); h.frame();
    const geometries = h.meshes().map(mesh => mesh.geometry);
    expect(probe.import).toHaveBeenCalledOnce(); expect(geometries[0]).toBe(geometries[1]);
    h.engine.update({ ...h.props, nodes: [{ ...nodes[0], position: [20, 5, 8], color: '#ff0000' }, nodes[1]] }); h.frame();
    expect(probe.import).toHaveBeenCalledOnce(); expect(h.meshes()[0].geometry).toBe(geometries[0]);
    expect(h.meshes()[0].parent!.position.toArray()).toEqual([20, 5, 8]);
  });
  it('does not redraw or walk geometry for callback-only and projection-feedback renders', async () => {
    const h = harness(); await h.ready(); h.frame(); probe.render.mockClear();
    const matrix = vi.spyOn(BufferGeometry.prototype, 'computeBoundingBox');
    const onSelect = vi.fn();
    for (let i = 0; i < 20; i++) { h.engine.update({ ...h.props, onSelect, onProjectionChange: vi.fn() }); h.frame(); }
    expect(probe.render).not.toHaveBeenCalled(); expect(matrix).not.toHaveBeenCalled();
    h.canvas.dispatch('pointerdown'); h.canvas.dispatch('pointerup');
    expect(onSelect).toHaveBeenCalledWith('occ-1'); expect(h.props.onSelect).not.toHaveBeenCalled();
  });
  it('leaves the baseline pose/color untouched and reassembles to the proposal pose', async () => {
    const h = harness(); await h.ready();
    const changed: ProposalNode = { ...h.node, position: [30, 0, 0], color: '#ff0000' };
    h.engine.update({ ...h.props, nodes: [changed], presentation: { ...h.props.presentation, explode: 0.8 } }); h.frame();
    expect(h.meshes()[0].parent!.position.toArray()).not.toEqual([30, 0, 0]);
    h.engine.update({ ...h.props, nodes: [changed] }); h.frame(); expect(h.meshes()[0].parent!.position.toArray()).toEqual([30, 0, 0]);
    h.engine.update({ ...h.props, nodes: [changed], presentation: { ...h.props.presentation, view: 'original' } }); h.frame();
    expect(h.meshes()[0].parent!.position.toArray()).toEqual([0, 0, 0]);
    expect((h.meshes()[0].material as MeshStandardMaterial).color.getHexString()).toBe('8899aa');
    h.engine.update({ ...h.props, nodes: [changed], presentation: { ...h.props.presentation, view: 'overlay', explode: 0.6 } }); h.frame();
    const [proposed, original] = h.meshes();
    expect(proposed.parent!.position.clone().sub(original.parent!.position).toArray()).toEqual([30, 0, 0]);
  });
  it('cancels obsolete source requests and refuses to display a stale response under a new edition', async () => {
    let release!: (value: ReturnType<typeof imported>) => void;
    probe.import.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(imported());
    const h = harness(); const firstSignal = probe.import.mock.calls[0][2] as AbortSignal;
    const next = source({ stepUrl: '/new-source.step', sourceHash: 'b'.repeat(64), position: [50, 0, 0] });
    const nextNode = nodeFor(next);
    h.engine.update({ ...h.props, sources: [next], nodes: [nextNode], baseline: [structuredClone(nextNode)] });
    expect(firstSignal.aborted).toBe(true); await h.ready(); release(imported()); await Promise.resolve(); await Promise.resolve(); h.frame();
    expect(h.meshes().length).toBe(1); expect(h.meshes()[0].parent!.position.toArray()).toEqual([50, 0, 0]);
    expect(h.status()?.errors).toEqual([]);
  });
  it('rejects capture when a raw STEP failed instead of using its optional mesh derivative', async () => {
    probe.import.mockRejectedValue(new Error('Hash mismatch'));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const sourceWithDerivative = source({ meshUrl: '/old-mesh.json' });
    const h = harness({ sources: [sourceWithDerivative] }); await h.ready();
    expect(fetch).not.toHaveBeenCalled(); expect(h.status()?.loaded).toBe(0);
    await expect(h.engine.capture()).rejects.toThrow('no available');
  });
  it('does not select after an orbit returning to its start, a pinch, or a source-changing gesture', async () => {
    const h = harness(); await h.ready(); h.frame();
    h.canvas.dispatch('pointerdown'); h.canvas.dispatch('pointermove', { clientX: 450 }); h.canvas.dispatch('pointermove'); h.canvas.dispatch('pointerup');
    h.canvas.dispatch('pointerdown'); h.canvas.dispatch('pointerdown', { pointerId: 2 }); h.canvas.dispatch('pointerup', { pointerId: 2 }); h.canvas.dispatch('pointerup');
    h.canvas.dispatch('pointerdown'); h.engine.update({ ...h.props, nodes: [{ ...h.node, position: [1, 0, 0] }] }); h.canvas.dispatch('pointerup');
    expect(h.props.onSelect).not.toHaveBeenCalled();
  });
  it('publishes viewport aspect changes for view-specific markup guards', async () => {
    const h = harness(); await h.ready();
    expect(h.engine.getCamera().aspect).toBeCloseTo(4 / 3);
    h.resize(400, 600);
    expect(h.engine.getCamera().aspect).toBeCloseTo(2 / 3);
    expect(h.props.onCameraChange).toHaveBeenLastCalledWith(expect.objectContaining({ aspect: 2 / 3 }));
  });
  it('treats opaque component IDs as own opacity keys and never uses inherited or nonfinite values', async () => {
    const part = source({ id: 'constructor' }), node = nodeFor(part);
    const h = harness({ sources: [part], nodes: [node], baseline: [structuredClone(node)] }); await h.ready(); h.frame();
    expect(h.meshes()).toHaveLength(1);
    expect((h.meshes()[0].material as MeshStandardMaterial).opacity).toBe(1);
    h.engine.update({ ...h.props, presentation: { ...h.props.presentation, opacityById: { constructor: NaN } } }); h.frame();
    expect(h.meshes()).toHaveLength(1);
    expect((h.meshes()[0].material as MeshStandardMaterial).opacity).toBe(1);
    h.engine.update({ ...h.props, presentation: { ...h.props.presentation, opacityById: { constructor: 0.4 } } }); h.frame();
    expect((h.meshes()[0].material as MeshStandardMaterial).opacity).toBe(0.4);
  });
  it('makes zero-opacity proposed and overlay geometry invisible and unpickable without changing product state', async () => {
    const h = harness(); await h.ready(); h.frame();
    const snapshot = structuredClone({ nodes: h.props.nodes, baseline: h.props.baseline });
    h.engine.update({ ...h.props, presentation: { ...h.props.presentation, view: 'overlay', opacityById: { 'occ-1': 0 } } }); h.frame();
    expect(h.meshes()).toEqual([]); expect(h.engine.pick(0.5, 0.5)).toBeNull(); expect(h.engine.project('occ-1', [0, 0, 0])).toBeNull();
    expect({ nodes: h.props.nodes, baseline: h.props.baseline }).toEqual(snapshot);
    expect(h.props.onTransform).not.toHaveBeenCalled();
    h.engine.update(h.props); h.frame(); expect(h.meshes()).toHaveLength(1);
    expect(h.engine.pick(0.5, 0.5)?.nodeId).toBe('occ-1');
  });
  it('pauses a hidden workspace and resumes the same assets and camera without an identity reload', async () => {
    const h = harness(); await h.ready(); h.frame();
    h.engine.restoreCamera({ position: [80, -140, 70], target: [2, 3, 4], aspect: 4 / 3 }); h.frame();
    const retainedCamera = h.engine.getCamera(), geometry = h.meshes()[0].geometry;
    probe.render.mockClear(); vi.mocked(h.props.onCameraChange!).mockClear(); vi.mocked(h.props.onProjectionChange!).mockClear();
    h.engine.update({ ...h.props, active: false }); h.resize(0, 0);
    for (let index = 0; index < 5; index++) h.frame();
    expect(probe.render).not.toHaveBeenCalled(); expect(h.props.onProjectionChange).not.toHaveBeenCalled();
    expect(h.engine.getCamera()).toEqual(retainedCamera);
    await expect(h.engine.capture()).rejects.toThrow('Open Playground');
    h.resize(400, 600); expect(h.props.onCameraChange).not.toHaveBeenCalled();
    h.engine.update({ ...h.props, active: true }); h.frame();
    expect(probe.import).toHaveBeenCalledOnce(); expect(probe.render).toHaveBeenCalledOnce();
    expect(h.meshes()[0].geometry).toBe(geometry);
    expect(h.engine.getCamera()).toEqual({ ...retainedCamera, aspect: 2 / 3 });
  });
  it('lets an authorized import finish while hidden without fitting or rendering until reopened', async () => {
    let release!: (value: ReturnType<typeof imported>) => void;
    probe.import.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const part = source({ position: [50, 0, 0] }), node = nodeFor(part);
    const h = harness({ sources: [part], nodes: [node], baseline: [structuredClone(node)] });
    const initialCamera = h.engine.getCamera(), signal = probe.import.mock.calls[0][2] as AbortSignal;
    h.engine.update({ ...h.props, active: false }); release(imported()); await h.ready(); h.frame();
    expect(signal.aborted).toBe(false); expect(h.status()?.loaded).toBe(1); expect(probe.render).not.toHaveBeenCalled();
    expect(h.engine.getCamera()).toEqual(initialCamera);
    h.engine.update({ ...h.props, active: true }); h.frame();
    expect(probe.import).toHaveBeenCalledOnce(); expect(h.engine.getCamera().target).toEqual([50, 0, 0]);
    expect(probe.render).toHaveBeenCalledOnce();
  });
  it('disposes shared geometry exactly once when the viewport is closed repeatedly', async () => {
    const h = harness(); await h.ready(); h.frame();
    const released = vi.fn(); h.meshes()[0].geometry.addEventListener('dispose', released);
    h.engine.dispose(); h.engine.dispose(); await Promise.resolve();
    expect(released).toHaveBeenCalledOnce();
  });
});
