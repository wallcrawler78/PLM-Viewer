import {describe,it,expect} from 'vitest';
import type {ScenePart} from '../src/components/model/types';
import type {ProposalContext,ProposalNode,PlaygroundAnnotation} from '../src/playground/types';
import {createProposal,createHistory,applyCommands,undo,redo,validateProposal,validateCommands,proposalChanges} from '../src/playground/state';
import {LocalProposalStore,proposalStorageKey} from '../src/playground/storage';
import {createEcrPackage,SimulatedEcrAdapter,affectedItemsForProposal} from '../src/playground/ecr';

const context:ProposalContext={workspaceId:'w',snapshotId:'s',configurationId:'frozen-B',rootItemId:'root',itemNumber:'ASM-001',name:'Test assembly',revision:'B',sourceMode:'preview'};
const parts:ScenePart[]=[{id:'occ-1',itemId:'part',itemNumber:'PN-01',name:'Bracket',revision:'A',sourceHash:'sha256:one',color:'#aabbcc',position:[10,20,30],rotation:[0,0,0],stepUrl:'https://secret.example/file?token=do-not-store',cadNodePath:[0,2],sourceToPart:{position:[-10,0,0],rotation:[0,0,0]}},{id:'occ-2',itemId:'part',itemNumber:'PN-01',name:'Bracket instance',revision:'A',sourceHash:'sha256:one',color:'#aabbcc',position:[50,20,30],rotation:[0,0,0]}];
const concept:ProposalNode={id:'concept-1',kind:'bracket',name:'Proposed bracket',position:[0,0,0],rotation:[0,0,0],color:'#12abef',dimensions:{width:40,depth:30,height:25,thickness:3,holeDiameter:6,holeX:0,holeY:0},provenance:{kind:'manual',assumptions:['Thickness is assumed.']}};
const annotation:PlaygroundAnnotation={id:'mark-1',type:'arrow',label:'Move hole here',color:'#ffaa00',points:[[0.2,0.3],[0.5,0.6]],target:{type:'view',camera:{position:[100,100,100],target:[0,0,0]}},anchors:[{nodeId:'occ-1',localPoint:[1,2,3]},null],createdAt:'2026-01-01T00:00:00.000Z'};
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2qWkAAAAASUVORK5CYII=';
const make=()=>createProposal(context,parts);
const memory=()=>{const data=new Map<string,string>();return {data,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};};

describe('Playground proposal state',()=>{
 it('preserves source occurrence transforms, normalization and exact identities without delivery URLs',()=>{
   const p=make();
   expect(p.baseline[0].position).toEqual([10,20,30]);expect(p.baseline[0].sourceBinding?.cadNodePath).toEqual([0,2]);
   expect(JSON.stringify(p)).not.toContain('secret.example');expect(JSON.stringify(p)).not.toContain('stepUrl');
   expect(Object.isFrozen(p.baseline)).toBe(true);expect(Object.isFrozen(p.baseline[0].position)).toBe(true);
   parts[0].position[0]=11;expect(p.baseline[0].position[0]).toBe(10);parts[0].position[0]=10;
 });
 it('applies one atomic transaction, preserves baseline and undoes/redoes with monotonic versions',()=>{
   const original=createHistory(make());
   let h=applyCommands(original,[{type:'transform',nodeId:'occ-1',position:[20,30,40]},{type:'annotation.upsert',annotation}]);
   expect(h.past).toHaveLength(1);expect(h.present.version).toBe(1);expect(h.present.baseline[0].position).toEqual([10,20,30]);
   h=undo(h);expect(h.present.version).toBe(2);expect(h.present.nodes[0].position).toEqual([10,20,30]);expect(h.present.annotations).toHaveLength(0);
   h=redo(h);expect(h.present.version).toBe(3);expect(h.present.nodes[0].position).toEqual([20,30,40]);expect(h.present.annotations).toHaveLength(1);
   expect(original.present.nodes[0].position).toEqual([10,20,30]);
 });
 it('fails the whole transaction when a later operation is invalid',()=>{
   const h=createHistory(make());
   expect(()=>applyCommands(h,[{type:'transform',nodeId:'occ-1',position:[99,0,0]},{type:'resize',nodeId:'occ-2',dimensions:{width:10,depth:10,height:10}}])).toThrow(/Source CAD/);
   expect(h.present.nodes[0].position).toEqual([10,20,30]);expect(h.past).toHaveLength(0);
 });
 it('rejects stale AI suggestions after an edit or source change',()=>{
   const h=applyCommands(createHistory(make()),[{type:'rename',nodeId:'occ-1',name:'Mount'}]);
   expect(()=>applyCommands(h,[{type:'remove',nodeId:'occ-1'}],{expectedVersion:0})).toThrow(/proposal changed/);
   expect(()=>applyCommands(h,[{type:'remove',nodeId:'occ-1'}],{expectedSourceKey:'other'})).toThrow(/another source/);
 });
 it('only changes the selected repeated occurrence and restores its installed baseline',()=>{
   let h=applyCommands(createHistory(make()),[{type:'transform',nodeId:'occ-1',position:[0,0,0]}]);
   expect(h.present.nodes[1].position).toEqual([50,20,30]);
   h=applyCommands(h,[{type:'remove',nodeId:'occ-1'}]);expect(h.present.nodes).toHaveLength(2);expect(h.present.nodes[0].removed).toBe(true);
   h=applyCommands(h,[{type:'restore',nodeId:'occ-1'}]);expect(h.present.nodes[0]).toEqual(h.present.baseline[0]);
 });
 it('validates bounded typed operations and refuses executable or nonfinite payloads',()=>{
   expect(()=>validateCommands([{type:'eval',code:'alert(1)'}])).toThrow(/unsupported/);
   expect(()=>validateCommands([{type:'transform',nodeId:'occ-1',position:[NaN,0,0]}])).toThrow(/range/);
   expect(()=>validateCommands([{type:'transform',nodeId:'occ-1',position:[1,2,3],script:'x'}])).toThrow(/unsupported field/);
   expect(()=>validateCommands([{type:'add',node:{...concept,sourceId:'occ-1'}}])).toThrow(/cannot claim/);
   expect(()=>validateCommands([{type:'add',node:{...concept,kind:'script'}}])).toThrow(/unsupported/);
   expect(()=>validateCommands([{type:'add',node:{...concept,kind:'box'}}])).toThrow(/bracket concepts only/);
 });
 it('adds an editable concept and keeps hole placement inside the visual bracket base',()=>{
   let h=applyCommands(createHistory(make()),[{type:'add',node:concept}]);
   h=applyCommands(h,[{type:'resize',nodeId:concept.id,dimensions:{...concept.dimensions!,holeX:7}}]);
   expect(h.present.nodes.at(-1)?.dimensions?.holeX).toBe(7);
   expect(()=>applyCommands(h,[{type:'resize',nodeId:concept.id,dimensions:{...concept.dimensions!,holeX:20}}])).toThrow(/within its base plate/);
   expect(h.present.nodes.at(-1)?.dimensions?.holeX).toBe(7);
 });
 it('supports empty labels, exact PDF anchors, and retained model anchors after proposed removal',()=>{
   let h=applyCommands(createHistory(make()),[{type:'annotation.upsert',annotation:{...annotation,label:''}},{type:'remove',nodeId:'occ-1'}]);
   const pdf={...annotation,id:'pdf-1',anchors:undefined,target:{type:'document',fileId:'f',itemId:'part',revision:'A',edition:'2',sourceHash:'sha256:pdf',page:3}};
   h=applyCommands(h,[{type:'annotation.upsert',annotation:pdf}]);
   expect(h.present.annotations[0].anchors?.[0]?.nodeId).toBe('occ-1');expect(h.present.annotations[1].target).toMatchObject({page:3,edition:'2'});
   expect(()=>applyCommands(h,[{type:'annotation.upsert',annotation:{...annotation,id:'bad',anchors:[{nodeId:'missing',localPoint:[0,0,0]},null]}}])).toThrow(/unavailable component/);
 });
 it('retains a view-only markup scene identity and projection aspect with explicit bounds',()=>{
   const target={type:'view' as const,camera:{position:[100,100,100] as [number,number,number],target:[0,0,0] as [number,number,number],aspect:1.6},sceneKey:'scene-v1:exact-display',geometryKey:'geometry-v1:exact-shape'};
   const h=applyCommands(createHistory(make()),[{type:'annotation.upsert',annotation:{...annotation,target}}]);
   expect(h.present.annotations[0].target).toEqual(target);
   expect(()=>applyCommands(h,[{type:'annotation.upsert',annotation:{...annotation,target:{...target,camera:{...target.camera,aspect:0}}}}])).toThrow(/aspect ratio/);
   expect(()=>applyCommands(h,[{type:'annotation.upsert',annotation:{...annotation,target:{...target,sceneKey:'s'.repeat(257)}}}])).toThrow(/scene identity/);
   expect(()=>applyCommands(h,[{type:'annotation.upsert',annotation:{...annotation,target:{...target,geometryKey:'s'.repeat(257)}}}])).toThrow(/geometry identity/);
 });
 it('rejects mismatched source configurations and attempts to replace original geometry on import',()=>{
   const p=make(),changed=structuredClone(p);changed.nodes[0].sourceHash='sha256:evil';
   expect(()=>validateProposal(changed,p)).toThrow(/identity/);
   const other=createProposal({...context,configurationId:'different'},parts);expect(()=>validateProposal(other,p)).toThrow(/different exact source/);
   const mapping=createProposal(context,[{...parts[0],cadNodePath:[0,3]},parts[1]]);expect(()=>validateProposal(mapping,p)).toThrow(/different exact source/);
   const removed=structuredClone(p);removed.nodes.shift();expect(()=>validateProposal(removed,p)).toThrow(/remain recorded/);
 });
 it('keeps title in history and clears redo after a new branch of changes',()=>{
   let h=applyCommands(createHistory(make()),[{type:'proposal.rename',title:'Move the mount'}]);h=undo(h);
   expect(h.future).toHaveLength(1);h=applyCommands(h,[{type:'rename',nodeId:'occ-1',name:'Alternate mount'}]);expect(h.future).toHaveLength(0);
 });
 it('diffs product changes only; an added then removed concept produces no product change',()=>{
   let h=applyCommands(createHistory(make()),[{type:'add',node:concept},{type:'annotation.upsert',annotation}]);
   expect(proposalChanges(h.present).map(c=>c.kind)).toEqual(['added']);
   h=applyCommands(h,[{type:'remove',nodeId:concept.id}]);expect(proposalChanges(h.present)).toHaveLength(0);
   expect(()=>validateCommands([{type:'explode',amount:1}])).toThrow(/unsupported/);
 });
 it('caps history and rejects oversized markup sequences',()=>{
   let h=createHistory(make());for(let i=0;i<45;i++) h=applyCommands(h,[{type:'proposal.rename',title:`Proposal ${i}`}]);
   expect(h.past).toHaveLength(40);
   expect(()=>applyCommands(h,[{type:'annotation.upsert',annotation:{...annotation,type:'pen',points:Array.from({length:513},()=>[.1,.2])}}])).toThrow(/limit/);
 });
});

describe('local Playground persistence',()=>{
 it('round-trips a draft while rejecting stale sequential writes',()=>{
   const storage=memory(),store=new LocalProposalStore(storage),p=make();expect(store.load(p)).toEqual({proposal:null,revision:0});
   const revision=store.save(p,0);expect(revision).toBe(1);expect(store.load(p).proposal?.id).toBe(p.id);
   expect(()=>store.save(p,0)).toThrow(/Another tab/);expect(store.load(p).revision).toBe(1);
 });
 it('preserves corrupt data and refuses to overwrite it silently',()=>{
   const storage=memory(),store=new LocalProposalStore(storage),p=make(),key=proposalStorageKey(p.sourceKey);storage.setItem(key,'{broken');
   expect(()=>store.load(p)).toThrow(/invalid/);expect(()=>store.save(p,0)).toThrow(/invalid/);expect(store.readRaw(p)).toBe('{broken');
 });
 it('retains the saved version and live draft on storage failure',()=>{
   const storage=memory(),p=make(),store=new LocalProposalStore(storage);store.save(p,0);
   const draft=applyCommands(createHistory(p),[{type:'transform',nodeId:'occ-1',position:[0,1,2]}]).present;
   const failing=new LocalProposalStore({...storage,setItem(){throw new Error('quota');}});
   expect(()=>failing.save(draft,1)).toThrow(/retained/);expect(store.load(p).proposal?.version).toBe(0);expect(draft.nodes[0].position).toEqual([0,1,2]);
 });
 it('isolates workspaces and detects mismatched payloads even if an index is overwritten',()=>{
   const storage=memory(),store=new LocalProposalStore(storage),p=make(),other=createProposal({...context,workspaceId:'other'},parts);
   store.save(other,0);expect(store.load(p).proposal).toBeNull();
   storage.setItem(proposalStorageKey(p.sourceKey),storage.getItem(proposalStorageKey(other.sourceKey))!);
   expect(()=>store.load(p)).toThrow(/different exact source/);
 });
});

describe('ECR review package and simulated handoff',()=>{
 it('preserves frozen captured intent after the live markup is edited and deleted',async()=>{
   let h=applyCommands(createHistory(make()),[{type:'annotation.upsert',annotation}]);
   const captured={kind:'intent' as const,name:'intent.png',imageDataUrl:PNG,sourceKey:h.present.sourceKey,proposalVersion:h.present.version,annotationIds:[annotation.id],annotations:structuredClone(h.present.annotations),camera:{position:[100,100,100] as [number,number,number],target:[0,0,0] as [number,number,number],aspect:1.6},presentation:{view:'proposed' as const,explode:.4,hiddenIds:['occ-2'],labels:true,opacityById:{'occ-1':.35},studio:true}};
   h=applyCommands(h,[{type:'annotation.upsert',annotation:{...annotation,label:'Different instruction'}}]);
   h=applyCommands(h,[{type:'annotation.remove',id:annotation.id}]);
   const review=await createEcrPackage(h.present,{captures:[captured]});
   expect(review.manifest.annotations).toEqual([]);expect(review.manifest.captures[0].annotations?.[0].label).toBe('Move hole here');
   expect(review.manifest.captures[0].proposalVersion).toBe(1);expect(review.manifest.captures[0].camera?.aspect).toBe(1.6);expect(review.manifest.captures[0].presentation?.explode).toBe(.4);
   expect(review.manifest.captures[0].presentation?.opacityById?.['occ-1']).toBe(.35);expect(review.manifest.captures[0].presentation?.studio).toBe(true);
   captured.annotations[0].label='Mutated later';expect(review.captures[0].annotations?.[0].label).toBe('Move hole here');
 });
 it('retains a document capture on its exact file edition, hash and page without requiring current markups',async()=>{
   const document={type:'document' as const,fileId:'drawing',itemId:'part',revision:'A',edition:'2',sourceHash:'sha256:drawing',page:3};
   const mark={...annotation,target:document,anchors:undefined};
   let h=applyCommands(createHistory(make()),[{type:'annotation.upsert',annotation:mark}]);
   const captured={kind:'intent' as const,name:'drawing.png',imageDataUrl:PNG,sourceKey:h.present.sourceKey,proposalVersion:h.present.version,annotations:[mark],document};
   h=applyCommands(h,[{type:'annotation.remove',id:mark.id}]);
   const review=await createEcrPackage(h.present,{captures:[captured]});expect(review.captures[0].document).toEqual(document);
   await expect(createEcrPackage(h.present,{captures:[{...captured,document:{...document,edition:'3'}}]})).rejects.toThrow(/different document edition/);
   await expect(createEcrPackage(h.present,{captures:[{...captured,document:{...document,sourceHash:'sha256:different'}}]})).rejects.toThrow(/different document edition/);
   await expect(createEcrPackage(h.present,{captures:[{...captured,document:undefined}]})).rejects.toThrow(/exact captured file edition/);
 });
 it('rejects mismatched capture source/version, malformed anchor identities, and unsafe presentation data',async()=>{
   const p=applyCommands(createHistory(make()),[{type:'annotation.upsert',annotation}]).present;
   const capture={kind:'intent' as const,name:'intent.png',imageDataUrl:PNG,sourceKey:p.sourceKey,proposalVersion:p.version,annotations:[annotation]};
   await expect(createEcrPackage(p,{captures:[{...capture,sourceKey:'other'}]})).rejects.toThrow(/different source/);
   await expect(createEcrPackage(p,{captures:[{...capture,proposalVersion:p.version+1}]})).rejects.toThrow(/newer proposal version/);
   await expect(createEcrPackage(p,{captures:[{...capture,annotations:[{...annotation,anchors:[{nodeId:'',localPoint:[0,0,0]},null]}]}]})).rejects.toThrow(/Anchor component/);
   await expect(createEcrPackage(p,{captures:[{...capture,presentation:{view:'proposed',explode:2,hiddenIds:[],labels:true}}]})).rejects.toThrow(/display state/);
   await expect(createEcrPackage(p,{captures:[{...capture,presentation:{view:'proposed',explode:0,hiddenIds:[],labels:true,opacityById:{'occ-1':1.5}}}]})).rejects.toThrow(/transparency state/);
   await expect(createEcrPackage(p,{captures:[{...capture,presentation:{view:'proposed',explode:0,hiddenIds:[''],labels:true}}]})).rejects.toThrow(/display state/);
   await expect(createEcrPackage(p,{captures:[{...capture,annotations:undefined,annotationIds:[annotation.id]}]})).rejects.toThrow(/exact annotation text/);
 });
 it('retains historical intent for a concept later undone without mapping it to an Arena affected item',async()=>{
   let h=applyCommands(createHistory(make()),[{type:'add',node:concept}]);
   const mark={...annotation,anchors:[{nodeId:concept.id,localPoint:[1,2,3] as [number,number,number]},null]};
   h=applyCommands(h,[{type:'annotation.upsert',annotation:mark}]);
   const captured={kind:'intent' as const,name:'historical.png',imageDataUrl:PNG,sourceKey:h.present.sourceKey,proposalVersion:h.present.version,annotations:[mark],presentation:{view:'proposed' as const,explode:0,hiddenIds:[concept.id],opacityById:{[concept.id]:.4},labels:true,studio:false}};
   h=undo(undo(h));expect(h.present.nodes.some(node=>node.id===concept.id)).toBe(false);
   const review=await createEcrPackage(h.present,{captures:[captured]});
   expect(review.captures[0].annotations?.[0].label).toBe('Move hole here');expect(review.captures[0].unresolvedAnchorNodeIds).toEqual([concept.id]);
   expect(review.captures[0].presentation?.hiddenIds).toEqual([concept.id]);expect(review.manifest.affectedItems.every(item=>!item.occurrenceIds.includes(concept.id))).toBe(true);
   const roundTrip=await createEcrPackage(h.present,{captures:review.captures});expect(roundTrip.digest).toBe(review.digest);
 });
 it('includes all selected visible source items, deduplicates repeated occurrences, and keeps concepts in the report',async()=>{
   const p=applyCommands(createHistory(make()),[{type:'add',node:concept},{type:'annotation.upsert',annotation}]).present;
   const review=await createEcrPackage(p,{description:'Move the hole.',affectedNodeIds:['occ-1','occ-2',concept.id],attachments:[{name:'description.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byteLength:1234}]});
   expect(review.manifest.affectedItems).toEqual([{itemId:'part',itemNumber:'PN-01',revision:'A',occurrenceIds:['occ-1','occ-2']}]);
   expect(review.manifest.changes[0].kind).toBe('added');expect(review.manifest.annotations[0].label).toBe('Move hole here');expect(review.manifest.cadEdited).toBe(false);
   expect(review.manifest.assumptions).toContain('Thickness is assumed.');expect(JSON.stringify(review)).not.toContain('secret.example');
 });
 it('uses the chosen affected occurrences rather than inferring selection from changed nodes',()=>{
   const p=applyCommands(createHistory(make()),[{type:'remove',nodeId:'occ-1'}]).present;
   expect(affectedItemsForProposal(p,['occ-2'])[0].occurrenceIds).toEqual(['occ-2']);
   expect(()=>affectedItemsForProposal(p,['missing'])).toThrow(/no longer/);
 });
 it('generates stable content digests and returns the same preview receipt on retry without an Arena URL',async()=>{
   const p=make(),first=await createEcrPackage(p,{description:'Test'}),second=await createEcrPackage(p,{description:'Test'});
   expect(first.digest).toBe(second.digest);
   const adapter=new SimulatedEcrAdapter(),a=await adapter.createDraft(first),b=await adapter.createDraft(second);
   expect(a).toEqual(b);expect(a.mode).toBe('preview');expect(a.number).toMatch(/^PREVIEW-ECR-/);expect(a.url).toBeUndefined();expect(a.message).toContain('No Arena record');
 });
 it('rejects tampering after a package was prepared and idempotency reuse for different content',async()=>{
   const p=make(),review=await createEcrPackage(p),adapter=new SimulatedEcrAdapter();await adapter.createDraft(review,'one');
   const altered=structuredClone(review);altered.manifest.description='changed';await expect(adapter.createDraft(altered)).rejects.toThrow(/changed after/);
   const second=await createEcrPackage(p,{description:'different'});await expect(adapter.createDraft(second,'one')).rejects.toThrow(/different review content/);
 });
 it('refuses remote/script images, attachment traversal, duplicate names, and oversized captures',async()=>{
   const p=make();await expect(createEcrPackage(p,{captures:[{kind:'proposed',name:'image.png',imageDataUrl:'https://server/image.png'}]})).rejects.toThrow(/local PNG/);
   await expect(createEcrPackage(p,{attachments:[{name:'../escape.docx',mimeType:'a',byteLength:1}]})).rejects.toThrow(/simple filenames/);
   await expect(createEcrPackage(p,{captures:Array.from({length:4},()=>({kind:'proposed' as const,name:'a.png',imageDataUrl:'data:image/png;base64,AAAA'}))})).rejects.toThrow(/three/);
 });
});
