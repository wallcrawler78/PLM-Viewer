/** Non-sensitive browser defaults only. Exact sources and review state belong elsewhere. */
export interface ViewerPreferences {
  documentComparison: 'pages' | 'redline';
  linkedScrolling: boolean;
  sourceHighlights: boolean;
  renderQuality: 'standard' | 'economy';
}
export const DEFAULT_VIEWER_PREFERENCES: Readonly<ViewerPreferences> = Object.freeze({
  documentComparison: 'pages', linkedScrolling: true, sourceHighlights: true, renderQuality: 'standard',
});
export const VIEWER_PREFERENCES_KEY = 'review-studio.preferences.v1';
export const MAX_PREFERENCE_BYTES = 4096;
export type PreferencePersistence = 'local' | 'session' | 'blocked';
export interface PreferenceSnapshot {
  readonly preferences: Readonly<ViewerPreferences>;
  readonly persistence: PreferencePersistence;
  readonly persistenceMessage: string;
}
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const keys = ['documentComparison', 'linkedScrolling', 'sourceHighlights', 'renderQuality'] as const;
const messages = {
  local: 'Preferences are saved only in this browser.',
  session: 'Browser storage is unavailable. Your choices apply to this session.',
  invalid: 'Saved preferences could not be read. Your choices apply to this session; reset preferences to replace the saved settings.',
  future: 'Saved preferences use a newer format. Your choices apply to this session; reset preferences to replace the saved settings.',
} as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function validField(key: keyof ViewerPreferences, value: unknown): boolean {
  if (key === 'documentComparison') return value === 'pages' || value === 'redline';
  if (key === 'renderQuality') return value === 'standard' || value === 'economy';
  return typeof value === 'boolean';
}
function closedPatch(value: unknown): Partial<ViewerPreferences> {
  if (!record(value)) throw new Error('Unsupported viewer preferences.');
  const result: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(value, key)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !validField(key, descriptor.value)) throw new Error('Unsupported viewer preference.');
    result[key] = descriptor.value;
  }
  return result as Partial<ViewerPreferences>;
}
type ReadResult = { kind: 'valid'; preferences: ViewerPreferences } | { kind: 'invalid' | 'future' | 'unavailable' };
function decode(raw: string | null): ReadResult {
  if (raw === null) return { kind: 'valid', preferences: { ...DEFAULT_VIEWER_PREFERENCES } };
  if (raw.length > MAX_PREFERENCE_BYTES || new TextEncoder().encode(raw).byteLength > MAX_PREFERENCE_BYTES) return { kind: 'invalid' };
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value)) return { kind: 'invalid' };
    if (Number.isSafeInteger(value.version) && Number(value.version) > 1) return { kind: 'future' };
    if (value.version !== 1 || !record(value.preferences)) return { kind: 'invalid' };
    return { kind: 'valid', preferences: { ...DEFAULT_VIEWER_PREFERENCES, ...closedPatch(value.preferences) } };
  } catch { return { kind: 'invalid' }; }
}
function encode(preferences: Readonly<ViewerPreferences>): string {
  return JSON.stringify({ version: 1, preferences: closedPatch(preferences) });
}
const samePreferences = (a: Readonly<ViewerPreferences>, b: Readonly<ViewerPreferences>) => keys.every(key => a[key] === b[key]);

/**
 * Only explicit changes write. Corrupt/future data is preserved until Reset.
 * Failed writes retain session overrides. A later edit merges the latest valid
 * storage plus those overrides, avoiding sequential cross-tab lost updates.
 * This is convenience storage, not a transactional or account-synced service.
 */
export class ViewerPreferenceStore {
  private snapshot: PreferenceSnapshot;
  private readonly listeners = new Set<() => void>();
  private overrides: Partial<ViewerPreferences> = {};

  constructor(private readonly storage?: PreferenceStorage) {
    this.snapshot = Object.freeze({ preferences: DEFAULT_VIEWER_PREFERENCES, persistence: 'session', persistenceMessage: messages.session });
    this.refresh();
  }
  getSnapshot = (): PreferenceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private read(): ReadResult {
    if (!this.storage) return { kind: 'unavailable' };
    try { return decode(this.storage.getItem(VIEWER_PREFERENCES_KEY)); }
    catch { return { kind: 'unavailable' }; }
  }
  private publish(preferences: ViewerPreferences | Readonly<ViewerPreferences>, persistence: PreferencePersistence, persistenceMessage: string): void {
    if (samePreferences(preferences, this.snapshot.preferences) && persistence === this.snapshot.persistence && persistenceMessage === this.snapshot.persistenceMessage) return;
    this.snapshot = Object.freeze({ preferences: Object.freeze({ ...preferences }), persistence, persistenceMessage });
    for (const listener of this.listeners) listener();
  }
  private fromRead(read: ReadResult): void {
    if (read.kind === 'valid') {
      const pending = Object.keys(this.overrides).length > 0;
      this.publish({ ...read.preferences, ...this.overrides }, pending ? 'session' : 'local', pending ? messages.session : messages.local);
    } else {
      this.publish(this.snapshot.preferences, read.kind === 'unavailable' ? 'session' : 'blocked', read.kind === 'unavailable' ? messages.session : messages[read.kind]);
    }
  }
  /** Used for storage events; it never echoes a change back into storage. */
  refresh = (): void => { this.fromRead(this.read()); };

  update = (patch: Partial<ViewerPreferences>): void => {
    const safe = closedPatch(patch);
    if (!Object.keys(safe).length) return;
    this.overrides = { ...this.overrides, ...safe };
    const read = this.read();
    const preferences = { ...(read.kind === 'valid' ? read.preferences : this.snapshot.preferences), ...this.overrides };
    if (read.kind === 'valid' && this.storage) {
      try {
        this.storage.setItem(VIEWER_PREFERENCES_KEY, encode(preferences));
        this.overrides = {};
        this.publish(preferences, 'local', messages.local);
        return;
      } catch { this.publish(preferences, 'session', messages.session); return; }
    }
    this.publish(preferences, read.kind === 'unavailable' ? 'session' : 'blocked', read.kind === 'unavailable' ? messages.session : read.kind === 'valid' ? messages.session : messages[read.kind]);
  };

  /** Explicitly replaces only preferences; never clears reviews, sources or other keys. */
  reset = (): void => {
    this.overrides = { ...DEFAULT_VIEWER_PREFERENCES };
    if (this.storage) {
      try {
        this.storage.removeItem(VIEWER_PREFERENCES_KEY);
        this.overrides = {};
        this.publish(DEFAULT_VIEWER_PREFERENCES, 'local', messages.local);
        return;
      } catch { /* Keep defaults for this session, preserving the saved bytes. */ }
    }
    this.publish(DEFAULT_VIEWER_PREFERENCES, 'session', messages.session);
  };
}
