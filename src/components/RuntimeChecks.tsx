import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, Box, Check, Circle, CircleAlert, FileCheck2, FileText, LoaderCircle, Monitor, Play, ShieldCheck, Square, X } from 'lucide-react';
import { browserRuntimeEnvironment, createBrowserRuntimeChecks } from '../runtime-checks-browser';
import { createRuntimeReport, initialRuntimeResults, RUNTIME_CHECK_DEFINITIONS, RUNTIME_MESSAGES, runRuntimeChecks } from '../runtime-checks';
import type { RuntimeCheckId, RuntimeCheckResult, RuntimeReport } from '../runtime-checks';
import './runtime-checks.css';

const ICONS = { assets: ShieldCheck, step: Box, pdf: FileCheck2, docx: FileText, graphics: Monitor };
const STATUS_LABELS = { pending: 'Ready', running: 'Running', passed: 'Passed', failed: 'Failed', unavailable: 'Unavailable', cancelled: 'Cancelled' };

function CheckStatus({ result }: { result: RuntimeCheckResult }) {
  const Icon = result.status === 'passed' ? Check : result.status === 'running' ? LoaderCircle : result.status === 'failed' || result.status === 'unavailable' ? CircleAlert : result.status === 'cancelled' ? X : Circle;
  return <span className={`runtime-check-status ${result.status}`}><Icon size={13} className={result.status === 'running' ? 'spin' : undefined}/>{STATUS_LABELS[result.status]}</span>;
}

function metricSummary(result: RuntimeCheckResult): string {
  const metrics = result.metrics;
  if (!metrics) return '';
  if (result.id === 'step') return `${metrics.widthMm} × ${metrics.depthMm} × ${metrics.heightMm} mm · ${Number(metrics.triangles).toLocaleString()} triangles`;
  if (result.id === 'pdf' || result.id === 'docx') return `${metrics.pages} pages · ${Number(metrics.textCharacters).toLocaleString()} characters checked`;
  if (result.id === 'graphics') return `WebGL2 ${metrics.webgl2 ? 'available' : 'unavailable'} · Software render verified`;
  return `${metrics.sourceFiles} fixture hashes verified · ${Math.round(Number(metrics.sourceBytes) / 1024)} KiB`;
}

export default function RuntimeChecks() {
  const [environment] = useState(browserRuntimeEnvironment);
  const [results, setResults] = useState(initialRuntimeResults);
  const [report, setReport] = useState<RuntimeReport | null>(null);
  const [running, setRunning] = useState(false);
  const [downloadIssue, setDownloadIssue] = useState('');
  const active = useRef<AbortController | null>(null);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const extension = environment.surface === 'chrome-extension';
  const completed = results.filter(result => !['pending', 'running'].includes(result.status)).length;
  const current = results.find(result => result.status === 'running');
  const currentTitle = RUNTIME_CHECK_DEFINITIONS.find(definition => definition.id === current?.id)?.title;
  const headline = running ? `Checking ${currentTitle?.toLowerCase() ?? 'local runtime'}…`
    : report?.outcome === 'passed' ? 'Local fixture checks passed'
      : report?.outcome === 'cancelled' ? 'Checks cancelled'
        : report ? 'Some checks need attention' : 'Ready when you are';
  const back = `${location.pathname}?mode=preview`;

  useEffect(() => () => {
    const owned = active.current; active.current = null; owned?.abort();
    for (const [url, timer] of downloads.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
    downloads.current.clear();
  }, []);

  async function run() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const session = createBrowserRuntimeChecks(environment);
    const startedAt = new Date().toISOString();
    setRunning(true); setReport(null); setResults(initialRuntimeResults()); setDownloadIssue('');
    try {
      const checks = await runRuntimeChecks(session.operations, controller.signal, update => { if (active.current === controller) setResults(update); });
      if (active.current === controller) setReport(createRuntimeReport(environment, checks, startedAt, new Date().toISOString()));
    } finally {
      session.dispose();
      if (active.current === controller) { active.current = null; setRunning(false); }
    }
  }

  function download() {
    if (!report) return;
    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      link = document.createElement('a');
      link.href = url; link.download = `review-studio-runtime-${report.environment.surface}-${report.finishedAt.slice(0, 10)}.json`;
      document.body.append(link); link.click();
      const ownedUrl = url;
      const timer = setTimeout(() => { URL.revokeObjectURL(ownedUrl); downloads.current.delete(ownedUrl); }, 1_000);
      downloads.current.set(url, timer); setDownloadIssue('');
    } catch {
      if (url) URL.revokeObjectURL(url);
      setDownloadIssue('The report could not be downloaded. Allow downloads for this viewer and try again.');
    } finally { link?.remove(); }
  }

  return <main className="runtime-check-page">
    <header className="runtime-check-topbar">
      <a className="runtime-check-back" href={back}><ArrowLeft size={16}/>Sample workspace</a>
      <span>REVIEW STUDIO <b> / </b> LOCAL TOOLS</span>
    </header>
    <div className="runtime-check-content">
      <section className="runtime-check-heading" aria-labelledby="runtime-heading">
        <span className="runtime-check-eyebrow"><ShieldCheck size={15}/>Runtime qualification</span>
        <h1 id="runtime-heading">Built in. Checked here.</h1>
        <p>Run the packaged STEP, PDF, and Word samples through this browser’s local engines. Get a small, shareable report of what actually worked.</p>
        <div className={`runtime-surface-badge ${extension ? 'extension' : ''}`}><Monitor size={14}/>{extension ? 'Chrome extension page' : 'Hosted Preview'}<span>Viewer {environment.viewerVersion ?? 'version unavailable'}</span></div>
      </section>

      <section className="runtime-check-card" aria-labelledby="runtime-status-heading">
        <div className="runtime-check-summary">
          <div><span className="runtime-check-eyebrow">THIS BROWSER SESSION</span><h2 id="runtime-status-heading" aria-live="polite">{headline}</h2><p>{running ? `${completed} of ${results.length} checks complete. You can cancel at any time.` : 'Synthetic fixtures only. Your Arena connection and review files stay untouched.'}</p></div>
          <div className="runtime-check-actions">
            {running ? <button className="button secondary" type="button" onClick={() => active.current?.abort()}><Square size={13}/>Cancel checks</button> : <button className="button primary" type="button" onClick={() => void run()}><Play size={14}/>{report ? 'Run again' : 'Run local checks'}</button>}
            {report && !running && <button className="button secondary" type="button" onClick={download}><ArrowDownToLine size={14}/>Download report</button>}
          </div>
        </div>
        <ol className="runtime-check-list" aria-label="Local runtime checks" aria-busy={running}>
          {RUNTIME_CHECK_DEFINITIONS.map(definition => {
            const result = results.find(value => value.id === definition.id)!;
            const Icon = ICONS[definition.id as RuntimeCheckId];
            return <li key={definition.id} className={`runtime-check-row ${result.status}`}>
              <span className="runtime-check-icon"><Icon size={20}/></span>
              <div className="runtime-check-description"><h3>{definition.title}</h3><p>{result.status === 'pending' ? definition.detail : RUNTIME_MESSAGES[result.code]}</p>{result.metrics && <small>{metricSummary(result)}</small>}</div>
              <div className="runtime-check-result"><CheckStatus result={result}/>{result.elapsedMs > 0 && <span>{(result.elapsedMs / 1_000).toFixed(1)} s</span>}</div>
            </li>;
          })}
        </ol>
        {downloadIssue && <p className="runtime-download-issue" role="alert">{downloadIssue}</p>}
      </section>

      <section className="runtime-check-scope" aria-labelledby="runtime-scope-heading">
        <CircleAlert size={18}/><div><h2 id="runtime-scope-heading">What this result tells you</h2><p>{extension ? 'These checks run on this installed extension page and exercise its local runtime. They are one part of release qualification.' : 'This is a hosted Preview check. To qualify the packaged Chrome runtime, install the extension and open Local runtime checks from its Options page.'}</p><p>A passing result covers the included samples. Large files, all document layouts, Arena permissions, attachment launching, and shared review storage need separate testing.</p></div>
      </section>
      <details className="runtime-check-details"><summary>Check limits &amp; report contents</summary><p>Checks run one at a time with a maximum of 45 seconds per check. Cancellation stops owned workers, fetches, and page rendering. Word layout uses the browser’s main thread; a synchronous operation or garbage collection cannot be forcibly interrupted. Temporary buffers, canvases, and document pages are released after use.</p><p>The JSON report contains the execution surface, application and dependency versions, a timestamp, check statuses, timings, and numeric fixture results. It excludes URLs, credentials, Arena identifiers, customer files, and document content. Downloading is optional; nothing is uploaded or saved automatically.</p><dl><div><dt>PDF.js</dt><dd>{environment.packages.pdf}</dd></div><div><dt>Word runtime</dt><dd>{environment.packages.word}</dd></div><div><dt>CAD runtime</dt><dd>{environment.packages.cad}</dd></div><div><dt>Three.js</dt><dd>{environment.packages.graphics}</dd></div>{extension && <div><dt>Extension</dt><dd>{environment.extensionVersion ?? 'Unavailable'}</dd></div>}</dl></details>
      <footer className="runtime-check-footer">Local rendering. No AI subscription or conversion service required for these checks.</footer>
    </div>
  </main>;
}
