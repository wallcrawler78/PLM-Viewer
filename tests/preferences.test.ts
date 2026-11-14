import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIEWER_PREFERENCES, MAX_PREFERENCE_BYTES, VIEWER_PREFERENCES_KEY, ViewerPreferenceStore } from '../src/preferences';
import type { PreferenceStorage, ViewerPreferences } from '../src/preferences';

class MemoryStorage implements PreferenceStorage {
  values = new Map<string, string>();
  getItem = vi.fn((key: string) => this.values.get(key) ?? null);
  setItem = vi.fn((key: string, value: string) => { this.values.set(key, value); });
  removeItem = vi.fn((key: string) => { this.values.delete(key); });
}
const encoded = (preferences: Partial<ViewerPreferences> = {}) => JSON.stringify({ version: 1, preferences: { ...DEFAULT_VIEWER_PREFERENCES, ...preferences } });

describe('browser viewer preferences', () => {
  it('opens defaults without writing, then stores only an explicit change', () => {
    const storage = new MemoryStorage(), store = new ViewerPreferenceStore(storage);
    expect(store.getSnapshot()).toMatchObject({ preferences: DEFAULT_VIEWER_PREFERENCES, persistence: 'local' });
    expect(storage.setItem).not.toHaveBeenCalled();
    store.update({ documentComparison: 'redline' });
    expect(store.getSnapshot().preferences.documentComparison).toBe('redline');
    expect(JSON.parse(storage.values.get(VIEWER_PREFERENCES_KEY)!)).toEqual({ version: 1, preferences: { ...DEFAULT_VIEWER_PREFERENCES, documentComparison: 'redline' } });
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it('reopens valid settings and excludes unknown fields without rewriting on load', () => {
    const storage = new MemoryStorage();
    storage.values.set(VIEWER_PREFERENCES_KEY, JSON.stringify({ version: 1, token: 'PRIVATE', preferences: { ...DEFAULT_VIEWER_PREFERENCES, linkedScrolling: false, fileId: 'PRIVATE', workspaceId: 'PRIVATE' } }));
    const store = new ViewerPreferenceStore(storage);
    expect(store.getSnapshot().preferences.linkedScrolling).toBe(false);
    expect(JSON.stringify(store.getSnapshot())).not.toContain('PRIVATE');
    expect(storage.setItem).not.toHaveBeenCalled();
    store.update({ renderQuality: 'economy', secret: 'PRIVATE' } as Partial<ViewerPreferences>);
    expect(storage.values.get(VIEWER_PREFERENCES_KEY)).not.toContain('PRIVATE');
    expect(new ViewerPreferenceStore(storage).getSnapshot().preferences).toEqual({ ...DEFAULT_VIEWER_PREFERENCES, linkedScrolling: false, renderQuality: 'economy' });
  });

  it.each([
    '{corrupt', 'null', '[]',
    JSON.stringify({ version: 1, preferences: { documentComparison: 'visual' } }),
    JSON.stringify({ version: 1, preferences: { linkedScrolling: 'false' } }),
    JSON.stringify({ version: 1, preferences: { renderQuality: 'unbounded' } }),
    ' '.repeat(MAX_PREFERENCE_BYTES + 1),
    JSON.stringify({ version: 1, preferences: {}, extra: 'é'.repeat(2200) }),
  ])('preserves invalid stored bytes while allowing session-only choices: %j', raw => {
    const storage = new MemoryStorage();
    storage.values.set(VIEWER_PREFERENCES_KEY, raw);
    const store = new ViewerPreferenceStore(storage);
    expect(store.getSnapshot().persistence).toBe('blocked');
    store.update({ sourceHighlights: false });
    expect(store.getSnapshot().preferences.sourceHighlights).toBe(false);
    expect(store.getSnapshot().persistence).toBe('blocked');
    expect(storage.values.get(VIEWER_PREFERENCES_KEY)).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('does not downgrade a newer preference format before an explicit reset', () => {
    const storage = new MemoryStorage(), raw = JSON.stringify({ version: 2, preferences: { futureChoice: 'retained' } });
    storage.values.set(VIEWER_PREFERENCES_KEY, raw);
    const store = new ViewerPreferenceStore(storage);
    store.update({ documentComparison: 'redline' });
    expect(store.getSnapshot().persistenceMessage).toContain('newer format');
    expect(storage.values.get(VIEWER_PREFERENCES_KEY)).toBe(raw);
    store.reset();
    expect(store.getSnapshot()).toMatchObject({ preferences: DEFAULT_VIEWER_PREFERENCES, persistence: 'local' });
    expect(storage.values.has(VIEWER_PREFERENCES_KEY)).toBe(false);
    store.update({ linkedScrolling: false });
    expect(JSON.parse(storage.values.get(VIEWER_PREFERENCES_KEY)!).version).toBe(1);
  });

  it('keeps choices usable when storage access or writes are unavailable', () => {
    const absent = new ViewerPreferenceStore();
    absent.update({ renderQuality: 'economy' });
    expect(absent.getSnapshot()).toMatchObject({ persistence: 'session', preferences: { renderQuality: 'economy' } });
    const storage = new MemoryStorage();
    storage.getItem.mockImplementation(() => { throw new Error('Blocked'); });
    const store = new ViewerPreferenceStore(storage);
    store.update({ linkedScrolling: false });
    expect(store.getSnapshot()).toMatchObject({ persistence: 'session', preferences: { linkedScrolling: false } });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('retains failed-write choices and merges them with a later safe external update', () => {
    const storage = new MemoryStorage(), store = new ViewerPreferenceStore(storage);
    storage.setItem.mockImplementationOnce(() => { throw new Error('Quota'); });
    store.update({ linkedScrolling: false });
    expect(store.getSnapshot().persistence).toBe('session');
    storage.values.set(VIEWER_PREFERENCES_KEY, encoded({ documentComparison: 'redline' }));
    store.refresh();
    expect(store.getSnapshot().preferences).toEqual({ ...DEFAULT_VIEWER_PREFERENCES, documentComparison: 'redline', linkedScrolling: false });
    store.update({ sourceHighlights: false });
    expect(store.getSnapshot().persistence).toBe('local');
    expect(new ViewerPreferenceStore(storage).getSnapshot().preferences).toEqual({ ...DEFAULT_VIEWER_PREFERENCES, documentComparison: 'redline', linkedScrolling: false, sourceHighlights: false });
  });

  it('merges sequential changes from another tab before persisting a local field', () => {
    const storage = new MemoryStorage(), first = new ViewerPreferenceStore(storage), second = new ViewerPreferenceStore(storage);
    first.update({ documentComparison: 'redline' });
    second.update({ renderQuality: 'economy' });
    const result = new ViewerPreferenceStore(storage).getSnapshot().preferences;
    expect(result).toMatchObject({ documentComparison: 'redline', renderQuality: 'economy' });
  });

  it('applies cross-tab update/reset notifications without writing them back', () => {
    const storage = new MemoryStorage(), store = new ViewerPreferenceStore(storage), changed = vi.fn();
    const unsubscribe = store.subscribe(changed);
    storage.values.set(VIEWER_PREFERENCES_KEY, encoded({ sourceHighlights: false }));
    store.refresh();
    expect(store.getSnapshot().preferences.sourceHighlights).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    const snapshot = store.getSnapshot();
    store.refresh();
    expect(store.getSnapshot()).toBe(snapshot);
    expect(changed).toHaveBeenCalledOnce();
    storage.values.delete(VIEWER_PREFERENCES_KEY);
    store.refresh();
    expect(store.getSnapshot().preferences).toEqual(DEFAULT_VIEWER_PREFERENCES);
    expect(storage.setItem).not.toHaveBeenCalled();
    unsubscribe();
    storage.values.set(VIEWER_PREFERENCES_KEY, encoded({ renderQuality: 'economy' }));
    store.refresh();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('retains current choices if a later storage event contains unusable data', () => {
    const storage = new MemoryStorage(), store = new ViewerPreferenceStore(storage);
    store.update({ documentComparison: 'redline' });
    storage.values.set(VIEWER_PREFERENCES_KEY, '{corrupt externally');
    store.refresh();
    expect(store.getSnapshot()).toMatchObject({ persistence: 'blocked', preferences: { documentComparison: 'redline' } });
    expect(storage.values.get(VIEWER_PREFERENCES_KEY)).toBe('{corrupt externally');
  });

  it('resets only the preference key and does not touch notes, saved views or launcher settings', () => {
    const storage = new MemoryStorage();
    storage.values.set('assembly-review:workspace', 'existing notes and views');
    storage.values.set('launcher-settings', 'existing launcher');
    const store = new ViewerPreferenceStore(storage);
    store.update({ renderQuality: 'economy' });
    store.reset();
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(VIEWER_PREFERENCES_KEY);
    expect(storage.values.get('assembly-review:workspace')).toBe('existing notes and views');
    expect(storage.values.get('launcher-settings')).toBe('existing launcher');
    expect(store.getSnapshot().preferences).toEqual(DEFAULT_VIEWER_PREFERENCES);
  });

  it('applies reset for the session without destroying stored bytes when removal fails', () => {
    const storage = new MemoryStorage(), raw = encoded({ renderQuality: 'economy' });
    storage.values.set(VIEWER_PREFERENCES_KEY, raw);
    storage.removeItem.mockImplementation(() => { throw new Error('Unavailable'); });
    const store = new ViewerPreferenceStore(storage);
    store.reset();
    expect(store.getSnapshot()).toMatchObject({ preferences: DEFAULT_VIEWER_PREFERENCES, persistence: 'session' });
    expect(storage.values.get(VIEWER_PREFERENCES_KEY)).toBe(raw);
  });

  it('rejects invalid explicit fields and executable accessors before any write', () => {
    const storage = new MemoryStorage(), store = new ViewerPreferenceStore(storage), getter = vi.fn(() => 'economy');
    expect(() => store.update({ renderQuality: 'unbounded' } as unknown as Partial<ViewerPreferences>)).toThrow('Unsupported viewer preference');
    const patch = Object.defineProperty({}, 'renderQuality', { get: getter, enumerable: true });
    expect(() => store.update(patch)).toThrow('Unsupported viewer preference');
    expect(getter).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.getSnapshot().preferences).toEqual(DEFAULT_VIEWER_PREFERENCES);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().preferences)).toBe(true);
  });
});
