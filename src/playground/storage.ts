import type { Proposal } from './types';
import { PLAYGROUND_LIMITS } from './types';
import { validateProposal } from './state';

export interface ProposalStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export class ProposalStorageError extends Error {
  constructor(readonly code: 'UNAVAILABLE'|'CORRUPT'|'CONFLICT'|'QUOTA'|'SOURCE_MISMATCH', message: string) { super(message); this.name='ProposalStorageError'; }
}
interface StoredProposal { schemaVersion:1; storageRevision:number; proposal:Proposal }
export interface LoadedProposal { proposal:Proposal|null; revision:number }

/** The compact hash is an index only. The full source key is verified on every read. */
export function proposalStorageKey(sourceKey:string):string {
  let a=2166136261,b=5381;
  for(let i=0;i<sourceKey.length;i++) { a=Math.imul(a^sourceKey.charCodeAt(i),16777619); b=Math.imul(b,33)^sourceKey.charCodeAt(i); }
  return `review-studio.playground.v1:${(a>>>0).toString(16)}${(b>>>0).toString(16)}`;
}
function defaultStorage():ProposalStorage {
  try { return window.localStorage; } catch { throw new ProposalStorageError('UNAVAILABLE','Browser storage is unavailable. Your proposal remains open in this session; export a package to keep it.'); }
}
const byteLength=(value:string)=>new TextEncoder().encode(value).byteLength;

/** Browser-local drafting, not shared Arena storage. Sequential stale writes are rejected;
 * localStorage does not provide transactional compare-and-swap between browser tabs. */
export class LocalProposalStore {
  constructor(private readonly supplied?:ProposalStorage) {}
  private storage() { return this.supplied ?? defaultStorage(); }
  readRaw(baseline:Proposal):string|null {
    try { return this.storage().getItem(proposalStorageKey(baseline.sourceKey)); }
    catch(error) { if(error instanceof ProposalStorageError) throw error; throw new ProposalStorageError('UNAVAILABLE','The saved proposal could not be read. The current draft has been retained.'); }
  }
  private parse(raw:string,baseline:Proposal):StoredProposal {
    try {
      if(byteLength(raw)>PLAYGROUND_LIMITS.storageBytes) throw new Error('Stored draft exceeds size limit.');
      const v:unknown=JSON.parse(raw);
      if(!v||typeof v!=='object'||Array.isArray(v)) throw new Error('Missing record.');
      const record=v as Record<string,unknown>;
      if(Object.keys(record).some(key=>!['schemaVersion','storageRevision','proposal'].includes(key))||record.schemaVersion!==1||!Number.isSafeInteger(record.storageRevision)||(record.storageRevision as number)<1) throw new Error('Invalid storage version.');
      const proposal=validateProposal(record.proposal);
      if(proposal.sourceKey!==baseline.sourceKey) throw new ProposalStorageError('SOURCE_MISMATCH','This stored draft belongs to a different exact source. It has not been replaced or remapped.');
      return {schemaVersion:1,storageRevision:record.storageRevision as number,proposal:validateProposal(proposal,baseline)};
    } catch(error) {
      if(error instanceof ProposalStorageError) throw error;
      throw new ProposalStorageError('CORRUPT','The saved Playground draft is invalid. It has been preserved; export the current session or recover the saved data before replacing it.');
    }
  }
  load(baseline:Proposal):LoadedProposal {
    const valid=validateProposal(baseline);
    const raw=this.readRaw(valid);
    if(raw===null) return {proposal:null,revision:0};
    const stored=this.parse(raw,valid);
    return {proposal:stored.proposal,revision:stored.storageRevision};
  }
  save(proposal:Proposal,expectedRevision:number):number {
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0) throw new ProposalStorageError('CONFLICT','The draft storage revision is invalid. Reload the saved proposal before saving again.');
    const valid=validateProposal(proposal);
    const raw=this.readRaw(valid);
    const current=raw===null?0:this.parse(raw,valid).storageRevision;
    if(current!==expectedRevision) throw new ProposalStorageError('CONFLICT','Another tab saved this proposal. Your draft remains open; export it before reloading the saved version.');
    const revision=current+1;
    const next=JSON.stringify({schemaVersion:1,storageRevision:revision,proposal:valid} satisfies StoredProposal);
    if(byteLength(next)>PLAYGROUND_LIMITS.storageBytes) throw new ProposalStorageError('QUOTA','This proposal is too large for local draft storage. Your changes remain open; export the review package.');
    try { this.storage().setItem(proposalStorageKey(valid.sourceKey),next); }
    catch(error) { if(error instanceof ProposalStorageError) throw error; throw new ProposalStorageError('QUOTA','Browser storage could not save this proposal. Your current draft and previous saved version have been retained.'); }
    return revision;
  }
}
