import {installChatStreamRecovery} from './chat-stream.mjs';
installChatStreamRecovery();
import { historyKey, mergeRecovered } from './history-merge.mjs';
// The native branch operation supplies identity only; inheritance belongs to ChatStore.
globalThis.strataExtensionsBranch=source=>({sxBranchSource:source});
const app = document.querySelector('script[data-strata-app]')?.dataset.strataApp;
if (!app || !/^\/(assets\/[^/]+\.js|src\/main\.tsx)$/.test(app)) throw Error('Не найдена точка входа Strata.');
try {
  const state = await fetch('/api/extensions').then(r => { if (!r.ok) throw Error('Не удалось проверить перенос истории.'); return r.json(); });
  const response = await fetch('/api/extensions/history'); if (!response.ok) throw Error('Не удалось прочитать план восстановления истории.');
  const recovery = await response.json();
  const post = async (route, data) => { const r = await fetch('/api/extensions/history/' + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-extension-token': state.token }, body: JSON.stringify(data) }); if (!r.ok) throw Error((await r.json()).error); return r.json(); };
  if (recovery.plan && !recovery.applied) {
    const before = localStorage.getItem(historyKey), current = JSON.parse(before ?? '[]');
    const text = JSON.stringify(mergeRecovered(current, recovery.plan.sessions));
    await post('backup', { id: recovery.plan.id, before });
    for (const photo of recovery.plan.images ?? []) {
      const bytes = Uint8Array.from(atob(photo.data), c => c.charCodeAt(0));
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== photo.sha256 || bytes.length !== photo.bytes) throw Error('Повреждено восстановленное изображение.');
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('strata-photos', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        await new Promise((resolve, reject) => { const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').put(new File([bytes], photo.name, { type: photo.mediaType }), photo.id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
        const saved = await new Promise((resolve, reject) => { const r = db.transaction('photos').objectStore('photos').get(photo.id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await saved.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (actual !== photo.sha256) throw Error('Изображение не сохранилось.');
      } finally { db.close(); }
    }
    localStorage.setItem(historyKey, text);
    if (localStorage.getItem(historyKey) !== text) throw Error('История не сохранилась в профиле окна.');
    await post('applied', { id: recovery.plan.id, value: text });
  }
  // 0.2.11 owns chats in the host file store. Do not keep rewriting its legacy
  // browser import source after recovery has been applied.
  // Refresh the canonical entry URL before import. Native chunks import this URL,
  // so a query suffix would instantiate a second application store.
  const entry = await fetch(app, { cache: 'reload' });
  if (!entry.ok) throw Error('Не удалось обновить интерфейс Strata.');
  await entry.arrayBuffer();
  await import(app);
} catch (e) {
  const panel = document.createElement('div'); panel.setAttribute('role', 'alert'); panel.style.cssText = 'padding:32px;max-width:800px;margin:auto;white-space:pre-wrap';
  panel.textContent = 'Strata Extensions: история оставлена для проверки.\n' + e.message; document.body.append(panel); console.error(e);
}
