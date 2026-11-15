import { isPlainAttachmentClick, recognizeAttachmentAction } from './attachment-action.js';

let settings = { autoOpenAttachments: false };
// Extension storage is restricted to extension pages, so this page script never reads it.
// The service worker returns only the three launch settings, and they are re-read whenever
// the user comes back to this tab (for example after changing the options).
function refreshSettings() {
  chrome.runtime.sendMessage({ type: 'review-studio-launch-settings' }).then(value => {
    if (value?.ok) settings = { viewerUrl: value.viewerUrl, workspaceId: value.workspaceId, autoOpenAttachments: value.autoOpenAttachments === true };
  }).catch(() => {});
}
refreshSettings();
addEventListener('focus', refreshSettings);
addEventListener('pageshow', refreshSettings);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshSettings(); });

function showFailure(message, originalHref) {
  document.getElementById('review-studio-launch-notice')?.remove();
  const box = document.createElement('div');
  box.id = 'review-studio-launch-notice';
  box.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = `Review Studio: ${message} The original attachment action was paused.`;
  const link = document.createElement('a');
  link.href = originalHref;
  link.textContent = 'Continue with Arena';
  link.dataset.reviewStudioOriginal = 'true';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => box.remove());
  box.append(text, link, close);
  (document.body ?? document.documentElement).append(box);
}

// A normal Enter activation of an anchor generates a click and follows the same
// path. Modifier/middle clicks and incomplete/unknown actions stay with Arena.
document.addEventListener('click', event => {
  if (!isPlainAttachmentClick(event)) return;
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const link = target?.closest('a[href]');
  if (!link || link.dataset.reviewStudioOriginal === 'true' || link.closest('[contenteditable="true"]')) return;
  const action = recognizeAttachmentAction(link.href, settings);
  if (!action) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const originalHref = link.href;
  chrome.runtime.sendMessage(action).then(result => {
    if (!result?.ok) showFailure(result?.message || 'The viewer could not open this attachment.', originalHref);
  }).catch(() => showFailure('The extension connection was interrupted. Reload this Arena page and try again.', originalHref));
}, true);
