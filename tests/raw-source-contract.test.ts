import { describe, expect, it, vi } from 'vitest';
import fixtureManifest from '../public/fixtures/manifest.json';
import { PreviewAdapter } from '../src/data/previewAdapter';
import { validateSnapshot } from '../src/domain';
import { sceneParts } from '../src/model-sources';

const source = async () => new PreviewAdapter('precision', vi.fn(async () => new Response(JSON.stringify(fixtureManifest)))).loadBom('B');

describe('source-only CAD contract', () => {
  it('preserves exact revisions and repeated occurrence poses during bulk scene mapping', async () => {
    const snapshot = await source();
    const base = snapshot.parts[0], occurrence = snapshot.occurrences[0];
    snapshot.parts = [
      { ...base, id: 'shared', revision: 'A', sourceHash: 'a'.repeat(64), stepUrl: '/fixtures/shared-A.step' },
      { ...base, id: 'shared', revision: 'B', sourceHash: 'b'.repeat(64), stepUrl: '/fixtures/shared-B.step' },
    ];
    snapshot.occurrences = Array.from({ length: 600 }, (_, i) => ({ ...occurrence, id: `instance-${i}`, partId: 'shared', partRevision: i % 2 ? 'B' : 'A', position: [i, 0, 0] as [number, number, number] }));
    const scene = sceneParts(snapshot, snapshot.occurrences.map(row => row.id));
    expect(scene).toHaveLength(600);
    for (let i = 0; i < scene.length; i++) {
      expect(scene[i]).toMatchObject({ id: `instance-${i}`, revision: i % 2 ? 'B' : 'A', sourceHash: (i % 2 ? 'b' : 'a').repeat(64), position: [i, 0, 0] });
    }
    expect(sceneParts(snapshot, ['instance-599'])).toEqual([scene[599]]);
  });

  it('accepts an exact STEP without server derivatives or precomputed CAD properties', async () => {
    const snapshot = await source();
    for (const part of snapshot.parts) { delete part.meshUrl; delete part.bbox; delete part.volumeMm3; }
    expect(validateSnapshot(snapshot)).toBe(snapshot);
    const scene = sceneParts(snapshot, snapshot.occurrences.map(row => row.id));
    expect(scene).toHaveLength(snapshot.occurrences.length);
    expect(scene.every(part => part.stepUrl?.endsWith('.step') && /^[a-f0-9]{64}$/.test(part.sourceHash!))).toBe(true);
    expect(scene.every(part => part.meshUrl === undefined && part.bbox === undefined && part.bboxSource === undefined)).toBe(true);
  });
  it('uses raw sources by default even when a fixture derivative exists and preserves repeated placement', async () => {
    const snapshot = await source();
    const scene = sceneParts(snapshot, snapshot.occurrences.map(row => row.id));
    const bolts = scene.filter(part => part.itemId === 'fastener');
    expect(bolts).toHaveLength(3);
    expect(new Set(bolts.map(part => part.stepUrl)).size).toBe(1);
    expect(new Set(bolts.map(part => JSON.stringify(part.position))).size).toBe(3);
    expect(scene.every(part => part.meshUrl === undefined && part.bboxSource === 'cad')).toBe(true);
  });
  it('only selects derivatives explicitly and refuses a missing derivative', async () => {
    const snapshot = await source(), part = snapshot.parts[0];
    part.displaySource = 'mesh';
    const occurrence = snapshot.occurrences.find(row => row.partId === part.id)!;
    const scene = sceneParts(validateSnapshot(snapshot), [occurrence.id]);
    expect(scene[0].meshUrl).toBe(part.meshUrl); expect(scene[0].stepUrl).toBeUndefined();
    delete part.meshUrl;
    expect(() => validateSnapshot(snapshot)).toThrow('derivative is unavailable');
  });
  it('requires distinct explicit assembly component mappings instead of duplicating whole geometry', async () => {
    const snapshot = await source(), first = snapshot.parts[0], second = snapshot.parts[1];
    second.stepUrl = first.stepUrl; second.sourceHash = first.sourceHash;
    expect(() => validateSnapshot(snapshot)).toThrow('explicit CAD component paths');
    first.cadNodePath = [0]; second.cadNodePath = [1];
    first.sourceToPart = { position: [0, 0, 0], rotation: [0, 0, 0] };
    second.sourceToPart = { position: [0, 0, 0], rotation: [0, 0, 0] };
    expect(validateSnapshot(snapshot)).toBe(snapshot);
    second.cadNodePath = [0, 1];
    expect(() => validateSnapshot(snapshot)).toThrow('overlap');
    second.cadNodePath = [-1];
    expect(() => validateSnapshot(snapshot)).toThrow('Invalid CAD component path');
  });
  it('requires a finite explicit source frame for every subtree and retains the real occurrence pose', async () => {
    const snapshot = await source(), part = snapshot.parts[0];
    const occurrence = snapshot.occurrences.find(row => row.partId === part.id)!;
    occurrence.position = [55, -22, 90]; occurrence.rotation = [0.3, -0.2, 0.4];
    part.cadNodePath = [0, 2];
    expect(() => validateSnapshot(snapshot)).toThrow('explicit sourceToPart');
    expect(() => sceneParts(snapshot, [occurrence.id])).toThrow('explicit sourceToPart');
    part.sourceToPart = { position: [-10, 20, 40], rotation: [0.6, 0.5, -0.4] };
    const [scene] = sceneParts(validateSnapshot(snapshot), [occurrence.id]);
    expect(scene.position).toEqual(occurrence.position); expect(scene.rotation).toEqual(occurrence.rotation);
    expect(scene.sourceToPart).toEqual(part.sourceToPart); expect(scene.cadNodePath).toEqual([0, 2]);
    part.cadNodePath = [];
    delete part.sourceToPart;
    expect(() => validateSnapshot(snapshot)).toThrow('explicit sourceToPart');
    part.sourceToPart = { position: [0, 0, 0], rotation: [0, 0, 0] };
    expect(validateSnapshot(snapshot)).toBe(snapshot);
    part.sourceToPart.rotation[0] = Infinity;
    expect(() => validateSnapshot(snapshot)).toThrow('sourceToPart transform is invalid');
  });
  it('rejects unsupported frame declarations and CAD paths outside the importer budget', async () => {
    const snapshot = await source(), part = snapshot.parts[0];
    part.cadNodePath = [20_000];
    expect(() => validateSnapshot(snapshot)).toThrow('Invalid CAD component path');
    part.cadNodePath = [19_999];
    part.sourceToPart = { position: [0, 0, 0], rotation: [0, 0, 0] };
    expect(validateSnapshot(snapshot)).toBe(snapshot);
    Object.assign(part.sourceToPart, { scale: 2 });
    expect(() => validateSnapshot(snapshot)).toThrow('sourceToPart transform is invalid');
    delete part.cadNodePath;
    part.sourceToPart = { position: [0, 0, 0], rotation: [0, 0, 0] };
    part.displaySource = 'mesh';
    expect(() => validateSnapshot(snapshot)).toThrow('cannot also apply a STEP sourceToPart');
  });
  it('rejects invalid optional properties while allowing an absent property', async () => {
    const snapshot = await source(); snapshot.parts[0].volumeMm3 = NaN;
    expect(() => validateSnapshot(snapshot)).toThrow('CAD volume');
    delete snapshot.parts[0].volumeMm3;
    snapshot.parts[0].bbox = { min: [2, 0, 0], max: [1, 1, 1] };
    expect(() => validateSnapshot(snapshot)).toThrow('bounds');
  });
});
