import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAssistantPlan, readAssistantStatus, requestAssistantPlan, requestEcrDraft, validateAssistantPlan } from '../src/playground/assistant';
import { applyCommands, createHistory, createProposal } from '../src/playground/state';
import { readReviewBeforeApply, writeReviewBeforeApply } from '../src/playground/extension-assistant';

const proposal = () => createProposal({ workspaceId: 'w', snapshotId: 'snap', rootItemId: 'assembly', itemNumber: '100', name: 'Assembly', revision: 'A', sourceMode: 'preview' }, [{ id: 'occ-a', itemId: 'item-a', itemNumber: '100-1', revision: 'A', sourceHash: 'a'.repeat(64), name: 'Bracket', position: [0, 0, 0], color: '#999999' }]);
const json = (data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });
const plan = (p = proposal()) => ({ requestId: 'request-1', proposalId: p.id, proposalVersion: p.version, sourceKey: p.sourceKey, summary: 'Raise bracket by 5 mm.', commands: [{ type: 'transform', nodeId: 'occ-a', position: [0, 0, 5] }], assumptions: [], questions: [], display: {} });
afterEach(() => vi.unstubAllGlobals());

describe('Playground assistant client', () => {
  const extensionPage = (stored: Record<string, unknown>) => {
    vi.stubGlobal('location', { protocol: 'chrome-extension:' });
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({ ...stored })) } } });
  };
  const claude = (text: unknown, init: { status?: number; stop_reason?: string } = {}) => vi.fn(async (..._call: Parameters<typeof fetch>) => new Response(JSON.stringify({ stop_reason: init.stop_reason ?? 'end_turn', content: [{ type: 'text', text: JSON.stringify(text) }] }), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } }));
  const wirePlan = { summary: 'Raise bracket by 5 mm.', commands: [{ type: 'transform', nodeId: 'occ-a', position: [0, 0, 5] }], assumptions: [], questions: [] };

  it('contacts no API from the packaged Chrome extension until the user saves a key', async () => {
    for (const stored of [{}, { assistantApiKey: '' }, { assistantApiKey: 'has space' }, { assistantApiKey: 'sk-ant-test', assistantModel: 'gpt-something' }]) {
      extensionPage(stored);
      const fetcher = vi.fn();
      expect(await readAssistantStatus({ sourceMode: 'preview', workspaceId: 'w' }, undefined, fetcher)).toMatchObject({ available: false, state: 'extension', liveEcr: false });
      await expect(requestAssistantPlan(proposal(), 'Move this', {}, fetcher)).rejects.toMatchObject({ code: 'UNCONFIGURED' });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it('sends an extension request only to the Claude API with the saved key, and never returns the key', async () => {
    extensionPage({ assistantApiKey: 'sk-ant-test-key', assistantModel: 'claude-opus-5-5' });
    const status = await readAssistantStatus({ sourceMode: 'preview', workspaceId: 'w' });
    expect(status).toMatchObject({ available: true, state: 'ready', provider: 'anthropic', model: 'claude-opus-5-5', imagesAllowed: false, liveEcr: false });
    expect(JSON.stringify(status)).not.toContain('sk-ant-test-key');
    const fetcher = claude(wirePlan), current = proposal();
    const result = await requestAssistantPlan(current, 'Raise the bracket 5 mm', {}, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(options!.headers).toMatchObject({ 'x-api-key': 'sk-ant-test-key', 'anthropic-dangerous-direct-browser-access': 'true' });
    const sent = JSON.parse(options!.body as string);
    expect(sent.model).toBe('claude-opus-5-5');
    expect(options!.body).not.toContain('sk-ant-test-key');
    expect(result).toMatchObject({ proposalId: current.id, proposalVersion: current.version, sourceKey: current.sourceKey, summary: wirePlan.summary });
    expect(JSON.stringify(result)).not.toContain('sk-ant-test-key');
    expect(applyAssistantPlan(createHistory(current), result).present.nodes[0].position).toEqual([0, 0, 5]);
  });
  it('reports a rejected key, a refusal and an unsupported plan without changing the proposal', async () => {
    extensionPage({ assistantApiKey: 'sk-ant-test-key' });
    await expect(requestAssistantPlan(proposal(), 'Move', {}, claude(wirePlan, { status: 401 }))).rejects.toMatchObject({ code: 'KEY_REJECTED', message: expect.stringContaining('rejected the saved API key') });
    await expect(requestAssistantPlan(proposal(), 'Move', {}, claude(wirePlan, { stop_reason: 'refusal' }))).rejects.toMatchObject({ code: 'REFUSED' });
    await expect(requestAssistantPlan(proposal(), 'Move', {}, claude({ ...wirePlan, commands: [{ type: 'run', code: 'alert(1)' }] }))).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    await expect(requestAssistantPlan(proposal(), 'Move', {}, claude({ ...wirePlan, commands: [{ type: 'transform', nodeId: 'not-in-scene', position: [0, 0, 5] }] }))).rejects.toMatchObject({ code: 'INVALID_PLAN' });
  });
  it('does not attach an image unless image sharing is turned on in the options', async () => {
    extensionPage({ assistantApiKey: 'sk-ant-test-key' });
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const fetcher = claude(wirePlan);
    await expect(requestAssistantPlan(proposal(), 'Move', { image, imageContext: { kind: 'model', camera: { position: [1, 1, 1], target: [0, 0, 0] } } }, fetcher)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('Image sharing is turned off') });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends earlier turns with a follow-up so it can be understood, bounded and without the key', async () => {
    extensionPage({ assistantApiKey: 'sk-ant-test-key' });
    const fetcher = claude(wirePlan);
    const history = [{ role: 'user' as const, text: 'Raise the bracket 5 mm' }, { role: 'assistant' as const, text: 'Raise bracket by 5 mm.', outcome: 'applied' as const }, ...Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, text: `older turn ${i}` }))];
    await requestAssistantPlan(proposal(), 'A bit more', { history }, fetcher);
    const scene = JSON.parse(JSON.parse(fetcher.mock.calls[0][1]!.body as string).messages[0].content[0].text);
    expect(scene.prompt).toBe('A bit more');
    expect(scene.history).toHaveLength(20);
    expect(scene.history.at(-1)).toEqual({ role: 'user', text: 'older turn 29' });
    await requestAssistantPlan(proposal(), 'First request', {}, fetcher);
    expect(JSON.parse(JSON.parse(fetcher.mock.calls[1][1]!.body as string).messages[0].content[0].text).history).toBeUndefined();
  });
  it('drafts ECR wording from accepted changes, numbered markups and the conversation, as a suggestion only', async () => {
    extensionPage({ assistantApiKey: 'sk-ant-test-key' });
    const moved = applyCommands(createHistory(proposal()), [{ type: 'transform', nodeId: 'occ-a', position: [0, 0, 5] }]).present;
    const draft = { title: 'Raise bracket 100-1 by 5 mm', description: '100-1: raise by 5 mm. Reason not stated.', openQuestions: ['Confirm fastener length.'] };
    const fetcher = claude(draft);
    const result = await requestEcrDraft(moved, { title: 'Working title', history: [{ role: 'user', text: 'Raise it 5 mm to clear the cable' }, { role: 'assistant', text: 'Hide the cover.', outcome: 'dismissed' }] }, fetcher);
    expect(result).toEqual(draft);
    const sent = JSON.parse(fetcher.mock.calls[0][1]!.body as string), material = JSON.parse(sent.messages[0].content[0].text);
    expect(sent.system).toContain('engineering change request');
    expect(material.changes).toEqual([{ component: '100-1 — Bracket', revision: 'A', kind: 'modified', summary: expect.stringContaining('position [0, 0, 0] → [0, 0, 5] mm') }]);
    expect(material.history[1]).toEqual({ role: 'assistant', text: 'Hide the cover.', outcome: 'dismissed' });
    expect(fetcher.mock.calls[0][1]!.body).not.toContain('sk-ant-test-key');
    // No source geometry, hashes or delivery URLs are part of the drafting request.
    expect(Object.keys(material).sort()).toEqual(['assumptions', 'changes', 'context', 'history', 'markups', 'title']);
    await expect(requestEcrDraft(proposal(), { title: 't' }, fetcher)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(requestEcrDraft(moved, { title: 't' }, claude({ title: 'x', description: '', openQuestions: [] }))).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    await expect(requestEcrDraft(moved, { title: 't' }, claude({ ...draft, script: 'alert(1)' }))).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    vi.stubGlobal('location', { protocol: 'https:' });
    await expect(requestEcrDraft(moved, { title: 't' }, fetcher)).rejects.toMatchObject({ code: 'UNCONFIGURED' });
  });
  it('applies suggestions immediately by default and remembers a choice to review first', async () => {
    const stored: Record<string, unknown> = {};
    const storage = { get: async (keys: readonly string[]) => Object.fromEntries(keys.filter(key => key in stored).map(key => [key, stored[key]])), set: async (items: Record<string, unknown>) => { Object.assign(stored, items); } };
    expect(await readReviewBeforeApply(storage)).toBe(false);
    await writeReviewBeforeApply(true, storage);
    expect(stored).toEqual({ assistantReviewBeforeApply: true });
    expect(await readReviewBeforeApply(storage)).toBe(true);
    await writeReviewBeforeApply(false, storage);
    expect(await readReviewBeforeApply(storage)).toBe(false);
    // Anything other than an explicit true means the default: apply immediately.
    stored.assistantReviewBeforeApply = 'yes';
    expect(await readReviewBeforeApply(storage)).toBe(false);
    expect(await readReviewBeforeApply({ get: async () => { throw new Error('unavailable'); } })).toBe(false);
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
