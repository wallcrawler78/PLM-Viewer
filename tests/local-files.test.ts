import { afterEach, describe, expect, it, vi } from 'vitest';
import { localFileKind, LOCAL_FILE_LIMIT, openLocalFile, releaseLocalFiles } from '../src/local-files';

afterEach(() => vi.restoreAllMocks());
describe('explicit session-local file selection', () => {
  it('accepts supported suffixes and gives an honest legacy DOC error', () => {
    expect(localFileKind('Part.STP')).toBe('step');
    expect(localFileKind('spec.DOCX')).toBe('docx');
    expect(() => localFileKind('spec.doc')).toThrow('not supported');
    expect(() => localFileKind('source.html')).toThrow('Select a STEP');
  });
  it('binds selected content to a real hash and revokes its session URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:https://viewer.invalid/local');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = new File(['%PDF-1.7\n%%EOF'], 'spec.pdf');
    const opened = await openLocalFile(file, 1);
    expect(opened).toMatchObject({ kind: 'pdf', revision: 'File 1', edition: 'local', size: file.size });
    expect(opened.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(create).toHaveBeenCalledWith(file);
    releaseLocalFiles([opened]); expect(revoke).toHaveBeenCalledWith(opened.url);
  });
  it('rejects mismatched bytes and aborts before making an object URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    await expect(openLocalFile(new File(['<html>'], 'fake.pdf'), 1)).rejects.toThrow('contents');
    const cancelled = new AbortController(); cancelled.abort();
    await expect(openLocalFile(new File(['%PDF-1.7'], 'spec.pdf'), 1, cancelled.signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects oversize files before reading any source bytes', async () => {
    const file = { name: 'large.step', size: LOCAL_FILE_LIMIT + 1, arrayBuffer: vi.fn() } as unknown as File;
    await expect(openLocalFile(file, 1)).rejects.toThrow('32 MiB');
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });
});
