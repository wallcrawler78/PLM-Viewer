import { validateSourceToPart } from './cad/step-mapping';
import { STEP_LIMITS } from './cad/step-types';
import type { CadSourceToPart } from './cad/step-types';
import { normalizeBomPlacements, sameBomOrientation } from '../shared/bom-placements.mjs';

/** Neutral viewer contract. Arena GUIDs are opaque; labels are schema data. */
export type Vec3 = [number, number, number];
export type WorkspacePreset = 'precision' | 'medical';
export type Revision = 'A' | 'B';
export type AttributeValue = string | number | boolean | null;
export type AttributeValues = Record<string, AttributeValue>;
export interface AttributeDefinition {
  id: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'enum';
  scope: 'item' | 'bom';
  unit?: string;
  options?: string[];
  defaultVisible?: boolean;
}
export interface WorkspaceSchema {
  workspaceId: string;
  name: string;
  preset?: WorkspacePreset;
  version: string;
  attributes: AttributeDefinition[];
}
export interface PartDefinition {
  id: string;
  itemNumber: string;
  name: string;
  revision: string;
  stepUrl: string;
  /** Optional explicit derivative. Raw STEP is the default display source. */
  meshUrl?: string;
  displaySource?: 'step' | 'mesh';
  /** Child-index path from the exact STEP import hierarchy root. Never inferred from names. */
  cadNodePath?: number[];
  /** pPart = RXYZ(rotation) * pSource + position, mm/radians, right-handed.
   * Required for every explicit STEP subtree (including [] and identity).
   * Occurrence poses and anchors continue to use the resulting part-local frame.
   */
  sourceToPart?: CadSourceToPart;
  sourceHash: string;
  color: string;
  material: string;
  /** Source-supplied CAD properties in the mapped part-local frame; may be absent. */
  bbox?: { min: Vec3; max: Vec3 };
  volumeMm3?: number;
  attributes: AttributeValues;
}
export type ModelState = 'loaded' | 'not-loaded' | 'no-model' | 'unavailable' | 'placement-needed';
export interface BomOccurrence {
  id: string;
  parentId?: string;
  partId: string;
  partRevision: string;
  itemNumber: string;
  name: string;
  position: Vec3;
  rotation: Vec3;
  quantity: number;
  attributes: AttributeValues;
  modelState: ModelState;
}
export interface Attachment {
  id: string;
  /** Provider-supplied document family identity; never inferred from its filename. */
  seriesId?: string;
  itemId: string;
  revision: string;
  kind: 'pdf' | 'docx' | 'doc';
  name: string;
  url: string;
  edition: string;
  sourceHash: string;
  text?: string;
}
/** Exact original CAD attachment and the occurrences represented by it. */
export interface ModelSource {
  id: string;
  itemId: string;
  revision: string;
  edition: string;
  sourceHash: string;
  occurrenceIds: string[];
}
/** Sourcing data is optional and retains provider-defined attribute identifiers. */
export interface SupplierItem {
  id: string;
  itemId: string;
  supplierId: string;
  supplierName: string;
  partNumber: string;
  name: string;
  attributes: AttributeValues;
  attachments?: Attachment[];
}
/** A file GUID can have several editions. URLs are delivery locations, not source identity. */
export type AttachmentIdentity = Pick<Attachment, 'id' | 'itemId' | 'revision' | 'edition'> & { sourceHash?: string; kind: string };
export interface AttachmentReference {
  fileId: string;
  itemId: string;
  revision: string;
  edition: string;
  sourceHash: string;
  kind: Attachment['kind'];
}
export function attachmentIdentityKey(file: AttachmentIdentity): string {
  return JSON.stringify([file.id, file.itemId, file.revision, file.edition, file.sourceHash ?? null, file.kind]);
}
export function toAttachmentReference(file: AttachmentIdentity): AttachmentReference {
  return validateAttachmentReference({ fileId: file.id, itemId: file.itemId, revision: file.revision, edition: file.edition, sourceHash: file.sourceHash, kind: file.kind });
}
export function validateAttachmentReference(value: unknown): AttachmentReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('This document source reference is incomplete.');
  const source = value as Record<string, unknown>;
  if (!['fileId', 'itemId', 'revision', 'edition', 'sourceHash'].every(key => validIdentityText(source[key])) || typeof source.kind !== 'string' || !['pdf', 'docx', 'doc'].includes(source.kind)) throw new Error('This document source reference needs an exact file, item revision, edition, hash, and format.');
  return value as AttachmentReference;
}
export function resolveAttachmentReference<T extends AttachmentIdentity>(reference: AttachmentReference, files: readonly T[]): T {
  const source = validateAttachmentReference(reference);
  const key = attachmentIdentityKey({ id: source.fileId, ...source });
  const matches = files.filter(file => attachmentIdentityKey(file) === key);
  if (!matches.length) throw new Error('The original document edition is unavailable or has changed. No other edition has been substituted.');
  if (matches.length > 1) throw new Error('The original document source is ambiguous. Resolve its exact attachment before restoring this view.');
  return matches[0];
}
export interface BomSnapshot {
  id: string;
  workspaceId: string;
  rootItemId: string;
  rootItemNumber: string;
  title: string;
  revision: string;
  configurationId: string;
  units: 'mm';
  upAxis: 'Z';
  /** Omitted means world poses. Explicit parent poses are composed at validation. */
  placementSpace?: 'world' | 'parent';
  capturedAt: string;
  parts: PartDefinition[];
  occurrences: BomOccurrence[];
  documents: Attachment[];
  attributes: AttributeValues;
  assemblyStepUrl?: string;
  modelSources?: ModelSource[];
}
export interface RevisionDescriptor { id: string; label: string; lifecycle: string; }
export interface PlmAdapter {
  readonly mode: 'preview' | 'arena';
  loadSchema(signal?: AbortSignal): Promise<WorkspaceSchema>;
  loadBom(revision: string, signal?: AbortSignal): Promise<BomSnapshot>;
  listRevisions(signal?: AbortSignal): Promise<RevisionDescriptor[]>;
  listAttachments(itemId: string, revision: string, signal?: AbortSignal): Promise<Attachment[]>;
}
export interface BomChange {
  id: string;
  occurrenceId: string;
  itemNumber: string;
  name: string;
  kind: 'added' | 'removed' | 'revised' | 'moved' | 'attributes' | 'quantity';
  summary: string;
  before?: BomOccurrence;
  after?: BomOccurrence;
}
export interface SourceReference {
  workspaceId: string;
  snapshotId: string;
  itemId: string;
  revision: string;
  fileId?: string;
  edition?: string;
  sourceHash?: string;
}
export type ReviewAnchor =
  | { kind: 'model'; occurrenceId: string; localPoint?: Vec3; units: 'mm' }
  | { kind: 'document'; documentId: string; page?: number; quote?: string; rectangle?: [number, number, number, number] }
  | { kind: 'general' };
export interface ReviewComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  status: 'open' | 'resolved';
  source: SourceReference;
  anchor: ReviewAnchor;
  replies: { id: string; body: string; author: string; createdAt: string }[];
}
export interface SavedReviewView {
  id: string;
  name: string;
  createdAt: string;
  source: SourceReference;
  /** Camera, layout, doc edition, visibility, etc. are owned by the viewer, not PLM. */
  state: Record<string, unknown>;
}
export interface ReviewDocument {
  formatVersion: 1;
  workspaceId: string;
  revision: number;
  updatedAt: string;
  comments: ReviewComment[];
  views: SavedReviewView[];
}

export function resolvePart(snapshot: BomSnapshot, occurrence: BomOccurrence): PartDefinition | undefined {
  return snapshot.parts.find(part => part.id === occurrence.partId && part.revision === occurrence.partRevision);
}

/** Per-snapshot lookup for bulk work. IDs/revisions remain separate opaque keys;
 * callers own its lifetime, so it cannot cache a previous user's source data. */
export function createPartLookup(parts: readonly PartDefinition[]) {
  const index = new Map<string, Map<string, PartDefinition>>();
  for (const part of parts) {
    let revisions = index.get(part.id);
    if (!revisions) { revisions = new Map(); index.set(part.id, revisions); }
    // Preserve resolvePart's first-match behavior; validation rejects duplicates.
    if (!revisions.has(part.revision)) revisions.set(part.revision, part);
  }
  return (occurrence: Pick<BomOccurrence, 'partId' | 'partRevision'>): PartDefinition | undefined => index.get(occurrence.partId)?.get(occurrence.partRevision);
}

const attributeNumberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

export function formatAttributeValue(value: AttributeValue | undefined, definition?: AttributeDefinition): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return `${attributeNumberFormat.format(value)}${definition?.unit ? ` ${definition.unit}` : ''}`;
  return String(value);
}

function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a as object).sort(), bk = Object.keys(b as object).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && equalValues((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Compares resolved configuration facts. Viewer visibility/loading never constitutes a BOM change. */
export function compareSnapshots(before: BomSnapshot, after: BomSnapshot): BomChange[] {
  if (before.workspaceId !== after.workspaceId || before.rootItemId !== after.rootItemId) throw new Error('Compare revisions of the same item in the same workspace.');
  before = normalizeBomPlacements(before);
  after = normalizeBomPlacements(after);
  const previous = new Map(before.occurrences.map(o => [o.id, o]));
  const current = new Map(after.occurrences.map(o => [o.id, o]));
  const previousPart = createPartLookup(before.parts), currentPart = createPartLookup(after.parts);
  const changes: BomChange[] = [];
  function add(kind: BomChange['kind'], old: BomOccurrence | undefined, next: BomOccurrence | undefined, summary: string) {
    const row = next ?? old!;
    changes.push({ id: `${row.id}:${kind}`, occurrenceId: row.id, itemNumber: row.itemNumber, name: row.name, kind, summary, before: old, after: next });
  }
  for (const old of before.occurrences) {
    if (!current.has(old.id)) add('removed', old, undefined, 'Occurrence removed from proposed BOM');
  }
  for (const next of after.occurrences) {
    const old = previous.get(next.id);
    if (!old) { add('added', undefined, next, 'New occurrence in proposed BOM'); continue; }
    const oldPart = previousPart(old), nextPart = currentPart(next);
    if (old.partId !== next.partId || old.partRevision !== next.partRevision) add('revised', old, next, old.partId === next.partId ? `Part revision ${old.partRevision} → ${next.partRevision}` : `Replaced ${old.itemNumber} with ${next.itemNumber}`);
    else if (oldPart?.sourceHash && nextPart?.sourceHash && oldPart.sourceHash !== nextPart.sourceHash) add('revised', old, next, 'Source file changed within the same item revision');
    const moved = old.position.some((x, i) => Math.abs(x - next.position[i]) > 1e-6) || !sameBomOrientation(old.rotation, next.rotation) || old.parentId !== next.parentId;
    if (moved) {
      const delta = Math.hypot(...next.position.map((x, i) => x - old.position[i]));
      add('moved', old, next, delta > 1e-6 ? `Placement changed · ${delta.toFixed(1)} mm translation` : 'Orientation or parent changed');
    }
    if (old.quantity !== next.quantity) add('quantity', old, next, `Quantity ${old.quantity} → ${next.quantity}`);
    if (!equalValues(old.attributes, next.attributes) || !equalValues(oldPart?.attributes, nextPart?.attributes)) add('attributes', old, next, 'Item or BOM attributes changed');
  }
  return changes;
}

export function assertSafeAssetUrl(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('Invalid attachment URL.');
  const url = new URL(value, 'https://viewer.invalid');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Attachment URL must use HTTP(S) without credentials.');
}

export function assertDocumentSeriesId(value: unknown): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error('Invalid document series identifier.');
}

function validIdentityText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Validate untrusted adapter metadata before a reader or source-details panel uses it. */
export function validateAttachment(value: unknown): Attachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid document attachment metadata.');
  const file = value as Record<string, unknown>;
  validateAttachmentReference({ fileId: file.id, itemId: file.itemId, revision: file.revision, edition: file.edition, sourceHash: file.sourceHash, kind: file.kind });
  if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 2048 || /[\u0000-\u001f\u007f]/.test(file.name)) throw new Error('The document attachment needs a valid display name.');
  assertSafeAssetUrl(file.url);
  assertDocumentSeriesId(file.seriesId);
  if (file.text !== undefined && typeof file.text !== 'string') throw new Error('Invalid extracted document text.');
  return value as Attachment;
}

export function validateSupplierItem(value: unknown): SupplierItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid supplier item metadata.');
  const row = value as Record<string, unknown>;
  if (!['id', 'itemId', 'supplierId', 'supplierName', 'partNumber', 'name'].every(key => validIdentityText(row[key]))) throw new Error('Supplier items need exact item and supplier identifiers and display names.');
  if (!row.attributes || typeof row.attributes !== 'object' || Array.isArray(row.attributes) || Object.values(row.attributes).some(attribute => attribute !== null && !['string', 'number', 'boolean'].includes(typeof attribute) || typeof attribute === 'number' && !Number.isFinite(attribute))) throw new Error('Invalid supplier item attributes.');
  if (row.attachments !== undefined) {
    if (!Array.isArray(row.attachments)) throw new Error('Invalid supplier item attachments.');
    row.attachments.forEach(validateAttachment);
    if (new Set(row.attachments.map(attachmentIdentityKey)).size !== row.attachments.length) throw new Error('Duplicate supplier attachment identities.');
  }
  return value as SupplierItem;
}

export function validateSnapshot(snapshot: BomSnapshot): BomSnapshot {
  if (!snapshot || !snapshot.id || !snapshot.workspaceId || !snapshot.rootItemId || !snapshot.revision || !Array.isArray(snapshot.occurrences) || !Array.isArray(snapshot.parts) || !Array.isArray(snapshot.documents)) throw new Error('Incomplete BOM snapshot.');
  if (snapshot.units !== 'mm' || snapshot.upAxis !== 'Z') throw new Error('Adapter must normalize geometry to millimeters and Z up.');
  const parts = new Set<string>();
  for (const p of snapshot.parts) {
    const key = `${p.id}:${p.revision}`;
    if (parts.has(key)) throw new Error(`Duplicate part edition: ${key}`);
    parts.add(key);
    assertSafeAssetUrl(p.stepUrl);
    if (p.meshUrl !== undefined) assertSafeAssetUrl(p.meshUrl);
    if (p.displaySource !== undefined && !['step', 'mesh'].includes(p.displaySource)) throw new Error(`Unsupported geometry source for ${p.id}`);
    if (p.displaySource === 'mesh' && !p.meshUrl) throw new Error(`The selected mesh derivative is unavailable for ${p.id}`);
    if (p.cadNodePath !== undefined && (!Array.isArray(p.cadNodePath) || p.cadNodePath.length > STEP_LIMITS.maxHierarchyDepth || Array.from(p.cadNodePath).some(index => !Number.isSafeInteger(index) || index < 0 || index >= STEP_LIMITS.maxHierarchyNodes))) throw new Error(`Invalid CAD component path for ${p.id}`);
    if (p.displaySource === 'mesh' && p.cadNodePath !== undefined) throw new Error(`A mesh derivative cannot also select a STEP component for ${p.id}`);
    if (p.displaySource === 'mesh' && p.sourceToPart !== undefined) throw new Error(`A mesh derivative cannot also apply a STEP sourceToPart transform for ${p.id}`);
    if (p.displaySource !== 'mesh') validateSourceToPart(p.sourceToPart, p.cadNodePath !== undefined);
    if (p.bbox !== undefined && (!p.bbox || !finiteVec(p.bbox.min) || !finiteVec(p.bbox.max) || p.bbox.min.some((v, i) => v > p.bbox!.max[i]))) throw new Error(`Invalid bounds for ${p.id}`);
    if (p.volumeMm3 !== undefined && (!Number.isFinite(p.volumeMm3) || p.volumeMm3 < 0)) throw new Error(`Invalid CAD volume for ${p.id}`);
  }
  validateCadSourceMappings(snapshot.parts);
  const ids = new Set<string>();
  for (const o of snapshot.occurrences) {
    if (!o.id || ids.has(o.id)) throw new Error('BOM occurrence identifiers must be unique.');
    ids.add(o.id);
    if (!finiteVec(o.position) || !finiteVec(o.rotation)) throw new Error(`Missing or invalid placement for ${o.id}`);
    if (!Number.isFinite(o.quantity) || o.quantity <= 0) throw new Error(`Invalid quantity for ${o.id}`);
    if (o.modelState === 'loaded' && !parts.has(`${o.partId}:${o.partRevision}`)) throw new Error(`Loaded occurrence has no matching part edition: ${o.id}`);
  }
  const documentIds = new Set<string>();
  for (const d of snapshot.documents) {
    validateAttachment(d);
    const identity = attachmentIdentityKey(d);
    if (documentIds.has(identity)) throw new Error('Document attachment identities must be unique within a configuration.');
    documentIds.add(identity);
  }
  if (snapshot.assemblyStepUrl !== undefined) assertSafeAssetUrl(snapshot.assemblyStepUrl);
  if (snapshot.modelSources !== undefined) {
    if (!Array.isArray(snapshot.modelSources)) throw new Error('Invalid CAD source metadata.');
    const sources = new Set<string>();
    for (const source of snapshot.modelSources) {
      if (!source || !['id', 'itemId', 'revision', 'edition', 'sourceHash'].every(key => validIdentityText(source[key as keyof ModelSource])) || !Array.isArray(source.occurrenceIds) || new Set(source.occurrenceIds).size !== source.occurrenceIds.length) throw new Error('CAD sources need exact attachment identities and occurrence references.');
      const key = JSON.stringify([source.id, source.itemId, source.revision, source.edition, source.sourceHash]);
      if (sources.has(key)) throw new Error('Duplicate CAD source identity.');
      sources.add(key);
      const isAssembly = source.itemId === snapshot.rootItemId && source.revision === snapshot.revision;
      if (source.occurrenceIds.some(id => !ids.has(id) || !isAssembly && !snapshot.occurrences.some(row => row.id === id && row.partId === source.itemId && row.partRevision === source.revision))) throw new Error('CAD source does not match its BOM occurrences.');
      if (!isAssembly && !source.occurrenceIds.length) throw new Error('A part CAD source needs a matching occurrence in this configuration.');
    }
  }
  return normalizeBomPlacements(snapshot);
}
function finiteVec(v: unknown): v is Vec3 { return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)); }

/** Prevent a shared assembly STEP from being drawn in full once for every logical BOM part. */
export function validateCadSourceMappings(parts: readonly PartDefinition[]): void {
  const groups = new Map<string, PartDefinition[]>();
  for (const part of parts) {
    if (part.displaySource === 'mesh') continue;
    const url = new URL(part.stepUrl, 'https://viewer.invalid');
    const fields = ['workspaceId', 'itemId', 'revision', 'fileId', 'edition', 'sourceHash'];
    const key = fields.every(field => url.searchParams.has(field))
      ? JSON.stringify(fields.map(field => url.searchParams.get(field)))
      : JSON.stringify([part.stepUrl, part.sourceHash]);
    groups.set(key, [...groups.get(key) ?? [], part]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (group.some(part => part.cadNodePath === undefined)) throw new Error('A shared assembly STEP needs explicit CAD component paths for each BOM part. No component mapping was guessed.');
    for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) {
      const a = group[left].cadNodePath!, b = group[right].cadNodePath!;
      if (a.slice(0, Math.min(a.length, b.length)).every((value, index) => value === b[index])) throw new Error('CAD component paths overlap within one STEP source. Each BOM part must represent distinct geometry.');
    }
  }
}

export function validateSchema(schema: WorkspaceSchema): WorkspaceSchema {
  if (!schema?.workspaceId || !schema.name || !schema.version || !Array.isArray(schema.attributes)) throw new Error('Invalid attribute schema.');
  const ids = new Set<string>();
  for (const attribute of schema.attributes) {
    if (!attribute.id || !attribute.label || ids.has(attribute.id) || !['text', 'number', 'boolean', 'enum'].includes(attribute.type) || !['item', 'bom'].includes(attribute.scope)) throw new Error('Attribute definitions need unique IDs, labels, supported types, and scope.');
    ids.add(attribute.id);
  }
  return schema;
}
