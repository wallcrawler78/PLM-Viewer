import type { CadSourceToPart } from '../../cad/step-types';

export type Vec3 = [number, number, number];

export interface ScenePart {
  id: string;
  itemId: string;
  itemNumber: string;
  name: string;
  revision: string;
  /** Raw STEP takes precedence; no remote conversion or derivative is required. */
  stepUrl?: string;
  sourceHash?: string;
  /** Exact child-index path in the hash-bound STEP hierarchy; [] is the root. */
  cadNodePath?: number[];
  /** Explicit rigid source-to-part frame conversion before the occurrence pose. */
  sourceToPart?: CadSourceToPart;
  /** Explicit preconverted display geometry remains supported. */
  meshUrl?: string;
  color: string;
  position: Vec3;
  rotation?: Vec3;
  bbox?: { min: number[]; max: number[] };
  bboxSource?: 'cad' | 'mesh';
}

export interface SceneBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  source: 'cad-bounds-envelope' | 'tessellated-bounds';
  occurrenceIds: string[];
  /** The displayed comparison source used to calculate this envelope. */
  comparisonSource?: 'current' | 'baseline';
}

export interface CameraState { position: Vec3; target: Vec3 }
export interface MeasurementResult {
  distance: number;
  a: Vec3;
  b: Vec3;
  occurrenceA: string;
  occurrenceB: string;
}
export interface ModelAnchor { occurrenceId: string; localPoint: Vec3; worldPoint: Vec3 }
export interface SectionState { enabled: boolean; axis: 'x' | 'y' | 'z'; offset: number }
export interface ViewCommand { type: 'fit' | 'fit-selection' | 'iso' | 'top' | 'front' | 'right'; nonce: number }

export interface ModelViewportProps {
  parts: ScenePart[];
  comparisonParts?: ScenePart[];
  /** Source revision labels; comparison slots are not revision identifiers. */
  currentRevision?: string;
  baselineRevision?: string;
  sourcePresentation?: 'item' | 'local';
  /** Raster resolution only. Geometry, measurements and source fidelity are unchanged. */
  renderQuality?: 'standard' | 'economy';
  mode: 'single' | 'overlay' | 'split';
  selectedIds: string[];
  hiddenIds: string[];
  opacityById: Record<string, number>;
  explode: number;
  section: SectionState;
  measurementMode: boolean;
  anchorMode?: boolean;
  viewCommand?: ViewCommand;
  onSelect: (id: string, additive?: boolean) => void;
  /** Null clears a previous result when endpoints reset or a new pair begins. */
  onMeasure?: (result: MeasurementResult | null) => void;
  onAnchor?: (anchor: ModelAnchor) => void;
  anchors?: { id: string; occurrenceId: string; localPoint: Vec3; label?: string }[];
  onAnchorSelect?: (id: string) => void;
  onError?: (message: string) => void;
  onCameraChange?: (state: CameraState) => void;
  cameraState?: CameraState;
  /** Increment on explicit restore, including a repeat restore of the same saved camera. */
  cameraRestoreKey?: number;
  onBoundsChange?: (bounds: SceneBounds | null) => void;
  onReady?: (bounds: SceneBounds | null) => void;
  showBoundingBox?: boolean;
  overlayOpacity?: { a: number; b: number };
  className?: string;
  /** Changes clear measured endpoints without reloading source geometry. */
  measurementResetKey?: number;
  /** A completed measurement to restore once when this viewport mounts. */
  restoredMeasurement?: MeasurementResult | null;
}

export interface ViewerStatus {
  rendererMode?: 'webgl' | 'software';
  loading: boolean;
  loaded: number;
  total: number;
  error?: string;
  hint?: string;
  sourceKind?: 'step' | 'mesh' | 'mixed';
  importNotice?: string;
  pointCount: number;
  measurement?: number;
}
