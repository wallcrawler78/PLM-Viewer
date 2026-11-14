import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createContext, Script } from 'node:vm';
import { BufferAttribute, BufferGeometry, Euler, Group, Matrix3, Matrix4, Mesh, Vector3 } from 'three';
import { createCspCompatibleOcct } from '../scripts/prepare-cad-runtime.mjs';
import { importStepBytes, normalizeStepResult, verifyStepSource } from '../src/cad/step-import';
import { validateSourceToPart } from '../src/cad/step-mapping';
import type { CadSourceToPart, OcctImporter } from '../src/cad/step-types';
import { sceneParts } from '../src/model-sources';
import { validateSnapshot } from '../src/domain';
import type { BomSnapshot, Vec3 } from '../src/domain';
import { boundsForParts, localToAssembled } from '../src/components/model/geometry';
import manifest from '../public/fixtures/manifest.json';

const packageDirectory = resolve('node_modules/occt-import-js');
const glue = readFileSync(resolve(packageDirectory, 'dist/occt-import-js.js'), 'utf8');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let importer: OcctImporter;
const identity: CadSourceToPart = { position: [0, 0, 0], rotation: [0, 0, 0] };

beforeAll(async () => {
  // Compile the trusted package once. All subsequent Function/eval generation
  // is prohibited by the VM, matching the important MV3 restriction.
  const directory = resolve(packageDirectory, 'dist');
  const context = createContext({ module: { exports: {} }, exports: {}, require: createRequire(resolve(directory, 'occt-import-js.js')),
    __dirname: directory, process, console, TextDecoder, TextEncoder, setTimeout, clearTimeout,
  }, { codeGeneration: { strings: false, wasm: true } });
  new Script(createCspCompatibleOcct(glue)).runInContext(context);
  importer = await context.module.exports({ wasmBinary: readFileSync(resolve(directory, 'occt-import-js.wasm')), print: () => {}, printErr: () => {} });
}, 20_000);

describe('actual local OpenCascade STEP import', () => {
  it('imports raw STEP into finite millimeter geometry with string-code-generation disabled', async () => {
    const part = manifest.parts.find(part => part.id === 'base' && part.revision === 'A')!;
    const bytes = readFileSync(resolve('public', part.stepUrl.slice(1)));
    const result = await importStepBytes(importer, bytes, part.sourceHash);
    expect(result.sourceHash).toBe(part.sourceHash);
    expect(result.units).toBe('mm');
    expect(result.indices.length).toBeGreaterThan(1000);
    expect(result.positions.every(Number.isFinite)).toBe(true);
    expect(result.normals.every(Number.isFinite)).toBe(true);
    expect(result.meshRanges).toHaveLength(1);
    for (let axis = 0; axis < 3; axis++) {
      expect(result.bounds.min[axis]).toBeCloseTo(part.bbox.min[axis], 4);
      expect(result.bounds.max[axis]).toBeCloseTo(part.bbox.max[axis], 4);
    }
  }, 20_000);

  it('normalizes meter, millimeter and inch STEP representations into the same physical scale', async () => {
    for (const units of ['m', 'mm', 'in']) {
      const bytes = readFileSync(resolve(packageDirectory, `test/testfiles/cube-units/cube-${units}.step`));
      const result = await importStepBytes(importer, bytes, hash(bytes));
      expect(result.bounds.max[0] - result.bounds.min[0]).toBeCloseTo(1000, 3);
    }
  }, 20_000);

  it('preserves assembly placements and selects exact repeated subcomponents without matching names', async () => {
    const bytes = readFileSync(resolve('public/fixtures/step/atlas-assembly-A.step'));
    const sourceHash = hash(bytes);
    const assembly = await importStepBytes(importer, bytes, sourceHash);
    expect(assembly.meshRanges).toHaveLength(9);
    expect(assembly.hierarchy.children[0].children).toHaveLength(9);
    expect(assembly.warnings[0]).toContain('multiple bodies');
    // The upstream exporter repeats the name "occ-bolt-1". Child paths remain
    // distinct and preserve the imported assembly's positive/negative Y poses.
    const first = await importStepBytes(importer, bytes, sourceHash, [0, 5], identity);
    const second = await importStepBytes(importer, bytes, sourceHash, [0, 6], identity);
    expect(first.hierarchy.children[0].children[5].name).toBe(second.hierarchy.children[0].children[6].name);
    expect(first.meshRanges).toHaveLength(1); expect(second.meshRanges).toHaveLength(1);
    expect((first.bounds.min[0] + first.bounds.max[0]) / 2).toBeCloseTo(-75, 3);
    expect((first.bounds.min[1] + first.bounds.max[1]) / 2).toBeCloseTo(-45, 3);
    expect((second.bounds.min[1] + second.bounds.max[1]) / 2).toBeCloseTo(45, 3);
    await expect(importStepBytes(importer, bytes, sourceHash, [0, 50], identity)).rejects.toThrow('absent from this source edition');
  }, 30_000);

  it('maps an actually imported assembly child into its part frame before applying a translated and rotated occurrence', async () => {
    const bytes = readFileSync(resolve('public/fixtures/step/atlas-assembly-A.step')), sourceHash = hash(bytes);
    const path = [0, 5];
    const source = await importStepBytes(importer, bytes, sourceHash, path, identity);
    const position: Vec3 = [-75, -45, -6], rotation: Vec3 = [0.32, -0.21, 0.53];
    const occurrenceMatrix = new Matrix4().makeRotationFromEuler(new Euler(...rotation, 'XYZ')).setPosition(...position);
    const inverse = occurrenceMatrix.clone().invert();
    const euler = new Euler().setFromRotationMatrix(inverse, 'XYZ');
    const sourceToPart: CadSourceToPart = { position: new Vector3().setFromMatrixPosition(inverse).toArray() as Vec3, rotation: [euler.x, euler.y, euler.z] };
    const snapshot = validateSnapshot({ id: 'mapped-assembly', workspaceId: 'test', rootItemId: 'assembly', rootItemNumber: 'ASM', title: 'Mapped assembly', revision: 'A', configurationId: 'frozen-A', units: 'mm', upAxis: 'Z', capturedAt: '2026-11-13T00:00:00Z', attributes: {}, documents: [],
      parts: [{ id: 'fastener', itemNumber: 'BOLT', name: 'Fastener', revision: 'A', stepUrl: '/fixtures/step/atlas-assembly-A.step', sourceHash, cadNodePath: path, sourceToPart, color: '#888888', material: 'Not supplied', attributes: {} }],
      occurrences: [{ id: 'fastener-1', partId: 'fastener', partRevision: 'A', itemNumber: 'BOLT', name: 'Fastener 1', position, rotation, quantity: 1, attributes: {}, modelState: 'loaded' }],
    } satisfies BomSnapshot);
    const [part] = sceneParts(snapshot, ['fastener-1']);
    const mapped = await importStepBytes(importer, bytes, part.sourceHash, part.cadNodePath, part.sourceToPart);
    expect(part.position).toEqual(position); expect(part.rotation).toEqual(rotation);
    expect(mapped.sourceToPart).toEqual(sourceToPart);
    const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(mapped.positions, 3));
    const group = new Group(), mesh = new Mesh(geometry);
    group.position.set(...part.position); group.rotation.set(...part.rotation!); group.add(mesh); group.updateMatrixWorld(true);
    const worldNormalMatrix = new Matrix3().getNormalMatrix(group.matrixWorld);
    try {
      // Every world vertex returns to the assembly position exactly once. Using
      // the already-placed source vertices directly would apply the pose twice.
      for (let offset = 0; offset < mapped.positions.length; offset += 3) {
        const local = new Vector3().fromArray(mapped.positions, offset), world = mesh.localToWorld(local.clone());
        const expectedWorld = new Vector3().fromArray(source.positions, offset);
        expect(world.distanceTo(expectedWorld)).toBeLessThan(0.00003);
        expect(group.worldToLocal(world.clone()).distanceTo(local)).toBeLessThan(1e-9);
        const normal = new Vector3().fromArray(mapped.normals, offset).applyMatrix3(worldNormalMatrix);
        expect(normal.distanceTo(new Vector3().fromArray(source.normals, offset))).toBeLessThan(0.000001);
      }
      const endpoint = new Vector3().fromArray(mapped.positions).toArray() as Vec3;
      const worldEndpoint = new Vector3(...localToAssembled(endpoint, part));
      expect(worldEndpoint.distanceTo(new Vector3().fromArray(source.positions))).toBeLessThan(0.00003);
      geometry.computeBoundingBox();
      expect(geometry.boundingBox!.min.toArray()).toEqual(mapped.bounds.min);
      expect(geometry.boundingBox!.max.toArray()).toEqual(mapped.bounds.max);
      expect(boundsForParts([{ ...part, bbox: mapped.bounds, bboxSource: 'mesh' }])).toMatchObject({ source: 'tessellated-bounds', occurrenceIds: ['fastener-1'] });
    } finally { geometry.dispose(); (mesh.material as { dispose: () => void }).dispose(); }
  }, 30_000);

  it('rejects changed source bytes and non-STEP data before invoking the CAD engine', async () => {
    const bytes = readFileSync(resolve('public/fixtures/step/base-A.step'));
    let calls = 0;
    const engine: OcctImporter = { ReadStepFile() { calls++; throw new Error('Should not import unverified bytes'); } };
    await expect(importStepBytes(engine, bytes, '0'.repeat(64))).rejects.toThrow('do not match');
    await expect(importStepBytes(engine, new TextEncoder().encode('%PDF-1.7'))).rejects.toThrow('not a supported STEP');
    await expect(verifyStepSource(bytes, 'not-a-hash')).rejects.toThrow('SHA-256');
    await expect(importStepBytes(engine, bytes, hash(bytes), [0, 5])).rejects.toThrow('explicit sourceToPart');
    await expect(importStepBytes(engine, bytes, hash(bytes), [])).rejects.toThrow('explicit sourceToPart');
    expect(calls).toBe(0);
  });

  it('refuses to silently apply the CSP patch to a different upstream binary loader', () => {
    expect(() => createCspCompatibleOcct(`${glue}\n`)).toThrow('loader changed');
    expect(createCspCompatibleOcct(glue)).not.toMatch(/newFunc\(Function|return Function\b|\beval\s*\(/);
  });
});

function syntheticResult() {
  const mesh = (offset: number) => ({ name: 'same name', attributes: { position: { array: [offset, 0, 0, offset + 1, 0, 0, offset, 1, 0] } }, index: { array: [0, 1, 2] } });
  return { success: true, meshes: [mesh(0), mesh(100)], root: { name: 'root', meshes: [] as number[], children: [
    { name: 'duplicate', meshes: [0], children: [] }, { name: 'duplicate', meshes: [1], children: [] },
  ] } };
}

describe('STEP import result boundary', () => {
  it('uses an exact hierarchy child path and computes display normals when absent', () => {
    const result = normalizeStepResult(syntheticResult(), 'a'.repeat(64), [1], identity);
    expect(result.bounds).toEqual({ min: [100, 0, 0], max: [101, 1, 0] });
    expect(Array.from(result.indices)).toEqual([0, 1, 2]);
    expect(Array.from(result.normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(result.meshRanges[0].sourceMeshIndex).toBe(1);
  });

  it('maps source points before display rounding and rejects unsupported or nonfinite frames', () => {
    const raw = syntheticResult();
    raw.meshes[0].attributes.position.array = [100000000, 0, 0, 100000001, 0, 0, 100000000, 1, 0];
    const result = normalizeStepResult(raw, 'a'.repeat(64), [0], { position: [-100000000, 0, 0], rotation: [0, 0, 0] });
    expect(result.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
    for (const value of [null, { position: [0, 0, 0], rotation: [Infinity, 0, 0] }, { position: new Array(3), rotation: [0, 0, 0] }, { ...identity, scale: 2 }, { ...identity, order: 'ZYX' }]) {
      expect(() => validateSourceToPart(value)).toThrow('sourceToPart transform is invalid');
    }
    expect(() => normalizeStepResult(raw, 'a'.repeat(64), [0], { position: [Number.MAX_VALUE, 0, 0], rotation: [0, 0, 0] })).toThrow('mapped STEP coordinates');
  });

  it('rejects invalid coordinates, indices, component paths and cyclic hierarchies', () => {
    const badPosition = syntheticResult(); badPosition.meshes[0].attributes.position.array[0] = Infinity;
    expect(() => normalizeStepResult(badPosition, 'a'.repeat(64))).toThrow('invalid vertices');
    const badIndex = syntheticResult(); badIndex.meshes[0].index.array[0] = 3;
    expect(() => normalizeStepResult(badIndex, 'a'.repeat(64))).toThrow('invalid vertices');
    expect(() => normalizeStepResult(syntheticResult(), 'a'.repeat(64), [-1])).toThrow('mapping is invalid');
    const cycle = syntheticResult(); (cycle.root.children as unknown[]).push(cycle.root);
    expect(() => normalizeStepResult(cycle, 'a'.repeat(64))).toThrow('cyclic');
  });
});
