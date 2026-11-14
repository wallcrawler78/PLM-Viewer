import { useEffect, useId, useRef } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { useViewerPreferences } from '../ViewerPreferences';
import type { ViewerPreferences } from '../preferences';
import './viewer-preferences.css';

export function ViewerPreferencesSettings({ titleId }: { titleId?: string } = {}) {
  const generatedTitleId = useId();
  const headingId = titleId ?? generatedTitleId;
  const { preferences, updatePreferences, resetPreferences, persistence, persistenceMessage } = useViewerPreferences();
  return <section className="settings-section viewer-preferences" aria-labelledby={headingId}>
    <h3 id={headingId}><SlidersHorizontal size={16}/>Viewer preferences</h3>
    <p className="viewer-preferences-intro">Defaults for this browser. New document comparisons use these choices; open comparisons keep their current settings.</p>
    <div className="viewer-preference-fields">
      <label className="field-label">Document comparison
        <select aria-label="Default document comparison" value={preferences.documentComparison} onChange={event => updatePreferences({ documentComparison: event.target.value as ViewerPreferences['documentComparison'] })}>
          <option value="pages">Side by side</option><option value="redline">Text redline</option>
        </select>
      </label>
      <label className="field-label">3D rendering
        <select aria-label="3D rendering quality" value={preferences.renderQuality} onChange={event => updatePreferences({ renderQuality: event.target.value as ViewerPreferences['renderQuality'] })}>
          <option value="standard">Standard</option><option value="economy">Economy</option>
        </select>
        <span className="viewer-preference-help">Economy reduces display resolution. Geometry, measurements and document comparisons stay the same.</span>
      </label>
      <label className="viewer-preference-toggle"><input type="checkbox" checked={preferences.linkedScrolling} onChange={event => updatePreferences({ linkedScrolling: event.target.checked })}/><span>Link scrolling in new document comparisons</span></label>
      <label className="viewer-preference-toggle"><input type="checkbox" checked={preferences.sourceHighlights} onChange={event => updatePreferences({ sourceHighlights: event.target.checked })}/><span>Highlight text changes in source pages</span></label>
    </div>
    <div className="viewer-preferences-footer"><p className={persistence === 'local' ? 'tiny muted' : 'tiny viewer-preference-storage-notice'} role="status">{persistenceMessage}</p><button type="button" className="text-button" onClick={resetPreferences}>Reset preferences</button></div>
    <p className="tiny muted viewer-preference-reset-note">Reset affects these defaults only. Review notes and saved views are kept.</p>
  </section>;
}

/** Mount while open. Native modal focus stays independent of the loaded sources. */
export function ViewerPreferencesDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog className="viewer-preferences-dialog" ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const element = event.currentTarget;
    const targets = Array.from(element.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')).filter(target => target.tabIndex >= 0 && !target.matches(':disabled') && target.getClientRects().length > 0 && getComputedStyle(target).visibility === 'visible');
    const first = targets[0], last = targets.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !element.contains(active))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (active === last || !element.contains(active))) {
      event.preventDefault(); first.focus();
    }
  }}>
    <button type="button" className="icon-button viewer-preferences-dialog-close" aria-label="Close preferences" onClick={onClose}><X size={18}/></button>
    <ViewerPreferencesSettings titleId={titleId}/>
  </dialog>;
}
