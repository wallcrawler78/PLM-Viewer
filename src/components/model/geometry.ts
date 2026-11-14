import { Box3, Euler, Matrix4, Vector3 } from 'three';
import type { SceneBounds, ScenePart, Vec3 } from './types';

export const vec = (point: number[]): Vec3 => [point[0], point[1], point[2]];
// Matches the local STEP importer's coordinate range. The world scene must keep
// the same bound after occurrence placement, before derived GPU/display work.
export const MAX_REVIEW_COORDINATE_MM = 1e9;

export function occurrenceMatrix(part: Pick<ScenePart, 'position' | 'rotation'>): Matrix4 {
  const matrix = new Matrix4().makeRotationFromEuler(new Euler(...(part.rotation ?? [0, 0, 0]), 'XYZ'));
  matrix.setPosition(...part.position);
  return matrix;
}

export function localToAssembled(point: Vec3, part: Pick<ScenePart, 'position' | 'rotation'>): Vec3 {
  return new Vector3(...point).applyMatrix4(occurrenceMatrix(part)).toArray() as Vec3;
}

export function validateScenePlacement(part: Pick<ScenePart, 'position' | 'rotation' | 'bbox'>, geometryBounds: Box3 | null): void {
  const inRange = (number: number) => Number.isFinite(number) && Math.abs(number) <= MAX_REVIEW_COORDINATE_MM;
  if (part.position.length !== 3 || !part.position.every(inRange)
    || part.rotation !== undefined && (part.rotation.length !== 3 || !part.rotation.every(Number.isFinite))) {
    throw new Error('The model placement exceeds the local review range (±1e9 mm) or has an invalid rotation. Check the BOM placement.');
  }
  const matrix = occurrenceMatrix(part);
  const check = (box: Box3 | null, label: string) => {
    if (!box || box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(inRange)) {
      throw new Error(`The ${label} envelope exceeds the local review range (±1e9 mm) or is invalid. Check the source geometry.`);
    }
    const placed = box.clone().applyMatrix4(matrix);
    if (![...placed.min.toArray(), ...placed.max.toArray()].every(inRange)) {
      throw new Error(`The transformed ${label} envelope exceeds the local review range (±1e9 mm). Check the BOM placement.`);
    }
  };
  check(geometryBounds, 'model');
  // Verify actual geometry even when the provider supplies a smaller CAD box;
  // both envelopes participate in display, picking and measurement behavior.
  if (part.bbox) check(new Box3(new Vector3(...vec(part.bbox.min)), new Vector3(...vec(part.bbox.max))), 'CAD');
}

/** A transformed source AABB is an envelope, not an oriented/minimum-volume box. */
export function boundsForParts(parts: ScenePart[]): SceneBounds | null {
  const result = new Box3();
  const included: string[] = [];
  let includesMeshBounds = false;
  for (const part of parts) {
    if (!part.bbox || part.bbox.min.length !== 3 || part.bbox.max.length !== 3) continue;
    const values = [...part.bbox.min, ...part.bbox.max];
    if (!values.every(Number.isFinite)) continue;
    const box = new Box3(new Vector3(...vec(part.bbox.min)), new Vector3(...vec(part.bbox.max)));
    if (box.isEmpty()) continue;
    result.union(box.applyMatrix4(occurrenceMatrix(part)));
    included.push(part.id);
    if (part.bboxSource === 'mesh') includesMeshBounds = true;
  }
  if (result.isEmpty()) return null;
  return {
    min: result.min.toArray() as Vec3,
    max: result.max.toArray() as Vec3,
    size: result.getSize(new Vector3()).toArray() as Vec3,
    source: includesMeshBounds ? 'tessellated-bounds' : 'cad-bounds-envelope',
    occurrenceIds: included,
  };
}

export function selectedVisibleParts(parts: ScenePart[], selectedIds: string[], hiddenIds: string[]): ScenePart[] {
  const hidden = new Set(hiddenIds), selection = new Set(selectedIds);
  const visible = parts.filter(part => !hidden.has(part.id));
  const selected = visible.filter(part => selection.has(part.id));
  return selectedIds.length ? selected : visible;
}

export function pointDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function validateMesh(data: unknown): asserts data is { positions: number[]; indices: number[]; normals?: number[] } {
  if (!data || typeof data !== 'object') throw new Error('The mesh response is not an object.');
  const value = data as Record<string, unknown>;
  // Finite JSON doubles can overflow when converted to the renderer's Float32
  // attributes. Reject them before they can contaminate bounds and raycasting.
  const finiteAttribute = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && Number.isFinite(Math.fround(number));
  if (!Array.isArray(value.positions) || value.positions.length < 9 || value.positions.length % 3 !== 0 || value.positions.length > 18_000_000 || !value.positions.every(number => finiteAttribute(number) && Math.abs(number) <= MAX_REVIEW_COORDINATE_MM)) {
    throw new Error('The mesh has invalid or oversized vertex data.');
  }
  const vertexCount = value.positions.length / 3;
  if (!Array.isArray(value.indices) || value.indices.length < 3 || value.indices.length % 3 !== 0 || value.indices.length > 36_000_000 || !value.indices.every(n => Number.isInteger(n) && n >= 0 && n < vertexCount)) {
    throw new Error('The mesh has invalid triangle references.');
  }
  if (value.normals !== undefined && (!Array.isArray(value.normals) || value.normals.length !== value.positions.length || !value.normals.every(finiteAttribute))) {
    throw new Error('The mesh has invalid vertex normals.');
  }
}
