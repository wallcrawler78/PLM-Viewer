import { describe, it, expect, vi, afterEach } from 'vitest';
import fixtureManifest from '../public/fixtures/manifest.json';
import { PreviewAdapter } from '../src/data/previewAdapter';
import { compareSnapshots, createPartLookup, formatAttributeValue, resolvePart, validateSnapshot, validateSchema, assertSafeAssetUrl } from '../src/domain';
import { schemas } from '../src/data/schemas';
import { ArenaAdapter, parseArenaLaunchContext } from '../src/integrations/arenaAdapter';

function fixtureFetch(manifest: unknown = fixtureManifest): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}
afterEach(() => { vi.unstubAllGlobals(); });
describe('browser native fetch receiver', () => {
  it('invokes default global fetch with the global receiver in both adapters', async () => {
    const receiverSensitiveFetch = vi.fn(function(this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      const body = String(input).includes('/status?') ? { configured: false, provider: 'arena' } : fixtureManifest;
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', receiverSensitiveFetch);
    expect((await new PreviewAdapter().loadBom('B')).revision).toBe('B');
    expect((await new ArenaAdapter({ workspaceId: 'w', itemId: 'i' }).connectionStatus()).configured).toBe(false);
    expect(receiverSensitiveFetch).toHaveBeenCalledTimes(2);
  });
});
describe('Preview data and dynamic workspace schemas', () => {
  it('loads real fixture variants with unique part editions and repeated occurrences', async () => {
    const api = new PreviewAdapter('precision', fixtureFetch());
    const a = await api.loadBom('A'), b = await api.loadBom('B');
    expect(a.occurrences).toHaveLength(9); expect(b.occurrences).toHaveLength(9);
    const bolts = a.occurrences.filter(o => o.partId === 'fastener');
    expect(bolts).toHaveLength(4);
    expect(new Set(bolts.map(o => o.id)).size).toBe(4);
    expect(new Set(bolts.map(o => JSON.stringify(o.position))).size).toBe(4);
    expect(bolts.map(o => resolvePart(a, o))).toEqual(Array(4).fill(resolvePart(a, bolts[0])));
    expect(resolvePart(b, b.occurrences.find(o => o.id === 'occ-base')!)?.revision).toBe('B');
    expect(resolvePart(b, b.occurrences.find(o => o.id === 'occ-motor')!)?.revision).toBe('A');
    expect(a.parts.every(p => /^[a-f0-9]{64}$/.test(p.sourceHash))).toBe(true);
  });
  it('supplies substantially different field IDs and types without changing geometry', async () => {
    const precision = new PreviewAdapter('precision', fixtureFetch()), medical = new PreviewAdapter('medical', fixtureFetch());
    const p = await precision.loadSchema(), m = await medical.loadSchema();
    expect(p.attributes.every(a => !m.attributes.some(b => b.id === a.id))).toBe(true);
    expect(new Set(p.attributes.map(a => a.type))).toEqual(new Set(['text', 'number', 'enum', 'boolean']));
    const ps = await precision.loadBom('B'), ms = await medical.loadBom('B');
    expect(ps.occurrences.map(o => o.position)).toEqual(ms.occurrences.map(o => o.position));
    expect(ps.parts[0].attributes).not.toEqual(ms.parts[0].attributes);
    expect(ps.workspaceId).not.toBe(ms.workspaceId);
  });
  it('resolves document editions using child revision even in a newer parent configuration', async () => {
    const api = new PreviewAdapter('precision', fixtureFetch());
    const b = await api.loadBom('B');
    expect(b.documents.some(d => d.id === 'atlas-spec-A-pdf')).toBe(false);
    expect(b.documents.some(d => d.id === 'atlas-spec-B-pdf')).toBe(true);
    expect(b.documents.some(d => d.id === 'base-drawing-B-pdf')).toBe(true);
    expect(b.documents.some(d => d.id === 'gearbox-inspection-A-pdf')).toBe(true);
    expect((await api.listAttachments('assembly', 'A')).every(d => d.itemId === 'assembly' && d.revision === 'A')).toBe(true);
  });
  it('normalizes numeric editions and returns isolated copies', async () => {
    const fixture = structuredClone(fixtureManifest) as unknown as { documents: { edition: unknown }[] };
    fixture.documents[0].edition = 1;
    const api = new PreviewAdapter('precision', fixtureFetch(fixture));
    const a = await api.loadBom('A');
    expect(a.documents[0].edition).toBe('1');
    a.occurrences[0].position[0] = 900;
    a.parts[0].attributes.changed = true;
    const fresh = await api.loadBom('A');
    expect(fresh.occurrences[0].position[0]).not.toBe(900);
    expect(fresh.parts[0].attributes.changed).toBeUndefined();
  });
  it('rejects missing revisions, incomplete data and cancellation without poisoning future loads', async () => {
    const api = new PreviewAdapter('precision', fixtureFetch());
    await expect(api.loadBom('C')).rejects.toThrow('Unknown');
    const controller = new AbortController(); controller.abort();
    await expect(api.loadBom('A', controller.signal)).rejects.toThrow();
    expect((await api.loadBom('A')).revision).toBe('A');
    await expect(new PreviewAdapter('precision', fixtureFetch({})).loadBom('A')).rejects.toThrow('incomplete');
  });
  it('retries failed loading instead of caching rejection forever', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(fixtureManifest)));
    const api = new PreviewAdapter('precision', fetcher);
    await expect(api.loadBom('A')).rejects.toThrow('503');
    expect((await api.loadBom('A')).revision).toBe('A');
  });
});

describe('configuration comparison', () => {
  it('keeps opaque part IDs, revisions and snapshot ownership distinct in bulk lookup', async () => {
    const sample = (await new PreviewAdapter('precision', fixtureFetch()).loadBom('A')).parts[0];
    const first = { ...sample, id: 'item:alpha', revision: 'B' };
    const second = { ...sample, id: 'item', revision: 'alpha:B' };
    const third = { ...sample, id: 'item:alpha', revision: 'C' };
    const lookup = createPartLookup([first, second, third]);
    expect(lookup({ partId: first.id, partRevision: 'B' })).toBe(first);
    expect(lookup({ partId: second.id, partRevision: second.revision })).toBe(second);
    expect(lookup({ partId: first.id, partRevision: 'C' })).toBe(third);
    expect(lookup({ partId: first.id, partRevision: 'missing' })).toBeUndefined();
    const nextSource = { ...first, sourceHash: 'b'.repeat(64) };
    expect(createPartLookup([nextSource])({ partId: first.id, partRevision: 'B' })).toBe(nextSource);
    expect(createPartLookup([])({ partId: first.id, partRevision: 'B' })).toBeUndefined();
    expect(lookup({ partId: first.id, partRevision: 'B' })).toBe(first);
  });

  it('identifies added, removed, moved and revised occurrences independently', async () => {
    const api = new PreviewAdapter('precision', fixtureFetch());
    const a = await api.loadBom('A'), b = await api.loadBom('B');
    const changes = compareSnapshots(a, b);
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ occurrenceId: 'occ-base', kind: 'revised' }),
      expect.objectContaining({ occurrenceId: 'occ-cover', kind: 'revised' }),
      expect.objectContaining({ occurrenceId: 'occ-motor', kind: 'moved', summary: expect.stringContaining('4.0 mm') }),
      expect.objectContaining({ occurrenceId: 'occ-bolt-4', kind: 'removed' }),
      expect.objectContaining({ occurrenceId: 'occ-sensor', kind: 'added' }),
    ]));
    expect(changes.filter(c => c.kind === 'added')).toHaveLength(1);
    expect(changes.filter(c => c.kind === 'removed')).toHaveLength(1);
  });
  it('never treats unavailable/hidden/loading models as BOM removals', async () => {
    const a = await new PreviewAdapter('precision', fixtureFetch()).loadBom('A');
    const b = structuredClone(a); b.occurrences[0].modelState = 'unavailable'; b.occurrences[1].modelState = 'not-loaded';
    expect(compareSnapshots(a, b)).toEqual([]);
  });
  it('detects a changed source within an unchanged item revision', async () => {
    const a = await new PreviewAdapter('precision', fixtureFetch()).loadBom('A');
    const b = structuredClone(a); b.parts.find(p => p.id === 'motor')!.sourceHash = 'new-file-edition';
    expect(compareSnapshots(a, b)).toEqual([expect.objectContaining({ occurrenceId: 'occ-motor', kind: 'revised', summary: expect.stringContaining('same item revision') })]);
  });
  it('rejects comparisons between different workspaces/items', async () => {
    const a = await new PreviewAdapter('precision', fixtureFetch()).loadBom('A');
    expect(() => compareSnapshots(a, { ...a, workspaceId: 'another' })).toThrow('same item');
    expect(() => compareSnapshots(a, { ...a, rootItemId: 'another' })).toThrow('same item');
  });
});

describe('physical orientation comparison', () => {
  it('does not flag a wrapped Euler angle or singular equivalent orientation as motion', async () => {
    const before = await new PreviewAdapter('precision', fixtureFetch()).loadBom('B');
    const after = structuredClone(before);
    after.occurrences[0].rotation[2] += Math.PI * 2;
    expect(compareSnapshots(before, after)).toEqual([]);
    before.occurrences[0].rotation = [.3, Math.PI / 2, 1.2];
    after.occurrences[0].rotation = [1.5, Math.PI / 2, 0];
    expect(compareSnapshots(before, after)).toEqual([]);
    after.occurrences[0].rotation[0] += 2e-6;
    expect(compareSnapshots(before, after)).toEqual([expect.objectContaining({ kind: 'moved', occurrenceId: before.occurrences[0].id })]);
  });
  it('compares a relative snapshot with its normalized world poses without false changes', async () => {
    const before = await new PreviewAdapter('precision', fixtureFetch()).loadBom('B');
    before.placementSpace = 'parent';
    before.occurrences[0].rotation = [.3, 3 * Math.PI / 4, 1.2];
    before.occurrences[1].parentId = before.occurrences[0].id;
    before.occurrences[1].rotation = [-.6, 1.1, .4];
    const normalized = validateSnapshot(structuredClone(before));
    expect(compareSnapshots(before, normalized)).toEqual([]);
  });
});

describe('data validation', () => {
  it('rejects duplicate occurrence IDs, wrong units, invalid geometry and cycles', async () => {
    const snapshot = await new PreviewAdapter('precision', fixtureFetch()).loadBom('A');
    const duplicate = structuredClone(snapshot); duplicate.occurrences.push(duplicate.occurrences[0]);
    expect(() => validateSnapshot(duplicate)).toThrow('unique');
    expect(() => validateSnapshot({ ...snapshot, units: 'm' } as never)).toThrow('millimeters');
    const invalid = structuredClone(snapshot); invalid.occurrences[0].position[0] = NaN;
    expect(() => validateSnapshot(invalid)).toThrow('placement');
    const cycle = structuredClone(snapshot); cycle.occurrences[0].parentId = cycle.occurrences[1].id; cycle.occurrences[1].parentId = cycle.occurrences[0].id;
    expect(() => validateSnapshot(cycle)).toThrow('Cyclic');
  });
  it('rejects a STEP part whose exact source hash is missing or malformed', async () => {
    const snapshot = await new PreviewAdapter('precision', fixtureFetch()).loadBom('A');
    const index = snapshot.parts.findIndex(part => !!part.stepUrl);
    for (const sourceHash of [undefined, '', 'latest', 'A'.repeat(64)]) {
      const altered = structuredClone(snapshot);
      (altered.parts[index] as { sourceHash?: string }).sourceHash = sourceHash;
      expect(() => validateSnapshot(altered), String(sourceHash)).toThrow('SHA-256 source hash');
    }
    const unnamed = structuredClone(snapshot); unnamed.parts[index].revision = '';
    expect(() => validateSnapshot(unnamed)).toThrow();
    expect(() => validateSnapshot(structuredClone(snapshot))).not.toThrow();
  });
  it('validates schema identity and safe resource protocols', () => {
    const duplicate = structuredClone(schemas.precision); duplicate.attributes.push(duplicate.attributes[0]);
    expect(() => validateSchema(duplicate)).toThrow('unique');
    expect(() => assertSafeAssetUrl('javascript:alert(1)')).toThrow();
    expect(() => assertSafeAssetUrl('https://user:password@example.com/file')).toThrow();
    expect(() => assertSafeAssetUrl('/fixtures/doc.pdf')).not.toThrow();
    expect(formatAttributeValue(false)).toBe('No');
    expect(formatAttributeValue(0, { id: 'x', label: 'Length', scope: 'item', type: 'number', unit: 'mm' })).toBe('0 mm');
    expect(formatAttributeValue(null)).toBe('—');
  });
});

describe('Arena transport and launcher', () => {
  it('fails closed before requesting data when the service is unconfigured', async () => {
    const fetcher = fixtureFetch({ configured: false, provider: 'arena', message: 'Connect tenant first.' });
    const adapter = new ArenaAdapter({ workspaceId: 'w', itemId: 'i' }, fetcher);
    await expect(adapter.loadBom('A')).rejects.toThrow('Connect tenant first.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects HTML fallback, denied sessions and mismatched workspace', async () => {
    const html = new ArenaAdapter({ workspaceId: 'w', itemId: 'i' }, vi.fn(async () => new Response('<html/>', { headers: { 'Content-Type': 'text/html' } })));
    await expect(html.loadSchema()).rejects.toThrow('Expected JSON');
    const denied = new ArenaAdapter({ workspaceId: 'w', itemId: 'i' }, vi.fn(async () => new Response('', { status: 403 })));
    await expect(denied.loadSchema()).rejects.toThrow('does not have access');
    const mismatch = new ArenaAdapter({ workspaceId: 'w', itemId: 'i' }, fixtureFetch({ configured: true, provider: 'arena', workspaceId: 'different' }));
    await expect(mismatch.loadSchema()).rejects.toThrow('different workspace');
  });
  it('blocks third-party BFF endpoints and retains explicit source context', () => {
    expect(() => new ArenaAdapter({ workspaceId: 'w', itemId: 'i', baseUrl: 'https://evil.example' })).toThrow('same-origin');
    expect(parseArenaLaunchContext('?mode=preview&itemId=ignored')).toBeNull();
    expect(() => parseArenaLaunchContext('?mode=arena')).toThrow('missing');
    expect(parseArenaLaunchContext('?mode=arena&workspaceId=w&itemId=i&revision=B&fileId=f&parentItemId=p')).toEqual({ mode: 'arena', workspaceId: 'w', itemId: 'i', revision: 'B', fileId: 'f', parentItemId: 'p' });
  });
});
