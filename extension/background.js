import { arenaContext, previewTarget, viewerTarget } from './launch-url.js';
import { ARENA_APPLICATION_PATTERNS, isArenaApplicationUrl, validateAttachmentMessage } from './attachment-action.js';

const MENU = 'open-assembly-review';
// Keep saved settings, including a user's Claude API key, out of reach of content scripts
// running in Arena pages. Runs on every service-worker start.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  // Application hosts listed by Arena's official service-status page. These only
  // control menu visibility; the launcher still reads explicit source parameters.
  chrome.contextMenus.create({ id: MENU, title: 'Open in Review Studio', contexts: ['page', 'link'], documentUrlPatterns: [...ARENA_APPLICATION_PATTERNS] });
});

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: previewTarget(chrome.runtime.getURL('viewer.html')).href }));

async function showLaunchError(error) {
  await chrome.storage.local.set({ launchNotice: error instanceof Error ? error.message : 'Check the viewer settings and exact source context before opening this item.' });
  await chrome.runtime.openOptionsPage();
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU) return;
  const settings = await chrome.storage.local.get(['viewerUrl', 'workspaceId']);
  try {
    if (!settings.viewerUrl || !settings.workspaceId) throw new Error('Configure the viewer URL and Arena workspace before opening a live item.');
    // The menu is offered only on Arena application pages, and only an Arena application
    // link or page may supply source context. A link to any other site is not a source.
    const source = info.linkUrl || info.pageUrl;
    if (!isArenaApplicationUrl(info.pageUrl) || !isArenaApplicationUrl(source)) throw new Error('Open this from an item or attachment link inside the Arena application.');
    const context = arenaContext(source, settings.workspaceId);
    await chrome.tabs.create({ url: viewerTarget(settings.viewerUrl, context).href });
  } catch (error) {
    await showLaunchError(error);
  }
});

// Arena pages cannot read extension storage. They receive only the launch settings they need.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'review-studio-launch-settings') return false;
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !isArenaApplicationUrl(sender.url) || !isArenaApplicationUrl(sender.tab.url)) { respond({ ok: false }); return false; }
  chrome.storage.local.get(['viewerUrl', 'workspaceId', 'autoOpenAttachments']).then(
    value => respond({ ok: true, viewerUrl: value.viewerUrl ?? '', workspaceId: value.workspaceId ?? '', autoOpenAttachments: value.autoOpenAttachments === true }),
    () => respond({ ok: false }));
  return true;
});

// Live sources keep the current authenticated hosted/BFF boundary. The bundled
// Preview is a separate explicit action; it never receives live source context.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'review-studio-open-attachment') return false;
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !isArenaApplicationUrl(sender.url) || !isArenaApplicationUrl(sender.tab.url)) {
    respond({ ok: false, message: 'This source action is unavailable outside the configured Arena application.' });
    return false;
  }
  void (async () => {
    try {
      const settings = await chrome.storage.local.get(['viewerUrl', 'workspaceId', 'autoOpenAttachments']);
      const context = validateAttachmentMessage(message, settings);
      const target = viewerTarget(settings.viewerUrl, context);
      await chrome.tabs.create({ url: target.href });
      respond({ ok: true });
    } catch (error) {
      // No original URL or content bytes are persisted. The source action has
      // already been cancelled; failure must not silently start a download.
      const message = error instanceof Error ? error.message : 'Review Studio could not open this source.';
      await showLaunchError(error).catch(() => {});
      respond({ ok: false, message });
    }
  })();
  return true;
});
