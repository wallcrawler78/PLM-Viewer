import { attachmentIdentityKey } from './domain';
import type { Attachment, BomSnapshot, PartDefinition } from './domain';

type ItemLabel = Pick<PartDefinition, 'id' | 'itemNumber' | 'name'>;
type NavigationSnapshot = Pick<BomSnapshot, 'rootItemId' | 'rootItemNumber' | 'documents'> & { parts: readonly ItemLabel[] };
export interface FileNavigationEntry {
  key: string;
  file: Attachment;
  current: boolean;
  itemNumber: string;
  itemName: string;
  duplicateName: boolean;
  searchText: string;
}
export interface FileNavigationGroup { itemId: string; itemNumber: string; itemName: string; files: FileNavigationEntry[] }

/** Resolve item labels and duplicate filenames once instead of scanning every BOM per file. */
export function indexFileNavigation(snapshot: NavigationSnapshot, snapshots: readonly NavigationSnapshot[], files: readonly Attachment[]): FileNavigationEntry[] {
  const labels = new Map<string, ItemLabel>();
  // Prefer the active configuration when an item's name changed between revisions.
  for (const source of [snapshot, ...snapshots]) for (const part of source.parts) if (!labels.has(part.id)) labels.set(part.id, part);
  const current = new Set(snapshot.documents.map(attachmentIdentityKey));
  const nameCounts = new Map<string, number>();
  for (const file of files) nameCounts.set(file.name, (nameCounts.get(file.name) ?? 0) + 1);
  return files.map(file => {
    const key = attachmentIdentityKey(file);
    const label = labels.get(file.itemId);
    const itemNumber = file.itemId === snapshot.rootItemId ? snapshot.rootItemNumber : label?.itemNumber ?? file.itemId;
    const itemName = file.itemId === snapshot.rootItemId ? 'Assembly' : label?.name ?? 'Item';
    return { key, file, current: current.has(key), itemNumber, itemName, duplicateName: (nameCounts.get(file.name) ?? 0) > 1,
      searchText: `${file.name} ${file.kind} ${file.itemId} ${itemNumber} ${itemName}`.toLocaleLowerCase() };
  });
}

/** Keep the opened exact edition visible even when it is outside the active configuration. */
export function groupFileNavigation(entries: readonly FileNavigationEntry[], rootItemId: string, query: string, showEarlier: boolean, selectedKey: string | null): FileNavigationGroup[] {
  const groups = new Map<string, FileNavigationGroup>();
  const search = query.trim().toLocaleLowerCase();
  for (const entry of entries) {
    if ((!showEarlier && !entry.current && entry.key !== selectedKey) || !entry.searchText.includes(search)) continue;
    let group = groups.get(entry.file.itemId);
    if (!group) { group = { itemId: entry.file.itemId, itemNumber: entry.itemNumber, itemName: entry.itemName, files: [] }; groups.set(entry.file.itemId, group); }
    group.files.push(entry);
  }
  for (const group of groups.values()) group.files.sort((a,b) => Number(b.current) - Number(a.current) || a.file.kind.localeCompare(b.file.kind) || a.file.name.localeCompare(b.file.name));
  return [...groups.values()].sort((a,b) => a.itemId === rootItemId ? -1 : b.itemId === rootItemId ? 1 : a.itemNumber.localeCompare(b.itemNumber));
}
