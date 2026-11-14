import type { AttachmentReference } from '../domain';
import type { CameraState as ViewerCameraState, Vec3 } from '../components/model/types';
import type { CadSourceToPart } from '../cad/step-types';

export type { Vec3 };
/** Playground view-only markup also binds the projection's aspect ratio. */
export interface CameraState extends ViewerCameraState { aspect?: number }

/** Concept dimensions are millimeters; rotations are right-handed XYZ radians. */
export interface ProposalDimensions {
  width: number;
  depth: number;
  height: number;
  thickness?: number;
  holeDiameter?: number;
  holeX?: number;
  holeY?: number;
}

export interface ProposalNode {
  id: string;
  name: string;
  itemId?: string;
  itemNumber?: string;
  revision?: string;
  sourceHash?: string;
  kind: 'source' | 'box' | 'cylinder' | 'bracket';
  sourceId?: string;
  /** Exact CAD mapping identity, never an authorization or delivery URL. */
  sourceBinding?: { cadNodePath?: number[]; sourceToPart?: CadSourceToPart };
  position: Vec3;
  rotation: Vec3;
  color: string;
  dimensions?: ProposalDimensions;
  removed?: boolean;
  provenance?: { kind: 'manual' | 'ai'; document?: AttachmentReference; assumptions: string[] };
}

export interface ProposalContext {
  workspaceId: string;
  snapshotId: string;
  configurationId?: string;
  rootItemId: string;
  itemNumber: string;
  name: string;
  revision: string;
  sourceMode: 'preview' | 'arena';
}

export type AnnotationTarget =
  | { type: 'view'; camera: CameraState; sceneKey?: string; geometryKey?: string }
  | { type: 'document'; fileId: string; itemId: string; revision: string; edition: string; sourceHash: string; page: number };

export interface PlaygroundAnnotation {
  id: string;
  type: 'arrow' | 'rect' | 'ellipse' | 'pen' | 'note' | 'pin';
  label: string;
  color: string;
  /** Normalized viewport or unrotated page coordinates in [0, 1]. */
  points: [number, number][];
  target: AnnotationTarget;
  /** Optional point-for-point mesh hits, in the component's local frame. */
  anchors?: ({ nodeId: string; localPoint: Vec3 } | null)[];
  createdAt: string;
}

export interface Proposal {
  schemaVersion: 1;
  id: string;
  title: string;
  context: ProposalContext;
  /** Exact serialized source identity. Never use a delivery URL as identity. */
  sourceKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  baseline: ProposalNode[];
  nodes: ProposalNode[];
  annotations: PlaygroundAnnotation[];
}

export type PlaygroundCommand =
  | { type: 'proposal.rename'; title: string }
  | { type: 'transform'; nodeId: string; position?: Vec3; rotation?: Vec3 }
  | { type: 'resize'; nodeId: string; dimensions: ProposalDimensions }
  | { type: 'add'; node: ProposalNode }
  | { type: 'remove' | 'restore'; nodeId: string }
  | { type: 'appearance'; nodeId: string; color: string }
  | { type: 'rename'; nodeId: string; name: string }
  | { type: 'annotation.upsert'; annotation: PlaygroundAnnotation }
  | { type: 'annotation.remove'; id: string };

export interface ProposalHistory {
  past: Proposal[];
  present: Proposal;
  future: Proposal[];
}

export interface ProposalChange {
  nodeId: string;
  name: string;
  itemId?: string;
  itemNumber?: string;
  revision?: string;
  kind: 'added' | 'removed' | 'modified';
  fields: ('position' | 'rotation' | 'dimensions' | 'color' | 'name')[];
  summary: string;
  before?: ProposalNode;
  after?: ProposalNode;
}

export const PLAYGROUND_LIMITS = Object.freeze({
  nodes: 2000,
  commands: 100,
  annotations: 250,
  annotationPoints: 512,
  history: 40,
  coordinate: 1_000_000,
  dimension: 100_000,
  storageBytes: 4 * 1024 * 1024,
  text: 4000,
});
