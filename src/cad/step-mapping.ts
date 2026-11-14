import { STEP_LIMITS } from './step-types';
import type { CadSourceToPart, CadVec3 } from './step-types';

export class CadImportError extends Error {
  override name = 'CadImportError';
}

export function validateCadNodePath(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > STEP_LIMITS.maxHierarchyDepth || !Array.from(value).every(index => Number.isSafeInteger(index) && index >= 0 && index < STEP_LIMITS.maxHierarchyNodes)) {
    throw new CadImportError('This STEP component mapping is invalid. Reopen the exact source.');
  }
  return [...value];
}

function finiteVec(value: unknown): value is CadVec3 {
  return Array.isArray(value) && value.length === 3 && [0, 1, 2].every(index => typeof value[index] === 'number' && Number.isFinite(value[index]));
}

/** A subtree has already been placed by OCCT, so its frame must be explicit. */
export function validateSourceToPart(value: unknown, required = false): CadSourceToPart {
  if (value === undefined) {
    if (required) throw new CadImportError('A mapped STEP component needs an explicit sourceToPart transform, including identity. No coordinate frame was guessed.');
    return { position: [0, 0, 0], rotation: [0, 0, 0] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CadImportError('The STEP sourceToPart transform is invalid. Supply finite millimeter position and XYZ Euler rotation in radians.');
  const transform = value as Record<string, unknown>;
  if (Object.keys(transform).some(key => key !== 'position' && key !== 'rotation') || !finiteVec(transform.position) || !finiteVec(transform.rotation)) {
    throw new CadImportError('The STEP sourceToPart transform is invalid. Supply finite millimeter position and XYZ Euler rotation in radians.');
  }
  return { position: [...transform.position], rotation: [...transform.rotation] };
}

export function validateStepMapping(path: unknown, transform: unknown) {
  return { cadNodePath: validateCadNodePath(path), sourceToPart: validateSourceToPart(transform, path !== undefined) };
}

/** Same right-handed XYZ convention as the Three.js occurrence transform. */
export function sourceRotation(transform: CadSourceToPart): readonly number[] {
  const [x, y, z] = transform.rotation;
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  return [c * e, -c * f, d,
    a * f + b * e * d, a * e - b * f * d, -b * c,
    b * f - a * e * d, b * e + a * f * d, a * c];
}
