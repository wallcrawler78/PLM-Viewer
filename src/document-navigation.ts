export interface DocumentNavigation { page: number; progress: number }
/** Page bounds in the scroll container's content coordinates, after browser zoom. */
export interface DocumentPageGeometry { page: number; top: number; height: number }

const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value));

/** Link the page being read, not a fraction of two differently sized documents. */
export function readDocumentNavigation(scrollTop: number, viewportHeight: number, pages: readonly DocumentPageGeometry[]): DocumentNavigation | null {
  if (!pages.length) return null;
  const bottom = scrollTop + viewportHeight;
  let visible = pages[0], largestOverlap = -1;
  for (const page of pages) {
    const overlap = Math.max(0, Math.min(bottom, page.top + page.height) - Math.max(scrollTop, page.top));
    if (overlap > largestOverlap) { largestOverlap = overlap; visible = page; }
  }
  const travel = Math.max(0, visible.height - viewportHeight);
  return { page: visible.page, progress: travel > 0 ? clamp((scrollTop - visible.top) / travel) : 0 };
}

/** Resolve a peer command against this document's own page geometry. */
export function documentNavigationScrollTop(navigation: DocumentNavigation, viewportHeight: number, scrollHeight: number, pages: readonly DocumentPageGeometry[]): number {
  const page = pages.find(candidate => candidate.page === navigation.page) ?? pages.at(-1);
  if (!page) return 0;
  const target = page.top + clamp(navigation.progress) * Math.max(0, page.height - viewportHeight);
  return clamp(target, Math.max(0, scrollHeight - viewportHeight));
}

/**
 * Scroll events do not distinguish user input from scrollTo(). Ownership therefore
 * follows real input, not a timeout: delayed rendering/locate events never echo.
 */
export class DocumentScrollLink {
  private userOwnsScroll = false;
  userInput() { this.userOwnsScroll = true; }
  programmatic() { this.userOwnsScroll = false; }
  report(navigation: DocumentNavigation): DocumentNavigation | null {
    return this.userOwnsScroll ? navigation : null;
  }
}

export interface DocumentFocusCommand { id: string; page: number; nonce: number }
export interface DocumentFocusState { owner: 'change' | 'search' | 'manual'; changeKey: string | null }
export type DocumentFocusAction = { kind: 'change'; command: DocumentFocusCommand | null }
  | { kind: 'search' | 'manual' };

/** Clearing search is not a request to replay an older comparison command. */
export function reduceDocumentFocus(state: DocumentFocusState, action: DocumentFocusAction): DocumentFocusState {
  if (action.kind === 'change') {
    if (!action.command) return state;
    const key = JSON.stringify([action.command.id, action.command.page, action.command.nonce]);
    if (key === state.changeKey) return state;
    return { owner: 'change', changeKey: key };
  }
  return state.owner === action.kind ? state : { ...state, owner: action.kind };
}
