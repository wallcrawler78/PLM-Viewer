import {describe,it,expect} from 'vitest';
import JSZip from 'jszip';
import {createProposal,createHistory,applyCommands} from '../src/playground/state';
import {createEcrPackage,SimulatedEcrAdapter} from '../src/playground/ecr';
import {buildWordReport,buildReviewArchive,sha256} from '../src/playground/report';

const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2qWkAAAAASUVORK5CYII=';
const make=()=>createProposal({workspaceId:'workspace',snapshotId:'frozen',rootItemId:'asm',itemNumber:'ASM-1',name:'Étude <product> & mount',revision:'B',sourceMode:'preview'},[{id:'occurrence',itemId:'item',itemNumber:'PN-01',name:'Bracket & plate',revision:'A',sourceHash:'sha256:original',stepUrl:'https://private.example/file?token=secret',position:[0,0,0],rotation:[0,0,0],color:'#aaaabb'}]);

describe('local ECR Word and archive generation',()=>{
 it('includes the captured original instruction after its live markup is edited and deleted',async()=>{
   let history=applyCommands(createHistory(make()),[{type:'annotation.upsert',annotation:{id:'intent',type:'arrow',label:'Original request: move <hole> & retain clearance',color:'#ffcc00',points:[[.2,.3],[.5,.6]],target:{type:'view',camera:{position:[100,100,100],target:[0,0,0],aspect:1.6},sceneKey:'scene-at-capture',geometryKey:'shape-at-capture'},createdAt:'2026-01-01T00:00:00.000Z'}}]);
   const capture={kind:'intent' as const,name:'original-intent.png',imageDataUrl:PNG,sourceKey:history.present.sourceKey,proposalVersion:history.present.version,annotations:structuredClone(history.present.annotations)};
   history=applyCommands(history,[{type:'annotation.upsert',annotation:{...history.present.annotations[0],label:'A later replacement'}}]);
   history=applyCommands(history,[{type:'annotation.remove',id:'intent'}]);
   const review=await createEcrPackage(history.present,{captures:[capture]});expect(review.manifest.annotations).toEqual([]);
   const zip=await JSZip.loadAsync(await buildWordReport(review)),xml=await zip.file('word/document.xml')!.async('string');
   expect(xml).toContain('Original request: move &lt;hole&gt; &amp; retain clearance');expect(xml).not.toContain('A later replacement');
   expect(xml).toContain('Captured proposal version 1');expect(xml).toContain('Instruction at capture');
 });
 it('embeds actual captured image bytes with valid OpenXML relationships and safely escapes unicode text',async()=>{
   const proposal=applyCommands(createHistory(make()),[{type:'transform',nodeId:'occurrence',position:[12,0,0]}]).present;
   const review=await createEcrPackage(proposal,{title:'Move <hole> & review “fit”',description:'第一行 & <instruction>\nUse a 12 mm offset.',captures:[{kind:'proposed',name:'design.png',imageDataUrl:PNG}]});
   const word=await buildWordReport(review),zip=await JSZip.loadAsync(word);
   expect(zip.file('[Content_Types].xml')).not.toBeNull();expect(zip.file('_rels/.rels')).not.toBeNull();
   const xml=await zip.file('word/document.xml')!.async('string');
   expect(xml).toContain('Move &lt;hole&gt; &amp; review “fit”');expect(xml).toContain('第一行 &amp; &lt;instruction&gt;');expect(xml).toContain('<w:br/>');expect(xml).not.toContain('<instruction>');
   expect(xml).toContain('PN-01');expect(xml).toContain('position [0, 0, 0] → [12, 0, 0] mm (moved +12, 0, 0 mm in X, Y, Z)');expect(xml).toContain('Source value → proposed value');expect(xml).toContain('degrees about X, Y, Z');
   // Identical content must give identical bytes so a retry is recognised as the same package.
   expect(await sha256(await buildWordReport(review))).toBe(await sha256(word));expect(xml).toContain('r:embed="rIdImage1"');
   const relationships=await zip.file('word/_rels/document.xml.rels')!.async('string');expect(relationships).toContain('Target="media/view-1.png"');expect(relationships).toContain('Id="rIdImage1"');
   const image=await zip.file('word/media/view-1.png')!.async('uint8array');expect(Array.from(image.slice(0,8))).toEqual([137,80,78,71,13,10,26,10]);
   expect(xml).not.toContain('private.example');expect(xml).not.toContain('token=secret');
 });
 it('packages the description, image, manifest and explicit preview receipt without including original source files',async()=>{
   const proposal=make(),preliminary=await createEcrPackage(proposal,{description:'Review this configuration.',captures:[{kind:'intent',name:'intent.png',imageDataUrl:PNG}]}),word=await buildWordReport(preliminary);
   const review=await createEcrPackage(proposal,{description:preliminary.manifest.description,captures:preliminary.captures,attachments:[{name:'change-summary.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byteLength:word.byteLength,sha256:await sha256(word)}]});
   const receipt=await new SimulatedEcrAdapter().createDraft(review),archive=await JSZip.loadAsync(await buildReviewArchive(review,word,receipt));
   expect(Object.keys(archive.files).sort()).toEqual(['README.txt','change-summary.docx','creation-receipt.json','intent.png','proposal-manifest.json']);
   const storedWord=await archive.file('change-summary.docx')!.async('uint8array');expect(await sha256(storedWord)).toBe(review.manifest.attachments[0].sha256);
   const manifest=await archive.file('proposal-manifest.json')!.async('string');expect(manifest).not.toContain('private.example');expect(manifest).not.toContain('token=secret');expect(manifest).toContain('sha256:original');
   const readback=JSON.parse(await archive.file('creation-receipt.json')!.async('string'));expect(readback.mode).toBe('preview');expect(readback.url).toBeUndefined();expect(readback.attachmentNames).toContain('change-summary.docx');
 });
 it('states source and proposed values, concept dimensions and which listed items actually change',async()=>{
   let history=applyCommands(createHistory(make()),[{type:'transform',nodeId:'occurrence',position:[18,0,-2.5],rotation:[0,0,Math.PI/2]}]);
   history=applyCommands(history,[{type:'add',node:{id:'concept-bracket',name:'Concept bracket',kind:'bracket',position:[40,0,10],rotation:[0,0,0],color:'#62cdb4',dimensions:{width:60,depth:40,height:28,thickness:3,holeDiameter:8,holeX:5,holeY:-3},provenance:{kind:'manual',assumptions:[]}}}]);
   const review=await createEcrPackage(history.present,{description:'Shift the bracket.',captures:[{kind:'baseline',name:'source-design.png',imageDataUrl:PNG},{kind:'proposed',name:'proposed-design.png',imageDataUrl:PNG}],includeRootItem:true});
   const moved=review.manifest.changes.find(change=>change.nodeId==='occurrence')!,added=review.manifest.changes.find(change=>change.nodeId==='concept-bracket')!;
   expect(moved.summary).toContain('position [0, 0, 0] → [18, 0, -2.5] mm (moved +18, 0, -2.5 mm in X, Y, Z)');
   expect(moved.summary).toContain('rotation [0, 0, 0]° → [0, 0, 90]° XYZ');
   expect(added.summary).toContain('60 × 40 × 28 mm (width × depth × height), thickness 3 mm, hole ⌀8 mm at (5, -3) mm from plate centre');
   expect(added.summary).toContain('not CAD');
   const xml=await (await JSZip.loadAsync(await buildWordReport(review))).file('word/document.xml')!.async('string');
   expect(xml).toContain('Source configuration');expect(xml).toContain('Proposed configuration');
   expect(xml.indexOf('Source configuration')).toBeLessThan(xml.indexOf('Proposed configuration'));
   // The moved item is marked as changed; the parent assembly was added for review only.
   expect(xml).toContain('>Changed<');expect(xml).toContain('No change — listed for review');expect(xml).toContain('hole ⌀8 mm');
 });
});
