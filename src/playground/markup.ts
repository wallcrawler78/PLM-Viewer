import type { CameraState, PlaygroundAnnotation, ProposalNode, Vec3 } from './types';

export type Point2 = [number, number];
export const sameCamera = (a: CameraState, b: CameraState, tolerance = 0.00001) => {
  const distance=Math.hypot(...a.position.map((v,i)=>v-a.target[i]));
  return [...a.position,...a.target].every((v,i)=>Math.abs(v-[...b.position,...b.target][i])<=Math.max(0.0001,distance*tolerance));
};

// A compact display-state index, never an authorization or source identity proof.
function signature(value:unknown):string{const text=JSON.stringify(value);let a=2166136261,b=5381;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}return `${(a>>>0).toString(16)}-${(b>>>0).toString(16)}`;}
// Opaque IDs must sort identically when an exported proposal is opened by a
// colleague whose browser uses a different locale.
const compareId=(a:unknown[],b:unknown[])=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0;
export function markupGeometryKey(nodes:ProposalNode[]):string{return signature(nodes.map(node=>[node.id,node.kind,node.sourceHash,node.sourceBinding,node.dimensions]).sort(compareId));}
/** The display state a view-bound mark was drawn over. It does not change when a part is moved or a concept is added. */
export function markupPresentationKey(presentation:{view:string;explode:number;hiddenIds:string[]}):string{return signature([presentation.view,presentation.explode,[...presentation.hiddenIds].sort()]);}
export function markupSceneKey(nodes:ProposalNode[],presentation:{view:string;explode:number;hiddenIds:string[]}):string{return signature([markupGeometryKey(nodes),nodes.map(node=>[node.id,node.position,node.rotation,!!node.removed]).sort(compareId),presentation.view,presentation.explode,[...presentation.hiddenIds].sort()]);}

/** Move the complete stroke while preserving its shape and page bounds. */
export function moveMarkupPoints(points: readonly Point2[], delta: Point2): Point2[] {
  if (!points.length) return [];
  const x = Math.min(1 - Math.max(...points.map(p => p[0])), Math.max(-Math.min(...points.map(p => p[0])), delta[0]));
  const y = Math.min(1 - Math.max(...points.map(p => p[1])), Math.max(-Math.min(...points.map(p => p[1])), delta[1]));
  return points.map(p => [p[0] + x, p[1] + y]);
}

export function visibleMarkupPoints(mark: PlaygroundAnnotation, camera: CameraState | undefined, project?: (nodeId: string, point: Vec3) => Point2 | null, sceneKey?:string, _geometryKey?:string, presentationKey?:string): Point2[] | null {
  if (mark.target.type === 'document') return mark.points;
  // A fully surface-anchored mark follows its own components through later edits to
  // other parts, added concepts, explosion and camera moves. It disappears only when
  // an anchored component is no longer in the displayed scene.
  if (project && mark.anchors?.length === mark.points.length && mark.anchors.every(Boolean)) {
    const projected = mark.anchors.map(anchor => project(anchor!.nodeId, anchor!.localPoint));
    return projected.every(Boolean) ? projected as Point2[] : null;
  }
  // One mesh hit does not establish depth for a whole stroke, so a view-bound mark
  // belongs to its camera and display state. Editing the proposal does not hide it;
  // switching Original/Proposed/Overlay, exploding or hiding parts does.
  if(mark.target.presentationKey!==undefined){if(mark.target.presentationKey!==presentationKey)return null;}
  else if(mark.target.sceneKey&&mark.target.sceneKey!==sceneKey)return null;
  if(!camera||!sameCamera(mark.target.camera,camera))return null;
  // Fixed vertical FOV in the Playground renderer: adapt view points to a changed
  // aspect ratio without inventing depth or moving them onto a different ray.
  const aspect=mark.target.camera.aspect&&camera.aspect?mark.target.camera.aspect/camera.aspect:1;
  const points=mark.points.map(([x,y]):Point2=>[0.5+(x-0.5)*aspect,y]);
  return points.every(([x,y])=>x>=0&&x<=1&&y>=0&&y<=1)?points:null;
}

const xml = (value: string) => value.replace(/[<>&"']/g, character => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[character]!));

/** Shared scene/page capture layer. No remote image or markup code is executed. */
/** `number` is the markup's position in the proposal's markup list, so an image, the
 * on-screen list and the change document all refer to the same markup by the same number. */
export function markupSvg(marks: { mark: PlaygroundAnnotation; points: Point2[]; number?: number }[], width: number, height: number): string {
  const line = Math.max(2, width / 550), font = Math.max(12, width / 85);
  // Label boxes already placed, plus every numbered badge, so a later label does not cover them.
  const taken: [number, number, number, number][] = marks.flatMap(({points, number}) => number && points.length ? [[points[0][0]*width-font*1.7, points[0][1]*height-font*1.7, font*2.6, font*2.6] as [number, number, number, number]] : []);
  const overlaps = (x: number, y: number, w: number, h: number) => taken.some(([tx, ty, tw, th]) => x < tx+tw && x+w > tx && y < ty+th && y+h > ty);
  const shapes = marks.map(({mark, points, number}, markIndex) => {
    if (!points.length) return '';
    const color = /^#[a-f\d]{6}$/i.test(mark.color) ? mark.color : '#76e2bb';
    const p = points.map(([x,y]) => [x * width,y * height]), a = p[0], b = p.at(-1)!;
    let shape = '';
    if (mark.type === 'arrow') {
      const theta = Math.atan2(b[1]-a[1],b[0]-a[0]), length = font;
      const l = [b[0]-length*Math.cos(theta-0.4),b[1]-length*Math.sin(theta-0.4)], r = [b[0]-length*Math.cos(theta+0.4),b[1]-length*Math.sin(theta+0.4)];
      shape = `<path d="M ${a.join(' ')} L ${b.join(' ')} M ${l.join(' ')} L ${b.join(' ')} L ${r.join(' ')}"/>`;
    } else if (mark.type === 'rect') shape = `<rect x="${Math.min(a[0],b[0])}" y="${Math.min(a[1],b[1])}" width="${Math.abs(b[0]-a[0])}" height="${Math.abs(b[1]-a[1])}" rx="3"/>`;
    else if (mark.type === 'ellipse') shape = `<ellipse cx="${(a[0]+b[0])/2}" cy="${(a[1]+b[1])/2}" rx="${Math.abs(b[0]-a[0])/2}" ry="${Math.abs(b[1]-a[1])/2}"/>`;
    else if (mark.type === 'pen') shape = `<polyline points="${p.map(point=>point.join(',')).join(' ')}"/>`;
    else shape = mark.type==='pin'?`<circle cx="${a[0]}" cy="${a[1]}" r="${font*0.75}" fill="${color}"/><text x="${a[0]}" y="${a[1]+font*0.33}" text-anchor="middle" stroke="none" fill="#133d32" font-family="Arial,sans-serif" font-size="${font}">${number??markIndex+1}</text>`:`<circle cx="${a[0]}" cy="${a[1]}" r="${font/2}" fill="${color}"/>`;
    if (number && mark.type !== 'pin') { const bx = Math.min(width-font, Math.max(font, a[0]-font*0.9)), by = Math.min(height-font, Math.max(font, a[1]-font*0.9)); shape += `<g stroke="none"><circle cx="${bx}" cy="${by}" r="${font*0.72}" fill="${color}"/><text x="${bx}" y="${by+font*0.33}" text-anchor="middle" fill="#133d32" font-family="Arial,sans-serif" font-size="${font*0.92}">${number}</text></g>`; }
    const labelText = mark.label.slice(0,180)+(mark.label.length>180?'…':''), label = labelText && number ? `${number}. ${labelText}` : labelText, lines = label.match(/.{1,42}(?:\s|$)|.{1,42}/g) ?? [];
    const labelWidth = Math.min(width-16, Math.max(50, ...lines.map(value => value.length * font * 0.56 + 16)));
    // A region's label sits under the region so it never covers what the region marks.
    const region = mark.type === 'rect' || mark.type === 'ellipse', labelHeight = font*(lines.length+1);
    const below = Math.max(a[1],b[1])+8, above = Math.min(a[1],b[1])-labelHeight-8;
    const x = Math.min(width-labelWidth-8, Math.max(8, region ? Math.min(a[0],b[0]) : a[0]+12));
    let y = region ? (below+labelHeight<=height-8 ? below : Math.max(8, above)) : Math.min(height-labelHeight-8,Math.max(8,a[1]+14));
    if (label) {
      // Step down, then up, until the label is clear of other labels and badges.
      const start = y, step = font*0.75; let placed = !overlaps(x, y, labelWidth, labelHeight);
      for (const direction of [1, -1]) for (let k = 1; !placed && k <= 40; k++) { const candidate = start + direction*k*step; if (candidate < 8 || candidate + labelHeight > height - 8) break; if (!overlaps(x, candidate, labelWidth, labelHeight)) { y = candidate; placed = true; } }
      taken.push([x, y, labelWidth, labelHeight]);
    }
    const text = label ? `<g stroke="none"><rect x="${x}" y="${y}" width="${labelWidth}" height="${labelHeight}" rx="5" fill="#13242d" fill-opacity="0.94"/><text fill="#f2f9f7" font-family="Arial,sans-serif" font-size="${font}">${lines.map((value,i)=>`<tspan x="${x+8}" y="${y+font*(i+1)}">${xml(value.trim())}</tspan>`).join('')}</text></g>` : '';
    return `<g fill="none" stroke="${color}" stroke-width="${line}" stroke-linecap="round" stroke-linejoin="round">${shape}${text}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes}</svg>`;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  await new Promise<void>((resolve,reject) => {img.onload=()=>resolve();img.onerror=()=>reject(new Error('The rendered image could not be captured.'));img.src=url;});
  return img;
}

export async function compositeMarkup(image: string, marks: {mark: PlaygroundAnnotation;points:Point2[];number?:number}[], maxWidth = 1600): Promise<string> {
  const source = await loadImage(image), scale = Math.min(1,maxWidth/source.width);
  const canvas=document.createElement('canvas');canvas.width=Math.round(source.width*scale);canvas.height=Math.round(source.height*scale);
  const context=canvas.getContext('2d');if(!context)throw new Error('Image capture is unavailable in this browser.');
  context.drawImage(source,0,0,canvas.width,canvas.height);
  if(marks.length){
    const url=URL.createObjectURL(new Blob([markupSvg(marks,canvas.width,canvas.height)],{type:'image/svg+xml'}));
    try {context.drawImage(await loadImage(url),0,0);} finally {URL.revokeObjectURL(url);}
  }
  return canvas.toDataURL('image/png');
}
