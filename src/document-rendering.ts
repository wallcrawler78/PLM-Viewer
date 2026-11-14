/** Rendered attachment links must not become executable viewer-origin URLs. */
export type DocumentLink = { kind: 'bookmark'; href: string; bookmark: string }
  | { kind: 'external'; href: string }
  | { kind: 'blocked' };

export function documentLink(value: string | null): DocumentLink {
  if (!value || value.length > 8192 || /[\\\u0000-\u001f\u007f]/.test(value)) return { kind: 'blocked' };
  const href = value.trim();
  if (href.startsWith('#')) {
    let bookmark;
    try { bookmark = decodeURIComponent(href.slice(1)); } catch { return { kind: 'blocked' }; }
    if (!bookmark || bookmark.length > 2048 || /[\u0000-\u001f\u007f]/.test(bookmark)) return { kind: 'blocked' };
    return { kind: 'bookmark', href: `#${encodeURIComponent(bookmark)}`, bookmark };
  }
  try {
    // Relative URLs would resolve against the viewer, not the originating Word file.
    const url = new URL(href);
    if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) return { kind: 'blocked' };
    if (['https:', 'http:'].includes(url.protocol) && !/^https?:\/\//i.test(href)) return { kind: 'blocked' };
    return { kind: 'external', href: url.href };
  } catch { return { kind: 'blocked' }; }
}

/** Check the parsed OOXML tree before docx-preview can create symbol innerHTML. */
export function validateWordSymbols(document: unknown) {
  const parts = (document as { parts?: unknown[] } | null)?.parts;
  if (!Array.isArray(parts)) throw new Error('Unsupported Word document structure.');
  const pending: unknown[] = [];
  const features = { trackedChanges: false, comments: false, altChunks: false };
  for (const source of parts) {
    const part = source as { body?: unknown; rootElement?: unknown; notes?: unknown[]; comments?: unknown[] } | null;
    if (!part || typeof part !== 'object') continue;
    if (part.comments?.length) features.comments = true;
    pending.push(part.body, part.rootElement, ...(part.notes ?? []), ...(part.comments ?? []));
  }
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 200_000) throw new Error('This Word document exceeds the display limit.');
    const node = value as { type?: string; char?: unknown; children?: unknown[] };
    if (['inserted', 'deleted', 'deletedText'].includes(node.type ?? '')) features.trackedChanges = true;
    if (['commentReference', 'commentRangeStart', 'commentRangeEnd'].includes(node.type ?? '')) features.comments = true;
    if (node.type === 'altChunk') features.altChunks = true;
    if (node.type === 'symbol') {
      if (typeof node.char !== 'string' || !/^[a-f\d]{1,6}$/i.test(node.char) || parseInt(node.char, 16) > 0x10ffff) throw new Error('Unsupported Word symbol encoding.');
    }
    if (Array.isArray(node.children)) for (const child of node.children) pending.push(child);
  }
  return features;
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\(?:([a-f\d]{1,6})(?:\r\n|[\t\n\f\r ])?|([^\n\r\f]))/gi, (_match, hex: string | undefined, character: string | undefined) => {
    const code = hex ? parseInt(hex, 16) : 0;
    return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : character ?? '';
  });
}

/** CSS must stay inside its source pane and cannot load remote attachment resources. */
export function documentCssValue(value: string): boolean {
  let safe = true;
  // Normal list markers use escaped tabs; escaped url() receives the same check.
  const normalized = decodeCssEscapes(value);
  const remaining = normalized.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, source: string) => {
    if (!/^#[a-z\d_.:-]+$/i.test(source) && !/^data:(?:image\/[a-z\d.+-]+|font\/[a-z\d.+-]+|application\/(?:octet-stream|font-[a-z\d-]+|vnd\.ms-[a-z\d-]+));base64,[a-z\d+/=\s]+$/i.test(source)) safe = false;
    return '';
  });
  return safe && !/[\\{}<>]|\/\*|\*\/|(?:url|image-set|src|expression)\s*\(|(?:https?|file|javascript|vbscript|blob):/i.test(remaining);
}

export function documentCssSelector(selector: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scoped = new RegExp(`^(?:[a-z][a-z\\d-]*)?\\.${escaped}(?=[_a-z\\d-]|[\\s.#:\\[>]|$)`, 'i');
  return !/[+~]|:has\(|:is\(|:where\(/i.test(selector) && selector.split(',').every(part => scoped.test(part.trim()));
}

/** JSZip blobs have no MIME; recover known image types without allowing generic data links. */
export function normalizedDocumentImage(value: string): string | null {
  if (/^data:image\/[a-z\d.+-]+;base64,[a-z\d+/=\s]+$/i.test(value) || /^#[a-z\d_.:-]+$/i.test(value)) return value;
  const generic = /^data:application\/octet-stream;base64,([a-z\d+/=\s]+)$/i.exec(value);
  if (!generic) return null;
  const encoded = generic[1].replace(/\s/g, '');
  let head;
  try { head = atob(encoded.slice(0, 1024)); } catch { return null; }
  const bytes = Array.from(head, character => character.charCodeAt(0));
  const mime = head.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
    : /^GIF8[79]a/.test(head) ? 'image/gif'
    : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP' ? 'image/webp'
    : head.startsWith('BM') ? 'image/bmp'
    : bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 ? 'image/x-icon'
    : /^\s*(?:<\?xml[^>]*\?>\s*)?<svg(?:\s|>)/i.test(head) ? 'image/svg+xml' : null;
  return mime ? `data:${mime};base64,${encoded}` : null;
}

export const documentImageSource = (value: string): boolean => normalizedDocumentImage(value) !== null;

export function wordFontKey(value: string): string {
  return decodeCssEscapes(value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')).replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

/** Preserve fallback lists, quoted commas and var() while replacing embedded font names. */
export function namespaceWordFonts(value: string, families: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  let quote = '', escaped = false, depth = 0, start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === ',' && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start));
  return parts.map(part => { const name = families.get(wordFontKey(part)); return name ? `"${name}"` : part.trim(); }).join(', ');
}

/** The renderer is a formatter, not a sanitizer. Apply its output policy before insertion. */
export function sanitizeWordMarkup(root: HTMLElement, className: string): boolean {
  let altered = false;
  root.querySelectorAll('script,iframe,object,embed,form,input,textarea,select,button,link,meta,base,video,audio').forEach(element => { element.remove(); altered = true; });
  const sheets: { element: HTMLStyleElement; sheet: CSSStyleSheet }[] = [];
  const fontFamilies = new Map<string, string>();
  root.querySelectorAll<HTMLStyleElement>('style').forEach(element => {
    try {
      const sheet = new CSSStyleSheet(); sheet.replaceSync(element.textContent ?? ''); sheets.push({ element, sheet });
      for (const rule of Array.from(sheet.cssRules)) if (rule.type === CSSRule.FONT_FACE_RULE) {
        const family = (rule as CSSFontFaceRule).style.getPropertyValue('font-family');
        const key = wordFontKey(family);
        if (key && documentCssValue(family) && !fontFamilies.has(key)) fontFamilies.set(key, `${className}-font-${fontFamilies.size}`);
      }
    } catch { element.remove(); altered = true; }
  });
  const cleanDeclarations = (style: CSSStyleDeclaration) => {
    for (const name of Array.from(style)) {
      if (!documentCssValue(style.getPropertyValue(name)) || name === 'position' && ['fixed', 'sticky'].includes(style.getPropertyValue(name).trim())) {
        style.removeProperty(name); altered = true;
      } else if (name.startsWith('--') && name.toLowerCase().endsWith('-font')) {
        style.setProperty(name, namespaceWordFonts(style.getPropertyValue(name), fontFamilies), style.getPropertyPriority(name));
      }
    }
    const family = style.getPropertyValue('font-family');
    if (family) style.setProperty('font-family', namespaceWordFonts(family, fontFamilies), style.getPropertyPriority('font-family'));
  };
  const resourceAttributes = new Set(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
  root.querySelectorAll<HTMLElement>('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || ['srcdoc', 'autofocus', 'contenteditable'].includes(attribute.name.toLowerCase())) { element.removeAttribute(attribute.name); altered = true; }
      if (['srcset', 'poster'].includes(attribute.name.toLowerCase()) || resourceAttributes.has(attribute.localName.toLowerCase()) && !documentCssValue(attribute.value)) { element.removeAttribute(attribute.name); altered = true; }
      if (attribute.localName === 'src' || attribute.localName === 'href' && element.localName !== 'a') {
        const image = normalizedDocumentImage(attribute.value);
        if (image === null) { element.removeAttribute(attribute.name); altered = true; }
        else element.setAttribute(attribute.name, image);
      }
      if (attribute.localName === 'font-family') element.setAttribute(attribute.name, namespaceWordFonts(attribute.value, fontFamilies));
    }
    if (element.style) cleanDeclarations(element.style);
  });
  for (const { element, sheet } of sheets) {
    try {
      const safeRules: string[] = [];
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === CSSRule.STYLE_RULE) {
          const style = rule as CSSStyleRule;
          if (!documentCssSelector(style.selectorText, className)) { altered = true; continue; }
          cleanDeclarations(style.style); safeRules.push(style.cssText);
        } else if (rule.type === CSSRule.FONT_FACE_RULE) {
          const font = rule as CSSFontFaceRule;
          cleanDeclarations(font.style); safeRules.push(font.cssText);
        }
        // Print/media/import rules are unnecessary in the browser review surface.
      }
      element.textContent = safeRules.join('\n');
    } catch { element.remove(); altered = true; }
  }
  root.querySelectorAll<HTMLAnchorElement>('a').forEach(link => {
    const destination = documentLink(link.getAttribute('href'));
    link.removeAttribute('href'); link.removeAttribute('target'); link.removeAttribute('download');
    if (destination.kind === 'external') {
      link.href = destination.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
    } else if (destination.kind === 'bookmark') {
      link.href = destination.href; link.dataset.documentBookmark = destination.bookmark;
    } else {
      link.setAttribute('aria-disabled', 'true'); link.title = 'This link type is not supported in the viewer.'; altered = true;
    }
  });
  return altered;
}

/** Limit backing-store memory while retaining the page's CSS size and coordinates. */
export const PDF_RASTER_LIMITS = Object.freeze({ pixels: 8_000_000, edge: 8192 });

export function pdfRasterSize(width: number, height: number, devicePixelRatio: number) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 100_000)) throw new Error('Unsupported PDF page dimensions.');
  const requested = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(devicePixelRatio, 2) : 1;
  const ratio = Math.min(requested, Math.sqrt(PDF_RASTER_LIMITS.pixels / (width * height)), PDF_RASTER_LIMITS.edge / width, PDF_RASTER_LIMITS.edge / height);
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), ratio };
}

/** A missing text layer must not discard an otherwise viewable PDF page. */
export async function renderPdfLayers(renderImage: () => Promise<unknown>, renderText: () => Promise<unknown>, cancelled: () => boolean): Promise<'complete' | 'image-only' | 'cancelled'> {
  await renderImage();
  if (cancelled()) return 'cancelled';
  try { await renderText(); }
  catch { return cancelled() ? 'cancelled' : 'image-only'; }
  return cancelled() ? 'cancelled' : 'complete';
}
