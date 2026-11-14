import { useMemo, useState } from 'react';
import { ArrowUpRight, Box, ChevronDown, FileText, Search, X } from 'lucide-react';
import type { Attachment, BomSnapshot } from '../domain';
import { groupFileNavigation, indexFileNavigation } from '../file-navigation';

interface Props {
  snapshot: BomSnapshot;
  snapshots: BomSnapshot[];
  files: Attachment[];
  selectedKey: string | null;
  onOpen: (file: Attachment) => void;
  onOpenModel: () => void;
  followSelection?: boolean;
  onFollowSelectionChange?: (value: boolean) => void;
}

/** The source list is independent of the rendering technology of its files. */
export function FileNavigator({ snapshot, snapshots, files, selectedKey, onOpen, onOpenModel, followSelection, onFollowSelectionChange }: Props) {
  const [query, setQuery] = useState('');
  const [showEarlier, setShowEarlier] = useState(false);
  const entries = useMemo(() => indexFileNavigation(snapshot, snapshots, files), [snapshot, snapshots, files]);
  const groups = useMemo(() => groupFileNavigation(entries, snapshot.rootItemId, query, showEarlier, selectedKey), [entries, snapshot.rootItemId, query, showEarlier, selectedKey]);
  const readyModels = snapshot.occurrences.filter(occurrence => occurrence.modelState === 'loaded').length;
  return <div className="file-navigator">
    <div className="file-nav-context"><span className="mini-label">FILES IN THIS BOM</span><span>{snapshot.rootItemNumber} · configuration {snapshot.revision}</span></div>
    <label className="search-field"><Search size={15}/><input aria-label="Find files" placeholder="Find a file or item…" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="Clear file search" onClick={() => setQuery('')}><X size={13}/></button>}</label>
    <div className="file-nav-list">
      {groups.map(group => <section className="file-nav-group" key={group.itemId} aria-label={`Files for ${group.itemNumber}`}>
          <h3><ChevronDown size={12}/><span>{group.itemNumber}</span><small>{group.itemName}</small></h3>
          {group.files.map(({ file, key, current, duplicateName }) => <button key={key} className={`file-nav-row ${selectedKey === key ? 'active' : ''}`} aria-pressed={selectedKey === key} aria-label={`Open ${file.name}${duplicateName?` · Rev ${file.revision} · Edition ${file.edition}`:''}`} title={file.name} onClick={() => onOpen(file)}>
            <span className={`file-format-icon ${file.kind}`}><FileText size={19}/><small>{file.kind.toUpperCase()}</small></span>
            <span className="file-nav-name"><strong>{file.name.replace(/\s+Rev\s+[^.]+(?=\.[^.]+$)/i, '').replace(/\.(pdf|docx?)$/i, '')}</strong><span>Rev {file.revision} <i>·</i> Edition {file.edition}{!current && <em>Other revision</em>}</span></span>
          </button>)}
        </section>)}
      {!groups.length && <div className="empty-small">No matching files.<button className="text-button" onClick={() => {setQuery('');setShowEarlier(true);}}>Show all revisions</button></div>}
    </div>
    <label className="earlier-files"><input type="checkbox" checked={showEarlier} onChange={event => setShowEarlier(event.target.checked)}/>Show other revisions</label>
    {onFollowSelectionChange && <label className="earlier-files follow-files" title="Open the selected BOM item's document. Turn off to keep the current file open."><input type="checkbox" checked={followSelection ?? false} onChange={event => onFollowSelectionChange(event.target.checked)}/>Follow selected BOM item</label>}
    <button className="related-model-card" disabled={!readyModels} onClick={onOpenModel}><span><Box size={21}/></span><div><strong>{readyModels ? 'Open assembly model' : 'No display model available'}</strong><small>{readyModels ? `STEP · ${readyModels} components ready · Rev ${snapshot.revision}` : 'Documents remain available for review'}</small></div>{readyModels > 0 && <ArrowUpRight size={15}/>}</button>
  </div>;
}
