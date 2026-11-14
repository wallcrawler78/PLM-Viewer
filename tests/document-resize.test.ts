import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentWidthScheduler } from '../src/document-resize';

afterEach(() => { vi.useRealTimers(); });

describe('PDF pane width scheduling', () => {
  it('measures the first visible pane immediately and renders only the final width of a resize burst', () => {
    vi.useFakeTimers();
    const apply = vi.fn(), widths = createDocumentWidthScheduler(apply);
    widths.update(380); expect(apply.mock.calls).toEqual([[380]]);
    widths.update(400); vi.advanceTimersByTime(60);
    widths.update(420); vi.advanceTimersByTime(60);
    widths.update(440.5); vi.advanceTimersByTime(119);
    expect(apply).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1); expect(apply.mock.calls).toEqual([[380], [440.5]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the readable width when hidden and cancels a pending hidden-pane render', () => {
    vi.useFakeTimers();
    const apply = vi.fn(), widths = createDocumentWidthScheduler(apply);
    widths.update(0); widths.update(NaN); widths.update(Infinity); widths.update(-1);
    expect(apply).not.toHaveBeenCalled();
    widths.update(380); widths.update(500); widths.update(0);
    vi.advanceTimersByTime(1000); expect(apply.mock.calls).toEqual([[380]]);
    widths.update(500); vi.advanceTimersByTime(120); expect(apply.mock.calls).toEqual([[380], [500]]);
  });

  it('does not rerender after a redundant resize or a return to the committed width', () => {
    vi.useFakeTimers();
    const apply = vi.fn(), widths = createDocumentWidthScheduler(apply);
    widths.update(380); widths.update(380); widths.update(500); widths.update(380);
    vi.advanceTimersByTime(1000); expect(apply.mock.calls).toEqual([[380]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes source-owned timers so a closed document cannot restart a render', () => {
    vi.useFakeTimers();
    const apply = vi.fn(), widths = createDocumentWidthScheduler(apply);
    widths.update(380); widths.update(500); widths.dispose(); widths.update(600);
    vi.advanceTimersByTime(1000); expect(apply.mock.calls).toEqual([[380]]); expect(vi.getTimerCount()).toBe(0);
  });
});
