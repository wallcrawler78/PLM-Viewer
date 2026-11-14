export interface TextChange { kind: 'equal' | 'added' | 'removed'; text: string }

/** Bounded line comparison. Never calls an LLM or changes the source document. */
export function compareText(before: string, after: string): TextChange[] {
  const lines = (value: string) => value.replace(/\r/g, '').split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 1500);
  const a = lines(before), b = lines(after);
  const width = b.length + 1;
  const matrix = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    matrix[i * width + j] = a[i] === b[j] ? matrix[(i + 1) * width + j + 1] + 1 : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  const result: TextChange[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: 'equal', text: a[i++] }); j++; }
    else if (j < b.length && (i === a.length || matrix[i * width + j + 1] >= matrix[(i + 1) * width + j])) result.push({ kind: 'added', text: b[j++] });
    else result.push({ kind: 'removed', text: a[i++] });
  }
  return result;
}
