import { Color, Line, LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Scene, ShadowMaterial } from 'three';
import type { BufferGeometry, Material, Plane } from 'three';
import { clipPolygonAgainstPlane, clipPolygonToCamera, clipSegmentAgainstPlane, projectPoint, transformPoint } from './softwareGeometry';
import type { Point3, Viewport } from './softwareGeometry';

type PaintedMaterial = Material & { color?: Color; emissive?: Color; emissiveIntensity?: number; vertexColors?: boolean; linewidth?: number; dashSize?: number; gapSize?: number; clippingPlanes?: Plane[] | null };
type Face = { kind: 'face'; points: number[]; depth: number; color: string; opacity: number; layer: number };
type Stroke = { kind: 'line'; points: number[]; depth: number; color: string; opacity: number; layer: number; width: number; dashed: boolean };
type Primitive = Face | Stroke;

/**
 * CPU fallback for environments without WebGL2. It projects the same original
 * indexed STEP-derived triangles used by the GPU and Raycaster. Painter sorting
 * approximates depth for intersecting faces; lighting is deliberately simple.
 * No triangle reduction, scene replacement, or remote rendering occurs.
 */
export class SoftwareRenderer {
  readonly domElement = document.createElement('canvas');
  readonly isSoftwareRenderer = true;
  readonly shadowMap = { enabled: false, type: 0 };
  outputColorSpace = '';
  toneMapping = 0;
  toneMappingExposure = 1;
  localClippingEnabled = true;
  private context: CanvasRenderingContext2D;
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private viewport: Viewport = { x: 0, y: 0, width: 1, height: 1 };
  private scissor: Viewport = { x: 0, y: 0, width: 1, height: 1 };
  private scissorEnabled = false;
  private projection = new Matrix4();
  private paletteCache = new Map<string, string[]>();

  constructor() {
    const context = this.domElement.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D rendering is unavailable.');
    this.context = context;
    this.domElement.dataset.renderer = 'software';
  }

  setPixelRatio(value: number) { this.pixelRatio = Math.min(value, 1.5); }
  setSize(width: number, height: number, updateStyle = false) {
    this.width = width; this.height = height;
    this.domElement.width = Math.round(width * this.pixelRatio);
    this.domElement.height = Math.round(height * this.pixelRatio);
    if (updateStyle) { this.domElement.style.width = `${width}px`; this.domElement.style.height = `${height}px`; }
  }
  setViewport(x: number, y: number, width: number, height: number) { this.viewport = { x, y: this.height - y - height, width, height }; }
  setScissor(x: number, y: number, width: number, height: number) { this.scissor = { x, y: this.height - y - height, width, height }; }
  setScissorTest(enabled: boolean) { this.scissorEnabled = enabled; }
  clear() {
    this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.context.clearRect(0, 0, this.width, this.height);
  }

  private palette(material: PaintedMaterial): string[] {
    const color = material.color ?? new Color('#8896a6');
    const emissive = material.emissive;
    const key = `${color.getHexString()}-${emissive?.getHexString()}-${material.emissiveIntensity ?? 0}`;
    let palette = this.paletteCache.get(key);
    if (palette) return palette;
    palette = Array.from({ length: 64 }, (_, level) => {
      const shade = 0.24 + level / 63 * 1.07;
      const shaded = color.clone().multiplyScalar(shade);
      if (emissive) shaded.add(emissive.clone().multiplyScalar(material.emissiveIntensity ?? 0));
      return shaded.getStyle();
    });
    this.paletteCache.set(key, palette);
    // Material selections create small variants; bound the cache in long reviews.
    if (this.paletteCache.size > 128) this.paletteCache.delete(this.paletteCache.keys().next().value!);
    return palette;
  }

  private collectMesh(object: Mesh, camera: PerspectiveCamera, primitives: Primitive[]) {
    const geometry = object.geometry as BufferGeometry;
    const material = (Array.isArray(object.material) ? object.material[0] : object.material) as PaintedMaterial;
    if (!material || !material.visible || material.opacity <= 0 || material instanceof ShadowMaterial) return;
    const positions = geometry.getAttribute('position');
    if (!positions) return;
    const index = geometry.getIndex();
    const indicesCount = index?.count ?? positions.count;
    const start = Math.max(0, geometry.drawRange.start);
    const end = Math.min(indicesCount, start + geometry.drawRange.count);
    const worldMatrix = object.matrixWorld.elements;
    const viewMatrix = camera.matrixWorldInverse.elements;
    const projection = camera.projectionMatrix.elements;
    const world = new Float64Array(positions.count * 3);
    const view = new Float64Array(positions.count * 3);
    const screen = new Float64Array(positions.count * 3);
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const offset = vertex * 3;
      const point = transformPoint([positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)], worldMatrix);
      world.set(point, offset);
      const viewPoint = transformPoint(point, viewMatrix);
      view.set(viewPoint, offset);
      const projected = projectPoint(viewPoint, projection, this.viewport);
      if (projected) { screen[offset] = projected.x; screen[offset + 1] = projected.y; screen[offset + 2] = projected.z; }
      else { screen[offset] = NaN; screen[offset + 1] = NaN; screen[offset + 2] = NaN; }
    }
    const palette = this.palette(material);
    const basic = material instanceof MeshBasicMaterial;
    const planes = this.localClippingEnabled ? material.clippingPlanes ?? [] : [];
    const opacity = Math.max(0, Math.min(1, material.opacity));
    const layer = material.depthTest === false ? 10 : (object.renderOrder < 0 ? -10 : 0);
    for (let i = start; i + 2 < end; i += 3) {
      const ia = (index ? index.getX(i) : i) * 3;
      const ib = (index ? index.getX(i + 1) : i + 1) * 3;
      const ic = (index ? index.getX(i + 2) : i + 2) * 3;
      let clipped = false;
      let rejected = false;
      for (const plane of planes) {
        const da = plane.normal.x * world[ia] + plane.normal.y * world[ia + 1] + plane.normal.z * world[ia + 2] + plane.constant;
        const db = plane.normal.x * world[ib] + plane.normal.y * world[ib + 1] + plane.normal.z * world[ib + 2] + plane.constant;
        const dc = plane.normal.x * world[ic] + plane.normal.y * world[ic + 1] + plane.normal.z * world[ic + 2] + plane.constant;
        if (da < 0 && db < 0 && dc < 0) { rejected = true; break; }
        if (da < 0 || db < 0 || dc < 0) clipped = true;
      }
      if (rejected) continue;
      const depths = [view[ia + 2], view[ib + 2], view[ic + 2]];
      if (depths.every(z => z > -camera.near) || depths.every(z => z < -camera.far)) continue;
      if (depths.some(z => z > -camera.near || z < -camera.far)) clipped = true;
      let points: number[];
      let depth: number;
      if (!clipped) {
        points = [screen[ia], screen[ia + 1], screen[ib], screen[ib + 1], screen[ic], screen[ic + 1]];
        depth = (screen[ia + 2] + screen[ib + 2] + screen[ic + 2]) / 3;
      } else {
        let polygon: Point3[] = [
          [world[ia], world[ia + 1], world[ia + 2]],
          [world[ib], world[ib + 1], world[ib + 2]],
          [world[ic], world[ic + 1], world[ic + 2]],
        ];
        for (const plane of planes) polygon = clipPolygonAgainstPlane(polygon, [plane.normal.x, plane.normal.y, plane.normal.z], plane.constant);
        polygon = clipPolygonToCamera(polygon.map(point => transformPoint(point, viewMatrix)), camera.near, camera.far);
        if (polygon.length < 3) continue;
        const projected = polygon.map(point => projectPoint(point, projection, this.viewport));
        if (projected.some(point => !point)) continue;
        points = projected.flatMap(point => [point!.x, point!.y]);
        depth = projected.reduce((sum, point) => sum + point!.z, 0) / projected.length;
      }
      if (!Number.isFinite(depth) || !this.intersectsViewport(points)) continue;
      const ux = world[ib] - world[ia], uy = world[ib + 1] - world[ia + 1], uz = world[ib + 2] - world[ia + 2];
      const vx = world[ic] - world[ia], vy = world[ic + 1] - world[ia + 1], vz = world[ic + 2] - world[ia + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      if (length < 1e-12) continue;
      nx /= length; ny /= length; nz /= length;
      const towardCamera = nx * (camera.position.x - world[ia]) + ny * (camera.position.y - world[ia + 1]) + nz * (camera.position.z - world[ia + 2]);
      if (material.side === 0 && towardCamera <= 0) continue;
      if (material.side === 1 && towardCamera > 0) continue;
      if (towardCamera < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const key = Math.max(0, nx * -0.36 + ny * -0.48 + nz * 0.8);
      const fill = Math.max(0, nx * 0.75 + ny * 0.2 + nz * 0.63);
      const light = basic ? 1 : 0.43 + key * 0.6 + fill * 0.18 + Math.max(0, nz) * 0.1;
      const shade = Math.max(0, Math.min(63, Math.round((light - 0.24) / 1.07 * 63)));
      primitives.push({ kind: 'face', points, depth, color: palette[shade], opacity, layer });
    }
  }

  private collectLines(object: Line, camera: PerspectiveCamera, primitives: Primitive[]) {
    const geometry = object.geometry as BufferGeometry;
    const material = (Array.isArray(object.material) ? object.material[0] : object.material) as PaintedMaterial;
    if (!material || !material.visible || material.opacity <= 0) return;
    const positions = geometry.getAttribute('position');
    const colors = geometry.getAttribute('color');
    const index = geometry.getIndex();
    if (!positions) return;
    const count = index?.count ?? positions.count;
    const start = Math.max(0, geometry.drawRange.start);
    const end = Math.min(count, start + geometry.drawRange.count);
    const stride = object instanceof LineSegments ? 2 : 1;
    const planes = this.localClippingEnabled ? material.clippingPlanes ?? [] : [];
    const layer = material.depthTest === false ? 11 : (object.renderOrder < 0 || object.type === 'GridHelper' ? -10 : 0);
    for (let i = start; i + 1 < end; i += stride) {
      const ai = index ? index.getX(i) : i;
      const bi = index ? index.getX(i + 1) : i + 1;
      let segment: [Point3, Point3] | null = [
        transformPoint([positions.getX(ai), positions.getY(ai), positions.getZ(ai)], object.matrixWorld.elements),
        transformPoint([positions.getX(bi), positions.getY(bi), positions.getZ(bi)], object.matrixWorld.elements),
      ];
      for (const plane of planes) {
        if (!segment) break;
        segment = clipSegmentAgainstPlane(segment[0], segment[1], [plane.normal.x, plane.normal.y, plane.normal.z], plane.constant);
      }
      if (!segment) continue;
      segment = [transformPoint(segment[0], camera.matrixWorldInverse.elements), transformPoint(segment[1], camera.matrixWorldInverse.elements)];
      segment = clipSegmentAgainstPlane(segment[0], segment[1], [0, 0, -1], -camera.near);
      if (segment) segment = clipSegmentAgainstPlane(segment[0], segment[1], [0, 0, 1], camera.far);
      if (!segment) continue;
      const a = projectPoint(segment[0], camera.projectionMatrix.elements, this.viewport);
      const b = projectPoint(segment[1], camera.projectionMatrix.elements, this.viewport);
      if (!a || !b) continue;
      const points = [a.x, a.y, b.x, b.y];
      if (!this.intersectsViewport(points)) continue;
      const color = material.color?.clone() ?? new Color('#64788b');
      if (material.vertexColors && colors) color.multiply(new Color(colors.getX(ai), colors.getY(ai), colors.getZ(ai)));
      primitives.push({ kind: 'line', points, depth: (a.z + b.z) / 2 - 0.0000008, color: color.getStyle(), opacity: material.opacity, layer, width: material.linewidth ?? 1, dashed: material.dashSize !== undefined });
    }
  }

  private intersectsViewport(points: number[]) {
    const { x, y, width, height } = this.viewport;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) { minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]); minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]); }
    return maxX >= x && minX <= x + width && maxY >= y && minY <= y + height;
  }

  render(scene: Scene, camera: PerspectiveCamera) {
    const context = this.context;
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const primitives: Primitive[] = [];
    scene.traverseVisible(object => {
      if (object instanceof Mesh) this.collectMesh(object, camera, primitives);
      else if (object instanceof Line) this.collectLines(object, camera, primitives);
    });
    primitives.sort((a, b) => a.layer - b.layer || b.depth - a.depth || (a.kind === 'line' ? 1 : 0) - (b.kind === 'line' ? 1 : 0));
    context.save();
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    const clip = this.scissorEnabled ? this.scissor : this.viewport;
    context.beginPath(); context.rect(clip.x, clip.y, clip.width, clip.height); context.clip();
    context.globalAlpha = 1;
    context.fillStyle = scene.background instanceof Color ? scene.background.getStyle() : '#edf1f4';
    context.fillRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    context.lineJoin = 'round'; context.lineCap = 'round';
    let currentStyle = '';
    let currentKind: Primitive['kind'] | undefined;
    let pending = false;
    const flush = () => { if (pending) { if (currentKind === 'face') context.fill(); else context.stroke(); pending = false; } };
    for (const primitive of primitives) {
      const style = `${primitive.kind}|${primitive.color}|${primitive.opacity}|${primitive.kind === 'line' ? `${primitive.width}|${primitive.dashed}` : ''}`;
      if (style !== currentStyle) {
        flush(); currentStyle = style; currentKind = primitive.kind;
        context.globalAlpha = primitive.opacity;
        if (primitive.kind === 'face') context.fillStyle = primitive.color;
        else { context.strokeStyle = primitive.color; context.lineWidth = primitive.width; context.setLineDash(primitive.dashed ? [5, 3] : []); }
        context.beginPath();
      }
      const points = primitive.points;
      context.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) context.lineTo(points[i], points[i + 1]);
      if (primitive.kind === 'face') context.closePath();
      pending = true;
    }
    flush();
    context.restore();
  }

  dispose() { this.paletteCache.clear(); }
}
