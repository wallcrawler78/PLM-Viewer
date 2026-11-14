import { STEP_LIMITS } from './step-types';
import type { CadHierarchyNode, CadMeshRange, CadSourceToPart, CadVec3, OcctImporter, StepImportResult } from './step-types';
import { CadImportError, sourceRotation, validateStepMapping } from './step-mapping';
export { CadImportError, validateCadNodePath } from './step-mapping';

export const STEP_TESSELLATION = Object.freeze({
  linearUnit: 'millimeter' as const,
  linearDeflectionType: 'absolute_value' as const,
  linearDeflection: 0.1,
  angularDeflection: 0.15,
});

export async function verifyStepSource(bytes: Uint8Array, expectedHash?: string): Promise<string> {
  if (!bytes.byteLength || bytes.byteLength > STEP_LIMITS.maxSourceBytes) throw new CadImportError('This STEP exceeds the 32 MiB local import limit or is empty.');
  const header = new TextDecoder().decode(bytes.subarray(0, 128)).replace(/^\uFEFF/, '').trimStart();
  if (!header.startsWith('ISO-10303-21;')) throw new CadImportError('This attachment is not a supported STEP Part 21 file.');
  if (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) throw new CadImportError('This STEP source needs a valid SHA-256 identity.');
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (expectedHash && actual !== expectedHash) throw new CadImportError('The STEP bytes do not match this source edition. Reopen the attachment.');
  return actual;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CadImportError('The STEP importer returned invalid geometry.');
  return value as Record<string, unknown>;
}

function label(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512) : '';
}

function hierarchy(value: unknown, meshCount: number): CadHierarchyNode {
  let count = 0;
  const seen = new Set<object>();
  const visit = (input: unknown, depth: number): CadHierarchyNode => {
    if (++count > STEP_LIMITS.maxHierarchyNodes || depth > STEP_LIMITS.maxHierarchyDepth) throw new CadImportError('This STEP assembly hierarchy exceeds the local review limit.');
    const node = object(input);
    if (seen.has(node)) throw new CadImportError('The STEP assembly hierarchy is cyclic.');
    seen.add(node);
    if (!Array.isArray(node.meshes) || !node.meshes.every(index => Number.isSafeInteger(index) && index >= 0 && index < meshCount) || !Array.isArray(node.children)) throw new CadImportError('The STEP assembly hierarchy has invalid component references.');
    const result = { name: label(node.name), meshIndices: [...node.meshes] as number[], children: node.children.map(child => visit(child, depth + 1)) };
    seen.delete(node);
    return result;
  };
  return visit(value, 0);
}

type ValidMesh = { positions: number[]; normals?: number[]; indices: number[]; name: string; color?: CadVec3 };

function meshes(value: unknown): ValidMesh[] {
  if (!Array.isArray(value) || !value.length || value.length > STEP_LIMITS.maxMeshes) throw new CadImportError('This STEP contains no supported display geometry or too many bodies.');
  let vertices = 0, triangles = 0;
  return value.map(input => {
    const mesh = object(input), attributes = object(mesh.attributes);
    const positions = object(attributes.position).array;
    const indices = object(mesh.index).array;
    const normals = attributes.normal === undefined ? undefined : object(attributes.normal).array;
    if (!Array.isArray(positions) || positions.length < 9 || positions.length % 3 || !Array.isArray(indices) || indices.length < 3 || indices.length % 3) throw new CadImportError('The STEP importer returned incomplete triangles.');
    vertices += positions.length / 3; triangles += indices.length / 3;
    if (vertices > STEP_LIMITS.maxVertices || triangles > STEP_LIMITS.maxTriangles) throw new CadImportError('This STEP exceeds the local geometry budget. Use a smaller source assembly.');
    if (!positions.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9) || !indices.every(value => Number.isSafeInteger(value) && value >= 0 && value < positions.length / 3)) throw new CadImportError('The STEP importer returned invalid vertices or triangle references.');
    if (normals !== undefined && (!Array.isArray(normals) || normals.length !== positions.length || !normals.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 2))) throw new CadImportError('The STEP importer returned invalid surface normals.');
    const color = Array.isArray(mesh.color) && mesh.color.length === 3 && mesh.color.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ? mesh.color as CadVec3 : undefined;
    return { positions, indices, normals: normals as number[] | undefined, name: label(mesh.name), ...(color ? { color } : {}) };
  });
}

/** OCCT applies source placements. Only an explicit rigid mapping may change that frame. */
export function normalizeStepResult(value: unknown, sourceHash: string, requestedPath?: number[], requestedTransform?: CadSourceToPart): StepImportResult {
  const { cadNodePath, sourceToPart } = validateStepMapping(requestedPath, requestedTransform);
  const raw = object(value);
  if (raw.success !== true) throw new CadImportError('This STEP could not be imported. Check its export format and geometry.');
  const validated = meshes(raw.meshes);
  const tree = hierarchy(raw.root, validated.length);
  let selected = tree;
  for (const childIndex of cadNodePath) {
    if (!selected.children[childIndex]) throw new CadImportError('The mapped STEP component is absent from this source edition. No other component was substituted.');
    selected = selected.children[childIndex];
  }
  const selectedIndices = new Set<number>();
  const collect = (node: CadHierarchyNode) => { node.meshIndices.forEach(index => selectedIndices.add(index)); node.children.forEach(collect); };
  collect(selected);
  if (!selectedIndices.size) throw new CadImportError('The mapped STEP component contains no supported display geometry.');
  const included = [...selectedIndices].map(index => ({ index, mesh: validated[index] }));
  const vertexValues = included.reduce((sum, entry) => sum + entry.mesh.positions.length, 0);
  const indexValues = included.reduce((sum, entry) => sum + entry.mesh.indices.length, 0);
  const positions = new Float32Array(vertexValues), normals = new Float32Array(vertexValues), indices = new Uint32Array(indexValues);
  const min: CadVec3 = [Infinity, Infinity, Infinity], max: CadVec3 = [-Infinity, -Infinity, -Infinity];
  const meshRanges: CadMeshRange[] = [];
  const rotation = sourceRotation(sourceToPart);
  let vertexOffset = 0, indexOffset = 0, missingNormals = false;
  for (const { index, mesh } of included) {
    // Convert in double precision before storing display floats. This avoids
    // losing small local details when an assembly has a large source offset.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
      for (let axis = 0; axis < 3; axis++) {
        const offset = axis * 3;
        const coordinate = rotation[offset] * x + rotation[offset + 1] * y + rotation[offset + 2] * z + sourceToPart.position[axis];
        if (!Number.isFinite(coordinate) || Math.abs(coordinate) > 1e9) throw new CadImportError('The mapped STEP coordinates exceed the local review range. Check its sourceToPart transform.');
        positions[vertexOffset + i + axis] = coordinate;
        if (mesh.normals) normals[vertexOffset + i + axis] = rotation[offset] * mesh.normals[i] + rotation[offset + 1] * mesh.normals[i + 1] + rotation[offset + 2] * mesh.normals[i + 2];
      }
    }
    if (!mesh.normals) missingNormals = true;
    for (let i = 0; i < mesh.indices.length; i++) indices[indexOffset + i] = mesh.indices[i] + vertexOffset / 3;
    meshRanges.push({ sourceMeshIndex: index, name: mesh.name, firstTriangle: indexOffset / 3, triangleCount: mesh.indices.length / 3, ...(mesh.color ? { color: mesh.color } : {}) });
    vertexOffset += mesh.positions.length; indexOffset += mesh.indices.length;
  }
  for (let i = 0; i < positions.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis], positions[i]); max[axis] = Math.max(max[axis], positions[i]); }
  if (missingNormals) computeNormals(positions, indices, normals);
  return { positions, normals, indices, bounds: { min, max }, hierarchy: tree, meshRanges, sourceHash, units: 'mm', cadNodePath, sourceToPart,
    warnings: included.length > 1 ? ['This STEP contains multiple bodies. Selection follows the mapped BOM occurrence; automatic matching of its internal components is unavailable.'] : [],
  };
}

function computeNormals(positions: Float32Array, indices: Uint32Array, normals: Float32Array) {
  normals.fill(0);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] * 3, b = indices[offset + 1] * 3, c = indices[offset + 2] * 3;
    const ab = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const ac = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    for (const vertex of [a, b, c]) for (let axis = 0; axis < 3; axis++) normals[vertex + axis] += normal[axis];
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (length) for (let axis = 0; axis < 3; axis++) normals[i + axis] /= length;
  }
}

export async function importStepBytes(importer: OcctImporter, bytes: Uint8Array, expectedHash?: string, cadNodePath?: number[], sourceToPart?: CadSourceToPart): Promise<StepImportResult> {
  const mapping = validateStepMapping(cadNodePath, sourceToPart);
  const sourceHash = await verifyStepSource(bytes, expectedHash);
  let raw: unknown;
  try { raw = importer.ReadStepFile(bytes, STEP_TESSELLATION); }
  catch { throw new CadImportError('The local CAD engine could not process this STEP. Its geometry may be unsupported or exceed available memory.'); }
  return normalizeStepResult(raw, sourceHash, mapping.cadNodePath, mapping.sourceToPart);
}
