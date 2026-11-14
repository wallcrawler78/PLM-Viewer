import { Box3, BoxGeometry, BufferGeometry, CylinderGeometry, Euler, ExtrudeGeometry, Matrix4, Path, Shape, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ScenePart } from '../components/model/types';
import type { ProposalNode, Vec3 } from './types';

/** Source delivery is runtime-only. Geometry sharing also respects exact subtree and frame mapping. */
export function playgroundAssetKey(source: ScenePart): string {
  return JSON.stringify([source.stepUrl ? 'step' : 'mesh', source.stepUrl ?? source.meshUrl ?? null,
    source.sourceHash ?? null, source.cadNodePath ?? null, source.sourceToPart ?? null]);
}

export function proposalMatrix(node: Pick<ProposalNode, 'position' | 'rotation'>): Matrix4 {
  const matrix = new Matrix4().makeRotationFromEuler(new Euler(...node.rotation, 'XYZ'));
  return matrix.setPosition(...node.position);
}

/** Display explosion never changes an installed proposal pose. */
export function explodedPosition(position: Vec3, offset: Vec3, amount: number): Vec3 {
  const fraction = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
  return position.map((value, index) => value + offset[index] * fraction) as Vec3;
}

/** Deterministic radial offset, computed from the installed envelope, not a previous exploded frame. */
export function explosionOffset(localBounds: Box3, node: ProposalNode, assemblyBounds: Box3): Vec3 {
  const center = assemblyBounds.getCenter(new Vector3());
  const partCenter = localBounds.getCenter(new Vector3()).applyMatrix4(proposalMatrix(node));
  const direction = partCenter.sub(center);
  if (direction.lengthSq() < 0.0001) direction.set(0, 0, 1);
  const span = Math.max(20, ...assemblyBounds.getSize(new Vector3()).toArray());
  return direction.normalize().multiplyScalar(span * 0.68).toArray() as Vec3;
}

export function conceptGeometryKey(node: ProposalNode): string {
  return JSON.stringify([node.kind, node.dimensions]);
}

/** Bounded, packaged mesh construction. These are visual concept shapes, not editable CAD B-reps. */
export function createConceptGeometry(node: ProposalNode): BufferGeometry {
  const dimensions = node.dimensions;
  if (!['box', 'cylinder', 'bracket'].includes(node.kind) || !dimensions) throw new Error('A supported concept shape requires dimensions.');
  const { width, depth, height } = dimensions;
  if (![width, depth, height].every(value => Number.isFinite(value) && value > 0 && value <= 100_000)) {
    throw new Error('Concept dimensions must be finite, positive millimeters, up to 100,000.');
  }
  let geometry: BufferGeometry;
  if (node.kind === 'box') geometry = new BoxGeometry(width, depth, height);
  else if (node.kind === 'cylinder') {
    // Three cylinders point along Y; our product frame is Z up. Width/depth are the two diameters.
    geometry = new CylinderGeometry(width / 2, width / 2, height, 48, 1, false);
    geometry.rotateX(Math.PI / 2);
    geometry.scale(1, depth / width, 1);
  } else {
    const thickness = dimensions.thickness ?? 3;
    const diameter = dimensions.holeDiameter ?? 0;
    const holeX = dimensions.holeX ?? 0, holeY = dimensions.holeY ?? 0;
    if (!Number.isFinite(thickness) || thickness <= 0 || thickness > Math.min(width, depth, height) / 2
      || !Number.isFinite(diameter) || diameter < 0 || !Number.isFinite(holeX) || !Number.isFinite(holeY)
      || Math.abs(holeX) + diameter / 2 > width / 2 - thickness
      || Math.abs(holeY) + diameter / 2 > depth / 2 - thickness) {
      throw new Error('The bracket thickness or hole falls outside the supported base plate.');
    }
    const plate = new Shape();
    plate.moveTo(-width / 2, -depth / 2); plate.lineTo(width / 2, -depth / 2);
    plate.lineTo(width / 2, depth / 2); plate.lineTo(-width / 2, depth / 2); plate.closePath();
    if (diameter > 0) {
      const hole = new Path();
      hole.absarc(holeX, holeY, diameter / 2, 0, Math.PI * 2, true);
      plate.holes.push(hole);
    }
    const base = new ExtrudeGeometry(plate, { depth: thickness, bevelEnabled: false, curveSegments: 24, steps: 1 });
    base.translate(0, 0, -height / 2);
    const upright = new BoxGeometry(width, thickness, height - thickness).toNonIndexed();
    upright.translate(0, -depth / 2 + thickness / 2, thickness / 2);
    geometry = mergeGeometries([base, upright], false)!;
    base.dispose(); upright.dispose();
    if (!geometry) throw new Error('The visual bracket could not be constructed.');
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
