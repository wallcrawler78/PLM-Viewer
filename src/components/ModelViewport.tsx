import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Box, Crosshair, Link2, LoaderCircle, MousePointer2, RotateCcw } from 'lucide-react';
import { ViewerEngine } from './model/engine';
import type { ModelViewportProps, ViewerStatus } from './model/types';

export type { CameraState, MeasurementResult, ModelAnchor, ModelViewportProps, SceneBounds, ScenePart, SectionState, Vec3, ViewCommand } from './model/types';

export default function ModelViewport(props: ModelViewportProps) {
  const container = useRef<HTMLDivElement>(null);
  const orientation = useRef<HTMLDivElement>(null);
  const engine = useRef<ViewerEngine | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const [retry, setRetry] = useState(0);
  const [engineError, setEngineError] = useState<string>();
  const [status, setStatus] = useState<ViewerStatus>({ loading: true, loaded: 0, total: 0, pointCount: 0 });
  // Scene arrays follow React's immutable-props contract. Retain value-based
  // source reloads without serializing every occurrence on each status update.
  const partSignature = useMemo(() => JSON.stringify(props.parts), [props.parts]);
  const comparisonSignature = useMemo(() => JSON.stringify(props.comparisonParts ?? []), [props.comparisonParts]);

  useEffect(() => {
    if (!container.current) return;
    setEngineError(undefined);
    try {
      engine.current = new ViewerEngine(container.current, latestProps.current, setStatus, orientation.current ?? undefined);
    } catch (error) {
      const message = 'Neither accelerated nor software rendering is available in this browser session. Try a current Chrome browser.';
      setEngineError(message);
      latestProps.current.onError?.(message);
    }
    return () => { engine.current?.dispose(); engine.current = null; };
  }, [retry]);

  useEffect(() => {
    void engine.current?.setParts(latestProps.current.parts, latestProps.current.comparisonParts);
  }, [partSignature, comparisonSignature, retry]);

  useEffect(() => { engine.current?.update(props); });

  const displayedParts = [...props.parts, ...(props.mode === 'single' ? [] : props.comparisonParts ?? [])];
  const noParts = displayedParts.length === 0;
  const allHidden = displayedParts.length > 0 && displayedParts.every(part => props.hiddenIds.includes(part.id));
  const localSources = props.sourcePresentation === 'local';

  return (
    <div className={`model-viewport ${props.className ?? ''}`} data-testid="model-viewport" data-view-mode={props.mode} data-renderer={status.rendererMode}>
      <div ref={container} className="model-canvas-container" />

      {props.mode === 'split' && !engineError && <>
        <div className="model-split-divider" />
        <div className="model-revision-label model-revision-label-a"><span className="model-dot model-dot-a" />Baseline · {localSources ? '' : 'Rev '}{props.baselineRevision ?? 'A'}</div>
        <div className="model-revision-label model-revision-label-b"><span className="model-dot model-dot-b" />Current · {localSources ? '' : 'Rev '}{props.currentRevision ?? 'B'}</div>
        <div className="model-linked-cameras"><Link2 size={12} /> Linked cameras</div>
      </>}

      {props.mode === 'overlay' && !engineError && <div className="model-overlay-legend">
        <span><i className="model-dot model-dot-a" />{localSources ? '' : 'Revision '}{props.baselineRevision ?? 'A'}</span>
        <span><i className="model-dot model-dot-b" />{localSources ? '' : 'Revision '}{props.currentRevision ?? 'B'}</span>
      </div>}

      {!engineError && <div className="model-review-hints">
        {!status.loading && status.importNotice && <div className="model-import-notice" role="status">{status.importNotice}</div>}
        {(props.measurementMode || props.anchorMode) && <div className="model-tool-hint" role="status">
          <Crosshair size={14} />
          <span>{props.measurementMode ? (status.pointCount === 0 ? 'Pick the first point on a surface' : status.pointCount === 1 ? 'Pick a second point to measure' : 'Pick a new point to start another measurement') : 'Click a surface to anchor your comment'}</span>
          {props.explode > 0 && <em>Assembled coordinates</em>}
        </div>}
      </div>}

      {status.measurement !== undefined && !engineError && <div className="model-measurement-label" role="status" data-testid="model-measurement">
        <span>Point distance</span><strong>{status.measurement.toFixed(2)} <small>mm</small></strong>
        <em>Surface mesh · approximate</em>
      </div>}

      {status.loading && !engineError && <div className="model-loading" role="status">
        <LoaderCircle size={15} className="model-spin" />{status.sourceKind === 'step' || status.sourceKind === 'mixed' ? 'Importing STEP locally' : 'Loading geometry'} <span>{status.loaded}/{status.total || props.parts.length}</span>
      </div>}

      {status.hint && <div className="model-context-hint" role="status">{status.hint}</div>}
      {status.error && !engineError && <div className="model-asset-error" role="alert"><AlertTriangle size={15} /><span>{status.error}</span><button onClick={() => setRetry(value => value + 1)}>Retry</button></div>}

      {engineError && <div className="model-empty-state" role="alert"><AlertTriangle size={32} /><h3>Unable to start the 3D viewer</h3><p>{engineError}</p><button onClick={() => setRetry(value => value + 1)}><RotateCcw size={14} />Try again</button></div>}
      {!engineError && !status.loading && (noParts || allHidden) && <div className="model-empty-state model-empty-state-soft"><Box size={32} /><h3>{allHidden ? 'All components are hidden' : 'No models loaded'}</h3><p>{localSources ? allHidden ? 'Choose Show above to reveal the model.' : 'Choose Open files and select a STEP model.' : allHidden ? 'Use Reset view or reveal a component in the BOM.' : 'Open Add from BOM or use a component’s Load button to bring its model into the view.'}</p></div>}

      {!engineError && <>
        {status.rendererMode === 'software' && <div className="model-software-badge" title="Graphics acceleration is unavailable. The original STEP-derived triangles are rendered on the CPU, with simplified lighting and painter-sorted transparency. Large assemblies may be slower.">Software 3D</div>}
        <div className="model-navigation-hint"><MousePointer2 size={12} /><span>Drag to orbit · Right-drag to pan · Scroll to zoom</span></div>
        <div className="model-coordinate-system"><div ref={orientation} className="model-axis-widget" aria-hidden="true"><span className="model-axis-origin" /><span data-axis="x" className="model-axis-x">X</span><span data-axis="y" className="model-axis-y">Y</span><span data-axis="z" className="model-axis-z">Z</span></div><span className="model-unit-label">mm · Z up</span></div>
        {props.section.enabled && <div className="model-section-state">Section {props.section.axis.toUpperCase()} · {props.section.offset.toFixed(0)} mm<span>Open cut</span></div>}
      </>}
    </div>
  );
}

export { ModelViewport };
