import type { Attachment, AttachmentReference, Vec3 } from './domain';
import { attachmentIdentityKey, resolveAttachmentReference, validateAttachmentReference } from './domain';
export interface ViewerState {
  revision: 'A' | 'B'; mode: 'single' | 'overlay' | 'split';
  selectedIds: string[]; hiddenIds: string[]; loadedIds: string[];
  opacityById: Record<string, number>; explode: number;
  section: { enabled: boolean; axis: 'x' | 'y' | 'z'; offset: number };
  camera?: { position: Vec3; target: Vec3 };
  documentId: string | null; pinned: boolean; panelOpen: boolean;
  panel?: 'reference' | 'properties' | 'discussion';
  documentWidth?: number;
  overlayOpacity?: { a: number; b: number };
  showBounds?: boolean;
  columns?: string[];
  workspaceView?: 'documents' | 'model' | 'together';
  documentCompare?: boolean;
  navigationOpen?: boolean;
  splitRatio?: number;
  /** Exact identities accompany legacy IDs; never restore a changed edition by ID alone. */
  documentSource?: AttachmentReference | null;
  documentBaselineSource?: AttachmentReference | null;
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length < 10000 && v.every(x => typeof x === 'string');
const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e9);
const scalarEnum = (value: unknown, allowed: readonly string[]): value is string => typeof value === 'string' && allowed.includes(value);
export function parseViewerState(value: unknown): ViewerState {
  if (!isRecord(value) || !scalarEnum(value.revision, ['A', 'B']) || !scalarEnum(value.mode, ['single', 'overlay', 'split']) || !strings(value.selectedIds) || !strings(value.hiddenIds) || !strings(value.loadedIds)) throw new Error('This saved view has an unsupported layout or source revision.');
  if (value.mode !== 'single' && value.revision !== 'B') throw new Error('A comparison view must use proposed revision B so the two views show different source revisions.');
  if (!isRecord(value.opacityById) || Object.values(value.opacityById).some(x => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1)) throw new Error('This saved view has invalid transparency.');
  if (typeof value.explode !== 'number' || !Number.isFinite(value.explode) || value.explode < 0 || value.explode > 1) throw new Error('This saved view has an invalid explosion setting.');
  if (!isRecord(value.section) || typeof value.section.enabled !== 'boolean' || !scalarEnum(value.section.axis, ['x', 'y', 'z']) || typeof value.section.offset !== 'number' || !Number.isFinite(value.section.offset)) throw new Error('This saved view has an invalid section plane.');
  if (value.camera !== undefined && (!isRecord(value.camera) || !vector(value.camera.position) || !vector(value.camera.target))) throw new Error('This saved view has an invalid camera.');
  if ((value.documentId !== null && typeof value.documentId !== 'string') || typeof value.pinned !== 'boolean' || typeof value.panelOpen !== 'boolean') throw new Error('This saved view has invalid document settings.');
  if (value.panel !== undefined && !scalarEnum(value.panel, ['reference','properties','discussion'])) throw new Error('This saved view has an invalid side panel.');
  if (value.documentWidth !== undefined && (typeof value.documentWidth !== 'number' || !Number.isFinite(value.documentWidth) || value.documentWidth < 310 || value.documentWidth > 620)) throw new Error('This saved view has an invalid document width.');
  if (value.overlayOpacity !== undefined && (!isRecord(value.overlayOpacity) || ![value.overlayOpacity.a,value.overlayOpacity.b].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1))) throw new Error('This saved view has invalid overlay opacity.');
  if (value.showBounds !== undefined && typeof value.showBounds !== 'boolean' || value.columns !== undefined && !strings(value.columns)) throw new Error('This saved view has invalid display settings.');
  if (value.workspaceView !== undefined && !scalarEnum(value.workspaceView, ['documents','model','together'])) throw new Error('This saved view has an unsupported workspace view.');
  if (value.documentCompare !== undefined && typeof value.documentCompare !== 'boolean' || value.navigationOpen !== undefined && typeof value.navigationOpen !== 'boolean') throw new Error('This saved view has invalid document review settings.');
  if (value.splitRatio !== undefined && (typeof value.splitRatio !== 'number' || !Number.isFinite(value.splitRatio) || value.splitRatio < 30 || value.splitRatio > 70)) throw new Error('This saved view has an invalid document split.');
  if (value.documentSource !== undefined && value.documentSource !== null) {
    const source = validateAttachmentReference(value.documentSource);
    if (value.documentId !== source.fileId) throw new Error('The saved document ID does not match its exact source reference.');
  }
  if (value.documentSource === null && value.documentId !== null) throw new Error('The saved view declares no document but still contains a document ID.');
  if (value.documentBaselineSource !== undefined && value.documentBaselineSource !== null) validateAttachmentReference(value.documentBaselineSource);
  return value as unknown as ViewerState;
}

/** Resolve every document before changing the visible saved-view state. */
export function resolveViewDocuments(value: ViewerState, files: readonly Attachment[]): { document: Attachment | null; baseline: Attachment | null; legacy: boolean } {
  const state = parseViewerState(value);
  // An unchanged source can be listed in several frozen configurations or under
  // refreshed delivery URLs. Neither creates a new source edition.
  const unique = Array.from(new Map(files.map(file => [attachmentIdentityKey(file), file])).values());
  let document: Attachment | null = null;
  const legacy = state.documentSource === undefined && state.documentId !== null;
  if (state.documentSource) document = resolveAttachmentReference(state.documentSource, unique);
  else if (legacy) {
    const matches = unique.filter(file => file.id === state.documentId);
    if (!matches.length) throw new Error('The document in this older saved view is unavailable. No other file has been substituted.');
    if (matches.length !== 1) throw new Error('This older saved view does not identify a unique document edition. Open the intended source and save the view again.');
    document = matches[0];
  }
  const baseline = state.documentBaselineSource ? resolveAttachmentReference(state.documentBaselineSource, unique) : null;
  if (baseline && (!document || baseline.itemId !== document.itemId || baseline.kind !== document.kind || attachmentIdentityKey(baseline) === attachmentIdentityKey(document))) throw new Error('The saved baseline must be a different source of the same item and document format.');
  return { document, baseline, legacy };
}
