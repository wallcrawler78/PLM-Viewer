import {
  ACESFilmicToneMapping, AmbientLight, Box3, Box3Helper, BufferAttribute, BufferGeometry, Color,
  DirectionalLight, DoubleSide, EdgesGeometry, Float32BufferAttribute, GridHelper,
  Group, HemisphereLight, Line, LineBasicMaterial, LineDashedMaterial, LineSegments,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Plane,
  PlaneGeometry, Raycaster, Scene, SphereGeometry, SRGBColorSpace, Vector2, Vector3,
  WebGLRenderer, PCFSoftShadowMap, ShadowMaterial,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SoftwareRenderer } from './SoftwareRenderer';
import { boundsForParts, localToAssembled, occurrenceMatrix, pointDistance, selectedVisibleParts, validateScenePlacement, vec } from './geometry';
import { readMeshSource } from './mesh-source';
import type { CameraState, MeasurementResult, ModelViewportProps, SceneBounds, ScenePart, Vec3, ViewerStatus } from './types';
import { fetchViewerContent } from '../../integrations/protectedContent';
import { importStepUrl } from '../../cad/step-client';
import type { CadHierarchyNode, CadMeshRange } from '../../cad/step-types';

type ModelEntry = {
  part: ScenePart;
  baseline: boolean;
  group: Group;
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  edges: LineSegments<EdgesGeometry, LineBasicMaterial>;
  explodeDirection: Vector3;
};
type GeometryAsset = { geometry: BufferGeometry; edges: EdgesGeometry; memoryBytes: number; warnings: string[]; cad?: { hierarchy: CadHierarchyNode; meshRanges: CadMeshRange[] } };
type GeometryRequest = { promise: Promise<GeometryAsset>; controller: AbortController };
type PickPoint = { local: Vec3; assembled: Vec3; occurrenceId: string };
type PendingMeasurement = { result: MeasurementResult; sourceKey: string; resetKey?: number };

const ACCENT = '#0f8f88';
const BASELINE = '#ed785d';
const CURRENT = '#25b5ac';
const MAX_SCENE_GEOMETRY_BYTES = 96 * 1024 * 1024;
const MAX_EDGE_TRIANGLES = 120_000;

// Callbacks and source labels can change when the surrounding document/notes UI
// renders. They must stay current without walking every model or redrawing it.
// Arrays and nested display values follow the immutable-props contract.
const SCENE_INPUTS = [
  'parts', 'comparisonParts', 'mode', 'selectedIds', 'hiddenIds', 'opacityById',
  'explode', 'section', 'measurementMode', 'anchorMode', 'viewCommand',
  'cameraState', 'cameraRestoreKey', 'measurementResetKey', 'showBoundingBox',
  'overlayOpacity', 'anchors', 'renderQuality',
] as const satisfies readonly (keyof ModelViewportProps)[];
function sameSceneInputs(before: ModelViewportProps, after: ModelViewportProps) {
  return SCENE_INPUTS.every(key => before[key] === after[key]);
}

function assetKey(part: ScenePart): string {
  return JSON.stringify([part.stepUrl ? 'step' : 'mesh', part.stepUrl ?? part.meshUrl ?? null, part.sourceHash ?? null,
    part.stepUrl ? part.cadNodePath ?? [] : null,
    part.stepUrl ? [part.sourceToPart?.position ?? null, part.sourceToPart?.rotation ?? null] : null]);
}

function measurementSourceKey(result: MeasurementResult, parts: ScenePart[]): string | undefined {
  const source = [result.occurrenceA, result.occurrenceB].map(id => parts.find(part => part.id === id));
  if (source.some(part => !part)) return undefined;
  return JSON.stringify(source.map(part => [part!.id, part!.itemId, part!.revision, assetKey(part!), part!.position, part!.rotation ?? [0, 0, 0]]));
}

function disposeMaterials(group: Group) {
  group.traverse(object => {
    if ('material' in object) {
      const material = (object as Mesh).material;
      if (Array.isArray(material)) material.forEach(m => m.dispose());
      else material?.dispose();
    }
  });
}

export class ViewerEngine {
  readonly canvas: HTMLCanvasElement;
  private scene = new Scene();
  private renderer: WebGLRenderer | SoftwareRenderer;
  private softwareRendering = false;
  private renderDirty = true;
  private lastRenderTime = 0;
  private camera = new PerspectiveCamera(35, 1, 0.1, 20000);
  private controls: OrbitControls;
  private baseGroup = new Group();
  private currentGroup = new Group();
  private groundGroup = new Group();
  private measurementGroup = new Group();
  private anchorGroup = new Group();
  private bboxGroup = new Group();
  private geometryCache = new Map<string, GeometryRequest>();
  private geometryBytes = 0;
  private models: ModelEntry[] = [];
  private props: ModelViewportProps;
  private appliedDisplayProps?: ModelViewportProps;
  private status: ViewerStatus = { loading: true, loaded: 0, total: 0, pointCount: 0 };
  private statusListener: (status: ViewerStatus) => void;
  private generation = 0;
  private destroyed = false;
  private frame = 0;
  private size = { width: 1, height: 1 };
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private pointerStart?: { id: number; x: number; y: number; moved: boolean };
  private activePointers = new Set<number>();
  private firstFit = true;
  private fullBounds: SceneBounds | null = null;
  private points: PickPoint[] = [];
  private pendingInitialMeasurement?: PendingMeasurement;
  private clipPlane = new Plane(new Vector3(0, 0, 1), 0);
  private hintTimer?: ReturnType<typeof setTimeout>;
  private lastViewNonce = -1;
  private lastResetKey?: number;
  private lastCameraKey = '';
  private lastCameraRestoreKey?: number;
  private pendingInitialCamera?: CameraState;
  private lastBoundsKey = '';
  private lastBoundsVisualKey = '';
  private lastMeasurementVisualKey = '';
  private lastAnchorVisualKey = '';
  private boundsBaseline = false;
  private lastHoverTime = 0;
  private resizeObserver: ResizeObserver;
  private orientationElement?: HTMLElement;

  constructor(container: HTMLDivElement, props: ModelViewportProps, statusListener: (status: ViewerStatus) => void, orientationElement?: HTMLElement) {
    this.props = props;
    this.lastResetKey = props.measurementResetKey;
    if (props.restoredMeasurement) {
      const sourceKey = measurementSourceKey(props.restoredMeasurement, props.parts);
      if (sourceKey) this.pendingInitialMeasurement = { result: props.restoredMeasurement, sourceKey, resetKey: props.measurementResetKey };
    }
    this.statusListener = statusListener;
    this.orientationElement = orientationElement;
    try {
      const canvas = document.createElement('canvas');
      const forceSoftware = new URLSearchParams(window.location.search).get('renderer') === 'software';
      const context = forceSoftware ? null : canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
      if (!context) throw new Error('WebGL2 unavailable.');
      this.renderer = new WebGLRenderer({ canvas, context, antialias: true, alpha: false, powerPreference: 'high-performance' });
      this.renderer.domElement.dataset.renderer = 'webgl';
    } catch {
      this.renderer = new SoftwareRenderer();
      this.softwareRendering = true;
    }
    this.status.rendererMode = this.softwareRendering ? 'software' : 'webgl';
    this.setRenderQuality(props.renderQuality);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.scene.background = new Color('#edf1f4');
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'model-webgl-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', props.sourcePresentation === 'local' ? 'Interactive local STEP model. Drag to orbit, right-drag to pan, scroll to zoom.' : 'Interactive STEP assembly. Drag to orbit, right-drag to pan, scroll to zoom. Select parts in the BOM for keyboard access.');
    container.appendChild(this.canvas);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(270, -330, 250);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.10;
    this.controls.rotateSpeed = 0.7;
    this.controls.panSpeed = 0.7;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 50000;
    this.controls.addEventListener('end', this.handleCameraEnd);
    this.controls.addEventListener('change', this.markRenderDirty);
    this.scene.add(new HemisphereLight('#f3f8ff', '#a6b1bc', 2.1));
    this.scene.add(new AmbientLight('#ffffff', 0.30));
    const key = new DirectionalLight('#fff5e5', 3.4);
    key.position.set(-220, -350, 500);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    key.shadow.camera.left = -350; key.shadow.camera.right = 350;
    key.shadow.camera.top = 350; key.shadow.camera.bottom = -350;
    key.shadow.camera.near = 0.1; key.shadow.camera.far = 1800;
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.6;
    this.scene.add(key);
    const fill = new DirectionalLight('#d4e6ff', 1.3);
    fill.position.set(350, 150, 240);
    this.scene.add(fill);
    const rim = new DirectionalLight('#ffffff', 1.5);
    rim.position.set(-120, 300, 300);
    this.scene.add(rim);
    this.scene.add(this.groundGroup, this.baseGroup, this.currentGroup, this.measurementGroup, this.anchorGroup, this.bboxGroup);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.addEventListener('lostpointercapture', this.handlePointerCancel);
    this.canvas.addEventListener('contextmenu', this.preventContextMenu);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    this.resizeObserver = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      this.size = { width: Math.max(1, width), height: Math.max(1, height) };
      this.renderer.setSize(this.size.width, this.size.height, false);
      this.renderDirty = true;
    });
    this.resizeObserver.observe(container);
    this.publishStatus({ rendererMode: this.softwareRendering ? 'software' : 'webgl' });
    this.animate();
  }

  private publishStatus(changes: Partial<ViewerStatus>) {
    this.status = { ...this.status, ...changes };
    if (!this.destroyed) this.statusListener(this.status);
  }

  private setRenderQuality(quality: ModelViewportProps['renderQuality']) {
    const deviceRatio = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    this.renderer.setPixelRatio(Math.min(deviceRatio, quality === 'economy' ? 1 : 2));
  }

  private hint(message: string) {
    clearTimeout(this.hintTimer);
    this.publishStatus({ hint: message });
    this.hintTimer = setTimeout(() => this.publishStatus({ hint: undefined }), 4500);
  }

  private loadAsset(part: ScenePart): Promise<GeometryAsset> {
    const key = assetKey(part);
    const cached = this.geometryCache.get(key);
    if (cached) return cached.promise;
    const controller = new AbortController();
    const promise = (async () => {
      let data: { positions: number[] | Float32Array; normals?: number[] | Float32Array; indices: number[] | Uint32Array };
      let warnings: string[] = [], cad: GeometryAsset['cad'];
      if (part.stepUrl) {
        const result = await importStepUrl(part.stepUrl, part.sourceHash, controller.signal, part.cadNodePath, part.sourceToPart);
        data = result; warnings = result.warnings;
        cad = { hierarchy: result.hierarchy, meshRanges: result.meshRanges };
      } else {
        if (!part.meshUrl) throw new Error('This model has no STEP source or prepared display geometry.');
        data = await readMeshSource(signal => fetchViewerContent(part.meshUrl!, signal), controller.signal);
      }
      controller.signal.throwIfAborted();
      const geometry = new BufferGeometry();
      let edges: EdgesGeometry | undefined;
      try {
        const minimumBytes = data.positions.length * 8 + data.indices.length * 4;
        if (this.geometryBytes + minimumBytes > MAX_SCENE_GEOMETRY_BYTES) throw new Error('Loaded geometry exceeds this review session’s memory budget. Load fewer BOM components.');
        geometry.setAttribute('position', data.positions instanceof Float32Array ? new BufferAttribute(data.positions, 3) : new Float32BufferAttribute(data.positions, 3));
        geometry.setIndex(data.indices instanceof Uint32Array ? new BufferAttribute(data.indices, 1) : data.indices);
        if (data.normals) geometry.setAttribute('normal', data.normals instanceof Float32Array ? new BufferAttribute(data.normals, 3) : new Float32BufferAttribute(data.normals, 3));
        else geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const detailedEdges = data.indices.length / 3 <= MAX_EDGE_TRIANGLES;
        edges = detailedEdges ? new EdgesGeometry(geometry, 30) : new EdgesGeometry();
        if (!detailedEdges) warnings = [...warnings, 'Detailed edge lines are hidden for this large model to keep review responsive.'];
        const memoryBytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0)
          + (geometry.index?.array.byteLength ?? 0) + (edges.getAttribute('position')?.array.byteLength ?? 0);
        if (this.geometryBytes + memoryBytes > MAX_SCENE_GEOMETRY_BYTES) throw new Error('Loaded geometry exceeds this review session’s memory budget. Load fewer BOM components.');
        this.geometryBytes += memoryBytes;
        return { geometry, edges, memoryBytes, warnings, cad };
      } catch (error) { geometry.dispose(); edges?.dispose(); throw error; }
    })();
    const request = { promise, controller };
    this.geometryCache.set(key, request);
    promise.catch(() => { if (this.geometryCache.get(key) === request) this.geometryCache.delete(key); });
    return promise;
  }

  private releaseAsset(url: string, request: GeometryRequest) {
    this.geometryCache.delete(url);
    request.controller.abort();
    void request.promise.then(asset => { this.geometryBytes = Math.max(0, this.geometryBytes - asset.memoryBytes); asset.geometry.dispose(); asset.edges.dispose(); }).catch(() => {});
  }

  async setParts(parts: ScenePart[], comparisonParts: ScenePart[] = []) {
    const generation = ++this.generation;
    // A revision can share occurrence IDs with the previous scene. Never let a
    // gesture begun on old geometry create a finding against the new source.
    this.pointerStart = undefined;
    const requested = [...parts.map(part => ({ part, baseline: false })), ...comparisonParts.map(part => ({ part, baseline: true }))];
    // Source labels change immediately. Clear previous geometry and envelopes so
    // a slow replacement cannot display the old revision under the new label.
    disposeMaterials(this.baseGroup); disposeMaterials(this.currentGroup);
    this.baseGroup.clear(); this.currentGroup.clear(); this.models = [];
    this.fullBounds = null;
    this.rebuildGround();
    this.updateBounds();
    const pendingMeasurement = this.pendingInitialMeasurement;
    this.clearMeasurement();
    this.updateAnchorVisuals();
    const requestedUrls = new Set(requested.map(entry => assetKey(entry.part)));
    for (const [url, request] of this.geometryCache) {
      if (!requestedUrls.has(url)) this.releaseAsset(url, request);
    }
    const hasStep = requested.some(entry => Boolean(entry.part.stepUrl)), hasMesh = requested.some(entry => !entry.part.stepUrl);
    this.publishStatus({ loading: true, loaded: 0, total: requested.length, error: undefined, importNotice: undefined, sourceKind: hasStep ? hasMesh ? 'mixed' : 'step' : 'mesh' });
    let completed = 0;
    const loaded = await Promise.all(requested.map(async entry => {
      try {
        const asset = await this.loadAsset(entry.part);
        validateScenePlacement(entry.part, asset.geometry.boundingBox);
        if (!this.destroyed && this.generation === generation) this.publishStatus({ loaded: ++completed });
        return { ...entry, asset };
      } catch (error) {
        if (!this.destroyed && this.generation === generation) this.publishStatus({ loaded: ++completed });
        return { ...entry, error };
      }
    }));
    if (this.destroyed || this.generation !== generation) return;
    // Use every successfully prepared source, including mesh-derived bounds,
    // instead of treating unavailable files as part of the displayed scene.
    const successful = loaded.flatMap(entry => {
      if (!('asset' in entry) || !entry.asset) return [];
      const part = { ...entry.part };
      if (!part.bbox && entry.asset.geometry.boundingBox) {
        part.bbox = { min: entry.asset.geometry.boundingBox.min.toArray(), max: entry.asset.geometry.boundingBox.max.toArray() };
        part.bboxSource = 'mesh';
      }
      return [{ ...entry, part, asset: entry.asset }];
    });
    // Acquisition may succeed even when every occurrence fails its world/CAD
    // envelope check. Such geometry has no scene owner and must not retain
    // buffers or consume the review budget. A healthy current or baseline use
    // of the same source still owns the shared asset.
    const successfulSources = new Set(successful.map(entry => assetKey(entry.part)));
    for (const [key, request] of this.geometryCache) {
      if (!successfulSources.has(key)) this.releaseAsset(key, request);
    }
    this.fullBounds = boundsForParts(successful.map(entry => entry.part));
    const center = this.fullBounds ? new Vector3(...this.fullBounds.min).add(new Vector3(...this.fullBounds.max)).multiplyScalar(0.5) : new Vector3();
    const maxDimension = this.fullBounds ? Math.max(...this.fullBounds.size) : 200;
    const errors = loaded.filter(entry => !('asset' in entry) || !entry.asset).map(entry => `${entry.part.name}${'error' in entry && entry.error instanceof Error ? `: ${entry.error.message.slice(0, 220)}` : ''}`);
    for (const { baseline, asset, part } of successful) {
      const group = new Group();
      group.position.set(...part.position);
      group.rotation.set(...(part.rotation ?? [0, 0, 0]));
      const material = new MeshStandardMaterial({ color: part.color, metalness: 0.18, roughness: 0.43, side: DoubleSide });
      const mesh = new Mesh(asset.geometry, material);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.occurrenceId = part.id;
      const edgeMaterial = new LineBasicMaterial({ color: '#354657', transparent: true, opacity: 0.18 });
      const edges = new LineSegments(asset.edges, edgeMaterial);
      group.add(mesh, edges);
      (baseline ? this.baseGroup : this.currentGroup).add(group);
      group.updateMatrixWorld(true);
      const partBox = boundsForParts([part]);
      const partCenter = partBox ? new Vector3(...partBox.min).add(new Vector3(...partBox.max)).multiplyScalar(0.5) : new Vector3(...part.position);
      const direction = partCenter.sub(center);
      if (direction.lengthSq() < 1) direction.set(0, 0, 1);
      direction.normalize().multiplyScalar(maxDimension * 0.42);
      // Spread repeated hardware and keep the base below the lifted components.
      if (/base|mounting plate/i.test(part.name)) direction.set(0, 0, -maxDimension * 0.18);
      if (/cover|lid/i.test(part.name)) direction.z = Math.max(direction.z, maxDimension * 0.38);
      this.models.push({ part, baseline, group, mesh, edges, explodeDirection: direction });
    }
    this.rebuildGround();
    // A status render can apply the current props while imports are pending.
    // Newly built scene objects still need the full display state applied once.
    this.update(this.props, true);
    if (pendingMeasurement) this.restoreInitialMeasurement(pendingMeasurement);
    if (this.firstFit && this.models.length) {
      this.fit('iso');
      this.firstFit = false;
      if (this.pendingInitialCamera) {
        this.restoreCamera(this.pendingInitialCamera);
        this.pendingInitialCamera = undefined;
      }
    }
    const uniqueErrors = Array.from(new Set(errors));
    const errorMessage = errors.length ? `${errors.length} model${errors.length === 1 ? '' : 's'} could not load: ${uniqueErrors.slice(0, 4).join('; ')}${uniqueErrors.length > 4 ? `; and ${uniqueErrors.length - 4} more` : ''}. ${this.models.length ? 'Other parts remain available.' : 'No model geometry is available. Retry the load or check the source attachments.'}` : undefined;
    const warnings = [...new Set(successful.flatMap(entry => entry.asset.warnings))];
    this.publishStatus({ loading: false, error: errorMessage, importNotice: warnings.join(' ') || undefined });
    if (errorMessage) this.props.onError?.(errorMessage);
    this.props.onReady?.(this.fullBounds);
  }

  update(props: ModelViewportProps, forceScene = false) {
    const measurementWasEnabled = this.props.measurementMode;
    const modeChanged = this.props.mode !== props.mode;
    const previousExplode = this.props.explode;
    const previousQuality = this.props.renderQuality;
    this.props = props;
    if (!forceScene && this.appliedDisplayProps && sameSceneInputs(this.appliedDisplayProps, props)) return;
    this.appliedDisplayProps = props;
    this.renderDirty = true;
    if (previousQuality !== props.renderQuality) {
      this.setRenderQuality(props.renderQuality);
      // WebGL and software adapters both retain CSS dimensions while rebuilding
      // the backing raster for the selected pixel ratio.
      this.renderer.setSize(this.size.width, this.size.height, false);
    }
    this.canvas.style.cursor = props.measurementMode || props.anchorMode ? 'crosshair' : 'grab';
    if ((props.measurementMode && !measurementWasEnabled) || props.measurementResetKey !== this.lastResetKey) {
      this.clearMeasurement();
      this.lastResetKey = props.measurementResetKey;
    }
    this.clipPlane.normal.set(props.section.axis === 'x' ? 1 : 0, props.section.axis === 'y' ? 1 : 0, props.section.axis === 'z' ? 1 : 0);
    this.clipPlane.constant = -props.section.offset;
    const planes = props.section.enabled ? [this.clipPlane] : [];
    const selectedIds = new Set(props.selectedIds), hiddenIds = new Set(props.hiddenIds);
    for (const model of this.models) {
      const { part, baseline, mesh, edges, group } = model;
      const selected = selectedIds.has(part.id);
      group.visible = !hiddenIds.has(part.id);
      group.position.set(...part.position).addScaledVector(model.explodeDirection, Math.max(0, Math.min(1, props.explode)));
      const material = mesh.material;
      const overlay = props.mode === 'overlay';
      material.color.set(overlay ? (baseline ? BASELINE : CURRENT) : part.color);
      material.emissive.set(selected ? ACCENT : '#000000');
      material.emissiveIntensity = selected ? 0.16 : 0;
      const factor = overlay ? (baseline ? (props.overlayOpacity?.a ?? 0.28) : (props.overlayOpacity?.b ?? 0.66)) : 1;
      const opacity = Math.max(0, Math.min(1, (props.opacityById[part.id] ?? 1) * factor));
      material.opacity = opacity;
      const transparent = opacity < 0.999;
      if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
      material.depthWrite = !transparent;
      material.clippingPlanes = planes;
      mesh.renderOrder = baseline ? 1 : 2;
      mesh.castShadow = !transparent;
      edges.material.color.set(selected ? '#007b76' : (overlay ? (baseline ? '#aa4d38' : '#137b77') : '#354657'));
      edges.material.opacity = (selected ? 0.8 : overlay ? 0.32 : 0.19) * opacity;
      edges.material.clippingPlanes = planes;
      edges.renderOrder = 3;
      group.updateMatrixWorld(true);
    }
    if (this.fullBounds) {
      let displayMinZ = this.fullBounds.min[2];
      for (const model of this.models) {
        if (!model.group.visible || (model.baseline && props.mode === 'single')) continue;
        const box = boundsForParts([model.part]);
        if (box) displayMinZ = Math.min(displayMinZ, box.min[2] + model.explodeDirection.z * props.explode);
      }
      this.groundGroup.position.z = displayMinZ - this.fullBounds.min[2];
    }
    if (previousExplode !== props.explode && this.models.length) {
      const ratio = (1 + props.explode * 0.72) / (1 + previousExplode * 0.72);
      this.camera.position.sub(this.controls.target).multiplyScalar(ratio).add(this.controls.target);
      this.controls.update();
      this.handleCameraEnd();
    }
    this.updateBounds();
    this.updateMeasurementVisuals();
    this.updateAnchorVisuals();
    if (modeChanged && this.models.length) this.fit('fit');
    if (props.viewCommand && props.viewCommand.nonce !== this.lastViewNonce) {
      this.lastViewNonce = props.viewCommand.nonce;
      if (this.models.length) this.fit(props.viewCommand.type);
    }
    const cameraKey = props.cameraState ? JSON.stringify(props.cameraState) : '';
    const explicitRestore = props.cameraRestoreKey !== undefined && props.cameraRestoreKey !== this.lastCameraRestoreKey;
    if (props.cameraState && (cameraKey !== this.lastCameraKey || explicitRestore)) {
      this.lastCameraKey = cameraKey;
      this.lastCameraRestoreKey = props.cameraRestoreKey;
      if (this.firstFit) this.pendingInitialCamera = props.cameraState;
      else this.restoreCamera(props.cameraState);
    } else if (!props.cameraState) {
      this.lastCameraKey = '';
      this.lastCameraRestoreKey = props.cameraRestoreKey;
      this.pendingInitialCamera = undefined;
    }
  }

  private updateBounds() {
    const currentParts = this.models.filter(m => !m.baseline).map(m => m.part);
    // Linked selections normally describe the current revision. A removed
    // occurrence exists only in the baseline, so its bounds must come from that
    // exact source instead of silently disappearing or using another part.
    this.boundsBaseline = this.props.mode !== 'single' && this.props.selectedIds.length > 0
      && !currentParts.some(part => this.props.selectedIds.includes(part.id));
    const sourceParts = this.boundsBaseline ? this.models.filter(model => model.baseline).map(model => model.part) : currentParts;
    const envelope = boundsForParts(selectedVisibleParts(sourceParts, this.props.selectedIds, this.props.hiddenIds));
    const bounds: SceneBounds | null = envelope ? { ...envelope, comparisonSource: this.boundsBaseline ? 'baseline' : 'current' } : null;
    const boundsKey = JSON.stringify(bounds);
    if (boundsKey !== this.lastBoundsKey) {
      this.lastBoundsKey = boundsKey;
      this.props.onBoundsChange?.(bounds);
    }
    const visualKey = `${boundsKey}|${this.props.showBoundingBox === true}`;
    if (visualKey === this.lastBoundsVisualKey) return;
    this.lastBoundsVisualKey = visualKey;
    this.bboxGroup.traverse(obj => {
      if (obj instanceof Box3Helper) {
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach(material => material.dispose());
      }
    });
    this.bboxGroup.clear();
    if (!this.props.showBoundingBox || !bounds) return;
    const helper = new Box3Helper(new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max)), new Color('#d4a13e'));
    const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
    materials.forEach(material => { material.depthTest = false; material.transparent = true; material.opacity = 0.95; });
    helper.renderOrder = 10;
    this.bboxGroup.add(helper);
  }

  private rebuildGround() {
    this.groundGroup.traverse(obj => {
      if ('geometry' in obj) (obj as Mesh).geometry?.dispose();
    });
    disposeMaterials(this.groundGroup);
    this.groundGroup.clear();
    if (!this.fullBounds) return;
    const maxDimension = Math.max(...this.fullBounds.size);
    const gridSize = Math.ceil(maxDimension * 3 / 100) * 100;
    const floorZ = this.fullBounds.min[2] - 0.35;
    const grid = new GridHelper(gridSize, Math.min(60, gridSize / 20), '#aebbc5', '#cbd4dc');
    grid.rotation.x = Math.PI / 2;
    grid.position.z = floorZ;
    const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
    materials.forEach(material => { material.transparent = true; material.opacity = 0.36; material.depthWrite = false; });
    this.groundGroup.add(grid);
    const shadow = new Mesh(new PlaneGeometry(gridSize, gridSize), new ShadowMaterial({ opacity: 0.15 }));
    shadow.position.z = floorZ + 0.1;
    shadow.receiveShadow = true;
    this.groundGroup.add(shadow);
  }

  private boundsForFit(selected: boolean) {
    const candidates = this.models.filter(m => (this.props.mode !== 'single' || !m.baseline) && !this.props.hiddenIds.includes(m.part.id));
    const parts = selected ? candidates.filter(m => this.props.selectedIds.includes(m.part.id)) : candidates;
    const box = new Box3();
    for (const model of (parts.length ? parts : candidates)) {
      const bounds = boundsForParts([model.part]);
      if (!bounds) continue;
      const offset = model.explodeDirection.clone().multiplyScalar(this.props.explode);
      box.union(new Box3(new Vector3(...bounds.min).add(offset), new Vector3(...bounds.max).add(offset)));
    }
    if (box.isEmpty() && this.fullBounds) box.set(new Vector3(...this.fullBounds.min), new Vector3(...this.fullBounds.max));
    return box;
  }

  private fit(type: 'fit' | 'fit-selection' | 'iso' | 'top' | 'front' | 'right') {
    const box = this.boundsForFit(type === 'fit-selection');
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    let direction: Vector3;
    if (type === 'top') direction = new Vector3(0.001, 0, 1);
    else if (type === 'front') direction = new Vector3(0, -1, 0.001);
    else if (type === 'right') direction = new Vector3(1, 0, 0.001);
    else if (type === 'fit' || type === 'fit-selection') direction = this.camera.position.clone().sub(this.controls.target).normalize();
    else direction = new Vector3(1.25, -1.6, 1.15).normalize();
    const radius = size.length() * 0.5;
    const aspect = this.size.width / this.size.height / (this.props.mode === 'split' ? 2 : 1);
    const verticalFov = this.camera.fov * Math.PI / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.08;
    this.camera.position.copy(center).addScaledVector(direction, Math.max(10, distance));
    this.camera.near = Math.max(0.01, radius / 1000);
    this.camera.far = Math.max(20000, radius * 200);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.handleCameraEnd();
  }

  private restoreCamera(state: CameraState) {
    const values = [...state.position, ...state.target];
    if (values.length !== 6 || !values.every(Number.isFinite) || pointDistance(state.position, state.target) < 0.01) return;
    this.camera.position.set(...state.position);
    this.controls.target.set(...state.target);
    this.controls.update();
  }

  private handleCameraEnd = () => {
    if (this.destroyed) return;
    this.props.onCameraChange?.({ position: this.camera.position.toArray() as Vec3, target: this.controls.target.toArray() as Vec3 });
  };

  private pick(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    let x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const isSplit = this.props.mode === 'split';
    const baseline = isSplit && x < rect.width / 2;
    const viewportWidth = isSplit ? rect.width / 2 : rect.width;
    if (isSplit && !baseline) x -= viewportWidth;
    this.pointer.set((x / viewportWidth) * 2 - 1, -(y / rect.height) * 2 + 1);
    this.camera.aspect = viewportWidth / rect.height;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const models = this.models.filter(model => model.group.visible && model.mesh.material.opacity > 0.02 && (isSplit ? model.baseline === baseline : this.props.mode === 'overlay' || !model.baseline));
    const hits = this.raycaster.intersectObjects(models.map(model => model.mesh), false);
    const hit = hits.find(hit => !this.props.section.enabled || this.clipPlane.distanceToPoint(hit.point) >= -0.001);
    if (!hit) return null;
    const model = models.find(model => model.mesh === hit.object)!;
    return { model, point: hit.point };
  }

  private pickAnchor(event: PointerEvent): string | undefined {
    if (this.props.mode === 'split') {
      const rect = this.canvas.getBoundingClientRect();
      if (event.clientX - rect.left < rect.width / 2) return undefined;
    }
    this.anchorGroup.updateMatrixWorld(true);
    const hit = this.raycaster.intersectObjects(this.anchorGroup.children, false)[0];
    return hit?.object.userData.anchorId;
  }

  private handlePointerDown = (event: PointerEvent) => {
    this.activePointers.add(event.pointerId);
    if (event.button !== 0 || event.isPrimary === false || this.activePointers.size !== 1 || this.status.loading) {
      this.pointerStart = undefined;
      return;
    }
    this.pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };

  private handlePointerUp = (event: PointerEvent) => {
    const start = this.pointerStart;
    this.activePointers.delete(event.pointerId);
    this.pointerStart = undefined;
    if (this.status.loading || event.button !== 0 || !start || event.pointerId !== start.id || start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const hit = this.pick(event);
    const anchorId = this.pickAnchor(event);
    if (anchorId && !this.props.measurementMode && !this.props.anchorMode) {
      this.props.onAnchorSelect?.(anchorId);
      return;
    }
    if (!hit) return;
    const { model, point } = hit;
    if (model.baseline && (this.props.measurementMode || this.props.anchorMode || event.altKey)) {
      this.hint('Choose a surface on the current revision to place a measurement or comment.');
      return;
    }
    const local = model.group.worldToLocal(point.clone()).toArray() as Vec3;
    const assembled = localToAssembled(local, model.part);
    if (this.props.measurementMode) {
      if (this.points.length === 2) this.points = [];
      this.points.push({ local, assembled, occurrenceId: model.part.id });
      const measurement = this.points.length === 2 ? pointDistance(this.points[0].assembled, this.points[1].assembled) : undefined;
      this.publishStatus({ pointCount: this.points.length, measurement });
      this.updateMeasurementVisuals();
      this.props.onMeasure?.(this.points.length === 2
        ? { distance: measurement!, a: this.points[0].assembled, b: this.points[1].assembled, occurrenceA: this.points[0].occurrenceId, occurrenceB: this.points[1].occurrenceId }
        : null);
    } else if (this.props.anchorMode || event.altKey) {
      this.props.onAnchor?.({ occurrenceId: model.part.id, localPoint: local, worldPoint: assembled });
    } else {
      this.props.onSelect(model.part.id, event.shiftKey || event.metaKey || event.ctrlKey);
    }
  };

  private handlePointerMove = (event: PointerEvent) => {
    if (this.pointerStart?.id === event.pointerId && Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) {
      this.pointerStart.moved = true;
    }
    if (this.status.loading) return;
    if (event.buttons) return;
    if (this.props.measurementMode || this.props.anchorMode) return;
    const now = performance.now();
    if (now - this.lastHoverTime < 65) return;
    this.lastHoverTime = now;
    const hit = this.pick(event);
    this.canvas.style.cursor = hit || this.pickAnchor(event) ? 'pointer' : 'grab';
  };

  private handlePointerCancel = (event: PointerEvent) => {
    this.activePointers.delete(event.pointerId);
    this.pointerStart = undefined;
  };

  private preventContextMenu = (event: Event) => event.preventDefault();

  private clearMeasurement() {
    this.pendingInitialMeasurement = undefined;
    this.points = [];
    this.publishStatus({ pointCount: 0, measurement: undefined });
    this.props.onMeasure?.(null);
    this.updateMeasurementVisuals();
  }

  private restoreInitialMeasurement(pending: PendingMeasurement) {
    const result = pending.result;
    const currentModels = this.models.filter(model => !model.baseline);
    if (pending.resetKey !== this.props.measurementResetKey
      || measurementSourceKey(result, currentModels.map(model => model.part)) !== pending.sourceKey
      || ![...result.a, ...result.b].every(value => Number.isFinite(value) && Math.abs(value) < 1e9)) return;
    const models = [result.occurrenceA, result.occurrenceB].map(id => currentModels.find(model => model.part.id === id));
    if (models.some(model => !model?.group.visible || model.mesh.material.opacity <= 0.02)) return;
    this.points = [result.a, result.b].map((assembled, index) => ({
      occurrenceId: models[index]!.part.id,
      assembled: [...assembled] as Vec3,
      local: new Vector3(...assembled).applyMatrix4(occurrenceMatrix(models[index]!.part).invert()).toArray() as Vec3,
    }));
    const distance = pointDistance(this.points[0].assembled, this.points[1].assembled);
    this.publishStatus({ pointCount: 2, measurement: distance });
    this.updateMeasurementVisuals();
    this.props.onMeasure?.({ ...result, distance, a: this.points[0].assembled, b: this.points[1].assembled });
  }

  private clearOverlayGroup(group: Group) {
    group.traverse(object => { if ('geometry' in object) (object as Mesh).geometry?.dispose(); });
    disposeMaterials(group);
    group.clear();
  }

  private updateMeasurementVisuals() {
    const visualKey = JSON.stringify([this.generation, this.models.length, this.points, this.props.explode, this.props.hiddenIds, this.props.opacityById, this.props.mode, this.props.overlayOpacity]);
    if (visualKey === this.lastMeasurementVisualKey) return;
    this.lastMeasurementVisualKey = visualKey;
    this.renderDirty = true;
    this.clearOverlayGroup(this.measurementGroup);
    if (!this.points.length) return;
    const radius = (this.fullBounds ? Math.max(...this.fullBounds.size) : 200) * 0.006;
    const positions: Vector3[] = [];
    for (const point of this.points) {
      const model = this.models.find(model => !model.baseline && model.part.id === point.occurrenceId);
      if (!model || !model.group.visible || model.mesh.material.opacity <= 0.02) continue;
      const position = model.group.localToWorld(new Vector3(...point.local));
      positions.push(position);
      const sphere = new Mesh(new SphereGeometry(radius, 16, 12), new MeshBasicMaterial({ color: '#d19730', depthTest: false }));
      sphere.position.copy(position); sphere.renderOrder = 15;
      this.measurementGroup.add(sphere);
    }
    if (positions.length === 2) {
      const geometry = new BufferGeometry().setFromPoints(positions);
      const line = new Line(geometry, new LineDashedMaterial({ color: '#ab7625', dashSize: radius * 2, gapSize: radius, depthTest: false }));
      line.computeLineDistances(); line.renderOrder = 15;
      this.measurementGroup.add(line);
    }
  }

  private updateAnchorVisuals() {
    const visualKey = JSON.stringify([this.generation, this.models.length, this.props.anchors, this.props.explode, this.props.hiddenIds, this.props.opacityById, this.props.mode, this.props.overlayOpacity]);
    if (visualKey === this.lastAnchorVisualKey) return;
    this.lastAnchorVisualKey = visualKey;
    this.renderDirty = true;
    this.clearOverlayGroup(this.anchorGroup);
    const radius = (this.fullBounds ? Math.max(...this.fullBounds.size) : 200) * 0.010;
    for (const anchor of this.props.anchors ?? []) {
      const model = this.models.find(model => !model.baseline && model.part.id === anchor.occurrenceId);
      if (!model || !model.group.visible || model.mesh.material.opacity <= 0.02) continue;
      const sphere = new Mesh(new SphereGeometry(radius, 16, 12), new MeshBasicMaterial({ color: '#f1b747', depthTest: false }));
      sphere.position.copy(model.group.localToWorld(new Vector3(...anchor.localPoint)));
      sphere.userData.anchorId = anchor.id;
      sphere.renderOrder = 16;
      this.anchorGroup.add(sphere);
    }
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    this.publishStatus({ error: 'The graphics context was interrupted. The browser will try to recover it.' });
  };
  private handleContextRestored = () => { this.renderDirty = true; this.publishStatus({ error: undefined }); };

  private markRenderDirty = () => {
    this.renderDirty = true;
    // Publish the latest position synchronously, including damping frames.
    // Documents can unmount this engine immediately after an orbit or view
    // command; a delayed callback would save an older camera on that transition.
    this.handleCameraEnd();
  };

  private updateOrientation() {
    if (!this.orientationElement) return;
    const quaternion = this.camera.quaternion.clone().invert();
    const axes = [{ name: 'x', vector: new Vector3(1, 0, 0) }, { name: 'y', vector: new Vector3(0, 1, 0) }, { name: 'z', vector: new Vector3(0, 0, 1) }];
    for (const axis of axes) {
      axis.vector.applyQuaternion(quaternion);
      const node = this.orientationElement.querySelector<HTMLElement>(`[data-axis="${axis.name}"]`);
      if (node) {
        node.style.transform = `translate(${axis.vector.x * 24}px,${-axis.vector.y * 24}px)`;
        node.style.opacity = String(0.6 + (axis.vector.z + 1) * 0.2);
        node.style.zIndex = String(Math.round((axis.vector.z + 1) * 10));
      }
    }
  }

  private animate = () => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    const now = performance.now();
    if (!this.renderDirty || this.softwareRendering && now - this.lastRenderTime < 33) return;
    this.renderDirty = false;
    this.lastRenderTime = now;
    this.updateOrientation();
    const { width, height } = this.size;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    if (this.props.mode === 'split') {
      const leftWidth = Math.floor(width / 2);
      this.camera.aspect = leftWidth / height;
      this.camera.updateProjectionMatrix();
      this.currentGroup.visible = false; this.baseGroup.visible = true;
      this.measurementGroup.visible = false; this.anchorGroup.visible = false; this.bboxGroup.visible = this.boundsBaseline;
      this.renderer.setViewport(0, 0, leftWidth, height);
      this.renderer.setScissor(0, 0, leftWidth, height);
      this.renderer.render(this.scene, this.camera);
      this.baseGroup.visible = false; this.currentGroup.visible = true;
      this.measurementGroup.visible = true; this.anchorGroup.visible = true; this.bboxGroup.visible = !this.boundsBaseline;
      this.renderer.setViewport(leftWidth, 0, width - leftWidth, height);
      this.renderer.setScissor(leftWidth, 0, width - leftWidth, height);
      this.renderer.render(this.scene, this.camera);
    } else {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.currentGroup.visible = true; this.baseGroup.visible = this.props.mode === 'overlay';
      this.measurementGroup.visible = true; this.anchorGroup.visible = true; this.bboxGroup.visible = true;
      this.renderer.setViewport(0, 0, width, height);
      this.renderer.setScissor(0, 0, width, height);
      this.renderer.render(this.scene, this.camera);
    }
    this.renderer.setScissorTest(false);
  };

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.hintTimer);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('end', this.handleCameraEnd);
    this.controls.removeEventListener('change', this.markRenderDirty);
    this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this.handlePointerCancel);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    disposeMaterials(this.baseGroup); disposeMaterials(this.currentGroup);
    this.clearOverlayGroup(this.measurementGroup);
    this.clearOverlayGroup(this.anchorGroup);
    this.clearOverlayGroup(this.bboxGroup);
    this.clearOverlayGroup(this.groundGroup);
    for (const [url, request] of this.geometryCache) this.releaseAsset(url, request);
    // Renderer.dispose does not own the lights' render targets. Release shadow
    // maps explicitly when switching back to a document-only workspace.
    this.scene.traverse(object => { if (object instanceof DirectionalLight) object.dispose(); });
    this.scene.clear();
    this.models = [];
    this.renderer.dispose();
    this.canvas.remove();
  }
}
