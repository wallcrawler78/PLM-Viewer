import { boundedDocumentTask, DOCUMENT_PROCESSING_LIMITS } from './document-extraction';

export const WORD_PACKAGE_LIMITS = Object.freeze({ entries: 2_000, expandedBytes: 64 * 1024 * 1024, entryBytes: 16 * 1024 * 1024, xmlBytes: 8 * 1024 * 1024 });
interface ZipEntry { name: string; method: number; compressed: number; expanded: number; checksum: number; start: number; end: number }

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

/** Validate the actual inflated bytes before the Word renderer unzips the file.
 * Header declarations alone are insufficient protection against expansion bombs.
 * ZIP64, encryption and unsupported methods fail explicitly within this release.
 */
export async function validateWordPackage(data: ArrayBuffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (data.byteLength < 22 || data.byteLength > DOCUMENT_PROCESSING_LIMITS.sourceBytes) throw new Error('Unsupported Word package size.');
  const view = new DataView(data), bytes = new Uint8Array(data);
  const invalid = () => new Error('This Word package is incomplete or uses an unsupported ZIP format.');
  let directoryEnd = -1;
  for (let cursor = data.byteLength - 22, lower = Math.max(0, data.byteLength - 65_557); cursor >= lower; cursor--) {
    if (view.getUint32(cursor, true) === 0x06054b50 && cursor + 22 + view.getUint16(cursor + 20, true) === data.byteLength) { directoryEnd = cursor; break; }
  }
  if (directoryEnd < 0) throw invalid();
  const count = view.getUint16(directoryEnd + 10, true), size = view.getUint32(directoryEnd + 12, true), start = view.getUint32(directoryEnd + 16, true);
  if (view.getUint16(directoryEnd + 4, true) || view.getUint16(directoryEnd + 6, true) || view.getUint16(directoryEnd + 8, true) !== count || count === 0xffff || start === 0xffffffff || size === 0xffffffff || start + size !== directoryEnd || !count) throw invalid();
  if (count > WORD_PACKAGE_LIMITS.entries) throw new Error('This Word file has too many embedded resources.');
  const entries: ZipEntry[] = [], names = new Set<string>();
  let cursor = start, total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), checksum = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true), expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true), local = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || flags & 1 || ![0, 8].includes(method) || view.getUint16(cursor + 34, true) || local + 30 > start || local === 0xffffffff || compressed === 0xffffffff || expanded === 0xffffffff) throw invalid();
    let name: string;
    try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); } catch { throw invalid(); }
    if (!name || /[\\\u0000-\u001f]|^\//.test(name) || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) throw invalid();
    names.add(name);
    const limit = /\.(?:xml|rels)$/i.test(name) ? WORD_PACKAGE_LIMITS.xmlBytes : WORD_PACKAGE_LIMITS.entryBytes;
    if (expanded > limit || compressed > DOCUMENT_PROCESSING_LIMITS.sourceBytes || (total += expanded) > WORD_PACKAGE_LIMITS.expandedBytes) throw new Error('This Word file exceeds the expanded-content limit.');
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) throw invalid();
    const localNameLength = view.getUint16(local + 26, true), localExtraLength = view.getUint16(local + 28, true);
    const contentStart = local + 30 + localNameLength + localExtraLength, contentEnd = contentStart + compressed;
    if (contentEnd > start || localNameLength !== nameLength) throw invalid();
    for (let offset = 0; offset < nameLength; offset++) if (bytes[local + 30 + offset] !== bytes[cursor + 46 + offset]) throw invalid();
    if (method === 0 && compressed !== expanded) throw invalid();
    entries.push({ name, method, compressed, expanded, checksum, start: contentStart, end: contentEnd });
    cursor = next;
  }
  if (cursor !== directoryEnd || !names.has('[Content_Types].xml') || !names.has('word/document.xml')) throw invalid();
  const spans = entries.filter(entry => entry.compressed > 0).sort((a, b) => a.start - b.start);
  if (spans.some((entry, index) => index > 0 && entry.start < spans[index - 1].end)) throw invalid();
  const started = Date.now();
  let verifiedTotal = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    let crc = 0xffffffff, length = 0;
    const check = (chunk: Uint8Array) => {
      length += chunk.length; verifiedTotal += chunk.length;
      if (length > entry.expanded || verifiedTotal > WORD_PACKAGE_LIMITS.expandedBytes) throw new Error('This Word file exceeds its declared expanded-content limit.');
      for (const value of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 0xff];
    };
    const compressed = bytes.subarray(entry.start, entry.end);
    if (entry.method === 0) check(compressed);
    else {
      let inflater: DecompressionStream;
      try { inflater = new DecompressionStream('deflate-raw'); }
      catch { throw new Error('This browser cannot safely open compressed Word files. Use a current Chrome version.'); }
      const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(compressed); controller.close(); } });
      const reader = input.pipeThrough(inflater).getReader();
      try {
        while (true) {
          const part = await boundedDocumentTask(reader.read(), signal, DOCUMENT_PROCESSING_LIMITS.openMs - (Date.now() - started));
          if (part.done) break;
          check(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); }
    }
    if (length !== entry.expanded || ((crc ^ 0xffffffff) >>> 0) !== entry.checksum) throw invalid();
  }
}
