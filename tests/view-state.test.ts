import { describe, it, expect } from 'vitest';
import { parseViewerState } from '../src/view-state';
const state = { revision:'B', mode:'overlay', selectedIds:['occ-base'], hiddenIds:[], loadedIds:['occ-base'], opacityById:{'occ-base':0.5}, explode:0.4, section:{enabled:false,axis:'z',offset:0}, camera:{position:[200,100,200],target:[0,0,0]},documentId:'pdf-B',pinned:true,panelOpen:true };
describe('saved viewer state boundary', () => {
  it('round trips a valid assembly and document layout', () => expect(parseViewerState(JSON.parse(JSON.stringify(state)))).toEqual(state));
  it('rejects non-finite camera positions before passing them to WebGL', () => expect(() => parseViewerState({...state,camera:{position:[Infinity,0,0],target:[0,0,0]}})).toThrow('camera'));
  it('rejects unknown source revisions and unsafe opacity', () => {
    expect(() => parseViewerState({...state,revision:'LATEST'})).toThrow('source revision');
    expect(() => parseViewerState({...state,opacityById:{x:-1}})).toThrow('transparency');
  });
  it('rejects imported comparisons that would display baseline A twice under A/B labels', () => {
    for (const mode of ['overlay', 'split']) expect(() => parseViewerState({...state,revision:'A',mode})).toThrow('comparison view');
    expect(parseViewerState({...state,revision:'A',mode:'single'}).revision).toBe('A');
  });
  it('preserves document layout and column settings, while rejecting oversized panes',()=>{
    const layout={...state,panel:'reference',documentWidth:430,columns:['attr-material'],overlayOpacity:{a:0.2,b:0.7},showBounds:true};
    expect(parseViewerState(layout)).toEqual(layout);
    expect(()=>parseViewerState({...layout,documentWidth:100000})).toThrow('document width');
  });
  it('restores universal review layouts without accepting malformed imported modes',()=>{
    const layout={...state,workspaceView:'documents',documentCompare:true,navigationOpen:false,splitRatio:55};
    expect(parseViewerState(layout)).toEqual(layout);
    expect(()=>parseViewerState({...layout,workspaceView:'unknown'})).toThrow('workspace view');
    expect(()=>parseViewerState({...layout,documentCompare:'yes'})).toThrow('document review');
    expect(()=>parseViewerState({...layout,splitRatio:NaN})).toThrow('document split');
  });
});
