import { arenaContext, viewerTarget } from './launch-url.js';

export const ARENA_APPLICATION_ORIGINS = Object.freeze([
  'https://app.bom.com', 'https://app.arenagov.com',
  'https://app.europe.arenaplm.com', 'https://app.uk.arenaplm.com',
]);
export const ARENA_APPLICATION_PATTERNS = Object.freeze(ARENA_APPLICATION_ORIGINS.map(origin => `${origin}/*`));
const SOURCE_KEYS = new Set(['mode', 'workspaceId', 'itemId', 'fileId', 'revision', 'parentItemId', 'parentRevision', 'configurationId', 'baselineRevision', 'baselineConfigurationId', 'edition', 'sourceHash', 'view', 'compare']);
const SUPPORTED = new Set(['step', 'pdf', 'docx']);

export function isArenaApplicationUrl(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && ARENA_APPLICATION_ORIGINS.includes(url.origin);
  } catch { return false; }
}

function sourceKind(url) {
  const candidates = [];
  const inspectName = value => {
    const match = value.match(/\.(step|stp|pdf|docx)$/i);
    if (match) candidates.push(match[1].toLowerCase() === 'stp' ? 'step' : match[1].toLowerCase());
  };
  inspectName(decodeURIComponent(url.pathname));
  const names = ['fileName', 'filename'];
  const values = names.flatMap(name => url.searchParams.getAll(name));
  if (values.length > 1) return null;
  for (const value of values) inspectName(value);
  const formats = ['kind', 'format'].flatMap(name => url.searchParams.getAll(name));
  if (formats.length > 1) return null;
  for (const format of formats) {
    const kind = format.toLowerCase().replace(/^\./, '');
    if (!['step', 'stp', 'pdf', 'docx'].includes(kind)) return null;
    candidates.push(kind === 'stp' ? 'step' : kind);
  }
  return candidates.length && new Set(candidates).size === 1 ? candidates[0] : null;
}

function assertSettings(settings) {
  if (settings?.autoOpenAttachments !== true) throw new Error('Automatic attachment opening is turned off.');
  if (typeof settings.workspaceId !== 'string' || !settings.workspaceId || settings.workspaceId !== settings.workspaceId.trim() || settings.workspaceId.length > 200 || /[\u0000-\u001f\u007f]/.test(settings.workspaceId)) throw new Error('Configure your exact Arena workspace ID before enabling automatic opening.');
  if (typeof settings.viewerUrl !== 'string' || !settings.viewerUrl) throw new Error('Configure the authenticated Arena viewer URL before enabling automatic opening.');
  viewerTarget(settings.viewerUrl, {});
}

function assertExactContext(context, workspaceId, kind) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some(key => !SOURCE_KEYS.has(key))) throw new Error('This attachment has invalid source context.');
  if (context.mode !== 'arena' || context.workspaceId !== workspaceId || !SUPPORTED.has(kind)) throw new Error('This attachment does not match the configured Arena connection.');
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('This attachment has invalid source context.');
    if (key === 'view' && !['documents', 'model', 'together'].includes(value)) throw new Error('This attachment requests an unavailable view.');
    if (key === 'compare' && !['true', 'false', '1', '0'].includes(value)) throw new Error('This attachment requests an invalid comparison.');
  }
  if (!context.itemId || !context.fileId || !context.revision || !context.edition || !/^[a-f0-9]{64}$/.test(context.sourceHash ?? '')) throw new Error('Automatic opening needs an exact item, revision, file edition and source hash. Use the context menu when this link does not supply them.');
  if (context.revision.length > 100 || context.view === 'model' && kind !== 'step' || context.view === 'documents' && kind === 'step') throw new Error('This attachment does not match the requested view.');
  return { ...context };
}

/** Pure recognition. A null result means let Arena perform its original action. */
export function recognizeAttachmentAction(href, settings) {
  try {
    assertSettings(settings);
    if (typeof href !== 'string' || href.length > 8192 || !isArenaApplicationUrl(href)) return null;
    const source = new URL(href);
    const kind = sourceKind(source);
    if (!kind) return null;
    const workspaces = source.searchParams.getAll('workspaceId');
    if (workspaces.length > 1 || workspaces.length === 1 && workspaces[0] !== settings.workspaceId) return null;
    const context = assertExactContext(arenaContext(href, settings.workspaceId), settings.workspaceId, kind);
    return { type: 'review-studio-open-attachment', kind, context };
  } catch { return null; }
}

/** Background validation repeats checks after storage or page state may change. */
export function validateAttachmentMessage(message, settings) {
  assertSettings(settings);
  if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(key => !['type', 'kind', 'context'].includes(key)) || message.type !== 'review-studio-open-attachment') throw new Error('This attachment action is invalid.');
  return assertExactContext(message.context, settings.workspaceId, message.kind);
}

export function isPlainAttachmentClick(event) {
  return !event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}
