import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('registers the fallback launch action on Arena application hosts', async () => {
  let install;
  const create = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { onInstalled: { addListener(callback) { install = callback; } }, onMessage: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    contextMenus: { removeAll: vi.fn(async () => {}), create, onClicked: { addListener() {} } },
  });
  await import('../extension/background.js');
  await install();
  const menu = create.mock.calls[0][0];
  for (const host of ['app.bom.com', 'app.arenagov.com', 'app.europe.arenaplm.com', 'app.uk.arenaplm.com']) {
    // Exact HTTPS match patterns make the menu visible on each real application.
    expect(menu.documentUrlPatterns, host).toContain('https://' + host + '/*');
  }
  expect(menu.contexts).toContain('link');
});
