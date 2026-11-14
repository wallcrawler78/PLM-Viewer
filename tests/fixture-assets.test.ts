import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import manifest from '../public/fixtures/manifest.json';
import { validateMesh } from '../src/components/model/geometry';

function bytes(url: string): Buffer {
  return readFileSync(new URL(`../public${url}`, import.meta.url));
}

describe('CAD fixture source integrity and dimensional regression', () => {
  it('keeps nominal plate dimensions independent of mesh deflection padding', () => {
    for (const revision of ['A', 'B']) {
      const plate = manifest.parts.find(part => part.id === 'base' && part.revision === revision)!;
      expect(plate.bbox.max.map((value, axis) => value - plate.bbox.min[axis])).toEqual([180, revision === 'A' ? 120 : 136, 8]);
      expect(plate.bboxTessellationIndependent).toBe(true);
      expect(plate.bboxMethod).toContain('useTriangulation=false');
      expect(plate.bboxMethod).toContain('useShapeTolerance=false');
    }
  });

  it('records the hash of every real STEP and document source without source replacement', () => {
    for (const part of manifest.parts) {
      const source = bytes(part.stepUrl);
      expect(source.toString('utf8').startsWith('ISO-10303-21;')).toBe(true);
      expect(createHash('sha256').update(source).digest('hex')).toBe(part.sourceHash);
    }
    for (const document of manifest.documents) {
      expect(createHash('sha256').update(bytes(document.url)).digest('hex')).toBe(document.sourceHash);
    }
  });

  it('keeps finite display vertices inside their CAD envelope within serialization tolerance', () => {
    for (const part of manifest.parts) {
      const mesh: unknown = JSON.parse(bytes(part.meshUrl).toString('utf8'));
      validateMesh(mesh);
      for (let i = 0; i < mesh.positions.length; i++) {
        const axis = i % 3;
        // Mesh positions are serialized to six decimals; CAD envelopes retain
        // nine decimals with conservative rounding and numerical CAD tolerance.
        expect(mesh.positions[i]).toBeGreaterThanOrEqual(part.bbox.min[axis] - 1e-6);
        expect(mesh.positions[i]).toBeLessThanOrEqual(part.bbox.max[axis] + 1e-6);
      }
    }
  });
});
