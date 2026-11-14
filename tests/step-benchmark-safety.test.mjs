import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReportWriter, readBoundedStepSource } from '../scripts/benchmark-step.mjs';

const directories = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'step-benchmark-safety-'));
  directories.push(directory);
  const source = join(directory, 'source.step');
  await writeFile(source, 'ISO-10303-21;\noriginal source');
  return { directory, source };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('STEP benchmark source and output isolation', () => {
  it('rejects an output symlink without changing its source target', async () => {
    const { directory, source } = await fixture();
    const output = join(directory, 'report.json');
    await symlink(source, output);
    await expect(createReportWriter(output, [source])).rejects.toThrow('symbolic link');
    expect(await readFile(source, 'utf8')).toContain('original source');
  });

  it('rejects an existing hard link to the input', async () => {
    const { directory, source } = await fixture();
    const output = join(directory, 'report.json');
    await link(source, output);
    await expect(createReportWriter(output, [source])).rejects.toThrow('aliases an input');
    expect(await readFile(source, 'utf8')).toContain('original source');
  });

  it('rejects canonical source aliases reached through linked directories', async () => {
    const { directory } = await fixture();
    const actual = join(directory, 'actual.json');
    const source = join(directory, 'input.step');
    const linkedDirectory = join(directory, 'linked');
    await writeFile(actual, 'original JSON-named STEP bytes');
    await symlink(actual, source);
    await symlink(directory, linkedDirectory, 'dir');
    await expect(createReportWriter(join(linkedDirectory, 'actual.json'), [source])).rejects.toThrow('aliases an input');
    expect(await readFile(actual, 'utf8')).toBe('original JSON-named STEP bytes');
  });

  it('ignores a predictable checkpoint symlink and atomically replaces its own report', async () => {
    const { directory, source } = await fixture();
    const output = join(directory, 'report.json');
    await symlink(source, `${output}.tmp`);
    const writer = await createReportWriter(output, [source]);
    await writer.write({ run: 1 });
    await writer.write({ run: 2 });
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ run: 2 });
    expect(await readFile(source, 'utf8')).toContain('original source');
    expect((await readdir(directory)).sort()).toEqual(['report.json', 'report.json.tmp', 'source.step']);
  });

  it('rechecks output aliases introduced after writer creation', async () => {
    const { directory, source } = await fixture();
    const output = join(directory, 'report.json');
    const writer = await createReportWriter(output, [source]);
    await link(source, output);
    await expect(writer.write({ run: 1 })).rejects.toThrow('aliases an input');
    expect(await readFile(source, 'utf8')).toContain('original source');
  });

  it('returns the complete stable source within its byte bound', async () => {
    const { source } = await fixture();
    const expected = await readFile(source);
    expect(await readBoundedStepSource(source, 1024, expected.byteLength)).toEqual(expected);
  });

  it('refuses oversized or stat-changed sources before allocating their contents', async () => {
    const { source } = await fixture();
    await expect(readBoundedStepSource(source, 8)).rejects.toThrow('local import limit');
    await expect(readBoundedStepSource(source, 1024, 1)).rejects.toThrow('changed before reading');
  });
});
