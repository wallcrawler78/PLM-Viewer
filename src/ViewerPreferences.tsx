import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ViewerPreferenceStore, VIEWER_PREFERENCES_KEY } from './preferences';
import type { PreferenceSnapshot, PreferenceStorage, ViewerPreferences } from './preferences';

interface ViewerPreferencesContext extends PreferenceSnapshot {
  updatePreferences: (patch: Partial<ViewerPreferences>) => void;
  resetPreferences: () => void;
}
const PreferencesContext = createContext<ViewerPreferencesContext | null>(null);
function browserStorage(): PreferenceStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function ViewerPreferencesProvider({ children }: { children: ReactNode }) {
  const [storage] = useState(browserStorage);
  const [store] = useState(() => new ViewerPreferenceStore(storage));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.storageArea === storage && (event.key === VIEWER_PREFERENCES_KEY || event.key === null)) store.refresh();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [store, storage]);
  const value = useMemo(() => ({ ...snapshot, updatePreferences: store.update, resetPreferences: store.reset }), [snapshot, store]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function useViewerPreferences(): ViewerPreferencesContext {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('Viewer preferences require their provider.');
  return value;
}
