import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { markupGeometryKey, markupPresentationKey, markupSceneKey, markupSvg, moveMarkupPoints, sameCamera, visibleMarkupPoints } from '../src/playground/markup';
import type { Point2 } from '../src/playground/markup';
import type { CameraState, PlaygroundAnnotation, ProposalNode, Vec3 } from '../src/playground/types';

const camera: CameraState = { position: [0, -100, 0], target: [0, 0, 0], aspect: 2 };
const presentation = { view: 'proposed', explode: 0, hiddenIds: [] as string[] };
const source = (values: Partial<ProposalNode> = {}): ProposalNode => ({ id: 'source-1', sourceId: 'source-1', itemId: 'item-1', itemNumber: 'PN-1',
  revision: 'A', name: 'Source bracket', kind: 'source', sourceHash: 'a'.repeat(64), position: [0, 0, 0], rotation: [0, 0, 0], color: '#8899aa', ...values });
const concept = (values: Partial<ProposalNode> = {}): ProposalNode => ({ id: 'concept-1', name: 'Concept bracket', kind: 'bracket',
  position: [40, 0, 0], rotation: [0, 0, 0], color: '#75b8b0', dimensions: { width: 40, depth: 30, height: 25, thickness: 3, holeDiameter: 6, holeX: 0, holeY: 0 }, ...values });
function arrow(nodes: ProposalNode[] = [source()], values: Partial<PlaygroundAnnotation> = {}): PlaygroundAnnotation {
  return { id: 'mark-1', type: 'arrow', label: 'Move hole here', color: '#71e4b6', points: [[0.4, 0.5], [0.6, 0.5]],
    target: { type: 'view', camera, sceneKey: markupSceneKey(nodes, presentation), geometryKey: markupGeometryKey(nodes) }, createdAt: '2026-11-14T00:00:00.000Z', ...values };
}
afterEach(() => vi.restoreAllMocks());

describe('Markup source, geometry and presentation binding', () => {
  it('distinguishes pose/display changes from geometry changes while ignoring visual color and names', () => {
    const nodes = [source(), concept()]; const geometry = markupGeometryKey(nodes), scene = markupSceneKey(nodes, presentation);
    const moved = [{ ...nodes[0], position: [12, 0, 0] as Vec3 }, nodes[1]];
    expect(markupGeometryKey(moved)).toBe(geometry); expect(markupSceneKey(moved, presentation)).not.toBe(scene);
    const recolored = nodes.map(node => ({ ...node, color: '#aabbcc', name: 'Renamed label' }));
    expect(markupGeometryKey(recolored)).toBe(geometry); expect(markupSceneKey(recolored, presentation)).toBe(scene);
    for (const changed of [{ ...presentation, view: 'original' }, { ...presentation, explode: 0.6 }, { ...presentation, hiddenIds: ['source-1'] }]) {
      expect(markupSceneKey(nodes, changed)).not.toBe(scene);
    }
    expect(markupGeometryKey([{ ...nodes[0], sourceHash: 'b'.repeat(64) }, nodes[1]])).not.toBe(geometry);
    expect(markupGeometryKey([nodes[0], { ...nodes[1], dimensions: { ...nodes[1].dimensions!, holeX: 8 } }])).not.toBe(geometry);
    expect(markupGeometryKey([{ ...nodes[0], sourceBinding: { cadNodePath: [1], sourceToPart: { position: [10, 0, 0], rotation: [0, 0, 0] } } }, nodes[1]])).not.toBe(geometry);
    expect(markupSceneKey([{ ...nodes[0], removed: true }, nodes[1]], presentation)).not.toBe(scene);
  });
  it('produces portable keys independent of input order or locale collation', () => {
    const nodes = [source({ id: 'ä-occurrence' }), source({ id: 'z-occurrence' }), concept({ id: 'A-concept' })];
    const p = { ...presentation, hiddenIds: ['ä-occurrence', 'z-occurrence'] };
    const geometry = markupGeometryKey(nodes), scene = markupSceneKey(nodes, p);
    vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('Locale collation must not choose persisted identity order.'); });
    expect(markupGeometryKey([...nodes].reverse())).toBe(geometry);
    expect(markupSceneKey([...nodes].reverse(), { ...p, hiddenIds: [...p.hiddenIds].reverse() })).toBe(scene);
  });
  it('keeps surface-anchored and view-bound marks when the proposal is edited after they were drawn', () => {
    const nodes = [source()], edited = [source({ position: [20, 0, 0] }), concept()];
    const anchored = arrow(nodes, { anchors: [{ nodeId: 'source-1', localPoint: [1, 2, 3] }, { nodeId: 'source-1', localPoint: [4, 5, 6] }] });
    const project = vi.fn((_id: string, point: Vec3): Point2 => [point[0] / 10, point[1] / 10]);
    // Adding a concept bracket and moving a part changes both recorded keys; the mark must stay.
    expect(visibleMarkupPoints(anchored, camera, project, markupSceneKey(edited, presentation), markupGeometryKey(edited), markupPresentationKey(presentation))).toEqual([[0.1, 0.2], [0.4, 0.5]]);
    const viewBound = arrow(nodes, { target: { type: 'view', camera, sceneKey: markupSceneKey(nodes, presentation), geometryKey: markupGeometryKey(nodes), presentationKey: markupPresentationKey(presentation) } });
    expect(visibleMarkupPoints(viewBound, camera, undefined, markupSceneKey(edited, presentation), markupGeometryKey(edited), markupPresentationKey(presentation))).toEqual(viewBound.points);
    // A different display state or camera is a different picture: the view-bound mark does not follow.
    for (const changed of [{ ...presentation, view: 'original' }, { ...presentation, explode: 0.5 }, { ...presentation, hiddenIds: ['source-1'] }]) {
      expect(visibleMarkupPoints(viewBound, camera, undefined, markupSceneKey(nodes, changed), markupGeometryKey(nodes), markupPresentationKey(changed)), JSON.stringify(changed)).toBeNull();
    }
    expect(visibleMarkupPoints(viewBound, { ...camera, position: [50, -100, 0] }, undefined, markupSceneKey(nodes, presentation), markupGeometryKey(nodes), markupPresentationKey(presentation))).toBeNull();
    expect(markupPresentationKey({ ...presentation, hiddenIds: ['b', 'a'] })).toBe(markupPresentationKey({ ...presentation, hiddenIds: ['a', 'b'] }));
  });
  it('numbers every markup in an image with the number it has in the proposal list', () => {
    const svg = markupSvg([{ mark: arrow(), points: [[0.4, 0.5], [0.6, 0.5]], number: 7 }, { mark: arrow([source()], { id: 'pin', type: 'pin', points: [[0.2, 0.2]] }), points: [[0.2, 0.2]], number: 3 }], 800, 600);
    expect(svg).toMatch(/>7<\/text>/); expect(svg).toMatch(/>3<\/text>/); expect(svg).not.toMatch(/>1<\/text>/);
  });
  it('follows complete mesh anchors through a rigid move and camera change', () => {
    const nodes = [source()], mark = arrow(nodes, { anchors: [{ nodeId: 'source-1', localPoint: [1, 2, 3] }, { nodeId: 'source-1', localPoint: [4, 5, 6] }] });
    const moved = [source({ position: [20, 0, 0] })], project = vi.fn((_id: string, point: Vec3): Point2 => [point[0] / 10, point[1] / 10]);
    expect(visibleMarkupPoints(mark, { ...camera, position: [50, -100, 0] }, project, markupSceneKey(moved, presentation), markupGeometryKey(moved)))
      .toEqual([[0.1, 0.2], [0.4, 0.5]]);
    expect(project).toHaveBeenCalledWith('source-1', [1, 2, 3]); expect(project).toHaveBeenCalledWith('source-1', [4, 5, 6]);
  });
  it('hides anchored marks when their component is hidden or absent rather than inventing a projection', () => {
    const nodes = [source()], mark = arrow(nodes, { anchors: [{ nodeId: 'source-1', localPoint: [0, 0, 0] }, { nodeId: 'source-1', localPoint: [1, 0, 0] }] });
    expect(visibleMarkupPoints(mark, camera, () => null, markupSceneKey(nodes, presentation), markupGeometryKey(nodes))).toBeNull();
  });
  it('does not infer the depth of a whole arrow from one anchored endpoint', () => {
    const nodes = [source()], mark = arrow(nodes, { anchors: [{ nodeId: 'source-1', localPoint: [0, 0, 0] }, null] }), project = vi.fn((): Point2 => [0.1, 0.2]);
    expect(visibleMarkupPoints(mark, camera, project, markupSceneKey(nodes, presentation), markupGeometryKey(nodes))).toEqual(mark.points);
    expect(project).not.toHaveBeenCalled();
    expect(visibleMarkupPoints(mark, camera, project, markupSceneKey([source({ position: [10, 0, 0] })], presentation), markupGeometryKey(nodes))).toBeNull();
  });
  it('hides a view-specific mark when its scene or camera changes and preserves page-based marks', () => {
    const nodes = [source()], mark = arrow(nodes), scene = markupSceneKey(nodes, presentation), geometry = markupGeometryKey(nodes);
    expect(visibleMarkupPoints(mark, camera, undefined, scene, geometry)).toEqual(mark.points);
    expect(visibleMarkupPoints(mark, undefined, undefined, scene, geometry)).toBeNull();
    expect(visibleMarkupPoints(mark, { ...camera, position: [1, -100, 0] }, undefined, scene, geometry)).toBeNull();
    expect(visibleMarkupPoints(mark, camera, undefined, 'changed-scene', geometry)).toBeNull();
    const page = arrow(nodes, { target: { type: 'document', fileId: 'file-1', itemId: 'item-1', revision: 'A', edition: '1', sourceHash: 'a'.repeat(64), page: 2 } });
    expect(visibleMarkupPoints(page, undefined)).toEqual(page.points);
  });
});

describe('View projection and bounded markup editing', () => {
  it('reprojects a fixed-view arrow through aspect changes onto the same perspective rays', () => {
    function project(point: Vec3, aspect: number): Point2 {
      const lens = new PerspectiveCamera(36, aspect, 0.1, 1000); lens.up.set(0, 0, 1); lens.position.set(...camera.position);
      lens.lookAt(new Vector3(...camera.target)); lens.updateMatrixWorld(true);
      const p = new Vector3(...point).project(lens); return [(p.x + 1) / 2, (1 - p.y) / 2];
    }
    const points: Vec3[] = [[10, 0, 0], [20, 0, 10]], nodes = [source()];
    const mark = arrow(nodes, { points: points.map(point => project(point, 2)) });
    const reprojected = visibleMarkupPoints(mark, { ...camera, aspect: 1 }, undefined, markupSceneKey(nodes, presentation), markupGeometryKey(nodes))!;
    points.forEach((point, index) => { const expected = project(point, 1); expect(reprojected[index][0]).toBeCloseTo(expected[0], 12); expect(reprojected[index][1]).toBeCloseTo(expected[1], 12); });
    expect(reprojected[0][0]).not.toBe(mark.points[0][0]);
    expect(mark.points).toEqual(points.map(point => project(point, 2)));
  });
  it('hides arrows outside the resized viewport rather than clamping them to unrelated geometry', () => {
    const nodes = [source()], mark = arrow(nodes, { points: [[0.1, 0.5], [0.9, 0.5]] });
    expect(visibleMarkupPoints(mark, { ...camera, aspect: 0.5 }, undefined, markupSceneKey(nodes, presentation), markupGeometryKey(nodes))).toBeNull();
  });
  it('uses camera-to-target distance for tolerance even when the assembly has a large world origin', () => {
    const far: CameraState = { position: [900000, 800000, 700100], target: [900000, 800000, 700000], aspect: 2 };
    expect(sameCamera(far, { ...far, position: [900000.0002, 800000, 700100] })).toBe(true);
    expect(sameCamera(far, { ...far, position: [900010, 800000, 700100] })).toBe(false);
    expect(sameCamera(far, { ...far, target: [900000, 800010, 700000] })).toBe(false);
  });
  it('moves an entire stroke within bounds without reshaping it or mutating the original', () => {
    const original: Point2[] = [[0.2, 0.3], [0.5, 0.6], [0.7, 0.8]], snapshot = structuredClone(original);
    const moved = moveMarkupPoints(original, [0.8, -0.8]);
    expect(moved[0][0]).toBeCloseTo(0.5); expect(moved[0][1]).toBeCloseTo(0);
    expect(moved[2][0]).toBeCloseTo(1); expect(moved[2][1]).toBeCloseTo(0.5);
    expect(moved[1][0] - moved[0][0]).toBeCloseTo(original[1][0] - original[0][0]);
    expect(moved[2][1] - moved[0][1]).toBeCloseTo(original[2][1] - original[0][1]);
    expect(original).toEqual(snapshot); expect(moveMarkupPoints([], [1, 1])).toEqual([]);
  });
  it('escapes labels and rejects injected colors in the shared SVG overlay', () => {
    const label = '<img onerror="x"> & \'quoted\'';
    const mark = arrow([source()], { label, color: '#ffffff" onload="evil()' });
    const svg = markupSvg([{ mark, points: mark.points }], 800, 600);
    expect(svg).toContain('&lt;img onerror=&quot;x&quot;&gt; &amp; &apos;quoted&apos;');
    expect(svg).not.toContain('<img'); expect(svg).not.toContain('onload='); expect(svg).not.toContain('evil()');
    expect(svg).toContain('stroke="#76e2bb"'); expect(svg).toContain('<path');
  });
});
