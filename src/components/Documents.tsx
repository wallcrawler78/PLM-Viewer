import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { getDocument, OPS, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { AlertCircle, ChevronLeft, ChevronRight, FileText, LoaderCircle, Minus, Plus, Search, X } from 'lucide-react';
import { compareText } from '../text-diff';
import type { DocumentTextBlock } from '../document-review';
import { matchesDocumentAnchor } from '../document-sources';
import { DocumentScrollLink, documentNavigationScrollTop, readDocumentNavigation, reduceDocumentFocus } from '../document-navigation';
import type { DocumentNavigation, DocumentPageGeometry } from '../document-navigation';
import { fetchViewerContent } from '../integrations/protectedContent';
import { pdfRasterSize, renderPdfLayers, sanitizeWordMarkup, validateWordSymbols } from '../document-rendering';
import { boundedDocumentTask, documentComparisonCoverage, documentExtraction, DOCUMENT_PROCESSING_LIMITS, extractionCoverageMessage, failedDocumentExtraction, localPdfAssetUrls, readDocumentSource, verifyDocumentSource } from '../document-extraction';
import type { DocumentExtraction, DocumentPageCoverage } from '../document-extraction';
import { validateWordPackage } from '../document-package';
import { createPdfRasterSource } from '../pdf-visual-raster';
import type { PdfRasterAvailability } from '../pdf-visual-raster';
import { boundedPdfReaderTask, PdfReaderError, readPdfSelectionText, requestPdfPageCleanup } from '../pdf-reader';
import { withAbort } from '../integrations/responseBody';
import { createLocalPdfWorker } from '../pdf-worker';
import { createDocumentWidthScheduler } from '../document-resize';
import { createDocumentSearchIndex, DOCUMENT_SEARCH_LIMITS, documentSearchStatus, findDocumentPassages, isDocumentFindShortcut, normalizeDocumentSearchQuery } from '../document-search';

/** Only deliberately authored attachment errors are safe to show in the viewer. */
class DocumentOpenError extends Error {}
const unreadableAttachmentMessage = 'This attachment could not be opened. Its contents may be incomplete or its format unsupported. Retry, or choose another attachment.';

export interface DocumentFile {
  id: string; itemId: string; revision: string; edition: string; kind: string;
  name: string; url: string; sourceHash?: string; seriesId?: string;
}
export interface DocumentAnchor {
  fileId: string; revision: string; edition: string; page: number;
  itemId?: string; sourceHash?: string;
  x: number; y: number; quote?: string; kind: 'pdf' | 'docx';
  /** False denotes a page/quote anchor without an actual source point. */
  point?: boolean;
}
/** A quoted change has a precise page even when its rendered point is unavailable. */
export type DocumentSuggestionAnchor = Omit<DocumentAnchor, 'x' | 'y'> & { x?: number; y?: number };
export type DocumentSourcePresentation = 'item' | 'local';
interface Props {
  file: DocumentFile;
  sourcePresentation?: DocumentSourcePresentation;
  markMode?: boolean;
  onAnchor?: (anchor: DocumentAnchor) => void;
  onText?: (text: string | null) => void;
  onBlocks?: (blocks: DocumentTextBlock[] | null) => void;
  onExtraction?: (extraction: DocumentExtraction | null) => void;
  /** Shares this exact loaded PDF with the local visual comparison, without refetching. */
  onPdfRaster?: (availability: PdfRasterAvailability) => void;
  highlights?: { id: string; kind: 'added' | 'removed' }[];
  focusBlock?: { id: string; page: number; nonce: number } | null;
  navigation?: { page: number; progress: number; nonce: number } | null;
  onNavigate?: (navigation: { page: number; progress: number }) => void;
  focusAnchor?: DocumentAnchor | null;
  compact?: boolean;
  anchors?: { id: string; anchor: DocumentAnchor; label: string }[];
  onAnchorSelect?: (id: string) => void;
}

export function documentSourceKey(file: DocumentFile): string {
  return JSON.stringify([file.id, file.itemId, file.revision, file.edition, file.sourceHash, file.url, file.kind]);
}

/** IDs are shared by extraction and rendered text, so repeated passages stay distinct. */
function pdfTextBlocks(page: number, items: { str: string; hasEOL?: boolean }[]) {
  const blocks: DocumentTextBlock[] = [];
  const itemBlocks: string[] = [];
  let text = '', index = 0;
  for (const item of items) {
    itemBlocks.push(`p${page}-b${index}`);
    text += item.str + ' ';
    if (item.hasEOL) {
      if (text.trim()) blocks.push({ id: `p${page}-b${index}`, page, text: text.replace(/\s+/g, ' ').trim() });
      text = ''; index++;
    }
  }
  if (text.trim()) blocks.push({ id: `p${page}-b${index}`, page, text: text.replace(/\s+/g, ' ').trim() });
  return { blocks, itemBlocks };
}

export function FileView(props: Props) {
  const [attempt, setAttempt] = useState(0);
  // A new edition must get fresh DOM and render state immediately. In particular,
  // an older Word document must never remain visible under a newer source label.
  return <FileContent key={`${documentSourceKey(props.file)}:${attempt}`} {...props} onRetry={() => setAttempt(value => value + 1)} />;
}

function FileContent({ file, sourcePresentation = 'item', markMode, onAnchor, onText, onBlocks, onExtraction, onPdfRaster, highlights = [], focusBlock, navigation, onNavigate, focusAnchor: requestedFocusAnchor, compact, anchors: requestedAnchors = [], onAnchorSelect, onRetry }: Props & { onRetry: () => void }) {
  const focusAnchor = matchesDocumentAnchor(requestedFocusAnchor, file) ? requestedFocusAnchor : null;
  const anchors = requestedAnchors.filter(pin => matchesDocumentAnchor(pin.anchor, file));
  // docx-preview emits document-specific global CSS. A distinct prefix prevents
  // one revision's Word styles or numbering from styling the other source pane.
  const renderId = useId();
  const docxClassName = `docx-source-${renderId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textContainer = useRef<HTMLDivElement>(null);
  const docxContainer = useRef<HTMLDivElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const findId = `${renderId}-find`;
  const findStatusId = `${renderId}-find-status`;
  const textCallback = useRef(onText);
  textCallback.current = onText;
  const blocksCallback = useRef(onBlocks); blocksCallback.current = onBlocks;
  const extractionCallback = useRef(onExtraction); extractionCallback.current = onExtraction;
  const rasterCallback = useRef(onPdfRaster); rasterCallback.current = onPdfRaster;
  const navigateCallback = useRef(onNavigate); navigateCallback.current = onNavigate;
  const scrollLink = useRef(new DocumentScrollLink());
  const pendingNavigation = useRef<DocumentNavigation | null>(null);
  const [blocks, setBlocks] = useState<DocumentTextBlock[] | null>(null);
  const [extraction, setExtraction] = useState<DocumentExtraction | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [searchFocus, setSearchFocus] = useState<{ id: string; page: number; nonce: number } | null>(null);
  const [focusState, dispatchFocus] = useReducer(reduceDocumentFocus, { owner: 'manual', changeKey: null });
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [pages, setPages] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(380);
  const [size, setSize] = useState({ width: 320, height: 440 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const [textNotice, setTextNotice] = useState('');
  const [sourceNotice, setSourceNotice] = useState('');
  const [renderedPage, setRenderedPage] = useState<string | null>(null);
  const pageKey = `${page}:${zoom}:${width}`;
  const displayError = error || pageError;
  const ready = !loading && !displayError && (file.kind !== 'pdf' || renderedPage === pageKey);
  const searchIndex = useMemo(() => createDocumentSearchIndex(blocks), [blocks]);
  const matches = useMemo(() => findDocumentPassages(searchIndex, query), [searchIndex, query]);
  const searchStatus = documentSearchStatus(extraction, query, matches.length, matchIndex, searchIndex.limited);
  const targetBlock = focusState.owner === 'search' ? searchFocus : focusState.owner === 'change' ? focusBlock : null;

  useEffect(() => { setPageDraft(String(page)); }, [page]);

  function publishExtraction(value: DocumentExtraction | null) {
    setExtraction(value); extractionCallback.current?.(value);
    const nextBlocks = value?.blocks ?? null;
    setBlocks(nextBlocks); blocksCallback.current?.(nextBlocks);
    textCallback.current?.(nextBlocks === null ? null : nextBlocks.map(block => block.text).join('\n'));
  }

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const widths = createDocumentWidthScheduler(nextWidth => { scrollLink.current.programmatic(); setWidth(nextWidth); });
    const observer = new ResizeObserver(entries => {
      // Switching to 3D hides this workspace without discarding reading state.
      // A hidden zero-width box must not trigger a tiny PDF render.
      const nextWidth = entries[0]?.contentRect.width ?? 0;
      widths.update(nextWidth);
    });
    observer.observe(element);
    return () => { observer.disconnect(); widths.dispose(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let loadingTask: ReturnType<typeof getDocument> | undefined;
    let workerOwner: ReturnType<typeof createLocalPdfWorker> | undefined;
    const stopPdf = () => {
      try { if (loadingTask) void loadingTask.destroy().catch(() => {}); } catch { /* The document may already have closed. */ }
      try { workerOwner?.dispose(); } catch { /* Native termination is guaranteed by the owner. */ }
    };
    setPdf(null); setPage(1); setZoom(1); setLoading(true); setError(''); setSourceNotice('');
    rasterCallback.current?.({ status: 'loading' });
    publishExtraction(null);
    async function load() {
      try {
        if (!['pdf', 'docx'].includes(file.kind)) throw new DocumentOpenError('Legacy .doc files are not supported by this viewer. Open a PDF or DOCX rendition supplied with the item.');
        let data: ArrayBuffer;
        try { data = await readDocumentSource(signal => fetchViewerContent(file.url, signal), controller.signal); }
        catch (failure) { if (controller.signal.aborted) throw failure; throw new DocumentOpenError(failure instanceof Error ? failure.message : unreadableAttachmentMessage); }
        if (stopped) return;
        try { await verifyDocumentSource(data, file.sourceHash); }
        catch (failure) { throw new DocumentOpenError(failure instanceof Error ? failure.message : unreadableAttachmentMessage); }
        if (stopped) return;
        if (file.kind === 'pdf') {
          workerOwner = createLocalPdfWorker();
          loadingTask = getDocument({ data, worker: workerOwner.worker, isEvalSupported: false, ...localPdfAssetUrls(import.meta.env.BASE_URL, location.href) });
          const document = await boundedDocumentTask(loadingTask.promise, controller.signal, DOCUMENT_PROCESSING_LIMITS.openMs);
          if (stopped) { stopPdf(); return; }
          setPages(document.numPages); setPdf(document); setLoading(false);
          const extracted: DocumentTextBlock[] = [], coverage: DocumentPageCoverage[] = [];
          const deadline = Date.now() + DOCUMENT_PROCESSING_LIMITS.extractionMs;
          let remainingCharacters = DOCUMENT_PROCESSING_LIMITS.extractionCharacters, limited = false;
          // Rendering remains available even when only some pages can supply text.
          for (let i = 1; i <= Math.min(document.numPages, DOCUMENT_PROCESSING_LIMITS.extractionPages); i++) {
            if (stopped) return;
            if (Date.now() >= deadline || remainingCharacters <= 0 || extracted.length >= DOCUMENT_PROCESSING_LIMITS.extractionBlocks) { limited = true; break; }
            let reader: ReadableStreamDefaultReader | undefined;
            let sheet: PDFPageProxy | undefined;
            try {
              sheet = await boundedDocumentTask(document.getPage(i), controller.signal, deadline - Date.now());
              reader = sheet.streamTextContent().getReader();
              const items: { str: string; hasEOL?: boolean }[] = [];
              let pageLimited = false;
              while (true) {
                const chunk = await boundedDocumentTask(reader.read(), controller.signal, deadline - Date.now());
                if (chunk.done) break;
                for (const item of chunk.value.items) {
                  if (!('str' in item)) continue;
                  if (items.length >= DOCUMENT_PROCESSING_LIMITS.extractionItemsPerPage) { pageLimited = true; break; }
                  if (item.str.length > remainingCharacters) { pageLimited = true; }
                  const text = item.str.slice(0, remainingCharacters);
                  items.push({ str: text, hasEOL: item.hasEOL }); remainingCharacters -= text.length;
                  if (!remainingCharacters) { pageLimited = true; break; }
                }
                if (pageLimited) break;
              }
              const pageBlocks = pdfTextBlocks(i, items).blocks;
              const room = DOCUMENT_PROCESSING_LIMITS.extractionBlocks - extracted.length;
              extracted.push(...pageBlocks.slice(0, room));
              pageLimited ||= pageBlocks.length > room;
              if (pageLimited) { coverage.push({ page: i, status: 'limited' }); limited = true; break; }
              if (pageBlocks.length) coverage.push({ page: i, status: 'text' });
              else {
                const operators = await boundedDocumentTask(sheet.getOperatorList(), controller.signal, deadline - Date.now());
                // A non-text drawing/scanned page is not equivalent to a blank
                // revision. Conservatively require no drawing/text operators.
                const painting = new Set(Object.entries(OPS).filter(([name]) => /^(paint|fill|eoFill|stroke|closeStroke|closeFill|closeEOFill|shadingFill|constructPath|showText|showSpacedText|nextLineShowText|nextLineSetSpacingShowText)/.test(name)).map(([, value]) => value));
                coverage.push({ page: i, status: operators.fnArray.some(operation => painting.has(operation)) ? 'non-text' : 'empty' });
              }
            } catch {
              if (stopped) return;
              coverage.push({ page: i, status: 'failed' });
              if (Date.now() >= deadline) { limited = true; break; }
            } finally { void reader?.cancel().catch(() => {}); requestPdfPageCleanup(sheet); }
            // Yield between pages so navigation and cancellation stay responsive.
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          limited ||= coverage.length < document.numPages;
          if (!stopped) publishExtraction(documentExtraction(extracted, coverage, document.numPages, limited));
        } else if (docxContainer.current) {
          // PDF-only sessions do not need the Word parser and ZIP renderer.
          const { parseAsync, renderDocument } = await import('docx-preview');
          if (stopped || !docxContainer.current) return;
          try { await validateWordPackage(data, controller.signal); }
          catch (failure) { if (controller.signal.aborted) throw failure; throw new DocumentOpenError(failure instanceof Error ? failure.message : unreadableAttachmentMessage); }
          if (stopped || !docxContainer.current) return;
          const target = document.createElement('div');
          const options = {
            inWrapper: true, ignoreWidth: true, ignoreHeight: true,
            className: docxClassName, breakPages: true, renderHeaders: true,
            renderFooters: true, renderAltChunks: false, renderChanges: false,
            renderComments: false, useBase64URL: true,
          };
          const wordDocument = await boundedDocumentTask(parseAsync(data, options), controller.signal, DOCUMENT_PROCESSING_LIMITS.openMs);
          if (stopped || !docxContainer.current) return;
          const features = validateWordSymbols(wordDocument);
          await boundedDocumentTask(Promise.resolve(renderDocument(wordDocument, target, undefined, options)), controller.signal, DOCUMENT_PROCESSING_LIMITS.openMs);
          if (stopped || !docxContainer.current) return;
          // docx-preview preserves external relationship targets as href values.
          // Review document links before attaching its DOM to the viewer origin.
          const notices: string[] = [];
          if (sanitizeWordMarkup(target, docxClassName)) notices.push('Some embedded links or styles are unavailable in this browser view.');
          if (features.trackedChanges) notices.push('This file contains tracked changes. Showing current text; existing Word change marks are not displayed.');
          if (features.comments) notices.push('Existing Word comments are not displayed.');
          if (features.altChunks) notices.push('Some embedded document content is unsupported and is excluded from this view.');
          setSourceNotice(notices.join(' '));
          target.querySelectorAll<HTMLElement>(`section.${docxClassName}`).forEach(section => section.classList.add('word-page'));
          target.querySelectorAll<HTMLElement>(`.${docxClassName}-wrapper`).forEach(wrapper => wrapper.classList.add('word-page-wrapper'));
          if (target.querySelectorAll('*').length > DOCUMENT_PROCESSING_LIMITS.wordElements || target.querySelectorAll('section.word-page').length > DOCUMENT_PROCESSING_LIMITS.wordPages) throw new DocumentOpenError('This Word file exceeds the browser display limit. Use a PDF rendition or a smaller document.');
          docxContainer.current.replaceChildren(...Array.from(target.childNodes));
          // The rendered pages are intentionally hidden until this load completes.
          // Read semantic paragraph text, independent of visibility, and exclude
          // docx-preview's injected styles and wrapper content from comparison.
          const sections = Array.from(docxContainer.current.querySelectorAll<HTMLElement>('section.word-page'));
          const extracted: DocumentTextBlock[] = [], coverage: DocumentPageCoverage[] = [];
          let remainingCharacters = DOCUMENT_PROCESSING_LIMITS.extractionCharacters, limited = false;
          for (const [sectionIndex, section] of sections.entries()) {
            if (!remainingCharacters || extracted.length >= DOCUMENT_PROCESSING_LIMITS.extractionBlocks) { limited = true; break; }
            const paragraphs = Array.from(section.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6,tr'))
              .filter(element => element.tagName === 'TR' || !element.closest('tr'));
            const initialCount = extracted.length;
            let pageLimited = false;
            for (const [index, element] of paragraphs.entries()) {
              // A table row is one requirement: keep each cell with its label.
              const text = element.tagName === 'TR'
                ? Array.from((element as HTMLTableRowElement).cells).map(cell => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' | ')
                : (element.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (!text) continue;
              const id = `p${sectionIndex + 1}-b${index}`;
              element.dataset.documentBlock = id;
              const included = text.slice(0, remainingCharacters);
              extracted.push({ id, page: sectionIndex + 1, text: included });
              remainingCharacters -= included.length;
              if (included.length < text.length || !remainingCharacters || extracted.length >= DOCUMENT_PROCESSING_LIMITS.extractionBlocks) { pageLimited = true; limited = true; break; }
            }
            coverage.push({ page: sectionIndex + 1, status: pageLimited ? 'limited' : extracted.length > initialCount ? 'text' : section.querySelector('img,svg,canvas,math') ? 'non-text' : 'empty' });
          }
          setPages(Math.max(1, sections.length));
          const extraction = documentExtraction(extracted, coverage.length ? coverage : [{ page: 1, status: 'empty' }], Math.max(1, sections.length), limited);
          if (features.altChunks) extraction.status = extracted.length ? 'partial' : 'unavailable';
          publishExtraction(extraction);
          setLoading(false);
        }
      } catch (e) {
        if (!stopped) { const message = e instanceof DocumentOpenError ? e.message : unreadableAttachmentMessage; setError(message); setPdf(null); setLoading(false); publishExtraction(failedDocumentExtraction()); rasterCallback.current?.({ status: 'unavailable', message }); stopPdf(); }
      }
    }
    void load();
    return () => { stopped = true; controller.abort(); stopPdf(); };
  }, [file.id, file.url, file.kind, file.edition, file.revision, file.sourceHash]);

  useEffect(() => {
    if (!pdf) return;
    const provider = createPdfRasterSource(pdf, documentSourceKey(file));
    rasterCallback.current?.({ status: 'ready', source: provider.source });
    return () => provider.dispose();
  }, [pdf]);

  // A PDF changes its rendered surface when its page changes. DOCX keeps every
  // page mounted: scrolling into another page must not replay the locate command.
  const focusRenderPage = file.kind === 'pdf' ? page : 0;
  useEffect(() => {
    if (focusAnchor?.fileId === file.id) {
      dispatchFocus({ kind: 'manual' });
      scrollLink.current.programmatic();
      setPage(Math.max(1, Math.min(pages, focusAnchor.page)));
    }
  }, [focusAnchor, file.id, file.kind, pages, loading]);

  useEffect(() => {
    const scroller = container.current?.querySelector<HTMLElement>('.file-scroll');
    if (file.kind === 'pdf') { scrollLink.current.programmatic(); scroller?.scrollTo({ top: 0, left: 0 }); }
  }, [page]);

  function pageGeometry(scroller: HTMLElement): DocumentPageGeometry[] {
    if (file.kind !== 'docx') return [{ page, top: 0, height: scroller.scrollHeight }];
    const top = scroller.getBoundingClientRect().top;
    return Array.from(docxContainer.current?.querySelectorAll<HTMLElement>('section.word-page') ?? [])
      .map((section, index) => {
        const bounds = section.getBoundingClientRect();
        return { page: index + 1, top: scroller.scrollTop + bounds.top - top, height: bounds.height };
      });
  }

  function scrollToNavigation(scroller: HTMLElement, value: DocumentNavigation) {
    scrollLink.current.programmatic();
    scroller.scrollTo({ top: documentNavigationScrollTop(value, scroller.clientHeight, scroller.scrollHeight, pageGeometry(scroller)), behavior: 'auto' });
  }

  function startUserScroll() {
    pendingNavigation.current = null;
    scrollLink.current.userInput();
    dispatchFocus({ kind: 'manual' });
  }

  function goToPage(next: number) {
    const nextPage = Math.max(1, Math.min(pages, next));
    pendingNavigation.current = null;
    scrollLink.current.programmatic();
    dispatchFocus({ kind: 'manual' });
    setSearchFocus(null); setPage(nextPage);
    if (file.kind === 'docx') {
      const scroller = container.current?.querySelector<HTMLElement>('.file-scroll');
      if (scroller) scrollToNavigation(scroller, { page: nextPage, progress: 0 });
    }
    navigateCallback.current?.({ page: nextPage, progress: 0 });
  }

  function commitPage() {
    const next = Number(pageDraft);
    if (Number.isInteger(next) && next >= 1 && next <= pages) goToPage(next);
    else setPageDraft(String(page));
  }

  function scrollToElement(scroller: HTMLElement, element: HTMLElement, center = true) {
    scrollLink.current.programmatic();
    scroller.scrollTo({
      top: scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (center ? scroller.clientHeight / 3 : 15),
      behavior: 'auto',
    });
  }

  useEffect(() => {
    if (!navigation) { pendingNavigation.current = null; return; }
    dispatchFocus({ kind: 'manual' });
    scrollLink.current.programmatic();
    const targetPage = Math.max(1, Math.min(pages, navigation.page));
    setPage(targetPage);
    pendingNavigation.current = { page: targetPage, progress: Math.max(0, Math.min(1, navigation.progress)) };
  }, [navigation, pages]);

  useEffect(() => {
    if (!ready || pendingNavigation.current === null) return;
    if (file.kind === 'pdf' && navigation && page !== Math.max(1, Math.min(pages, navigation.page))) return;
    const scroller = container.current?.querySelector<HTMLElement>('.file-scroll');
    if (!scroller) return;
    scrollToNavigation(scroller, pendingNavigation.current);
    pendingNavigation.current = null;
  }, [ready, navigation, page, file.kind, pages]);

  useEffect(() => { dispatchFocus({ kind: 'change', command: focusBlock ?? null }); }, [focusBlock]);
  function changeQuery(value: string) {
    const next = value.slice(0, DOCUMENT_SEARCH_LIMITS.queryCharacters);
    setQuery(next); setMatchIndex(0);
    dispatchFocus({ kind: normalizeDocumentSearchQuery(next) ? 'search' : 'manual' });
  }
  function openSearch() {
    setFindOpen(true);
    findInput.current?.focus({ preventScroll: true });
    findInput.current?.select();
  }
  function closeSearch() {
    setFindOpen(false); changeQuery(''); setSearchFocus(null);
    findButton.current?.focus({ preventScroll: true });
  }
  function handleDocumentKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (event.defaultPrevented || event.nativeEvent.isComposing || !(target instanceof Element)
      || target.closest('.file-view') !== event.currentTarget || !event.currentTarget.contains(document.activeElement)) return;
    // A portal may bubble through React despite being outside this pane. Nested
    // dialogs own their shortcuts; a surrounding comparison dialog still lets
    // its reader handle its own search without closing that dialog on Escape.
    const dialog = target.closest('dialog,[role="dialog"],[aria-modal="true"]');
    if (dialog && event.currentTarget.contains(dialog)) return;
    if (event.key === 'Escape' && findOpen && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation(); closeSearch(); return;
    }
    if (loading || error || !isDocumentFindShortcut(event)) return;
    event.preventDefault(); event.stopPropagation(); openSearch();
  }
  useEffect(() => { if (findOpen) findInput.current?.focus({ preventScroll: true }); }, [findOpen]);
  useEffect(() => {
    setMatchIndex(0);
    setSearchFocus(matches[0] ? { id: matches[0].id, page: matches[0].page, nonce: Date.now() } : null);
  }, [query, blocks]);
  function focusMatch(next: number) {
    if (!matches.length) return;
    const index = (next + matches.length) % matches.length;
    dispatchFocus({ kind: 'search' });
    setMatchIndex(index); setSearchFocus({ id: matches[index].id, page: matches[index].page, nonce: Date.now() });
  }
  useEffect(() => {
    if (targetBlock) setPage(Math.max(1, Math.min(pages, targetBlock.page)));
  }, [targetBlock, pages]);
  useEffect(() => {
    if (!ready) return;
    const root = file.kind === 'pdf' ? textContainer.current : docxContainer.current;
    const elements = Array.from(root?.querySelectorAll<HTMLElement>('[data-document-block]') ?? []);
    const highlightMap = new Map(highlights.map(highlight => [highlight.id, highlight.kind]));
    const matchIds = new Set(matches.map(match => match.id));
    for (const element of elements) {
      const id = element.dataset.documentBlock ?? '';
      const kind = highlightMap.get(id);
      element.classList.toggle('document-change-added', kind === 'added');
      element.classList.toggle('document-change-removed', kind === 'removed');
      element.classList.toggle('document-change-active', !!kind && targetBlock?.id === id);
      element.classList.toggle('document-search-hit', matchIds.has(id));
      element.classList.toggle('document-search-active', focusState.owner === 'search' && searchFocus?.id === id);
    }
  }, [ready, highlights, matches, targetBlock, searchFocus, file.kind, focusState.owner]);
  useEffect(() => {
    if (!ready || !targetBlock) return;
    const scroller = container.current?.querySelector<HTMLElement>('.file-scroll');
    const root = file.kind === 'pdf' ? textContainer.current : docxContainer.current;
    const target = Array.from(root?.querySelectorAll<HTMLElement>('[data-document-block]') ?? []).find(element => element.dataset.documentBlock === targetBlock.id);
    if (target && scroller) scrollToElement(scroller, target);
  }, [ready, targetBlock, file.kind]);

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const scroller = event.currentTarget;
    if (!ready || scroller.clientHeight <= 0) return;
    const value = readDocumentNavigation(scroller.scrollTop, scroller.clientHeight, pageGeometry(scroller));
    if (file.kind === 'docx' && value) setPage(value.page);
    if (!value) return;
    const report = scrollLink.current.report(value);
    if (report) navigateCallback.current?.(report);
  }

  useEffect(() => {
    if (!ready || focusAnchor?.fileId !== file.id) return;
    const scroller = container.current?.querySelector<HTMLElement>('.file-scroll');
    if (!scroller) return;
    if (focusAnchor.quote) {
      const quote = focusAnchor.quote.replace(/\s+/g, ' ').trim();
      const quotedBlock = blocks?.find(block => block.page === focusAnchor.page && block.text.includes(quote));
      const root = file.kind === 'pdf' ? textContainer.current : docxContainer.current;
      const target = Array.from(root?.querySelectorAll<HTMLElement>('[data-document-block]') ?? []).find(element => element.dataset.documentBlock === quotedBlock?.id);
      if (target) { scrollToElement(scroller, target); return; }
    }
    const surface = file.kind === 'pdf'
      ? focusAnchor.page === focusRenderPage ? container.current?.querySelector<HTMLElement>('.pdf-page') : null
      : docxContainer.current?.querySelectorAll<HTMLElement>('section.word-page')[focusAnchor.page - 1];
    if (!surface) return;
    if (focusAnchor.point === false) { scrollToElement(scroller, surface, false); return; }
    const scrollBox = scroller.getBoundingClientRect(), surfaceBox = surface.getBoundingClientRect();
    scrollLink.current.programmatic();
    scroller.scrollTo({
      top: scroller.scrollTop + surfaceBox.top - scrollBox.top + surfaceBox.height * focusAnchor.y - scrollBox.height / 2,
      left: scroller.scrollLeft + surfaceBox.left - scrollBox.left + surfaceBox.width * focusAnchor.x - scrollBox.width / 2,
      behavior: 'auto',
    });
  }, [ready, focusAnchor, file.id, file.kind, focusRenderPage, blocks]);

  useEffect(() => {
    if (!pdf || !canvas.current || !textContainer.current) return;
    const controller = new AbortController();
    let cancelled = false;
    let sheet: PDFPageProxy | undefined;
    let task: RenderTask | undefined;
    let layer: TextLayer | undefined;
    setRenderedPage(null);
    setPageError('');
    setTextNotice('');
    textContainer.current.replaceChildren();
    (async () => {
      try {
        const currentSheet = await boundedPdfReaderTask(() => pdf.getPage(page), controller.signal);
        sheet = currentSheet;
        if (cancelled || !canvas.current || !textContainer.current) return;
        const natural = currentSheet.getViewport({ scale: 1 });
        const scale = Math.max(0.15, Math.min(width - 38, 900) / natural.width) * zoom;
        const viewport = currentSheet.getViewport({ scale });
        const raster = pdfRasterSize(viewport.width, viewport.height, window.devicePixelRatio || 1);
        const c = canvas.current;
        c.width = raster.width; c.height = raster.height;
        c.style.width = `${viewport.width}px`; c.style.height = `${viewport.height}px`;
        setSize({ width: viewport.width, height: viewport.height });
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('Canvas rendering is unavailable in this browser.');
        const result = await renderPdfLayers(async () => {
          await boundedPdfReaderTask(() => {
            task = currentSheet.render({ canvasContext: ctx, viewport, transform: [raster.ratio, 0, 0, raster.ratio, 0, 0] });
            return task.promise;
          }, controller.signal, { cancel: () => task?.cancel() });
        }, async () => {
          await boundedPdfReaderTask(async signal => {
            const text = await readPdfSelectionText(currentSheet.streamTextContent(), signal);
            signal.throwIfAborted();
            if (cancelled || !textContainer.current) return;
            textContainer.current.replaceChildren();
            textContainer.current.style.setProperty('--scale-factor', String(scale));
            layer = new TextLayer({ textContentSource: text, container: textContainer.current, viewport });
            await withAbort(layer.render(), signal);
            signal.throwIfAborted();
            const items = text.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item);
            const mapping = pdfTextBlocks(page, items).itemBlocks;
            layer.textDivs.forEach((element, index) => { if (mapping[index]) element.dataset.documentBlock = mapping[index]; });
          }, controller.signal, { cancel: () => layer?.cancel() });
        }, () => cancelled);
        if (result === 'cancelled') return;
        if (result === 'image-only') {
          layer?.cancel(); textContainer.current?.replaceChildren();
          setTextNotice('Text selection is unavailable on this page. The page image is still available for visual review.');
        }
        setRenderedPage(pageKey);
      } catch (e) {
        if (!cancelled && !(e instanceof Error && e.name === 'RenderingCancelledException')) setPageError(e instanceof PdfReaderError ? e.message : 'This page could not be rendered. Try another page or retry the document.');
      } finally { requestPdfPageCleanup(sheet); }
    })();
    return () => { cancelled = true; controller.abort(); task?.cancel(); layer?.cancel(); };
  }, [pdf, page, zoom, width, pageKey]);

  function anchor(event: React.MouseEvent<HTMLDivElement>) {
    if (!ready || !markMode || !onAnchor) return;
    // A markup click on linked text adds a comment instead of opening the link.
    event.preventDefault();
    const sections = file.kind === 'docx' ? Array.from(event.currentTarget.querySelectorAll<HTMLElement>('section.word-page')) : [];
    const section = event.target instanceof Element ? event.target.closest<HTMLElement>('section.word-page') : null;
    const sectionIndex = section ? sections.indexOf(section) : -1;
    // Coordinates belong to a page, not the wrapper spanning all Word pages.
    if (file.kind === 'docx' && sectionIndex < 0) return;
    const box = (sectionIndex >= 0 ? section! : event.currentTarget).getBoundingClientRect();
    const selection = window.getSelection();
    const quote = selection && event.currentTarget.contains(selection.anchorNode) ? selection.toString().slice(0, 800) : '';
    onAnchor({ fileId: file.id, itemId: file.itemId, sourceHash: file.sourceHash, revision: file.revision, edition: file.edition, page: sectionIndex >= 0 ? sectionIndex + 1 : page,
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)), quote: quote || undefined,
      kind: file.kind === 'pdf' ? 'pdf' : 'docx' });
  }

  function docxClick(event: React.MouseEvent<HTMLDivElement>) {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-document-bookmark]') : null;
    if (link && event.currentTarget.contains(link)) {
      event.preventDefault();
      if (!markMode && ready) {
        // Resolve bookmarks inside this exact source pane; comparison revisions
        // can contain identical bookmark IDs without jumping to each other.
        const destination = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[id]')).find(element => element.id === link.dataset.documentBookmark);
        const scroller = container.current?.querySelector<HTMLElement>('.file-scroll');
        if (destination && scroller) {
          dispatchFocus({ kind: 'manual' }); setSearchFocus(null); pendingNavigation.current = null;
          scrollToElement(scroller, destination);
          const value = readDocumentNavigation(scroller.scrollTop, scroller.clientHeight, pageGeometry(scroller));
          if (value) { setPage(value.page); navigateCallback.current?.(value); }
        }
      }
    }
    anchor(event);
  }

  return <div className={`file-view ${compact ? 'compact' : ''}`} ref={container} onKeyDown={handleDocumentKey}>
    <div className="file-controls">
      <span className="file-type"><FileText size={13} />{file.kind.toUpperCase()}</span>
      <>
        <button className="icon-button small" title="Previous page" aria-label="Previous page" onClick={() => goToPage(page - 1)} disabled={loading || !!error || page <= 1}><ChevronLeft size={15} /></button>
        <label className="document-page-field" title={file.kind === 'docx' ? 'Browser page' : 'Page'}><span className="sr-only">Page number</span><input type="number" aria-label="Page number" min={1} max={pages} value={pageDraft} disabled={loading || !!error} title="Enter a page number, then press Enter or leave the field to open it" onChange={event => setPageDraft(event.target.value)} onBlur={commitPage} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /><span>/ {pages}</span></label>
        <button className="icon-button small" title="Next page" aria-label="Next page" onClick={() => goToPage(page + 1)} disabled={loading || !!error || page >= pages}><ChevronRight size={15} /></button>
        <span className="control-spacer" />
        <button className="icon-button small" aria-label="Zoom out document" disabled={loading || !!error || zoom <= 0.5} onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))}><Minus size={14} /></button>
        <button className="text-button zoom-value" onClick={() => setZoom(1)} title="Fit page width" aria-label="Fit document width">{zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`}</button>
        <button className="icon-button small" aria-label="Zoom in document" disabled={loading || !!error || zoom >= 2.5} onClick={() => setZoom(z => Math.min(2.5, z + 0.25))}><Plus size={14} /></button>
        <span className="document-control-divider" />
        <button ref={findButton} className={`icon-button small ${findOpen ? 'active' : ''}`} aria-label="Find in document" title="Find in document (Ctrl/⌘+F)" aria-keyshortcuts="Control+f Meta+f" aria-pressed={findOpen} aria-expanded={findOpen} aria-controls={findOpen ? findId : undefined} onClick={() => findOpen ? closeSearch() : openSearch()} disabled={loading || !!error}><Search size={15} /></button>
      </>
    </div>
    {findOpen && <div id={findId} className="document-find" role="search"><Search size={14} /><input ref={findInput} type="search" aria-label="Find document text" aria-describedby={findStatusId} maxLength={DOCUMENT_SEARCH_LIMITS.queryCharacters} value={query} placeholder="Find text in this file…" title="Find words or phrases in extracted text. Results are matching passages." onChange={event => changeQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); focusMatch(matchIndex + (event.shiftKey ? -1 : 1)); } }} /><span id={findStatusId} aria-live="polite" aria-atomic="true">{searchStatus}</span><button className="icon-button small" aria-label="Previous search result" title="Previous matching passage (Shift+Enter)" disabled={!matches.length} onClick={() => focusMatch(matchIndex - 1)}><ChevronLeft size={14} /></button><button className="icon-button small" aria-label="Next search result" title="Next matching passage (Enter)" disabled={!matches.length} onClick={() => focusMatch(matchIndex + 1)}><ChevronRight size={14} /></button><button className="icon-button small" aria-label="Close document search" onClick={closeSearch}><X size={14} /></button></div>}
    {markMode && <div className="document-instruction">{file.kind === 'pdf' ? 'Click a location on the page to add a comment.' : 'Click a location or select a passage to comment. Page numbers follow this browser reflow.'}</div>}
    {(sourceNotice || textNotice || extractionCoverageMessage(extraction)) && <div className="document-text-notice" role="status"><AlertCircle size={14} /><span>{[sourceNotice, textNotice, extractionCoverageMessage(extraction)].filter(Boolean).join(' ')}</span></div>}
    {file.kind === 'docx' && anchors.length > 0 && <div className="document-note-links">{anchors.map(pin => <button key={pin.id} onClick={() => onAnchorSelect?.(pin.id)}><span>{pin.label}</span>Review note</button>)}</div>}
    <div className="file-scroll" tabIndex={0} aria-label="Document pages" aria-busy={!ready && !displayError} onScroll={handleScroll} onWheel={startUserScroll} onPointerDownCapture={startUserScroll} onTouchStart={startUserScroll} onKeyDownCapture={event => { if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) startUserScroll(); }}>
      {!ready && !displayError && <div className="document-state" role="status"><LoaderCircle className="spin" size={22} /><span>Rendering document…</span></div>}
      {displayError && <div className="document-state error" role="alert"><AlertCircle size={24} /><strong>Document unavailable</strong><p>{displayError}</p><button className="button secondary" onClick={onRetry}>Retry document</button></div>}
      {file.kind === 'pdf' && <div className={`pdf-page ${markMode ? 'mark-mode' : ''}`} style={{ width: size.width, height: size.height, visibility: ready ? 'visible' : 'hidden' }} onClick={anchor}>
        <canvas ref={canvas} />
        <div className="textLayer" ref={textContainer} />
        {focusAnchor?.fileId === file.id && focusAnchor.page === page && focusAnchor.point !== false && <span className="document-pin" style={{ left: `${focusAnchor.x * 100}%`, top: `${focusAnchor.y * 100}%` }}>●</span>}
        {anchors.filter(pin => pin.anchor.page === page).map(pin => <button className="document-comment-pin" key={pin.id} aria-label={`Open document comment ${pin.label}`} style={{ left: `${pin.anchor.x * 100}%`, top: `${pin.anchor.y * 100}%` }} onClick={event => { event.stopPropagation(); onAnchorSelect?.(pin.id); }}>{pin.label}</button>)}
      </div>}
      {file.kind === 'docx' && <div className={`docx-content ${markMode ? 'mark-mode' : ''}`} style={{ visibility: ready ? 'visible' : 'hidden', zoom }} ref={docxContainer} onClick={docxClick} />}
    </div>
    <div className="file-source">{sourcePresentation === 'local' ? <>{file.revision} <span>·</span> Local source</> : <>Rev {file.revision} <span>·</span> File edition {file.edition}</>} <span>·</span> {file.kind === 'docx' ? 'Reflowed pages' : 'Source pages'}</div>
  </div>;
}

export function DocumentComparison({ before, after, onClose, onSuggest }: {
  before: DocumentFile; after: DocumentFile; onClose: () => void;
  onSuggest: (message: string, file: DocumentFile) => void;
}) {
  const [leftExtraction, setLeftExtraction] = useState<DocumentExtraction | null>(null);
  const [rightExtraction, setRightExtraction] = useState<DocumentExtraction | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') ?? [])
          .filter(control => !control.hidden && control.getClientRects().length > 0 && getComputedStyle(control).visibility !== 'hidden');
        if (!controls.length) return;
        const focused = document.activeElement as HTMLElement;
        if (event.shiftKey && (focused === controls[0] || !controls.includes(focused))) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && (focused === controls.at(-1) || !controls.includes(focused))) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if(previous?.isConnected) previous.focus(); };
  }, []);
  const leftText = leftExtraction?.blocks.map(block => block.text).join('\n') ?? null;
  const rightText = rightExtraction?.blocks.map(block => block.text).join('\n') ?? null;
  const coverage = documentComparisonCoverage(leftExtraction, rightExtraction);
  const changes = coverage.canCompare ? compareText(leftText ?? '', rightText ?? '') : [];
  const changed = changes.filter(c => c.kind !== 'equal');
  const textStatus = coverage.pending ? 'Extracting text…' : coverage.unavailable ? 'Text comparison unavailable' : `${changed.length} text changes${coverage.partial ? ' · partial coverage' : ''}`;
  return <div className="modal-backdrop" role="presentation">
    <section ref={dialog} className="document-comparison modal" role="dialog" aria-modal="true" aria-label="Compare document revisions">
      <div className="modal-header"><div><span className="eyebrow">DOCUMENT COMPARISON</span><h2>Review document changes</h2></div><button className="button secondary" onClick={onClose}>Back to assembly</button></div>
      <div className="comparison-docs">
        <div><div className="comparison-doc-label"><span className="revision-tag a">A</span><strong>{before.name}</strong><span>Edition {before.edition}</span></div><FileView file={before} onExtraction={setLeftExtraction} compact /></div>
        <div><div className="comparison-doc-label"><span className="revision-tag b">B</span><strong>{after.name}</strong><span>Edition {after.edition}</span></div><FileView file={after} onExtraction={setRightExtraction} compact /></div>
      </div>
      <div className="text-difference-header"><strong>{textStatus}</strong><span>Extracted text comparison; formatting and scanned images are not classified.</span><button className="text-button" onClick={() => setShowChanges(s => !s)}>{showChanges ? 'Collapse' : 'Expand'}</button></div>
      {showChanges && <div className="text-differences">
        {coverage.pending ? <p className="muted">Extracting text from both documents…</p> : coverage.unavailable ? <p className="muted">Text could not be extracted from one or both files. Compare the rendered pages; scanned documents require OCR.</p> : changed.length === 0 ? <p>{coverage.partial ? 'No differences found in the available text. Some content was not compared.' : 'No text differences found.'}</p> : changes.map((c, i) => c.kind !== 'equal' && <div className={`text-change ${c.kind}`} key={i}><span>{c.kind === 'added' ? '+' : '−'}</span><p>{c.text}</p>{c.kind === 'added' && <button className="text-button" onClick={() => onSuggest(`Verify the updated requirement against the model: “${c.text.slice(0, 500)}”`, after)}>Suggest review note</button>}</div>)}
      </div>}
      <div className="comparison-footnote">Suggested notes are review prompts generated from the text changes. They require your review before posting.{coverage.partial ? ' Comparison is incomplete; unavailable content can appear as changes.' : ''}{(leftText?.split(/\n+/).length??0)>1500||(rightText?.split(/\n+/).length??0)>1500?' Comparison is limited to the first 1,500 nonempty lines in each file.':''}</div>
    </section>
  </div>;
}
