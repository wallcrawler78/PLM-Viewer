import type { CameraState, PlaygroundCommand, Proposal, ProposalHistory, ProposalContext } from './types';
import { applyCommands, validateCommands, validateProposal } from './state';
import { discardResponse, readBoundedJson, withAbort } from '../integrations/responseBody';
import { invalidateViewerSession } from '../integrations/protectedContent';
import { draftEcrFromExtension, ExtensionAssistantFailure, isExtensionPage, proposeFromExtension, readExtensionAssistantSettings } from './extension-assistant';
import type { EcrDraft } from './extension-assistant';
import { proposalChanges } from './state';
export type { EcrDraft };

/** One turn of this session's exchange with the assistant. Kept in memory for the session only. */
export interface ConversationTurn { role: 'user' | 'assistant'; text: string; outcome?: 'applied' | 'dismissed' | 'question' | 'pending'; }
const wireHistory = (turns: readonly ConversationTurn[] = []) => turns.slice(-20).map(turn => ({ role: turn.role, text: turn.text.slice(0, 2000), ...(turn.outcome ? { outcome: turn.outcome } : {}) })).filter(turn => turn.text.trim());

export interface AssistantStatus {
  configured: boolean;
  available: boolean;
  state: 'unconfigured' | 'ready' | 'restricted' | 'extension';
  provider?: string;
  model?: string;
  imagesAllowed: boolean;
  liveEcr: false;
  connectionId?: string;
  message: string;
}
export interface AssistantDisplay {
  explode?: number;
  labels?: boolean;
  view?: 'proposed' | 'original' | 'overlay';
  hiddenIds?: string[];
}
export interface AssistantPlan {
  requestId: string;
  proposalId: string;
  proposalVersion: number;
  sourceKey: string;
  summary: string;
  commands: PlaygroundCommand[];
  assumptions: string[];
  questions: string[];
  display?: AssistantDisplay;
}
export type AssistantImageContext =
  | { kind: 'model'; camera: CameraState; presentation?: AssistantDisplay & { opacityById?: Record<string, number>; studio?: boolean } }
  | { kind: 'document'; fileId: string; itemId: string; revision: string; edition: string; sourceHash: string; page: number };
export interface AssistantRequestOptions {
  selectedId?: string;
  /** Explicitly selected PNG/JPEG screenshot. No file or image is uploaded implicitly. */
  image?: string;
  imageContext?: AssistantImageContext;
  annotationIds?: string[];
  /** Earlier turns of this session, so a follow-up such as "a bit more" can be understood. */
  history?: readonly ConversationTurn[];
  connectionId?: string;
  signal?: AbortSignal;
}
export class AssistantError extends Error {
  override name = 'AssistantError';
  constructor(message: string, readonly code = 'UNAVAILABLE') { super(message); }
}
const PREFIX = '/api/viewer/v1/playground/';
const extension = isExtensionPage;
const unavailable = (state: 'extension' | 'unconfigured' = 'unconfigured'): AssistantStatus => ({ configured: false, available: false, state, imagesAllowed: false, liveEcr: false, message: state === 'extension' ? 'Add your Claude API key in the extension options to use the assistant. Local Playground tools work without it.' : 'AI is not connected. Drawing, editing, comparison and Preview ECR tools work locally.' });
/** The packaged extension has no server: it calls Claude directly with the user's saved key. */
async function extensionStatus(): Promise<AssistantStatus> {
  const settings = await readExtensionAssistantSettings();
  if (!settings) return unavailable('extension');
  return { configured: true, available: true, state: 'ready', provider: 'anthropic', model: settings.model, imagesAllowed: settings.shareImages, liveEcr: false, message: 'Requests go from this browser directly to Anthropic using the API key saved in the extension options, and are billed to that key.' };
}
const string = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const invalid = () => new AssistantError('The assistant returned unsupported data. Your proposal is unchanged.', 'INVALID_PLAN');

async function readService(path: string, options: { signal?: AbortSignal; connectionId?: string; body?: string; fetcher?: typeof fetch } = {}): Promise<unknown> {
  if (extension()) throw new AssistantError(unavailable('extension').message, 'UNCONFIGURED');
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), options.body ? 95_000 : 15_000);
  let response: Response | undefined;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.connectionId) headers['X-Viewer-Connection'] = options.connectionId;
    if (options.body) { headers['Content-Type'] = 'application/json'; headers['X-Playground-Request'] = '1'; }
    response = await withAbort<Response>((options.fetcher ?? fetch)(`${PREFIX}${path}`, { method: options.body ? 'POST' : 'GET', headers, body: options.body, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }).then(result => { if (signal.aborted) { discardResponse(result); signal.throwIfAborted(); } return result; }), signal);
    if (!response.ok) {
      const messages: Record<number, string> = { 401: 'Reconnect your authorized Arena account before using the assistant.', 403: 'AI sharing is not enabled for this user, source, or viewer origin.', 409: 'Your Arena connection changed. Reopen the source.', 413: 'The assistant request is too large. Use a smaller image or fewer annotations.', 429: 'The assistant is busy or its request budget is reached. Try again shortly.', 503: unavailable().message, 504: 'The assistant timed out. Your proposal is unchanged.' };
      if (options.connectionId && [401, 409].includes(response.status)) invalidateViewerSession({ code: response.status === 401 ? 'AUTH_REQUIRED' : 'CONNECTION_CHANGED', message: messages[response.status], connectionId: options.connectionId });
      throw new AssistantError(messages[response.status] ?? 'The assistant could not complete this request. Your proposal is unchanged.', `HTTP_${response.status}`);
    }
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new AssistantError(unavailable().message, 'UNCONFIGURED');
    const data = await readBoundedJson<unknown>(response, 2 * 1024 * 1024, signal);
    const inactiveStatus = path.startsWith('status?') && object(data) && data.available === false;
    if (options.connectionId && response.headers.get('X-Viewer-Connection') !== options.connectionId && !inactiveStatus) {
      const message = 'The assistant response belongs to a different or unverified Arena connection.';
      invalidateViewerSession({ code: 'CONNECTION_CHANGED', message, connectionId: options.connectionId });
      throw new AssistantError(message, 'CONNECTION_CHANGED');
    }
    return data;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (timeout.signal.aborted) throw new AssistantError('The assistant request timed out. Your proposal is unchanged.', 'TIMEOUT');
    if (error instanceof AssistantError) throw error;
    throw new AssistantError('The assistant service could not be reached. Local Playground tools remain available.');
  } finally { clearTimeout(timer); discardResponse(response); }
}

export async function readAssistantStatus(context: Pick<ProposalContext, 'sourceMode' | 'workspaceId'> & { connectionId?: string }, signal?: AbortSignal, fetcher?: typeof fetch): Promise<AssistantStatus> {
  if (extension()) return extensionStatus();
  try {
    const params = new URLSearchParams({ sourceMode: context.sourceMode, workspaceId: context.workspaceId });
    const value = await readService(`status?${params}`, { signal, connectionId: context.connectionId, fetcher });
    if (!object(value) || typeof value.configured !== 'boolean' || typeof value.available !== 'boolean' || !['unconfigured', 'ready', 'restricted'].includes(value.state as string) || typeof value.imagesAllowed !== 'boolean' || value.liveEcr !== false || !string(value.message) || value.provider !== undefined && !string(value.provider, 80) || value.model !== undefined && !string(value.model, 120)) throw invalid();
    if (value.available && (!value.configured || value.state !== 'ready' || !value.provider || !value.model)) throw invalid();
    return value as unknown as AssistantStatus;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof AssistantError && ['HTTP_404', 'UNCONFIGURED', 'UNAVAILABLE'].includes(error.code)) return unavailable();
    throw error;
  }
}

export function validateAssistantPlan(input: unknown, proposal: Proposal): AssistantPlan {
  if (!object(input) || !only(input, ['requestId', 'proposalId', 'proposalVersion', 'sourceKey', 'summary', 'commands', 'assumptions', 'questions', 'display']) || !string(input.requestId, 512) || !string(input.summary) || input.proposalId !== proposal.id || input.proposalVersion !== proposal.version || input.sourceKey !== proposal.sourceKey) throw new AssistantError('This suggestion belongs to an earlier proposal or another source. Ask for a fresh suggestion.', 'STALE_PLAN');
  const sentences = (value: unknown, max: number): string[] => { if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || v.length > 2000)) throw invalid(); return value; };
  let commands: PlaygroundCommand[];
  try { commands = validateCommands(input.commands); if (commands.length > 40) throw invalid(); }
  catch { throw invalid(); }
  let display: AssistantDisplay | undefined;
  if (input.display !== undefined && input.display !== null) {
    const d = input.display;
    if (!object(d) || !only(d, ['explode', 'labels', 'view', 'hiddenIds']) || d.explode !== undefined && (typeof d.explode !== 'number' || !Number.isFinite(d.explode) || d.explode < 0 || d.explode > 1) || d.labels !== undefined && typeof d.labels !== 'boolean' || d.view !== undefined && !['proposed', 'original', 'overlay'].includes(d.view as string)) throw invalid();
    const ids = new Set([...proposal.nodes.map(node => node.id), ...commands.flatMap(command => command.type === 'add' ? [command.node.id] : [])]);
    if (d.hiddenIds !== undefined && (!Array.isArray(d.hiddenIds) || d.hiddenIds.length > 200 || d.hiddenIds.some(id => typeof id !== 'string' || !ids.has(id)))) throw invalid();
    display = d as AssistantDisplay;
  }
  const assumptions = sentences(input.assumptions, 40), questions = sentences(input.questions, 10);
  if (questions.length && (commands.length || display && Object.keys(display).length)) throw invalid();
  // Validate the complete transaction without mutating the current proposal.
  try { applyCommands({ past: [], present: proposal, future: [] }, commands); } catch { throw invalid(); }
  return { requestId: input.requestId, proposalId: proposal.id, proposalVersion: proposal.version, sourceKey: proposal.sourceKey, summary: input.summary, commands, assumptions, questions, ...(display ? { display } : {}) };
}

export async function requestAssistantPlan(proposal: Proposal, prompt: string, options: AssistantRequestOptions = {}, fetcher?: typeof fetch): Promise<AssistantPlan> {
  const current = validateProposal(proposal);
  if (!prompt.trim() || prompt.length > 8000) throw new AssistantError('Enter a design request of up to 8,000 characters.', 'INVALID_REQUEST');
  if (current.nodes.length > 200 || current.annotations.length > 100) throw new AssistantError('AI context currently supports 200 components and 100 marks per proposal. Local editing remains available.', 'TOO_LARGE');
  if (options.selectedId && !current.nodes.some(node => node.id === options.selectedId)) throw new AssistantError('Select an available component before asking about it.', 'INVALID_REQUEST');
  if (options.image && (!options.imageContext || options.image.length > 2_800_000 || !/^data:image\/(png|jpeg);base64,/.test(options.image))) throw new AssistantError('Attach a PNG/JPEG view of at most 2 MiB with its source context.', 'TOO_LARGE');
  let imageContext = options.imageContext;
  if (imageContext?.kind === 'model' && imageContext.presentation) {
    const ids = new Set(current.nodes.map(node => node.id)), p = imageContext.presentation;
    // Undo can leave harmless display entries for a removed concept. Send only visible-scene identities.
    imageContext = { ...imageContext, presentation: { ...p, ...(p.hiddenIds ? { hiddenIds: p.hiddenIds.filter(id => ids.has(id)) } : {}), ...(p.opacityById ? { opacityById: Object.fromEntries(Object.entries(p.opacityById).filter(([id]) => ids.has(id))) } : {}) } };
  }
  const body = JSON.stringify({ proposalId: current.id, proposalVersion: current.version, sourceKey: current.sourceKey, context: current.context, baseline: current.baseline.map(({ sourceBinding: _binding, ...node }) => node), nodes: current.nodes.map(({ sourceBinding: _binding, ...node }) => node), annotations: current.annotations, prompt: prompt.trim(), ...(options.selectedId ? { selectedId: options.selectedId } : {}), ...(options.annotationIds ? { annotationIds: options.annotationIds } : {}), ...(options.image ? { image: options.image, imageContext } : {}), ...(wireHistory(options.history).length ? { history: wireHistory(options.history) } : {}) });
  if (new TextEncoder().encode(body).length > 4 * 1024 * 1024) throw new AssistantError('This assistant request is too large. Use a smaller image or fewer annotations.', 'TOO_LARGE');
  if (extension()) {
    const settings = await readExtensionAssistantSettings();
    if (!settings) throw new AssistantError(unavailable('extension').message, 'UNCONFIGURED');
    const timeout = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), 95_000);
    try { return validateAssistantPlan(await proposeFromExtension(JSON.parse(body), settings, { signal, fetcher }), current); }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (timeout.signal.aborted) throw new AssistantError('The assistant request timed out. Your proposal is unchanged.', 'TIMEOUT');
      if (error instanceof ExtensionAssistantFailure) throw new AssistantError(error.message, error.code);
      throw error;
    } finally { clearTimeout(timer); }
  }
  return validateAssistantPlan(await readService('propose', { body, signal: options.signal, connectionId: options.connectionId, fetcher }), current);
}

/** Apply only after explicit review; display changes are handled separately by the UI. */
export function applyAssistantPlan(history: ProposalHistory, plan: AssistantPlan): ProposalHistory {
  const validated = validateAssistantPlan(plan, history.present);
  return applyCommands(history, validated.commands, { expectedVersion: validated.proposalVersion, expectedSourceKey: validated.sourceKey });
}

/** Draft the ECR title and description from the accepted changes, the numbered markups and the session's
 * turns. Available where the assistant runs in the browser with the user's own key. Returns a suggestion only. */
export async function requestEcrDraft(proposal: Proposal, options: { title: string; history?: readonly ConversationTurn[]; signal?: AbortSignal } , fetcher?: typeof fetch): Promise<EcrDraft> {
  const current = validateProposal(proposal);
  if (!extension()) throw new AssistantError('Drafting with Claude is available in the Chrome extension after you add a Claude API key in its options.', 'UNCONFIGURED');
  const settings = await readExtensionAssistantSettings();
  if (!settings) throw new AssistantError(unavailable('extension').message, 'UNCONFIGURED');
  const changes = proposalChanges(current).map(change => ({ component: `${change.itemNumber ?? 'Concept part'} — ${change.name}`.slice(0, 400), ...(change.revision ? { revision: change.revision } : {}), kind: change.kind, summary: change.summary.slice(0, 4000) }));
  const markups = current.annotations.slice(0, 100).map((mark, index) => ({ number: index + 1, type: mark.type, instruction: mark.label, source: mark.target.type === 'document' ? `Drawing ${mark.target.fileId}, revision ${mark.target.revision}, page ${mark.target.page}`.slice(0, 400) : mark.anchors?.every(Boolean) ? 'Pinned to a model surface' : 'Drawn over a saved model view' }));
  if (!changes.length && !markups.length) throw new AssistantError('Make a change or add a markup first. There is nothing to describe yet.', 'INVALID_REQUEST');
  const assumptions = Array.from(new Set(current.nodes.filter(node => node.kind !== 'source' && !node.removed).flatMap(node => node.provenance?.assumptions ?? []))).slice(0, 40).map(text => text.slice(0, 2000));
  const body = { context: current.context, title: (options.title.trim() || current.title).slice(0, 300), changes, markups, assumptions, history: wireHistory(options.history) };
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), 95_000);
  try { return await draftEcrFromExtension(body, settings, { signal, fetcher }); }
  catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (timeout.signal.aborted) throw new AssistantError('The drafting request timed out. Your description is unchanged.', 'TIMEOUT');
    if (error instanceof ExtensionAssistantFailure) throw new AssistantError(error.message, error.code);
    throw error;
  } finally { clearTimeout(timer); }
}
