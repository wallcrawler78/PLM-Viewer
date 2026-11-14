import React from 'react';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/dm-sans/latin-700.css';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/latin-800.css';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ViewerPreferencesProvider } from './ViewerPreferences';
// Keep viewport defaults before the workspace overrides even though its JS is lazy.
import './components/model/viewport.css';
import './styles.css';
import './universal.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="fatal-state"><h1>The workspace needs to reload</h1><p>{this.state.error}</p><p>Your saved preview comments and views are kept in this browser.</p><button className="button primary" onClick={() => location.reload()}>Reload workspace</button></main>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><ViewerPreferencesProvider><App /></ViewerPreferencesProvider></ErrorBoundary>);
