/** Assistant transport for the packaged Chrome extension, which has no server.
 * The user's own Claude API key is saved in the extension options and read here, in the
 * viewer page, for each request. Requests go only to the fixed Anthropic Messages endpoint.
 * The key is never written to proposal data, review data, logs, or a launch URL. */
import { ASSISTANT_ERRORS, PlaygroundError, stampAssistantConcepts, validateAssistantPlan as validateWirePlan, validateAssistantRequest } from '../../shared/playground-contract.mjs';
import { createAnthropicAssistant } from '../../shared/playground-provider.mjs';

export const ASSISTANT_SETTING_KEYS = ['assistantApiKey', 'assistantModel', 'assistantShareImages'] as const;
export const DEFAULT_ASSISTANT_MODEL = 'claude-fable-5-2';
export interface ExtensionAssistantSettings { apiKey: string; model: string; shareImages: boolean; }
interface StorageArea { get(keys: readonly string[]): Promise<Record<string, unknown>>; }
interface ExtensionRuntime { storage?: { local?: StorageArea }; runtime?: { openOptionsPage?: () => Promise<void> | void }; }
const runtime = (): ExtensionRuntime | undefined => (globalThis as { chrome?: ExtensionRuntime }).chrome;

export const isExtensionPage = () => typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

/** Same rules as the options page: printable ASCII without spaces, and a fixed-shape model ID. */
export function normalizeAssistantSettings(stored: Record<string, unknown>): ExtensionAssistantSettings | null {
  const apiKey = stored.assistantApiKey, model = stored.assistantModel ?? DEFAULT_ASSISTANT_MODEL;
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey)) return null;
  if (typeof model !== 'string' || !/^claude-[a-z0-9-]{1,80}$/.test(model)) return null;
  return { apiKey, model, shareImages: stored.assistantShareImages === true };
}

export async function readExtensionAssistantSettings(storage: StorageArea | undefined = runtime()?.storage?.local): Promise<ExtensionAssistantSettings | null> {
  if (!storage) return null;
  try { return normalizeAssistantSettings(await storage.get(ASSISTANT_SETTING_KEYS)); }
  catch { return null; }
}

export async function openAssistantSettings(): Promise<boolean> {
  try { const open = runtime()?.runtime?.openOptionsPage; if (!open) return false; await open.call(runtime()!.runtime); return true; }
  catch { return false; }
}

export class ExtensionAssistantFailure extends Error {
  override name = 'ExtensionAssistantFailure';
  constructor(readonly code: string, message: string) { super(message); }
}

/** Validate, send, and validate again. Returns the same wire shape the server route returns. */
export async function proposeFromExtension(body: Record<string, unknown>, settings: ExtensionAssistantSettings, options: { signal?: AbortSignal; fetcher?: typeof fetch } = {}): Promise<Record<string, unknown>> {
  try {
    const request = validateAssistantRequest(body);
    if (request.image !== undefined && !settings.shareImages) throw new PlaygroundError('FORBIDDEN');
    const assistant = createAnthropicAssistant({ apiKey: settings.apiKey, model: settings.model, directBrowser: true, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
    const plan = stampAssistantConcepts(validateWirePlan(await assistant.propose(request, { signal: options.signal }), request), request);
    return { requestId: crypto.randomUUID(), proposalId: request.proposalId, proposalVersion: request.proposalVersion, sourceKey: request.sourceKey, ...plan };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const code = error instanceof PlaygroundError ? error.code : 'UPSTREAM_ERROR';
    const message = code === 'FORBIDDEN' ? 'Image sharing is turned off in the extension options. Turn it on there, or send the request without an image.'
      : code === 'UPSTREAM_ERROR' ? 'Claude could not be reached or did not complete this request. Check your network connection and the model ID in the extension options. Your proposal is unchanged.'
      : (ASSISTANT_ERRORS[code] ?? ASSISTANT_ERRORS.UPSTREAM_ERROR)[1];
    throw new ExtensionAssistantFailure(code, message);
  }
}
