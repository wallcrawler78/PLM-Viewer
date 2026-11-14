import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { Attachment } from '../domain';
import { FileView } from '../components/Documents';
import { planPdfComparison } from '../pdf-visual-raster';
import type { PdfRasterAvailability } from '../pdf-visual-raster';
import { compositeMarkup } from './markup';
import { MarkupLayer } from './MarkupLayer';
import type { MarkupTool } from './MarkupLayer';
import type { AnnotationTarget, PlaygroundAnnotation } from './types';

export interface PlaygroundDocumentHandle {
  capture(signal?:AbortSignal):Promise<{image:string;target:Extract<AnnotationTarget,{type:'document'}>}>;
}
interface Props {
  file:Attachment;
  tool:MarkupTool;
  color:string;
  marks:PlaygroundAnnotation[];
  selectedId?:string|null;
  onSelect:(id:string|null)=>void;
  onChange:(mark:PlaygroundAnnotation)=>void;
  onActivate:()=>void;
  onInteractionChange?:(active:boolean)=>void;
  focusPage?:{page:number;nonce:number};
}

export const PlaygroundDocument=forwardRef<PlaygroundDocumentHandle,Props>(function PlaygroundDocument({file,tool,color,marks,selectedId,onSelect,onChange,onActivate,onInteractionChange,focusPage},ref){
  const [raster,setRaster]=useState<PdfRasterAvailability>({status:'loading'});
  const page=useRef(1);
  const target=(number:number):Extract<AnnotationTarget,{type:'document'}>=>({type:'document',fileId:file.id,itemId:file.itemId,revision:file.revision,edition:file.edition,sourceHash:file.sourceHash,page:number});
  const pageMarks=(number:number)=>marks.filter(mark=>mark.target.type==='document'&&mark.target.fileId===file.id&&mark.target.itemId===file.itemId&&mark.target.revision===file.revision&&mark.target.edition===file.edition&&mark.target.sourceHash===file.sourceHash&&mark.target.page===number);
  useImperativeHandle(ref,()=>({async capture(signal){
    if(raster.status!=='ready'||file.kind!=='pdf')throw new Error('Open a rendered PDF page to capture a drawing. Word remains available in the document reader.');
    const capturePage=page.current,captureTarget=target(capturePage),captureMarks=pageMarks(capturePage),controller=new AbortController();
    const activeSignal=signal??controller.signal;
    const dimensions=await raster.source.dimensions(capturePage,activeSignal),plan=planPdfComparison(dimensions,null),pixels=await raster.source.render(capturePage,plan.pixelsPerPoint,activeSignal);
    activeSignal.throwIfAborted();
    const canvas=document.createElement('canvas');canvas.width=pixels.width;canvas.height=pixels.height;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Document capture is unavailable.');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height),0,0);
    return {image:await compositeMarkup(canvas.toDataURL('image/png'),captureMarks.map(mark=>({mark,points:mark.points})),1280),target:captureTarget};
  }}));
  return <div className="pg-document-reader" onPointerDownCapture={onActivate}>
    {file.kind!=='pdf'&&tool!=='select'&&<p className="pg-document-notice">Drawing tools attach to PDF pages. This Word document keeps its reading and text-search tools.</p>}
    <FileView file={file} compact onPdfRaster={setRaster} onNavigate={value=>{page.current=value.page;}} navigation={focusPage?{...focusPage,progress:0}:undefined} pageOverlay={number=><MarkupLayer key={number} tool={tool} target={target(number)} color={color} marks={pageMarks(number).map(mark=>({mark,points:mark.points}))} selectedId={selectedId} onSelect={onSelect} onChange={onChange} onInteractionChange={onInteractionChange}/>}/>
  </div>;
});
