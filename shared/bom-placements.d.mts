export const BOM_PLACEMENT_LIMITS: Readonly<{ occurrences: number; depth: number }>;
export interface PlacementOccurrence {
  id: string;
  parentId?: string;
  position: [number, number, number];
  rotation: [number, number, number];
}
export function sameBomOrientation(a: readonly [number, number, number], b: readonly [number, number, number], angularTolerance?: number): boolean;
export function normalizeBomPlacements<T extends { placementSpace?: 'world' | 'parent'; occurrences: PlacementOccurrence[] }>(snapshot: T): Omit<T, 'placementSpace'> & { placementSpace?: 'world' };
