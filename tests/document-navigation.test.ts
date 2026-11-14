import { describe, expect, it } from 'vitest';
import { DocumentScrollLink, documentNavigationScrollTop, readDocumentNavigation, reduceDocumentFocus } from '../src/document-navigation';
import type { DocumentFocusState } from '../src/document-navigation';

describe('linked document page navigation', () => {
  const baseline = [{ page: 1, top: 24, height: 840 }, { page: 2, top: 883, height: 700 }];
  const revised = [{ page: 1, top: 24, height: 1176 }, { page: 2, top: 1220, height: 900 }];

  it('keeps a next-page command on the corresponding page despite different Word reflow', () => {
    const source = readDocumentNavigation(883, 400, baseline)!;
    expect(source).toEqual({ page: 2, progress: 0 });
    const targetTop = documentNavigationScrollTop(source, 400, 2144, revised);
    expect(targetTop).toBe(1220);
    expect(readDocumentNavigation(targetTop, 400, revised)).toEqual({ page: 2, progress: 0 });
  });

  it('maps progress within a page using each revision’s own height', () => {
    const source = readDocumentNavigation(1033, 400, baseline)!;
    expect(source).toEqual({ page: 2, progress: 0.5 });
    const targetTop = documentNavigationScrollTop(source, 400, 2144, revised);
    expect(targetTop).toBe(1470);
    expect(readDocumentNavigation(targetTop, 400, revised)).toEqual(source);
  });

  it('identifies the page occupying most of the viewport, not a sliver of its preceding page', () => {
    expect(readDocumentNavigation(820, 400, baseline)).toEqual({ page: 2, progress: 0 });
  });

  it('clamps the target to reachable scroll positions for short or final pages', () => {
    const shortPages = [{ page: 1, top: 24, height: 600 }, { page: 2, top: 640, height: 250 }];
    expect(documentNavigationScrollTop({ page: 2, progress: 1 }, 500, 914, shortPages)).toBe(414);
    expect(documentNavigationScrollTop({ page: 1, progress: -1 }, 500, 914, shortPages)).toBe(24);
    expect(readDocumentNavigation(0, 400, [])).toBeNull();
  });

  it('preserves relative scrolling for a single PDF page', () => {
    const geometry = [{ page: 3, top: 0, height: 1000 }];
    expect(readDocumentNavigation(300, 400, geometry)).toEqual({ page: 3, progress: 0.5 });
    expect(documentNavigationScrollTop({ page: 3, progress: 0.5 }, 400, 1000, geometry)).toBe(300);
  });
});

describe('document scroll ownership', () => {
  it('does not echo initial, received, or delayed programmatic scrolling', () => {
    const link = new DocumentScrollLink();
    expect(link.report({ page: 1, progress: 0 })).toBeNull();
    link.userInput();
    expect(link.report({ page: 2, progress: 0.3 })).toEqual({ page: 2, progress: 0.3 });
    link.programmatic();
    // Event count and elapsed time cannot expire programmatic ownership.
    for (let event = 0; event < 40; event++) expect(link.report({ page: 2, progress: event / 40 })).toBeNull();
    link.userInput();
    expect(link.report({ page: 2, progress: 0.7 })).toEqual({ page: 2, progress: 0.7 });
  });

  it('lets either pane take control without a receive-report feedback loop', () => {
    const left = new DocumentScrollLink(), right = new DocumentScrollLink();
    left.userInput();
    const toRight = left.report({ page: 2, progress: 0.4 });
    expect(toRight).not.toBeNull();
    right.programmatic();
    expect(right.report(toRight!)).toBeNull();
    right.userInput();
    const toLeft = right.report({ page: 2, progress: 0.8 });
    expect(toLeft).not.toBeNull();
    left.programmatic();
    expect(left.report(toLeft!)).toBeNull();
  });
});

describe('document focus command ownership', () => {
  const initial: DocumentFocusState = { owner: 'manual', changeKey: null };
  const firstChange = { id: 'p1-b2', page: 1, nonce: 1 };

  it('keeps manual page navigation authoritative after a search instead of replaying the old change', () => {
    let state = reduceDocumentFocus(initial, { kind: 'change', command: firstChange });
    state = reduceDocumentFocus(state, { kind: 'search' });
    expect(state.owner).toBe('search');
    state = reduceDocumentFocus(state, { kind: 'manual' });
    const afterManualPage = state;
    state = reduceDocumentFocus(state, { kind: 'change', command: { ...firstChange } });
    expect(state).toBe(afterManualPage);
    expect(state.owner).toBe('manual');
  });

  it('lets an explicit next-change command reclaim focus after manual reading', () => {
    let state = reduceDocumentFocus(initial, { kind: 'change', command: firstChange });
    state = reduceDocumentFocus(state, { kind: 'manual' });
    state = reduceDocumentFocus(state, { kind: 'change', command: { id: 'p2-b4', page: 2, nonce: 2 } });
    expect(state.owner).toBe('change');
    expect(state.changeKey).toBe(JSON.stringify(['p2-b4', 2, 2]));
  });

  it('resumes an explicit search result and permits revisiting the same change with a new nonce', () => {
    let state = reduceDocumentFocus(initial, { kind: 'change', command: firstChange });
    state = reduceDocumentFocus(state, { kind: 'manual' });
    state = reduceDocumentFocus(state, { kind: 'search' });
    expect(state.owner).toBe('search');
    state = reduceDocumentFocus(state, { kind: 'change', command: { ...firstChange, nonce: 3 } });
    expect(state.owner).toBe('change');
  });

  it('does not invent a focus command for a missing source side of an addition or removal', () => {
    const searched = reduceDocumentFocus(initial, { kind: 'search' });
    expect(reduceDocumentFocus(searched, { kind: 'change', command: null })).toBe(searched);
  });
});
