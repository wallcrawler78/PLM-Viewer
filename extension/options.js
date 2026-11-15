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

// Playground assistant. The key stays in chrome.storage.local, which the service worker
// restricts to extension pages; it is never echoed back into the form.
const ASSISTANT_DEFAULT_MODEL = 'claude-fable-5-2';
const assistantNote = text => { byId('notice').textContent = text; };
async function showAssistant() {
  const stored = await chrome.storage.local.get(['assistantApiKey', 'assistantModel', 'assistantShareImages', 'assistantReviewBeforeApply']);
  const saved = typeof stored.assistantApiKey === 'string' && stored.assistantApiKey.length > 0;
  byId('assistantApiKey').value = '';
  byId('assistantApiKey').placeholder = saved ? `Saved key ending ${stored.assistantApiKey.slice(-4)} — enter a new key to replace it` : 'sk-ant-…';
  byId('assistantModel').value = stored.assistantModel || '';
  byId('assistantShareImages').checked = stored.assistantShareImages === true;
  byId('assistantReviewBeforeApply').checked = stored.assistantReviewBeforeApply === true;
  byId('assistantState').textContent = saved ? 'Key saved' : 'Not connected';
  byId('assistantRemove').disabled = !saved; byId('assistantTest').disabled = !saved;
  return stored;
}
function assistantInput() {
  const apiKey = byId('assistantApiKey').value.trim(), model = byId('assistantModel').value.trim() || ASSISTANT_DEFAULT_MODEL;
  if (apiKey && (apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey))) throw new Error('Enter the API key exactly as issued, without spaces or line breaks.');
  if (!/^claude-[a-z0-9-]{1,80}$/.test(model)) throw new Error('Enter a Claude model ID such as claude-fable-5-2.');
  return { apiKey, model, assistantShareImages: byId('assistantShareImages').checked, assistantReviewBeforeApply: byId('assistantReviewBeforeApply').checked };
}
byId('assistant').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const { apiKey, model, assistantShareImages, assistantReviewBeforeApply } = assistantInput();
    const stored = await chrome.storage.local.get(['assistantApiKey']);
    if (!apiKey && !stored.assistantApiKey) throw new Error('Enter a Claude API key to connect the assistant.');
    await chrome.storage.local.set({ ...(apiKey ? { assistantApiKey: apiKey } : {}), assistantModel: model, assistantShareImages, assistantReviewBeforeApply });
    await showAssistant(); assistantNote('Assistant settings saved. Open the Playground and choose Check connection.');
  } catch (error) { assistantNote(error.message); }
});
byId('assistantRemove').addEventListener('click', async () => {
  await chrome.storage.local.remove(['assistantApiKey']);
  await showAssistant(); assistantNote('The saved API key was removed from this browser. Revoke it in the Anthropic Console if it is no longer needed.');
});
// One fixed read-only request that returns no model output and costs nothing.
byId('assistantTest').addEventListener('click', async () => {
  const button = byId('assistantTest'); button.disabled = true; assistantNote('Checking the saved key…');
  try {
    const stored = await chrome.storage.local.get(['assistantApiKey', 'assistantModel']);
    const model = stored.assistantModel || ASSISTANT_DEFAULT_MODEL;
    if (!stored.assistantApiKey || !/^claude-[a-z0-9-]{1,80}$/.test(model)) throw new Error('Save a Claude API key first.');
    const response = await fetch(`https://api.anthropic.com/v1/models/${model}`, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
      headers: { 'x-api-key': stored.assistantApiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
    void response.body?.cancel().catch(() => {});
    assistantNote(response.ok ? `Connected. This key can use ${model}.`
      : response.status === 401 || response.status === 403 ? 'Anthropic rejected this API key. Check that it was copied completely and is still active.'
      : response.status === 404 ? `This key works, but the model ID ${model} was not found for it. Check the model ID.`
      : response.status === 429 ? 'Anthropic is rate limiting this key. Try again shortly.'
      : `Anthropic returned an unexpected status (${response.status}). Try again later.`);
  } catch (error) { assistantNote(error.name === 'TimeoutError' || error instanceof TypeError ? 'Anthropic could not be reached from this browser. Check your network connection.' : error.message); }
  finally { await showAssistant(); }
});
await showAssistant();
