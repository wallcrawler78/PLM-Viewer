import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowLeftRight, ArrowUpRight, BookOpen, Box, Boxes, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, ClipboardList, Columns2, Component, Copy, Eye, EyeOff, FileText, Focus, FolderOpen, GitCompareArrows, GripVertical, Layers3, LayoutPanelLeft, LoaderCircle, Maximize2, MessageSquare, Move3D, PanelRightClose, PanelRightOpen, Pin, Plus, RotateCcw, Ruler, Save, ScanLine, Search, Settings2, ShieldCheck, SlidersHorizontal, Table2, Trash2, Unplug, X } from 'lucide-react';
import type { Attachment, AttributeDefinition, BomOccurrence, BomSnapshot, ReviewAnchor, ReviewComment, ReviewDocument, RevisionDescriptor, SavedReviewView, SourceReference, Vec3, WorkspacePreset, WorkspaceSchema } from './domain';
import { attachmentIdentityKey, compareSnapshots, createPartLookup, documentForItem, formatAttributeValue, resolvePart, toAttachmentReference } from './domain';
import { PreviewAdapter } from './data/previewAdapter';
import { LocalReviewStore, emptyReview } from './data/reviewStore';
import type { ReviewRecoveryToken } from './data/reviewStore';
import { ReviewImportController } from './data/reviewImport';
import { pickSnapshotForAttachment, resolveCommentSource } from './data/reviewSource';
import type { SceneBounds, ScenePart } from './components/model/types';
import { DocumentWorkspace } from './components/DocumentWorkspace';
import { FileNavigator } from './components/FileNavigator';
import { ArenaConnection } from './components/ArenaConnection';
import { ModelLoadBoundary } from './components/ModelLoadBoundary';
import type { ArenaConnectionIssue } from './components/ArenaConnection';
import { loadArenaWorkspace } from './integrations/liveWorkspace';
import type { LiveWorkspace } from './integrations/liveWorkspace';
import { arenaLoginTarget, disconnectArena, readArenaAuthStatus } from './integrations/arenaAuth';
import type { ArenaAuthStatus } from './integrations/arenaAuth';
import { parseLaunchContext, resolvePreviewLaunch } from './launch-context';
import type { WorkspaceView } from './launch-context';
import type { DocumentAnchor, DocumentFile, DocumentSuggestionAnchor } from './components/Documents';
import { parseViewerState, resolveViewDocuments } from './view-state';
import type { ViewerState } from './view-state';
import { sectionControlRange } from './section-controls';
import { sceneParts } from './model-sources';
import { isRuntimeCheckRoute, runtimeCheckTarget } from './runtime-checks';
import { useViewerPreferences } from './ViewerPreferences';
import { ViewerPreferencesSettings } from './components/ViewerPreferencesSettings';

// Documents are the default workspace; fetch the CAD engine only when a model is opened.
const ModelViewport = lazy(() => import('./components/ModelViewport'));
const LocalFileWorkspace = lazy(() => import('./components/LocalFileWorkspace'));
const RuntimeChecks = lazy(() => import('./components/RuntimeChecks'));
const PlaygroundWorkspace = lazy(() => import('./playground/PlaygroundWorkspace'));

type Mode = 'single' | 'overlay' | 'split';
type Panel = 'properties' | 'discussion';
type ModalName = 'settings' | 'help' | 'models' | 'table' | 'views' | 'save' | null;
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 1 });
const shortDate = (s: string) => new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const isCompactWorkspace = () => window.matchMedia('(max-width: 900px)').matches;
const liveReviewNotice = 'Arena sources are read-only. Shared review storage is not connected, so notes and saved views are unavailable in this workspace.';

function connectionIssue(error: unknown): ArenaConnectionIssue {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNAVAILABLE';
  return { code, message: error instanceof Error ? error.message : 'The Arena connection could not be verified. Reopen the workspace to try again.' };
}

function IconButton({ label, children, onClick, active, disabled, className = '' }: { label: string; children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}
function Modal({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const node = ref.current;
    (node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>('button,input,select'))?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && node) {
        const targets = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')).filter(target => target.getClientRects().length > 0 && target.tabIndex >= 0);
        if (!targets.length) return;
        if (e.shiftKey && document.activeElement === targets[0]) { e.preventDefault(); targets.at(-1)?.focus(); }
        else if (!e.shiftKey && (document.activeElement === targets.at(-1) || !node.contains(document.activeElement))) { e.preventDefault(); targets[0].focus(); }
      }
    }
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><IconButton label="Close dialog" onClick={onClose}><X size={19} /></IconButton></div>{children}</section></div>;
}

function sourceFor(snapshot: BomSnapshot, occurrence?: BomOccurrence, file?: Attachment): SourceReference {
  const part = occurrence && resolvePart(snapshot, occurrence);
  return { workspaceId: snapshot.workspaceId, snapshotId: snapshot.id, itemId: file?.itemId ?? part?.id ?? snapshot.rootItemId, revision: file?.revision ?? part?.revision ?? snapshot.revision,
    ...(file ? { fileId: file.id, edition: file.edition, sourceHash: file.sourceHash } : part ? { sourceHash: part.sourceHash } : {}) };
}
function availableModelIds(snapshot: BomSnapshot | null): string[] {
  return snapshot?.occurrences.filter(occurrence=>occurrence.modelState==='loaded').map(occurrence=>occurrence.id)??[];
}
function modelAvailability(occurrence: BomOccurrence): string {
  return occurrence.modelState==='placement-needed'?'Placement required':occurrence.modelState==='no-model'?'No model attachment':occurrence.modelState==='unavailable'?'Source unavailable':'Geometry not prepared';
}

export default function App() {
  // A dedicated Preview route mounts no workspace, session, or Arena effects.
  if (isRuntimeCheckRoute(location.search)) return <Suspense fallback={<main className="connection-state"><LoaderCircle className="spin" size={28}/><p>Opening local runtime checks…</p></main>}><RuntimeChecks/></Suspense>;
  return <ReviewApp/>;
}

function ReviewApp() {
  const { preferences } = useViewerPreferences();
  const [playgroundOpen, setPlaygroundOpen] = useState(() => new URLSearchParams(location.search).get('playground') === '1');
  const [playgroundStarted, setPlaygroundStarted] = useState(playgroundOpen);
  useEffect(()=>{if(playgroundOpen)setPlaygroundStarted(true);},[playgroundOpen]);
  const [localFilesOpen, setLocalFilesOpen] = useState(false);
  const [preset, setPreset] = useState<WorkspacePreset>('precision');
  const [schema, setSchema] = useState<WorkspaceSchema | null>(null);
  const [snapshots, setSnapshots] = useState<{ A: BomSnapshot; B: BomSnapshot } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [revision, setRevision] = useState<'A' | 'B'>('B');
  const [mode, setMode] = useState<Mode>('single');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [loadedIds, setLoadedIds] = useState<string[]>([]);
  const [opacityById, setOpacityById] = useState<Record<string, number>>({});
  const [explode, setExplode] = useState(0);
  const [section, setSection] = useState<{enabled:boolean;axis:'x'|'y'|'z';offset:number}>({enabled:false,axis:'z',offset:30});
  const [measurementMode, setMeasurementMode] = useState(false);
  const [showBounds, setShowBounds] = useState(false);
  const [anchorMode, setAnchorMode] = useState(false);
  const [measurementResetKey,setMeasurementResetKey]=useState(0);
  const [cameraRestoreKey,setCameraRestoreKey]=useState(0);
  const [measurement, setMeasurement] = useState<{distance:number;a:Vec3;b:Vec3;occurrenceA:string;occurrenceB:string}|null>(null);
  const [bounds, setBounds] = useState<SceneBounds|null>(null);
  const [sceneBounds, setSceneBounds] = useState<SceneBounds|null>(null);
  const [cameraState, setCameraState] = useState<{position:Vec3;target:Vec3}|undefined>(undefined);
  const cameraRef = useRef<{position:Vec3;target:Vec3}|undefined>(undefined);
  const [viewCommand, setViewCommand] = useState<{type:'fit'|'iso'|'top'|'front'|'right';nonce:number}>({type:'iso',nonce:0});
  const [overlayOpacity, setOverlayOpacity] = useState({a:0.32,b:0.76});
  const [panel, setPanel] = useState<Panel>('discussion');
  const [panelOpen, setPanelOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('documents');
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [navigationTab, setNavigationTab] = useState<'files'|'bom'>('files');
  const [splitRatio, setSplitRatio] = useState(50);
  const contentRef = useRef<HTMLDivElement>(null);
  const splitResizeControllerRef = useRef<AbortController|null>(null);
  const [launchSearch, setLaunchSearch] = useState(location.search);
  const [docWidth, setDocWidth] = useState(382);
  const [documentKey, setDocumentKey] = useState<string|null>(null);
  const [documentBaselineKey, setDocumentBaselineKey] = useState<string|undefined>(undefined);
  const [pinned, setPinned] = useState(true);
  const [focusDocumentAnchor, setFocusDocumentAnchor] = useState<DocumentAnchor|null>(null);
  const [docCompare, setDocCompare] = useState(false);
  const [tab, setTab] = useState<'bom'|'changes'>('bom');
  const [search, setSearch] = useState('');
  const [fastenersExpanded, setFastenersExpanded] = useState(false);
  const [modal, setModal] = useState<ModalName>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [review, setReview] = useState<ReviewDocument>(emptyReview('preview-precision'));
  const storeRef = useRef<LocalReviewStore|null>(null);
  // Comments and views made while storage could not be used exist only in memory; nothing may replace them silently.
  const sessionOnlyRef = useRef(0);
  const recoveryRef = useRef<{store:LocalReviewStore;token:ReviewRecoveryToken|null}|null>(null);
  const importControllerRef = useRef(new ReviewImportController());
  const [draft, setDraft] = useState('');
  const [draftAnchor, setDraftAnchor] = useState<ReviewAnchor>({kind:'general'});
  const [draftSource, setDraftSource] = useState<SourceReference|null>(null);
  const [activeComment, setActiveComment] = useState<string|null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string,string>>({});
  const reply = activeComment ? replyDrafts[activeComment] ?? '' : '';
  const setReply = (value:string) => { if(activeComment) setReplyDrafts(current=>({...current,[activeComment]:value})); };
  const [viewName, setViewName] = useState('');
  const [notice, setNotice] = useState<{text:string;error?:boolean}|null>(null);
  const [storageIssue, setStorageIssue] = useState('');
  const [liveRequested, setLiveRequested] = useState(new URLSearchParams(location.search).get('mode') === 'arena');
  const [liveWorkspace, setLiveWorkspace] = useState<LiveWorkspace | null>(null);
  const [liveIssue, setLiveIssue] = useState<ArenaConnectionIssue | null>(null);
  const [liveRevisions, setLiveRevisions] = useState<RevisionDescriptor[]>([]);
  const [arenaAuth, setArenaAuth] = useState<ArenaAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authRefresh, setAuthRefresh] = useState(0);
  const authGenerationRef = useRef(0);
  const disconnectControllerRef = useRef<AbortController | null>(null);
  const sourceGenerationRef = useRef(0);
  const importRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const modelWorkspaceRef = useRef<HTMLElement>(null);
  const resolvedSnapshots = useMemo(() => snapshots ? [snapshots.A, snapshots.B] : [], [snapshots]);
  const snapshot = snapshots?.[revision] ?? null;
  const baseline = snapshots?.A ?? null;
  const currentPart = useMemo(() => createPartLookup(snapshot?.parts ?? []), [snapshot?.parts]);
  const baselinePart = useMemo(() => createPartLookup(baseline?.parts ?? []), [baseline?.parts]);
  const hasBaseline = !liveRequested || !!liveWorkspace?.hasBaseline;
  const changes = useMemo(() => snapshots && hasBaseline ? compareSnapshots(snapshots.A,snapshots.B) : [], [snapshots,hasBaseline]);
  const changeIds = useMemo(() => new Set(changes.map(c => c.occurrenceId)), [changes]);
  const allDocuments = useMemo(() => Array.from(new Map([...(snapshots?.A.documents??[]),...(snapshots?.B.documents??[])].map(d=>[attachmentIdentityKey(d),d])).values()), [snapshots]);
  const file = allDocuments.find(d=>attachmentIdentityKey(d)===documentKey) ?? null;
  const selectionSource = snapshot && selectedIds.some(id=>snapshot.occurrences.some(o=>o.id===id)) ? snapshot : mode!=='single' && baseline && selectedIds.some(id=>baseline.occurrences.some(o=>o.id===id)) ? baseline : snapshot;
  const selected = selectionSource?.occurrences.filter(o=>selectedIds.includes(o.id)) ?? [];
  const selectedPart = selectionSource && selected[0] ? (selectionSource === baseline ? baselinePart : currentPart)(selected[0]) : undefined;
  const parts = useMemo(() => sceneParts(snapshot,loadedIds),[snapshot,loadedIds]);
  const comparisonParts = useMemo(() => sceneParts(baseline,baseline?.occurrences.map(o=>o.id)??[]),[baseline]);
  const activeComparisonParts = mode==='single' ? undefined : comparisonParts;
  const sectionRange = sectionControlRange(sceneBounds, section.axis, section.offset);
  // Match the viewport's value-based source reload rule. Equivalent arrays from
  // Reset/Load all must not clear bounds when no new onReady event will follow.
  const sceneSourceKey = useMemo(() => JSON.stringify([parts, activeComparisonParts ?? []]), [parts, activeComparisonParts]);
  useEffect(() => { setSceneBounds(null); }, [sceneSourceKey]);
  const modelPins = useMemo(() => review.comments.filter(c=>c.source.snapshotId===snapshot?.id && c.status==='open' && c.anchor.kind==='model' && c.anchor.localPoint && validSource(c)).map((c,i)=>({id:c.id,occurrenceId:c.anchor.kind==='model'?c.anchor.occurrenceId:'',localPoint:c.anchor.kind==='model'?c.anchor.localPoint!:([0,0,0] as Vec3),label:String(i+1)})),[review.comments,snapshot?.id]);

  function validSource(comment:ReviewComment){try{resolveCommentSource(comment,Object.values(snapshots??{}));return true;}catch{return false;}}
  const documentPins=useMemo(()=>review.comments.flatMap((comment,index)=>{
    if(comment.status!=='open'||comment.anchor.kind!=='document'||!comment.anchor.rectangle||!snapshot||!snapshots)return [];
    try {
      const source=resolveCommentSource(comment,Object.values(snapshots));
      const attachment=source.attachment;
      if(!attachment||source.snapshot.id!==pickSnapshotForAttachment(attachment,snapshot,Object.values(snapshots)).id)return [];
      return [{id:comment.id,label:String(index+1),anchor:{fileId:attachment.id,itemId:attachment.itemId,sourceHash:attachment.sourceHash,revision:attachment.revision,edition:attachment.edition,page:comment.anchor.page??1,x:comment.anchor.rectangle[0],y:comment.anchor.rectangle[1],quote:comment.anchor.quote,kind:attachment.kind==='pdf'?'pdf' as const:'docx' as const}}];
    } catch {return [];}
  }),[review.comments,snapshots,snapshot]);
  const tell = useCallback((text:string,error=false)=>setNotice({text,error}),[]);
  useEffect(()=>{
    const query=window.matchMedia('(max-width: 900px)');
    const collapse=()=>{if(query.matches)setNavigationOpen(false);};
    collapse();query.addEventListener('change',collapse);
    return()=>{query.removeEventListener('change',collapse);splitResizeControllerRef.current?.abort();};
  },[]);
  useEffect(()=>{
    document.title=liveRequested?(!loading&&!liveIssue&&snapshot?`${snapshot.title} · Review Studio`:'Review Studio · Arena'):'Review Studio · Preview';
  },[liveRequested,loading,liveIssue,snapshot?.title]);
  useEffect(()=>{
    const generation=++authGenerationRef.current;
    if(!liveRequested){setArenaAuth(null);setAuthLoading(false);setAuthBusy(false);setAuthError('');return;}
    const controller=new AbortController();
    setAuthLoading(true);setAuthError('');setArenaAuth(null);
    void readArenaAuthStatus(controller.signal).then(status=>{
      if(controller.signal.aborted||generation!==authGenerationRef.current)return;
      setArenaAuth(status);setAuthLoading(false);
      if(liveWorkspace&&status.configured&&(!status.connected||status.user?.id!==liveWorkspace.status.user?.id||status.workspaceId!==liveWorkspace.status.workspaceId)){
        sourceGenerationRef.current++;clearSourceWorkspace();setLiveRevisions([]);setLoading(false);
        setLiveIssue({code:status.connected?'CONNECTION_CHANGED':'AUTH_REQUIRED',message:status.connected?'The connected Arena identity or workspace changed. Reopen this item to verify its source access.':'Your Arena session is disconnected. Connect to Arena to reopen this item.'});
      }
    }).catch(error=>{if(!controller.signal.aborted&&generation===authGenerationRef.current){setArenaAuth(null);setAuthLoading(false);setAuthError(error instanceof Error?error.message:'Arena sign-in status could not be checked.');}});
    return()=>{controller.abort();authGenerationRef.current++;};
  },[liveRequested,launchSearch,retry,authRefresh,liveWorkspace?.status.connectionId]);
  useEffect(()=>{
    if(!liveRequested)return;
    const refresh=()=>{if(document.visibilityState!=='hidden')setAuthRefresh(value=>value+1);};
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);disconnectControllerRef.current?.abort();};
  },[liveRequested]);
  useEffect(()=>{ if(!notice) return; const timer=window.setTimeout(()=>setNotice(null),notice.error?12000:5000); return ()=>clearTimeout(timer); },[notice]);
  useEffect(() => {
    if(liveRequested) return;
    const controller = new AbortController();
    const adapter = new PreviewAdapter(preset);
    setLoading(true); setLoadError('');setLiveWorkspace(null);setLiveIssue(null);setLiveRevisions([]);
    Promise.all([adapter.loadSchema(controller.signal),adapter.loadBom('A',controller.signal),adapter.loadBom('B',controller.signal)]).then(([s,a,b])=>{
      if(controller.signal.aborted) return;
      const launch=resolvePreviewLaunch(parseLaunchContext(launchSearch),[a,b]);
      setSchema(s); setSnapshots({A:a,B:b}); setRevision(launch.snapshot.revision as 'A'|'B');setMode('single');
      setWorkspaceView(launch.compare?'documents':launch.workspaceView);setNavigationTab(launch.workspaceView==='model'?'bom':'files');setNavigationOpen(!launch.compare&&!isCompactWorkspace());setSplitRatio(50);
      setSelectedIds(launch.selectedIds); setHiddenIds([]);setLoadedIds(launch.snapshot.occurrences.map(o=>o.id));setOpacityById({});setExplode(0);clearMeasurement();setShowBounds(false);
      setDocumentKey(launch.file?attachmentIdentityKey(launch.file):null);setDocumentBaselineKey(undefined);setPinned(true);
      setColumns(s.attributes.filter(a=>a.defaultVisible).map(a=>a.id));
      setDraft('');setDraftAnchor({kind:'general'});setDraftSource(null);setStorageIssue('');
      setReplyDrafts({});setActiveComment(null);setShowResolved(false);setSearch('');setFastenersExpanded(false);
      setSection({enabled:false,axis:'z',offset:30});setMeasurementMode(false);setAnchorMode(false);setFocusDocumentAnchor(null);setDocCompare(false);
      setPanel('discussion');setPanelOpen(false);setDocCompare(launch.compare);setTab('bom');setCameraState(undefined);cameraRef.current=undefined;setViewCommand({type:'iso',nonce:Date.now()});
      setOverlayOpacity({a:0.32,b:0.76});
      let openingStore:LocalReviewStore|null=null;
      storeRef.current=null;recoveryRef.current=null;
      try {
        const store = new LocalReviewStore(s.workspaceId);openingStore=store;storeRef.current=store;
        let data=store.load();
        if(data.revision===0) {
          const sensor=b.occurrences.find(o=>o.partId==='sensor');
          const doc=b.documents.find(d=>d.itemId==='assembly'&&d.kind==='pdf');
          const stamp='2026-11-10T16:15:00.000Z';
          const comments:ReviewComment[]=[];
          if(sensor) comments.push({id:'demo-sensor',body:'Sensor datum needs a second look. The specification calls for X = 61.0 ± 0.5 mm; the model occurrence is at X = 65.0 mm. Confirm the intended mounting position.',author:'Alex Morgan · demo reviewer',createdAt:stamp,updatedAt:stamp,status:'open',source:sourceFor(b,sensor),anchor:{kind:'model',occurrenceId:sensor.id,localPoint:[0,0,14],units:'mm'},replies:[]});
          if(doc) comments.push({id:'demo-width',body:'The new base is 136 mm wide. The revised installation envelope allows 140 mm. Please confirm that connectors and wiring stay inside the available clearance.',author:'Jamie Chen · demo reviewer',createdAt:stamp,updatedAt:stamp,status:'open',source:sourceFor(b,undefined,doc),anchor:{kind:'document',documentId:doc.id,page:1,rectangle:[0.52,0.45,0,0],quote:'Maximum installed width'},replies:[]});
          data=store.save({...data,comments},data.revision);
        }
        setReview(data);
      } catch(e) {
        storeRef.current=null;
        if(openingStore){try{recoveryRef.current={store:openingStore,token:openingStore.captureRecovery()};}catch{recoveryRef.current={store:openingStore,token:null};}}
        setReview(emptyReview(s.workspaceId));setStorageIssue(e instanceof Error?e.message:'Preview persistence is unavailable.');
      }
      setLoading(false);
    }).catch(e=>{if(!controller.signal.aborted){setLoadError(e instanceof Error?e.message:'Unable to load the preview.');setLoading(false);}});
    return ()=>{controller.abort();importControllerRef.current.cancel();};
  },[preset,retry,liveRequested,launchSearch]);
  useEffect(() => {
    if (!liveRequested) return;
    const controller = new AbortController();
    const generation = ++sourceGenerationRef.current;
    clearSourceWorkspace();
    setLoading(true);setLoadError('');setLiveIssue(null);setLiveRevisions([]);
    void loadArenaWorkspace(launchSearch, controller.signal).then(workspace => {
      if (controller.signal.aborted || generation !== sourceGenerationRef.current) return;
      const active = workspace.snapshots[workspace.slot];
      setLiveWorkspace(workspace);setLiveRevisions(workspace.revisions);
      setSchema(workspace.schema);setSnapshots(workspace.snapshots);setRevision(workspace.slot);setMode('single');
      setWorkspaceView(workspace.compare ? 'documents' : workspace.workspaceView);setNavigationTab(workspace.workspaceView === 'model' ? 'bom' : 'files');setNavigationOpen(!workspace.compare&&!isCompactWorkspace());setSplitRatio(50);
      setSelectedIds(workspace.selectedIds);setLoadedIds(availableModelIds(active));
      setDocumentKey(workspace.file ? attachmentIdentityKey(workspace.file) : null);setDocumentBaselineKey(undefined);setPinned(true);
      setColumns(workspace.schema.attributes.filter(attribute => attribute.defaultVisible).map(attribute => attribute.id));
      setReview(emptyReview(workspace.schema.workspaceId));setPanel('properties');setPanelOpen(false);setDocCompare(workspace.hasBaseline && workspace.compare);
      setLoading(false);
    }).catch(error => {
      if (controller.signal.aborted || generation !== sourceGenerationRef.current) return;
      clearSourceWorkspace();
      if (error instanceof Error && error.name === 'ArenaRevisionRequired' && 'revisions' in error && Array.isArray(error.revisions)) {
        setLiveRevisions(error.revisions as RevisionDescriptor[]);
        setLiveIssue({ code: 'REVISION_REQUIRED', message: error.message });
      } else setLiveIssue(connectionIssue(error));
      setLoading(false);
    });
    return () => { controller.abort();sourceGenerationRef.current++; };
  }, [liveRequested, launchSearch, retry]);
  useEffect(() => {
    if (!liveRequested || !liveWorkspace) return;
    const { adapter, status: expected } = liveWorkspace;
    let disposed = false;
    let pending: AbortController | null = null;
    function invalidate(issue: ArenaConnectionIssue) {
      if (disposed) return;
      disposed = true;pending?.abort();sourceGenerationRef.current++;
      clearSourceWorkspace();setLiveRevisions([]);setLiveIssue(issue);setLoading(false);setArenaAuth(null);setAuthRefresh(value=>value+1);
    }
    async function revalidate() {
      if (disposed || pending || document.visibilityState === 'hidden') return;
      const controller = new AbortController();pending = controller;
      try {
        const status = await adapter.connectionStatus(controller.signal);
        if (disposed || controller.signal.aborted) return;
        if (!status.configured || status.connectionId !== expected.connectionId || status.workspaceId !== expected.workspaceId || status.user?.id !== expected.user?.id || status.transport !== 'mcp' || !status.readOnly) {
          invalidate({ code: 'CONNECTION_CHANGED', message: 'The authenticated Arena connection changed. Reopen this workspace to check access and reload its exact sources.' });
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted) invalidate(connectionIssue(error));
      } finally { if (pending === controller) pending = null; }
    }
    function onSourceAccessFailure(event: Event) {
      const detail = (event as CustomEvent<{ code?: string; message?: string; connectionId?: string }>).detail;
      if (detail?.connectionId && detail.connectionId !== expected.connectionId) return;
      invalidate({ code: detail?.code ?? 'AUTH_REQUIRED', message: detail?.message ?? 'Access to an Arena source could not be verified. Reopen the workspace after checking your sign-in.' });
    }
    const interval = window.setInterval(() => { void revalidate(); }, 30_000);
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    window.addEventListener('viewer-session-invalid', onSourceAccessFailure);
    return () => { disposed = true;pending?.abort();window.clearInterval(interval);window.removeEventListener('focus', revalidate);document.removeEventListener('visibilitychange', revalidate);window.removeEventListener('viewer-session-invalid', onSourceAccessFailure); };
  }, [liveRequested, liveWorkspace]);
  useEffect(()=>{
    if(liveRequested)return;
    function sync(event:StorageEvent){const store=storeRef.current??recoveryRef.current?.store;if(store&&event.key===store.key){if(sessionOnlyRef.current){tell('Another tab changed the saved review. Your session-only comments and views are still here and were not replaced. Export them from Settings before reloading.',true);return;}try{setReview(store.load());storeRef.current=store;recoveryRef.current=null;setStorageIssue('');tell('Review updated from another browser tab. Your draft is still here.');}catch(e){tell(String(e),true);}}}
    window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
  },[tell,liveRequested]);
  useEffect(()=>{
    if(pinned||!snapshot) return;
    const target=selected[0]?.partId??snapshot.rootItemId;
    // The document must belong to the selected occurrence's exact item revision. Another revision's file is never shown in its place.
    chooseDocument(documentForItem(selectionSource,target,selected[0]?.partRevision??selectionSource?.revision));
  },[selectedIds,pinned,snapshot,selectionSource]);

  function clearSourceWorkspace() {
    splitResizeControllerRef.current?.abort();
    importControllerRef.current.cancel();sessionOnlyRef.current=0;storeRef.current=null;recoveryRef.current=null;
    setLiveWorkspace(null);setSchema(null);setSnapshots(null);setReview(emptyReview('arena-unconnected'));
    setDocumentKey(null);setDocumentBaselineKey(undefined);setFocusDocumentAnchor(null);setDocCompare(false);
    setSelectedIds([]);setHiddenIds([]);setLoadedIds([]);setOpacityById({});setMode('single');setExplode(0);setBounds(null);setSceneBounds(null);clearMeasurement();
    setSection({enabled:false,axis:'z',offset:30});setMeasurementMode(false);setShowBounds(false);setAnchorMode(false);
    setDraft('');setDraftSource(null);setDraftAnchor({kind:'general'});setReplyDrafts({});setActiveComment(null);setShowResolved(false);
    setCameraState(undefined);cameraRef.current=undefined;setViewCommand({type:'iso',nonce:Date.now()});setOverlayOpacity({a:0.32,b:0.76});
    setModal(null);setPanelOpen(false);setStorageIssue('');setNotice(null);setSearch('');setColumns([]);setTab('bom');setFastenersExpanded(false);
  }
  function clearMeasurement(){setMeasurement(null);setMeasurementResetKey(k=>k+1);}
  function chooseDocument(attachment:Attachment|null){
    const key=attachment?attachmentIdentityKey(attachment):null;
    setDocumentKey(key);
    if(key!==documentKey){setDocumentBaselineKey(undefined);setFocusDocumentAnchor(null);}
  }
  function persist(next:ReviewDocument):boolean {
    if(liveRequested){tell(liveReviewNotice,true);return false;}
    if(!storeRef.current){sessionOnlyRef.current++;setReview(next);tell(recoveryRef.current?'Kept for this session only: the review data saved in this browser cannot be read. Export this review from Settings, then recover or replace the saved data.':'Kept for this session only. Browser storage is unavailable. Export this review from Settings to keep it.',true);return true;}
    try {setReview(storeRef.current.save(next,review.revision));return true;} catch(e){tell(e instanceof Error?e.message:'Unable to save review.',true);try{setReview(storeRef.current.load());}catch{}return false;}
  }
  function select(ids:string[],additive=false){if(ids.length&&isCompactWorkspace())setNavigationOpen(false);if(ids.length&&workspaceView==='documents'){setWorkspaceView('together');setDocCompare(false);}setSelectedIds(current=>additive?Array.from(new Set([...current,...ids])).filter(i=>!(ids.includes(i)&&current.includes(i))):ids);}
  function switchRevision(value:'A'|'B') {
    if(!snapshots || (value==='A'&&!hasBaseline)) return;
    setRevision(value);setMode('single');setSelectedIds([]);setHiddenIds([]);setLoadedIds(availableModelIds(snapshots[value]));clearMeasurement();setShowBounds(false);setExplode(0);
    if(!pinned) chooseDocument(documentForItem(snapshots[value],snapshots[value].rootItemId,snapshots[value].revision,true));
  }
  function setComparison(value:Mode) {
    if(value!=='single'&&!hasBaseline){tell('Choose a baseline revision in Workspace settings before comparing.',true);return;}
    if(value!=='single'&&revision!=='B'&&snapshots){setRevision('B');setLoadedIds(availableModelIds(snapshots.B));setSelectedIds([]);}
    if(value==='single')setSelectedIds(ids=>ids.filter(id=>snapshot?.occurrences.some(o=>o.id===id)));
    setMode(value);clearMeasurement();setMeasurementMode(false);
  }
  function visibility(ids:string[]){const allHidden=ids.every(id=>hiddenIds.includes(id));setHiddenIds(current=>allHidden?current.filter(i=>!ids.includes(i)):Array.from(new Set([...current,...ids])));}
  function isolate(){if(!snapshot||!selectedIds.length)return;setHiddenIds(Array.from(new Set([...snapshot.occurrences,...(mode!=='single'?baseline?.occurrences??[]:[])].map(o=>o.id))).filter(id=>!selectedIds.includes(id)));setLoadedIds(current=>Array.from(new Set([...current,...selectedIds.filter(id=>availableModelIds(snapshot).includes(id))])));}
  function resetScene(){setSelectedIds([]);setHiddenIds([]);setLoadedIds(availableModelIds(snapshot));setOpacityById({});setExplode(0);setSection({enabled:false,axis:'z',offset:30});clearMeasurement();setMeasurementMode(false);setShowBounds(false);setAnchorMode(false);setViewCommand({type:'iso',nonce:Date.now()});}
  function anchorModel(anchor:{occurrenceId:string;localPoint:Vec3;worldPoint:Vec3}) {
    if(liveRequested){tell(liveReviewNotice,true);return;}
    if(!snapshot)return;
    if(draft.trim()){setAnchorMode(false);tell('Post or clear your current draft before choosing another comment anchor.',true);return;}
    const occurrence=snapshot.occurrences.find(o=>o.id===anchor.occurrenceId);
    setDraftAnchor({kind:'model',occurrenceId:anchor.occurrenceId,localPoint:anchor.localPoint,units:'mm'});setDraftSource(sourceFor(snapshot,occurrence));setAnchorMode(false);setPanel('discussion');setPanelOpen(true);setSelectedIds([anchor.occurrenceId]);setTimeout(()=>draftRef.current?.focus(),30);
  }
  function anchorDocument(anchor:DocumentAnchor){
    if(liveRequested){tell(liveReviewNotice,true);return;}
    const matches=allDocuments.filter(candidate=>candidate.id===anchor.fileId&&candidate.kind===anchor.kind&&candidate.revision===anchor.revision&&candidate.edition===anchor.edition&&(!anchor.itemId||candidate.itemId===anchor.itemId)&&(!anchor.sourceHash||candidate.sourceHash===anchor.sourceHash));
    const attachment=matches.length===1?matches[0]:null;
    if(!snapshot||!attachment)return;
    if(draft.trim()){tell('Post or clear your current draft before choosing another comment anchor.',true);return;}
    const owner=pickSnapshotForAttachment(attachment,snapshot,Object.values(snapshots!));
    setDraftAnchor({kind:'document',documentId:attachment.id,page:anchor.page,quote:anchor.quote,rectangle:[anchor.x,anchor.y,0,0]});
    setDraftSource(sourceFor(owner,undefined,attachment));setFocusDocumentAnchor(anchor);setPanel('discussion');setPanelOpen(true);
    setTimeout(()=>draftRef.current?.focus(),30);
  }
  function postComment(){
    if(liveRequested){tell(liveReviewNotice,true);return;}
    if(!snapshot||!draft.trim())return;
    const stamp=now();
    const comment:ReviewComment={id:id(),body:draft.trim(),author:'You · preview',createdAt:stamp,updatedAt:stamp,status:'open',source:draftSource??sourceFor(snapshot),anchor:draftAnchor,replies:[]};
    if(persist({...review,comments:[...review.comments,comment]})){setDraft('');setDraftAnchor({kind:'general'});setDraftSource(null);setActiveComment(comment.id);if(storeRef.current)tell('Comment saved in this preview browser.');}
  }
  function openComment(comment:ReviewComment,documentOnly=false){
    setActiveComment(comment.id);
    let located:ReturnType<typeof resolveCommentSource>;
    try {located=resolveCommentSource(comment,Object.values(snapshots!));}
    catch(e){setPanel('discussion');setPanelOpen(true);tell(e instanceof Error?e.message:'This note’s source is unavailable.',true);return;}
    const owner=located.snapshot;
    const ownerSlot=snapshots?.B.id===owner.id?'B':snapshots?.A.id===owner.id?'A':null;
    if(!ownerSlot){tell('This note’s exact configuration is unavailable.',true);return;}
    if(ownerSlot!==revision){setRevision(ownerSlot);setMode('single');setSelectedIds([]);setLoadedIds(availableModelIds(owner));setHiddenIds([]);clearMeasurement();setMeasurementMode(false);setShowBounds(false);}
    if(comment.anchor.kind==='model'){setDocCompare(false);setWorkspaceView(current=>current==='documents'?'together':current);const occurrenceId=comment.anchor.occurrenceId;setSelectedIds([occurrenceId]);setHiddenIds(h=>h.filter(i=>i!==occurrenceId));setLoadedIds(l=>Array.from(new Set([...l,occurrenceId])));}
    if(comment.anchor.kind==='document'){
      const documentAnchor=comment.anchor;const target=located.attachment;
      if(target){
        if(documentOnly)setWorkspace('documents');else setWorkspaceView(current=>current==='model'?'together':current);
        setDocCompare(false);chooseDocument(target);setPinned(true);
        setFocusDocumentAnchor(documentAnchor.page||documentAnchor.quote||documentAnchor.rectangle?{fileId:target.id,itemId:target.itemId,sourceHash:target.sourceHash,revision:target.revision,edition:target.edition,page:documentAnchor.page??1,x:documentAnchor.rectangle?.[0]??0,y:documentAnchor.rectangle?.[1]??0,point:!!documentAnchor.rectangle,quote:documentAnchor.quote,kind:target.kind==='pdf'?'pdf':'docx'}:null);
      }
    }
    setPanel('discussion');setPanelOpen(!documentOnly);
  }
  function toggleComment(comment:ReviewComment){persist({...review,comments:review.comments.map(c=>c.id===comment.id?{...c,status:c.status==='open'?'resolved':'open',updatedAt:now()}:c)});}
  function postReply(comment:ReviewComment){if(!reply.trim())return;if(persist({...review,comments:review.comments.map(c=>c.id===comment.id?{...c,updatedAt:now(),replies:[...c.replies,{id:id(),body:reply.trim(),author:'You · preview',createdAt:now()}]}:c)}))setReply('');}
  function saveView(){
    if(liveRequested){tell(liveReviewNotice,true);return;}
    if(!snapshot||!viewName.trim())return;
    const baselineDocument=allDocuments.find(candidate=>attachmentIdentityKey(candidate)===documentBaselineKey);
    const state:ViewerState={revision,mode,selectedIds,hiddenIds,loadedIds,opacityById,explode,section,camera:cameraRef.current,documentId:file?.id??null,documentSource:file?toAttachmentReference(file):null,documentBaselineSource:baselineDocument?toAttachmentReference(baselineDocument):null,pinned,panelOpen,panel,documentWidth:docWidth,overlayOpacity,showBounds,columns,workspaceView,documentCompare:docCompare,navigationOpen,splitRatio};
    const view:SavedReviewView={id:id(),name:viewName.trim(),createdAt:now(),source:sourceFor(snapshot),state:state as unknown as Record<string,unknown>};
    if(persist({...review,views:[...review.views,view]})){setModal(null);setViewName('');if(storeRef.current)tell('Saved the exact document editions, comparison, layout, and model state.');}
  }
  function restoreView(view:SavedReviewView){
    if(liveRequested){tell(liveReviewNotice,true);return;}
    try {
      const s=parseViewerState(view.state);
      const source=snapshots?.[s.revision];if(!source||source.id!==view.source.snapshotId)throw new Error('This saved view belongs to a different configuration and cannot be restored here.');
      const savedDocuments=resolveViewDocuments(s,allDocuments);
      const legacyWorkspace=s.panelOpen&&(s.panel??'reference')==='reference'?'together':'model';
      const restoredWorkspace=s.workspaceView??legacyWorkspace;
      const restoredInspector=s.workspaceView?s.panelOpen:s.panelOpen&&(s.panel==='properties'||s.panel==='discussion');
      const allowed=new Set(source.occurrences.map(o=>o.id));
      const displayAllowed=new Set([...allowed,...(s.mode!=='single'?baseline?.occurrences.map(o=>o.id)??[]:[])]);
      setRevision(s.revision);setMode(s.mode);setSelectedIds(s.selectedIds.filter(i=>displayAllowed.has(i)));setHiddenIds(s.hiddenIds.filter(i=>displayAllowed.has(i)));setLoadedIds(s.loadedIds.filter(i=>allowed.has(i)));setOpacityById(s.opacityById);setExplode(s.explode);setSection(s.section);setCameraState(s.camera);setCameraRestoreKey(k=>k+1);cameraRef.current=s.camera;
      setDocumentKey(savedDocuments.document?attachmentIdentityKey(savedDocuments.document):null);setDocumentBaselineKey(savedDocuments.baseline?attachmentIdentityKey(savedDocuments.baseline):s.documentBaselineSource===undefined?undefined:'');setFocusDocumentAnchor(null);
      setPinned(s.pinned);setPanelOpen(restoredInspector);setPanel(s.panel==='properties'?'properties':'discussion');setWorkspaceView(restoredWorkspace);setDocCompare(s.documentCompare??false);setNavigationOpen(s.navigationOpen??true);setNavigationTab(restoredWorkspace==='model'?'bom':'files');setSplitRatio(s.splitRatio??50);setDocWidth(s.documentWidth??382);setOverlayOpacity(s.overlayOpacity??{a:0.32,b:0.76});setShowBounds(s.showBounds??false);if(s.columns)setColumns(s.columns.filter(id=>schema?.attributes.some(a=>a.id===id)));setMeasurementMode(false);setAnchorMode(false);clearMeasurement();setModal(null);
      tell(savedDocuments.legacy?`Restored “${view.name}”. This older view stored only a file ID; its single available edition was opened. Save again to retain the exact editions.`:`Restored “${view.name}”.`,savedDocuments.legacy);
    }catch(e){tell(e instanceof Error?e.message:'Unable to restore view.',true);}
  }
  function exportReview(){if(liveRequested){tell(liveReviewNotice,true);return;}const blob=new Blob([JSON.stringify(review,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`assembly-review-${preset}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exportOriginalReview(){if(liveRequested){tell(liveReviewNotice,true);return;}const raw=recoveryRef.current?.token?.rawValue;if(raw===undefined)return;const url=URL.createObjectURL(new Blob([raw],{type:'text/plain'}));const link=document.createElement('a');link.href=url;link.download=`review-original-${preset}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function importReview(file:File){
    if(liveRequested){tell(liveReviewNotice,true);return;}
    importControllerRef.current.cancel();
    if(draft.trim()||Object.values(replyDrafts).some(value=>value.trim())){tell('Post or clear your note and reply drafts before replacing review data.',true);return;}
    if(file.size>2*1024*1024){tell('Review files must be smaller than 2 MB.',true);return;}
    if(sessionOnlyRef.current&&!window.confirm(`${sessionOnlyRef.current} comment or view change${sessionOnlyRef.current===1?' was':'s were'} kept for this session only and will be lost if you replace the review now. Export the current review first if you need ${sessionOnlyRef.current===1?'it':'them'}. Replace anyway?`))return;
    try{
      const store=storeRef.current??recoveryRef.current?.store??new LocalReviewStore(review.workspaceId);
      const request={store,expectedRevision:review.revision,recoveryToken:recoveryRef.current?.token??null};
      await importControllerRef.current.readAndImport(file,request,imported=>{
        storeRef.current=store;recoveryRef.current=null;sessionOnlyRef.current=0;setReview(imported);setStorageIssue('');
        setActiveComment(null);setFocusDocumentAnchor(null);
        tell('Local review replaced with the validated backup. Browser storage is active.');
      });
    }catch(e){tell(e instanceof Error?e.message:'Could not import review.',true);}
  }
  function setWorkspace(next:WorkspaceView){
    setPlaygroundOpen(false);
    splitResizeControllerRef.current?.abort();
    if(isCompactWorkspace())setNavigationOpen(false);
    if(workspaceView!=='documents'&&next==='documents'){setCameraState(cameraRef.current);setCameraRestoreKey(key=>key+1);}
    setWorkspaceView(next);setNavigationTab(next==='model'?'bom':'files');setAnchorMode(false);setMeasurementMode(false);
    if(next!=='model'&&!file){chooseDocument((selectedPart?documentForItem(snapshot,selectedPart.id,selectedPart.revision,true):null)??documentForItem(snapshot,snapshot?.rootItemId,snapshot?.revision,true));setPinned(true);}
    if(next==='together'){setDocCompare(false);setNavigationOpen(false);if(file&&workspaceView==='documents'){const related=snapshot?.occurrences.filter(occurrence=>occurrence.partId===file.itemId&&occurrence.partRevision===file.revision).map(occurrence=>occurrence.id)??[];setSelectedIds(related);setHiddenIds(current=>current.filter(id=>!related.includes(id)));setLoadedIds(current=>Array.from(new Set([...current,...related.filter(id=>availableModelIds(snapshot).includes(id))])));}}
  }
  function openDocument(document:DocumentFile){
    const attachment=allDocuments.find(candidate=>attachmentIdentityKey(candidate)===attachmentIdentityKey(document));
    if(!attachment){tell('That exact file edition is unavailable in this workspace.',true);return;}
    if(workspaceView==='model')setWorkspace('documents');
    chooseDocument(attachment);setPinned(true);setFocusDocumentAnchor(null);setDocCompare(false);
    setNavigationTab('files');
    if(isCompactWorkspace())setNavigationOpen(false);
  }
  function openDocCompare(){
    if(!hasBaseline){tell('Choose a baseline revision in Workspace settings before comparing.',true);return;}
    if(!file&&snapshot)chooseDocument(documentForItem(snapshot,snapshot.rootItemId,snapshot.revision,true));
    setWorkspace('documents');setDocCompare(true);setNavigationOpen(false);
  }
  function changeDocumentComparison(value:boolean){
    if(value&&!hasBaseline){tell('Choose a baseline revision in Workspace settings before comparing.',true);return;}
    if(value){setWorkspace('documents');setNavigationOpen(false);}setDocCompare(value);
  }
  function startSplitResize(event:React.PointerEvent<HTMLDivElement>){
    event.preventDefault();const box=contentRef.current?.getBoundingClientRect();if(!box||!box.width)return;
    splitResizeControllerRef.current?.abort();
    const controller=new AbortController();splitResizeControllerRef.current=controller;
    const handle=event.currentTarget,pointerId=event.pointerId;handle.setPointerCapture(pointerId);
    const move=(pointer:PointerEvent)=>{if(pointer.pointerId===pointerId)setSplitRatio(Math.max(30,Math.min(70,(pointer.clientX-box.left)/box.width*100)));};
    const end=()=>controller.abort();
    const endPointer=(pointer:PointerEvent)=>{if(pointer.pointerId===pointerId)end();};
    controller.signal.addEventListener('abort',()=>{if(handle.hasPointerCapture(pointerId))handle.releasePointerCapture(pointerId);if(splitResizeControllerRef.current===controller)splitResizeControllerRef.current=null;},{once:true});
    window.addEventListener('pointermove',move,{signal:controller.signal});
    window.addEventListener('pointerup',endPointer,{signal:controller.signal});
    window.addEventListener('pointercancel',endPointer,{signal:controller.signal});
    handle.addEventListener('lostpointercapture',endPointer,{signal:controller.signal});
    window.addEventListener('blur',end,{signal:controller.signal,once:true});
  }
  function openSampleWorkspace(){sourceGenerationRef.current++;clearSourceWorkspace();setLoading(true);setLiveRequested(false);setLaunchSearch('');history.replaceState({},'',location.pathname);setRetry(value=>value+1);}
  function connectArenaSession(){
    if(!liveRequested||!arenaAuth||authBusy)return;
    try{const target=arenaLoginTarget(arenaAuth,`${location.pathname}${launchSearch}`);setAuthError('');setAuthBusy(true);window.location.assign(target);}
    catch(error){setAuthBusy(false);setAuthError(error instanceof Error?error.message:'Arena sign-in could not be started.');}
  }
  async function disconnectArenaSession(){
    if(!liveRequested||!arenaAuth?.connected||authBusy)return;
    const status=arenaAuth;const controller=new AbortController();disconnectControllerRef.current?.abort();disconnectControllerRef.current=controller;
    const generation=++sourceGenerationRef.current;
    clearSourceWorkspace();setLiveRevisions([]);setLoading(false);setAuthBusy(true);setAuthError('');
    setLiveIssue({code:'AUTH_DISCONNECTING',message:'The viewer has cleared your sources and is ending this browser session’s Arena connection.'});
    try{
      await disconnectArena(status,controller.signal);
      if(controller.signal.aborted||generation!==sourceGenerationRef.current)return;
      setArenaAuth(null);setLiveIssue({code:'AUTH_DISCONNECTED',message:'This browser session is disconnected from Arena.'});
    }catch(error){
      if(!controller.signal.aborted&&generation===sourceGenerationRef.current)setLiveIssue(connectionIssue(error));
    }finally{
      if(disconnectControllerRef.current===controller){disconnectControllerRef.current=null;setAuthBusy(false);if(!controller.signal.aborted)setAuthRefresh(value=>value+1);}
    }
  }
  function openArenaRevision(value:string){
    const query=new URLSearchParams(launchSearch);query.set('revision',value);
    const next=`?${query.toString()}`;sourceGenerationRef.current++;clearSourceWorkspace();setLoading(true);setLiveIssue(null);setLaunchSearch(next);history.replaceState({},'',`${location.pathname}${next}`);
  }
  function chooseArenaBaseline(value:string){
    const query=new URLSearchParams(launchSearch);query.delete('baselineConfigurationId');if(value)query.set('baselineRevision',value);else{query.delete('baselineRevision');query.delete('compare');}
    const next=`?${query.toString()}`;sourceGenerationRef.current++;clearSourceWorkspace();setLoading(true);setLiveIssue(null);setLaunchSearch(next);history.replaceState({},'',`${location.pathname}${next}`);
  }
  function suggest(message:string,document:DocumentFile,anchor?:DocumentSuggestionAnchor){
    if(liveRequested){tell(liveReviewNotice,true);return;}
    if(draft.trim()){tell('Post or clear your current draft before starting a suggested note.',true);return;}
    const attachment=allDocuments.find(d=>attachmentIdentityKey(d)===attachmentIdentityKey(document));
    const owner=attachment&&snapshot&&snapshots?pickSnapshotForAttachment(attachment,snapshot,Object.values(snapshots)):null;
    const quote=anchor?.quote??(message.includes('“')&&message.includes('”')?message.slice(message.indexOf('“')+1,message.lastIndexOf('”')):undefined);
    if(owner&&attachment){setDraftSource(sourceFor(owner,undefined,attachment));setDraftAnchor({kind:'document',documentId:attachment.id,page:anchor?.page,quote,...(anchor?.x!==undefined&&anchor.y!==undefined?{rectangle:[anchor.x,anchor.y,0,0] as [number,number,number,number]}:{})});setDraft(message);setPanel('discussion');setPanelOpen(true);tell('Review the suggested note, then post it when ready.');}
  }
  function attributeValue(o:BomOccurrence,def:AttributeDefinition,owner=snapshot){const part=owner===snapshot?currentPart(o):owner===baseline?baselinePart(o):owner?resolvePart(owner,o):undefined;return formatAttributeValue(def.scope==='bom'?o.attributes[def.id]:part?.attributes[def.id],def);}
  const closeModal=useCallback(()=>setModal(null),[]);
  const filteredRows=(snapshot?.occurrences??[]).filter(o=>`${o.itemNumber} ${o.name}`.toLowerCase().includes(search.toLowerCase()));
  const boltRows=liveRequested?[]:filteredRows.filter(o=>o.partId==='fastener');
  const changeSummary={added:changes.filter(c=>c.kind==='added').length,removed:changes.filter(c=>c.kind==='removed').length,revised:changes.filter(c=>c.kind==='revised').length,moved:changes.filter(c=>c.kind==='moved').length};
  const activeAttributes=schema?.attributes.filter(a=>columns.includes(a.id))??[];
  const openCount=review.comments.filter(c=>c.status==='open').length;
  const orphanedReplies=Object.entries(replyDrafts).filter(([commentId,body])=>body.trim()&&!review.comments.some(comment=>comment.id===commentId));

  if(liveRequested&&(loading||liveIssue||!liveWorkspace||!snapshot||!schema))return <ArenaConnection loading={loading} issue={liveIssue} revisions={liveRevisions} onRevision={openArenaRevision} onRetry={()=>setRetry(value=>value+1)} onSample={openSampleWorkspace} authStatus={arenaAuth} authLoading={authLoading} authBusy={authBusy} authError={authError} onConnect={connectArenaSession} onDisconnect={()=>{void disconnectArenaSession();}}/>;
  if(loading||loadError||!snapshot||!schema)return <main className="connection-state"><div className="connection-card">{loadError?<><Unplug size={32}/><h1>This source could not be opened</h1><p>{loadError}</p><div className="button-row"><button className="button primary" onClick={()=>setRetry(r=>r+1)}>Try again</button><button className="button secondary" onClick={openSampleWorkspace}>Open sample workspace</button></div></>:<><LoaderCircle className="spin" size={32}/><h1>Opening your review workspace</h1><p>Resolving the requested file, its revisions, and related items.</p></>}</div></main>;
  if(localFilesOpen&&!liveRequested)return <Suspense fallback={<main className="connection-state"><LoaderCircle className="spin" size={28}/><p>Opening local file review…</p></main>}><LocalFileWorkspace onClose={()=>setLocalFilesOpen(false)}/></Suspense>;

  function row(o:BomOccurrence,indent=false){
    const selected=selectedIds.includes(o.id),hidden=hiddenIds.includes(o.id),loaded=loadedIds.includes(o.id),part=currentPart(o),available=o.modelState==='loaded';
    return <div className={`bom-row ${selected?'selected':''} ${hidden?'hidden-model':''} ${indent?'indented':''}`} key={o.id}>
      <button className="bom-row-main" aria-pressed={selected} onClick={e=>select([o.id],e.metaKey||e.ctrlKey||e.shiftKey)} title={`${o.name} · ${o.id}`}><span className="part-swatch" style={{background:part?.color??'#aaa'}}/><div><span className="part-number">{o.itemNumber}<span className={`row-change ${changeIds.has(o.id)?'changed':''}`} title={changeIds.has(o.id)?`Changed between revisions ${snapshots?.A.revision} and ${snapshots?.B.revision}`:'Unchanged'}/></span><span className="part-name">{indent?o.id.replace('occ-bolt-','Instance '):o.name}</span></div><span className="part-revision">{o.partRevision}</span></button>
      <IconButton className="row-visibility" disabled={!available} label={!available?`${o.name}: ${modelAvailability(o)}`:!loaded?`Load ${o.name}`:hidden?`Show ${o.name}`:`Hide ${o.name}`} onClick={()=>!loaded?setLoadedIds(l=>[...l,o.id]):visibility([o.id])}>{!loaded?<Plus size={14}/>:hidden?<EyeOff size={14}/>:<Eye size={14}/>}</IconButton>
    </div>;
  }

  const allParts=Object.values(snapshots!).flatMap(source=>source.parts);
  const fileSnapshot=file?pickSnapshotForAttachment(file,snapshot,Object.values(snapshots!)):null;
  const fileAttributes=file&&fileSnapshot?(file.itemId===fileSnapshot.rootItemId&&file.revision===fileSnapshot.revision?fileSnapshot.attributes:fileSnapshot.parts.find(part=>part.id===file.itemId&&part.revision===file.revision)?.attributes):undefined;
  const liveUser=typeof liveWorkspace?.status.user?.displayName==='string'&&liveWorkspace.status.user.displayName.trim()?liveWorkspace.status.user.displayName:liveWorkspace?.status.user?.id??'Authenticated user';
  const revisionLabel=snapshot.revision;
  const currentRevisionLabel=snapshots!.B.revision;
  const baselineRevisionLabel=baseline?.revision??'';
  const comparisonUnavailable='Choose a baseline revision in Workspace settings to compare.';
  return <div className={`app-shell universal-shell ${playgroundOpen?'playground-active':''}`}>
    <header className="appbar">
      <a className="brand" href={`${location.pathname}${liveRequested?launchSearch:''}`} aria-label="Review Studio home"><span className="brand-mark"><Layers3 size={22}/></span><span>Review<span className="brand-light">Studio</span></span></a><span className="header-divider"/>
      <button className="workspace-switch" onClick={()=>setModal('settings')}>{schema.name}<ChevronDown size={13}/></button><span className="appbar-spacer"/>
      <button className={liveRequested?'arena-live-badge':'preview-badge'} onClick={()=>setModal('settings')}><span/>{liveRequested?'Arena · Read only':'Preview mode'}</button>
      {!liveRequested&&<IconButton label="Open local test files" onClick={()=>setLocalFilesOpen(true)}><FolderOpen size={19}/></IconButton>}
      {!liveRequested&&<IconButton label="How to test the prototype" onClick={()=>setModal('help')}><CircleHelp size={19}/></IconButton>}
      <IconButton label="Workspace settings" onClick={()=>setModal('settings')}><Settings2 size={18}/></IconButton><span className="avatar" title={liveRequested?`Signed in as ${liveUser}`:'Local preview reviewer'} aria-label={liveRequested?`Signed in as ${liveUser}`:undefined}>{liveRequested?liveUser.trim().split(/\s+/).slice(0,2).map(name=>name[0]).join('').toUpperCase():'DB'}</span>
    </header>
    <section className="workspace-heading"><div className="heading-left"><span className="assembly-icon"><FolderOpen size={24}/></span><div><div className="breadcrumb">REVIEW WORKSPACE <ChevronRight size={10}/> {snapshot.rootItemNumber}</div><div className="title-line"><h1>{snapshot.title}</h1><span className="lifecycle"><span/>Configuration {revisionLabel}</span></div></div></div><div className="heading-actions"><button className="button quiet" aria-label="Saved views" disabled={liveRequested} title={liveRequested?liveReviewNotice:'Saved views'} onClick={()=>setModal('views')}><BookOpen size={16}/><span>Saved views</span>{review.views.length>0&&<span className="count">{review.views.length}</span>}</button><button className="button secondary" aria-label="Save view" disabled={liveRequested} title={liveRequested?liveReviewNotice:'Save view'} onClick={()=>{setViewName(workspaceView==='documents'?`${file?.kind.toUpperCase()??'Document'} review · ${docCompare?'Revision comparison':`Rev ${file?.revision??revisionLabel}`}`:`Rev ${revisionLabel} · ${workspaceView==='together'?'Document & model':mode==='single'?'Model review':mode==='overlay'?'Revision overlay':'Side by side'}`);setModal('save');}}><Save size={16}/><span>Save view</span></button></div></section>
    {storageIssue&&<div className="storage-banner">{storageIssue} Comments will remain in this session only.</div>}
    <nav className="universal-toolbar" aria-label="Review workspace layout">
      <button className={`navigation-toggle ${navigationOpen?'active':''}`} aria-label={navigationOpen?'Hide file navigator':'Show file navigator'} aria-expanded={navigationOpen} onClick={()=>setNavigationOpen(value=>!value)}><LayoutPanelLeft size={17}/><span>{navigationTab==='files'?'Files':'BOM'}</span></button>
      <div className="workspace-view-switch" role="group" aria-label="Content view">
        <button aria-pressed={!playgroundOpen&&workspaceView==='documents'} className={!playgroundOpen&&workspaceView==='documents'?'active':''} onClick={()=>setWorkspace('documents')}><FileText size={16}/><span>Documents</span></button>
        <button aria-pressed={!playgroundOpen&&workspaceView==='model'} className={!playgroundOpen&&workspaceView==='model'?'active':''} onClick={()=>setWorkspace('model')}><Box size={16}/><span>3D</span></button>
        <button aria-pressed={!playgroundOpen&&workspaceView==='together'} className={!playgroundOpen&&workspaceView==='together'?'active':''} onClick={()=>setWorkspace('together')}><Columns2 size={16}/><span>Together</span></button>
        <button aria-pressed={playgroundOpen} className={playgroundOpen?'active playground-tab':'playground-tab'} onClick={()=>setPlaygroundOpen(true)}><Component size={16}/><span>Playground</span></button>
      </div>
      <span className="universal-toolbar-spacer"/>
      <button className={`inspector-toggle ${panelOpen&&panel==='properties'?'active':''}`} aria-label="Source details" aria-pressed={panelOpen&&panel==='properties'} onClick={()=>{setPanelOpen(!(panelOpen&&panel==='properties'));setPanel('properties');}}><SlidersHorizontal size={16}/><span>Details</span></button>
      <button className={`inspector-toggle ${panelOpen&&panel==='discussion'?'active':''}`} aria-label={`Review notes (${openCount} open)`} aria-pressed={panelOpen&&panel==='discussion'} onClick={()=>{setPanelOpen(!(panelOpen&&panel==='discussion'));setPanel('discussion');}}><MessageSquare size={16}/><span>Notes</span><b className="count">{openCount}</b></button>
    </nav>
    <main hidden={playgroundOpen} className={`universal-layout view-${workspaceView} ${navigationOpen?'navigation-open':''} ${panelOpen?'inspector-open':''}`}>
      {navigationOpen&&<aside className="universal-navigation" aria-label="Workspace navigator"><div className="navigator-tabs"><button className={navigationTab==='files'?'active':''} aria-pressed={navigationTab==='files'} onClick={()=>setNavigationTab('files')}><FileText size={15}/>Files</button><button className={navigationTab==='bom'?'active':''} aria-pressed={navigationTab==='bom'} onClick={()=>setNavigationTab('bom')}><Boxes size={15}/>Bill of materials</button><IconButton label="Close navigator" onClick={()=>setNavigationOpen(false)}><X size={15}/></IconButton></div>{navigationTab==='files'?<FileNavigator snapshot={snapshot} snapshots={resolvedSnapshots} files={allDocuments} selectedKey={documentKey} onOpen={openDocument} onOpenModel={()=>setWorkspace('model')} followSelection={!pinned} onFollowSelectionChange={workspaceView==='together'?value=>setPinned(!value):undefined}/>:<aside className="bom-panel universal-bom" id="bill-of-materials" aria-label="Bill of materials"><div className="sidebar-tabs"><button className={tab==='bom'?'active':''} aria-pressed={tab==='bom'} onClick={()=>setTab('bom')}><Boxes size={15}/>Components</button><button className={tab==='changes'?'active':''} aria-pressed={tab==='changes'} disabled={!hasBaseline} title={!hasBaseline?comparisonUnavailable:'Compare resolved BOMs'} onClick={()=>setTab('changes')}>Changes<span className="count">{changeIds.size}</span></button></div>
        <div className="bom-context"><span className="mini-label">ASSEMBLY CONTEXT</span><select aria-label="Assembly revision" value={revision} onChange={e=>switchRevision(e.target.value as 'A'|'B')}><option value="B">Rev {currentRevisionLabel} · {liveRequested?'Current':'Proposed'}</option>{hasBaseline&&<option value="A">Rev {baselineRevisionLabel} · {liveRequested?'Baseline':'Released'}</option>}</select></div>
        {tab==='bom'?<><label className="search-field"><Search size={15}/><input placeholder="Find an item or part number…" aria-label="Search bill of materials" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button onClick={()=>setSearch('')} aria-label="Clear BOM search"><X size={13}/></button>}</label>
          <div className="tree-root"><ChevronDown size={14}/><Box size={16}/><button onClick={()=>select([])}><strong>{snapshot.rootItemNumber}</strong><span>{snapshot.occurrences.length} component instances</span></button><span className="root-revision">{revisionLabel}</span></div>
          <div className="bom-list">{filteredRows.filter(o=>liveRequested||o.partId!=='fastener').map(o=>row(o))}{boltRows.length>0&&<><div className={`bom-row fastener-group ${boltRows.every(o=>selectedIds.includes(o.id))?'selected':''}`}><button className="group-expand" aria-label="Expand fastener instances" aria-expanded={fastenersExpanded} onClick={()=>setFastenersExpanded(e=>!e)}>{fastenersExpanded?<ChevronDown size={13}/>:<ChevronRight size={13}/>}</button><button className="bom-row-main" onClick={()=>select(boltRows.map(o=>o.id))}><span className="part-swatch metallic"/><div><span className="part-number">{boltRows[0].itemNumber}</span><span className="part-name">M8 socket fastener <span className="instance-count">×{boltRows.length}</span></span></div><span className="part-revision">A</span></button><IconButton label="Toggle all fasteners" onClick={()=>visibility(boltRows.map(o=>o.id))}>{boltRows.every(o=>hiddenIds.includes(o.id))?<EyeOff size={14}/>:<Eye size={14}/>}</IconButton></div>{fastenersExpanded&&boltRows.map(o=>row(o,true))}</>}{filteredRows.length===0&&<div className="empty-small">No matching BOM items.<button className="text-button" onClick={()=>setSearch('')}>Clear search</button></div>}</div>
        </>:<div className="change-list"><div className="change-intro"><span className="revision-tag a">{baselineRevisionLabel}</span><ArrowLeftRight size={14}/><span className="revision-tag b">{currentRevisionLabel}</span><span>Resolved BOM comparison</span></div><div className="change-stats"><span><b>{changeSummary.added}</b> added</span><span><b>{changeSummary.removed}</b> removed</span><span><b>{changeSummary.revised}</b> revised</span><span><b>{changeSummary.moved}</b> moved</span></div>{changes.map(change=><button key={change.id} className={`change-card ${selectedIds.includes(change.occurrenceId)?'active':''}`} onClick={()=>{setComparison('overlay');select([change.occurrenceId]);setHiddenIds(h=>h.filter(i=>i!==change.occurrenceId));if(change.after?.modelState==='loaded')setLoadedIds(l=>Array.from(new Set([...l,change.occurrenceId])));}}><span className={`change-type ${change.kind}`}>{change.kind}</span><strong>{change.itemNumber}</strong><p>{change.name}</p><small>{change.summary}</small></button>)}<p className="change-limit">Changes come from BOM revisions and placements. Overlay shows geometry visually; automatic surface difference classification is a future tool.</p></div>}
        <div className="bom-bottom"><div><span className="status-dot"/>{loadedIds.filter(i=>!hiddenIds.includes(i)).length} visible <span>·</span> {snapshot.occurrences.length} in BOM</div><div className="bom-actions"><button className="button secondary" onClick={()=>setModal('models')}><Plus size={14}/>Add from BOM</button><IconButton label="Open BOM table and columns" onClick={()=>setModal('table')}><Table2 size={17}/></IconButton></div></div>
      </aside>}</aside>}
      <div className="universal-content" key={liveRequested?liveWorkspace?.status.connectionId:`preview-${schema.workspaceId}`} ref={contentRef} style={{'--document-ratio':`${splitRatio}%`} as CSSProperties}>
        <section className="document-primary" hidden={workspaceView==='model'} aria-label="Document review workspace"><DocumentWorkspace file={file} files={allDocuments} onAnchor={anchorDocument} focusAnchor={focusDocumentAnchor} anchors={documentPins} onAnchorSelect={commentId=>{const comment=review.comments.find(value=>value.id===commentId);if(comment)openComment(comment);}} onSuggest={suggest} compact={workspaceView==='together'} compare={docCompare} onCompareChange={changeDocumentComparison} baselineKey={documentBaselineKey} onBaselineChange={setDocumentBaselineKey} annotationsEnabled={!liveRequested} comparisonEnabled={hasBaseline}/></section>
        {workspaceView==='together'&&<div className="universal-split-handle" role="separator" aria-label="Resize document and model" aria-orientation="vertical" tabIndex={0} aria-valuemin={30} aria-valuemax={70} aria-valuenow={Math.round(splitRatio)} onPointerDown={startSplitResize} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setSplitRatio(value=>Math.max(30,Math.min(70,value+(event.key==='ArrowRight'?5:-5))));}}}><GripVertical size={11}/></div>}
        {!playgroundOpen&&workspaceView!=='documents'&&<section className="model-workspace" id="model-workspace" ref={modelWorkspaceRef} aria-label="3D model workspace"><div className="stage-header"><div className="view-modes" role="group" aria-label="Model comparison layout"><button className={mode==='single'?'active':''} aria-label="Model" title="Model" aria-pressed={mode==='single'} onClick={()=>setComparison('single')}><Box size={14}/><span>Model</span></button><button className={mode==='overlay'?'active':''} aria-label="Overlay" disabled={!hasBaseline} title={hasBaseline?'Revision overlay':comparisonUnavailable} aria-pressed={mode==='overlay'} onClick={()=>setComparison('overlay')}><Layers3 size={14}/><span>Overlay</span></button><button className={mode==='split'?'active':''} aria-label="Side by side" disabled={!hasBaseline} title={hasBaseline?'Side by side':comparisonUnavailable} aria-pressed={mode==='split'} onClick={()=>setComparison('split')}><Columns2 size={14}/><span>Side by side</span></button></div><span className="stage-header-spacer"/><span className="model-source-chip">Rev {revisionLabel} · STEP</span></div>
        <div className={`model-stage ${mode!=='single'?'is-comparing':''} ${section.enabled?'has-section':''}`}><ModelLoadBoundary onDocuments={()=>setWorkspace('documents')} hasDrafts={!!draft.trim()||Object.values(replyDrafts).some(value=>value.trim())}><Suspense fallback={<div className="model-module-loading" role="status"><LoaderCircle className="spin" size={22}/><span>Opening the 3D viewer…</span></div>}><ModelViewport renderQuality={preferences.renderQuality} currentRevision={revisionLabel} baselineRevision={baselineRevisionLabel} parts={parts} comparisonParts={activeComparisonParts} mode={mode} selectedIds={selectedIds} hiddenIds={hiddenIds} opacityById={opacityById} explode={explode} section={section} measurementMode={measurementMode} anchorMode={anchorMode} viewCommand={viewCommand} cameraState={cameraState} cameraRestoreKey={cameraRestoreKey} measurementResetKey={measurementResetKey} restoredMeasurement={measurement} onCameraChange={state=>{cameraRef.current=state;}} showBoundingBox={showBounds} overlayOpacity={overlayOpacity} onSelect={(id,add)=>select([id],add)} onMeasure={setMeasurement} onAnchor={anchorModel} onBoundsChange={setBounds} onReady={setSceneBounds} onError={message=>tell(message,true)} anchors={modelPins} onAnchorSelect={commentId=>{const c=review.comments.find(c=>c.id===commentId);if(c)openComment(c);}}/></Suspense></ModelLoadBoundary>
          <div className="stage-tools"><button className={`tool ${measurementMode?'active':''}`} onClick={()=>{setMeasurementMode(m=>!m);setAnchorMode(false);setExplode(0);clearMeasurement();}} aria-label="Measure" aria-pressed={measurementMode} title="Pick two mesh points to measure distance"><Ruler size={17}/><span>Measure</span></button><button className={`tool ${showBounds?'active':''}`} onClick={()=>{setShowBounds(b=>!b);setExplode(0);}} aria-label="Bounds" aria-pressed={showBounds} title="Bounding dimensions of selected or visible components"><ScanLine size={17}/><span>Bounds</span></button><button className={`tool ${section.enabled?'active':''}`} aria-label="Section" disabled={!section.enabled&&!sceneBounds} title={!section.enabled&&!sceneBounds?'Load model geometry to position a section plane':'Section plane'} aria-pressed={section.enabled} onClick={()=>setSection(s=>({...s,enabled:!s.enabled,offset:!s.enabled&&sceneBounds?sectionControlRange(sceneBounds,s.axis,s.offset).center:s.offset}))}><LayoutPanelLeft size={16}/><span>Section</span></button><span className="tool-separator"/><button className={`tool ${anchorMode?'active':''}`} aria-label="Pin comment" disabled={liveRequested} title={liveRequested?liveReviewNotice:'Pin a comment on the model'} aria-pressed={anchorMode} onClick={()=>{setAnchorMode(v=>!v);setMeasurementMode(false);setPanel('discussion');setPanelOpen(true);}}><MessageSquare size={16}/><span>Pin comment</span></button></div>
          <div className="inspection-controls">{mode!=='single'&&<div className="comparison-legend"><span><i className="legend-dot baseline"/>{baselineRevisionLabel} · {liveRequested?'Baseline':'Released'}</span><span><i className="legend-dot proposed"/>{currentRevisionLabel} · {liveRequested?'Current':'Proposed'}</span>{mode==='split'&&<small>Linked cameras</small>}</div>}
          {mode==='overlay'&&<div className="overlay-sliders"><label><span>{baselineRevisionLabel}</span><input aria-label="Baseline overlay opacity" type="range" min="0" max="1" step="0.05" value={overlayOpacity.a} onChange={e=>setOverlayOpacity(v=>({...v,a:+e.target.value}))}/></label><label><span>{currentRevisionLabel}</span><input aria-label={liveRequested?'Current overlay opacity':'Proposed overlay opacity'} type="range" min="0" max="1" step="0.05" value={overlayOpacity.b} onChange={e=>setOverlayOpacity(v=>({...v,b:+e.target.value}))}/></label></div>}
          {section.enabled&&<div className="section-control"><span>Section plane</span><select aria-label="Section axis" value={section.axis} onChange={e=>{const axis=e.target.value as 'x'|'y'|'z';setSection(s=>({...s,axis,offset:sceneBounds?sectionControlRange(sceneBounds,axis,s.offset).center:s.offset}));}}><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select><input aria-label="Section position" type="range" min={sectionRange.min} max={sectionRange.max} step="any" value={section.offset} onChange={e=>setSection(s=>({...s,offset:+e.target.value}))}/><span>{fmt(section.offset)} mm</span></div>}
          </div><div className="view-orientation"><IconButton label="Fit all visible models" onClick={()=>setViewCommand({type:'fit',nonce:Date.now()})}><Maximize2 size={18}/></IconButton><button onClick={()=>setViewCommand({type:'iso',nonce:Date.now()})} title="Isometric view">ISO</button><button onClick={()=>setViewCommand({type:'top',nonce:Date.now()})} title="Top view">TOP</button><button onClick={()=>setViewCommand({type:'front',nonce:Date.now()})} title="Front view">FRONT</button><button onClick={()=>setViewCommand({type:'right',nonce:Date.now()})} title="Right view">RIGHT</button></div>
          {(showBounds&&bounds||measurement)&&<div className="measurement-card">{showBounds&&bounds&&<><div className="measurement-title"><ScanLine size={14}/>{bounds.comparisonSource==='baseline'?'Baseline selection bounds':selectedIds.length?(mode!=='single'?'Current revision selection bounds':'Selection bounds'):'Visible assembly bounds'}</div><div className="bounds-values">{bounds.size.map((s,i)=><span key={i}><small>{['X','Y','Z'][i]}</small>{fmt(s)}<em>mm</em></span>)}</div><small>{bounds.source==='cad-bounds-envelope'?'Envelope of CAD part bounds':'Envelope of display-mesh bounds · approximate'} · assembled position</small></>}{measurement&&<><div className="measurement-title"><Ruler size={14}/>Point-to-point distance <button aria-label="Clear measurement" onClick={clearMeasurement}><X size={13}/></button></div><div className="distance-value">{fmt(measurement.distance)}<span>mm</span></div><small>Mesh surface points · approximate, not metrology</small></>}</div>}
          {selectedIds.length>0&&<div className="selection-toolbar"><span><span className="selection-indicator"/>{selectedIds.length===1?(selectedPart?.itemNumber??'Baseline component'):`${selectedIds.length} selected`}</span><IconButton label="Isolate selection" onClick={isolate}><Focus size={16}/></IconButton><IconButton label={selectedIds.every(id=>hiddenIds.includes(id))?'Show selection':'Hide selection'} onClick={()=>visibility(selectedIds)}>{selectedIds.every(id=>hiddenIds.includes(id))?<Eye size={16}/>:<EyeOff size={16}/>}</IconButton><label title="Selection opacity"><span>Opacity</span><input aria-label="Selected component opacity" type="range" min="0.1" max="1" step="0.05" value={opacityById[selectedIds[0]]??1} onChange={e=>setOpacityById(v=>({...v,...Object.fromEntries(selectedIds.map(id=>[id,+e.target.value]))}))}/></label><IconButton label="View selected item properties" onClick={()=>{setPanel('properties');setPanelOpen(true);}}><SlidersHorizontal size={16}/></IconButton><IconButton label="Clear selection" onClick={()=>select([])}><X size={15}/></IconButton></div>}
        </div>
        <div className="stage-bottom"><label className="explode-control"><Move3D size={16}/><span>Explode</span><input aria-label="Explode assembly" type="range" min="0" max="1" step="0.01" value={explode} onChange={e=>setExplode(+e.target.value)}/><span className="range-value">{Math.round(explode*100)}%</span></label><button className="text-button" aria-label="Reset view" title="Reset view" onClick={resetScene}><RotateCcw size={13}/><span>Reset view</span></button></div>
        <div className="model-caption"><span><i/>STEP-derived geometry</span><span>Drag to orbit <b>·</b> Scroll to zoom <b>·</b> Right-drag to pan</span><span>mm / Z up</span></div>
      </section>}
      </div>
      {panelOpen&&<aside className="universal-inspector" aria-label={panel==='discussion'?'Review notes':'Source details'}><div className="inspector-heading"><strong>{panel==='discussion'?'Review notes':'Source details'}</strong><IconButton label="Close review panel" onClick={()=>setPanelOpen(false)}><X size={17}/></IconButton></div>{panel==='properties'?(workspaceView==='documents'?<div className="properties-content file-details"><span className="eyebrow">DOCUMENT DETAILS</span>{file?<><h2>{file.name}</h2><div className="property-item-number">{file.itemId===snapshot.rootItemId?snapshot.rootItemNumber:allParts.find(part=>part.id===file.itemId)?.itemNumber??file.itemId}<span className="revision-tag b">Rev {file.revision}</span></div><div className="property-section"><h3>Source identity</h3><dl><div><dt>Format</dt><dd>{file.kind.toUpperCase()}</dd></div><div><dt>Item revision</dt><dd>{file.revision}</dd></div><div><dt>File edition</dt><dd>{file.edition}</dd></div><div><dt>Source hash</dt><dd className="hash" title={file.sourceHash}>{file.sourceHash.slice(0,20)}…</dd></div><div><dt>File identity</dt><dd>{file.id}</dd></div></dl></div><div className="property-section"><h3>Item attributes</h3><p className="property-subtitle">{schema.name} · supplied workspace fields</p><dl>{schema.attributes.filter(def=>def.scope==='item').map(def=><div key={def.id}><dt>{def.label}</dt><dd>{formatAttributeValue(fileAttributes?.[def.id],def)}</dd></div>)}</dl></div><button className="button secondary full" onClick={()=>{setWorkspace('together');setPanelOpen(false);}}><Columns2 size={15}/>View with related model</button><p className="file-detail-note">{liveRequested?liveReviewNotice:'Annotations stay attached to this exact file edition. Original files are unchanged.'}</p></>:<div className="empty-small">Open a document to inspect its source.</div>}</div>:<div className="properties-content"><span className="eyebrow">{selectedPart?'SELECTED ITEM':'ASSEMBLY CONTEXT'}</span><h2>{selectedPart?.name??snapshot.title}</h2><div className="property-item-number">{selectedPart?.itemNumber??snapshot.rootItemNumber}<span className="revision-tag b">Rev {selectedPart?.revision??revisionLabel}</span></div>{selectionSource?.id!==snapshot.id&&<p className="info-inline">Baseline revision {baselineRevisionLabel} · this occurrence is absent from the current BOM.</p>}{mode!=='single'&&selectedPart&&selectionSource?.id===snapshot.id&&<p className="info-inline">{liveRequested?'Current':'Proposed'} revision {currentRevisionLabel} properties. Component selection is linked across both revisions.</p>}{selected.length>1&&<p className="info-inline">{selected.length} instances selected. Item attributes below describe the first selected item.</p>}
            <div className="property-section"><h3>Geometry</h3><dl><div><dt>Source</dt><dd>{selectedPart?.displaySource==='mesh'?'STEP · Supplied mesh':'STEP · Local import'}</dd></div><div><dt>Coordinate system</dt><dd>Millimeters / Z up</dd></div>{selectedPart&&<><div><dt>Material</dt><dd>{selectedPart.material||'Not supplied'}</dd></div><div><dt>Supplied CAD bounds</dt><dd>{selectedPart.bbox?`${selectedPart.bbox.max.map((n,i)=>fmt(n-selectedPart.bbox!.min[i])).join(' × ')} mm`:'Not supplied · use Bounds for the imported mesh'}</dd></div><div><dt>CAD volume</dt><dd>{selectedPart.volumeMm3===undefined?'Not supplied':`${fmt(selectedPart.volumeMm3)} mm³`}</dd></div><div><dt>Occurrence origin</dt><dd>{selected[0]?.position.map(fmt).join(', ')} mm</dd></div><div><dt>Part source hash</dt><dd className="hash" title={selectedPart.sourceHash}>{selectedPart.sourceHash.slice(0,18)}…</dd></div></>}</dl></div>
            <div className="property-section"><div className="property-section-title"><h3>Workspace attributes</h3><button className="text-button" onClick={()=>setModal('table')}>Configure</button></div><p className="property-subtitle">{schema.name} · schema {schema.version}</p>{selected[0]?<dl>{schema.attributes.map(def=><div key={def.id}><dt>{def.label}<span className="attribute-scope">{def.scope}</span></dt><dd>{attributeValue(selected[0],def,selectionSource)}</dd></div>)}</dl>:<p className="muted">Select a component to inspect its item and BOM attributes.</p>}</div>
            <div className="property-section"><h3>Resolved source</h3><dl><div><dt>Configuration</dt><dd>{selectionSource?.configurationId}</dd></div><div><dt>Snapshot</dt><dd>{liveRequested?'Resolved revision':'Frozen preview'} {selectionSource?.revision}</dd></div><div><dt>Assembly file</dt><dd>{liveRequested?(selectionSource?.modelSources?.filter(source=>source.itemId===selectionSource.rootItemId&&source.revision===selectionSource.revision).map(source=>`${source.id} · Edition ${source.edition}`).join(', ')||'No assembly attachment'):selectionSource?.assemblyStepUrl?.split('/').pop()??'Manifest assembly'}</dd></div></dl><p className="property-subtitle">{liveRequested?'Source identity and attribute definitions are supplied by this Arena workspace. Access follows your authenticated Arena session.':'These are synthetic fixtures. In Arena mode, the adapter supplies this source identity and attribute schema.'}</p></div><button className="button secondary full" onClick={()=>setModal('settings')}><ArrowUpRight size={14}/>Arena integration details</button></div>):liveRequested?<div className="arena-review-unavailable"><ShieldCheck size={23}/><h3>Read-only Arena workspace</h3><p>{liveReviewNotice}</p></div>:<div className="discussion-content"><div className="discussion-heading"><div><span className="eyebrow">TEAM REVIEW</span><h2>Review notes</h2></div><span className="local-label">Local preview</span></div><p className="discussion-description">Comments keep their source revision and location. Demo reviewers are simulated.</p><div className="draft-box"><div className="draft-context"><MessageSquare size={13}/>{draftAnchor.kind==='model'?`Model point · ${snapshot.occurrences.find(o=>o.id===draftAnchor.occurrenceId)?.itemNumber??draftAnchor.occurrenceId}`:draftAnchor.kind==='document'?`Document · Rev ${draftSource?.revision??file?.revision??revision}${draftAnchor.page?` · page ${draftAnchor.page}`:''}`:draftSource?.fileId?`Document · Rev ${draftSource.revision}`:`Assembly · Rev ${draftSource?.revision??revision}`}{draftAnchor.kind!=='general'&&<button aria-label="Clear comment anchor" onClick={()=>{setDraftAnchor({kind:'general'});setDraftSource(null);}}><X size={12}/></button>}</div>{draftAnchor.kind==='document'&&draftAnchor.quote&&<blockquote>{draftAnchor.quote}</blockquote>}<textarea ref={draftRef} placeholder={anchorMode?'Click the model to place a pin, then add a note…':'Add a review note…'} aria-label="New review comment" maxLength={4000} value={draft} onChange={e=>{if(!draft.trim()&&e.target.value.trim()&&!draftSource){if(workspaceView!=='model'&&file){setDraftSource(sourceFor(pickSnapshotForAttachment(file,snapshot,Object.values(snapshots!)),undefined,file));setDraftAnchor({kind:'document',documentId:file.id});}else setDraftSource(sourceFor(snapshot));}setDraft(e.target.value);if(!e.target.value.trim()&&draftAnchor.kind==='general')setDraftSource(null);}}/><div className="draft-footer"><span>{draft.length}/4000</span><button className="button primary small-button" disabled={!draft.trim()} onClick={postComment}>Post note<ArrowUpRight size={13}/></button></div></div><>{orphanedReplies.map(([commentId,body])=><div className="orphaned-reply" key={commentId}><strong>Unsent reply retained</strong><p>This comment was removed from the review in another tab. Copy your reply before clearing it.</p><textarea readOnly aria-label="Retained unsent reply" value={body}/><button className="text-button" onClick={()=>setReplyDrafts(current=>{const next={...current};delete next[commentId];return next;})}>Clear retained reply</button></div>)}</><div className="discussion-filter"><span>{openCount} open {openCount===1?'comment':'comments'}</span><label><input type="checkbox" checked={showResolved} onChange={e=>setShowResolved(e.target.checked)}/>Show resolved</label></div>
            <div className="comments-list">{review.comments.filter(c=>showResolved||c.status==='open').slice().reverse().map(comment=><article key={comment.id} className={`comment-card ${activeComment===comment.id?'active':''} ${comment.status==='resolved'?'resolved':''}`}><div className="comment-author"><span className="comment-avatar">{comment.author.startsWith('You')?'Y':comment.author.split(' ').slice(0,2).map(n=>n[0]).join('')}</span><div><strong>{comment.author}</strong><span>{shortDate(comment.createdAt)}</span></div><button className={`comment-status ${comment.status}`} onClick={()=>toggleComment(comment)} title={comment.status==='open'?'Resolve comment':'Reopen comment'}>{comment.status==='resolved'?<CheckCircle2 size={16}/>:<Check size={15}/>}</button></div><button className="comment-location" onClick={()=>openComment(comment)}>{comment.anchor.kind==='model'?<Pin size={11}/>:comment.anchor.kind==='document'?<FileText size={11}/>:<Box size={11}/>} {comment.anchor.kind==='model'?'Model location':comment.anchor.kind==='document'?'Document markup':'Assembly note'}<span>Assembly {Object.values(snapshots!).find(s=>s.id===comment.source.snapshotId)?.revision??'unavailable'} · item {comment.source.revision}</span><ArrowUpRight size={11}/></button><p>{comment.body}</p>{comment.replies.map(r=><div className="comment-reply" key={r.id}><strong>{r.author}</strong><p>{r.body}</p></div>)}{activeComment===comment.id?<><div className="comment-anchor-detail">{comment.anchor.kind==='model'&&comment.anchor.localPoint?`Component coordinates: ${comment.anchor.localPoint.map(fmt).join(', ')} mm`:comment.anchor.kind==='document'?`File edition ${comment.source.edition??'1'}${comment.anchor.page?` · page ${comment.anchor.page}`:''}`:'Anchored to the assembly snapshot'}</div>{comment.anchor.kind==='document'&&<button className="text-button" onClick={()=>openComment(comment,true)}><BookOpen size={12}/>Show referenced document</button>}<div className="reply-field"><input aria-label="Reply to comment" placeholder="Reply to this comment…" maxLength={2000} value={reply} onChange={e=>setReply(e.target.value)}/><button disabled={!reply.trim()} aria-label="Post reply" onClick={()=>postReply(comment)}><ArrowUpRight size={15}/></button></div></>:<button className="text-button reply-link" onClick={()=>openComment(comment)}>{replyDrafts[comment.id]?.trim()?'Continue reply':comment.replies.length?`${comment.replies.length} replies`:'Reply or locate'}</button>}</article>)}</div>{review.comments.length===0&&<div className="empty-small">No comments yet. Pin a model point or mark a document to start.</div>}</div>}</aside>}
    </main>
    {(playgroundOpen||playgroundStarted)&&<div className="playground-container" hidden={!playgroundOpen}><ModelLoadBoundary onDocuments={()=>setWorkspace('documents')} hasDrafts={false}><Suspense fallback={<div className="pg-loading" role="status"><LoaderCircle className="spin" size={24}/><p>Opening Playground…</p></div>}><PlaygroundWorkspace active={playgroundOpen} snapshot={snapshot} sourceMode={liveRequested?'arena':'preview'} connectionId={liveWorkspace?.status.connectionId} initialFileId={file?.id} onExit={()=>setWorkspace('documents')}/></Suspense></ModelLoadBoundary></div>}
    <footer className="statusbar"><span><span className="status-dot"/>{liveRequested?'Arena source ready':'Preview data ready'} <span className="footer-divider">|</span> {snapshot.rootItemNumber} · Rev {revisionLabel}</span><span><ShieldCheck size={12}/>{liveRequested?liveUser:'No Arena connection'} <span className="footer-divider">|</span> {liveRequested?'Read only · review storage unconnected':storageIssue?'Review kept for this session only':'Review stored in this browser'}</span>{liveRequested?<button onClick={()=>setModal('settings')}>Connection details<ArrowUpRight size={11}/></button>:<button onClick={()=>setModal('help')}>Prototype guide<ArrowUpRight size={11}/></button>}</footer>

    {notice&&<div className={`toast ${notice.error?'error':''}`} role="status"><span>{notice.error?<Activity size={16}/>:<CheckCircle2 size={16}/>}</span>{notice.text}<button onClick={()=>setNotice(null)} aria-label="Dismiss notification"><X size={15}/></button></div>}
    {!liveRequested&&modal==='save'&&<Modal title="Save this review view" eyebrow="PICK UP WHERE YOU LEFT OFF" onClose={closeModal}><div className="modal-body"><label className="field-label">View name<input data-autofocus maxLength={160} value={viewName} onChange={e=>setViewName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&saveView()}/></label><p className="muted">Includes the document, comparison layout, exact source configuration, camera, selected and hidden parts, opacity, explosion, and section plane.</p><div className="save-context">{workspaceView==='documents'?<FileText size={18}/>:workspaceView==='together'?<Columns2 size={18}/>:<Box size={18}/>}<div><strong>{snapshot.rootItemNumber} · Rev {revisionLabel}</strong><span>{workspaceView==='documents'?'Document review':workspaceView==='together'?'Document & model':mode==='single'?'Model review':mode==='overlay'?'Revision overlay':'3D comparison'}{file?` · ${file.kind.toUpperCase()} · Rev ${file.revision}`:''}</span></div></div><button className="button primary full" disabled={!viewName.trim()} onClick={saveView}><Save size={16}/>Save view</button></div></Modal>}
    {!liveRequested&&modal==='views'&&<Modal title="Saved review views" eyebrow={`${review.views.length} VIEWS IN THIS WORKSPACE`} onClose={closeModal}><div className="modal-body">{review.views.length?review.views.slice().reverse().map(view=><div className="saved-view" key={view.id}><button onClick={()=>restoreView(view)}><span className="saved-view-icon">{view.state.workspaceView==='documents'?<FileText size={18}/>:view.state.workspaceView==='together'?<Columns2 size={18}/>:<Box size={18}/>}</span><div><strong>{view.name}</strong><span>Rev {view.source.revision} · {shortDate(view.createdAt)}</span></div><ChevronRight size={16}/></button><IconButton label={`Delete saved view ${view.name}`} onClick={()=>persist({...review,views:review.views.filter(v=>v.id!==view.id)})}><Trash2 size={15}/></IconButton></div>):<div className="empty-state"><BookOpen size={32}/><h3>Keep a useful viewpoint</h3><p>Arrange the model and document, then save the view to return to the same review context.</p><button className="button primary" onClick={()=>{setViewName('Assembly review');setModal('save');}}>Save current view</button></div>}</div></Modal>}
    {modal==='models'&&<Modal title="Add models from the BOM" eyebrow="SAME ASSEMBLY · EXACT RESOLVED REVISIONS" onClose={closeModal}><div className="modal-body"><p className="muted">Load or unload component occurrences without changing the BOM. Hidden models stay loaded and can be shown again.</p><div className="model-picker">{snapshot.occurrences.map(o=><label key={o.id}><input type="checkbox" disabled={o.modelState!=='loaded'} checked={loadedIds.includes(o.id)} onChange={e=>{setLoadedIds(l=>e.target.checked?[...l,o.id]:l.filter(i=>i!==o.id));setSelectedIds(s=>s.filter(i=>i!==o.id));}}/><span className="part-swatch" style={{background:currentPart(o)?.color}}/><div><strong>{o.itemNumber}<span>Rev {o.partRevision}</span></strong><p>{o.name}{o.partId==='fastener'?` · ${o.id.split('-').at(-1)}`:''}</p></div><span className={`model-state ${loadedIds.includes(o.id)?'loaded':''}`}>{o.modelState!=='loaded'?modelAvailability(o):loadedIds.includes(o.id)?'Loaded':'Not loaded'}</span></label>)}</div><div className="modal-action-row"><button className="button secondary" onClick={()=>setLoadedIds(availableModelIds(snapshot))}>Load all components</button><button className="button primary" onClick={closeModal}>Done</button></div><p className="tiny muted">Occurrences use explicit transforms from the assembly manifest. Loading a part preserves its position and orientation.</p></div></Modal>}
    {modal==='table'&&<Modal title="Bill of materials" eyebrow={`${snapshot.rootItemNumber} · REV ${revisionLabel} · ${schema.name}`} wide onClose={closeModal}><div className="table-config"><SlidersHorizontal size={15}/><strong>Columns</strong>{schema.attributes.map(def=><label key={def.id}><input type="checkbox" checked={columns.includes(def.id)} onChange={e=>setColumns(c=>e.target.checked?[...c,def.id]:c.filter(id=>id!==def.id))}/>{def.label}<span>{def.scope}</span></label>)}</div><div className="bom-table-scroll"><table className="bom-table"><thead><tr><th>Item number</th><th>Description / occurrence</th><th>Rev</th><th>Qty</th>{activeAttributes.map(d=><th key={d.id}>{d.label}{d.unit?` (${d.unit})`:''}</th>)}</tr></thead><tbody>{snapshot.occurrences.map(o=><tr className={selectedIds.includes(o.id)?'selected':''} key={o.id} onClick={()=>select([o.id])}><td><button className="table-link" onClick={()=>{select([o.id]);setModal(null);}}>{o.itemNumber}</button></td><td>{o.name}<small>{o.id}</small></td><td>{o.partRevision}</td><td>{o.quantity}</td>{activeAttributes.map(def=><td key={def.id}>{attributeValue(o,def)}</td>)}</tr>)}</tbody></table></div><div className="modal-footer-note">Column definitions, types, units, and scope are supplied by the workspace schema.{!liveRequested&&' Switch the preview workspace in Settings to try a different configuration.'}</div></Modal>}
    {modal==='settings'&&<Modal title="Workspace settings" eyebrow={liveRequested?'ARENA CONNECTION':'PREVIEW & INTEGRATION'} onClose={closeModal}>
      <div className="modal-body settings-body">
        {liveRequested&&liveWorkspace?<div className="arena-session-card">
          <span className="arena-live-badge"><span/>Arena MCP · Read only</span>
          <dl><div><dt>Signed in as</dt><dd>{liveUser}</dd></div><div><dt>Workspace</dt><dd>{schema.name}</dd></div><div><dt>Access</dt><dd>Your Arena permissions</dd></div></dl>
          <p>Every source request is checked for your authenticated user and workspace. An expired or changed session clears the open files.</p>
          {authLoading?<p role="status">Checking Arena sign-in…</p>:arenaAuth?.connected&&arenaAuth.logoutPath?<button className="button secondary" disabled={authBusy} onClick={()=>{void disconnectArenaSession();}}>Disconnect Arena</button>:arenaAuth?.configured&&arenaAuth.loginPath?<button className="button primary" disabled={authBusy} onClick={connectArenaSession}>Connect to Arena</button>:<p>{arenaAuth?.message??'Sign-in controls are unavailable for this connection.'}</p>}
          {authError&&<p role="status">{authError} <button className="text-button" disabled={authLoading||authBusy} onClick={()=>setAuthRefresh(value=>value+1)}>Check sign-in again</button></p>}
        </div>:<>
          <div className="mode-card"><span className="preview-badge"><span/>Preview mode</span><p>Synthetic BOMs, real generated STEP files, and sample specifications. No requests are made to Arena.</p></div>
          <label className="field-label">Preview workspace schema<select aria-label="Preview workspace schema" value={preset} onChange={e=>{if(draft.trim()||Object.values(replyDrafts).some(value=>value.trim())){tell('Post or clear your note and reply drafts before switching workspaces.',true);return;}importControllerRef.current.cancel();setLaunchSearch('');history.replaceState({},'',location.pathname);setPreset(e.target.value as WorkspacePreset);setModal(null);}}><option value="precision">Precision Engineering</option><option value="medical">Medical Device Lab</option></select></label>
          <p className="tiny muted">Changing workspaces loads different attribute definitions. Each workspace has its own local comments and views.</p>
        </>}
        <ViewerPreferencesSettings/>
        <div className="settings-section"><h3><ShieldCheck size={16}/>Arena MCP</h3>
          {liveRequested?<><div className="connection-status arena-connected"><span/>Connected with your user permissions</div><p>Items, BOMs, attachments, and available supplier data come through the configured Arena MCP service. The viewer uses exact source revisions and the workspace’s supplied attribute definitions.</p><p className="tiny muted">This connection allows source reads. No Arena write tools are exposed by this viewer.</p></>:<><div className="connection-status"><span/>Prepared · Awaiting a configured connection</div><p>The viewer is prepared to use Arena’s MCP through its server connection. An administrator must configure the MCP endpoint, verified tool mappings, and user sign-in before opening live sources.</p><p className="tiny muted">Preview does not contact Arena or test a live session. Open an Arena item through the configured Chrome launcher when the connection is ready.</p></>}
        </div>
        {liveRequested&&liveWorkspace&&<div className="settings-section"><h3><GitCompareArrows size={16}/>Revision comparison</h3><p>Current source: revision {currentRevisionLabel}. Choose an explicit baseline to compare the resolved BOM, models, and document editions.</p><label className="field-label">Baseline revision<select aria-label="Arena baseline revision" value={new URLSearchParams(launchSearch).get('baselineRevision')??''} onChange={event=>chooseArenaBaseline(event.target.value)}><option value="">No baseline — single revision</option>{liveRevisions.filter(value=>value.id!==currentRevisionLabel).map(value=><option key={value.id} value={value.id}>{value.label}{value.lifecycle?` · ${value.lifecycle}`:''}</option>)}</select></label><p className="tiny muted">Changing the baseline reloads the workspace and clears temporary viewing state.</p></div>}
        {!liveRequested&&<div className="settings-section"><h3><BookOpen size={16}/>Saved review views</h3><p>Return to a saved model, document, and comparison context.</p><button className="button secondary" onClick={()=>setModal('views')}>Open saved views<span className="count">{review.views.length}</span></button></div>}
        <div className="settings-section"><h3><ClipboardList size={16}/>Review data</h3>{liveRequested?<p>{liveReviewNotice} Preview notes are kept separate.</p>:<>
          {storageIssue&&<div className="info-inline" role="status"><p>{storageIssue}</p><p>Export any session notes before importing a backup. Import &amp; replace validates the backup before replacing saved data.</p>{recoveryRef.current?.token&&<button className="text-button" onClick={exportOriginalReview}>Download original stored data</button>}</div>}
          <p>Preview notes are local to this browser. Export a JSON review to move your test data. Import replaces this workspace’s local comments and views.</p><div className="button-row"><button className="button secondary" onClick={exportReview}><ArrowDownToLine size={14}/>Export review JSON</button><button className="button quiet" onClick={()=>importRef.current?.click()}>Import &amp; replace</button><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void importReview(f);e.target.value='';}}/></div>
        </>}</div>
        <div className="settings-section"><h3><FolderOpen size={16}/>Local tools &amp; handoff</h3><p>Check the bundled STEP, PDF, and Word engines in this browser and download a local test report.</p><a className="button secondary" href={runtimeCheckTarget(location.href)} target="_blank" rel="noopener"><ShieldCheck size={14}/>Local runtime checks<ArrowUpRight size={13}/></a>{!liveRequested&&<><p>Open your own STEP, PDF, or DOCX files to test local rendering and revision comparison. Files remain in this browser session.</p><button className="button secondary" onClick={()=>{setModal(null);setLocalFilesOpen(true);}}><FolderOpen size={14}/>Open local test files</button></>}{location.protocol!=='chrome-extension:'&&<><p>The repository includes the implementation plan, MCP connection, fixtures, extension, and automated tests.</p><div className="button-row"><a className="button secondary" href="/developer/review-studio-extension.zip" download><ArrowDownToLine size={14}/>Download Chrome extension</a><a className="button quiet" href="/developer/arena-review-source.zip" download>Download source</a></div></>}{liveRequested&&<div className="button-row"><button className="button quiet" onClick={openSampleWorkspace}>Open sample workspace</button></div>}</div>
      </div>
    </Modal>}
    {!liveRequested&&modal==='help'&&<Modal title="A review workspace you can explore" eyebrow="PROTOTYPE GUIDE" wide onClose={closeModal}><div className="guide-grid"><div><span className="guide-number">01</span><h3>Explore the assembly</h3><p>Click a BOM item or a model component. Hide or isolate it, change opacity, explode the assembly, and inspect a section. Repeated fasteners have individual occurrences.</p><button className="text-button" onClick={()=>{setModal(null);setWorkspace('model');setExplode(0.5);}}>Try the exploded view<ArrowUpRight size={13}/></button></div><div><span className="guide-number">02</span><h3>Review what changed</h3><p>Switch to Overlay or Side by side. Revision B widens the base, changes the cover, moves the motor, removes a fastener, and adds a sensor. Click a change to locate it.</p><button className="text-button" onClick={()=>{setModal(null);setWorkspace('model');setNavigationOpen(true);setComparison('overlay');setTab('changes');}}>Compare revisions<ArrowUpRight size={13}/></button></div><div><span className="guide-number">03</span><h3>Review documents as equals</h3><p>Open a PDF or Word document in the full reader. Compare revisions with automatic text redlines, then choose Together to bring the model alongside it.</p><button className="text-button" onClick={()=>{setModal(null);setPanelOpen(false);openDocCompare();}}>Compare the specifications<ArrowUpRight size={13}/></button></div><div><span className="guide-number">04</span><h3>Capture a comment</h3><p>The sensor’s model origin is X = 65 mm; Rev B’s specification asks for 61 ± 0.5 mm. Review the sample note, add a model pin or document markup, and save the view.</p><button className="text-button" onClick={()=>{setModal(null);setPanel('discussion');setPanelOpen(true);const c=review.comments.find(c=>c.id==='demo-sensor');if(c)openComment(c);}}>Open the sample comment<ArrowUpRight size={13}/></button></div></div><div className="guide-notes"><strong>Prototype limits</strong><p>Point measurements use display meshes. Bounds use CAD-derived part envelopes. DOCX is reflowed for the browser; legacy .doc viewing is not implemented. Comments and views are local, and formal Arena approval is separate. The app avoids automatic file downloads; rendered data is still present in the browser.</p></div></Modal>}
  </div>;
}
