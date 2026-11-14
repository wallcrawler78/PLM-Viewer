import { useEffect, useState } from 'react';
import { ArrowRight, Check, CircleAlert, Fingerprint, LoaderCircle, LockKeyhole, LogIn, LogOut, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import type { RevisionDescriptor } from '../domain';
import type { ArenaAuthStatus } from '../integrations/arenaAuth';
import './arena-connection.css';

export interface ArenaConnectionIssue {
  code: string;
  message: string;
}

interface ArenaConnectionProps {
  loading: boolean;
  issue: ArenaConnectionIssue | null;
  revisions: RevisionDescriptor[];
  onRevision: (revision: string) => void;
  onRetry: () => void;
  onSample: () => void;
  authStatus: ArenaAuthStatus | null;
  authLoading: boolean;
  authBusy: boolean;
  authError: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

const connectionCopy: Record<string, { title: string; detail: string }> = {
  UNCONFIGURED: {
    title: 'Arena MCP needs a connection',
    detail: 'Your administrator needs to configure the Arena MCP service and user sign-in on the viewer server. This workspace will open once that connection is ready.',
  },
  AUTH_REQUIRED: {
    title: 'Your Arena sign-in is required',
    detail: 'Sign in through your organization’s configured Arena connection, then try again. The viewer uses your own permissions for every source request.',
  },
  FORBIDDEN: {
    title: 'This source is outside your access',
    detail: 'Your Arena identity does not have permission to open this workspace or source. Ask your administrator to check access, or open an item you can view.',
  },
  FEATURE_NOT_ENABLED: {
    title: 'Arena MCP is not enabled for this workspace',
    detail: 'Ask your Arena administrator to check this workspace’s MCP eligibility and required feature access. Your sign-in can be connected while a workspace feature remains unavailable.',
  },
  AUTH_DISCONNECTED: {
    title: 'Arena is disconnected',
    detail: 'Your live sources have been cleared. Connect to Arena when you are ready to reopen this item.',
  },
  AUTH_DISCONNECTING: {
    title: 'Disconnecting from Arena',
    detail: 'Your open sources are cleared while the viewer ends this browser session’s connection.',
  },
  AUTH_DISCONNECT_FAILED: {
    title: 'Your disconnect was not confirmed',
    detail: 'The open sources have been cleared. Check the connection status below before trying again.',
  },
  CONNECTION_CHANGED: {
    title: 'Your Arena session changed',
    detail: 'The previous workspace has been cleared. Reopen it to resolve every source with the permissions of your current session.',
  },
  REVISION_REQUIRED: {
    title: 'Choose the source revision',
    detail: 'Open an explicit item revision so the model, documents, and BOM stay tied to the same source context.',
  },
};

export function ArenaConnection({ loading, issue, revisions, onRevision, onRetry, onSample, authStatus, authLoading, authBusy, authError, onConnect, onDisconnect }: ArenaConnectionProps) {
  const [revision, setRevision] = useState('');
  useEffect(() => { setRevision(''); }, [revisions]);
  const canConnect = !!authStatus?.configured && !authStatus.connected && !!authStatus.loginPath;
  const connected = !!authStatus?.connected;
  const copy = canConnect && (issue?.code === 'AUTH_REQUIRED' || issue?.code === 'UNCONFIGURED') ? {
    title: 'Connect your Arena account',
    detail: 'Sign in to Arena, select your workspace, and authorize the viewer. Source access stays tied to your own Arena permissions.',
  } : connected && issue?.code === 'UNCONFIGURED' ? {
    title: 'Your Arena sign-in is connected',
    detail: 'Your account is connected. Ask your administrator to finish connecting this workspace before opening this item.',
  } : issue ? connectionCopy[issue.code] : undefined;
  const selectingRevision = issue?.code === 'REVISION_REQUIRED' && revisions.length > 0;
  const accessIssue = issue?.code === 'AUTH_REQUIRED' || issue?.code === 'FORBIDDEN';

  return <main className="connection-state arena-connection-state">
    <section className="connection-card arena-connection-card" aria-labelledby="arena-connection-title" aria-busy={loading}>
      <div className={`arena-connection-icon ${loading ? 'is-loading' : ''}`}>{loading ? <LoaderCircle className="spin" size={28} /> : selectingRevision ? <Fingerprint size={28} /> : accessIssue ? <LockKeyhole size={28} /> : issue?.code === 'CONNECTION_CHANGED' ? <RefreshCw size={28} /> : <Unplug size={28} />}</div>
      <span className="eyebrow">ARENA WORKSPACE</span>
      <h1 id="arena-connection-title">{loading ? 'Opening your Arena workspace' : copy?.title ?? 'This Arena source could not be opened'}</h1>
      <p>{loading ? 'Checking your session and resolving the exact item revision, BOM, and attachments you are allowed to view.' : copy?.detail ?? 'The viewer could not resolve this source. Check the connection and source context, then try again.'}</p>
      {!loading && issue && issue.code !== 'UNCONFIGURED' && <div className="arena-connection-detail" role="status"><CircleAlert size={16} /><span>{issue.message}</span></div>}
      {!loading && connected && <div className="arena-session-card"><dl><div><dt>Signed in as</dt><dd>{authStatus?.user?.displayName ?? authStatus?.user?.id}</dd></div><div><dt>Arena workspace</dt><dd>{authStatus?.workspaceId}</dd></div></dl><p>{authStatus?.message ?? 'Your Arena identity is verified for this session.'}</p></div>}
      {!loading && !connected && authStatus?.message && issue?.code !== 'UNCONFIGURED' && <p className="arena-sample-note">{authStatus.message}</p>}
      {!loading && authLoading && <p className="arena-sample-note" role="status">Checking Arena sign-in…</p>}
      {!loading && authError && <div className="arena-connection-detail" role="status"><CircleAlert size={16} /><span>{authError}</span></div>}
      {selectingRevision && <form className="arena-revision-form" onSubmit={event => { event.preventDefault(); if (revision && !authBusy) onRevision(revision); }}>
        <label className="field-label">Item revision<select aria-label="Arena item revision" value={revision} disabled={authBusy} onChange={event => setRevision(event.target.value)}><option value="">Select a revision…</option>{revisions.map(value => <option key={value.id} value={value.id}>{value.label}{value.lifecycle ? ` · ${value.lifecycle}` : ''}</option>)}</select></label>
        <button className="button primary full" type="submit" disabled={!revision || authBusy}>Open this revision<ArrowRight size={15} /></button>
      </form>}
      {!loading && <div className="button-row arena-connection-actions">
        {canConnect && <button className="button primary" disabled={authLoading || authBusy} onClick={onConnect}><LogIn size={15} />Connect to Arena</button>}
        {!selectingRevision && <button className={`button ${canConnect?'secondary':'primary'}`} disabled={authBusy} onClick={onRetry}><RefreshCw size={15} />Try again</button>}
        {connected && authStatus?.logoutPath && <button className="button secondary" disabled={authBusy || authLoading} onClick={onDisconnect}>{authBusy?<LoaderCircle className="spin" size={15}/>:<LogOut size={15}/>}Disconnect Arena</button>}
        <button className="button secondary" onClick={onSample}>Open sample workspace</button>
      </div>}
      <div className="arena-connection-assurance"><span><ShieldCheck size={14} />Your Arena permissions apply</span><span><Check size={14} />Read-only source connection</span></div>
      {!loading && <p className="arena-sample-note">The sample workspace is separate and never contacts Arena.</p>}
    </section>
  </main>;
}
