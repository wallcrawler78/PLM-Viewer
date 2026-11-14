import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAssistantPlan, readAssistantStatus, requestAssistantPlan, validateAssistantPlan } from '../src/playground/assistant';
import { applyCommands, createHistory, createProposal } from '../src/playground/state';

const proposal = () => createProposal({ workspaceId: 'w', snapshotId: 'snap', rootItemId: 'assembly', itemNumber: '100', name: 'Assembly', revision: 'A', sourceMode: 'preview' }, [{ id: 'occ-a', itemId: 'item-a', itemNumber: '100-1', revision: 'A', sourceHash: 'a'.repeat(64), name: 'Bracket', position: [0, 0, 0], color: '#999999' }]);
const json = (data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });
const plan = (p = proposal()) => ({ requestId: 'request-1', proposalId: p.id, proposalVersion: p.version, sourceKey: p.sourceKey, summary: 'Raise bracket by 5 mm.', commands: [{ type: 'transform', nodeId: 'occ-a', position: [0, 0, 5] }], assumptions: [], questions: [], display: {} });
afterEach(() => vi.unstubAllGlobals());

describe('Playground assistant client', () => {
  it('does not contact an API from the packaged Chrome extension', async () => {
    vi.stubGlobal('location', { protocol: 'chrome-extension:' });
    const fetcher = vi.fn();
    expect(await readAssistantStatus({ sourceMode: 'preview', workspaceId: 'w' }, undefined, fetcher)).toMatchObject({ available: false, state: 'extension', liveEcr: false });
    await expect(requestAssistantPlan(proposal(), 'Move this', {}, fetcher)).rejects.toMatchObject({ code: 'UNCONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('handles static hosting as unconfigured without a pretend AI response', async () => {
    const fetcher = vi.fn(async () => new Response('<html>Static viewer</html>', { headers: { 'content-type': 'text/html' } }));
    expect(await readAssistantStatus({ sourceMode: 'preview', workspaceId: 'w' }, undefined, fetcher)).toMatchObject({ available: false, state: 'unconfigured' });
  });
  it('keeps an unconfigured AI status distinct from Arena session revocation', async () => {
    const fetcher = vi.fn(async () => json({ configured: false, available: false, state: 'unconfigured', imagesAllowed: false, liveEcr: false, message: 'AI is not connected.' }));
    expect(await readAssistantStatus({ sourceMode: 'arena', workspaceId: 'w', connectionId: 'verified-connection' }, undefined, fetcher)).toMatchObject({ available: false });
  });
  it('sends only explicit context and binds response to the exact proposal version', async () => {
    const p = proposal(), fetcher = vi.fn(async () => json(plan(p)));
    const result = await requestAssistantPlan(p, 'Raise this bracket', { selectedId: 'occ-a' }, fetcher);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/viewer/v1/playground/propose');
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error' });
    const sent = JSON.parse(options.body as string);
    expect(sent.image).toBeUndefined(); expect(sent.selectedId).toBe('occ-a'); expect(sent.sourceKey).toBe(p.sourceKey);
    expect(sent.baseline[0].position).toEqual([0, 0, 0]);
    expect(JSON.stringify(sent)).not.toContain('stepUrl');
    expect(applyAssistantPlan(createHistory(p), result).present.nodes[0].position).toEqual([0, 0, 5]);
    const later = applyCommands(createHistory(p), [{ type: 'transform', nodeId: 'occ-a', position: [1, 0, 0] }]);
    expect(() => applyAssistantPlan(later, result)).toThrow(/earlier proposal/);
    expect(later.present.nodes[0].position).toEqual([1, 0, 0]);
  });
  it('validates the entire batch atomically and keeps display-only intent out of product history', () => {
    const p = proposal();
    expect(() => validateAssistantPlan({ ...plan(p), commands: [...plan(p).commands, { type: 'eval', code: 'fetch(secret)' }] }, p)).toThrow();
    expect(() => validateAssistantPlan({ ...plan(p), commands: [{ type: 'transform', nodeId: 'unknown', position: [0, 0, 5] }] }, p)).toThrow();
    const display = validateAssistantPlan({ ...plan(p), commands: [], display: { explode: 1, labels: true } }, p);
    const history = createHistory(p);
    expect(applyAssistantPlan(history, display)).toBe(history);
    expect(display.display).toMatchObject({ explode: 1 });
    expect(() => validateAssistantPlan({ ...plan(p), questions: ['Which direction?'] }, p)).toThrow();
  });
  it('ignores hostile upstream error messages and observes cancellation', async () => {
    const fetcher = vi.fn(async () => new Response('token-secret-upstream-body', { status: 502 }));
    await expect(requestAssistantPlan(proposal(), 'Move this', {}, fetcher)).rejects.toThrow('could not complete');
    const controller = new AbortController();
    const pending = requestAssistantPlan(proposal(), 'Move this', { signal: controller.signal }, vi.fn(() => new Promise<Response>(() => {})));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
