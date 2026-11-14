import { describe, expect, it } from 'vitest';
import { Box3, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import type { ProposalNode } from '../src/playground/types';
import type { ScenePart } from '../src/components/model/types';
import { createConceptGeometry, explodedPosition, explosionOffset, playgroundAssetKey, proposalMatrix } from '../src/playground/geometry';

const node = (overrides: Partial<ProposalNode> = {}): ProposalNode => ({
  id: 'proposal-bracket', name: 'Bracket concept', kind: 'bracket', position: [0, 0, 0], rotation: [0, 0, 0], color: '#75b8b0',
  dimensions: { width: 40, depth: 30, height: 25, thickness: 3, holeDiameter: 6, holeX: 0, holeY: 0 }, ...overrides,
});
const source = (overrides: Partial<ScenePart> = {}): ScenePart => ({ id: 'source-1', itemId: 'bracket', itemNumber: 'BR-1',
  name: 'Bracket', revision: 'B', position: [0, 0, 0], color: '#aaaaaa', sourceHash: 'a'.repeat(64), stepUrl: '/bracket.step', ...overrides });

describe('Playground visual concept geometry', () => {
  it('constructs an actual open bracket hole and moves that hole without changing the source node', () => {
    const original = node(); const geometry = createConceptGeometry(original);
    const material = new MeshBasicMaterial({ side: DoubleSide });
    const mesh = new Mesh(geometry, material); mesh.updateMatrixWorld(true);
    const hits = (x: number) => new Raycaster(new Vector3(x, 0, 100), new Vector3(0, 0, -1)).intersectObject(mesh).length;
    expect(hits(0)).toBe(0); expect(hits(8)).toBeGreaterThan(0);
    const moved = createConceptGeometry(node({ dimensions: { ...original.dimensions!, holeX: 8 } }));
    mesh.geometry = moved;
    expect(hits(8)).toBe(0); expect(hits(0)).toBeGreaterThan(0);
    expect(original.dimensions!.holeX).toBe(0);
    expect(geometry.boundingBox!.min.toArray()).toEqual([-20, -15, -12.5]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([20, 15, 12.5]);
    geometry.dispose(); moved.dispose(); material.dispose();
  });
  it('keeps cylinder height on Z and width/depth as its two diameters', () => {
    const geometry = createConceptGeometry(node({ kind: 'cylinder', dimensions: { width: 20, depth: 30, height: 40 } }));
    const size = geometry.boundingBox!.getSize(new Vector3());
    expect(size.x).toBeCloseTo(20); expect(size.y).toBeCloseTo(30); expect(size.z).toBeCloseTo(40);
    geometry.dispose();
  });
  it('rejects invalid shapes and holes intersecting the upright or perimeter', () => {
    expect(() => createConceptGeometry(node({ kind: 'source' }))).toThrow('supported concept');
    expect(() => createConceptGeometry(node({ dimensions: { width: Infinity, depth: 20, height: 30 } }))).toThrow('finite');
    expect(() => createConceptGeometry(node({ dimensions: { width: 40, depth: 30, height: 25, thickness: 3, holeDiameter: 12, holeY: -10 } }))).toThrow('outside');
    expect(() => createConceptGeometry(node({ dimensions: { width: 40, depth: 30, height: 25, thickness: 25 } }))).toThrow('thickness');
  });
});

describe('Playground placement and source separation', () => {
  it('applies XYZ rotation then the installed world pose without independently centering', () => {
    const placed = node({ position: [100, 200, 300], rotation: [0, 0, Math.PI / 2] });
    const point = new Vector3(10, 0, 0).applyMatrix4(proposalMatrix(placed));
    expect(point.x).toBeCloseTo(100); expect(point.y).toBeCloseTo(210); expect(point.z).toBeCloseTo(300);
  });
  it('reassembles to the proposed installed pose, preserving the immutable baseline', () => {
    const baseline = node({ position: [40, 50, 60] }); const proposal = node({ position: [70, 50, 60] });
    const box = new Box3(new Vector3(-20, -15, -12.5), new Vector3(20, 15, 12.5));
    const bounds = new Box3(new Vector3(-50, -50, -10), new Vector3(120, 100, 100));
    const offset = explosionOffset(box, proposal, bounds);
    const displayed = explodedPosition(proposal.position, offset, 0.8);
    expect(displayed).not.toEqual(proposal.position);
    expect(explodedPosition(proposal.position, offset, 0)).toEqual([70, 50, 60]);
    expect(proposal.position).toEqual([70, 50, 60]); expect(baseline.position).toEqual([40, 50, 60]);
    expect(explosionOffset(box, proposal, bounds)).toEqual(offset);
  });
  it('shares one source asset across occurrences but separates exact subtrees and frames', () => {
    expect(playgroundAssetKey(source())).toBe(playgroundAssetKey(source({ id: 'source-2', position: [40, 50, 60] })));
    expect(playgroundAssetKey(source())).not.toBe(playgroundAssetKey(source({ sourceHash: 'b'.repeat(64) })));
    expect(playgroundAssetKey(source({ cadNodePath: [0] }))).not.toBe(playgroundAssetKey(source({ cadNodePath: [1] })));
    expect(playgroundAssetKey(source({ sourceToPart: { position: [0, 0, 0], rotation: [0, 0, 0] } })))
      .not.toBe(playgroundAssetKey(source({ sourceToPart: { position: [10, 0, 0], rotation: [0, 0, 0] } })));
  });
  it('bounds presentation inputs and uses a finite offset for a centered component', () => {
    const box = new Box3(new Vector3(-20, -15, -12.5), new Vector3(20, 15, 12.5));
    const offset = explosionOffset(box, node(), box);
    expect(offset.every(Number.isFinite)).toBe(true);
    expect(explodedPosition([1, 2, 3], offset, NaN)).toEqual([1, 2, 3]);
    expect(explodedPosition([1, 2, 3], offset, -1)).toEqual([1, 2, 3]);
    expect(explodedPosition([1, 2, 3], offset, 2)).toEqual(explodedPosition([1, 2, 3], offset, 1));
  });
});
