/**
 * Compose explicitly declared parent-local BOM placements into world poses.
 * CAD sourceToPart normalization is independent. This module is shared by the
 * server and browser without pulling the 3D renderer into document-first views.
 */
export const BOM_PLACEMENT_LIMITS = Object.freeze({ occurrences: 50_000, depth: 256 });
const finiteVector = value => Array.isArray(value) && value.length === 3 && [0, 1, 2].every(index => typeof value[index] === 'number' && Number.isFinite(value[index]));
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

function quaternion(rotation) {
  const [x, y, z] = rotation.map(value => value / 2);
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}
function multiply(a, b) {
  const [x, y, z, w] = a, [bx, by, bz, bw] = b;
  const q = [w * bx + x * bw + y * bz - z * by, w * by - x * bz + y * bw + z * bx, w * bz + x * by - y * bx + z * bw, w * bw - x * bx - y * by - z * bz];
  const length = Math.hypot(...q);
  return q.map(value => value / length);
}
function rotate(position, q) {
  const [x, y, z] = position, [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
}
function euler(q) {
  const [x, y, z, w] = q;
  // For XYZ Euler angles, these quaternion pairs encode (X+Z)/2 and
  // (X-Z)/2. Their magnitudes encode cos(Y/2) +/- sin(Y/2). This preserves
  // the physical orientation near gimbal lock without snapping Z to zero
  // across an arbitrary angular band. At the singularity X and Z remain
  // non-unique, but their observable sum/difference is preserved.
  const sum = Math.atan2(x + z, w + y), difference = Math.atan2(x - z, w - y);
  const pitch = 2 * Math.atan2(Math.hypot(x + z, w + y), Math.hypot(x - z, w - y)) - Math.PI / 2;
  return [sum + difference, pitch, sum - difference];
}

/** Compare physical rotations, including equivalent Euler branches and q/-q. */
export function sameBomOrientation(a, b, angularTolerance = 1e-8) {
  if (!finiteVector(a) || !finiteVector(b) || typeof angularTolerance !== 'number' || !Number.isFinite(angularTolerance) || angularTolerance < 0 || angularTolerance > Math.PI) throw new Error('Invalid BOM orientation comparison.');
  const left = quaternion(a), right = quaternion(b);
  const leftLength = Math.hypot(...left), rightLength = Math.hypot(...right);
  const difference = Math.hypot(...left.map((value, axis) => value / leftLength - right[axis] / rightLength));
  const sum = Math.hypot(...left.map((value, axis) => value / leftLength + right[axis] / rightLength));
  // The shorter unit-quaternion chord is 2*sin(physicalAngle/4).
  // Unlike acos(dot), this remains sensitive to very small rotations.
  return angularTolerance === Math.PI || Math.min(difference, sum) <= 2 * Math.sin(angularTolerance / 4);
}

/** Omitted means legacy world poses. Explicit parent poses return a new world snapshot. */
export function normalizeBomPlacements(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.occurrences)) throw new Error('Incomplete BOM placement data.');
  if (snapshot.placementSpace !== undefined && !['world', 'parent'].includes(snapshot.placementSpace)) throw new Error('BOM placementSpace must be world or parent. No coordinate frame was guessed.');
  if (snapshot.occurrences.length > BOM_PLACEMENT_LIMITS.occurrences) throw new Error('This BOM exceeds the occurrence placement limit.');
  const rows = new Map();
  for (const row of snapshot.occurrences) {
    if (!row || !identity(row.id) || rows.has(row.id)) throw new Error('BOM occurrence identifiers must be unique and valid.');
    if (!finiteVector(row.position) || !finiteVector(row.rotation)) throw new Error(`Missing or invalid placement for ${row.id}`);
    if (row.parentId !== undefined && !identity(row.parentId)) throw new Error(`Invalid parent for ${row.id}`);
    rows.set(row.id, row);
  }
  for (const row of rows.values()) if (row.parentId !== undefined && !rows.has(row.parentId)) throw new Error(`Unknown parent for ${row.id}`);
  const resolved = new Map(), local = snapshot.placementSpace === 'parent';
  for (const start of rows.values()) {
    if (resolved.has(start.id)) continue;
    const chain = [], visited = new Set();
    let cursor = start;
    while (cursor && !resolved.has(cursor.id)) {
      if (visited.has(cursor.id)) throw new Error(`Cyclic BOM placement hierarchy: ${start.id}`);
      visited.add(cursor.id); chain.push(cursor);
      if (chain.length > BOM_PLACEMENT_LIMITS.depth) throw new Error('This BOM exceeds the supported placement hierarchy depth.');
      cursor = cursor.parentId === undefined ? undefined : rows.get(cursor.parentId);
    }
    while (chain.length) {
      const row = chain.pop(), parent = row.parentId === undefined ? undefined : resolved.get(row.parentId);
      if (local && parent && rows.get(row.parentId).modelState === 'placement-needed') throw new Error(`The parent placement for ${row.id} is unresolved. No position was guessed.`);
      const depth = (parent?.depth ?? 0) + 1;
      if (depth > BOM_PLACEMENT_LIMITS.depth) throw new Error('This BOM exceeds the supported placement hierarchy depth.');
      // World snapshots still need graph validation, but their poses are
      // already final; avoid trigonometry and redundant vector allocation.
      if (!local) { resolved.set(row.id, { depth }); continue; }
      const relativeRotation = quaternion(row.rotation);
      const q = parent ? multiply(parent.quaternion, relativeRotation) : relativeRotation;
      const position = parent ? rotate(row.position, parent.quaternion).map((value, axis) => value + parent.position[axis]) : row.position;
      const rotation = parent ? euler(q) : row.rotation;
      if (!finiteVector(position) || !finiteVector(rotation)) throw new Error(`Composed placement is outside the numeric range for ${row.id}`);
      resolved.set(row.id, { position, rotation, quaternion: q, depth });
    }
  }
  if (!local) return snapshot;
  return { ...snapshot, placementSpace: 'world', occurrences: snapshot.occurrences.map(row => ({ ...row, position: [...resolved.get(row.id).position], rotation: [...resolved.get(row.id).rotation] })) };
}
