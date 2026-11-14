import type { DocumentFile } from './components/Documents';

export const LOCAL_FILE_LIMIT = 32 * 1024 * 1024;
export const LOCAL_SESSION_LIMIT = 128 * 1024 * 1024;
export const LOCAL_FILE_COUNT = 8;
export interface LocalReviewFile extends DocumentFile { kind: 'step' | 'pdf' | 'docx'; sourceHash: string; size: number; }

export function localFileKind(name: string): LocalReviewFile['kind'] {
  const extension = name.split('.').at(-1)?.toLowerCase();
  if (extension === 'step' || extension === 'stp') return 'step';
  if (extension === 'pdf' || extension === 'docx') return extension;
  if (extension === 'doc') throw new Error('Legacy .doc is not supported yet. Select a PDF or DOCX rendition.');
  throw new Error('Select a STEP, STP, PDF, or DOCX file.');
}

/** Explicit user-selected files only. URLs are session-local capabilities, never provider metadata. */
export async function openLocalFile(file: File, ordinal: number, signal?: AbortSignal): Promise<LocalReviewFile> {
  signal?.throwIfAborted();
  const kind = localFileKind(file.name);
  if (!file.size || file.size > LOCAL_FILE_LIMIT) throw new Error(`${file.name}: select a nonempty file no larger than 32 MiB.`);
  const data = await file.arrayBuffer();
  signal?.throwIfAborted();
  const prefix = new Uint8Array(data, 0, Math.min(data.byteLength, 4096));
  const text = new TextDecoder('ascii').decode(prefix);
  if (kind === 'step' && !/^\s*ISO-10303-21\s*;/i.test(text) || kind === 'pdf' && !text.startsWith('%PDF-') || kind === 'docx' && !(prefix[0] === 0x50 && prefix[1] === 0x4b && prefix[2] === 0x03 && prefix[3] === 0x04)) throw new Error(`${file.name}: the file contents do not match its format.`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  signal?.throwIfAborted();
  const sourceHash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  return { id: crypto.randomUUID(), itemId: 'local-review-session', revision: `File ${ordinal}`, edition: 'local', kind, name: file.name, url: URL.createObjectURL(file), sourceHash, size: file.size };
}

export function releaseLocalFiles(files: readonly LocalReviewFile[]): void {
  files.forEach(file => URL.revokeObjectURL(file.url));
}
