import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function loadBackground(stored = {}) {
  let install;
  const listeners = [], create = vi.fn(), setAccessLevel = vi.fn(async () => {}), get = vi.fn(async keys => Object.fromEntries(keys.filter(key => key in stored).map(key => [key, stored[key]])));
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension-id', onInstalled: { addListener(callback) { install = callback; } }, onMessage: { addListener(callback) { listeners.push(callback); } } },
    action: { onClicked: { addListener() {} } },
    contextMenus: { removeAll: vi.fn(async () => {}), create, onClicked: { addListener() {} } },
    storage: { local: { get, setAccessLevel } },
  });
  await import('../extension/background.js');
  const send = (message, sender) => new Promise(resolve => { if (!listeners.some(listener => listener(message, sender, resolve))) resolve(undefined); });
  return { install, create, setAccessLevel, get, send };
}

it('registers the fallback launch action on Arena application hosts', async () => {
  const { install, create } = await loadBackground();
  await install();
  const menu = create.mock.calls[0][0];
  for (const host of ['app.bom.com', 'app.arenagov.com', 'app.europe.arenaplm.com', 'app.uk.arenaplm.com']) {
    // Exact HTTPS match patterns make the menu visible on each real application.
    expect(menu.documentUrlPatterns, host).toContain('https://' + host + '/*');
  }
  expect(menu.contexts).toContain('link');
});

it('keeps saved settings out of content scripts and gives Arena pages only their launch settings', async () => {
  const stored = { viewerUrl: 'https://viewer.example/', workspaceId: 'w-1', autoOpenAttachments: true, assistantApiKey: 'sk-ant-secret', assistantModel: 'claude-fable-5-2', launchNotice: 'private' };
  const { setAccessLevel, get, send } = await loadBackground(stored);
  expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  const arena = { id: 'extension-id', frameId: 0, url: 'https://app.bom.com/items/1', tab: { url: 'https://app.bom.com/items/1' } };
  const reply = await send({ type: 'review-studio-launch-settings' }, arena);
  expect(reply).toEqual({ ok: true, viewerUrl: 'https://viewer.example/', workspaceId: 'w-1', autoOpenAttachments: true });
  expect(JSON.stringify(reply)).not.toContain('sk-ant-secret');
  for (const requested of get.mock.calls.flatMap(call => call[0])) expect(requested.startsWith('assistant'), requested).toBe(false);
  for (const sender of [
    { ...arena, id: 'another-extension' },
    { ...arena, frameId: 3 },
    { ...arena, url: 'https://example.com/', tab: { url: 'https://example.com/' } },
    { id: 'extension-id', frameId: 0, url: 'https://app.bom.com/items/1' },
  ]) expect(await send({ type: 'review-studio-launch-settings' }, sender)).toEqual({ ok: false });
});
