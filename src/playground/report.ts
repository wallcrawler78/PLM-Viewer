import JSZip from 'jszip';
import type { EcrPackage, EcrReceipt } from './ecr';

const escapeXml=(text:string)=>text.replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
const p=(text:string,style='Normal')=>`<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${text.split('\n').map((line,index)=>`${index?'<w:r><w:br/></w:r>':''}<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`).join('')}</w:p>`;
const cell=(text:string,heading=false)=>`<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${heading?'<w:shd w:fill="E8EFF5"/>':''}<w:vAlign w:val="center"/><w:tcMar><w:top w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${p(text,heading?'TableHeading':'Normal')}</w:tc>`;
const table=(head:string[],rows:string[][])=>`<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(edge=>`<w:${edge} w:val="single" w:sz="4" w:color="D9D9D9"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${head.map(()=>`<w:gridCol w:w="${Math.floor(9360/head.length)}"/>`).join('')}</w:tblGrid><w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${head.map(value=>cell(value,true)).join('')}</w:tr>${rows.map(row=>`<w:tr><w:trPr><w:cantSplit/></w:trPr>${row.map(value=>cell(value)).join('')}</w:tr>`).join('')}</w:tbl>`;

export function imageBytes(dataUrl:string):Uint8Array {
  const body=dataUrl.split(',')[1];if(!body||body.length>3_000_000)throw new Error('The captured image is unavailable or too large.');
  const raw=atob(body);return Uint8Array.from(raw,char=>char.charCodeAt(0));
}

function imageDimensions(bytes:Uint8Array):{width:number;height:number} {
  const checked=(width:number,height:number)=>{if(!width||!height||width>100_000||height>100_000)throw new Error('The captured image dimensions are invalid.');return {width,height};};
  if(bytes.length>24&&bytes[0]===137&&bytes[1]===80){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return checked(view.getUint32(16),view.getUint32(20));}
  if(bytes[0]===255&&bytes[1]===216){
    let offset=2;
    while(offset+8<bytes.length){
      if(bytes[offset++]!==255)break;
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===217||marker===218)break;
      if(marker===1||marker>=208&&marker<=216)continue;
      const length=(bytes[offset]<<8)|bytes[offset+1];if(length<2||offset+length>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return checked((bytes[offset+5]<<8)|bytes[offset+6],(bytes[offset+3]<<8)|bytes[offset+4]);
      offset+=length;
    }
  }
  throw new Error('The captured PNG or JPEG dimensions could not be read. Recapture this view.');
}

/** Locally generated OpenXML: no Word service, document API or generative image dependency. */
export async function buildWordReport(review:EcrPackage):Promise<Uint8Array> {
  const m=review.manifest,zip=new JSZip(),relationships:string[]=[];
  let body=p(m.title,'Title')+p('ENGINEERING CHANGE PROPOSAL','Subtitle')+p(m.source.sourceMode==='preview'?'Preview workspace • No Arena request has been submitted':'Prepared for Arena review • Submission status is recorded separately','Caption');
  body+=p('Change description','Heading1')+p(m.description||'No additional description supplied.');
  body+=p('Source and scope','Heading1')+table(['Product / revision','Proposal / version'],[[`${m.source.itemNumber} • ${m.source.name}\nRevision ${m.source.revision}`,`${m.proposalId}\nVersion ${m.proposalVersion}`]])+p(`Workspace: ${m.source.workspaceId}\nSnapshot: ${m.source.snapshotId}\nConfiguration: ${m.source.configurationId??'Not supplied'}\nUnits: millimeters; rotations: XYZ radians`,'Caption');
  body+=p('These views describe proposed changes to web 3D representations. Original CAD and released PLM records were not edited. Engineering feasibility, manufacturing detail and drawing compliance require review.');
  body+=p('Affected items','Heading1')+(m.affectedItems.length?table(['Item number','Revision','Visible / selected occurrences'],m.affectedItems.map(item=>[item.itemNumber,item.revision,item.occurrenceIds.join(', ')||'Parent assembly'])):p('No existing Arena items were selected. Unnumbered concept parts appear in the change list.'));
  body+=p('Proposed changes','Heading1')+(m.changes.length?table(['Component','Change','Details'],m.changes.map(change=>[`${change.itemNumber??'Concept'} — ${change.name}`,change.kind,change.summary])):p('No geometry or component changes. Review the intent markups below.'));
  if(m.annotations.length){body+=p('Design intent and markups','Heading1');body+=table(['Markup','Instruction','Source'],m.annotations.map((mark,index)=>[`${index+1}. ${mark.type}`,mark.label||'Unlabeled markup',mark.target.type==='document'?`${mark.target.fileId} • Rev ${mark.target.revision} • Edition ${mark.target.edition} • Page ${mark.target.page}`:mark.anchors?.every(Boolean)?'Model surface anchors':'Saved model camera — view-specific intent']));}
  if(m.assumptions.length)body+=p('Assumptions to review','Heading1')+m.assumptions.map(text=>p(`• ${text}`)).join('');
  for(let index=0;index<review.captures.length;index++){
    const capture=review.captures[index],bytes=imageBytes(capture.imageDataUrl),ext=capture.imageDataUrl.startsWith('data:image/jpeg')?'jpg':'png',path=`media/view-${index+1}.${ext}`,rid=`rIdImage${index+1}`;
    zip.file(`word/${path}`,bytes);relationships.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${path}"/>`);
    const dimensions=imageDimensions(bytes),ratio=dimensions.height/dimensions.width;
    const width=Math.min(5_943_600,7_000_000/ratio),height=Math.round(width*ratio);
    body+='<w:p><w:r><w:br w:type="page"/></w:r></w:p>'+p(capture.kind==='intent'?'Captured design intent':capture.kind==='baseline'?'Source configuration':'Proposed configuration','Heading1')+p(`${capture.name}${capture.proposalVersion===undefined?'':` • Captured proposal version ${capture.proposalVersion}`}`,'Caption');
    if(capture.document)body+=p(`Drawing: ${capture.document.fileId} • Revision ${capture.document.revision} • Edition ${capture.document.edition} • Page ${capture.document.page}`,'Caption');
    if(capture.annotations?.length)body+=table(['Original markup','Instruction at capture'],capture.annotations.map((mark,number)=>[`${number+1}. ${mark.type}`,mark.label||'Unlabeled markup']));
    body+=`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${Math.round(width)}" cy="${height}"/><wp:docPr id="${index+1}" name="${escapeXml(capture.name)}" descr="Actual locally rendered ${capture.kind} view"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index+1}" name="${escapeXml(capture.name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(width)}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    body+=p(capture.kind==='intent'?'The markup records the requested change. It does not independently prove a dimension or a 3D location.':'Rendered from the interactive scene. Display meshes and concept representations are approximate.','Caption');
  }
  body+='<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440"/></w:sectPr>';
  zip.file('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels',`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${relationships.join('')}</Relationships>`);
  zip.file('word/styles.xml',`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/><w:color w:val="233647"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${[['Normal','Normal',21,'233647'],['Title','Title',44,'000000'],['Subtitle','Subtitle',20,'000000'],['Heading1','heading 1',28,'000000'],['Caption','Caption',18,'617580'],['TableHeading','Table Heading',20,'000000']].map(([id,name,size,color])=>`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:pPr>${id==='Heading1'?'<w:keepNext/><w:spacing w:before="260" w:after="150"/>':''}</w:pPr><w:rPr><w:sz w:val="${size}"/><w:color w:val="${color}"/>${['Title','Heading1','TableHeading'].includes(String(id))?'<w:b/>':''}</w:rPr></w:style>`).join('')}</w:styles>`);
  zip.file('word/document.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}

export async function sha256(bytes:Uint8Array):Promise<string>{const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');}

export async function buildReviewArchive(review:EcrPackage,word:Uint8Array,receipt:EcrReceipt):Promise<Uint8Array>{
  const zip=new JSZip();
  zip.file('proposal-manifest.json',JSON.stringify(review.manifest,null,2));
  zip.file('creation-receipt.json',JSON.stringify(receipt,null,2));
  zip.file('change-summary.docx',word);
  for(const capture of review.captures)zip.file(capture.name,imageBytes(capture.imageDataUrl));
  zip.file('README.txt',`Review Studio — Playground proposal\n\n${receipt.message}\n\nProposal: ${review.manifest.proposalId}\nVersion: ${review.manifest.proposalVersion}\nPackage digest: ${review.digest}\n\nOpen change-summary.docx for the description, affected items, accepted changes, original intent and rendered views. proposal-manifest.json records the exact source binding and scene operations. This package contains no source STEP/PDF/Word attachments or access credentials.\n`);
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}

export function downloadBytes(name:string,bytes:Uint8Array|string,mime='application/json'){
  const blob=new Blob([typeof bytes==='string'?bytes:new Uint8Array(bytes)],{type:mime}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);
}
