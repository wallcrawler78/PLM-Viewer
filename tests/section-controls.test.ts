import { describe, expect, it } from 'vitest';
import { sectionControlRange } from '../src/section-controls';
import type { SceneBounds } from '../src/components/model/types';

const bounds: SceneBounds = { min: [10000, -6000, 250], max: [12000, -5000, 350], size: [2000, 1000, 100], occurrenceIds: ['offset-part'], source: 'cad-bounds-envelope' };

describe('section control extent', () => {
  it('reaches a large assembly positioned far from the global origin', () => {
    const range = sectionControlRange(bounds, 'x', 11000);
    expect(range.min).toBeLessThan(bounds.min[0]);
    expect(range.max).toBeGreaterThan(bounds.max[0]);
    expect(range.center).toBe(11000);
  });
  it('uses each axis and preserves an existing plane outside the loaded envelope', () => {
    expect(sectionControlRange(bounds, 'y', -5500).center).toBe(-5500);
    expect(sectionControlRange(bounds, 'z', 300).center).toBe(300);
    expect(sectionControlRange(bounds, 'x', -3000).min).toBe(-3000);
    expect(sectionControlRange(bounds, 'x', 15000).max).toBe(15000);
  });
  it('provides a usable range before a model loads and for a flat envelope', () => {
    expect(sectionControlRange(null, 'z', 400)).toEqual({ min: -120, max: 400, center: 0 });
    expect(sectionControlRange({ ...bounds, min: [0,0,5], max: [0,0,5], size: [0,0,0] }, 'z', 5)).toEqual({ min: 4, max: 6, center: 5 });
  });
});
