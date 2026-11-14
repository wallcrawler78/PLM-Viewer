import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Eye, Layers2, ListChecks, LoaderCircle, MessageSquarePlus, ScanSearch, Square, X } from 'lucide-react';
import { comparePdfPagePair } from '../pdf-page-comparison';
import type { RasterPage, VisualDiffResult } from '../visual-diff/types';
import { PdfVisualError, visualRegionPoint } from '../pdf-visual-raster';
import type { PdfRasterAvailability } from '../pdf-visual-raster';
import type { DocumentFile, DocumentSourcePresentation, DocumentSuggestionAnchor } from './Documents';
import PdfVisualOverview from './PdfVisualOverview';
import './visual-document-comparison.css';

interface Props {
  before: DocumentFile;
  after: DocumentFile;
  beforeRaster: PdfRasterAvailability;
  afterRaster: PdfRasterAvailability;
  active: boolean;
  sourcePresentation: DocumentSourcePresentation;
  annotationsEnabled: boolean;
  onSuggest(message: string, file: DocumentFile, anchor: DocumentSuggestionAnchor): void;
  onShowSources(beforePage: number, afterPage: number): void;
}
type CompletedComparison = { key: string; before: RasterPage | null; after: RasterPage | null; result: VisualDiffResult; downsampled: boolean };

function PageLayer({ page, width, height, opacity = 1 }: { page: RasterPage | null; width: number; height: number; opacity?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.width = width; element.height = height;
    const context = element.getContext('2d');
    if (context) {
      context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
      if (page) {
        const image = context.createImageData(page.width, page.height); image.data.set(page.data);
        context.putImageData(image, 0, 0);
      }
    }
    return () => { element.width = 0; element.height = 0; };
  }, [page, width, height]);
  return <canvas ref={canvas} aria-hidden="true" className="visual-page-layer" style={{ opacity }}/>;
}

function DifferenceLayer({ result, show }: { result: VisualDiffResult; show: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.width = result.width; element.height = result.height;
    const context = element.getContext('2d');
    if (context) { const image = context.createImageData(result.width, result.height); image.data.set(result.mask); context.putImageData(image, 0, 0); }
    return () => { element.width = 0; element.height = 0; };
  }, [result]);
  return <canvas ref={canvas} aria-hidden="true" className="visual-page-layer visual-difference-layer" style={{ opacity: show ? 1 : 0 }}/>;
}

function SourcePageControl({ file, label, availability, page, onPage, blankDisabled, presentation }: {
  file: DocumentFile; label: string; availability: PdfRasterAvailability; page: number; onPage(value: number): void; blankDisabled: boolean; presentation: DocumentSourcePresentation;
}) {
  const count = availability.status === 'ready' ? availability.source.pages : 0;
  const [draft, setDraft] = useState(page ? String(page) : '');
  useEffect(() => { setDraft(page ? String(page) : ''); }, [page]);
  const commit = () => {
    const next = Number(draft);
    if (Number.isInteger(next) && next >= 1 && next <= count) onPage(next);
    else setDraft(page ? String(page) : '');
  };
  return <div className="visual-source-control">
    <div><span>{label} <b>{presentation === 'local' ? file.revision : `Rev ${file.revision}`}</b></span><strong title={file.name}>{file.name}</strong></div>
    <label className="visual-page-input">Page<input type="number" min={1} max={count || 1} value={draft} disabled={!count || page === 0} aria-label={`${label} visual page`} title="Enter a page number, then press Enter or leave the field to compare it" onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { commit(); event.currentTarget.blur(); } }}/><span>of {count || '—'}</span></label>
    <label className="visual-blank-toggle" title="Use an explicitly absent page to review an addition or removal"><input type="checkbox" checked={page === 0} disabled={!count || blankDisabled && page !== 0} onChange={event => onPage(event.target.checked ? 0 : 1)}/>No page</label>
  </div>;
}

export default function VisualDocumentComparison({ before, after, beforeRaster, afterRaster, active, sourcePresentation, annotationsEnabled, onSuggest, onShowSources }: Props) {
  const [beforePage, setBeforePage] = useState(1), [afterPage, setAfterPage] = useState(1);
  const [tolerance, setTolerance] = useState(18);
  const [opacity, setOpacity] = useState(0.6);
  const [showHighlights, setShowHighlights] = useState(true);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewVisited, setOverviewVisited] = useState(false);
  const [regionIndex, setRegionIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false), [cancelled, setCancelled] = useState(false), [error, setError] = useState('');
  const [completed, setCompleted] = useState<CompletedComparison | null>(null);
  const completedRef = useRef<CompletedComparison | null>(null);
  const controller = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const beforeSource = beforeRaster.status === 'ready' ? beforeRaster.source : null;
  const afterSource = afterRaster.status === 'ready' ? afterRaster.source : null;
  const requestKey = JSON.stringify([beforeSource?.sourceKey, afterSource?.sourceKey, beforePage, afterPage, tolerance, retry]);
  const ready = beforeSource && afterSource;
  const failed = beforeRaster.status === 'unavailable' ? `Baseline: ${beforeRaster.message}` : afterRaster.status === 'unavailable' ? `Open file: ${afterRaster.message}` : '';
  const visible = ready && completed?.key === requestKey ? completed : null;
  const result = visible?.result;
  const regions = result?.regions ?? [];
  const selectedIndex = Math.min(regionIndex, Math.max(0, regions.length - 1));
  const region = regions[selectedIndex];

  useEffect(() => {
    if (!active || overviewOpen || !beforeSource || !afterSource) return;
    if (completedRef.current?.key === requestKey) { setBusy(false); return; }
    const current = new AbortController(); controller.current = current;
    completedRef.current = null; setCompleted(null);
    setBusy(true); setCancelled(false); setError(''); setRegionIndex(0);
    void (async () => {
      try {
        const comparison = await comparePdfPagePair(beforeSource, afterSource, { beforePage, afterPage }, tolerance, { signal: current.signal });
        current.signal.throwIfAborted();
        const value = { key: requestKey, ...comparison };
        completedRef.current = value; setCompleted(value);
      } catch (failure) {
        if (!current.signal.aborted) {
          setError(failure instanceof PdfVisualError ? failure.message : 'These pages could not be compared. Try another page pair or reopen the source documents.');
          setBusy(false);
          // A failure on one side must also stop the other page's render.
          current.abort();
        }
      } finally { if (!current.signal.aborted) setBusy(false); }
    })();
    return () => { current.abort(); if (controller.current === current) controller.current = null; };
  }, [active, overviewOpen, beforeSource, afterSource, beforePage, afterPage, tolerance, requestKey]);

  useEffect(() => {
    if (!active || overviewOpen || !region || !result || !stage.current || !scroller.current) return;
    const viewport = scroller.current, sheet = stage.current;
    const ratio = sheet.clientWidth / result.width;
    const y = sheet.offsetTop + (region.y + region.height / 2) * ratio;
    const x = sheet.offsetLeft + (region.x + region.width / 2) * ratio;
    if (y < viewport.scrollTop + 30 || y > viewport.scrollTop + viewport.clientHeight - 30) viewport.scrollTo({ top: Math.max(0, y - viewport.clientHeight / 2), left: Math.max(0, x - viewport.clientWidth / 2), behavior: 'auto' });
  }, [active, overviewOpen, region, result]);

  function chooseRegion(next: number) { if (regions.length) setRegionIndex((next + regions.length) % regions.length); }
  function draftNote() {
    if (!annotationsEnabled || !visible || !region) return;
    const preferred = region.kind === 'removed' ? 'before' : 'after';
    for (const side of [preferred, preferred === 'before' ? 'after' : 'before'] as const) {
      const raster = side === 'before' ? visible.before : visible.after;
      if (!raster) continue;
      const point = visualRegionPoint(region, raster);
      if (!point) continue;
      const file = side === 'before' ? before : after;
      const anchor: DocumentSuggestionAnchor = { fileId: file.id, itemId: file.itemId, revision: file.revision, edition: file.edition, sourceHash: file.sourceHash, page: raster.page, kind: 'pdf', ...point };
      onSuggest(`Review visual difference region ${selectedIndex + 1} on page ${raster.page}. The selected page pair contains changed pixels in this region; confirm the intended document change and its impact.`, file, anchor);
      return;
    }
  }

  const status = failed ? 'Source unavailable' : error ? 'Comparison unavailable' : !ready ? 'Opening source pages…' : busy ? 'Comparing selected pages…' : cancelled ? 'Comparison stopped' : result ? `${result.regionCount} ${result.regionCount === 1 ? 'region' : 'regions'}${result.truncated ? ' · partial list' : ''}` : 'Select pages to compare';
  return <section className="visual-document-review" aria-label="Visual PDF page comparison" style={{ display: active ? undefined : 'none' }}>
    <div className="visual-source-pair" style={{ display: overviewOpen ? 'none' : undefined }}>
      <SourcePageControl file={before} label="Baseline" availability={beforeRaster} page={beforePage} onPage={setBeforePage} blankDisabled={afterPage === 0} presentation={sourcePresentation}/>
      <SourcePageControl file={after} label="Open file" availability={afterRaster} page={afterPage} onPage={setAfterPage} blankDisabled={beforePage === 0} presentation={sourcePresentation}/>
    </div>
    <div className="visual-comparison-controls">
      <label className="visual-sensitivity">Sensitivity<select aria-label="Visual comparison sensitivity" value={tolerance} onChange={event => setTolerance(Number(event.target.value))}><option value={6}>High</option><option value={18}>Standard</option><option value={36}>Low</option></select></label>
      <button className={`visual-overview-toggle ${overviewOpen ? 'active' : ''}`} aria-pressed={overviewOpen} onClick={() => { setOverviewVisited(true); setOverviewOpen(value => !value); }}><ListChecks size={14}/><span>{overviewOpen ? 'Page overlay' : 'Page overview'}</span></button>
      {!overviewOpen && <>
      <label className="visual-opacity"><Layers2 size={14}/>Blend<input type="range" min={0} max={1} step={0.05} value={opacity} aria-label="Open file overlay opacity" onChange={event => setOpacity(Number(event.target.value))}/><span>{Math.round(opacity * 100)}%</span></label>
      <button className={showHighlights ? 'active' : ''} onClick={() => setShowHighlights(value => !value)} aria-pressed={showHighlights} aria-label="Show visual change highlights"><ScanSearch size={14}/><span>Highlights</span></button>
      <div className="visual-region-navigation"><span aria-live="polite">{status}</span>{busy ? <button className="icon-button small" aria-label="Stop visual comparison" onClick={() => { controller.current?.abort(); setBusy(false); setCancelled(true); }}><Square size={13}/></button> : (cancelled || error) && <button className="text-button" onClick={() => setRetry(value => value + 1)}>Compare pages</button>}<button className="icon-button small" aria-label="Previous visual region" disabled={!regions.length || busy} onClick={() => chooseRegion(selectedIndex - 1)}><ChevronLeft size={15}/></button><small>{regions.length ? `${selectedIndex + 1} / ${regions.length}` : '—'}</small><button className="icon-button small" aria-label="Next visual region" disabled={!regions.length || busy} onClick={() => chooseRegion(selectedIndex + 1)}><ChevronRight size={15}/></button></div>
      </>}
      {overviewOpen && <span className="visual-overview-hint">Same-number page pairs · Local scan</span>}
    </div>
    {overviewVisited && beforeSource && afterSource && <PdfVisualOverview key={JSON.stringify([beforeSource.sourceKey, beforeSource.pages, afterSource.sourceKey, afterSource.pages, tolerance])} before={beforeSource} after={afterSource} tolerance={tolerance} active={active && overviewOpen} onStart={() => { controller.current?.abort(); completedRef.current = null; setCompleted(null); setBusy(false); }} onOpenPair={(left, right) => { setBeforePage(left); setAfterPage(right); setOverviewOpen(false); }}/>}
    {overviewOpen && !ready && <div className="visual-comparison-state" role={failed ? 'alert' : 'status'}>{failed ? <AlertCircle size={27}/> : <LoaderCircle className="spin" size={27}/>}<h3>{failed ? 'Source unavailable' : 'Opening the PDF sources'}</h3><p>{failed || 'Both source PDFs must open before their pages can be scanned.'}</p></div>}
    <div className="visual-comparison-scroll" style={{ display: overviewOpen ? 'none' : undefined }} ref={scroller} tabIndex={0} aria-label="Visual difference overlay" aria-busy={busy || !ready && !failed}>
      {(failed || error) ? <div className="visual-comparison-state" role="alert"><AlertCircle size={27}/><h3>Visual comparison unavailable</h3><p>{failed || error}</p><button className="button secondary" onClick={() => onShowSources(beforePage, afterPage)}>Review source pages</button></div> : !visible ? <div className="visual-comparison-state" role="status">{cancelled ? <><X size={27}/><h3>Comparison stopped</h3><p>Your source pages remain open. Choose Compare pages when you are ready.</p></> : <><LoaderCircle className="spin" size={27}/><h3>{ready ? 'Comparing these pages' : 'Opening the PDF sources'}</h3><p>Rendering and pixel comparison run locally in this browser.</p></>}</div> : <>
        <div className="visual-comparison-summary"><div><span><strong>{(visible.result.changedFraction * 100).toFixed(2)}%</strong> changed pixels on this page pair</span><small>Baseline {visible.before ? `page ${visible.before.page}` : 'no page'} → Open file {visible.after ? `page ${visible.after.page}` : 'no page'}</small></div><span>{Math.round(visible.result.pixelsPerPoint * 72)} dpi · Same physical scale</span></div>
        {visible.result.pageSizeChanged && <div className="visual-page-notice" role="status"><AlertCircle size={14}/>Page sizes differ. Both pages keep their original scale; empty margins may have no changed pixels.</div>}
        <div className="visual-comparison-stage" ref={stage} style={{ width: visible.result.width, aspectRatio: `${visible.result.width} / ${visible.result.height}` }}>
          <PageLayer page={visible.before} width={visible.result.width} height={visible.result.height}/>
          <PageLayer page={visible.after} width={visible.result.width} height={visible.result.height} opacity={opacity}/>
          <DifferenceLayer result={visible.result} show={showHighlights}/>
          {regions.map((entry, index) => <button className={`visual-region ${index === selectedIndex ? 'selected' : ''}`} key={entry.id} tabIndex={index === selectedIndex ? 0 : -1} aria-label={`Visual difference region ${index + 1}`} aria-pressed={index === selectedIndex} title={`Region ${index + 1}: ${entry.pixels.toLocaleString()} changed pixels`} onClick={() => setRegionIndex(index)} style={{ left: `${entry.x / visible.result.width * 100}%`, top: `${entry.y / visible.result.height * 100}%`, width: `${entry.width / visible.result.width * 100}%`, height: `${entry.height / visible.result.height * 100}%` }}><span>{index + 1}</span></button>)}
        </div>
        {visible.result.changedPixels === 0 && <p className="visual-no-changes">No pixel differences at this sensitivity and resolution.{visible.result.pageSizeChanged ? ' The page sizes are different.' : ''}</p>}
      </>}
    </div>
    {!overviewOpen && <><div className="visual-comparison-detail"><div><Eye size={14}/><span>{region ? `Region ${selectedIndex + 1} · ${region.pixels.toLocaleString()} changed pixels` : 'Compare drawings, images and page layout'}</span></div><button className="text-button" onClick={() => onShowSources(beforePage, afterPage)}>Source pages</button><button className="text-button" disabled={!annotationsEnabled || !region || busy} title={annotationsEnabled ? 'Create an editable note on this exact source page' : 'Review notes are unavailable in this session.'} onClick={draftNote}><MessageSquarePlus size={14}/>Draft review note</button></div>
    <footer className="visual-comparison-footer"><div><span className="removed"/>Removed marks <span className="added"/>Added marks <span className="modified"/>Changed pixels</div><p>Selected pages only. Pages align at the top-left without automatic registration. Scanned images are compared visually; no OCR or AI is used.{visible?.downsampled ? ' Resolution was reduced to stay within the page pixel limit.' : ''}{result?.truncated ? ` The ${regions.length} largest regions are listed; the overlay includes all detected changed pixels.` : ''}</p></footer></>}
  </section>;
}
