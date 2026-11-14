import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRuntimeReport, initialRuntimeResults, isRuntimeCheckRoute, matchesRuntimeFixtureText, packagedResourceUrl, runRuntimeChecks, runtimeCheckTarget, RuntimeCheckIssue, verifyFixtureHash, withRuntimeDeadline } from '../src/runtime-checks';
import type { RuntimeCheckId, RuntimeCheckResult, RuntimeEnvironment, RuntimeObservation } from '../src/runtime-checks';

const environment: RuntimeEnvironment = { surface: 'hosted-preview', viewerVersion: '0.4.0', extensionVersion: null, browserMajor: '136', packages: { pdf: '5.3.31', word: '0.3.6', cad: '0.0.23', graphics: '0.177.0' } };
const passes = () => Object.fromEntries(['assets', 'step', 'pdf', 'docx', 'graphics'].map(id => [id, vi.fn(async (): Promise<RuntimeObservation> => ({ status: 'passed', code: 'assetsVerified' }))])) as Record<RuntimeCheckId, ReturnType<typeof vi.fn<() => Promise<RuntimeObservation>>>>;

afterEach(() => vi.useRealTimers());

describe('local qualification source boundary', () => {
  it('requires an unambiguous explicit Preview route', () => {
    expect(isRuntimeCheckRoute('?mode=preview&runtimeChecks=true')).toBe(true);
    for (const query of ['', '?runtimeChecks=true', '?mode=arena&runtimeChecks=true', '?mode=preview&mode=arena&runtimeChecks=true', '?mode=preview&runtimeChecks=true&runtimeChecks=false']) expect(isRuntimeCheckRoute(query)).toBe(false);
  });

  it('opens a separate diagnostic context without forwarding Arena identifiers or tokens', () => {
    const target = runtimeCheckTarget('https://viewer.example/review?mode=arena&itemId=private&token=secret#private');
    expect(target).toBe('https://viewer.example/review?mode=preview&runtimeChecks=true');
    expect(runtimeCheckTarget('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/viewer.html?fileId=private')).toBe('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/viewer.html?mode=preview&runtimeChecks=true');
  });

  it('resolves only fixed package paths and compares extension protocol and host', () => {
    const page = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/viewer.html?mode=preview';
    expect(packagedResourceUrl('/fixtures/step/base-B.step', page)).toBe('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/fixtures/step/base-B.step');
    for (const path of ['https://elsewhere.example/fixture', '//elsewhere.example/fixture', '/api/viewer/v1/item', '/fixtures/../../api/private', '/fixtures/%2e%2e/private', '/fixtures/a?token=secret', '/vendor/file#private']) expect(() => packagedResourceUrl(path, page)).toThrow(RuntimeCheckIssue);
  });

  it('verifies actual packaged fixture bytes and rejects a changed byte', async () => {
    const manifest = JSON.parse(await readFile(new URL('../public/fixtures/manifest.json', import.meta.url), 'utf8'));
    for (const [kind, id] of [['step', 'base'], ['pdf', 'atlas-spec-B-pdf'], ['docx', 'atlas-spec-B-docx']] as const) {
      const source = (kind === 'step' ? manifest.parts : manifest.documents).find((entry: { id: string; revision: string }) => entry.id === id && entry.revision === 'B');
      const bytes = new Uint8Array(await readFile(new URL(`../public${source[kind === 'step' ? 'stepUrl' : 'url']}`, import.meta.url)));
      await expect(verifyFixtureHash(bytes.buffer, source.sourceHash, webcrypto.subtle as SubtleCrypto)).resolves.toBeUndefined();
      bytes[0] ^= 1;
      await expect(verifyFixtureHash(bytes.buffer, source.sourceHash, webcrypto.subtle as SubtleCrypto)).rejects.toMatchObject({ code: 'hashMismatch' });
    }
  });

  it('checks actual rendered table content without requiring metadata-only punctuation', () => {
    const prefix = 'ASM-1000 | Revision B | Nominal base envelope';
    // PDF.js inserts spaces; DOCX textContent concatenates adjacent table cells.
    expect(matchesRuntimeFixtureText(`${prefix} 180 x 136 x 8 mm Maximum installed width 140.0 mm`)).toBe(true);
    expect(matchesRuntimeFixtureText(`${prefix}180 x 136 x 8 mmMaximum installed width140.0 mm`)).toBe(true);
    expect(matchesRuntimeFixtureText(`${prefix}: 180 x 136 x 8 mm Maximum installed width: 140.0 mm`)).toBe(true);
    expect(matchesRuntimeFixtureText(`${prefix} 180 x 136 x 8 mm Maximum installed width 130.0 mm`)).toBe(false);
    expect(matchesRuntimeFixtureText('Maximum installed width 140.0 mm')).toBe(false);
  });
});

describe('runtime qualification ownership', () => {
  it('runs checks sequentially and records failure without disclosing raw errors', async () => {
    const operations = passes(), order: string[] = [];
    for (const id of Object.keys(operations) as RuntimeCheckId[]) operations[id].mockImplementation(async () => {
      order.push(id);
      if (id === 'pdf') throw new Error('secret-token at https://customer.example/document');
      return { status: 'passed', code: 'assetsVerified' };
    });
    const updates: RuntimeCheckResult[][] = [];
    const results = await runRuntimeChecks(operations, new AbortController().signal, update => updates.push(update));
    expect(order).toEqual(['assets', 'step', 'pdf', 'docx', 'graphics']);
    expect(results[2]).toMatchObject({ status: 'failed', code: 'failed' });
    expect(results[3].status).toBe('passed');
    expect(updates[0][0].status).toBe('running'); // Previous updates must remain snapshots.
    expect(JSON.stringify(results)).not.toContain('secret-token');
  });

  it('aborts an owned operation when its deadline expires and continues other checks', async () => {
    vi.useFakeTimers();
    const operations = passes(); let childSignal: AbortSignal | undefined;
    operations.step.mockImplementation((signal?: AbortSignal) => { childSignal = signal; return new Promise(() => {}); });
    const task = runRuntimeChecks(operations, new AbortController().signal, () => {}, { step: 20 });
    await vi.advanceTimersByTimeAsync(21);
    const results = await task;
    expect(childSignal?.aborted).toBe(true);
    expect(results[1]).toMatchObject({ status: 'failed', code: 'timedOut' });
    expect(results[2].status).toBe('passed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels active work and never starts later operations', async () => {
    const controller = new AbortController(), operations = passes(); let childSignal: AbortSignal | undefined;
    operations.step.mockImplementation((signal?: AbortSignal) => {
      childSignal = signal; controller.abort(new Error('private cancellation detail'));
      return new Promise(() => {});
    });
    const results = await runRuntimeChecks(operations, controller.signal, () => {});
    expect(childSignal?.aborted).toBe(true);
    expect(results[1]).toMatchObject({ status: 'cancelled', code: 'cancelled' });
    expect(results.slice(2).every(result => result.status === 'cancelled' && result.code === 'notRun')).toBe(true);
    expect(operations.pdf).not.toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toContain('private');
  });

  it('does not start a previously cancelled operation and clears successful deadlines', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(); controller.abort();
    const operation = vi.fn(async () => true);
    await expect(withRuntimeDeadline(operation, controller.signal, 10)).rejects.toBeDefined();
    expect(operation).not.toHaveBeenCalled();
    await expect(withRuntimeDeadline(operation, new AbortController().signal, 10)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('sanitized runtime reports', () => {
  it('copies a closed schema without credentials, source metadata, arbitrary metrics, or raw exceptions', () => {
    const results = initialRuntimeResults().map(result => ({ ...result, status: 'passed' as const, code: 'stepVerified' as const, elapsedMs: 12, metrics: { triangles: 100, sourceText: 'customer-content', sourceHash: 'private-hash', vertices: Infinity }, rawError: 'secret-token' }));
    const untrustedEnvironment = { ...environment, viewerVersion: 'https://private.example?token=secret', extensionVersion: '9.9.9', origin: 'https://private.example', credentials: 'secret-token' };
    const report = createRuntimeReport(untrustedEnvironment, results, '2026-11-13T10:00:00Z', '2026-11-13T10:00:05Z');
    const serialized = JSON.stringify(report);
    expect(report.environment.viewerVersion).toBeNull();
    expect(report.environment.extensionVersion).toBeNull();
    expect(report.checks[0].metrics).toEqual({ triangles: 100 });
    for (const secret of ['secret-token', 'private.example', 'customer-content', 'private-hash', 'rawError']) expect(serialized).not.toContain(secret);
    expect(serialized.length).toBeLessThan(8_000);
    expect(report.scope.some(value => value.includes('does not qualify an installed Chrome extension'))).toBe(true);
  });

  it('distinguishes observed extension execution and incomplete results from a pass', () => {
    const extension = createRuntimeReport({ ...environment, surface: 'chrome-extension', extensionVersion: '0.4.0' }, initialRuntimeResults(), '2026-11-13', '2026-11-13');
    expect(extension.outcome).toBe('attention');
    expect(extension.environment.surface).toBe('chrome-extension');
    expect(extension.environment.extensionVersion).toBe('0.4.0');
    expect(extension.scope.some(value => value.includes('not a complete Chrome release qualification'))).toBe(true);
    const cancelled = createRuntimeReport(environment, initialRuntimeResults().map(result => ({ ...result, status: 'cancelled', code: 'notRun' })), '2026-11-13', '2026-11-13');
    expect(cancelled.outcome).toBe('cancelled');
  });
});
