export type CadVec3 = [number, number, number];

/** Rigid source-to-part mapping: millimeters, right-handed XYZ Euler radians.
 * pPart = RXYZ(rotation) * pSource + position. No scale or axis guessing.
 */
export interface CadSourceToPart { position: CadVec3; rotation: CadVec3; }

export const STEP_LIMITS = Object.freeze({
  maxSourceBytes: 32 * 1024 * 1024,
  maxVertices: 2_000_000,
  maxTriangles: 1_000_000,
  maxMeshes: 10_000,
  maxHierarchyNodes: 20_000,
  maxHierarchyDepth: 64,
  maxQueuedImports: 128,
  fetchTimeoutMs: 30_000,
  importTimeoutMs: 120_000,
});

export interface CadHierarchyNode {
  name: string;
  meshIndices: number[];
  children: CadHierarchyNode[];
}

export interface CadMeshRange {
  sourceMeshIndex: number;
  name: string;
  firstTriangle: number;
  triangleCount: number;
  /** Display color only; never an engineering material declaration. */
  color?: CadVec3;
}

export interface StepImportResult {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  bounds: { min: CadVec3; max: CadVec3 };
  hierarchy: CadHierarchyNode;
  meshRanges: CadMeshRange[];
  sourceHash: string;
  units: 'mm';
  /** Exact child-index path under hierarchy; [] represents the entire source. */
  cadNodePath: number[];
  /** Applied before tessellated bounds are calculated; output vertices are part-local. */
  sourceToPart: CadSourceToPart;
  warnings: string[];
}

export interface StepWorkerRequest {
  type: 'import-step';
  bytes: ArrayBuffer;
  expectedHash?: string;
  cadNodePath?: number[];
  sourceToPart?: CadSourceToPart;
}

export type StepWorkerResponse =
  | { type: 'step-result'; result: StepImportResult }
  | { type: 'step-error'; message: string };

export interface OcctImporter {
  ReadStepFile(bytes: Uint8Array, options: { linearUnit: 'millimeter'; linearDeflectionType: 'absolute_value'; linearDeflection: number; angularDeflection: number }): unknown;
}
export type OcctFactory = (options: { locateFile: (file: string) => string; print: () => void; printErr: () => void }) => Promise<OcctImporter>;
