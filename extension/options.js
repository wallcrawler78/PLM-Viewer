import { previewTarget, viewerTarget } from './launch-url.js';

const byId = id => document.getElementById(id);
const settings = await chrome.storage.local.get(['viewerUrl','workspaceId','autoOpenAttachments','launchNotice']);
byId('viewerUrl').value = settings.viewerUrl || '';
byId('workspaceId').value = settings.workspaceId || '';
byId('autoOpenAttachments').checked = settings.autoOpenAttachments === true;
byId('notice').textContent = settings.launchNotice || '';
await chrome.storage.local.remove('launchNotice');
function validSettings(requireWorkspace = false) {
  const value = byId('viewerUrl').value.trim();
  const url = value ? viewerTarget(value, {}) : null;
  const workspaceId = byId('workspaceId').value.trim();
  const autoOpenAttachments = byId('autoOpenAttachments').checked;
  if ((requireWorkspace || autoOpenAttachments) && (!workspaceId || !url)) throw new Error('Enter the hosted viewer URL and Arena workspace ID for live launches. Local Preview needs neither.');
  if (workspaceId.length > 200 || /[\u0000-\u001f\u007f]/.test(workspaceId)) throw new Error('Enter a valid Arena workspace ID.');
  return { viewerUrl:url?.href ?? '', workspaceId, autoOpenAttachments };
}
byId('settings').addEventListener('submit', async event => {
  event.preventDefault();
  try { await chrome.storage.local.set(validSettings()); byId('notice').textContent='Settings saved.'; } catch(error) { byId('notice').textContent=error.message; }
});
byId('launch').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const settings=validSettings(true); await chrome.storage.local.set(settings);
    const itemId=byId('itemId').value.trim();
    if (!itemId) throw new Error('Enter the exact Arena item GUID.');
    const context={mode:'arena',workspaceId:settings.workspaceId,itemId};
    for(const key of ['revision','fileId','edition','sourceHash']) if(byId(key).value.trim()) context[key]=byId(key).value.trim();
    if (context.sourceHash && !/^[a-f0-9]{64}$/.test(context.sourceHash)) throw new Error('Use the exact lowercase SHA-256 source hash.');
    if ((context.edition || context.sourceHash) && (!context.fileId || !context.revision)) throw new Error('An exact file edition needs its file GUID and item revision.');
    const target=viewerTarget(settings.viewerUrl,context);
    await chrome.tabs.create({url:target.href});
  } catch(error) { byId('notice').textContent=error.message; }
});

for (const button of document.querySelectorAll('[data-preview]')) button.addEventListener('click', async () => {
  try {
    const target=previewTarget(chrome.runtime.getURL('viewer.html'),button.dataset.preview);
    await chrome.tabs.create({url:target.href});
  } catch(error) { byId('notice').textContent=error.message; }
});

byId('runtime-checks').addEventListener('click', async () => {
  try {
    const target = new URL(chrome.runtime.getURL('viewer.html'));
    target.search = '?mode=preview&runtimeChecks=true';
    await chrome.tabs.create({ url: target.href });
  } catch { byId('notice').textContent = 'The local runtime check page could not be opened. Reload the extension and try again.'; }
});
