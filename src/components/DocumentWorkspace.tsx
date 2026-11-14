import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, FileText, GitCompareArrows, Highlighter, Link2, List, MessageSquarePlus, Pilcrow, ScanSearch } from 'lucide-react';
import type { DocumentTextChange } from '../document-review';
import { documentComparisonCoverage, extractionCoverageMessage } from '../document-extraction';
import type { DocumentExtraction } from '../document-extraction';
import { attachmentIdentityKey } from '../domain';
import { documentComparisonSources } from '../document-sources';
import { documentSourceKey, FileView } from './Documents';
import type { DocumentAnchor, DocumentFile, DocumentSourcePresentation, DocumentSuggestionAnchor } from './Documents';
import type { PdfRasterAvailability } from '../pdf-visual-raster';
import { useViewerPreferences } from '../ViewerPreferences';
import { useTextComparison } from '../text-comparison/useTextComparison';
export type { DocumentSuggestionAnchor } from './Documents';
import './document-workspace.css';

const VisualDocumentComparison = lazy(() => import('./VisualDocumentComparison'));

export interface DocumentWorkspaceProps {
  sourcePresentation?: DocumentSourcePresentation;
  file: DocumentFile | null;
  files: DocumentFile[];
  onAnchor: (anchor: DocumentAnchor) => void;
  focusAnchor?: DocumentAnchor | null;
  anchors?: { id: string; anchor: DocumentAnchor; label: string }[];
  onAnchorSelect?: (id: string) => void;
  onSuggest: (message: string, file: DocumentFile, anchor?: DocumentSuggestionAnchor) => void;
  compact?: boolean;
  compare: boolean;
  onCompareChange: (value: boolean) => void;
  /** Undefined requests automatic pairing; an empty key deliberately selects none. */
  baselineKey?: string;
  onBaselineChange?: (key: string) => void;
  /** Source viewing can be available before a review storage provider is connected. */
  annotationsEnabled?: boolean;
  /** Live sources require an explicitly resolved baseline configuration. */
  comparisonEnabled?: boolean;
}

export function DocumentWorkspace(props: DocumentWorkspaceProps) {
  if (!props.file) return <section className="document-workspace document-workspace-empty"><FileText size={38} /><span className="eyebrow">DOCUMENT REVIEW</span><h2>Choose a document</h2><p>Open a PDF or Word file from Files to read{props.comparisonEnabled !== false ? ' and compare revisions' : ''}{props.annotationsEnabled !== false ? ', or add review notes' : ''}.</p></section>;
  // Replacing a source also replaces its extraction, comparison, and markup state.
  return <DocumentSession key={documentSourceKey(props.file)} {...props} file={props.file} />;
}

function DocumentSession({ file, files, sourcePresentation = 'item', onAnchor, focusAnchor, anchors, onAnchorSelect, onSuggest, compact, compare, onCompareChange, baselineKey, onBaselineChange, annotationsEnabled = true, comparisonEnabled = true }: DocumentWorkspaceProps & { file: DocumentFile }) {
  const local = sourcePresentation === 'local';
  const { candidates, related, automaticKey } = documentComparisonSources(file, files);
  // A series identifies a document family, not a chronological revision order.
  // More than one possible baseline requires a deliberate choice.
  const [localBaselineKey, setLocalBaselineKey] = useState(automaticKey);
  // A controlled reset (for example restoring a legacy saved view) requests a
  // fresh safe pairing even when this same document session remains mounted.
  const selectedBaselineKey = baselineKey ?? (onBaselineChange ? automaticKey : localBaselineKey);
  useEffect(() => { if (baselineKey === undefined) onBaselineChange?.(automaticKey); }, [baselineKey, automaticKey, onBaselineChange]);
  const [markMode, setMarkMode] = useState(false);
  const before = candidates.find(candidate => attachmentIdentityKey(candidate) === selectedBaselineKey) ?? null;
  const anchor = (value: DocumentAnchor) => { setMarkMode(false); if (annotationsEnabled) onAnchor(value); };
  return <section className={`document-workspace ${compact ? 'document-workspace-compact' : ''} ${compare ? 'document-workspace-comparing' : ''}`} aria-label="Document workspace">
    <header className="document-workspace-heading">
      <div className="document-heading-icon"><FileText size={20} /></div>
      <div className="document-heading-copy"><span className="eyebrow">{compare ? local ? 'FILE COMPARISON' : 'REVISION REVIEW' : 'DOCUMENT'}</span><h2 title={file.name}>{file.name}</h2><p>{file.kind.toUpperCase()} <span>·</span> {local ? file.revision : `Rev ${file.revision}`} <span>·</span> {local ? 'Session only' : `Edition ${file.edition}`}</p></div>
      <div className="document-heading-actions">
        <button className={`button document-mark-button ${markMode ? 'active' : 'quiet'}`} aria-pressed={markMode} onClick={() => setMarkMode(value => !value)} disabled={!annotationsEnabled || (compare && !before)} title={annotationsEnabled ? 'Comment on a page or selected passage in either source' : 'Review notes are unavailable in this session.'}><MessageSquarePlus size={15} /><span>{markMode ? 'Cancel markup' : 'Add comment'}</span></button>
        <button className={`button ${compare ? 'secondary' : 'primary'} document-compare-button`} aria-pressed={compare} disabled={!comparisonEnabled} title={comparisonEnabled ? local ? 'Compare explicitly selected files' : 'Compare available document revisions' : 'Choose a baseline revision in Workspace settings to compare.'} onClick={() => { setMarkMode(false); onCompareChange(!compare); }}><GitCompareArrows size={16} /><span>{compare ? 'Close comparison' : local ? 'Compare files' : 'Compare revisions'}</span></button>
      </div>
    </header>
    {compare && <div className="document-baseline-bar"><label><span>Compare with</span><select aria-label={local ? 'Baseline document file' : 'Baseline document revision'} value={selectedBaselineKey} onChange={event => { setMarkMode(false); setLocalBaselineKey(event.target.value); onBaselineChange?.(event.target.value); }}><option value="">Choose a baseline…</option>{related.length > 0 && <optgroup label="Same document">{related.map(candidate => <option key={attachmentIdentityKey(candidate)} value={attachmentIdentityKey(candidate)}>{local ? candidate.revision : `Rev ${candidate.revision} · Edition ${candidate.edition}`} — {candidate.name}</option>)}</optgroup>}{candidates.filter(candidate => !related.some(match => attachmentIdentityKey(match) === attachmentIdentityKey(candidate))).length > 0 && <optgroup label={local ? 'Other open files' : 'Other files on this item'}>{candidates.filter(candidate => !related.some(match => attachmentIdentityKey(match) === attachmentIdentityKey(candidate))).map(candidate => <option key={attachmentIdentityKey(candidate)} value={attachmentIdentityKey(candidate)}>{candidate.name} · {local ? candidate.revision : `Rev ${candidate.revision} · Edition ${candidate.edition}`}</option>)}</optgroup>}</select><ChevronDown size={13} /></label><ArrowLeftRight size={14} /><span className="document-current-revision">Open file <strong>{local ? file.revision : `Rev ${file.revision}`}</strong></span>{before && <span className="document-auto-label"><Check size={12} />Local comparison</span>}</div>}
    {compare && !before ? <div className="document-baseline-empty"><GitCompareArrows size={32} /><h3>{candidates.length ? local ? 'Choose the file to compare' : 'Choose the revision to compare' : local ? 'No other file is available' : 'No other revision is available'}</h3><p>{candidates.length ? local ? 'Select a baseline above. Local files are compared only after you choose them.' : 'Select a baseline above. Files without a confirmed document family are never paired automatically.' : local ? 'Only one file of this type is open. Open another file or return to reading this file.' : 'This item has one available file of this type. Open another document or return to reading this file.'}</p><button className="button secondary" onClick={() => onCompareChange(false)}>Return to document</button></div> : compare && before ? <ComparisonReview key={JSON.stringify([documentSourceKey(before), documentSourceKey(file)])} before={before} after={file} sourcePresentation={sourcePresentation} markMode={annotationsEnabled && markMode} onAnchor={anchor} focusAnchor={focusAnchor} anchors={anchors} onAnchorSelect={onAnchorSelect} onSuggest={onSuggest} annotationsEnabled={annotationsEnabled} /> : <FileView file={file} sourcePresentation={sourcePresentation} markMode={annotationsEnabled && markMode} onAnchor={anchor} focusAnchor={focusAnchor} anchors={anchors} onAnchorSelect={onAnchorSelect} />}
  </section>;
}

interface ComparisonProps {
  sourcePresentation: DocumentSourcePresentation;
  before: DocumentFile;
  after: DocumentFile;
  markMode: boolean;
  onAnchor: (anchor: DocumentAnchor) => void;
  focusAnchor?: DocumentAnchor | null;
  anchors?: { id: string; anchor: DocumentAnchor; label: string }[];
  onAnchorSelect?: (id: string) => void;
  onSuggest: (message: string, file: DocumentFile, anchor?: DocumentSuggestionAnchor) => void;
  annotationsEnabled: boolean;
}
type Navigation = { page: number; progress: number; nonce: number };

function ComparisonReview({ before, after, sourcePresentation, markMode, onAnchor, focusAnchor, anchors, onAnchorSelect, onSuggest, annotationsEnabled }: ComparisonProps) {
  const { preferences } = useViewerPreferences();
  const pagesRef = useRef<HTMLDivElement>(null);
  const redlineRef = useRef<HTMLDivElement>(null);
  const [leftExtraction, setLeftExtraction] = useState<DocumentExtraction | null>(null);
  const [rightExtraction, setRightExtraction] = useState<DocumentExtraction | null>(null);
  // Saved defaults seed a new pair; an open review keeps its toolbar overrides.
  const [view, setView] = useState<'pages' | 'redline' | 'visual'>(() => preferences.documentComparison);
  const [visualOpened, setVisualOpened] = useState(false);
  const [leftRaster, setLeftRaster] = useState<PdfRasterAvailability>({ status: 'loading' });
  const [rightRaster, setRightRaster] = useState<PdfRasterAvailability>({ status: 'loading' });
  const visualSupported = before.kind === 'pdf' && after.kind === 'pdf';
  const [linked, setLinked] = useState(() => preferences.linkedScrolling);
  const [showHighlights, setShowHighlights] = useState(() => preferences.sourceHighlights);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [active, setActive] = useState(0);
  const [focusNonce, setFocusNonce] = useState(1);
  const [leftNavigation, setLeftNavigation] = useState<Navigation | null>(null);
  const [rightNavigation, setRightNavigation] = useState<Navigation | null>(null);
  const coverage = documentComparisonCoverage(leftExtraction, rightExtraction);
  const comparison = useTextComparison(documentSourceKey(before), documentSourceKey(after), leftExtraction, rightExtraction, coverage.canCompare);
  const { result } = comparison;
  const pending = coverage.pending || comparison.pending;
  const unavailable = coverage.unavailable || Boolean(comparison.error);
  const partial = coverage.partial;
  const changes = !unavailable ? result?.changes ?? [] : [];
  const index = Math.min(active, Math.max(0, changes.length - 1));
  const change = changes[index];
  const beforeHighlights = useMemo(() => showHighlights ? changes.flatMap(change => change.before ? [{ id: change.before.id, kind: 'removed' as const }] : []) : [], [changes, showHighlights]);
  const afterHighlights = useMemo(() => showHighlights ? changes.flatMap(change => change.after ? [{ id: change.after.id, kind: 'added' as const }] : []) : [], [changes, showHighlights]);
  const beforeFocus = useMemo(() => change?.before ? { id: change.before.id, page: change.before.page, nonce: focusNonce } : null, [change, focusNonce]);
  const afterFocus = useMemo(() => change?.after ? { id: change.after.id, page: change.after.page, nonce: focusNonce } : null, [change, focusNonce]);
  useEffect(() => { if (markMode) setView('pages'); }, [markMode]);
  useEffect(() => {
    if (view !== 'redline') return;
    const scroller = redlineRef.current;
    const target = scroller?.querySelector<HTMLElement>('.document-redline-card.active');
    if (!scroller || !target) return;
    scroller.scrollTo({ top: index === 0 ? 0 : scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 15, behavior: 'auto' });
  }, [index, view]);
  const choose = (next: number) => { if (changes.length) { setActive((next + changes.length) % changes.length); setFocusNonce(value => value + 1); setDetailsOpen(true); } };
  const suggest = (selected: DocumentTextChange) => {
    if (!annotationsEnabled) return;
    const source = selected.kind === 'removed' ? before : after;
    const block = selected.kind === 'removed' ? selected.before : selected.after;
    const excerpt = (block?.text ?? '').slice(0, 600);
    const anchor: DocumentSuggestionAnchor | undefined = block ? { fileId: source.id, itemId: source.itemId, sourceHash: source.sourceHash, revision: source.revision, edition: source.edition, page: block.page, quote: block.text.slice(0, 800), kind: source.kind === 'pdf' ? 'pdf' : 'docx' } : undefined;
    const pane = pagesRef.current?.querySelectorAll<HTMLElement>('.document-compare-pane')[selected.kind === 'removed' ? 0 : 1];
    const element = Array.from(pane?.querySelectorAll<HTMLElement>('[data-document-block]') ?? []).find(element => element.dataset.documentBlock === block?.id);
    const sheet = element?.closest<HTMLElement>('.pdf-page,section.word-page');
    if (anchor && element && sheet && sheet.getBoundingClientRect().width > 0) {
      const bounds = sheet.getBoundingClientRect(), point = element.getBoundingClientRect();
      anchor.x = Math.max(0, Math.min(1, (point.left + point.width / 2 - bounds.left) / bounds.width));
      anchor.y = Math.max(0, Math.min(1, (point.top + point.height / 2 - bounds.top) / bounds.height));
    }
    onSuggest(`${selected.kind === 'removed' ? 'Confirm that this removal is intended' : selected.kind === 'added' ? 'Review this added requirement for completeness and consistency' : 'Confirm the revised requirement and its impact'} (${sourcePresentation === 'local' ? '' : 'Rev '}${before.revision} → ${after.revision}): “${excerpt}”`, source, anchor);
  };
  const incomplete = partial || Boolean(result?.truncated);
  const status = pending ? 'Comparing text…' : unavailable ? 'Text comparison unavailable' : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}${incomplete ? ' · partial' : ''}`;
  return <div className="document-review">
    <div className="document-review-tools">
      <div className="document-view-switch" role="group" aria-label="Document comparison view"><button className={view === 'pages' ? 'active' : ''} aria-pressed={view === 'pages'} onClick={() => setView('pages')}><Columns2 size={14} /><span>Side by side</span></button><button className={view === 'redline' ? 'active' : ''} aria-pressed={view === 'redline'} onClick={() => setView('redline')}><Pilcrow size={15} /><span>Redline</span></button>{visualSupported && <button className={view === 'visual' ? 'active' : ''} aria-pressed={view === 'visual'} onClick={() => { setVisualOpened(true); setView('visual'); }}><ScanSearch size={14}/><span>Visual changes</span></button>}</div>
      {view === 'pages' && <div className="document-review-options"><button className={linked ? 'active' : ''} aria-label="Link document scrolling" aria-pressed={linked} onClick={() => { setLinked(value => !value); setLeftNavigation(null); setRightNavigation(null); }} title="Link page navigation and relative scroll position"><Link2 size={14} /><span>Linked</span></button><button className={showHighlights ? 'active' : ''} aria-label="Show source highlights" aria-pressed={showHighlights} onClick={() => setShowHighlights(value => !value)}><Highlighter size={14} /><span>Highlights</span></button></div>}
      {view !== 'visual' && <div className="document-change-navigation"><span aria-live="polite">{status}</span><button className="icon-button small" aria-label="Previous document change" disabled={!changes.length} onClick={() => choose(index - 1)}><ChevronLeft size={15} /></button><span className="document-change-position">{changes.length ? `${index + 1} / ${changes.length}` : '—'}</span><button className="icon-button small" aria-label="Next document change" disabled={!changes.length} onClick={() => choose(index + 1)}><ChevronRight size={15} /></button></div>}
    </div>
    {/* Keep both rendered sources mounted in every comparison view. Their extraction
        and exact source state remain authoritative; switching views does not refetch. */}
    <div ref={pagesRef} className={`document-review-pages ${view !== 'pages' ? 'document-pages-hidden' : ''}`} aria-hidden={view !== 'pages'} inert={view !== 'pages'}>
      <section className="document-compare-pane" aria-label={sourcePresentation === 'local' ? `Baseline file ${before.name}` : `Baseline revision ${before.revision}`}><SourceLabel file={before} side="before" sourcePresentation={sourcePresentation} /><FileView file={before} sourcePresentation={sourcePresentation} compact onExtraction={setLeftExtraction} onPdfRaster={setLeftRaster} highlights={beforeHighlights} focusBlock={beforeFocus} navigation={leftNavigation} onNavigate={linked ? value => setRightNavigation({ ...value, nonce: Date.now() }) : undefined} markMode={markMode} onAnchor={onAnchor} focusAnchor={focusAnchor} anchors={anchors} onAnchorSelect={onAnchorSelect} /></section>
      <section className="document-compare-pane" aria-label={sourcePresentation === 'local' ? `Open file ${after.name}` : `Open revision ${after.revision}`}><SourceLabel file={after} side="after" sourcePresentation={sourcePresentation} /><FileView file={after} sourcePresentation={sourcePresentation} compact onExtraction={setRightExtraction} onPdfRaster={setRightRaster} highlights={afterHighlights} focusBlock={afterFocus} navigation={rightNavigation} onNavigate={linked ? value => setLeftNavigation({ ...value, nonce: Date.now() }) : undefined} markMode={markMode} onAnchor={onAnchor} focusAnchor={focusAnchor} anchors={anchors} onAnchorSelect={onAnchorSelect} /></section>
    </div>
    {visualOpened && visualSupported && <Suspense fallback={view === 'visual' ? <div className="document-comparison-loading" role="status">Opening visual comparison…</div> : null}><VisualDocumentComparison before={before} after={after} beforeRaster={leftRaster} afterRaster={rightRaster} active={view === 'visual'} sourcePresentation={sourcePresentation} annotationsEnabled={annotationsEnabled} onSuggest={onSuggest} onShowSources={(beforePage, afterPage) => { setLinked(false); setLeftNavigation(beforePage ? { page: beforePage, progress: 0, nonce: Date.now() } : null); setRightNavigation(afterPage ? { page: afterPage, progress: 0, nonce: Date.now() } : null); setView('pages'); }}/></Suspense>}
    {view === 'redline' && <div ref={redlineRef} className="document-redline-list" aria-label="Automatic document redlines">
      <div className="document-redline-intro"><div><span className="eyebrow">EXTRACTED TEXT</span><h3>Every change, in context</h3></div><span><del>Removed</del><ins>Added</ins></span></div>
      {pending || unavailable || !changes.length ? <ComparisonState pending={pending} unavailable={unavailable} partial={incomplete} error={comparison.error} onRetry={comparison.retry} /> : changes.map((entry, entryIndex) => <article className={`document-redline-card ${entryIndex === index ? 'active' : ''}`} key={entry.id}><div className="document-redline-card-header"><button onClick={() => { choose(entryIndex); setView('pages'); }} title="Show this change in the source pages"><span className={`document-change-kind ${entry.kind}`}>{entry.kind}</span><span>Change {entryIndex + 1}</span><span>{pageLabel(entry)}</span></button><button className="text-button" disabled={!annotationsEnabled} title={annotationsEnabled?undefined:"Review notes are unavailable in this session."} onClick={() => suggest(entry)}><MessageSquarePlus size={13} />Draft note</button></div><Redline change={entry} /></article>)}
    </div>}
    {view === 'pages' && <div className={`document-change-detail ${detailsOpen ? '' : 'collapsed'}`}>
      <div className="document-change-detail-heading"><button className="document-detail-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}><List size={15} /><strong>{change ? `Change ${index + 1}` : 'Text changes'}</strong>{change && <span className={`document-change-kind ${change.kind}`}>{change.kind}</span>}<ChevronDown size={14} /></button>{change && <><span className="document-change-page">{pageLabel(change)}</span><button className="text-button document-draft-change" disabled={!annotationsEnabled} title={annotationsEnabled?undefined:"Review notes are unavailable in this session."} onClick={() => suggest(change)}><MessageSquarePlus size={14} />Draft review note</button></>}</div>
      {detailsOpen && <div className="document-change-detail-body">{change ? <Redline change={change} /> : <ComparisonState pending={pending} unavailable={unavailable} partial={incomplete} error={comparison.error} onRetry={comparison.retry} />}</div>}
    </div>}
    {view !== 'visual' && <footer className="document-review-footnote"><span><i className="removed" />Removed <i className="added" />Added</span><p>Text changes only. {visualSupported ? 'Use Visual changes for selected PDF pages, images and layout.' : 'Word layout and images need source review; visual pixel comparison requires PDF renditions.'}{partial ? ' Partial text comparison; unavailable content can appear as changes.' : ''}{extractionCoverageMessage(leftExtraction) ? ` Baseline: ${extractionCoverageMessage(leftExtraction)}` : ''}{extractionCoverageMessage(rightExtraction) ? ` Open file: ${extractionCoverageMessage(rightExtraction)}` : ''}{result?.truncated ? ' Comparison limits reached; some text or fine-grained redlines may be incomplete.' : ''}</p></footer>}
  </div>;
}

function SourceLabel({ file, side, sourcePresentation }: { file: DocumentFile; side: 'before' | 'after'; sourcePresentation: DocumentSourcePresentation }) {
  return <div className={`document-source-label ${side}`}><span className="document-source-revision">{sourcePresentation === 'local' ? file.revision.replace(/^File /, '#') : file.revision}</span><div><strong>{side === 'before' ? 'Baseline' : 'Open file'} <span>· {sourcePresentation === 'local' ? file.revision : `Edition ${file.edition}`}</span></strong><p title={file.name}>{file.name}</p></div></div>;
}
function pageLabel(change: DocumentTextChange) {
  return change.before && change.after ? `Page ${change.before.page} → ${change.after.page}` : `Page ${(change.after ?? change.before)?.page ?? 1}`;
}
function Redline({ change }: { change: DocumentTextChange }) {
  return <p className="document-word-redline">{change.runs.map((run, index) => run.kind === 'added' ? <ins key={index}>{run.text}</ins> : run.kind === 'removed' ? <del key={index}>{run.text}</del> : <span key={index}>{run.text}</span>)}</p>;
}
function ComparisonState({ pending, unavailable, partial, error, onRetry }: { pending: boolean; unavailable: boolean; partial: boolean; error: string; onRetry: () => void }) {
  return <div className="document-comparison-state" role={error ? 'alert' : 'status'}>{pending ? 'Extracting and aligning both source documents…' : error ? <>{error} <button className="text-button" onClick={onRetry}>Retry text comparison</button></> : unavailable ? 'Text could not be extracted from one or both files. Review the source pages visually; scanned files require OCR.' : partial ? 'No differences found in the available text. Some content was not compared.' : 'No text differences found in the extracted content.'}</div>;
}
