const SOURCE_PARAMETERS = ['revision', 'parentItemId', 'parentRevision', 'configurationId', 'baselineRevision', 'baselineConfigurationId', 'edition', 'sourceHash', 'view', 'compare'];
const LAUNCH_PARAMETERS = ['mode', 'workspaceId', 'itemId', 'fileId', ...SOURCE_PARAMETERS];
// Connection and content guards belong to protected delivery URLs, never new launches.
const VIEWER_PARAMETERS = [...LAUNCH_PARAMETERS, 'connectionId', 'contentHash'];
const CREDENTIAL_PARAMETERS = new Set(['token', 'accesstoken', 'refreshtoken', 'idtoken', 'authorization', 'auth', 'apikey', 'xapikey', 'secret', 'clientsecret', 'password', 'session', 'sessionid', 'code', 'state']);

const PREVIEW_EXAMPLES = Object.freeze({
  pdf: { fileId: 'atlas-spec-B-pdf' },
  word: { fileId: 'atlas-spec-B-docx' },
  compare: { fileId: 'atlas-spec-B-pdf', compare: 'true' },
  model: { fileId: 'step:assembly:B' },
  together: { fileId: 'step:base:B', view: 'together' },
});

/** A packaged Preview never depends on a stored hosted viewer URL or live IDs. */
export function previewTarget(extensionViewerUrl, example = 'pdf') {
  const target = new URL(extensionViewerUrl);
  if (target.protocol !== 'chrome-extension:' || !/^[a-p]{32}$/.test(target.hostname) || target.pathname !== '/viewer.html' || target.username || target.password) throw new Error('Open Preview from the installed Review Studio extension.');
  if (!Object.hasOwn(PREVIEW_EXAMPLES, example)) throw new Error('Choose an available Preview example.');
  target.search = '';
  target.hash = '';
  for (const [key, value] of Object.entries({ mode: 'preview', ...PREVIEW_EXAMPLES[example] })) target.searchParams.set(key, value);
  return target;
}

/** Retain deployment parameters, but never inherit source context from a saved URL. */
export function viewerTarget(viewerUrl, context) {
  const target = new URL(viewerUrl);
  if (target.username || target.password || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname)))) {
    throw new Error('Use an HTTPS viewer URL, or HTTP on localhost. Do not include credentials.');
  }
  if ([...target.searchParams.keys()].some(key => CREDENTIAL_PARAMETERS.has(key.toLowerCase().replace(/[-_.\s]/g, '')))) {
    throw new Error('Use the viewer application URL without sign-in codes, tokens, or API credentials. Sign-in is handled by the viewer server.');
  }
  for (const key of VIEWER_PARAMETERS) target.searchParams.delete(key);
  target.hash = '';
  for (const [key, value] of Object.entries(context)) {
    if (!LAUNCH_PARAMETERS.includes(key)) throw new Error('Only explicit viewer source context may be passed by the launcher.');
    if (value !== undefined && value !== '') target.searchParams.set(key, String(value));
  }
  return target;
}

/** Read only explicit launch parameters; no Arena route or revision is inferred. */
export function arenaContext(sourceUrl, workspaceId) {
  const source = new URL(sourceUrl);
  function parameter(...names) {
    const values = names.flatMap(name => source.searchParams.getAll(name));
    if (values.length > 1) throw new Error('This Arena link contains ambiguous source context. Open an exact item or file link.');
    if (values.length && (!values[0] || values[0] !== values[0].trim() || values[0].length > 512 || /[\u0000-\u001f\u007f]/.test(values[0]))) throw new Error('This Arena link contains invalid source context. Open an exact item or file link.');
    return values[0];
  }
  const itemId = parameter('itemId', 'itemGUID');
  if (!itemId) throw new Error('This Arena URL did not include explicit item context. Enter the item GUID, or configure an Arena launch action with itemId and fileId parameters.');
  const context = { mode: 'arena', workspaceId, itemId };
  const fileId = parameter('fileId', 'fileGUID');
  if (fileId !== undefined) context.fileId = fileId;
  for (const key of SOURCE_PARAMETERS) {
    const value = parameter(key);
    if (value !== undefined) context[key] = value;
  }
  return context;
}
