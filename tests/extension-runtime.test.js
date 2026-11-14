import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recognizeAttachmentAction, validateAttachmentMessage, isPlainAttachmentClick } from '../extension/attachment-action.js';
import { previewTarget } from '../extension/launch-url.js';

const extensionId = 'a'.repeat(32);
const settings = { viewerUrl: 'https://viewer.example/?deployment=private&mode=preview&itemId=old', workspaceId: 'workspace', autoOpenAttachments: true };
const exact = { itemId: 'item', fileId: 'file', revision: 'B', edition: '4', sourceHash: 'c'.repeat(64) };
const link = (overrides = {}, path = '/attachment.pdf') => `https://app.bom.com${path}?${new URLSearchParams({ ...exact, ...overrides })}`;

afterEach(() => vi.unstubAllGlobals());

describe('packaged Preview launch', () => {
  it('always opens the local viewer with explicitly synthetic context', () => {
    const base = `chrome-extension://${extensionId}/viewer.html?mode=arena&workspaceId=live&itemId=real#old`;
    const target = previewTarget(base, 'model');
    expect(target.origin).toBe('null'); // Chromium extension origins are opaque to Node's URL implementation.
    expect(target.protocol).toBe('chrome-extension:');
    expect(Object.fromEntries(target.searchParams)).toEqual({ mode: 'preview', fileId: 'step:assembly:B' });
    expect(target.hash).toBe('');
    expect(() => previewTarget('https://viewer.example/viewer.html')).toThrow();
    expect(() => previewTarget(base, 'live')).toThrow();
  });
});

describe('automatic attachment recognition', () => {
  it('recognizes exact PDF/Word/STEP links without forwarding credentials or untrusted keys', () => {
    for (const path of ['/attachment.pdf', '/attachment.DOCX', '/attachment.step', '/attachment.STP']) {
      const action = recognizeAttachmentAction(link({ access_token: 'not-forwarded', connectionId: 'not-forwarded' }, path), settings);
      expect(action?.context).toEqual({ mode: 'arena', workspaceId: 'workspace', ...exact });
      expect(JSON.stringify(action)).not.toContain('not-forwarded');
      expect(validateAttachmentMessage(action, settings)).toEqual(action.context);
    }
  });

  it('accepts an explicit filename or kind on a filename-less route', () => {
    expect(recognizeAttachmentAction(link({ fileName: 'spec.pdf' }, '/opaque'), settings)?.kind).toBe('pdf');
    expect(recognizeAttachmentAction(link({ format: 'stp' }, '/opaque'), settings)?.kind).toBe('step');
  });

  it('leaves unknown, ambiguous, unsupported or unconfigured actions with Arena', () => {
    const cases = [
      link({}, '/opaque'), link({}, '/attachment.doc'),
      link({ edition: '' }), link({ sourceHash: 'bad' }), link({ fileId: '' }),
      link({ workspaceId: 'another-workspace' }), link({ kind: 'step' }),
      link({ view: 'model' }), `${link()}&revision=C`, `${link()}&itemGUID=other`,
      link().replace('app.bom.com', 'app.bom.com.attacker.example'),
      link().replace('https:', 'http:'),
    ];
    for (const href of cases) expect(recognizeAttachmentAction(href, settings), href).toBeNull();
    expect(recognizeAttachmentAction(link(), { ...settings, autoOpenAttachments: false })).toBeNull();
    expect(recognizeAttachmentAction(link(), { ...settings, viewerUrl: '' })).toBeNull();
    expect(recognizeAttachmentAction(link(), { ...settings, viewerUrl: 'https://viewer.example/?token=secret' })).toBeNull();
  });

  it('rechecks stored connection settings and the complete message boundary', () => {
    const action = recognizeAttachmentAction(link(), settings);
    expect(() => validateAttachmentMessage(action, { ...settings, autoOpenAttachments: false })).toThrow('turned off');
    expect(() => validateAttachmentMessage(action, { ...settings, workspaceId: 'changed' })).toThrow('configured Arena connection');
    expect(() => validateAttachmentMessage({ ...action, token: 'unexpected' }, settings)).toThrow('invalid');
    expect(() => validateAttachmentMessage({ ...action, context: { ...action.context, access_token: 'unexpected' } }, settings)).toThrow('invalid');
  });

  it('preserves modifier/middle actions and accepts Enter-generated ordinary clicks', () => {
    const normal = { button: 0, detail: 0, defaultPrevented: false };
    expect(isPlainAttachmentClick(normal)).toBe(true);
    for (const override of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) expect(isPlainAttachmentClick({ ...normal, ...override })).toBe(false);
  });
});

describe('extension background boundary', () => {
  beforeEach(() => vi.resetModules());

  async function background(connection = settings) {
    const listeners = {};
    const chrome = {
      runtime: {
        id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`,
        onInstalled: { addListener(callback) { listeners.install = callback; } },
        onMessage: { addListener(callback) { listeners.message = callback; } },
        openOptionsPage: vi.fn(async () => {}),
      },
      action: { onClicked: { addListener(callback) { listeners.action = callback; } } },
      contextMenus: { removeAll: vi.fn(async () => {}), create: vi.fn(), onClicked: { addListener(callback) { listeners.menu = callback; } } },
      tabs: { create: vi.fn(async () => ({ id: 42 })) },
      storage: { local: { get: vi.fn(async () => ({ ...connection })), set: vi.fn(async () => {}), setAccessLevel: vi.fn(async () => {}) } },
    };
    vi.stubGlobal('chrome', chrome);
    await import('../extension/background.js');
    return { chrome, listeners };
  }

  it('opens local Preview from the toolbar even when live settings are absent', async () => {
    const { chrome, listeners } = await background({});
    await listeners.action();
    expect(chrome.tabs.create.mock.calls[0][0].url).toBe(`chrome-extension://${extensionId}/viewer.html?mode=preview&fileId=atlas-spec-B-pdf`);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('opens verified attachment context in the configured hosted live viewer', async () => {
    const { chrome, listeners } = await background();
    const action = recognizeAttachmentAction(link(), settings);
    const response = new Promise(resolve => {
      expect(listeners.message(action, { id: extensionId, frameId: 0, url: 'https://app.bom.com/item', tab: { url: 'https://app.bom.com/item' } }, resolve)).toBe(true);
    });
    expect(await response).toEqual({ ok: true });
    const target = new URL(chrome.tabs.create.mock.calls[0][0].url);
    expect(target.origin).toBe('https://viewer.example');
    expect(Object.fromEntries(target.searchParams)).toEqual({ deployment: 'private', mode: 'arena', workspaceId: 'workspace', ...exact });
  });

  it('rejects messages from other origins or stale settings without launching Preview', async () => {
    const { chrome, listeners } = await background({ ...settings, autoOpenAttachments: false });
    const action = recognizeAttachmentAction(link(), settings);
    const outsider = vi.fn();
    expect(listeners.message(action, { id: extensionId, frameId: 0, url: 'https://other.example/', tab: { url: 'https://other.example/' } }, outsider)).toBe(false);
    expect(outsider.mock.calls[0][0].ok).toBe(false);
    const response = await new Promise(resolve => listeners.message(action, { id: extensionId, frameId: 0, url: 'https://app.bom.com/item', tab: { url: 'https://app.bom.com/item' } }, resolve));
    expect(response.ok).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });
});
