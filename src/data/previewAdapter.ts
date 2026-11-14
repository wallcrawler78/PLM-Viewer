import type { Attachment, BomSnapshot, PartDefinition, PlmAdapter, RevisionDescriptor, Vec3, WorkspacePreset, WorkspaceSchema } from '../domain';
import { validateSchema, validateSnapshot } from '../domain';
import { itemAttributes, occurrenceAttributes, schemas } from './schemas';

interface FixtureManifest {
  units: 'mm'; upAxis: 'Z';
  parts: Omit<PartDefinition, 'attributes'>[];
  assemblies: Record<string, { id: string; partId: string; partRevision: string; position: Vec3; rotation: Vec3; name: string }[]>;
  documents: Attachment[];
  assemblyStepUrls?: Record<string, string>;
}
// Explicit fixture metadata. A real adapter supplies its document-family GUID;
// a matching filename is not sufficient evidence that two files are revisions.
const documentSeries: Record<string, string> = {
  'atlas-spec-A-pdf': 'atlas-spec-pdf', 'atlas-spec-B-pdf': 'atlas-spec-pdf',
  'atlas-spec-A-docx': 'atlas-spec-docx', 'atlas-spec-B-docx': 'atlas-spec-docx',
  'base-drawing-A-pdf': 'base-drawing-pdf', 'base-drawing-B-pdf': 'base-drawing-pdf',
  'gearbox-inspection-A-pdf': 'gearbox-inspection-pdf',
};
const normalizeDocument = (doc: Attachment): Attachment => ({ ...doc, edition: String(doc.edition), ...(documentSeries[doc.id] ? { seriesId: documentSeries[doc.id] } : {}) });
export class PreviewAdapter implements PlmAdapter {
  readonly mode = 'preview' as const;
  private manifestPromise?: Promise<FixtureManifest>;
  constructor(readonly preset: WorkspacePreset = 'precision', private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  async loadSchema(signal?: AbortSignal): Promise<WorkspaceSchema> {
    signal?.throwIfAborted();
    return validateSchema(structuredClone(schemas[this.preset]));
  }
  private async manifest(signal?: AbortSignal): Promise<FixtureManifest> {
    signal?.throwIfAborted();
    // Share only an un-aborted request; callers' cancellation must not poison future loads.
    if (!this.manifestPromise) this.manifestPromise = this.fetcher('/fixtures/manifest.json', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error(`Preview assets could not load (${response.status}). Reload or run npm run fixtures.`);
      const manifest = await response.json() as FixtureManifest;
      if (!Array.isArray(manifest.parts) || !manifest.assemblies?.A || !manifest.assemblies?.B || !Array.isArray(manifest.documents)) throw new Error('Preview fixture manifest is incomplete.');
      return manifest;
    }).catch(error => { this.manifestPromise = undefined; throw error; });
    const result = await this.manifestPromise;
    signal?.throwIfAborted();
    return result;
  }
  async loadBom(revision: string, signal?: AbortSignal): Promise<BomSnapshot> {
    if (!['A', 'B'].includes(revision)) throw new Error(`Unknown preview revision: ${revision}`);
    const manifest = await this.manifest(signal);
    const allParts = manifest.parts.map(part => ({ ...part, attributes: itemAttributes(part, this.preset) }));
    const placements = manifest.assemblies[revision];
    const occurrences = placements.map((placement, index) => {
      const part = allParts.find(p => p.id === placement.partId && p.revision === placement.partRevision);
      if (!part) throw new Error(`Missing fixture part ${placement.partId} revision ${placement.partRevision}`);
      return { ...placement, itemNumber: part.itemNumber, name: part.name, quantity: 1, attributes: occurrenceAttributes(part.id, index, this.preset), modelState: 'loaded' as const };
    });
    const parts = allParts.filter(part => occurrences.some(o => o.partId === part.id && o.partRevision === part.revision));
    const snapshot: BomSnapshot = {
      id: `preview:${this.preset}:atlas-drive:${revision}:1`, workspaceId: schemas[this.preset].workspaceId,
      rootItemId: 'assembly', rootItemNumber: 'ASM-1000', title: 'Atlas Drive Module', revision,
      configurationId: `atlas-drive-${revision}-frozen-1`, units: manifest.units, upAxis: manifest.upAxis,
      capturedAt: '2026-11-10T16:00:00.000Z', parts, occurrences,
      documents: manifest.documents.filter(doc => doc.itemId === 'assembly' ? doc.revision === revision : parts.some(part => part.id === doc.itemId && part.revision === doc.revision)).map(normalizeDocument),
      attributes: {}, assemblyStepUrl: manifest.assemblyStepUrls?.[revision],
    };
    return validateSnapshot(structuredClone(snapshot));
  }
  async listRevisions(signal?: AbortSignal): Promise<RevisionDescriptor[]> {
    signal?.throwIfAborted();
    return [{ id: 'A', label: 'Rev A · Released', lifecycle: 'Released' }, { id: 'B', label: 'Rev B · Proposed', lifecycle: 'Working' }];
  }
  async listAttachments(itemId: string, revision: string, signal?: AbortSignal): Promise<Attachment[]> {
    const manifest = await this.manifest(signal);
    return structuredClone(manifest.documents.filter(doc => doc.itemId === itemId && doc.revision === revision).map(normalizeDocument));
  }
}
