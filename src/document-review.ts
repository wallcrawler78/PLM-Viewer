/** An extracted text unit with a stable identifier in its source document. */
export interface DocumentTextBlock { id: string; page: number; text: string }
export interface DocumentTextRun { kind: 'equal' | 'added' | 'removed'; text: string }
export interface DocumentTextChange {
  id: string;
  kind: 'added' | 'removed' | 'modified';
  before?: DocumentTextBlock;
  after?: DocumentTextBlock;
  runs: DocumentTextRun[];
}
export interface DocumentComparisonResult {
  changes: DocumentTextChange[];
  stats: { added: number; removed: number; modified: number; unchanged: number };
  /** Some input or fine-grained alignment was limited; this is not a complete comparison. */
  truncated: boolean;
}

/** Bounds are per document except the shared alignment and word-comparison budgets. */
export const DOCUMENT_COMPARISON_LIMITS = Object.freeze({
  blocks: 1500,
  scannedBlocks: 6000,
  characters: 500_000,
  charactersPerBlock: 12_000,
  alignmentCells: 262_144,
  alignmentCellsPerGap: 65_536,
  wordCells: 4_000_000,
  wordCellsPerChange: 500_000,
});

interface IndexedBlock extends DocumentTextBlock { index: number; words: string[]; frequencies: Map<string, number> }
interface Budget { alignment: number; words: number; truncated: boolean }
const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
const lexicalWords = (text: string) => text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu) ?? [];
const wordTokens = (text: string) => text.match(/\p{L}[\p{L}\p{N}_]*|\p{N}+(?:[.,]\p{N}+)*|\s+|[^\s]/gu) ?? [];

function prepare(input: DocumentTextBlock[], budget: Budget): IndexedBlock[] {
  const output: IndexedBlock[] = [];
  let available = DOCUMENT_COMPARISON_LIMITS.characters;
  const end = Math.min(input.length, DOCUMENT_COMPARISON_LIMITS.scannedBlocks);
  if (end < input.length) budget.truncated = true;
  for (let index = 0; index < end; index++) {
    if (output.length >= DOCUMENT_COMPARISON_LIMITS.blocks || available <= 0) { budget.truncated = true; break; }
    const source = input[index];
    const allowance = Math.min(available, DOCUMENT_COMPARISON_LIMITS.charactersPerBlock);
    if (source.text.length > allowance) budget.truncated = true;
    // Slice before normalization so a huge whitespace string cannot bypass the work bound.
    const raw = source.text.slice(0, allowance);
    available -= raw.length;
    const text = normalize(raw);
    if (!text) continue;
    const words = lexicalWords(text);
    const frequencies = new Map<string, number>();
    for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    output.push({ id: source.id, page: source.page, text, index, words, frequencies });
  }
  return output;
}

function sourceBlock(block: IndexedBlock): DocumentTextBlock {
  return { id: block.id, page: block.page, text: block.text };
}

/** A conservative similarity gate prevents unrelated adjacent paragraphs becoming a replacement. */
function similarity(before: IndexedBlock, after: IndexedBlock): number {
  if (before.text === after.text) return 1;
  if (!before.words.length || !after.words.length) return 0;
  // Numeric/table cells can change completely while retaining their unit or punctuation.
  const numeric = /^[+−\-]?\d/;
  if (numeric.test(before.text) && numeric.test(after.text)) {
    const shape = (value: string) => value.toLocaleLowerCase('en-US').replace(/[\d.,]+/gu, '#');
    if (shape(before.text) === shape(after.text)) return 0.9;
  }
  let common = 0, substantial = false;
  for (const [word, count] of before.frequencies) {
    const found = Math.min(count, after.frequencies.get(word) ?? 0);
    common += found;
    if (found && /\p{L}/u.test(word) && word.length >= 3) substantial = true;
  }
  const score = 2 * common / (before.words.length + after.words.length);
  return substantial && score >= 0.45 ? score : 0;
}

function pushRun(runs: DocumentTextRun[], kind: DocumentTextRun['kind'], text: string) {
  if (!text) return;
  const previous = runs.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else runs.push({ kind, text });
}

/** Runs reconstruct both normalized source texts, including their numbers and punctuation. */
function compareWords(before: string, after: string, budget: Budget): DocumentTextRun[] {
  const beforeTokens = wordTokens(before), afterTokens = wordTokens(after);
  let prefix = 0, suffix = 0;
  while (prefix < beforeTokens.length && prefix < afterTokens.length && beforeTokens[prefix] === afterTokens[prefix]) prefix++;
  while (suffix < beforeTokens.length - prefix && suffix < afterTokens.length - prefix
    && beforeTokens[beforeTokens.length - suffix - 1] === afterTokens[afterTokens.length - suffix - 1]) suffix++;
  const a = beforeTokens.slice(prefix, beforeTokens.length - suffix), b = afterTokens.slice(prefix, afterTokens.length - suffix);
  const cells = (a.length + 1) * (b.length + 1);
  if (cells > DOCUMENT_COMPARISON_LIMITS.wordCellsPerChange || cells > budget.words) {
    budget.truncated = true;
    const runs: DocumentTextRun[] = [];
    pushRun(runs, 'equal', beforeTokens.slice(0, prefix).join(''));
    pushRun(runs, 'removed', a.join(''));
    pushRun(runs, 'added', b.join(''));
    pushRun(runs, 'equal', suffix ? beforeTokens.slice(-suffix).join('') : '');
    return runs;
  }
  budget.words -= cells;
  const width = b.length + 1;
  const matrix = new Uint16Array(cells);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    matrix[i * width + j] = a[i] === b[j]
      ? matrix[(i + 1) * width + j + 1] + 1
      : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  const runs: DocumentTextRun[] = [];
  pushRun(runs, 'equal', beforeTokens.slice(0, prefix).join(''));
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { pushRun(runs, 'equal', a[i++]); j++; }
    else if (i < a.length && (j >= b.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) pushRun(runs, 'removed', a[i++]);
    else pushRun(runs, 'added', b[j++]);
  }
  pushRun(runs, 'equal', suffix ? beforeTokens.slice(-suffix).join('') : '');
  return runs;
}

/**
 * Compare actual extracted text. This does not infer engineering intent or classify
 * drawing geometry, images, formatting, OCR, or native Word tracked changes.
 *
 * Exact block matches anchor a deterministic LCS, including repeated paragraphs.
 * Within each gap, monotonic similarity alignment pairs plausible edits; unrelated
 * blocks remain removals/additions. Fine-grained edits use a bounded token LCS.
 */
export function compareDocumentBlocks(before: DocumentTextBlock[], after: DocumentTextBlock[]): DocumentComparisonResult {
  const budget: Budget = { alignment: DOCUMENT_COMPARISON_LIMITS.alignmentCells, words: DOCUMENT_COMPARISON_LIMITS.wordCells, truncated: false };
  const a = prepare(before, budget), b = prepare(after, budget);
  const changes: DocumentTextChange[] = [];
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };

  function emit(left?: IndexedBlock, right?: IndexedBlock) {
    const kind = left && right ? 'modified' : left ? 'removed' : 'added';
    stats[kind]++;
    changes.push({
      id: `change-${left?.index ?? 'x'}-${right?.index ?? 'x'}`,
      kind,
      ...(left ? { before: sourceBlock(left) } : {}),
      ...(right ? { after: sourceBlock(right) } : {}),
      runs: left && right ? compareWords(left.text, right.text, budget)
        : [{ kind: left ? 'removed' : 'added', text: (left ?? right)!.text }],
    });
  }

  function compareGap(left: IndexedBlock[], right: IndexedBlock[]) {
    if (!left.length) { right.forEach(block => emit(undefined, block)); return; }
    if (!right.length) { left.forEach(block => emit(block)); return; }
    const cells = (left.length + 1) * (right.length + 1);
    if (cells > DOCUMENT_COMPARISON_LIMITS.alignmentCellsPerGap || cells > budget.alignment) {
      // Every source block remains represented; only replacement pairing is unavailable.
      budget.truncated = true;
      left.forEach(block => emit(block)); right.forEach(block => emit(undefined, block)); return;
    }
    budget.alignment -= cells;
    const width = right.length + 1;
    const scores = new Float32Array(cells);
    const matrix = new Float32Array(cells);
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
      const score = similarity(left[i], right[j]);
      scores[i * width + j] = score;
      matrix[i * width + j] = Math.max(
        score ? score + matrix[(i + 1) * width + j + 1] : 0,
        matrix[(i + 1) * width + j], matrix[i * width + j + 1],
      );
    }
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      const score = i < left.length && j < right.length ? scores[i * width + j] : 0;
      // Float32 accumulation can differ by a few ULPs from a fresh JS addition.
      if (score && Math.abs(matrix[i * width + j] - (score + matrix[(i + 1) * width + j + 1])) < 0.0001) emit(left[i++], right[j++]);
      else if (i < left.length && (j >= right.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) emit(left[i++]);
      else emit(undefined, right[j++]);
    }
  }

  const width = b.length + 1;
  const matrix = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    matrix[i * width + j] = a[i].text === b[j].text
      ? matrix[(i + 1) * width + j + 1] + 1
      : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  let i = 0, j = 0, startA = 0, startB = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) {
      compareGap(a.slice(startA, i), b.slice(startB, j));
      stats.unchanged++; i++; j++; startA = i; startB = j;
    } else if (i < a.length && (j >= b.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) i++;
    else j++;
  }
  compareGap(a.slice(startA), b.slice(startB));
  return { changes, stats, truncated: budget.truncated };
}
