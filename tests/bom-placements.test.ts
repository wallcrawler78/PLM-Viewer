import { describe, expect, it, vi } from 'vitest';
import { Euler, Matrix4, Vector3 } from 'three';
import { BOM_PLACEMENT_LIMITS, normalizeBomPlacements } from '../shared/bom-placements.mjs';
import type { PlacementOccurrence } from '../shared/bom-placements.mjs';
import { compareSnapshots, validateSnapshot } from '../src/domain';
import { sceneParts } from '../src/model-sources';
import { PreviewAdapter } from '../src/data/previewAdapter';
import manifest from '../public/fixtures/manifest.json';

function matrix(row: PlacementOccurrence) { return new Matrix4().makeRotationFromEuler(new Euler(...row.rotation, 'XYZ')).setPosition(...row.position); }
function expectMatrix(actual: Matrix4, expected: Matrix4) { actual.elements.forEach((value, index) => expect(value).toBeCloseTo(expected.elements[index], 9)); }
const root: PlacementOccurrence = { id: 'parent', position: [100, -20, 35], rotation: [.3, -.4, .2] };
const middle: PlacementOccurrence = { id: 'middle', parentId: root.id, position: [10, 5, -2], rotation: [-.6, .1, 1.2] };
const leaf: PlacementOccurrence = { id: 'leaf', parentId: middle.id, position: [-7, 4, 20], rotation: [.2, .8, -.3] };
const sample = () => new PreviewAdapter('precision', vi.fn(async () => new Response(JSON.stringify(manifest)))).loadBom('B');

describe('explicit nested BOM placements', () => {
  it('composes unordered ancestors using the same XYZ rigid math as the renderer', () => {
    const input = { placementSpace: 'parent' as const, occurrences: structuredClone([leaf, root, middle]) };
    const before = structuredClone(input);
    const normalized = normalizeBomPlacements(input);
    expectMatrix(matrix(normalized.occurrences[0]), matrix(root).multiply(matrix(middle)).multiply(matrix(leaf)));
    expectMatrix(matrix(normalized.occurrences[2]), matrix(root).multiply(matrix(middle)));
    expect(input).toEqual(before);
    expect(normalized.placementSpace).toBe('world');
    expect(normalized.occurrences[0].parentId).toBe(middle.id);
    expect(normalizeBomPlacements(normalized)).toBe(normalized);
  });
  it('does not infer parent-local coordinates merely because parent IDs exist', () => {
    const input = { occurrences: structuredClone([root, middle, leaf]) };
    expect(normalizeBomPlacements(input)).toBe(input);
    expect(normalizeBomPlacements({ ...input, placementSpace: 'world' }).occurrences[2].position).toEqual(leaf.position);
  });
  it('handles gimbal-lock orientations and repeated siblings without sharing poses', () => {
    const parent = { ...root, rotation: [0, Math.PI / 2, 0] as [number, number, number] };
    const children = [1, -1].map((sign, index) => ({ ...middle, id: `child-${index}`, position: [0, sign * 40, 12] as [number, number, number] }));
    const normalized = normalizeBomPlacements({ placementSpace: 'parent', occurrences: [...children, parent] });
    for (const child of children) expectMatrix(matrix(normalized.occurrences.find(row => row.id === child.id)!), matrix(parent).multiply(matrix(child)));
    expect(normalized.occurrences[0].position).not.toEqual(normalized.occurrences[1].position);
  });
  it('preserves physical orientation and measured points immediately around either gimbal singularity', () => {
    const parent = { ...root, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };
    for (const sign of [-1, 1]) for (const offset of [0, 1e-12, 1e-8, 1e-6, 1e-4, 1e-3]) {
      const child = { ...middle, rotation: [.3, sign * (Math.PI / 2 - offset), 1.2] as [number, number, number] };
      const normalized = normalizeBomPlacements({ placementSpace: 'parent', occurrences: [parent, child] });
      const actual = matrix(normalized.occurrences[1]), expected = matrix(parent).multiply(matrix(child));
      expectMatrix(actual, expected);
      const probe = new Vector3(1000, -600, 800);
      expect(probe.clone().applyMatrix4(actual).distanceTo(probe.clone().applyMatrix4(expected))).toBeLessThan(1e-9);
    }
  });
  it('composes a long non-axis-aligned hierarchy consistently with independent renderer matrices', () => {
    const occurrences: PlacementOccurrence[] = Array.from({ length: 80 }, (_, index) => ({
      id: `nested-${index}`, parentId: index ? `nested-${index - 1}` : undefined,
      position: [Math.sin(index) * 20, Math.cos(index * .7) * 30, index / 3],
      rotation: [Math.sin(index * .31) * 8, Math.cos(index * .71) * 6, Math.sin(index * .37) * 7],
    }));
    const normalized = normalizeBomPlacements({ placementSpace: 'parent', occurrences: [...occurrences].reverse() });
    const expected = new Matrix4();
    for (const row of occurrences) {
      expected.multiply(matrix(row));
      expectMatrix(matrix(normalized.occurrences.find(value => value.id === row.id)!), expected);
    }
  });
  it('retains occurrence-local point meaning after nested scene placement', () => {
    const normalized = normalizeBomPlacements({ placementSpace: 'parent', occurrences: [root, middle, leaf] });
    const world = matrix(normalized.occurrences[2]);
    const point = new Vector3(3, -2, 7);
    const transformed = point.clone().applyMatrix4(world);
    const restored = transformed.applyMatrix4(world.clone().invert());
    expect(restored.distanceTo(point)).toBeLessThan(1e-10);
  });
  it('resolves unloaded container ancestors before selecting a loaded child', async () => {
    const snapshot = await sample(), child = snapshot.occurrences.find(row => row.id === 'occ-base')!;
    snapshot.placementSpace = 'parent';
    child.parentId = 'container'; child.position = [10, 0, 0]; child.rotation = [0, 0, 0];
    snapshot.occurrences.push({ ...child, id: 'container', parentId: undefined, position: [100, 20, 30], rotation: [0, 0, Math.PI / 2], modelState: 'no-model' });
    const normalized = validateSnapshot(snapshot);
    expect(normalized.placementSpace).toBe('world');
    const [part] = sceneParts(snapshot, [child.id]);
    expect(part.position[0]).toBeCloseTo(100); expect(part.position[1]).toBeCloseTo(30); expect(part.position[2]).toBeCloseTo(30);
    expect(sceneParts(normalized, [child.id])).toEqual([part]);
    expect(child.position).toEqual([10, 0, 0]);
  });
  it('includes inherited child motion in configuration comparison', async () => {
    const before = await sample();
    before.placementSpace = 'parent';
    before.occurrences[1].parentId = before.occurrences[0].id;
    const after = structuredClone(before); after.occurrences[0].position[0] += 25;
    const moved = compareSnapshots(before, after).filter(change => change.kind === 'moved');
    expect(moved.map(change => change.occurrenceId)).toEqual(expect.arrayContaining([before.occurrences[0].id, before.occurrences[1].id]));
    expect(moved.every(change => change.summary.includes('25.0 mm'))).toBe(true);
    expect(compareSnapshots(before, validateSnapshot(structuredClone(before)))).toEqual([]);
  });
  it('fails closed on an unresolved ancestor instead of inventing an origin', () => {
    expect(() => normalizeBomPlacements({ placementSpace: 'parent', occurrences: [{ ...root, modelState: 'placement-needed' }, middle] })).toThrow('unresolved');
  });
  it.each([
    { occurrences: [{ ...root, parentId: 'missing' }], error: 'Unknown parent' },
    { occurrences: [{ ...root, parentId: middle.id }, middle], error: 'Cyclic' },
    { occurrences: [root, { ...root }], error: 'unique' },
    { occurrences: [{ ...root, position: [0, Number.NaN, 0] }], error: 'invalid placement' },
    { occurrences: [{ ...root, rotation: Array(3) }], error: 'invalid placement' },
    { occurrences: [{ ...root, parentId: '' }], error: 'parent' },
  ])('rejects invalid placement graphs and vectors: $error', ({ occurrences, error }) => {
    for (const placementSpace of ['parent', 'world', undefined]) expect(() => normalizeBomPlacements({ placementSpace, occurrences } as never)).toThrow(error);
  });
  it('bounds hierarchy depth without recursive stack growth', () => {
    const occurrences = Array.from({ length: BOM_PLACEMENT_LIMITS.depth + 1 }, (_, index) => ({ id: `node-${index}`, parentId: index ? `node-${index - 1}` : undefined, position: [0, 0, 1], rotation: [0, 0, 0] }));
    for (const placementSpace of ['parent', 'world', undefined]) {
      expect(() => normalizeBomPlacements({ placementSpace, occurrences } as never)).toThrow('depth');
      expect(() => normalizeBomPlacements({ placementSpace, occurrences: [...occurrences].reverse() } as never)).toThrow('depth');
    }
  });
  it('rejects an unknown frame and arithmetic overflow', () => {
    expect(() => normalizeBomPlacements({ placementSpace: 'guessed', occurrences: [] } as never)).toThrow('No coordinate frame was guessed');
    const overflow = [{ ...root, position: [Number.MAX_VALUE, 0, 0], rotation: [0, 0, 0] }, { ...middle, position: [Number.MAX_VALUE, 0, 0], rotation: [0, 0, 0] }];
    expect(() => normalizeBomPlacements({ placementSpace: 'parent', occurrences: overflow } as never)).toThrow('numeric range');
  });
});
