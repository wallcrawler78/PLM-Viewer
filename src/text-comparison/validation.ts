import { DOCUMENT_COMPARISON_LIMITS } from '../document-review';
import type { DocumentTextBlock, DocumentTextChange, DocumentTextRun } from '../document-review';
import { TEXT_COMPARISON_LIMITS } from './types';
import type { TextComparisonInput, TextComparisonResult, TextComparisonSource } from './types';

/** Only these authored errors may be shown in the document UI. */
export class TextComparisonError extends Error {
  constructor(message: string) { super(message); this.name = 'TextComparisonError'; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const actual = Object.keys(value);
  return required.every(key => actual.includes(key)) && actual.every(key => required.includes(key) || optional.includes(key));
}
function source(value: unknown): TextComparisonSource {
  if (!record(value) || !keys(value, ['sourceKey', 'blocks']) || typeof value.sourceKey !== 'string' || !value.sourceKey.length || value.sourceKey.length > TEXT_COMPARISON_LIMITS.sourceKey
    || !Array.isArray(value.blocks) || value.blocks.length > TEXT_COMPARISON_LIMITS.blocks) {
    throw new TextComparisonError('The text comparison source is invalid or exceeds the local comparison limit.');
  }
  let characters = 0;
  const ids = new Set<string>();
  const blocks: DocumentTextBlock[] = [];
  for (const block of value.blocks) {
    if (!record(block) || !keys(block, ['id', 'page', 'text']) || typeof block.id !== 'string' || !block.id.length || block.id.length > TEXT_COMPARISON_LIMITS.blockId
      || ids.has(block.id) || typeof block.page !== 'number' || !Number.isSafeInteger(block.page) || block.page < 1 || block.page > TEXT_COMPARISON_LIMITS.pages
      || typeof block.text !== 'string' || block.text.length > TEXT_COMPARISON_LIMITS.characters) {
      throw new TextComparisonError('The extracted text has invalid block identities or exceeds the local comparison limit.');
    }
    characters += block.text.length;
    if (characters > TEXT_COMPARISON_LIMITS.characters) throw new TextComparisonError('The extracted text exceeds the local comparison transfer limit.');
    ids.add(block.id);
    // Snapshot the exact descriptors without retaining arbitrary caller fields.
    blocks.push({ id: block.id, page: block.page, text: block.text });
  }
  return { sourceKey: value.sourceKey, blocks };
}

export function normalizeTextComparisonInput(value: unknown): TextComparisonInput {
  if (!record(value) || !keys(value, ['before', 'after'])) throw new TextComparisonError('Both exact document sources are required for text comparison.');
  return { before: source(value.before), after: source(value.after) };
}

interface PreparedBlock extends DocumentTextBlock { index: number }
/** Mirror only the inexpensive input clipping/normalization, never the alignment. */
function prepared(blocks: DocumentTextBlock[]) {
  const output: PreparedBlock[] = [];
  let remaining = DOCUMENT_COMPARISON_LIMITS.characters, truncated = false;
  for (let index = 0; index < blocks.length; index++) {
    if (output.length >= DOCUMENT_COMPARISON_LIMITS.blocks || remaining <= 0) { truncated = true; break; }
    const block = blocks[index], allowance = Math.min(remaining, DOCUMENT_COMPARISON_LIMITS.charactersPerBlock);
    if (block.text.length > allowance) truncated = true;
    const raw = block.text.slice(0, allowance);
    remaining -= raw.length;
    const text = raw.replace(/\s+/gu, ' ').trim();
    if (text) output.push({ id: block.id, page: block.page, text, index });
  }
  return { output, truncated };
}

function invalidResult(): never { throw new TextComparisonError('The local text comparison result does not match these exact document sources. Retry the comparison.'); }

/** Validate source ownership and complete accounting without re-running the diff. */
export function validateTextComparisonResult(value: unknown, input: TextComparisonInput): TextComparisonResult {
  if (!record(value) || !keys(value, ['beforeKey', 'afterKey', 'changes', 'stats', 'truncated']) || value.beforeKey !== input.before.sourceKey || value.afterKey !== input.after.sourceKey
    || typeof value.truncated !== 'boolean' || !Array.isArray(value.changes) || value.changes.length > TEXT_COMPARISON_LIMITS.changes
    || !record(value.stats) || !keys(value.stats, ['added', 'removed', 'modified', 'unchanged'])) invalidResult();
  const returnedStats = value.stats;
  const before = prepared(input.before.blocks), after = prepared(input.after.blocks);
  if ((before.truncated || after.truncated) && !value.truncated) invalidResult();
  const sources = {
    before: new Map(before.output.map(block => [block.id, block])),
    after: new Map(after.output.map(block => [block.id, block])),
  };
  const used = { before: new Set<string>(), after: new Set<string>() };
  const previousIndex = { before: -1, after: -1 };
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const changes: DocumentTextChange[] = [];
  let totalRuns = 0;
  function block(raw: unknown, side: 'before' | 'after'): PreparedBlock {
    if (!record(raw) || !keys(raw, ['id', 'page', 'text']) || typeof raw.id !== 'string') invalidResult();
    const match = sources[side].get(raw.id);
    if (!match || match.page !== raw.page || match.text !== raw.text || used[side].has(match.id) || match.index <= previousIndex[side]) invalidResult();
    used[side].add(match.id); previousIndex[side] = match.index;
    return match;
  }
  for (const raw of value.changes) {
    if (!record(raw) || !keys(raw, ['id', 'kind', 'runs'], ['before', 'after']) || !['added', 'removed', 'modified'].includes(raw.kind as string)
      || !Array.isArray(raw.runs) || !raw.runs.length || raw.runs.length > TEXT_COMPARISON_LIMITS.runs) invalidResult();
    const kind = raw.kind as DocumentTextChange['kind'];
    if ((kind !== 'added') !== Object.hasOwn(raw, 'before') || (kind !== 'removed') !== Object.hasOwn(raw, 'after')) invalidResult();
    const left = kind !== 'added' ? block(raw.before, 'before') : undefined;
    const right = kind !== 'removed' ? block(raw.after, 'after') : undefined;
    if (raw.id !== `change-${left?.index ?? 'x'}-${right?.index ?? 'x'}`) invalidResult();
    totalRuns += raw.runs.length;
    if (totalRuns > TEXT_COMPARISON_LIMITS.runs) invalidResult();
    const runs: DocumentTextRun[] = [], beforeText: string[] = [], afterText: string[] = [];
    let beforeCharacters = 0, afterCharacters = 0;
    for (const run of raw.runs) {
      if (!record(run) || !keys(run, ['kind', 'text']) || !['equal', 'added', 'removed'].includes(run.kind as string) || typeof run.text !== 'string' || !run.text.length
        || run.text.length > DOCUMENT_COMPARISON_LIMITS.charactersPerBlock || runs.at(-1)?.kind === run.kind) invalidResult();
      const runKind = run.kind as DocumentTextRun['kind'];
      if (runKind !== 'added') { beforeCharacters += run.text.length; beforeText.push(run.text); }
      if (runKind !== 'removed') { afterCharacters += run.text.length; afterText.push(run.text); }
      if (beforeCharacters > (left?.text.length ?? 0) || afterCharacters > (right?.text.length ?? 0)) invalidResult();
      runs.push({ kind: runKind, text: run.text });
    }
    if (beforeText.join('') !== (left?.text ?? '') || afterText.join('') !== (right?.text ?? '')) invalidResult();
    const descriptor = (item: PreparedBlock): DocumentTextBlock => ({ id: item.id, page: item.page, text: item.text });
    changes.push({ id: raw.id as string, kind, ...(left ? { before: descriptor(left) } : {}), ...(right ? { after: descriptor(right) } : {}), runs });
    stats[kind]++;
  }
  // Omitted changes must not masquerade as an empty successful result. Every
  // unreferenced source block must have an exact, ordered unchanged counterpart.
  const unchangedBefore = before.output.filter(block => !used.before.has(block.id));
  const unchangedAfter = after.output.filter(block => !used.after.has(block.id));
  if (unchangedBefore.length !== unchangedAfter.length || unchangedBefore.some((block, index) => block.text !== unchangedAfter[index].text)) invalidResult();
  stats.unchanged = unchangedBefore.length;
  if (Object.entries(stats).some(([key, count]) => returnedStats[key] !== count)) invalidResult();
  return { beforeKey: input.before.sourceKey, afterKey: input.after.sourceKey, changes, stats, truncated: value.truncated };
}
