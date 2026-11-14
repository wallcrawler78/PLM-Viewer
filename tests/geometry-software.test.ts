import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Color, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Plane, Scene, Vector3 } from 'three';
import { clipPolygonAgainstPlane, clipPolygonToCamera, clipSegmentAgainstPlane, projectPoint, transformPoint } from '../src/components/model/softwareGeometry';
import { SoftwareRenderer } from '../src/components/model/SoftwareRenderer';

describe('software renderer geometry', () => {
  it('clips a triangle to the same positive half-space as the model section tool', () => {
    const result = clipPolygonAgainstPlane([[-2, 0, 0], [2, 0, 0], [2, 4, 0]], [1, 0, 0], 0);
    expect(result).toHaveLength(4);
    expect(result.every(point => point[0] >= 0)).toBe(true);
    expect(result.some(point => point[0] === 0 && point[1] === 2)).toBe(true);
  });
  it('removes fully clipped geometry without changing retained polygons', () => {
    expect(clipPolygonAgainstPlane([[-2, 0, 0], [-1, 1, 0], [-3, 2, 0]], [1, 0, 0], 0)).toEqual([]);
    const retained: [number, number, number][] = [[1, 0, 0], [2, 1, 0], [3, 2, 0]];
    expect(clipPolygonAgainstPlane(retained, [1, 0, 0], 0)).toEqual(retained);
  });
  it('clips near/far planes before perspective division, including a triangle crossing the camera', () => {
    const result = clipPolygonToCamera([[-1, 0, 1], [1, 0, -5], [0, 2, -5]], 0.1, 20);
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.every(point => point[2] <= -0.1 + 1e-9 && point[2] >= -20)).toBe(true);
    expect(clipPolygonToCamera([[0, 0, 1], [1, 0, 2], [0, 1, 3]], 0.1, 20)).toEqual([]);
  });
  it('projects the camera center into each split viewport without recentering models', () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
    const left = projectPoint([0, 0, -10], camera.projectionMatrix.elements, { x: 0, y: 0, width: 400, height: 400 });
    const right = projectPoint([0, 0, -10], camera.projectionMatrix.elements, { x: 400, y: 0, width: 400, height: 400 });
    expect(left?.x).toBe(200); expect(right?.x).toBe(600); expect(left?.y).toBe(200);
    const offset = projectPoint([1, 0, -10], camera.projectionMatrix.elements, { x: 0, y: 0, width: 400, height: 400 });
    expect(offset!.x).toBeGreaterThan(left!.x);
    expect(projectPoint([0, 0, 10], camera.projectionMatrix.elements, { x: 0, y: 0, width: 400, height: 400 })).toBeNull();
  });
  it('preserves occurrence translations through world transforms', () => {
    const matrix = new Matrix4().makeTranslation(10, 20, 30);
    expect(transformPoint([1, 2, 3], matrix.elements)).toEqual([11, 22, 33]);
  });
  it('clips measurement/edge lines consistently with surfaces', () => {
    expect(clipSegmentAgainstPlane([-2, 1, 3], [2, 1, 3], [1, 0, 0], 0)).toEqual([[0, 1, 3], [2, 1, 3]]);
    expect(clipSegmentAgainstPlane([-2, 0, 0], [-1, 0, 0], [1, 0, 0], 0)).toBeNull();
  });
});

describe('software renderer scene integration', () => {
  afterEach(() => vi.unstubAllGlobals());
  function harness() {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
    };
    vi.stubGlobal('document', { createElement: () => ({ dataset: {}, style: {}, getContext: () => context }) });
    const renderer = new SoftwareRenderer();
    renderer.setSize(800, 400); renderer.setViewport(0, 0, 400, 400);
    const scene = new Scene(); scene.background = new Color('#edf1f4');
    const material = new MeshStandardMaterial({ color: '#24485e' });
    scene.add(new Mesh(new BoxGeometry(2, 2, 2), material));
    const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(5, -6, 8); camera.lookAt(0, 0, 0);
    return { context, renderer, scene, camera, material };
  }
  it('renders real scene triangles with finite projected canvas coordinates', () => {
    const { context, renderer, scene, camera } = harness();
    renderer.render(scene, camera);
    expect(context.fill).toHaveBeenCalled();
    expect(context.lineTo.mock.calls.length).toBeGreaterThan(4);
    expect(context.moveTo.mock.calls.flat().every(Number.isFinite)).toBe(true);
    expect(context.lineTo.mock.calls.flat().every(Number.isFinite)).toBe(true);
  });
  it('uses distinct split viewports and omits fully sectioned geometry', () => {
    const { context, renderer, scene, camera, material } = harness();
    renderer.setViewport(400, 0, 400, 400); renderer.render(scene, camera);
    expect(context.moveTo.mock.calls.every(([x]) => x > 400)).toBe(true);
    context.fill.mockClear();
    material.clippingPlanes = [new Plane(new Vector3(1, 0, 0), -100)];
    renderer.render(scene, camera);
    expect(context.fill).not.toHaveBeenCalled();
  });
});
