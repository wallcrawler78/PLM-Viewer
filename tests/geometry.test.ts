import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { boundsForParts, localToAssembled, pointDistance, selectedVisibleParts, validateMesh, validateScenePlacement } from '../src/components/model/geometry';
import type { ScenePart } from '../src/components/model/types';

const part = (overrides: Partial<ScenePart> = {}): ScenePart => ({ id: 'bolt-1', itemId: 'bolt', itemNumber: 'HD-001', name: 'Bolt', revision: 'A', color: '#888888', meshUrl: '/bolt.json', position: [0, 0, 0], bbox: { min: [0, 0, 0], max: [10, 20, 30] }, ...overrides });

describe('CAD occurrence coordinates', () => {
  it('retains the distinct world placement of repeated uses of the same part', () => {
    const parts = [part(), part({ id: 'bolt-2', position: [100, 5, -10] })];
    expect(boundsForParts(parts)?.min).toEqual([0, 0, -10]);
    expect(boundsForParts(parts)?.max).toEqual([110, 25, 30]);
    expect(boundsForParts(parts)?.size).toEqual([110, 25, 40]);
  });
  it('applies occurrence rotation before translation without recentering the source', () => {
    const point = localToAssembled([10, 0, 0], part({ position: [40, 50, 60], rotation: [0, 0, Math.PI / 2] }));
    expect(point[0]).toBeCloseTo(40); expect(point[1]).toBeCloseTo(60); expect(point[2]).toBeCloseTo(60);
    const bounds = boundsForParts([part({ rotation: [0, 0, Math.PI / 2] })]);
    expect(bounds?.min[0]).toBeCloseTo(-20); expect(bounds?.max[1]).toBeCloseTo(10);
  });
  it('measures point distance in millimeters in a shared assembled frame', () => {
    const a = localToAssembled([1, 2, 3], part({ position: [20, 0, 0] }));
    const b = localToAssembled([1, 2, 3], part({ position: [20, 30, 40] }));
    expect(pointDistance(a, b)).toBe(50);
  });
  it('does not include hidden components in a selection envelope', () => {
    const parts = [part(), part({ id: 'bolt-2', position: [100, 0, 0] })];
    expect(selectedVisibleParts(parts, ['bolt-1', 'bolt-2'], ['bolt-2']).map(p => p.id)).toEqual(['bolt-1']);
    expect(boundsForParts(selectedVisibleParts(parts, [], ['bolt-2']))?.size).toEqual([10, 20, 30]);
  });
  it('does not label other visible parts as bounds for an entirely hidden or unloaded selection', () => {
    const parts = [part(), part({ id: 'bolt-2', position: [100, 0, 0] })];
    expect(boundsForParts(selectedVisibleParts(parts, ['bolt-1'], ['bolt-1']))).toBeNull();
    expect(boundsForParts(selectedVisibleParts(parts, ['unloaded-part'], []))).toBeNull();
    expect(boundsForParts(selectedVisibleParts(parts, [], []))?.size).toEqual([110, 20, 30]);
  });
  it('reports a clearly named envelope and handles empty geometry', () => {
    expect(boundsForParts([])).toBeNull();
    expect(boundsForParts([part({ bbox: undefined })])).toBeNull();
    expect(boundsForParts([part()])?.source).toBe('cad-bounds-envelope');
    expect(boundsForParts([part({ bboxSource: 'mesh' })])?.source).toBe('tessellated-bounds');
  });
  it('validates placed envelopes without changing a shared source box', () => {
    const box = new Box3(new Vector3(0, 0, 0), new Vector3(10, 20, 30));
    expect(() => validateScenePlacement(part({ position: [40, 50, 60], rotation: [0.2, 0.3, Math.PI / 2] }), box)).not.toThrow();
    expect(box.min.toArray()).toEqual([0, 0, 0]);
    expect(box.max.toArray()).toEqual([10, 20, 30]);
  });
  it('rejects invalid translations and actual transformed envelopes even with small declared CAD bounds', () => {
    const small = new Box3(new Vector3(0, 0, 0), new Vector3(10, 20, 30));
    expect(() => validateScenePlacement(part({ position: [1e40, 0, 0] }), small)).toThrow('model placement exceeds');
    const large = new Box3(new Vector3(0, 0, 0), new Vector3(8e8, 8e8, 30));
    expect(() => validateScenePlacement(part({ rotation: [0, 0, Math.PI / 4] }), large)).toThrow('transformed model envelope');
  });
  it('rejects an oversized transformed CAD envelope independently from valid display geometry', () => {
    const box = new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
    const placed = part({ position: [1e9 - 5, 0, 0] });
    expect(() => validateScenePlacement(placed, box)).toThrow('transformed CAD envelope');
  });
});

describe('mesh validation', () => {
  const valid = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
  it('accepts finite indexed triangle data', () => expect(() => validateMesh(valid)).not.toThrow());
  it('rejects out-of-range triangle indices', () => expect(() => validateMesh({ ...valid, indices: [0, 1, 99] })).toThrow('triangle'));
  it('rejects nonfinite vertices and malformed normal arrays', () => {
    expect(() => validateMesh({ ...valid, positions: [...valid.positions.slice(0, 8), NaN] })).toThrow('vertex');
    expect(() => validateMesh({ ...valid, normals: [0, 1, 0] })).toThrow('normals');
  });
  it('rejects finite doubles that would overflow the renderer’s Float32 attributes', () => {
    expect(Number.isFinite(1e40)).toBe(true);
    expect(new Float32Array([1e40])[0]).toBe(Infinity);
    expect(() => validateMesh({ ...valid, positions: [...valid.positions.slice(0, 8), 1e40] })).toThrow('vertex');
    expect(() => validateMesh({ ...valid, normals: [0, 0, 1, 0, 0, 1, 0, 0, -1e40] })).toThrow('normals');
  });
});
