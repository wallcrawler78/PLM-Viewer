import { Component } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, FileText, RefreshCw } from 'lucide-react';
import './model-load-boundary.css';

/** Keep a failed CAD module inside its pane so document review and drafts survive. */
export class ModelLoadBoundary extends Component<{ children: ReactNode; onDocuments: () => void; hasDrafts: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="model-load-failure" role="alert" aria-labelledby="model-load-failure-title">
      <AlertTriangle size={30}/>
      <h3 id="model-load-failure-title">The 3D viewer could not open</h3>
      <p>You can continue reviewing documents. Reload the workspace to try loading the 3D viewer again.</p>
      {this.props.hasDrafts && <p className="model-load-draft-note">Copy or post your unsent notes before reloading.</p>}
      <div className="button-row">
        <button className="button primary" onClick={this.props.onDocuments}><FileText size={15}/>Return to documents</button>
        <button className="button secondary" onClick={() => window.location.reload()}><RefreshCw size={15}/>Reload workspace</button>
      </div>
    </div>;
  }
}
