import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Box, Columns2, Eye, EyeOff, FileText, FolderOpen, LoaderCircle, Maximize2, Ruler, ScanLine, Settings2, X } from 'lucide-react';
import { DocumentWorkspace } from './DocumentWorkspace';
import { ModelLoadBoundary } from './ModelLoadBoundary';
import type { MeasurementResult, SceneBounds, ScenePart, SectionState, ViewCommand } from './model/types';
import { LOCAL_FILE_COUNT, LOCAL_SESSION_LIMIT, openLocalFile, releaseLocalFiles } from '../local-files';
import type { LocalReviewFile } from '../local-files';
import { useViewerPreferences } from '../ViewerPreferences';
import { ViewerPreferencesDialog } from './ViewerPreferencesSettings';
import './local-files.css';

const ModelViewport = lazy(() => import('./ModelViewport'));
const LOCAL_SECTION: SectionState = { enabled: false, axis: 'z', offset: 0 };
const toPart = (file: LocalReviewFile): ScenePart => ({ id: 'local-model', itemId: 'local-model', itemNumber: file.name, name: file.name, revision: file.revision, stepUrl: file.url, sourceHash: file.sourceHash, color: '#6f91aa', position: [0, 0, 0], rotation: [0, 0, 0] });

export default function LocalFileWorkspace({ onClose }: { onClose: () => void }) {
  const { preferences } = useViewerPreferences();
  const [files, setFiles] = useState<LocalReviewFile[]>([]);
  const filesRef = useRef<LocalReviewFile[]>([]);
  const controller = useRef(new AbortController());
  const input = useRef<HTMLInputElement>(null);
  const ordinal = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'documents' | 'model' | 'together'>('documents');
  const [documentId, setDocumentId] = useState('');
  const [modelId, setModelId] = useState('');
  const [baselineId, setBaselineId] = useState('');
  const [docCompare, setDocCompare] = useState(false);
  const [modelMode, setModelMode] = useState<'single' | 'overlay' | 'split'>('single');
  const [measure, setMeasure] = useState(false);
  const [boundsVisible, setBoundsVisible] = useState(false);
  const [bounds, setBounds] = useState<SceneBounds | null>(null);
  const [measurement, setMeasurement] = useState<MeasurementResult | null>(null);
  const [fit, setFit] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [selected, setSelected] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [modelOpened, setModelOpened] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const closePreferences = useCallback(() => setPreferencesOpen(false), []);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    return () => { active.abort(); releaseLocalFiles(filesRef.current); filesRef.current = []; };
  }, []);

  function commit(next: LocalReviewFile[]) { filesRef.current = next; setFiles(next); }
  async function add(selected: File[]) {
    if (!selected.length || busy) return;
    const existing = filesRef.current;
    if (existing.length + selected.length > LOCAL_FILE_COUNT || existing.reduce((total, file) => total + file.size, 0) + selected.reduce((total, file) => total + file.size, 0) > LOCAL_SESSION_LIMIT) {
      setError('This local test session supports up to eight files and 128 MiB of source data. Remove files before adding more.'); return;
    }
    const signal = controller.current.signal;
    setBusy(true); setError('');
    const added: LocalReviewFile[] = [];
    try {
      for (const file of selected) {
        const opened = await openLocalFile(file, ++ordinal.current, signal);
        if ([...existing, ...added].some(value => value.sourceHash === opened.sourceHash && value.kind === opened.kind)) { releaseLocalFiles([opened]); continue; }
        added.push(opened);
      }
      signal.throwIfAborted();
      commit([...existing, ...added]);
      const document = added.find(file => file.kind !== 'step'), model = added.find(file => file.kind === 'step');
      if (document) setDocumentId(document.id);
      if (model) setModelId(model.id);
      if (document && model) setView('together'); else if (model) setView('model'); else if (document) setView('documents');
      setMeasurement(null); setBounds(null); setFit(value => value + 1);
    } catch (error) {
      releaseLocalFiles(added);
      if (!signal.aborted) setError(error instanceof Error ? error.message : 'These files could not be opened.');
    } finally { if (!signal.aborted) setBusy(false); }
  }
  function remove(file: LocalReviewFile) {
    commit(filesRef.current.filter(value => value.id !== file.id)); releaseLocalFiles([file]);
    if (file.id === documentId) setDocumentId('');
    if (file.id === modelId) { setModelId(''); setBounds(null); setMeasurement(null); }
    if (file.id === baselineId) { setBaselineId(''); setModelMode('single'); }
  }
  const documents = files.filter(file => file.kind !== 'step'), models = files.filter(file => file.kind === 'step');
  const document = documents.find(file => file.id === documentId) ?? documents[0] ?? null;
  const model = models.find(file => file.id === modelId) ?? models[0] ?? null;
  const baseline = models.find(file => file.id === baselineId && file.id !== model?.id) ?? null;
  const parts = useMemo(() => model ? [toPart(model)] : [], [model]);
  const comparisonParts = useMemo(() => baseline && modelMode !== 'single' ? [toPart(baseline)] : [], [baseline, modelMode]);
  const selectedIds = useMemo(() => selected ? ['local-model'] : [], [selected]);
  const hiddenIds = useMemo(() => hidden ? ['local-model'] : [], [hidden]);
  const opacityById = useMemo(() => ({ 'local-model': opacity }), [opacity]);
  const viewCommand = useMemo<ViewCommand>(() => ({ type: 'fit', nonce: fit }), [fit]);
  useEffect(() => { if (view !== 'documents') setModelOpened(true); }, [view]);
  useEffect(() => { setBounds(null); setMeasurement(null); setSelected(false); setHidden(false); setOpacity(1); }, [model?.id, baseline?.id]);
  useEffect(() => { setMeasurement(null); }, [modelMode]);
  useEffect(() => {
    if (view === 'documents') return;
    let resizeFrame = 0;
    const layoutFrame = requestAnimationFrame(() => { resizeFrame = requestAnimationFrame(() => setFit(value => value + 1)); });
    return () => { cancelAnimationFrame(layoutFrame); cancelAnimationFrame(resizeFrame); };
  }, [view]);
  const modelSourceKey = `${model?.id ?? ''}:${baseline?.id ?? ''}`;

  return <main className="local-review">
    <header className="local-review-header">
      <button className="button quiet" onClick={onClose}><ArrowLeft size={17}/>Back to Preview</button>
      <div><h1>Local file review</h1><p>Files stay in this browser session. Nothing is uploaded.</p></div>
      <button className="icon-button" aria-label="Viewer preferences" title="Viewer preferences" onClick={() => setPreferencesOpen(true)}><Settings2 size={18}/></button>
      <button className="button primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? <LoaderCircle size={16} className="spin"/> : <FolderOpen size={16}/>}Open files</button>
      <input ref={input} type="file" accept=".step,.stp,.pdf,.docx" multiple hidden onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ''; void add(selected); }}/>
    </header>
    {error && <div className="local-file-error" role="alert">{error}<button className="icon-button" aria-label="Dismiss file error" onClick={() => setError('')}><X size={16}/></button></div>}
    <div className="local-review-body">
      <aside className="local-review-files" aria-label="Local test files">
        <div className="local-files-heading"><strong>Files</strong><span>{files.length}/{LOCAL_FILE_COUNT}</span></div>
        {files.map(file => <div key={file.id} className={`local-file-row ${file.id === model?.id && view !== 'documents' || file.id === document?.id && view !== 'model' ? 'active' : ''}`}>
          <button onClick={() => { if (file.kind === 'step') { setModelId(file.id); setMeasurement(null); setBounds(null); if (view !== 'together') setView('model'); } else { setDocumentId(file.id); if (view !== 'together') setView('documents'); } }} title={file.name}>{file.kind === 'step' ? <Box size={16}/> : <FileText size={16}/>}<span>{file.name}<small>{file.kind.toUpperCase()} · {(file.size / 1024).toFixed(0)} KiB</small></span></button>
          <button className="icon-button" disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => remove(file)}><X size={14}/></button>
        </div>)}
        <p className="local-file-help">STEP, PDF and DOCX<br/>32 MiB per file<br/>Choose revision baselines explicitly.</p>
        <p className="local-file-help">Local files have no verified Arena item or BOM association. Notes are available in the sample workspace.</p>
      </aside>
      <section className="local-review-main">
        <nav className="local-review-tabs" aria-label="Local content view">
          <button className={view === 'documents' ? 'active' : ''} aria-pressed={view === 'documents'} onClick={() => setView('documents')}><FileText size={16}/>Documents</button>
          <button className={view === 'model' ? 'active' : ''} aria-pressed={view === 'model'} onClick={() => setView('model')}><Box size={16}/>3D</button>
          <button className={view === 'together' ? 'active' : ''} aria-pressed={view === 'together'} onClick={() => { setDocCompare(false); setView('together'); }}><Columns2 size={16}/>Together</button>
        </nav>
        {!files.length ? <div className="local-review-empty"><FolderOpen size={42}/><h2>Bring a source into the viewer</h2><p>Open a STEP model, a PDF, or a Word document. Add another revision to compare, or open a model and specification together.</p><button className="button primary" disabled={busy} onClick={() => input.current?.click()}>Choose files</button><span>Local processing · No desktop viewer · No AI service</span></div> : <div className={`local-review-panes ${view === 'together' ? 'together' : ''}`}>
          <div className="local-document-pane" style={{ display: view === 'model' ? 'none' : undefined }}><DocumentWorkspace file={document} files={documents} compare={docCompare} onCompareChange={value => { setDocCompare(value); if (value) setView('documents'); }} onAnchor={() => {}} onSuggest={() => {}} annotationsEnabled={false} sourcePresentation="local"/></div>
          {(view !== 'documents' || modelOpened) && <section className="local-model-pane" aria-label="Local model review" style={{ display: view === 'documents' ? 'none' : undefined }}>
            <div className="local-model-heading"><strong>{model?.name ?? 'Choose a STEP file'}</strong><span>Local STEP import</span></div>
            <div className="local-model-controls">
              <button className="button quiet" disabled={!model} onClick={() => setFit(value => value + 1)}><Maximize2 size={15}/>Fit</button>
              <button className={`button ${boundsVisible ? 'secondary' : 'quiet'}`} disabled={!model} aria-pressed={boundsVisible} onClick={() => setBoundsVisible(value => !value)}><ScanLine size={15}/>Bounds</button>
              <button className={`button ${measure ? 'secondary' : 'quiet'}`} disabled={!model} aria-pressed={measure} onClick={() => setMeasure(value => !value)}><Ruler size={15}/>Measure</button>
              <button className="button quiet" disabled={!model} aria-pressed={hidden} onClick={() => setHidden(value => !value)}>{hidden ? <EyeOff size={15}/> : <Eye size={15}/>}{hidden ? 'Show' : 'Hide'}</button>
              <label>Opacity<input aria-label="Local model opacity" type="range" min="0.1" max="1" step="0.05" value={opacity} onChange={event => setOpacity(Number(event.target.value))}/></label>
            </div>
            {models.length > 1 && <div className="local-model-comparison"><label>Baseline<select aria-label="Local model baseline" value={baseline?.id ?? ''} onChange={event => { setBaselineId(event.target.value); setModelMode(event.target.value ? 'overlay' : 'single'); }}><option value="">Choose a model…</option>{models.filter(file => file.id !== model?.id).map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select></label><select aria-label="Local model comparison layout" disabled={!baseline} value={baseline ? modelMode : 'single'} onChange={event => setModelMode(event.target.value as typeof modelMode)}><option value="single">Single</option><option value="overlay">Overlay</option><option value="split">Side by side</option></select></div>}
            <div className="local-model-stage"><ModelLoadBoundary key={modelSourceKey} onDocuments={() => setView('documents')} hasDrafts={false}><Suspense fallback={<div className="local-review-empty"><LoaderCircle className="spin" size={24}/>Opening local CAD tools…</div>}><ModelViewport renderQuality={preferences.renderQuality} sourcePresentation="local" parts={parts} comparisonParts={comparisonParts} mode={baseline ? modelMode : 'single'} currentRevision={model?.revision} baselineRevision={baseline?.revision} selectedIds={selectedIds} hiddenIds={hiddenIds} opacityById={opacityById} explode={0} section={LOCAL_SECTION} measurementMode={measure} onSelect={id => setSelected(Boolean(id))} onMeasure={setMeasurement} onBoundsChange={setBounds} showBoundingBox={boundsVisible} viewCommand={viewCommand}/></Suspense></ModelLoadBoundary></div>
            <footer className="local-model-footer">{bounds ? <span>Mesh envelope: {bounds.size.map(value => value.toFixed(2)).join(' × ')} mm</span> : <span>Source coordinates are preserved.</span>}{measurement && <span>Point distance: {measurement.distance.toFixed(2)} mm · approximate</span>}{baseline && <span>Comparison assumes a shared coordinate frame.</span>}</footer>
          </section>}
        </div>}
      </section>
    </div>
    {preferencesOpen && <ViewerPreferencesDialog onClose={closePreferences}/>}
  </main>;
}
