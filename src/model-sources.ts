import { createPartLookup } from './domain';
import type { BomSnapshot } from './domain';
import type { ScenePart } from './components/model/types';
import { validateSourceToPart } from './cad/step-mapping';
import { normalizeBomPlacements } from '../shared/bom-placements.mjs';

/** Default to the original STEP; a derivative is an explicit provider decision. */
export function sceneParts(snapshot: BomSnapshot | null, loaded: readonly string[]): ScenePart[] {
  if (!snapshot) return [];
  snapshot = normalizeBomPlacements(snapshot);
  const loadedIds = new Set(loaded);
  const resolvePart = createPartLookup(snapshot.parts);
  return snapshot.occurrences.filter(row => loadedIds.has(row.id) && row.modelState === 'loaded').flatMap(row => {
    const part = resolvePart(row);
    if (!part) return [];
    if (part.displaySource !== 'mesh') validateSourceToPart(part.sourceToPart, part.cadNodePath !== undefined);
    return [{
      id: row.id, itemId: part.id, itemNumber: part.itemNumber, name: row.name,
      revision: part.revision, color: part.color, position: row.position, rotation: row.rotation,
      ...(part.displaySource === 'mesh'
        ? { meshUrl: part.meshUrl }
        : { stepUrl: part.stepUrl, sourceHash: part.sourceHash,
          ...(part.cadNodePath !== undefined ? { cadNodePath: part.cadNodePath } : {}),
          ...(part.sourceToPart !== undefined ? { sourceToPart: part.sourceToPart } : {}) }),
      ...(part.bbox ? { bbox: part.bbox, bboxSource: 'cad' as const } : {}),
    }];
  });
}
