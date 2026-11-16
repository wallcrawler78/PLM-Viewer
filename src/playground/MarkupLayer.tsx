import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { markupSvg, moveMarkupPoints } from './markup';
import type { Point2 } from './markup';
import type { AnnotationTarget, PlaygroundAnnotation } from './types';

export type MarkupTool = 'select' | PlaygroundAnnotation['type'];
interface Props {
  tool: MarkupTool;
  target: AnnotationTarget;
  marks: {mark: PlaygroundAnnotation;points:Point2[];number?:number}[];
  selectedId?: string | null;
  color: string;
  onSelect: (id:string|null)=>void;
  onChange: (mark:PlaygroundAnnotation)=>void;
  pick?: (u:number,v:number)=>{nodeId:string;localPoint:[number,number,number]}|null;
  onInteractionChange?: (active:boolean)=>void;
  disabled?: boolean;
}

/** An inert SVG display with a bounded pointer editor. Camera controls live below. */
export function MarkupLayer({tool,target,marks,selectedId,color,onSelect,onChange,pick,onInteractionChange,disabled=false}:Props){
  const host=useRef<HTMLDivElement>(null);
  const [draft,setDraft]=useState<PlaygroundAnnotation|null>(null);
  const active=useRef<{mark:PlaygroundAnnotation;current:PlaygroundAnnotation;start:Point2;move:boolean;changed:boolean}|null>(null);
  const interactionCallback=useRef(onInteractionChange);interactionCallback.current=onInteractionChange;
  const [size,setSize]=useState({width:800,height:600});
  useEffect(()=>{const element=host.current;if(!element)return;const observer=new ResizeObserver(entries=>{const r=entries[0]?.contentRect;if(r?.width&&r.height)setSize({width:r.width,height:r.height});});observer.observe(element);return()=>observer.disconnect();},[]);
  useEffect(()=>()=>{if(active.current)interactionCallback.current?.(false);},[]);
  const currentPoint=(event:PointerEvent):Point2=>{const r=host.current!.getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))];};
  function start(event:PointerEvent<HTMLDivElement>){
    if(disabled||event.button!==0||tool==='select')return;
    event.preventDefault();event.stopPropagation();
    const point=currentPoint(event),r=event.currentTarget.getBoundingClientRect();setSize({width:r.width,height:r.height});
    const mark:PlaygroundAnnotation={id:crypto.randomUUID(),type:tool,label:'',color,points:tool==='pin'||tool==='note'?[point]:[point,point],target:structuredClone(target),createdAt:new Date().toISOString()};
    active.current={mark,current:mark,start:point,move:false,changed:false};setDraft(mark);onInteractionChange?.(true);event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event:PointerEvent<HTMLDivElement>){
    const action=active.current;if(!action)return;event.stopPropagation();const point=currentPoint(event);
    let next:PlaygroundAnnotation;
    if(action.move)next={...action.mark,points:moveMarkupPoints(action.mark.points,[point[0]-action.start[0],point[1]-action.start[1]]),anchors:undefined,target:structuredClone(target)};
    else if(action.mark.type==='pen'){
      const points=action.mark.points,last=points.at(-1)!;
      if(Math.hypot(point[0]-last[0],point[1]-last[1])<0.002)return;
      next={...action.mark,points:points.length<512?[...points,point]:[...points.filter((_,i)=>i%2===0),point]};action.mark=next;
    }else next={...action.mark,points:action.mark.type==='note'||action.mark.type==='pin'?[point]:[action.start,point]};
    action.current=next;action.changed ||=Math.hypot(point[0]-action.start[0],point[1]-action.start[1])>0.003;setDraft(next);
  }
  function finish(event:PointerEvent<HTMLDivElement>){
    const action=active.current;if(!action)return;event.stopPropagation();move(event);active.current=null;onInteractionChange?.(false);
    const mark=action.current;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    setDraft(null);
    if(action.move&&!action.changed)return;
    if(!action.move&&mark.type!=='pin'&&mark.type!=='note'&&Math.hypot(mark.points.at(-1)![0]-mark.points[0][0],mark.points.at(-1)![1]-mark.points[0][1])<0.006&&mark.points.length<=2)return;
    // Freehand and region marks are tied to the view. Hundreds of mesh raycasts per
    // stroke are unnecessary and do not establish a meaningful surface region.
    const anchors=target.type==='view'&&pick&&['arrow','note','pin'].includes(mark.type)?mark.points.map(([u,v])=>{const hit=pick(u,v);return hit?{nodeId:hit.nodeId,localPoint:hit.localPoint}:null;}):undefined;
    onChange({...mark,...(anchors?{anchors}:{})});onSelect(mark.id);
  }
  const shown=marks.filter(entry=>entry.mark.id!==draft?.id);if(draft)shown.push({mark:draft,points:draft.points});
  return <div ref={host} className={`pg-markup-layer ${tool!=='select'&&!disabled?'is-drawing':''}`} role="group" aria-label="Drawing and labeling layer" onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={()=>{active.current=null;setDraft(null);onInteractionChange?.(false);}}>
    <svg width="100%" height="100%" className="pg-markup-svg" aria-hidden="true" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" dangerouslySetInnerHTML={{__html:markupSvg(shown,size.width,size.height).replace(/^<svg[^>]*>|<\/svg>$/g,'')}}/>
    {tool==='select'&&!disabled&&marks.map(({mark,points})=><button key={mark.id} type="button" className={`pg-markup-hit ${selectedId===mark.id?'selected':''}`} style={{left:`${points[0][0]*100}%`,top:`${points[0][1]*100}%`}} title={mark.label||'Edit markup'} aria-label={`Edit markup: ${mark.label||mark.type}`} onClick={event=>{event.stopPropagation();onSelect(mark.id);}} onPointerDown={event=>{event.stopPropagation();const point=currentPoint(event),current={...mark,points};active.current={mark:current,current,start:point,move:true,changed:false};setDraft(current);onInteractionChange?.(true);host.current?.setPointerCapture(event.pointerId);onSelect(mark.id);}}>{mark.type==='pin'?'●':'✎'}</button>)}
  </div>;
}
