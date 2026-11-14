import { beforeAll, describe, expect, it, vi } from 'vitest';
import manifest from '../public/fixtures/manifest.json';
import type { BomSnapshot } from '../src/domain';
import { validateSnapshot } from '../src/domain';
import { PreviewAdapter } from '../src/data/previewAdapter';
import { ArenaAdapter } from '../src/integrations/arenaAdapter';
import { parseLaunchContext, previewModelFileId, resolvePreviewLaunch } from '../src/launch-context';

const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
let snapshots: BomSnapshot[];
beforeAll(async () => {
  const adapter = new PreviewAdapter('precision', fetcher);
  snapshots = await Promise.all([adapter.loadBom('A'), adapter.loadBom('B')]);
});

describe('universal launch context', () => {
  it('starts an untargeted preview with the current specification as a document', () => {
    const result = resolvePreviewLaunch(parseLaunchContext(''), snapshots);
    expect(result.snapshot.revision).toBe('B');
    expect(result.file?.id).toBe('atlas-spec-B-pdf');
    expect(result.workspaceView).toBe('documents');
    expect(result.compare).toBe(false);
  });

  it('opens the exact requested PDF or Word source and preserves its item revision', () => {
    for (const [fileId, revision] of [['atlas-spec-A-pdf', 'A'], ['atlas-spec-B-docx', 'B']]) {
      const launch = parseLaunchContext(`?mode=preview&itemId=assembly&revision=${revision}&fileId=${fileId}&compare=true`);
      const result = resolvePreviewLaunch(launch, snapshots);
      expect(result.file?.id).toBe(fileId);
      expect(result.file?.revision).toBe(revision);
      expect(result.snapshot.revision).toBe(revision);
      expect(result.workspaceView).toBe('documents');
      expect(result.compare).toBe(true);
    }
  });

  it('resolves an unchanged child revision within the proposed parent configuration', () => {
    const result = resolvePreviewLaunch(parseLaunchContext('?fileId=gearbox-inspection-A-pdf&itemId=gearbox&revision=A'), snapshots);
    expect(result.snapshot.revision).toBe('B');
    expect(result.file?.revision).toBe('A');
    expect(result.selectedIds).toEqual(['occ-gearbox']);
    expect(result.workspaceView).toBe('documents');
  });

  it('opens assembly and repeated part STEP sources in 3D with occurrence identity', () => {
    const assembly = resolvePreviewLaunch(parseLaunchContext('?fileId=step%3Aassembly%3AB'), snapshots);
    expect(assembly.workspaceView).toBe('model');
    expect(assembly.snapshot.revision).toBe('B');
    expect(assembly.file).toBeNull();
    expect(assembly.selectedIds).toEqual([]);
    const repeated = resolvePreviewLaunch({ mode: 'preview', fileId: previewModelFileId('fastener', 'A') }, snapshots);
    expect(repeated.selectedIds).toEqual(['occ-bolt-1', 'occ-bolt-2', 'occ-bolt-3']);
    expect(repeated.snapshot.revision).toBe('B');
  });

  it('lets Together add the same item document while preserving the model context', () => {
    const result = resolvePreviewLaunch(parseLaunchContext('?fileId=step%3Abase%3AA&view=together'), snapshots);
    expect(result.workspaceView).toBe('together');
    expect(result.snapshot.revision).toBe('A');
    expect(result.file?.id).toBe('base-drawing-A-pdf');
    expect(result.selectedIds).toEqual(['occ-base']);
  });

  it('rejects missing and mismatched source requests instead of opening a convenient replacement', () => {
    for (const query of [
      '?fileId=missing', '?itemId=unknown', '?revision=C',
      '?fileId=atlas-spec-B-pdf&revision=A', '?fileId=atlas-spec-B-pdf&itemId=base',
      '?fileId=step%3Aassembly%3AA&revision=B', '?fileId=step%3Abase%3AB&itemId=motor',
      '?fileId=atlas-spec-B-pdf&view=model', '?fileId=step%3Aassembly%3AB&view=documents',
      '?workspaceId=another-workspace', '?view=model&compare=true',
    ]) expect(() => resolvePreviewLaunch(parseLaunchContext(query), snapshots), query).toThrow();
  });

  it('never resolves Arena context with preview fixtures, even when its IDs happen to match', () => {
    const context = parseLaunchContext('?mode=arena&workspaceId=preview-precision&itemId=assembly&fileId=atlas-spec-B-pdf');
    expect(() => resolvePreviewLaunch(context, snapshots)).toThrow('Arena provider');
    expect(parseLaunchContext('?mode=arena')).toEqual({ mode: 'arena' });
  });

  it('rejects ambiguous or malformed launch instructions', () => {
    for (const query of ['?mode=unknown', '?mode=preview&mode=arena', '?fileId=one&fileId=two', '?fileId=', '?itemId=%20', '?revision=A%00', '?view=gallery', '?compare=yes']) {
      expect(() => parseLaunchContext(query), query).toThrow();
    }
    expect(() => parseLaunchContext(`?fileId=${'a'.repeat(513)}`)).toThrow();
    expect(parseLaunchContext('?mode=preview&compare=0&unrelated=value').compare).toBe(false);
  });

  it('detects conflicting same-ID document editions and multiple possible document files', () => {
    const altered = structuredClone(snapshots);
    altered[1].documents.find(file => file.id === 'gearbox-inspection-A-pdf')!.sourceHash = 'different-source';
    expect(() => resolvePreviewLaunch({ mode: 'preview', fileId: 'gearbox-inspection-A-pdf' }, altered)).toThrow('conflicting editions');
    const many = structuredClone(snapshots);
    const current = many[1].documents.find(file => file.id === 'atlas-spec-B-pdf')!;
    many[1].documents.push({ ...current, id: 'other-spec-B-pdf', seriesId: 'another-document' });
    expect(() => resolvePreviewLaunch({ mode: 'preview', itemId: 'assembly', revision: 'B', view: 'documents' }, many)).toThrow('several possible documents');
    expect(resolvePreviewLaunch({ mode: 'preview', fileId: current.id }, many).file?.id).toBe(current.id);
  });
});

describe('document family metadata', () => {
  it('supplies explicit independent PDF/Word families consistently across both adapter reads', async () => {
    const a = snapshots[0], b = snapshots[1];
    expect(a.documents.find(file => file.id === 'atlas-spec-A-pdf')?.seriesId).toBe(b.documents.find(file => file.id === 'atlas-spec-B-pdf')?.seriesId);
    expect(b.documents.find(file => file.id === 'atlas-spec-B-docx')?.seriesId).not.toBe(b.documents.find(file => file.id === 'atlas-spec-B-pdf')?.seriesId);
    const list = await new PreviewAdapter('precision', fetcher).listAttachments('assembly', 'B');
    expect(list.map(file => file.seriesId)).toEqual(b.documents.filter(file => file.itemId === 'assembly').map(file => file.seriesId));
  });

  it('rejects malformed family metadata at both snapshot and live attachment boundaries', async () => {
    const invalid = structuredClone(snapshots[1]);
    invalid.documents[0].seriesId = '';
    expect(() => validateSnapshot(invalid)).toThrow('series identifier');
    const response = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes('/status?')
      ? { configured: true, provider: 'arena', workspaceId: 'workspace' }
      : [{ ...invalid.documents[0], itemId: 'item', revision: 'B', seriesId: { id: 'invalid' } }]), { headers: { 'Content-Type': 'application/json' } }));
    const adapter = new ArenaAdapter({ workspaceId: 'workspace', itemId: 'item' }, response);
    await expect(adapter.listAttachments('item', 'B')).rejects.toThrow('series identifier');
  });
});

describe('extension launch URL source isolation', () => {
  it('clears stale target context from a configured URL before opening another attachment', async () => {
    const modulePath = '../extension/launch-url.js';
    const { viewerTarget } = await import(modulePath) as { viewerTarget: (url: string, context: Record<string, string>) => URL };
    const oldContext = new URLSearchParams({ mode: 'preview', workspaceId: 'old-workspace', itemId: 'old-item', fileId: 'old', revision: 'A', view: 'together', compare: 'true', parentItemId: 'old-parent', parentRevision: 'old-parent-rev', configurationId: 'old-configuration', baselineRevision: 'old-baseline', baselineConfigurationId: 'old-baseline-configuration', edition: 'old-edition', sourceHash: 'old-hash', connectionId: 'old-connection', contentHash: 'old-content', deployment: 'keep' });
    oldContext.append('baselineRevision', 'another-old-baseline');
    const target = viewerTarget(`https://viewer.example/?${oldContext}#old`, { mode: 'arena', workspaceId: 'w', itemId: 'new' });
    expect(target.searchParams.get('mode')).toBe('arena');
    expect(target.searchParams.get('itemId')).toBe('new');
    expect(target.searchParams.has('fileId')).toBe(false);
    expect(target.searchParams.has('revision')).toBe(false);
    expect(target.searchParams.has('compare')).toBe(false);
    expect(target.searchParams.has('parentItemId')).toBe(false);
    for (const key of ['parentRevision', 'configurationId', 'baselineRevision', 'baselineConfigurationId', 'edition', 'sourceHash', 'connectionId', 'contentHash']) expect(target.searchParams.has(key), key).toBe(false);
    expect(target.searchParams.get('workspaceId')).toBe('w');
    expect(target.searchParams.get('deployment')).toBe('keep');
    expect(target.hash).toBe('');
    expect(() => viewerTarget('https://user:secret@viewer.example/', {})).toThrow();
    expect(() => viewerTarget('http://viewer.example/', {})).toThrow();
  });

  it('uses only newly supplied exact context and keeps stale live context out of preview launches', async () => {
    const modulePath = '../extension/launch-url.js';
    const { viewerTarget } = await import(modulePath) as { viewerTarget: (url: string, context: Record<string, string>) => URL };
    const saved = 'https://viewer.example/?configurationId=stale&baselineRevision=old&parentRevision=old-parent&edition=old&sourceHash=old';
    const context = { mode: 'arena', workspaceId: 'w', itemId: 'child', revision: '03', fileId: 'file', edition: '7', sourceHash: 'a'.repeat(64), parentItemId: 'assembly', parentRevision: '04', configurationId: 'frozen-current', baselineRevision: '03', baselineConfigurationId: 'frozen-baseline' };
    expect(Object.fromEntries(viewerTarget(saved, context).searchParams)).toEqual(context);
    const previewContext = { mode: 'preview', fileId: 'atlas-spec-B-pdf' };
    expect(Object.fromEntries(viewerTarget(saved, previewContext).searchParams)).toEqual(previewContext);
  });

  it('rejects credential-bearing viewer URLs before they can be stored or launched', async () => {
    const modulePath = '../extension/launch-url.js';
    const { viewerTarget } = await import(modulePath) as { viewerTarget: (url: string, context: Record<string, string>) => URL };
    for (const key of ['access_token', 'refreshToken', 'id_token', 'Authorization', 'api_key', 'client_secret', 'password', 'sessionId', 'code']) {
      expect(() => viewerTarget(`https://viewer.example/?${key}=credential`, {}), key).toThrow('without sign-in codes, tokens, or API credentials');
    }
    expect(() => viewerTarget('https://viewer.example/', { access_token: 'credential' })).toThrow('Only explicit viewer source context');
    expect(viewerTarget('https://viewer.example/?deployment=private#access_token=discarded', {}).href).toBe('https://viewer.example/?deployment=private');
  });

  it('forwards explicit exact source parameters from Arena links without inferring routes or credentials', async () => {
    const modulePath = '../extension/launch-url.js';
    const { arenaContext } = await import(modulePath) as { arenaContext: (url: string, workspaceId: string) => Record<string, string> };
    const explicit = { revision: '03', parentItemId: 'assembly', parentRevision: '04', configurationId: 'frozen-current', baselineRevision: '02', baselineConfigurationId: 'frozen-baseline', edition: '8', sourceHash: 'b'.repeat(64), view: 'together' };
    const params = new URLSearchParams({ itemGUID: 'child', fileGUID: 'file', ...explicit, access_token: 'never-forwarded', workspaceId: 'untrusted-workspace', connectionId: 'never-forwarded' });
    expect(arenaContext(`https://arena.example/opaque?${params}`, 'configured-workspace')).toEqual({ mode: 'arena', workspaceId: 'configured-workspace', itemId: 'child', fileId: 'file', ...explicit });
    expect(() => arenaContext('https://arena.example/items/guessed', 'w')).toThrow('explicit item context');
    for (const query of ['itemId=one&itemId=two', 'itemId=one&itemGUID=two', 'itemId=one&fileId=a&fileGUID=b', 'itemId=one&baselineRevision=02&baselineRevision=03', 'itemId=one&edition=', 'itemId=one&revision=%20']) {
      expect(() => arenaContext(`https://arena.example/?${query}`, 'w'), query).toThrow();
    }
  });
});
