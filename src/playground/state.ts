import type { AttachmentReference } from '../domain';
import type { ScenePart } from '../components/model/types';
import type { AnnotationTarget, CameraState, PlaygroundAnnotation, PlaygroundCommand, Proposal, ProposalChange, ProposalContext, ProposalDimensions, ProposalHistory, ProposalNode, Vec3 } from './types';
import { PLAYGROUND_LIMITS as LIMIT } from './types';

export class PlaygroundValidationError extends Error {
  readonly code = 'PLAYGROUND_INVALID';
  constructor(message: string) { super(message); this.name = 'PlaygroundValidationError'; }
}
const fail = (message: string): never => { throw new PlaygroundValidationError(message); };
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[], label: string) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} contains an unsupported field.`);
};
const text = (value: unknown, label: string, max = 512, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} is missing or too long.`);
  return value as string;
};
const identity = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (/[\r\n\t]/.test(result)) fail(`${label} has an invalid identity.`);
  return result;
};
const finite = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} is outside the supported range.`);
  return value as number;
};
const integer = (value: unknown, label: string, min: number, max: number): number => {
  const n = finite(value, label, min, max);
  if (!Number.isSafeInteger(n)) fail(`${label} must be an integer.`);
  return n;
};
const vector = (value: unknown, label: string, bound: number = LIMIT.coordinate): Vec3 => {
  if (!Array.isArray(value) || value.length !== 3) fail(`${label} needs three coordinates.`);
  return (value as unknown[]).map(n => finite(n, label, -bound, bound)) as Vec3;
};
const color = (value: unknown): string => {
  if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) fail('Use a six-digit hexadecimal display color.');
  return (value as string).toLowerCase();
};
const timestamp = (value: unknown): string => {
  const result = text(value, 'Timestamp', 40);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) fail('Timestamp must use ISO UTC format.');
  return result;
};
const list = (value: unknown, max: number, label: string): unknown[] => {
  if (!Array.isArray(value) || value.length > max) fail(`${label} exceeds the supported limit.`);
  return value as unknown[];
};
const optional = <T>(value: unknown, parse: (v: unknown) => T): T | undefined => value === undefined ? undefined : parse(value);
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
};
const now = () => new Date().toISOString();

export function validateContext(input: unknown): ProposalContext {
  const v = object(input, 'Proposal context');
  keys(v, ['workspaceId','snapshotId','configurationId','rootItemId','itemNumber','name','revision','sourceMode'], 'Proposal context');
  if (v.sourceMode !== 'preview' && v.sourceMode !== 'arena') fail('Select a valid source mode.');
  return { workspaceId: identity(v.workspaceId,'Workspace'), snapshotId: identity(v.snapshotId,'Snapshot'), ...(v.configurationId === undefined ? {} : { configurationId: identity(v.configurationId,'Configuration') }), rootItemId: identity(v.rootItemId,'Root item'), itemNumber: text(v.itemNumber,'Item number'), name: text(v.name,'Product name'), revision: identity(v.revision,'Revision'), sourceMode: v.sourceMode as 'preview'|'arena' };
}

export function validateDimensions(input: unknown, kind?: ProposalNode['kind']): ProposalDimensions {
  const v = object(input, 'Concept dimensions');
  keys(v, ['width','depth','height','thickness','holeDiameter','holeX','holeY'], 'Concept dimensions');
  const result: ProposalDimensions = { width: finite(v.width,'Width',0.01,LIMIT.dimension), depth: finite(v.depth,'Depth',0.01,LIMIT.dimension), height: finite(v.height,'Height',0.01,LIMIT.dimension) };
  for (const key of ['thickness','holeDiameter','holeX','holeY'] as const) if (v[key] !== undefined) result[key] = finite(v[key], key, key === 'holeX'||key === 'holeY' ? -LIMIT.dimension : 0, LIMIT.dimension);
  if (kind === 'source') fail('Source geometry cannot be resized. Create a concept representation instead.');
  if ((kind === 'box' || kind === 'cylinder') && ['thickness','holeDiameter','holeX','holeY'].some(key => v[key] !== undefined)) fail('Hole and plate-thickness tools are available for bracket concepts only.');
  if (kind === 'bracket') {
    const thickness = result.thickness ?? 3;
    if (thickness < 0.01 || thickness > Math.min(result.width,result.depth,result.height)/2) fail('Bracket thickness must fit its overall dimensions.');
    const radius = (result.holeDiameter ?? 0) / 2;
    if (Math.abs(result.holeX ?? 0)+radius > result.width/2-thickness || Math.abs(result.holeY ?? 0)+radius > result.depth/2-thickness) fail('The bracket hole must remain within its base plate.');
    result.thickness = thickness;
    result.holeDiameter ??= 0;
    result.holeX ??= 0;
    result.holeY ??= 0;
  }
  return result;
}

function documentReference(input: unknown): AttachmentReference {
  const v = object(input, 'Document source');
  keys(v,['fileId','itemId','revision','edition','sourceHash','kind'],'Document source');
  if (!['pdf','docx','doc'].includes(v.kind as string)) fail('Document source format is unsupported.');
  return { fileId:identity(v.fileId,'File'),itemId:identity(v.itemId,'Item'),revision:identity(v.revision,'Revision'),edition:identity(v.edition,'Edition'),sourceHash:identity(v.sourceHash,'Source hash'),kind:v.kind as AttachmentReference['kind'] };
}

export function validateNode(input: unknown): ProposalNode {
  const v = object(input, 'Component');
  keys(v,['id','name','itemId','itemNumber','revision','sourceHash','kind','sourceId','sourceBinding','position','rotation','color','dimensions','removed','provenance'],'Component');
  if (!['source','box','cylinder','bracket'].includes(v.kind as string)) fail('This concept geometry is unsupported.');
  if (v.removed !== undefined && typeof v.removed !== 'boolean') fail('Removed state must be a boolean.');
  const node: ProposalNode = { id:identity(v.id,'Component ID'),name:text(v.name,'Component name',200),kind:v.kind as ProposalNode['kind'],position:vector(v.position,'Position'),rotation:vector(v.rotation,'Rotation',Math.PI*200),color:color(v.color),removed:v.removed === true };
  if (node.kind === 'source') {
    if (v.dimensions !== undefined || v.provenance !== undefined) fail('Imported geometry and its provenance cannot be replaced.');
    node.sourceId = identity(v.sourceId,'Source occurrence');
    node.itemId = identity(v.itemId,'Item');
    node.itemNumber = text(v.itemNumber,'Item number');
    node.revision = identity(v.revision,'Revision');
    node.sourceHash = identity(v.sourceHash,'Source hash');
    if (v.sourceBinding !== undefined) {
      const binding = object(v.sourceBinding,'CAD source mapping');
      keys(binding,['cadNodePath','sourceToPart'],'CAD source mapping');
      node.sourceBinding = {};
      if (binding.cadNodePath !== undefined) node.sourceBinding.cadNodePath = list(binding.cadNodePath,64,'CAD node path').map(index => integer(index,'CAD path index',0,100000));
      if (binding.sourceToPart !== undefined) {
        const transform = object(binding.sourceToPart,'CAD normalization');
        keys(transform,['position','rotation'],'CAD normalization');
        node.sourceBinding.sourceToPart = { position:vector(transform.position,'CAD normalization position'),rotation:vector(transform.rotation,'CAD normalization rotation',Math.PI*200) };
      }
    }
  } else {
    if (['sourceId','sourceHash','sourceBinding','itemId','itemNumber','revision'].some(key => v[key] !== undefined)) fail('A concept cannot claim the identity of an Arena source.');
    node.dimensions = validateDimensions(v.dimensions,node.kind);
    if (v.provenance !== undefined) {
      const p = object(v.provenance,'Concept provenance');
      keys(p,['kind','document','assumptions'],'Concept provenance');
      if (p.kind !== 'manual' && p.kind !== 'ai') fail('Concept provenance is invalid.');
      const provenance: NonNullable<ProposalNode['provenance']> = { kind:p.kind as 'manual'|'ai', assumptions:list(p.assumptions,30,'Assumptions').map(s => text(s,'Assumption',1000)) };
      if (p.document !== undefined) provenance.document = documentReference(p.document);
      node.provenance = provenance;
    } else node.provenance = { kind:'manual',assumptions:[] };
  }
  return node;
}

export function validateCamera(input: unknown): CameraState {
  const camera=object(input,'Markup camera');
  keys(camera,['position','target','aspect'],'Markup camera');
  const position=vector(camera.position,'Camera position'),target=vector(camera.target,'Camera target');
  if(same(position,target)) fail('The markup camera needs a viewing direction.');
  return {position,target,...(camera.aspect===undefined?{}:{aspect:finite(camera.aspect,'Camera aspect ratio',0.01,100)})};
}

export function validateAnnotationTarget(input: unknown): AnnotationTarget {
  const target=object(input,'Markup target');
  if (target.type === 'view') {
    keys(target,['type','camera','sceneKey','geometryKey'],'Markup view');
    let sceneKey:string|undefined;
    if(target.sceneKey!==undefined) { sceneKey=text(target.sceneKey,'Markup scene identity',256);if(/[\r\n\t]/.test(sceneKey)) fail('Markup scene identity has invalid characters.'); }
    let geometryKey:string|undefined;
    if(target.geometryKey!==undefined) { geometryKey=text(target.geometryKey,'Markup geometry identity',256);if(/[\r\n\t]/.test(geometryKey)) fail('Markup geometry identity has invalid characters.'); }
    return {type:'view',camera:validateCamera(target.camera),...(sceneKey===undefined?{}:{sceneKey}),...(geometryKey===undefined?{}:{geometryKey})};
  } else if (target.type === 'document') {
    keys(target,['type','fileId','itemId','revision','edition','sourceHash','page'],'Markup document');
    return {type:'document',fileId:identity(target.fileId,'File'),itemId:identity(target.itemId,'Item'),revision:identity(target.revision,'Revision'),edition:identity(target.edition,'Edition'),sourceHash:identity(target.sourceHash,'Source hash'),page:integer(target.page,'Document page',1,100000)};
  }
  return fail('Markup must refer to an exact model view or document page.');
}

export function validateAnnotation(input: unknown): PlaygroundAnnotation {
  const v = object(input,'Markup');
  keys(v,['id','type','label','color','points','target','anchors','createdAt'],'Markup');
  if (!['arrow','rect','ellipse','pen','note','pin'].includes(v.type as string)) fail('Markup tool is unsupported.');
  const points = list(v.points,LIMIT.annotationPoints,'Markup points').map(point => {
    if (!Array.isArray(point) || point.length !== 2) fail('Markup points need two coordinates.');
    return (point as unknown[]).map(n => finite(n,'Markup position',0,1)) as [number,number];
  });
  const required = v.type === 'note' || v.type === 'pin' ? 1 : 2;
  if (points.length < required || (v.type !== 'pen' && points.length !== required)) fail('Markup needs the correct number of points.');
  const resultTarget=validateAnnotationTarget(v.target);
  const result: PlaygroundAnnotation = {id:identity(v.id,'Markup ID'),type:v.type as PlaygroundAnnotation['type'],label:text(v.label,'Markup label',LIMIT.text,true),color:color(v.color),points,target:resultTarget,createdAt:timestamp(v.createdAt)};
  if (v.anchors !== undefined) {
    if (resultTarget.type !== 'view') fail('Document markup cannot claim a 3D surface anchor.');
    const anchors = list(v.anchors,LIMIT.annotationPoints,'Markup anchors');
    if (anchors.length !== points.length) fail('Markup anchors must match the drawn points.');
    result.anchors = anchors.map(anchor => {
      if (anchor === null) return null;
      const a = object(anchor,'Surface anchor'); keys(a,['nodeId','localPoint'],'Surface anchor');
      return {nodeId:identity(a.nodeId,'Anchor component'),localPoint:vector(a.localPoint,'Local surface point')};
    });
  }
  return result;
}

/** The full source identity is compared, not a lossy filename/part-number hash. */
export function proposalSourceKey(context: ProposalContext, baseline: ProposalNode[]): string {
  return JSON.stringify([validateContext(context),baseline.map(validateNode).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)]);
}

export function createProposal(context: ProposalContext, parts: ScenePart[]): Proposal {
  const parsedContext = validateContext(context);
  const baseline = list(parts,LIMIT.nodes,'Source components').map(part => {
    const p = part as ScenePart;
    return validateNode({id:p.id,name:p.name,itemId:p.itemId,itemNumber:p.itemNumber,revision:p.revision,sourceHash:p.sourceHash,kind:'source',sourceId:p.id,position:p.position,rotation:p.rotation ?? [0,0,0],color:p.color,...(p.cadNodePath !== undefined || p.sourceToPart !== undefined ? {sourceBinding:{...(p.cadNodePath === undefined ? {}:{cadNodePath:p.cadNodePath}),...(p.sourceToPart === undefined?{}:{sourceToPart:p.sourceToPart})}}:{})});
  });
  if (new Set(baseline.map(node => node.id)).size !== baseline.length) fail('Source occurrences must have unique identities.');
  const time = now();
  return {schemaVersion:1,id:crypto.randomUUID(),title:`${parsedContext.name} · concept proposal`,context:parsedContext,sourceKey:proposalSourceKey(parsedContext,baseline),version:0,createdAt:time,updatedAt:time,baseline:freeze(baseline),nodes:copy(baseline),annotations:[]};
}

function sourceIdentity(node: ProposalNode): unknown {
  return [node.id,node.kind,node.sourceId,node.itemId,node.itemNumber,node.revision,node.sourceHash,node.sourceBinding];
}

export function validateProposal(input: unknown, expectedBaseline?: Proposal): Proposal {
  const v = object(input,'Proposal');
  keys(v,['schemaVersion','id','title','context','sourceKey','version','createdAt','updatedAt','baseline','nodes','annotations'],'Proposal');
  if (v.schemaVersion !== 1) fail('This proposal format is unsupported.');
  const context = validateContext(v.context);
  const baseline = list(v.baseline,LIMIT.nodes,'Source components').map(validateNode);
  const nodes = list(v.nodes,LIMIT.nodes,'Proposal components').map(validateNode);
  const annotations = list(v.annotations,LIMIT.annotations,'Markups').map(validateAnnotation);
  if (baseline.some(n => n.kind !== 'source' || n.removed)) fail('The baseline must retain the original source components.');
  for (const [values,label] of [[baseline,'Source components'],[nodes,'Proposal components'],[annotations,'Markups']] as const) if (new Set(values.map(value => value.id)).size !== values.length) fail(`${label} must have unique identities.`);
  const byId = new Map(baseline.map(n => [n.id,n]));
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    const original = byId.get(node.id);
    if (node.kind === 'source' && (!original || !same(sourceIdentity(node),sourceIdentity(original)))) fail('A source component identity or CAD mapping changed.');
    if (original && node.kind !== 'source') fail('A concept cannot replace a source component identity.');
  }
  if (baseline.some(node => !nodeIds.has(node.id))) fail('Sources must remain recorded, even when proposed for removal.');
  if (annotations.some(a => a.anchors?.some(anchor => anchor && !nodeIds.has(anchor.nodeId)))) fail('A markup anchor refers to an unavailable component.');
  const sourceKey = proposalSourceKey(context,baseline);
  if (v.sourceKey !== sourceKey) fail('Proposal source identity is inconsistent.');
  if (expectedBaseline && (sourceKey !== expectedBaseline.sourceKey || !same(baseline,expectedBaseline.baseline))) fail('This proposal belongs to a different exact source or configuration. No remapping was performed.');
  return {schemaVersion:1,id:identity(v.id,'Proposal ID'),title:text(v.title,'Proposal title',300),context,sourceKey,version:integer(v.version,'Proposal version',0,Number.MAX_SAFE_INTEGER-1),createdAt:timestamp(v.createdAt),updatedAt:timestamp(v.updatedAt),baseline:freeze(baseline),nodes,annotations};
}

export function validateCommands(input: unknown): PlaygroundCommand[] {
  return list(input,LIMIT.commands,'Command batch').map(command => {
    const v = object(command,'Command');
    if (v.type === 'proposal.rename') { keys(v,['type','title'],'Rename proposal'); return {type:v.type,title:text(v.title,'Proposal title',300)}; }
    if (v.type === 'transform') { keys(v,['type','nodeId','position','rotation'],'Transform'); if (v.position === undefined && v.rotation === undefined) fail('A transform needs a position or rotation.'); return {type:v.type,nodeId:identity(v.nodeId,'Component'),...(v.position === undefined?{}:{position:vector(v.position,'Position')}),...(v.rotation === undefined?{}:{rotation:vector(v.rotation,'Rotation',Math.PI*200)})}; }
    if (v.type === 'resize') { keys(v,['type','nodeId','dimensions'],'Resize'); return {type:v.type,nodeId:identity(v.nodeId,'Component'),dimensions:validateDimensions(v.dimensions)}; }
    if (v.type === 'add') { keys(v,['type','node'],'Add concept'); const node=validateNode(v.node); if(node.kind==='source') fail('New source files must come from the authorized source loader.'); return {type:v.type,node}; }
    if (v.type === 'remove' || v.type === 'restore') { keys(v,['type','nodeId'],'Component change'); return {type:v.type,nodeId:identity(v.nodeId,'Component')}; }
    if (v.type === 'appearance') { keys(v,['type','nodeId','color'],'Appearance'); return {type:v.type,nodeId:identity(v.nodeId,'Component'),color:color(v.color)}; }
    if (v.type === 'rename') { keys(v,['type','nodeId','name'],'Rename'); return {type:v.type,nodeId:identity(v.nodeId,'Component'),name:text(v.name,'Component name',200)}; }
    if (v.type === 'annotation.upsert') { keys(v,['type','annotation'],'Markup'); return {type:v.type,annotation:validateAnnotation(v.annotation)}; }
    if (v.type === 'annotation.remove') { keys(v,['type','id'],'Remove markup'); return {type:v.type,id:identity(v.id,'Markup')}; }
    return fail('The requested action is unsupported. Only packaged scene operations may run.');
  });
}

export function createHistory(proposal: Proposal): ProposalHistory { return {past:[],present:validateProposal(proposal),future:[]}; }

export function applyCommands(history: ProposalHistory, input: unknown, expected: { expectedVersion?: number; expectedSourceKey?: string } = {}): ProposalHistory {
  if (expected.expectedVersion !== undefined && expected.expectedVersion !== history.present.version) fail('The proposal changed while these instructions were prepared. Review a fresh suggestion.');
  if (expected.expectedSourceKey !== undefined && expected.expectedSourceKey !== history.present.sourceKey) fail('These instructions belong to another source configuration.');
  const commands = validateCommands(input);
  if (!commands.length) return history;
  const next: Proposal = { ...history.present, nodes: copy(history.present.nodes), annotations: copy(history.present.annotations) };
  for (const command of commands) {
    if (command.type === 'proposal.rename') { next.title=command.title; continue; }
    if (command.type === 'add') { if(next.nodes.some(n=>n.id===command.node.id)) fail('The new component ID already exists.'); next.nodes.push(copy(command.node)); continue; }
    if (command.type === 'annotation.upsert') { const at=next.annotations.findIndex(a=>a.id===command.annotation.id); if(at<0) next.annotations.push(copy(command.annotation)); else next.annotations[at]=copy(command.annotation); continue; }
    if (command.type === 'annotation.remove') { if(!next.annotations.some(a=>a.id===command.id)) fail('The markup is no longer available.'); next.annotations=next.annotations.filter(a=>a.id!==command.id); continue; }
    const at=next.nodes.findIndex(n=>n.id===command.nodeId);
    if(at<0) fail('The selected component is no longer available.');
    const node=next.nodes[at];
    if (node.removed && command.type !== 'restore') fail('Restore this component before changing it.');
    if(command.type==='transform') { if(command.position) node.position=copy(command.position); if(command.rotation) node.rotation=copy(command.rotation); }
    else if(command.type==='resize') { if(node.kind==='source') fail('Source CAD cannot be resized. Add a concept representation instead.'); node.dimensions=validateDimensions(command.dimensions,node.kind); }
    else if(command.type==='remove') node.removed=true;
    else if(command.type==='restore') { const original=next.baseline.find(n=>n.id===node.id); next.nodes[at]=original ? copy(original) : {...node,removed:false}; }
    else if(command.type==='appearance') node.color=command.color;
    else if(command.type==='rename') node.name=command.name;
  }
  if (same([next.nodes,next.annotations,next.title],[history.present.nodes,history.present.annotations,history.present.title])) return history;
  next.version=history.present.version+1;
  next.updatedAt=now();
  const valid=validateProposal(next,history.present);
  return {past:[...history.past,history.present].slice(-LIMIT.history),present:valid,future:[]};
}

export function undo(history: ProposalHistory): ProposalHistory {
  const previous=history.past.at(-1); if(!previous) return history;
  return {past:history.past.slice(0,-1),present:validateProposal({...previous,version:history.present.version+1,updatedAt:now()},history.present),future:[history.present,...history.future].slice(0,LIMIT.history)};
}
export function redo(history: ProposalHistory): ProposalHistory {
  const next=history.future[0]; if(!next) return history;
  return {past:[...history.past,history.present].slice(-LIMIT.history),present:validateProposal({...next,version:history.present.version+1,updatedAt:now()},history.present),future:history.future.slice(1)};
}

const numeric = (value: number) => Number(value.toFixed(3)).toString();
export function proposalChanges(proposal: Proposal): ProposalChange[] {
  const baseline=new Map(proposal.baseline.map(n=>[n.id,n]));
  const result:ProposalChange[]=[];
  for(const node of proposal.nodes) {
    const before=baseline.get(node.id);
    const identity={nodeId:node.id,name:node.name,...(node.itemId?{itemId:node.itemId}:{}),...(node.itemNumber?{itemNumber:node.itemNumber}:{}),...(node.revision?{revision:node.revision}:{})};
    if(!before) { if(!node.removed) result.push({...identity,kind:'added',fields:[],summary:`Add concept ${node.name} (${node.kind}); visual representation only.`,after:copy(node)}); continue; }
    if(node.removed) {result.push({...identity,kind:'removed',fields:[],summary:`Propose removing ${node.name} (${node.itemNumber ?? node.id}) from this configuration.`,before:copy(before),after:copy(node)});continue;}
    const fields=(['position','rotation','dimensions','color','name'] as const).filter(field=>!same(node[field],before[field]));
    if(!fields.length) continue;
    const details=fields.map(field=>field==='position'?`position [${node.position.map(numeric).join(', ')}] mm`:field==='rotation'?`rotation [${node.rotation.map(n=>numeric(n*180/Math.PI)).join(', ')}]° XYZ`:field==='color'?`display color ${node.color}`:field==='name'?`label “${node.name}”`:'concept dimensions');
    result.push({...identity,kind:'modified',fields,summary:`${node.itemNumber ?? node.name}: ${details.join('; ')}.`,before:copy(before),after:copy(node)});
  }
  return result;
}
