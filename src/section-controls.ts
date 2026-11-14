import type { SceneBounds, SectionState } from './components/model/types';

/** A section plane follows the prepared assembly extent, including offset CAD coordinates. */
export function sectionControlRange(bounds: SceneBounds | null, axis: SectionState['axis'], offset: number) {
  const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const low = bounds?.min[index], high = bounds?.max[index];
  const valid = low !== undefined && high !== undefined && Number.isFinite(low) && Number.isFinite(high) && low <= high;
  const current = Number.isFinite(offset) ? offset : 0;
  if (!valid) return { min: Math.min(-120, current), max: Math.max(120, current), center: 0 };
  const padding = Math.max(1, (high - low) * 0.02);
  return { min: Math.min(Math.floor(low - padding), current), max: Math.max(Math.ceil(high + padding), current), center: low + (high - low) / 2 };
}
