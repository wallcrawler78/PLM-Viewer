import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { PlaygroundEngine } from './scene-engine';
import type { PlaygroundSceneStatus, PlaygroundViewportHandle, PlaygroundViewportProps, SceneLabel } from './scene-engine';
export type { PlaygroundInteraction, PlaygroundPresentation, PlaygroundSceneStatus, PlaygroundViewportHandle, PlaygroundViewportProps, PlaygroundPick } from './scene-engine';

/** Keeps a single renderer alive through proposal edits. No source reload or scene replacement per drag. */
const PlaygroundViewport = forwardRef<PlaygroundViewportHandle, PlaygroundViewportProps>(function PlaygroundViewport(props, forwardedRef) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<PlaygroundEngine | null>(null);
  const latest = useRef(props); latest.current = props;
  const [labels, setLabels] = useState<SceneLabel[]>([]);
  const [status, setStatus] = useState<PlaygroundSceneStatus | null>(null);
  const [failure, setFailure] = useState('');
  useImperativeHandle(forwardedRef, () => ({
    getCamera: () => engine.current?.getCamera() ?? { position: [260, -320, 240], target: [0, 0, 0] },
    restoreCamera: camera => engine.current?.restoreCamera(camera),
    fit: () => engine.current?.fit(), orient: orientation => engine.current?.orient(orientation),
    capture: () => {
      // A capture can follow a presentation change before the passive update
      // effect. Apply the latest committed React props before reading pixels.
      engine.current?.update(latest.current);
      return engine.current?.capture() ?? Promise.reject(new Error('The 3D renderer is not available.'));
    },
    pick: (u, v) => engine.current?.pick(u, v) ?? null,
    project: (id, point) => engine.current?.project(id, point) ?? null,
  }), []);
  useEffect(() => {
    if (!host.current) return;
    try {
      engine.current = new PlaygroundEngine(host.current, latest.current, value => {
        setStatus(value); latest.current.onStatus?.(value);
      }, setLabels);
    } catch (error) { setFailure(error instanceof Error ? error.message : 'The browser could not open this 3D workspace.'); }
    return () => { engine.current?.dispose(); engine.current = null; };
  }, []);
  useEffect(() => { engine.current?.update(props); }, [props]);
  return <div className={`playground-viewport ${props.className ?? ''}`} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 220, overflow: 'hidden' }}>
    <div ref={host} className="playground-render-host" style={{ position: 'absolute', inset: 0 }}/>
    <svg className="playground-component-labels" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'hidden' }}>
      {labels.map(label => <g key={label.id}>
        <path d={`M${label.x},${label.y} L${label.labelX + (label.labelX > label.x ? 0 : 164)},${label.labelY + 12}`} fill="none" stroke={label.selected ? '#56dfcf' : '#83a7b3'} strokeWidth="1"/>
        <circle cx={label.x} cy={label.y} r="2.4" fill={label.selected ? '#6aebd7' : '#c4dde1'}/>
        <rect x={label.labelX} y={label.labelY} width="164" height="26" rx="6" fill="#112630" fillOpacity="0.94" stroke={label.selected ? '#58cabd' : '#344d5b'}/>
        <text x={label.labelX + 8} y={label.labelY + 17} fill="#e1efee" fontSize="10.5" fontFamily="DM Sans, sans-serif">{`${label.itemNumber ? `${label.itemNumber} · ` : ''}${label.name}`.slice(0, 29)}</text>
      </g>)}
    </svg>
    {status?.loading && <div className="playground-scene-status" role="status" style={{ position: 'absolute', top: 14, left: 14, display: 'flex', gap: 8, alignItems: 'center', padding: '8px 11px', borderRadius: 8, color: '#d9eeeb', background: '#112630e8', fontSize: 12 }}><LoaderCircle className="spin" size={15}/>Preparing local geometry · {status.loaded}/{status.total}</div>}
    {status?.rendererMode === 'software' && <div className="playground-software-badge" style={{ position: 'absolute', right: 12, bottom: 12, padding: '5px 8px', color: '#bfceda', background: '#182d3b', borderRadius: 6, fontSize: 10 }}>Software 3D</div>}
    {(failure || status && !status.loading && status.errors.length > 0) && <div className="playground-scene-error" role="alert" style={{ position: 'absolute', top: 52, left: 14, right: 14, maxWidth: 520, padding: '10px 13px', color: '#ffdbc8', background: '#482c24ee', border: '1px solid #775042', borderRadius: 8, fontSize: 12 }}>{failure || status?.errors.slice(0, 3).join(' ')}{status && status.errors.length > 3 ? ` ${status.errors.length - 3} more sources are unavailable.` : ''}</div>}
  </div>;
});
export default PlaygroundViewport;
