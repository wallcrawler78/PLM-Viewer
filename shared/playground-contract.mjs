/** Fixed data contract for AI-assisted visual proposals. No executable output is accepted.
 * Runs unchanged in Node and in the browser: no Node-only APIs. */
export const ASSISTANT_LIMITS = Object.freeze({ requestBytes: 4 * 1024 * 1024, responseBytes: 512 * 1024, imageBytes: 2 * 1024 * 1024, nodes: 200, annotations: 100, commands: 40, timeoutMs: 90_000 });

export class PlaygroundError extends Error {
  constructor(code = 'INVALID_REQUEST') { super(code); this.name = 'PlaygroundError'; this.code = code; }
}
export const ASSISTANT_ERRORS = Object.freeze({
  INVALID_REQUEST: [400, 'The assistant request is invalid or exceeds the supported scene limits.'],
  AUTH_REQUIRED: [401, 'Reconnect your authorized Arena account before using the assistant.'],
  FORBIDDEN: [403, 'AI sharing is not enabled for this user, source, or viewer origin.'],
  CONNECTION_CHANGED: [409, 'Your Arena connection changed. Reopen the source before using the assistant.'],
  TOO_LARGE: [413, 'The assistant request is too large. Use a smaller view or fewer annotations.'],
  BUSY: [429, 'The assistant is busy or its local request budget is reached. Try again shortly.'],
  KEY_REJECTED: [502, 'The AI provider rejected the saved API key. Check it in the extension options.'],
  REFUSED: [502, 'The AI provider declined this request. Your proposal is unchanged. Rephrase the request or remove the attached image.'],
  UNCONFIGURED: [503, 'The AI connection is not configured. Local Playground tools remain available.'],
  INVALID_PLAN: [502, 'The assistant returned an unsupported proposal. Your current proposal is unchanged.'],
  UPSTREAM_ERROR: [502, 'The AI provider could not complete this request. Your proposal is unchanged.'],
  TIMEOUT: [504, 'The assistant request timed out. Your proposal is unchanged.'],
  NOT_FOUND: [404, 'This Playground service operation is unavailable.'],
  METHOD_NOT_ALLOWED: [405, 'This Playground operation does not support that request method.'],
});
export function assistantFailure(error) {
  let code = error instanceof PlaygroundError ? error.code : 'UPSTREAM_ERROR';
  if (error?.code === 'UNAUTHENTICATED') code = 'AUTH_REQUIRED';
  if (['FORBIDDEN', 'CONNECTION_CHANGED', 'FEATURE_NOT_ENABLED'].includes(error?.code)) code = error.code === 'FEATURE_NOT_ENABLED' ? 'FORBIDDEN' : error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') code = 'TIMEOUT';
  const [status, message] = ASSISTANT_ERRORS[code] ?? ASSISTANT_ERRORS.UPSTREAM_ERROR;
  return { status, body: { code, error: message } };
}
const fail = () => { throw new PlaygroundError(); };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value; };
const keys = (value, names) => { object(value); if (Object.keys(value).some(key => !names.includes(key))) fail(); };
const text = (value, max = 512, empty = false) => { if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(); return value; };
const number = (value, min, max) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(); return value; };
const vector = value => { if (!Array.isArray(value) || value.length !== 3) fail(); value.forEach(v => number(v, -1_000_000, 1_000_000)); };
const color = value => { if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) fail(); };
const list = (value, max) => { if (!Array.isArray(value) || value.length > max) fail(); return value; };
const strings = (value, max = 40) => list(value, max).map(v => text(v, 2000, true));

function dimensions(value, kind) {
  keys(value, ['width', 'depth', 'height', 'thickness', 'holeDiameter', 'holeX', 'holeY']);
  if (kind && kind !== 'bracket' && Object.keys(value).some(key => !['width', 'depth', 'height'].includes(key))) fail();
  for (const field of ['width', 'depth', 'height']) number(value[field], 0.01, 100_000);
  if (value.thickness !== undefined) number(value.thickness, 0.01, 100_000);
  if (value.holeDiameter !== undefined) number(value.holeDiameter, 0, 100_000);
  for (const field of ['holeX', 'holeY']) if (value[field] !== undefined) number(value[field], -100_000, 100_000);
}
function documentIdentity(value, target = false) {
  keys(value, target ? ['kind', 'type', 'fileId', 'itemId', 'revision', 'edition', 'sourceHash', 'page'] : ['fileId', 'itemId', 'revision', 'edition', 'sourceHash', 'kind']);
  for (const key of ['fileId', 'itemId', 'revision', 'edition']) text(value[key]);
  if (!/^[a-f\d]{64}$/i.test(value.sourceHash)) fail();
  if (target) { number(value.page, 1, 100_000); if (!Number.isInteger(value.page)) fail(); }
  else if (!['pdf', 'docx'].includes(value.kind)) fail();
}
function node(value, added = false) {
  keys(value, ['id', 'name', 'itemId', 'itemNumber', 'revision', 'sourceHash', 'kind', 'sourceId', 'position', 'rotation', 'color', 'dimensions', 'removed', 'provenance']);
  for (const key of ['id', 'name']) text(value[key], key === 'name' ? 200 : 512);
  for (const key of ['itemId', 'itemNumber', 'revision', 'sourceHash', 'sourceId']) if (value[key] !== undefined) text(value[key]);
  if (!['source', 'box', 'cylinder', 'bracket'].includes(value.kind) || (added && value.kind === 'source')) fail();
  if (value.kind === 'source') text(value.sourceId);
  vector(value.position); vector(value.rotation); color(value.color);
  if (value.kind === 'source' && (value.dimensions !== undefined || value.provenance !== undefined)) fail();
  if (value.kind !== 'source' && ['itemId', 'itemNumber', 'revision', 'sourceId', 'sourceHash'].some(key => value[key] !== undefined)) fail();
  if (value.dimensions !== undefined) dimensions(value.dimensions, value.kind);
  if (value.kind !== 'source' && !value.dimensions) fail();
  if (value.removed !== undefined && typeof value.removed !== 'boolean') fail();
  if (value.provenance !== undefined) {
    keys(value.provenance, ['kind', 'document', 'assumptions']);
    if (!['manual', 'ai'].includes(value.provenance.kind)) fail();
    strings(value.provenance.assumptions);
    if (value.provenance.document !== undefined) documentIdentity(value.provenance.document);
  }
}
function camera(value) { keys(value, ['position', 'target', 'aspect']); vector(value.position); vector(value.target); if (value.aspect !== undefined) number(value.aspect, 0.01, 100); }
function annotation(value) {
  keys(value, ['id', 'type', 'label', 'color', 'points', 'target', 'anchors', 'createdAt']);
  text(value.id); text(value.label, 4000, true); text(value.createdAt, 50);
  if (!Number.isFinite(Date.parse(value.createdAt)) || !['arrow', 'rect', 'ellipse', 'pen', 'note', 'pin'].includes(value.type)) fail();
  color(value.color);
  list(value.points, 512).forEach(point => { if (!Array.isArray(point) || point.length !== 2) fail(); point.forEach(v => number(v, 0, 1)); });
  if (!value.points.length) fail();
  if (value.target?.type === 'view') {
    keys(value.target, ['type', 'camera', 'sceneKey', 'geometryKey', 'presentationKey']); camera(value.target.camera);
    for (const key of ['sceneKey', 'geometryKey', 'presentationKey']) if (value.target[key] !== undefined) { text(value.target[key], 256); if (/[\u0000-\u001f\u007f]/.test(value.target[key])) fail(); }
  }
  else if (value.target?.type === 'document') documentIdentity(value.target, true);
  else fail();
  if (value.anchors !== undefined) list(value.anchors, 512).forEach(anchor => { if (anchor === null) return; keys(anchor, ['nodeId', 'localPoint']); text(anchor.nodeId); vector(anchor.localPoint); });
}
function display(value, nodeIds) {
  if (value === undefined || value === null) return;
  keys(value, ['explode', 'labels', 'view', 'hiddenIds']);
  if (value.explode !== undefined) number(value.explode, 0, 1);
  if (value.labels !== undefined && typeof value.labels !== 'boolean') fail();
  if (value.view !== undefined && !['proposed', 'original', 'overlay'].includes(value.view)) fail();
  if (value.hiddenIds !== undefined) list(value.hiddenIds, ASSISTANT_LIMITS.nodes).forEach(id => { text(id); if (!nodeIds.has(id)) fail(); });
}

function presentation(value, nodeIds) {
  if (value === undefined) return;
  keys(value, ['explode', 'labels', 'view', 'hiddenIds', 'opacityById', 'studio']);
  const { opacityById, studio, ...d } = value; display(d, nodeIds);
  if (studio !== undefined && typeof studio !== 'boolean') fail();
  if (opacityById !== undefined) {
    object(opacityById);
    if (Object.keys(opacityById).length > ASSISTANT_LIMITS.nodes) fail();
    for (const [id, opacity] of Object.entries(opacityById)) { if (!nodeIds.has(id)) fail(); number(opacity, 0, 1); }
  }
}

export function validateAssistantRequest(input) {
  keys(input, ['proposalId', 'proposalVersion', 'sourceKey', 'context', 'selectedId', 'prompt', 'baseline', 'nodes', 'annotations', 'annotationIds', 'image', 'imageContext']);
  text(input.proposalId); text(input.sourceKey, 1024 * 1024); text(input.prompt, 8000);
  number(input.proposalVersion, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(input.proposalVersion)) fail();
  keys(input.context, ['workspaceId', 'snapshotId', 'configurationId', 'rootItemId', 'itemNumber', 'name', 'revision', 'sourceMode']);
  for (const key of ['workspaceId', 'snapshotId', 'rootItemId', 'itemNumber', 'name', 'revision']) text(input.context[key]);
  if (input.context.configurationId !== undefined) text(input.context.configurationId);
  if (!['preview', 'arena'].includes(input.context.sourceMode)) fail();
  const nodes = list(input.nodes, ASSISTANT_LIMITS.nodes); nodes.forEach(value => node(value));
  const ids = new Set(nodes.map(value => value.id)); if (ids.size !== nodes.length) fail();
  const baseline = list(input.baseline, ASSISTANT_LIMITS.nodes); baseline.forEach(value => { node(value); if (value.kind !== 'source' || !ids.has(value.id)) fail(); });
  if (new Set(baseline.map(value => value.id)).size !== baseline.length) fail();
  for (const source of baseline) {
    const current = nodes.find(value => value.id === source.id);
    if (['kind', 'sourceId', 'sourceHash', 'itemId', 'itemNumber', 'revision'].some(key => current[key] !== source[key])) fail();
  }
  if (nodes.some(value => value.kind === 'source' && !baseline.some(source => source.id === value.id))) fail();
  if (input.selectedId !== undefined && (!ids.has(input.selectedId) || typeof input.selectedId !== 'string')) fail();
  const marks = list(input.annotations, ASSISTANT_LIMITS.annotations); marks.forEach(annotation);
  const markIds = new Set(marks.map(value => value.id)); if (markIds.size !== marks.length) fail();
  if (input.annotationIds !== undefined) list(input.annotationIds, ASSISTANT_LIMITS.annotations).forEach(id => { if (!markIds.has(id)) fail(); });
  if (input.image !== undefined) {
    if (typeof input.image !== 'string' || input.image.length > Math.ceil(ASSISTANT_LIMITS.imageBytes / 3) * 4 + 30 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.image)) throw new PlaygroundError('TOO_LARGE');
    let bytes;
    try { bytes = Uint8Array.from(atob(input.image.split(',')[1]), character => character.charCodeAt(0)); } catch { fail(); }
    if (bytes.length > ASSISTANT_LIMITS.imageBytes || bytes.length < 8) throw new PlaygroundError('TOO_LARGE');
    const png = input.image.startsWith('data:image/png;');
    if (png ? [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value) : bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail();
    if (input.imageContext?.kind === 'model') { keys(input.imageContext, ['kind', 'camera', 'presentation']); camera(input.imageContext.camera); presentation(input.imageContext.presentation, ids); }
    else if (input.imageContext?.kind === 'document') documentIdentity(input.imageContext, true);
    else fail();
  } else if (input.imageContext !== undefined) fail();
  return input;
}

export function validateAssistantPlan(input, request) {
  try {
    keys(input, ['summary', 'commands', 'assumptions', 'questions', 'display']);
    text(input.summary, 4000); strings(input.assumptions, 30).forEach(value => text(value, 1000)); strings(input.questions, 10);
    const ids = new Map(request.nodes.map(value => [value.id, value]));
    list(input.commands, ASSISTANT_LIMITS.commands).forEach(command => {
      object(command);
      if (command.type === 'add') { keys(command, ['type', 'node']); node(command.node, true); if (ids.has(command.node.id)) fail(); ids.set(command.node.id, command.node); return; }
      if (command.type === 'annotation.upsert') { keys(command, ['type', 'annotation']); annotation(command.annotation); return; }
      if (command.type === 'annotation.remove') { keys(command, ['type', 'id']); if (!request.annotations.some(value => value.id === command.id)) fail(); return; }
      if (!ids.has(command.nodeId)) fail();
      if (command.type === 'transform') {
        keys(command, ['type', 'nodeId', 'position', 'rotation']);
        if (command.position === undefined && command.rotation === undefined) fail();
        if (command.position !== undefined) vector(command.position);
        if (command.rotation !== undefined) vector(command.rotation);
      } else if (command.type === 'resize') {
        keys(command, ['type', 'nodeId', 'dimensions']); if (ids.get(command.nodeId).kind === 'source') fail(); dimensions(command.dimensions, ids.get(command.nodeId).kind);
      } else if (['remove', 'restore'].includes(command.type)) keys(command, ['type', 'nodeId']);
      else if (command.type === 'appearance') { keys(command, ['type', 'nodeId', 'color']); color(command.color); }
      else if (command.type === 'rename') { keys(command, ['type', 'nodeId', 'name']); text(command.name, 200); }
      else fail();
    });
    display(input.display, new Set(ids.keys()));
    if (input.questions.length && (input.commands.length || input.display && Object.keys(input.display).length)) fail();
    return input;
  } catch { throw new PlaygroundError('INVALID_PLAN'); }
}

/** Assign provenance at the trusted boundary, even when an adapter omits it. */
export function stampAssistantConcepts(plan, request) {
  for (const command of plan.commands) if (command.type === 'add') {
    const doc = request.imageContext?.kind === 'document' ? request.imageContext : undefined;
    command.node.provenance = { kind: 'ai', assumptions: [...plan.assumptions], ...(doc ? { document: { fileId: doc.fileId, itemId: doc.itemId, revision: doc.revision, edition: doc.edition, sourceHash: doc.sourceHash, kind: 'pdf' } } : {}) };
  }
  return plan;
}

const str = { type: 'string' }, num = { type: 'number' }, vec = { type: 'array', items: num, description: 'Exactly three finite numbers, in X, Y, Z order.' };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const dimSchema = obj({ width: num, depth: num, height: num, thickness: num, holeDiameter: num, holeX: num, holeY: num }, ['width', 'depth', 'height']);
const nodeSchema = { anyOf: ['box', 'cylinder', 'bracket'].map(kind => obj({ id: str, name: str, kind: { const: kind }, position: vec, rotation: vec, color: str, dimensions: kind === 'bracket' ? dimSchema : obj({ width: num, depth: num, height: num }) })) };
/** Output intentionally omits annotation-writing; existing marks communicate intent, labels use names. */
export const ASSISTANT_PLAN_SCHEMA = obj({
  summary: str,
  commands: { type: 'array', items: { anyOf: [
    obj({ type: { const: 'transform' }, nodeId: str, position: vec, rotation: vec }, ['type', 'nodeId']),
    obj({ type: { const: 'resize' }, nodeId: str, dimensions: dimSchema }),
    obj({ type: { const: 'add' }, node: nodeSchema }),
    obj({ type: { type: 'string', enum: ['remove', 'restore'] }, nodeId: str }),
    obj({ type: { const: 'appearance' }, nodeId: str, color: str }),
    obj({ type: { const: 'rename' }, nodeId: str, name: str }),
  ] } },
  assumptions: { type: 'array', items: str }, questions: { type: 'array', items: str },
  display: obj({ explode: num, labels: { type: 'boolean' }, view: { type: 'string', enum: ['proposed', 'original', 'overlay'] }, hiddenIds: { type: 'array', items: str } }, []),
});
