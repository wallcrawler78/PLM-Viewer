import type { AnnotationTarget, CameraState, PlaygroundAnnotation, Proposal, ProposalChange, ProposalContext, ProposalNode } from './types';
import { validateAnnotation, validateAnnotationTarget, validateCamera, validateProposal, proposalChanges } from './state';

export interface EcrCapture {
  kind:'baseline'|'proposed'|'intent';
  name:string;
  imageDataUrl:string;
  camera?:CameraState;
  annotationIds?:string[];
  /** Captured intent keeps its own version and text, even after a markup is edited or deleted. */
  proposalVersion?:number;
  sourceKey?:string;
  annotations?:PlaygroundAnnotation[];
  /** The number drawn beside each captured markup in the image, in the same order as `annotations`. */
  annotationNumbers?:number[];
  /** Historical concept anchors can outlive an Undo that removed their scene node. */
  unresolvedAnchorNodeIds?:string[];
  document?:Extract<AnnotationTarget,{type:'document'}>;
  presentation?:{view:'proposed'|'original'|'overlay';explode:number;hiddenIds:string[];labels:boolean;opacityById?:Record<string,number>;studio?:boolean};
}
export interface EcrAttachmentMetadata { name:string; mimeType:string; byteLength:number; sha256?:string }
export interface EcrAffectedItem { itemId:string; itemNumber:string; revision:string; occurrenceIds:string[] }
export interface EcrPackageOptions {
  title?:string;
  description?:string;
  captures?:EcrCapture[];
  /** Exact selected occurrences; the UI seeds this with the components currently in view. */
  affectedNodeIds?:string[];
  includeRootItem?:boolean;
  attachments?:EcrAttachmentMetadata[];
}
export interface EcrManifest {
  schemaVersion:1;
  proposalId:string;
  proposalVersion:number;
  title:string;
  description:string;
  source:ProposalContext;
  sourceKey:string;
  units:'mm';
  rotationUnits:'XYZ radians';
  cadEdited:false;
  baseline:ProposalNode[];
  proposed:ProposalNode[];
  changes:ProposalChange[];
  annotations:PlaygroundAnnotation[];
  assumptions:string[];
  affectedItems:EcrAffectedItem[];
  captures:Omit<EcrCapture,'imageDataUrl'>[];
  attachments:EcrAttachmentMetadata[];
}
export interface EcrPackage {
  formatVersion:1;
  kind:'playground-ecr-review';
  generatedAt:string;
  digest:string;
  manifest:EcrManifest;
  captures:EcrCapture[];
}
export interface EcrReceipt {
  mode:'preview'|'arena';
  id:string;
  number:string;
  status:'draft';
  proposalId:string;
  proposalVersion:number;
  digest:string;
  createdAt:string;
  affectedItems:EcrAffectedItem[];
  attachmentNames:string[];
  /** Only a configured live provider may supply its verified Arena URL. */
  url?:string;
  message:string;
}
export interface EcrAdapter { createDraft(review:EcrPackage,idempotencyKey?:string):Promise<EcrReceipt> }

const cleanText=(value:unknown,label:string,max:number,allowEmpty=false):string=>{
  if(typeof value!=='string'||(!allowEmpty&&!value.trim())) throw new Error(`${label} is missing.`);
  if(value.length>max) throw new Error(`${label} is too long (${value.length.toLocaleString()} of ${max.toLocaleString()} characters).`);
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label} contains a control character that cannot be saved. Retype or paste it as plain text.`);
  return value;
};
const filename=(value:unknown)=>{
  const name=cleanText(value,'Attachment name',160);
  if(name==='.'||name==='..'||/[\\/\r\n]/.test(name)) throw new Error('Attachment names must be simple filenames.');
  return name;
};
const clone=<T>(v:T):T=>structuredClone(v);
const validSnapshotId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512&&!!value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);

export function affectedItemsForProposal(proposal:Proposal,nodeIds:string[]=proposal.nodes.filter(node=>!node.removed).map(node=>node.id),includeRoot=false):EcrAffectedItem[] {
  if(!Array.isArray(nodeIds)||nodeIds.length>proposal.nodes.length||new Set(nodeIds).size!==nodeIds.length) throw new Error('Select each affected component at most once.');
  const result=new Map<string,EcrAffectedItem>();
  const nodes=new Map(proposal.nodes.map(node=>[node.id,node]));
  for(const id of nodeIds) {
    const node=nodes.get(id);
    if(!node) throw new Error('An affected component is no longer part of this proposal.');
    if(node.kind!=='source') continue;
    if(!node.itemId||!node.itemNumber||!node.revision) throw new Error('Affected source items need exact item and revision identities.');
    const key=JSON.stringify([node.itemId,node.revision]);
    const item=result.get(key)??{itemId:node.itemId,itemNumber:node.itemNumber,revision:node.revision,occurrenceIds:[]};
    item.occurrenceIds.push(node.id);result.set(key,item);
  }
  if(includeRoot) {
    const c=proposal.context,key=JSON.stringify([c.rootItemId,c.revision]);
    if(!result.has(key)) result.set(key,{itemId:c.rootItemId,itemNumber:c.itemNumber,revision:c.revision,occurrenceIds:[]});
  }
  return Array.from(result.values());
}

function capture(input:EcrCapture,proposal:Proposal):EcrCapture {
  if(!input||typeof input!=='object'||!['baseline','proposed','intent'].includes(input.kind)) throw new Error('Capture type is invalid.');
  if(Object.keys(input).some(key=>!['kind','name','imageDataUrl','camera','annotationIds','proposalVersion','sourceKey','annotations','annotationNumbers','unresolvedAnchorNodeIds','document','presentation'].includes(key))) throw new Error('Capture metadata contains an unsupported field.');
  const name=filename(input.name);
  if(typeof input.imageDataUrl!=='string'||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.imageDataUrl)) throw new Error('A captured view must be a local PNG or JPEG image.');
  const base64=input.imageDataUrl.slice(input.imageDataUrl.indexOf(',')+1);
  if(base64.length%4!==0||base64.length*3/4>2*1024*1024) throw new Error('Each captured image must be no larger than 2 MiB.');
  const png=input.imageDataUrl.startsWith('data:image/png;');
  const header=atob(base64.slice(0,16));
  if(png ? !header.startsWith('\x89PNG\r\n\x1a\n') : !header.startsWith('\xff\xd8\xff')) throw new Error('The captured image bytes do not match their PNG or JPEG format.');
  if(png ? !/\.png$/i.test(name) : !/\.jpe?g$/i.test(name)) throw new Error('The capture filename must match its image format.');
  const result:EcrCapture={kind:input.kind,name,imageDataUrl:input.imageDataUrl};
  const hasSnapshot=input.proposalVersion!==undefined||input.sourceKey!==undefined||input.annotations!==undefined||input.document!==undefined||input.presentation!==undefined;
  if(hasSnapshot) {
    if(input.sourceKey!==proposal.sourceKey) throw new Error('The captured view belongs to a different source configuration. Capture it again in this proposal.');
    const version=input.proposalVersion;
    if(typeof version!=='number'||!Number.isSafeInteger(version)||version<0||version>proposal.version) throw new Error('The captured view has an invalid or newer proposal version.');
    result.sourceKey=proposal.sourceKey;result.proposalVersion=input.proposalVersion;
  }
  if(input.camera!==undefined) result.camera=validateCamera(input.camera);
  if(input.document!==undefined) {
    const document=validateAnnotationTarget(input.document);
    if(document.type!=='document') throw new Error('Captured document identity is invalid.');
    result.document=document;
    if(input.camera!==undefined||input.presentation!==undefined) throw new Error('A document capture cannot claim a 3D camera or presentation.');
  }
  const nodeIds=new Set([...proposal.nodes,...proposal.baseline].map(node=>node.id));
  if(input.annotations!==undefined) {
    if(!Array.isArray(input.annotations)||input.annotations.length>250) throw new Error('The captured markup snapshot exceeds the supported limit.');
    const annotations=input.annotations.map(validateAnnotation);
    if(new Set(annotations.map(mark=>mark.id)).size!==annotations.length) throw new Error('Captured markup IDs must be unique.');
    const unresolved=new Set<string>();
    for(const annotation of annotations) {
      // These IDs describe the saved raster's historical local geometry only.
      // They never map an affected item or authorize a current-scene operation.
      for(const anchor of annotation.anchors??[]) if(anchor&&!nodeIds.has(anchor.nodeId)) unresolved.add(anchor.nodeId);
      if(result.document) {
        if(annotation.target.type!=='document'||JSON.stringify(annotation.target)!==JSON.stringify(result.document)) throw new Error('A captured markup belongs to a different document edition or page.');
      } else if(annotation.target.type==='document') throw new Error('A document markup image needs its exact captured file edition, hash and page.');
    }
    result.annotations=annotations;
    if(unresolved.size>2000) throw new Error('Too many historical component anchors in the capture.');
    if(unresolved.size) result.unresolvedAnchorNodeIds=Array.from(unresolved);
    result.annotationIds=annotations.map(annotation=>annotation.id);
    if(input.annotationNumbers!==undefined) {
      if(!Array.isArray(input.annotationNumbers)||input.annotationNumbers.length!==annotations.length||input.annotationNumbers.some(value=>!Number.isSafeInteger(value)||value<1||value>250)) throw new Error('Captured markup numbers do not match their frozen snapshot.');
      result.annotationNumbers=[...input.annotationNumbers];
    }
    if(input.annotationIds!==undefined&&(!Array.isArray(input.annotationIds)||input.annotationIds.length!==annotations.length||new Set(input.annotationIds).size!==input.annotationIds.length||input.annotationIds.some(id=>!result.annotationIds!.includes(id)))) throw new Error('Capture markup references do not match their frozen snapshot.');
  } else if(input.annotationIds!==undefined) {
    if(!Array.isArray(input.annotationIds)||input.annotationIds.length) throw new Error('Capture the marked view again to retain its exact annotation text and source context.');
    result.annotationIds=[];
  }
  if(input.unresolvedAnchorNodeIds!==undefined&&(!input.annotations||!Array.isArray(input.unresolvedAnchorNodeIds)||input.unresolvedAnchorNodeIds.length>2000||input.unresolvedAnchorNodeIds.some(id=>!validSnapshotId(id)))) throw new Error('Historical capture anchor metadata is invalid.');
  if(input.presentation!==undefined) {
    const presentation=input.presentation;
    if(!presentation||typeof presentation!=='object'||Object.keys(presentation).some(key=>!['view','explode','hiddenIds','labels','opacityById','studio'].includes(key))||!['proposed','original','overlay'].includes(presentation.view)||!Number.isFinite(presentation.explode)||presentation.explode<0||presentation.explode>1||typeof presentation.labels!=='boolean'||!Array.isArray(presentation.hiddenIds)||presentation.hiddenIds.length>2000||new Set(presentation.hiddenIds).size!==presentation.hiddenIds.length||presentation.hiddenIds.some(id=>!validSnapshotId(id))||(presentation.studio!==undefined&&typeof presentation.studio!=='boolean')) throw new Error('The captured display state is invalid.');
    if(presentation.opacityById!==undefined&&(!presentation.opacityById||typeof presentation.opacityById!=='object'||Array.isArray(presentation.opacityById)||Object.keys(presentation.opacityById).length>2000||Object.entries(presentation.opacityById).some(([id,value])=>!validSnapshotId(id)||typeof value!=='number'||!Number.isFinite(value)||value<0||value>1))) throw new Error('The captured transparency state is invalid.');
    result.presentation=clone(presentation);
  }
  return result;
}

async function digestOf(manifest:EcrManifest,captures:EcrCapture[]):Promise<string> {
  const payload=JSON.stringify([manifest,captures]);
  const bytes=new TextEncoder().encode(payload);
  if(bytes.byteLength>12*1024*1024) throw new Error('The ECR review package exceeds the 12 MiB limit.');
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function createEcrPackage(input:Proposal,options:EcrPackageOptions={}):Promise<EcrPackage> {
  const proposal=validateProposal(input);
  const captures=(options.captures??[]);
  if(!Array.isArray(captures)||captures.length>4) throw new Error('An ECR package supports up to four captured views.');
  const images=captures.map(value=>capture(value,proposal));
  const attachments=options.attachments??[];
  if(!Array.isArray(attachments)||attachments.length>12) throw new Error('Too many review attachments.');
  const files:EcrAttachmentMetadata[]=attachments.map(file=>{
    if(!file||typeof file!=='object'||Object.keys(file).some(key=>!['name','mimeType','byteLength','sha256'].includes(key))) throw new Error('Attachment metadata is invalid.');
    if(!Number.isSafeInteger(file.byteLength)||file.byteLength<0||file.byteLength>12*1024*1024) throw new Error('Attachment size is invalid.');
    const result:EcrAttachmentMetadata={name:filename(file.name),mimeType:cleanText(file.mimeType,'Attachment type',160),byteLength:file.byteLength};
    if(file.sha256!==undefined) { if(!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Attachment checksum is invalid.'); result.sha256=file.sha256; }
    return result;
  });
  const names=[...images.map(i=>i.name),...files.map(f=>f.name)];
  if(new Set(names).size!==names.length) throw new Error('Review attachments need unique filenames.');
  const changes=proposalChanges(proposal);
  const assumptions=Array.from(new Set(proposal.nodes.filter(n=>n.kind!=='source'&&!n.removed).flatMap(n=>n.provenance?.assumptions??[])));
  if(proposal.nodes.some(n=>n.kind!=='source'&&!n.removed)) assumptions.unshift('Concept geometry expresses visual design intent; manufacturing details and engineering feasibility have not been verified.');
  const manifest:EcrManifest={schemaVersion:1,proposalId:proposal.id,proposalVersion:proposal.version,title:cleanText(options.title??proposal.title,'ECR title',300),description:cleanText(options.description??changes.map(change=>change.summary).join('\n'),'ECR description',12000,true),source:clone(proposal.context),sourceKey:proposal.sourceKey,units:'mm',rotationUnits:'XYZ radians',cadEdited:false,baseline:clone(proposal.baseline),proposed:clone(proposal.nodes),changes,annotations:clone(proposal.annotations),assumptions,affectedItems:affectedItemsForProposal(proposal,options.affectedNodeIds,options.includeRootItem),captures:images.map(({imageDataUrl,...metadata})=>metadata),attachments:files};
  const digest=await digestOf(manifest,images);
  return {formatVersion:1,kind:'playground-ecr-review',generatedAt:new Date().toISOString(),digest,manifest,captures:images};
}

/** An in-session preview of the create/readback boundary. It performs zero network calls.
 * A real provider must independently authorize items, upload bytes, and return a verified URL. */
export class SimulatedEcrAdapter implements EcrAdapter {
  private receipts=new Map<string,EcrReceipt>();
  async createDraft(review:EcrPackage,idempotencyKey=review.digest):Promise<EcrReceipt> {
    cleanText(idempotencyKey,'Idempotency key',512);
    if(review.formatVersion!==1||review.kind!=='playground-ecr-review'||!/^[a-f0-9]{64}$/.test(review.digest)||await digestOf(review.manifest,review.captures)!==review.digest) throw new Error('The review package changed after it was prepared. Rebuild it before creating the preview ECR.');
    const previous=this.receipts.get(idempotencyKey);
    if(previous) { if(previous.digest!==review.digest) throw new Error('This creation key was already used for different review content.'); return clone(previous); }
    if(this.receipts.size>=100) throw new Error('This preview session has reached its ECR limit. Keep an exported review package before opening a new session.');
    const number=`PREVIEW-ECR-${review.digest.slice(0,8).toUpperCase()}`;
    const receipt:EcrReceipt={mode:'preview',id:`preview:${review.digest}`,number,status:'draft',proposalId:review.manifest.proposalId,proposalVersion:review.manifest.proposalVersion,digest:review.digest,createdAt:new Date().toISOString(),affectedItems:clone(review.manifest.affectedItems),attachmentNames:[...review.captures.map(image=>image.name),...review.manifest.attachments.map(file=>file.name)],message:'Preview ECR created in this session. No Arena record or attachment was written; an Arena URL will appear after a configured live provider creates and verifies the request.'};
    this.receipts.set(idempotencyKey,receipt);
    return clone(receipt);
  }
}
