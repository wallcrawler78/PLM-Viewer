export type Point3 = [number, number, number];
export type Point2Depth = { x: number; y: number; z: number; w: number };
export type Viewport = { x: number; y: number; width: number; height: number };

/** Sutherland–Hodgman clipping. Keeps normal · point + constant >= 0. */
export function clipPolygonAgainstPlane(points: Point3[], normal: Point3, constant: number): Point3[] {
  if (!points.length) return [];
  const result: Point3[] = [];
  let previous = points[points.length - 1];
  let previousDistance = normal[0] * previous[0] + normal[1] * previous[1] + normal[2] * previous[2] + constant;
  for (const point of points) {
    const distance = normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2] + constant;
    const previousInside = previousDistance >= -1e-9;
    const inside = distance >= -1e-9;
    if (previousInside !== inside) {
      const denominator = previousDistance - distance;
      const t = Math.abs(denominator) < 1e-12 ? 0 : previousDistance / denominator;
      result.push([previous[0] + (point[0] - previous[0]) * t, previous[1] + (point[1] - previous[1]) * t, previous[2] + (point[2] - previous[2]) * t]);
    }
    if (inside) result.push(point);
    previous = point;
    previousDistance = distance;
  }
  return result;
}

export function clipPolygonToCamera(points: Point3[], near: number, far: number): Point3[] {
  return clipPolygonAgainstPlane(clipPolygonAgainstPlane(points, [0, 0, -1], -near), [0, 0, 1], far);
}

/** Matrix elements use Three.js/OpenGL column-major order. */
export function transformPoint(point: Point3, matrix: ArrayLike<number>): Point3 {
  const [x, y, z] = point;
  return [matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12], matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13], matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]];
}

export function projectPoint(point: Point3, matrix: ArrayLike<number>, viewport: Viewport): Point2Depth | null {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!Number.isFinite(w) || w <= 1e-10) return null;
  const nx = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
  const ny = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
  const nz = (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w;
  if (![nx, ny, nz].every(Number.isFinite)) return null;
  return { x: viewport.x + (nx + 1) * viewport.width / 2, y: viewport.y + (1 - ny) * viewport.height / 2, z: nz, w };
}

export function clipSegmentAgainstPlane(a: Point3, b: Point3, normal: Point3, constant: number): [Point3, Point3] | null {
  const da = normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2] + constant;
  const db = normal[0] * b[0] + normal[1] * b[1] + normal[2] * b[2] + constant;
  if (da < 0 && db < 0) return null;
  if (da >= 0 && db >= 0) return [a, b];
  const t = da / (da - db);
  const point: Point3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return da < 0 ? [point, b] : [a, point];
}
