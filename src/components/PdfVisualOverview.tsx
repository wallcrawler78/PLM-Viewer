import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronRight, FileDiff, LoaderCircle, Play, RotateCcw, Square } from 'lucide-react';
import type { PdfRasterSource } from '../pdf-visual-raster';
import { PdfVisualError } from '../pdf-visual-raster';
import { PDF_OVERVIEW_LIMITS, pdfOverviewPair, scanPdfVisualOverview } from '../pdf-visual-overview';
import type { PdfOverviewOutcome, PdfOverviewPair, PdfVisualOverviewReport } from '../pdf-visual-overview';

interface Props {
  before: PdfRasterSource;
  after: PdfRasterSource;
  tolerance: number;
  active: boolean;
  onStart(): void;
  onOpenPair(beforePage: number, afterPage: number): void;
}

const OUTCOME_LABELS: Record<PdfOverviewOutcome, string> = {
  changed: 'Visual change', 'no-detected-change': 'No pixel change detected', 'extra-baseline': 'Extra baseline page', 'extra-open-file': 'Extra open-file page', unavailable: 'Unavailable',
};

function pairDetail(pair: PdfOverviewPair) {
  if (pair.outcome === 'unavailable') return 'Not compared. Open this pair to retry or inspect its sources.';
  const details = [`${(pair.changedFraction! * 100).toFixed(2)}% changed pixels`, `${Math.round(pair.dpi!)} dpi`];
  if (pair.pageSizeChanged) details.push('Page size differs');
  if (pair.downsampled) details.push('Reduced resolution');
  return details.join(' · ');
}

/** Session-only summaries. The parent remounts this on source/sensitivity change. */
export default function PdfVisualOverview({ before, after, tolerance, active, onStart, onOpenPair }: Props) {
  const [report, setReport] = useState<PdfVisualOverviewReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'changes' | 'unavailable'>('all');
  const controller = useRef<AbortController | null>(null);
  const totalPairs = Math.max(before.pages, after.pages);
  const scanLimit = Math.min(totalPairs, PDF_OVERVIEW_LIMITS.maxPairs);
  const pairs = report?.pairs ?? [];
  const unavailable = pairs.filter(pair => pair.outcome === 'unavailable').length;
  const unchanged = pairs.filter(pair => pair.outcome === 'no-detected-change').length;
  const changed = pairs.length - unavailable - unchanged;
  const compared = pairs.length - unavailable;
  const unscanned = totalPairs - pairs.length;
  const canResume = !!report && pairs.length < scanLimit;
  const selectedPairs = Array.from({ length: scanLimit }, (_, index) => ({ number: index + 1, pair: pairs[index] }));
  const visiblePairs = selectedPairs.filter(({ pair }) => filter === 'all' || (filter === 'unavailable' ? pair?.outcome === 'unavailable' : pair && pair.outcome !== 'unavailable' && pair.outcome !== 'no-detected-change'));

  useEffect(() => { if (!active) controller.current?.abort(); }, [active]);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  function start(resume: boolean) {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setRunning(true); setError('');
    if (!resume) { setReport(null); setFilter('all'); }
    onStart();
    void scanPdfVisualOverview(before, after, tolerance, {
      signal: current.signal, resume: resume ? report : null,
      onProgress: value => { if (controller.current === current && !current.signal.aborted) setReport(value); },
    }).then(value => {
      if (controller.current === current) setReport(value);
    }).catch(failure => {
      if (controller.current === current && !current.signal.aborted) setError(failure instanceof PdfVisualError ? failure.message : 'The page overview could not finish. Reopen the source documents and try again.');
    }).finally(() => {
      if (controller.current === current) { controller.current = null; setRunning(false); }
    });
  }

  function openPair(number: number) {
    controller.current?.abort();
    const pair = pdfOverviewPair(number, before.pages, after.pages);
    onOpenPair(pair.beforePage, pair.afterPage);
  }

  const stopped = report?.stop;
  const pauseMessage = stopped === 'document-limit' ? `The overview covers the first ${scanLimit} page pairs. ${unscanned} pairs are beyond its limit and remain unscanned.` : stopped === 'cancelled' ? 'Scan paused. Completed results are retained for this session.' : stopped ? 'This run reached its processing budget. Resume to check the next page pair.' : '';
  const heading = running ? 'Scanning page pairs' : !report ? 'Find changes across the PDFs' : report.status === 'complete' ? unavailable ? 'Scan finished with coverage gaps' : 'Page scan complete' : 'Page scan paused';

  return <section className="pdf-overview" aria-label="PDF visual page overview" style={{ display: active ? undefined : 'none' }}>
    <header className="pdf-overview-heading">
      <div className="pdf-overview-symbol"><FileDiff size={22}/></div>
      <div><span className="eyebrow">PAGE OVERVIEW</span><h3>{heading}</h3><p>{before.pages} baseline {before.pages === 1 ? 'page' : 'pages'} <ArrowRight size={11}/> {after.pages} open-file {after.pages === 1 ? 'page' : 'pages'}</p></div>
      <div className="pdf-overview-actions">{running ? <button className="button secondary" onClick={() => controller.current?.abort()}><Square size={12}/>Pause scan</button> : <button className="button primary" onClick={() => start(canResume)} disabled={!!error}><Play size={13}/>{canResume ? 'Resume scan' : report ? 'Scan again' : 'Scan pages'}</button>}{!running && (canResume || error) && <button className="icon-button" aria-label="Start a new page scan" title="Discard these summaries and scan again" onClick={() => start(false)}><RotateCcw size={15}/></button>}</div>
    </header>
    <p className="pdf-overview-method">Pairs use the same page number at one physical scale. Inserted or reordered pages can shift the results; open a pair to adjust its pages.</p>
    {error && <div className="pdf-overview-notice" role="alert"><AlertCircle size={15}/><span>{error}</span></div>}
    {(report || running) ? <>
      <div className="pdf-overview-coverage" role="status" aria-live="polite"><span>{running && <LoaderCircle size={13} className="spin"/>}<strong>{compared} / {totalPairs}</strong> pairs compared</span><span>{unavailable} unavailable · {unscanned} unscanned</span></div>
      <progress className="pdf-overview-progress" value={pairs.length} max={totalPairs} aria-label="Attempted PDF page pairs"/>
      {pauseMessage && !running && <div className="pdf-overview-notice"><AlertCircle size={14}/><span>{pauseMessage}</span></div>}
      <div className="pdf-overview-result-tools"><div className="pdf-overview-counts"><span><b>{changed}</b> with changes</span><span><b>{unchanged}</b> no pixel change detected</span></div><label>Show<select aria-label="Filter page overview" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">All pairs</option><option value="changes">Changes</option><option value="unavailable">Unavailable</option></select></label></div>
      <div className="pdf-overview-pairs" aria-label="Page comparison results">
        {visiblePairs.map(({ number, pair }) => {
          const pages = pdfOverviewPair(number, before.pages, after.pages);
          const current = running && number === pairs.length + 1;
          return <button key={number} className={`pdf-overview-pair ${pair?.outcome ?? 'unscanned'}`} onClick={() => openPair(number)} aria-label={`Open page pair ${number}: baseline ${pages.beforePage || 'no page'}, open file ${pages.afterPage || 'no page'}, ${pair ? OUTCOME_LABELS[pair.outcome] : current ? 'scanning' : 'unscanned'}`} title={running ? 'Pause the scan and open this pair' : 'Open this pair in the detailed visual comparison'}>
            <span className="pdf-overview-pair-number">{number}</span><span className="pdf-overview-pair-pages"><strong>{pages.beforePage ? `Page ${pages.beforePage}` : 'No page'}<ArrowRight size={12}/>{pages.afterPage ? `Page ${pages.afterPage}` : 'No page'}</strong><small>{pair ? pairDetail(pair) : current ? 'Rendering and comparing locally…' : 'This pair has not been scanned.'}</small></span>
            <span className="pdf-overview-pair-status">{current ? <LoaderCircle size={13} className="spin"/> : pair?.outcome === 'unavailable' ? <AlertCircle size={13}/> : pair?.outcome === 'no-detected-change' ? <Check size={13}/> : null}{pair ? OUTCOME_LABELS[pair.outcome] : current ? 'Scanning' : 'Unscanned'}</span><ChevronRight size={15}/>
          </button>;
        })}
        {!visiblePairs.length && <p className="pdf-overview-empty-filter">No completed pairs match this filter.{unscanned ? ' Some pages remain unscanned.' : ''}</p>}
      </div>
    </> : <div className="pdf-overview-intro"><FileDiff size={37}/><h4>A page-by-page starting point</h4><p>Scan for drawing, image, color and layout changes. Each result opens the existing overlay for a closer review. Blank extra pages and page-size changes are included.</p><span>Local processing · {totalPairs} page pairs · No upload</span></div>}
    <footer className="pdf-overview-footer"><p>No pixel change detected applies only to the reported sensitivity and resolution. Failed or unscanned pages are coverage gaps. Matching page numbers do not prove matching content. Changing sensitivity starts a fresh overview.</p><span>One pair at a time · up to 50 pairs / 60 million pixels / 2 minutes per run · 300 pairs per overview</span></footer>
  </section>;
}
