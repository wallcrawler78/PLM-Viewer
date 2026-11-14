import { useEffect, useMemo, useState } from 'react';
import type { DocumentExtraction } from '../document-extraction';
import { compareDocumentText } from './client';
import type { TextComparisonInput, TextComparisonResult } from './types';
import { TextComparisonError } from './validation';

type State = { input: TextComparisonInput; result: TextComparisonResult | null; error: string };

export function useTextComparison(beforeKey: string, afterKey: string, before: DocumentExtraction | null, after: DocumentExtraction | null, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const input = useMemo<TextComparisonInput | null>(() => enabled && before && after
    ? { before: { sourceKey: beforeKey, blocks: before.blocks }, after: { sourceKey: afterKey, blocks: after.blocks } }
    : null, [beforeKey, afterKey, before, after, enabled, attempt]);
  useEffect(() => {
    if (!input) { setState(null); return; }
    const controller = new AbortController();
    // Clearing also releases prior redline strings on retry. Matching by input
    // object below hides obsolete data immediately, before effects are flushed.
    setState({ input, result: null, error: '' });
    void compareDocumentText(input, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setState({ input, result, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ input, result: null, error: error instanceof TextComparisonError ? error.message : 'Local text comparison failed. Retry, or review the source pages.' });
    });
    return () => controller.abort();
  }, [input]);
  const current = input && state?.input === input ? state : null;
  return {
    result: current?.result ?? null,
    error: current?.error ?? '',
    pending: input !== null && (!current || (!current.result && !current.error)),
    retry: () => setAttempt(value => value + 1),
  };
}
