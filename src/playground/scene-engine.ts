import {
  ACESFilmicToneMapping, AmbientLight, Box3, BufferAttribute, BufferGeometry, Color,
  DirectionalLight, DoubleSide, Float32BufferAttribute, GridHelper, Group, HemisphereLight,
  Mesh, MeshStandardMaterial, Object3D, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, Raycaster,
  Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { SoftwareRenderer } from '../components/model/SoftwareRenderer';
import { validateScenePlacement } from '../components/model/geometry';
import { readMeshSource } from '../components/model/mesh-source';
import { fetchViewerContent } from '../integrations/protectedContent';
import { importStepUrl } from '../cad/step-client';
import type { ScenePart, Vec3 } from '../components/model/types';
import type { CameraState, ProposalNode } from './types';
import { conceptGeometryKey, createConceptGeometry, explodedPosition, explosionOffset, playgroundAssetKey, proposalMatrix } from './geometry';

export interface PlaygroundPresentation {
  explode: number;
  hiddenIds: string[];
  opacityById: Record<string, number>;
  labels: boolean;
  view: 'proposed' | 'original' | 'overlay';
  studio: boolean;
}
export type PlaygroundInteraction = 'orbit' | 'translate' | 'rotate' | 'draw';
export interface PlaygroundSceneStatus {
  rendererMode: 'webgl' | 'software';
  loading: boolean;
  loaded: number;
  total: number;
  errors: string[];
  warnings: string[];
  geometryBytes: number;
}
export interface PlaygroundPick { nodeId: string; localPoint: Vec3; worldPoint: Vec3 }
export interface PlaygroundViewportHandle {
  getCamera(): CameraState;
  restoreCamera(camera: CameraState): void;
  fit(): void;
  orient(orientation: 'iso' | 'top' | 'front' | 'right'): void;
  capture(): Promise<string>;
  pick(u: number, v: number): PlaygroundPick | null;
  project(nodeId: string, localPoint: Vec3): [number, number] | null;
}
export interface PlaygroundViewportProps {
  /** Retain the scene/session while another universal-viewer tab is active. */
  active?: boolean;
  sources: ScenePart[];
  nodes: ProposalNode[];
  baseline: ProposalNode[];
  selectedId?: string | null;
  onSelect(id: string | null): void;
  onTransform(id: string, position: Vec3, rotation: Vec3): void;
  presentation: PlaygroundPresentation;
  interaction: PlaygroundInteraction;
  onStatus?(status: PlaygroundSceneStatus): void;
  onCameraChange?(camera: CameraState): void;
  /** Reproject mesh-attached markups after a scene pose, explode state or source finishes changing. */
  onProjectionChange?(): void;
  className?: string;
}
export interface SceneLabel {
  id: string; name: string; itemNumber?: string; selected: boolean;
  x: number; y: number; labelX: number; labelY: number;
}
type Asset = { geometry: BufferGeometry; bytes: number; warnings: string[] };
type AssetRequest = { promise: Promise<Asset>; controller: AbortController; asset?: Asset };
type Entry = { key: string; node: ProposalNode; original: boolean; group: Group; mesh: Mesh<BufferGeometry, MeshStandardMaterial>; ownsGeometry: boolean; geometryBytes: number; offset: Vec3 };
const MAX_GEOMETRY_BYTES = 96 * 1024 * 1024;
const MAX_LABELS = 40;
function opacityFor(values: Record<string, number>, id: string): number {
  const value = Object.hasOwn(values, id) ? values[id] : 1;
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** Incremental mesh scene. Poses/materials change in place; STEP assets remain shared and immutable. */
export class PlaygroundEngine implements PlaygroundViewportHandle {
  readonly canvas: HTMLCanvasElement;
  private scene = new Scene();
  private camera = new PerspectiveCamera(36, 1, 0.1, 20000);
  private renderer: WebGLRenderer | SoftwareRenderer;
  private controls: OrbitControls;
  private transform: TransformControls;
  private transformHelper: Object3D;
  private keyLight: DirectionalLight;
  private floor: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private grid: GridHelper;
  private entries = new Map<string, Entry>();
  private cache = new Map<string, AssetRequest>();
  private sourceErrors = new Map<string, string>();
  private sources = new Map<string, ScenePart>();
  private props: PlaygroundViewportProps;
  private status: PlaygroundSceneStatus;
  private statusListener: (status: PlaygroundSceneStatus) => void;
  private labelsListener: (labels: SceneLabel[]) => void;
  private labels: SceneLabel[] = [];
  private disposed = false;
  private generation = 0;
  private sourceSignature = '';
  private frame = 0;
  private renderDirty = true;
  private geometryBytes = 0;
  private lastRender = 0;
  private sceneSpan = 100;
  private firstFit = true;
  private resizeObserver: ResizeObserver;
  private size = { width: 1, height: 1 };
  private pendingSize?: { width: number; height: number };
  private pointerStart: { x: number; y: number; id: number; moved: boolean } | null = null;
  private activePointers = new Set<number>();
  private dragging = false;
  private contextLost = false;
  private appliedProps?: PlaygroundViewportProps;
  private presentationKey = '';
  private dragStart?: { id: string; position: Vec3; rotation: Vec3 };
  private raycaster = new Raycaster();

  constructor(container: HTMLDivElement, props: PlaygroundViewportProps, status: (status: PlaygroundSceneStatus) => void, labels: (labels: SceneLabel[]) => void) {
    this.props = props; this.statusListener = status; this.labelsListener = labels;
    let rendererMode: 'webgl' | 'software' = 'webgl';
    try {
      const canvas = document.createElement('canvas');
      const forced = new URLSearchParams(location.search).get('renderer') === 'software';
      const context = forced ? null : canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
      if (!context) throw new Error('WebGL2 unavailable');
      this.renderer = new WebGLRenderer({ canvas, context, antialias: true, alpha: false });
    } catch { this.renderer = new SoftwareRenderer(); rendererMode = 'software'; }
    this.status = { rendererMode, loading: false, loaded: 0, total: 0, errors: [], warnings: [], geometryBytes: 0 };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, rendererMode === 'software' ? 1 : 1.75));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.enabled = rendererMode === 'webgl';
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.dataset.renderer = rendererMode;
    this.canvas.className = 'playground-scene-canvas';
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Interactive product proposal. Drag to orbit, right-drag to pan, scroll to zoom. Select components from the parts panel for keyboard editing.');
    container.appendChild(this.canvas);
    this.camera.up.set(0, 0, 1); this.camera.position.set(260, -320, 240);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.65; this.controls.panSpeed = 0.7;
    this.controls.minDistance = 0.1; this.controls.maxDistance = 10_000_000;
    this.controls.addEventListener('change', this.cameraChanged);
    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSpace('world'); this.transform.setSize(0.85);
    this.transformHelper = this.transform.getHelper(); this.scene.add(this.transformHelper);
    this.transform.addEventListener('change', this.markDirty);
    this.transform.addEventListener('mouseDown', this.transformStart);
    this.transform.addEventListener('mouseUp', this.transformEnd);
    this.scene.add(new HemisphereLight('#d5e6ff', '#33434a', 2.5), new AmbientLight('#f4fbff', 0.65));
    this.keyLight = new DirectionalLight('#fff2e0', 3.6);
    this.keyLight.castShadow = true; this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.bias = -0.0004; this.keyLight.shadow.normalBias = 0.25;
    this.scene.add(this.keyLight, this.keyLight.target);
    const rim = new DirectionalLight('#72dfd7', 2.6); rim.position.set(250, 260, 300); this.scene.add(rim);
    const fill = new DirectionalLight('#b6c7ff', 1.6); fill.position.set(-250, 100, 80); this.scene.add(fill);
    this.floor = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ color: '#101d27', roughness: 0.87, metalness: 0.12 }));
    this.floor.receiveShadow = true; this.scene.add(this.floor);
    this.grid = new GridHelper(1, 20, '#617c91', '#263e50'); this.grid.rotation.x = Math.PI / 2; this.scene.add(this.grid);
    this.canvas.addEventListener('pointerdown', this.pointerDown);
    this.canvas.addEventListener('pointermove', this.pointerMove);
    this.canvas.addEventListener('pointerup', this.pointerUp);
    this.canvas.addEventListener('pointercancel', this.cancelGesture);
    window.addEventListener('blur', this.cancelGesture);
    this.canvas.addEventListener('keydown', this.keyDown);
    this.canvas.addEventListener('contextmenu', this.preventContext);
    this.canvas.addEventListener('webglcontextlost', this.contextLostHandler);
    this.canvas.addEventListener('webglcontextrestored', this.contextRestoredHandler);
    this.resizeObserver = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      // display:none must not replace the last useful aspect/camera with 1:1.
      if (width < 2 || height < 2) return;
      if (this.props.active === false) { this.pendingSize = { width, height }; return; }
      this.applySize(width, height);
    });
    this.resizeObserver.observe(container);
    this.update(props); this.updateRunning();
  }

  private publish(patch: Partial<PlaygroundSceneStatus> = {}) {
    const next = { ...this.status, ...patch, geometryBytes: this.geometryBytes };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    if (!this.disposed) this.statusListener(next);
  }
  private markDirty = () => { this.renderDirty = true; };
  private cameraChanged = () => { this.markDirty(); this.props.onCameraChange?.(this.getCamera()); };
  private preventContext = (event: Event) => event.preventDefault();
  private contextLostHandler = (event: Event) => {
    event.preventDefault(); this.cancelGesture(); this.contextLost = true;
    this.publish({ errors: ['The graphics context was lost. Wait for recovery, or reopen Playground.'] });
  };
  private contextRestoredHandler = () => { this.contextLost = false; this.syncEntries(); this.markDirty(); };

  update(props: PlaygroundViewportProps) {
    this.props = props;
    const presentationKey = JSON.stringify(props.presentation);
    const before = this.appliedProps;
    if (before && before.sources === props.sources && before.nodes === props.nodes && before.baseline === props.baseline
      && before.selectedId === props.selectedId && before.interaction === props.interaction
      && (before.active !== false) === (props.active !== false) && presentationKey === this.presentationKey) return;
    // An undo, accepted AI batch, selection switch or presentation change can
    // arrive while a pointer is down. Do not commit a gesture against old data.
    if (this.dragging) this.cancelGesture();
    this.pointerStart = null;
    this.appliedProps = props; this.presentationKey = presentationKey;
    if (props.active !== false && this.pendingSize) { const { width, height } = this.pendingSize; this.pendingSize = undefined; this.applySize(width, height); }
    const signature = before?.sources === props.sources ? this.sourceSignature : JSON.stringify(props.sources.map(source => [source.id, playgroundAssetKey(source)]));
    if (signature !== this.sourceSignature) {
      this.sourceSignature = signature; this.sources = new Map(props.sources.map(source => [source.id, source]));
      const needed = new Set(props.sources.map(playgroundAssetKey));
      for (const [key, request] of this.cache) if (!needed.has(key)) this.releaseAsset(key, request);
      this.sourceErrors.clear();
      void this.loadSources(++this.generation);
    }
    this.syncEntries(); this.updateRunning();
  }

  private async loadSources(generation: number) {
    const sources = [...new Map([...this.sources.values()].map(source => [playgroundAssetKey(source), source])).values()];
    this.publish({ loading: sources.length > 0 });
    // Bounded concurrency avoids overflowing the shared local STEP worker queue.
    let index = 0;
    const load = async () => {
      while (!this.disposed && generation === this.generation && index < sources.length) {
        const source = sources[index++]; const key = playgroundAssetKey(source);
        try { await this.loadAsset(source); }
        catch (error) {
          if (!this.disposed && generation === this.generation) this.sourceErrors.set(key, error instanceof Error ? error.message : 'Source geometry could not load.');
        }
        if (!this.disposed && generation === this.generation) this.syncEntries();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, load));
    if (this.disposed || generation !== this.generation) return;
    this.syncEntries(); this.publish({ loading: false });
    if (this.firstFit && this.entries.size && this.props.active !== false) { this.orient('iso'); this.firstFit = false; }
  }

  private loadAsset(source: ScenePart): Promise<Asset> {
    const key = playgroundAssetKey(source), cached = this.cache.get(key);
    if (cached) return cached.promise;
    const controller = new AbortController();
    const request = {} as AssetRequest;
    const promise = (async () => {
      let data: { positions: number[] | Float32Array; normals?: number[] | Float32Array; indices: number[] | Uint32Array };
      let warnings: string[] = [];
      if (source.stepUrl) {
        const result = await importStepUrl(source.stepUrl, source.sourceHash, controller.signal, source.cadNodePath, source.sourceToPart);
        data = result; warnings = result.warnings;
      } else {
        if (!source.meshUrl) throw new Error('The occurrence has no available STEP or display mesh.');
        data = await readMeshSource(signal => fetchViewerContent(source.meshUrl!, signal), controller.signal);
      }
      controller.signal.throwIfAborted();
      const bytes = data.positions.length * 8 + data.indices.length * 4;
      if (this.geometryBytes + bytes > MAX_GEOMETRY_BYTES) throw new Error('This Playground reached its 96 MiB geometry budget. Open a smaller assembly.');
      const geometry = new BufferGeometry();
      try {
        geometry.setAttribute('position', data.positions instanceof Float32Array ? new BufferAttribute(data.positions, 3) : new Float32BufferAttribute(data.positions, 3));
        geometry.setIndex(data.indices instanceof Uint32Array ? new BufferAttribute(data.indices, 1) : data.indices);
        if (data.normals) geometry.setAttribute('normal', data.normals instanceof Float32Array ? new BufferAttribute(data.normals, 3) : new Float32BufferAttribute(data.normals, 3));
        else geometry.computeVertexNormals();
        geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        controller.signal.throwIfAborted();
        const actualBytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0) + (geometry.index?.array.byteLength ?? 0);
        if (this.geometryBytes + actualBytes > MAX_GEOMETRY_BYTES) throw new Error('This Playground reached its geometry memory budget.');
        this.geometryBytes += actualBytes;
        const asset = { geometry, bytes: actualBytes, warnings }; request.asset = asset;
        return asset;
      } catch (error) { geometry.dispose(); throw error; }
    })();
    request.promise = promise; request.controller = controller; this.cache.set(key, request);
    // A failed import must not be remembered as the answer: the next load tries the source again.
    promise.catch(() => { if (this.cache.get(key) === request) this.cache.delete(key); });
    return promise;
  }

  private releaseAsset(key: string, request: AssetRequest) {
    this.cache.delete(key); request.controller.abort();
    void request.promise.then(asset => { this.geometryBytes = Math.max(0, this.geometryBytes - asset.bytes); asset.geometry.dispose(); }).catch(() => {});
  }

  private removeEntry(key: string, entry: Entry) {
    if (this.transform.object === entry.group) this.transform.detach();
    this.scene.remove(entry.group); entry.mesh.material.dispose();
    if (entry.ownsGeometry) { entry.mesh.geometry.dispose(); this.geometryBytes = Math.max(0, this.geometryBytes - entry.geometryBytes); }
    this.entries.delete(key);
  }

  private syncEntries() {
    if (this.disposed) return;
    const desired = new Map<string, { node: ProposalNode; original: boolean }>();
    for (const node of this.props.nodes) if (!node.removed) desired.set(`proposal:${node.id}`, { node, original: false });
    for (const node of this.props.baseline) if (!node.removed) desired.set(`original:${node.id}`, { node, original: true });
    for (const [key, entry] of this.entries) if (!desired.has(key)) this.removeEntry(key, entry);
    const errors: string[] = [], warnings = new Set<string>();
    for (const [key, { node, original }] of desired) {
      let geometry: BufferGeometry | undefined, geometryKey: string;
      let ownsGeometry = false;
      if (node.kind === 'source') {
        const source = this.sources.get(node.sourceId ?? node.id);
        if (!source) {
          errors.push(`${node.name}: the exact source occurrence is unavailable.`);
          const previous = this.entries.get(key); if (previous) this.removeEntry(key, previous);
          continue;
        }
        geometryKey = playgroundAssetKey(source);
        const asset = this.cache.get(geometryKey)?.asset;
        const error = this.sourceErrors.get(geometryKey);
        if (error) errors.push(`${node.name}: ${error}`);
        if (!asset) {
          const previous = this.entries.get(key); if (previous) this.removeEntry(key, previous);
          continue;
        }
        geometry = asset.geometry; asset.warnings.forEach(warning => warnings.add(warning));
      } else {
        geometryKey = conceptGeometryKey(node); ownsGeometry = true;
        const previous = this.entries.get(key);
        if (previous?.key === geometryKey) geometry = previous.mesh.geometry;
        else {
          try { geometry = createConceptGeometry(node); }
          catch (error) {
            errors.push(`${node.name}: ${error instanceof Error ? error.message : 'The concept shape is invalid.'}`);
            if (previous) this.removeEntry(key, previous);
            continue;
          }
        }
      }
      try { validateScenePlacement(node, geometry.boundingBox); }
      catch (error) {
        errors.push(`${node.name}: ${error instanceof Error ? error.message : 'Invalid placement.'}`);
        if (ownsGeometry && this.entries.get(key)?.mesh.geometry !== geometry) geometry.dispose();
        const previous = this.entries.get(key); if (previous) this.removeEntry(key, previous);
        continue;
      }
      let entry = this.entries.get(key);
      if (entry && entry.key !== geometryKey) { this.removeEntry(key, entry); entry = undefined; }
      if (!entry) {
        const bytes = ownsGeometry ? Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0) + (geometry.index?.array.byteLength ?? 0) : 0;
        if (this.geometryBytes + bytes > MAX_GEOMETRY_BYTES) {
          if (ownsGeometry) geometry.dispose();
          errors.push(`${node.name}: this Playground reached its geometry memory budget.`); continue;
        }
        this.geometryBytes += bytes;
        const material = new MeshStandardMaterial({ color: node.color, metalness: 0.3, roughness: 0.36, side: DoubleSide });
        const mesh = new Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.userData.nodeId = node.id;
        const group = new Group(); group.add(mesh); this.scene.add(group);
        entry = { key: geometryKey, node, original, group, mesh, ownsGeometry, geometryBytes: bytes, offset: [0, 0, 0] };
        this.entries.set(key, entry);
      }
      entry.node = node;
    }
    const installed = this.installedBounds();
    const offsets = new Map<string, Vec3>();
    const primaryOriginal = this.props.presentation.view === 'original';
    for (const entry of this.entries.values()) if (entry.original === primaryOriginal) {
      offsets.set(entry.node.id, explosionOffset(entry.mesh.geometry.boundingBox!, entry.node, installed));
    }
    for (const entry of this.entries.values()) {
      // A baseline/proposal pair receives the same display offset, preserving
      // the actual pose difference when the comparison is exploded.
      entry.offset = offsets.get(entry.node.id) ?? explosionOffset(entry.mesh.geometry.boundingBox!, entry.node, installed);
      this.displayEntry(entry);
    }
    this.updateEnvironment(installed); this.updateInteraction(); this.markDirty();
    const shownNodes = this.props.presentation.view === 'original' ? this.props.baseline : this.props.nodes;
    const groupPrefix = this.props.presentation.view === 'original' ? 'original:' : 'proposal:';
    this.publish({ loaded: shownNodes.filter(node => !node.removed && this.entries.has(`${groupPrefix}${node.id}`)).length,
      total: shownNodes.filter(node => !node.removed).length, errors: [...new Set(errors)], warnings: [...warnings] });
    if (this.firstFit && this.entries.size && !this.status.loading && this.props.active !== false) { this.orient('iso'); this.firstFit = false; }
  }

  private displayEntry(entry: Entry) {
    const { presentation, selectedId } = this.props;
    const opacity = opacityFor(presentation.opacityById, entry.node.id);
    if (!this.dragging || this.transform.object !== entry.group) {
      entry.group.position.set(...explodedPosition(entry.node.position, entry.offset, presentation.explode));
      entry.group.rotation.set(...entry.node.rotation, 'XYZ');
    }
    entry.group.visible = opacity > 0 && !presentation.hiddenIds.includes(entry.node.id)
      && (entry.original ? presentation.view !== 'proposed' : presentation.view !== 'original');
    const ghost = entry.original && presentation.view === 'overlay';
    const material = entry.mesh.material;
    material.color.set(ghost ? '#e9a18b' : entry.node.color);
    material.opacity = ghost ? Math.min(opacity, 0.22) : opacity;
    material.transparent = material.opacity < 1; material.depthWrite = !ghost && opacity > 0.9;
    entry.mesh.castShadow = !ghost && opacity > 0.8;
    material.emissive.set(entry.node.id === selectedId && !ghost ? '#106b65' : '#000000');
    material.emissiveIntensity = entry.node.id === selectedId ? 0.5 : 0;
    entry.group.updateMatrixWorld(true);
  }

  private installedBounds(): Box3 {
    const bounds = new Box3();
    for (const entry of this.entries.values()) {
      if (this.props.presentation.view === 'original' ? !entry.original : entry.original) continue;
      if (this.props.presentation.hiddenIds.includes(entry.node.id) || opacityFor(this.props.presentation.opacityById, entry.node.id) === 0) continue;
      bounds.union(entry.mesh.geometry.boundingBox!.clone().applyMatrix4(proposalMatrix(entry.node)));
    }
    if (bounds.isEmpty()) bounds.set(new Vector3(-50, -50, -30), new Vector3(50, 50, 70));
    return bounds;
  }

  private displayedBounds(): Box3 {
    const bounds = new Box3();
    for (const entry of this.entries.values()) if (entry.group.visible) bounds.union(entry.mesh.geometry.boundingBox!.clone().applyMatrix4(entry.group.matrixWorld));
    return bounds.isEmpty() ? this.installedBounds() : bounds;
  }

  private updateEnvironment(bounds: Box3) {
    const center = bounds.getCenter(new Vector3()), size = Math.max(20, ...bounds.getSize(new Vector3()).toArray());
    this.sceneSpan = size;
    this.scene.background = new Color(this.props.presentation.studio ? '#0b1620' : '#e9eff3');
    this.floor.material.color.set(this.props.presentation.studio ? '#10212c' : '#e1e8ec');
    this.floor.position.set(center.x, center.y, bounds.min.z - size * 0.025); this.floor.scale.set(size * 8, size * 8, 1);
    this.grid.position.copy(this.floor.position); this.grid.position.z += size * 0.001; this.grid.scale.setScalar(size * 3);
    this.grid.visible = !this.props.presentation.studio;
    this.keyLight.position.set(center.x - size, center.y - size * 1.8, center.z + size * 2.6);
    this.keyLight.target.position.copy(center);
    const shadow = this.keyLight.shadow.camera;
    shadow.left = shadow.bottom = -size * 1.8; shadow.right = shadow.top = size * 1.8;
    shadow.near = Math.max(0.01, size * 0.001); shadow.far = size * 8; shadow.updateProjectionMatrix();
    this.keyLight.shadow.normalBias = size * 0.001;
  }

  private updateInteraction() {
    this.controls.enabled = this.props.active !== false && this.props.interaction !== 'draw' && !this.dragging;
    this.canvas.style.cursor = this.props.interaction === 'draw' ? 'crosshair' : this.props.interaction === 'orbit' ? 'grab' : 'default';
    const entry = this.props.selectedId && this.entries.get(`proposal:${this.props.selectedId}`);
    const editable = this.props.active !== false && (this.props.interaction === 'translate' || this.props.interaction === 'rotate')
      && this.props.presentation.view !== 'original' && this.props.presentation.explode === 0 && entry && entry.group.visible;
    this.transform.enabled = Boolean(editable);
    if (editable) { this.transform.setMode(this.props.interaction as 'translate' | 'rotate'); this.transform.attach(entry.group); }
    else this.transform.detach();
  }

  private transformStart = () => {
    const entry = [...this.entries.values()].find(value => value.group === this.transform.object);
    if (!entry) return;
    this.dragging = true; this.controls.enabled = false; this.pointerStart = null;
    this.dragStart = { id: entry.node.id, position: [...entry.node.position], rotation: [...entry.node.rotation] };
  };
  private transformEnd = () => {
    const start = this.dragStart; this.dragStart = undefined; this.dragging = false;
    const object = this.transform.object;
    this.updateInteraction();
    if (!start || !object) return;
    const position = object.position.toArray() as Vec3;
    const rotation: Vec3 = [object.rotation.x, object.rotation.y, object.rotation.z];
    const changed = [...position, ...rotation].some((value, index) => Math.abs(value - [...start.position, ...start.rotation][index]) > 1e-8);
    if (!changed) return;
    if (![...position, ...rotation].every(Number.isFinite) || position.some(value => Math.abs(value) > 1_000_000)) {
      object.position.set(...start.position); object.rotation.set(...start.rotation); this.markDirty(); return;
    }
    this.props.onTransform(start.id, position, rotation);
  };
  private cancelGesture = () => {
    if (this.dragStart && this.transform.object) {
      this.transform.object.position.set(...this.dragStart.position); this.transform.object.rotation.set(...this.dragStart.rotation);
    }
    this.dragStart = undefined; this.dragging = false; this.pointerStart = null; this.activePointers.clear();
    this.transform.reset(); this.transform.dragging = false; this.updateInteraction(); this.markDirty();
  };
  private keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && this.dragging) { event.preventDefault(); this.cancelGesture(); } };
  private pointerDown = (event: PointerEvent) => {
    this.activePointers.add(event.pointerId);
    if (this.activePointers.size > 1) { this.pointerStart = null; return; }
    if (event.button !== 0 || this.props.interaction === 'draw') return;
    this.canvas.focus({ preventScroll: true });
    if (!this.dragging) this.pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
  };
  private pointerMove = (event: PointerEvent) => {
    if (this.pointerStart?.id === event.pointerId && Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) this.pointerStart.moved = true;
  };
  private pointerUp = (event: PointerEvent) => {
    const start = this.pointerStart; this.pointerStart = null;
    const multiple = this.activePointers.size > 1; this.activePointers.delete(event.pointerId);
    if (!start || start.moved || multiple || start.id !== event.pointerId || this.dragging || this.props.interaction === 'draw'
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.pick((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    this.props.onSelect(hit?.nodeId ?? null);
  };

  getCamera(): CameraState { return { position: this.camera.position.toArray() as Vec3, target: this.controls.target.toArray() as Vec3, aspect: this.camera.aspect }; }
  restoreCamera(state: CameraState) {
    if (this.props.active === false) return;
    if (![...state.position, ...state.target].every(Number.isFinite) || new Vector3(...state.position).distanceTo(new Vector3(...state.target)) < 0.001) return;
    this.camera.position.set(...state.position); this.controls.target.set(...state.target);
    this.controls.update(); this.markDirty();
  }
  /** Try the sources that failed to load again, without disturbing the ones that loaded. */
  retrySources() {
    if (this.disposed || !this.sourceErrors.size) return;
    this.sourceErrors.clear();
    void this.loadSources(++this.generation);
  }
  fit() {
    if (this.props.active === false) return;
    const bounds = this.displayedBounds(); const center = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const radius = Math.max(1, size.length() / 2);
    const verticalFov = this.camera.fov * Math.PI / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.13;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!direction.lengthSq()) direction.set(1, -1, 0.8).normalize();
    this.controls.target.copy(center); this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(0.001, radius / 2000); this.camera.far = Math.max(1000, distance + radius * 30);
    this.camera.updateProjectionMatrix(); this.controls.update(); this.markDirty();
  }
  orient(orientation: 'iso' | 'top' | 'front' | 'right') {
    if (this.props.active === false) return;
    const direction = orientation === 'top' ? new Vector3(0, -0.00001, 1)
      : orientation === 'front' ? new Vector3(0, -1, 0) : orientation === 'right' ? new Vector3(1, 0, 0) : new Vector3(1.1, -1.55, 0.95);
    this.camera.position.copy(this.controls.target).add(direction); this.fit();
  }
  pick(u: number, v: number): PlaygroundPick | null {
    if (![u, v].every(Number.isFinite) || u < 0 || v < 0 || u > 1 || v > 1) return null;
    this.scene.updateMatrixWorld(true); this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new Vector2(u * 2 - 1, 1 - v * 2), this.camera);
    const original = this.props.presentation.view === 'original';
    const entries = [...this.entries.values()].filter(entry => entry.group.visible && entry.original === original);
    const hits = this.raycaster.intersectObjects(entries.map(entry => entry.mesh), false);
    const hit = hits[0]; if (!hit) return null;
    const entry = entries.find(candidate => candidate.mesh === hit.object)!;
    return { nodeId: entry.node.id, localPoint: entry.group.worldToLocal(hit.point.clone()).toArray() as Vec3, worldPoint: hit.point.toArray() as Vec3 };
  }
  project(nodeId: string, localPoint: Vec3): [number, number] | null {
    const prefix = this.props.presentation.view === 'original' ? 'original:' : 'proposal:';
    const entry = this.entries.get(`${prefix}${nodeId}`); if (!entry?.group.visible) return null;
    entry.group.updateMatrixWorld(true); this.camera.updateMatrixWorld(true);
    const projected = new Vector3(...localPoint).applyMatrix4(entry.group.matrixWorld).project(this.camera);
    if (projected.z < -1 || projected.z > 1) return null;
    return [(projected.x + 1) / 2, (1 - projected.y) / 2];
  }

  private projectLabels(): SceneLabel[] {
    if (!this.props.presentation.labels) return [];
    const original = this.props.presentation.view === 'original';
    const available = [...this.entries.values()].filter(entry => entry.original === original && entry.group.visible);
    available.sort((a, b) => Number(b.node.id === this.props.selectedId) - Number(a.node.id === this.props.selectedId));
    const labels: SceneLabel[] = [];
    const lanes: number[] = [];
    for (const entry of available.slice(0, MAX_LABELS)) {
      const center = entry.mesh.geometry.boundingBox!.getCenter(new Vector3()).toArray() as Vec3;
      const point = this.project(entry.node.id, center);
      if (!point || point[0] < 0.03 || point[0] > 0.97 || point[1] < 0.03 || point[1] > 0.95) continue;
      const x = point[0] * this.size.width, y = point[1] * this.size.height;
      let labelY = Math.max(12, y - 20);
      while (lanes.some(taken => Math.abs(taken - labelY) < 31)) labelY += 32;
      if (labelY > this.size.height - 70) continue;
      lanes.push(labelY);
      const labelX = x < this.size.width / 2 ? Math.max(10, x - 195) : Math.min(this.size.width - 174, x + 48);
      labels.push({ id: entry.node.id, name: entry.node.name, itemNumber: entry.node.itemNumber, selected: entry.node.id === this.props.selectedId,
        x, y, labelX, labelY: Math.max(12, labelY) });
    }
    return labels;
  }

  private animate = (time = 0) => {
    this.frame = 0;
    if (this.disposed || this.props.active === false) return;
    this.frame = requestAnimationFrame(this.animate);
    if (this.controls.enabled) this.controls.update();
    if (!this.renderDirty || this.contextLost || this.size.width <= 1 || this.size.height <= 1) return;
    if (this.status.rendererMode === 'software' && time - this.lastRender < 65) return;
    this.updateClipping();
    this.renderer.render(this.scene, this.camera); this.lastRender = time; this.renderDirty = false;
    this.labels = this.projectLabels(); this.labelsListener(this.labels); this.props.onProjectionChange?.();
  };

  private updateRunning() {
    if (this.disposed || this.props.active === false) { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; return; }
    if (!this.frame) this.frame = requestAnimationFrame(this.animate);
  }

  private applySize(width: number, height: number) {
    if (this.size.width === width && this.size.height === height) return;
    this.size = { width, height }; this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.cameraChanged();
  }

  private updateClipping() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.001, Math.min(this.sceneSpan / 1000, distance / 10000));
    const far = Math.max(1000, distance + this.sceneSpan * 20);
    if (this.camera.near !== near || this.camera.far !== far) {
      this.camera.near = near; this.camera.far = far; this.camera.updateProjectionMatrix();
    }
  }

  async capture(): Promise<string> {
    if (this.props.active === false) throw new Error('Open Playground before capturing its view.');
    if (this.size.width < 2 || this.size.height < 2) throw new Error('Open a visible 3D viewport before capturing a proposal.');
    if (this.status.loading) throw new Error('Wait for the source geometry to finish loading before capturing a proposal.');
    if (!this.status.loaded || this.contextLost) throw new Error('There is no available rendered proposal to capture.');
    if (this.status.errors.length) throw new Error('Resolve the missing or invalid source geometry before capturing an engineering proposal.');
    const wasVisible = this.transformHelper.visible; this.transformHelper.visible = false;
    try {
      this.updateClipping();
      this.renderer.render(this.scene, this.camera);
      const output = document.createElement('canvas');
      const scale = Math.min(1, 1920 / this.canvas.width, 1200 / this.canvas.height);
      output.width = Math.max(1, Math.round(this.canvas.width * scale)); output.height = Math.max(1, Math.round(this.canvas.height * scale));
      const context = output.getContext('2d'); if (!context) throw new Error('Image capture is unavailable in this browser.');
      context.drawImage(this.canvas, 0, 0, output.width, output.height);
      const sx = output.width / this.size.width, sy = output.height / this.size.height;
      context.scale(sx, sy); context.font = '11px sans-serif'; context.lineWidth = 1;
      for (const label of this.projectLabels()) {
        context.strokeStyle = '#91c9c6'; context.beginPath(); context.moveTo(label.x, label.y);
        context.lineTo(label.labelX + (label.labelX > label.x ? 0 : 164), label.labelY + 12); context.stroke();
        context.fillStyle = '#10242f'; context.fillRect(label.labelX, label.labelY, 164, 26);
        context.strokeRect(label.labelX, label.labelY, 164, 26); context.fillStyle = '#e7f6f5';
        context.fillText(`${label.itemNumber ? `${label.itemNumber} · ` : ''}${label.name}`.slice(0, 27), label.labelX + 7, label.labelY + 17);
      }
      return output.toDataURL('image/png');
    } finally { this.transformHelper.visible = wasVisible; this.markDirty(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; ++this.generation; cancelAnimationFrame(this.frame); this.resizeObserver.disconnect();
    this.controls.dispose(); this.transform.dispose();
    this.canvas.removeEventListener('pointerdown', this.pointerDown); this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointercancel', this.cancelGesture); this.canvas.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('blur', this.cancelGesture);
    this.canvas.removeEventListener('contextmenu', this.preventContext);
    this.canvas.removeEventListener('webglcontextlost', this.contextLostHandler); this.canvas.removeEventListener('webglcontextrestored', this.contextRestoredHandler);
    for (const [key, entry] of this.entries) this.removeEntry(key, entry);
    for (const [key, request] of this.cache) this.releaseAsset(key, request);
    this.floor.geometry.dispose(); this.floor.material.dispose(); this.grid.geometry.dispose();
    const gridMaterial = this.grid.material;
    if (Array.isArray(gridMaterial)) gridMaterial.forEach(material => material.dispose()); else gridMaterial.dispose();
    this.keyLight.shadow.map?.dispose(); this.renderer.dispose(); this.canvas.remove();
  }
}
