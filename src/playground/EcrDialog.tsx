import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowUpRight,Check,CheckCircle2,Download,FileText,Image,LoaderCircle,PackageCheck,X} from 'lucide-react';
import type {Proposal} from './types';
import type {EcrCapture,EcrPackage,EcrReceipt} from './ecr';
import {createEcrPackage,SimulatedEcrAdapter} from './ecr';
import {proposalChanges} from './state';
import {buildReviewArchive,buildWordReport,downloadBytes,imageBytes,sha256} from './report';

export interface EcrDialogProps {
  proposal:Proposal;
  visibleNodeIds:string[];
  intentCaptures:EcrCapture[];
  captureDesign:(which?:'proposed'|'original')=>Promise<EcrCapture>;
  captureIntent?:()=>Promise<EcrCapture|null>;
  onClose:()=>void;
}
interface ItemGroup {key:string;itemId:string;itemNumber:string;revision:string;name:string;ids:string[];visibleIds:string[];changed:boolean;removed:boolean}
interface PreparedReview {key:string;review:EcrPackage;word:Uint8Array;receipt?:EcrReceipt;archive?:Uint8Array}
const DOCX_TYPE='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const phaseLabel={capture:'Capturing the design and intent views…',report:'Writing the Word description and embedding the views…',package:'Checking the review package…',create:'Creating the preview ECR and verifying its contents…',archive:'Preparing your downloadable review package…'};

function safeReceiptUrl(receipt:EcrReceipt):string|null {
  if(receipt.mode!=='arena'||!receipt.url) return null;
  try {const url=new URL(receipt.url);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;} catch{return null;}
}

export function EcrDialog({proposal,visibleNodeIds,intentCaptures,captureDesign,captureIntent,onClose}:EcrDialogProps) {
  const [title,setTitle]=useState(proposal.title);
  const [description,setDescription]=useState('');
  const [includeRoot,setIncludeRoot]=useState(false);
  const [phase,setPhase]=useState<keyof typeof phaseLabel|null>(null);
  const [error,setError]=useState('');
  const [result,setResult]=useState<PreparedReview|null>(null);
  const dialog=useRef<HTMLElement>(null),previousFocus=useRef<HTMLElement|null>(null),generation=useRef(0),adapter=useRef(new SimulatedEcrAdapter()),prepared=useRef<PreparedReview|null>(null),currentProposal=useRef(proposal);
  currentProposal.current=proposal;
  const busy=phase!==null;
  const groups=useMemo(()=>{
    const visible=new Set(visibleNodeIds),changed=new Set(proposalChanges(proposal).map(change=>change.nodeId)),map=new Map<string,ItemGroup>();
    for(const node of proposal.nodes) {
      if(node.kind!=='source'||!node.itemId||!node.itemNumber||!node.revision) continue;
      const key=JSON.stringify([node.itemId,node.revision]);
      const group=map.get(key)??{key,itemId:node.itemId,itemNumber:node.itemNumber,revision:node.revision,name:node.name,ids:[],visibleIds:[],changed:false,removed:true};
      group.ids.push(node.id);if(visible.has(node.id))group.visibleIds.push(node.id);
      group.changed ||=changed.has(node.id);group.removed &&=!!node.removed;map.set(key,group);
    }
    return Array.from(map.values());
  },[proposal,visibleNodeIds]);
  // Only items the proposal actually changes start selected. The reviewer adds others deliberately.
  const [selected,setSelected]=useState(()=>new Set(groups.filter(group=>group.changed).map(group=>group.key)));
  const conceptCount=proposal.nodes.filter(node=>node.kind!=='source'&&!node.removed).length;
  const selectedGroups=groups.filter(group=>selected.has(group.key));
  const displayedGroups=groups.filter(group=>group.visibleIds.length);
  const otherGroups=groups.filter(group=>!group.visibleIds.length);
  const capturedIntentCount=intentCaptures.filter(capture=>capture.kind==='intent').slice(-2).length;
  const effectiveCount=selectedGroups.length+(includeRoot&&!selectedGroups.some(group=>group.itemId===proposal.context.rootItemId&&group.revision===proposal.context.revision)?1:0);
  const close=()=>{generation.current++;onClose();};

  useEffect(()=>{
    previousFocus.current=document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLElement>('input')?.focus();
    return()=>{generation.current++;previousFocus.current?.focus();};
  },[]);
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
      if(event.key!=='Tab'||!dialog.current)return;
      const focusable=Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')).filter(element=>element.getClientRects().length>0);
      if(!focusable.length){event.preventDefault();return;}
      const first=focusable[0],last=focusable.at(-1)!;
      if(event.shiftKey&&(document.activeElement===first||!dialog.current.contains(document.activeElement))){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!dialog.current.contains(document.activeElement))){event.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',onKey,true);return()=>document.removeEventListener('keydown',onKey,true);
  });
  useEffect(()=>{if(result)dialog.current?.querySelector<HTMLElement>('[data-result-focus]')?.focus();},[result]);

  const toggle=(key:string)=>setSelected(previous=>{const next=new Set(previous);next.has(key)?next.delete(key):next.add(key);return next;});
  const row=(group:ItemGroup)=><label className={`pg-ecr-item ${selected.has(group.key)?'is-selected':''}`} key={group.key}>
    <input type="checkbox" checked={selected.has(group.key)} disabled={busy} onChange={()=>toggle(group.key)} aria-label={`Include ${group.itemNumber} revision ${group.revision}`}/>
    <span className="pg-ecr-item-main"><strong>{group.itemNumber}<span className="pg-ecr-revision">Rev {group.revision}</span></strong><span>{group.name}</span></span>
    <span className="pg-ecr-item-state">{group.visibleIds.length?`${group.visibleIds.length} in view`:group.removed?'Proposed removal':'Outside this view'}<small>{group.changed?'Has proposed changes':'No proposed change'}</small></span>
  </label>;

  async function createReview() {
    if(busy)return;
    setError('');
    if(!title.trim()){setError('Give the ECR a title.');return;}
    if(!description.trim()){setError('Describe the change and why you want it reviewed.');return;}
    const token=++generation.current,current=proposal;
    const active=()=>token===generation.current;
    const check=()=>{if(!active())throw new Error('Preparation cancelled.');if(currentProposal.current.id!==current.id||currentProposal.current.version!==current.version||currentProposal.current.sourceKey!==current.sourceKey)throw new Error('The proposal changed while the package was being prepared. Review the current view and try again.');};
    try {
      const affectedNodeIds=selectedGroups.flatMap(group=>group.visibleIds.length?group.visibleIds:group.ids);
      setPhase('capture');
      const key=await sha256(new TextEncoder().encode(JSON.stringify([current.id,current.version,current.sourceKey,title,description,affectedNodeIds,includeRoot,intentCaptures])));check();
      let work=prepared.current?.key===key?prepared.current:null;
      if(!work){
        const extension=(image:EcrCapture)=>image.imageDataUrl.startsWith('data:image/jpeg;')?'jpg':'png';
        const views:EcrCapture[]=[];
        // A before image only means something when the configuration itself changes.
        if(proposalChanges(current).some(change=>change.kind!=='modified'||change.fields.some(field=>field!=='color'&&field!=='name'))){const source=await captureDesign('original');check();views.push({...source,kind:'baseline',name:`source-design.${extension(source)}`});}
        const design=await captureDesign('proposed');check();
        views.push({...design,kind:'proposed',name:`proposed-design.${extension(design)}`});
        let intents=intentCaptures.filter(capture=>capture.kind==='intent').slice(-2);
        if(current.annotations.length&&!intents.some(capture=>(capture.annotations?.length??0)>0)){
          const image=await captureIntent?.();check();
          if(image?.annotations?.length)intents=[...intents.slice(-1),image];
          else throw new Error('The proposal contains markups but no intent image is available. Open a marked view, save its intent image, and try again.');
        }
        views.push(...intents.map((image,index)=>({...image,kind:'intent' as const,name:`design-intent-${index+1}.${image.imageDataUrl.startsWith('data:image/jpeg;')?'jpg':'png'}`})));
        setPhase('report');
        const preliminary=await createEcrPackage(current,{title:title.trim(),description:description.trim(),captures:views,affectedNodeIds,includeRootItem:includeRoot});check();
        const word=await buildWordReport(preliminary);check();
        const wordHash=await sha256(word);check();setPhase('package');
        const review=await createEcrPackage(current,{title:title.trim(),description:description.trim(),captures:views,affectedNodeIds,includeRootItem:includeRoot,attachments:[{name:'change-summary.docx',mimeType:DOCX_TYPE,byteLength:word.byteLength,sha256:wordHash}]});check();
        work={key,review,word};prepared.current=work;
      }
      setPhase('create');check();
      work.receipt??=await adapter.current.createDraft(work.review,work.review.digest);check();
      setPhase('archive');work.archive??=await buildReviewArchive(work.review,work.word,work.receipt);check();
      setResult({...work});setPhase(null);
    } catch(reason) {if(active()){setError(reason instanceof Error?reason.message:'The ECR package could not be prepared. Your description and selection have been retained.');setPhase(null);}}
  }

  const receipt=result?.receipt,arenaUrl=receipt?safeReceiptUrl(receipt):null;
  return <div className="pg-modal-backdrop pg-ecr-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)close();}}>
    <section className="pg-modal pg-ecr-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pg-ecr-title" aria-describedby="pg-ecr-description">
      <header className="pg-modal-header"><div><span className="pg-eyebrow">{receipt?'REVIEW PACKAGE READY':'ENGINEERING CHANGE REQUEST'}</span><h2 id="pg-ecr-title">{receipt?'Your preview ECR is ready':'Create an ECR'}</h2></div><button className="pg-icon-button" aria-label={busy?'Cancel preparation and close':'Close ECR dialog'} title={busy?'Cancel preparation':'Close'} onClick={close}><X size={19}/></button></header>
      {receipt&&result?<div className="pg-ecr-result">
        <div className="pg-ecr-success" role="status"><CheckCircle2 size={25}/><div><h3 tabIndex={-1} data-result-focus>{receipt.number}</h3><p id="pg-ecr-description">{receipt.message}</p></div></div>
        <div className="pg-ecr-receipt-grid"><div><span>Affected items</span><strong>{receipt.affectedItems.length}</strong></div><div><span>Attachments prepared</span><strong>{receipt.attachmentNames.length}</strong></div><div><span>Proposal version</span><strong>{receipt.proposalVersion}</strong></div></div>
        <div className="pg-ecr-link-card"><ArrowUpRight size={18}/><div><strong>Arena ECR link</strong>{arenaUrl?<a href={arenaUrl} target="_blank" rel="noopener noreferrer">Open {receipt.number} in Arena <ArrowUpRight size={13}/></a>:<p>Arena creation is not connected. A verified ECR link will appear here when the live write connection is configured and tested.</p>}</div></div>
        <h3 className="pg-section-heading">Prepared attachments</h3>
        <div className="pg-ecr-report-row"><FileText size={21}/><div><strong>change-summary.docx</strong><span>Description, affected items, changes, markups and rendered views</span></div><button className="pg-button secondary" onClick={()=>downloadBytes('change-summary.docx',result.word,DOCX_TYPE)}><Download size={14}/>Word report</button></div>
        <div className="pg-ecr-captures">{result.review.captures.map(capture=><figure key={capture.name}><img src={capture.imageDataUrl} alt={capture.kind==='intent'?'Captured design intent and markups':capture.kind==='baseline'?'Captured source product configuration':'Captured proposed product configuration'}/><figcaption><span>{capture.kind==='intent'?'Design intent':capture.kind==='baseline'?'Source design (before)':'Proposed design (after)'}{capture.proposalVersion!==undefined&&<small>Captured at proposal v{capture.proposalVersion}{capture.document?` · Page ${capture.document.page} · Edition ${capture.document.edition}`:''}</small>}</span><button className="pg-icon-button" title={`Download ${capture.name}`} aria-label={`Download ${capture.name}`} onClick={()=>downloadBytes(capture.name,imageBytes(capture.imageDataUrl),capture.imageDataUrl.startsWith('data:image/jpeg;')?'image/jpeg':'image/png')}><Download size={15}/></button></figcaption></figure>)}</div>
        <footer className="pg-modal-footer"><button className="pg-button secondary" onClick={close}>Done</button><button className="pg-button primary" onClick={()=>downloadBytes(`${receipt.number.toLowerCase()}.zip`,result.archive!,'application/zip')}><Download size={16}/>Download review package</button></footer>
      </div>:<form className="pg-ecr-form" onSubmit={event=>{event.preventDefault();void createReview();}}>
        <p id="pg-ecr-description" className="pg-ecr-intro">Describe your proposal, review the affected items, and prepare the design evidence for an Arena ECR.</p>
        <div className="pg-ecr-preview-notice"><PackageCheck size={18}/><div><strong>Preview handoff</strong><p>This creates a test receipt and a complete local review package. Arena records and attachments will be written only after its live ECR connection is configured.</p></div></div>
        <section className="pg-ecr-section"><h3><span>1</span> Describe the change</h3><label className="pg-field"><span>ECR title</span><input autoComplete="off" value={title} maxLength={300} onChange={event=>setTitle(event.target.value)} disabled={busy} placeholder="A short title for this request"/></label><label className="pg-field"><span>Change description</span><textarea value={description} maxLength={12000} rows={4} onChange={event=>setDescription(event.target.value)} disabled={busy} placeholder="What should change, and why? Include the design intent and anything the reviewers should consider."/><small>{description.length.toLocaleString()} / 12,000 characters</small></label></section>
        <section className="pg-ecr-section"><div className="pg-ecr-section-title"><h3><span>2</span> Affected items</h3><span className="pg-count">{effectiveCount} selected</span></div><p>Items with proposed changes are selected. Add any other item reviewers should consider. Repeated occurrences of one item and revision share a single affected-item entry.</p><div className="pg-ecr-items">{displayedGroups.length?displayedGroups.map(row):<p className="pg-empty-small">No existing Arena items are currently visible.</p>}</div>{otherGroups.length>0&&<details className="pg-ecr-other-items"><summary>Other source items ({otherGroups.length})</summary><p>Hidden items and proposed removals are available to include explicitly.</p>{otherGroups.map(row)}</details>}<label className="pg-ecr-parent"><input type="checkbox" checked={includeRoot} disabled={busy} onChange={event=>setIncludeRoot(event.target.checked)}/><span>Also include parent assembly <strong>{proposal.context.itemNumber}</strong> · Rev {proposal.context.revision}</span></label>{conceptCount>0&&<p className="pg-ecr-concept-note">{conceptCount} unnumbered concept {conceptCount===1?'component is':'components are'} documented in the report. Assigning Arena item numbers is a separate workflow.</p>}</section>
        <section className="pg-ecr-section"><h3><span>3</span> Attach the design evidence</h3><div className="pg-ecr-evidence-list"><div><Image size={17}/><span><strong>Proposed design image</strong><small>Captured from the interactive 3D view when you create the ECR</small></span><Check size={16}/></div><div><Image size={17}/><span><strong>Markup and intent {capturedIntentCount===1?'image':'images'}</strong><small>{capturedIntentCount?`${capturedIntentCount} saved intent ${capturedIntentCount===1?'view':'views'} will be included with the original markup text and capture version`:proposal.annotations.length?'A marked view will be captured with your instructions':'No markups yet; the proposed design image will be included'}</small></span>{capturedIntentCount>0&&<Check size={16}/>}</div><div><FileText size={17}/><span><strong>Word description (.docx)</strong><small>Your description, affected items, changes, assumptions and embedded images</small></span><Check size={16}/></div></div></section>
        {error&&<div className="pg-inline-error" role="alert">{error}</div>}
        {busy&&<div className="pg-ecr-progress" role="status" aria-live="polite"><LoaderCircle size={17} className="spin"/>{phaseLabel[phase!]}</div>}
        <footer className="pg-modal-footer"><button type="button" className="pg-button secondary" onClick={close}>{busy?'Cancel preparation':'Cancel'}</button><button type="submit" className="pg-button primary" disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:<PackageCheck size={16}/>} {error?'Try creating preview ECR again':'Create preview ECR'}</button></footer>
      </form>}
    </section>
  </div>;
}
export default EcrDialog;
