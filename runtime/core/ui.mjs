import {installChatManagement} from './chat-management-ui.mjs';
function startupError(error){
  const panel=document.getElementById('sx-startup-error')??document.createElement('div');
  panel.id='sx-startup-error';panel.setAttribute('role','alert');
  panel.style.cssText='position:fixed;inset:0 0 auto;z-index:2147483647;padding:14px;background:var(--st-surface,#fff);color:var(--st-ink,#222);border-bottom:2px solid #b33';
  panel.textContent='Strata-Mod: не удалось загрузить интерфейс расширений. Перезапустите программу. Сведения: '+String(error?.message??error);
  document.body.append(panel);
}
let dismissDialog;
try{({dismissDialog}=await import('./surfaces.mjs'));}
catch(error){startupError(error);throw error;}
// External UI host. The only upstream HTML change is a module script URL.
const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/extensions/core/ui.css'; document.head.append(link);
let session, notice = '', busy = false;
const panels = [], slots = [], mounted = new Map();

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v); else if (k === 'class') node.className = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  if(tag==='dialog')node.addEventListener('click',event=>dismissDialog(node,event));
  return node;
}
async function api(url, data) {
  const response = await fetch('/api/extensions' + url, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'content-type': 'application/json', 'x-strata-extension-token': session.token }, body: data === undefined ? undefined : JSON.stringify(data) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Не удалось выполнить действие.'); return value;
}
const button = (text, fn) => el('button', { type: 'button', class: 'st-btn sx-button', onclick: fn }, text);
async function act(fn) { if (busy) return; busy = true; try { await fn(); session = await api(''); } catch (e) { notice = e.message; } finally { busy = false; renderManagers(); } }
let search = '', openManager = false;
function manager(container) {
  container.replaceChildren(el('h2', { class: 'h3' }, 'Расширения'), el('input', { type: 'search', class: 'st-input', placeholder: 'Поиск расширений', 'aria-label':'Поиск расширений', value: search, oninput: e => { search = e.target.value; filterRows(); } }));
  if (notice) container.append(el('p', { role: 'status', class: 'sx-notice' }, notice));
  if (session.restartRequired) container.append(el('p', { role: 'status', class: 'sx-notice' }, 'Изменения сохранены. Закройте Strata и снова запустите её тем же ярлыком.'));
  function filterRows() {
    for (const row of container.querySelectorAll('[data-extension-name]')) row.hidden = !row.dataset.extensionName.includes(search.trim().toLowerCase());
  }
  for (const r of session.extensions) {
    const toggle = el('input', { type: 'checkbox', checked: r.enabled, onchange: () => act(async () => { await api('/toggle', { id: r.id, enabled: toggle.checked }); notice = 'Состояние сохранено; применяется после перезапуска.'; }) });
    const row = el('section', { class: 'sx-card' }, el('div', { class: 'sx-row' }, el('strong', {}, r.name + ' · ' + r.version), el('label', {}, toggle, ' Включено')), el('p', {}, r.description ?? ''), el('small', { class: 'sx-muted' }, r.id + ' · ' + (r.author ?? '') + ' · ' + (r.active ? 'Работает' : 'Не загружено')));
    if (r.error) row.append(el('p', { role: 'alert' }, r.error));
    const controls = el('div', { class: 'sx-row' });
    if (r.previous) controls.append(button('Откатить версию', () => act(async () => { await api('/rollback', { id: r.id }); notice = 'Версия изменена; перезапустите приложение.'; })));
    controls.append(button('Убрать из списка', () => act(async () => { await api('/remove', { id: r.id }); notice = 'Регистрация удалена. Файлы и настройки сохранены в папках расширений.'; })));
    const panel = panels.find(p => p.id === r.id);
    const enter = button('Настройки', async () => {
      const body = el('div', {class:'stack stack--lg'});
      container.replaceChildren(button('‹ Все расширения', () => manager(container)), body);
      if (panel) {
        try { await panel.mount(body, hostApi); } catch (error) { body.append(error.message); }
      } else body.append(el('h2', {}, r.name), el('p', {}, r.id === 'chat-rules' ? 'Откройте «Правила» в заголовке чата.' : 'У расширения нет общей формы настроек.'));
    });
    row.dataset.extensionName = [r.name,r.id,r.description].join(' ').toLowerCase();
    row.append(el('div',{class:'sx-row'}, enter, el('details', {}, el('summary', {}, 'Управление'), controls))); container.append(row);
  }
  filterRows();
  const source = el('input', { type: 'text', placeholder: 'Папка с extension.json', 'aria-label': 'Папка расширения' });
  const trust = el('input', { type: 'checkbox' });
  container.append(el('section', { class: 'sx-card' }, el('h3', {}, 'Установить или обновить'), el('div', { class: 'sx-row' }, source, button('Обзор…', async () => { try { const picked = await api('/folder', {}); if (picked.path) source.value = picked.path; } catch (e) { notice = e.message; renderManagers(); } })), el('label', {}, trust, ' Я доверяю этому расширению. Его код может обращаться к файлам и сети.'), button('Установить', () => act(async () => { await api('/install', { path: source.value, trusted: trust.checked }); notice = 'Пакет установлен. Перезапустите Strata.'; }))));
  container.append(el('p', { class: 'sx-muted sx-path' }, 'Код: ' + session.locations.packages), el('p', { class: 'sx-muted sx-path' }, 'Данные: ' + session.locations.data));
}
function renderManagers() { document.querySelectorAll('[data-sx-manager]').forEach(manager); }
const hostApi = Object.freeze({ version: 1, el, button, request: api,
  settings: (id, title, mount) => panels.push({ id, title, mount }),
  slot: (name, mount) => { if (!['chat', 'app'].includes(name)) throw new Error('Unknown UI slot'); slots.push({ name, mount }); },
  command: (id, args) => api('/command', { id, args }),
});
function attachSettings(layout) {
  const nav = layout.querySelector('.settingsindex'), pane = layout.querySelector('.settings-pane'); if (!nav || !pane || nav.querySelector('[data-sx-tab]')) return;
  const definitions = [{ id: 'extensions', title: 'Расширения', mount: container => { container.dataset.sxManager = ''; manager(container); } }];
  const restore = event => { if (!event.target.closest('[data-sx-tab]')) { layout.classList.remove('sx-settings-active'); nav.querySelectorAll('[data-sx-tab]').forEach(n => n.setAttribute('aria-selected', 'false')); pane.querySelectorAll('.sx-panel').forEach(n => n.hidden = true); } };
  nav.addEventListener('click', restore);
  for (const panel of definitions) {
    const node = el('div', { id: 'sx-panel-' + panel.id, role: 'tabpanel', class: 'sx-panel stack stack--lg settings-body', hidden: true, 'aria-labelledby': 'sx-tab-' + panel.id });
    const tab = el('button', { id: 'sx-tab-' + panel.id, role: 'tab', type: 'button', class: 'settingsindex__item', 'data-sx-tab': panel.id, 'aria-controls': node.id, 'aria-selected': 'false', onclick: () => {
      layout.classList.add('sx-settings-active');
      nav.querySelectorAll('[role=tab]').forEach(n => n.setAttribute('aria-selected', String(n === tab)));
      pane.querySelectorAll('.sx-panel').forEach(n => n.hidden = n !== node);
      pane.scrollTop = 0;
      if (!node.dataset.sxMounted) { node.dataset.sxMounted = '1'; Promise.resolve(panel.mount(node, hostApi)).catch(e => node.append(el('p', { role: 'alert' }, e.message))); }
    } }, el('span', {class:'sx-glyph','aria-hidden':'true'}, '⊞'), panel.title);
    // Upstream's keyboard tab handler knows only its own panels.
    tab.addEventListener('keydown', e => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) { e.stopPropagation(); e.preventDefault(); const tabs = [...nav.querySelectorAll('[role=tab]')], i = tabs.indexOf(tab); const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : tabs[(i + (e.key === 'ArrowUp' ? -1 : 1) + tabs.length) % tabs.length]; next.focus(); next.click(); } });
    nav.append(tab); pane.append(node);
  }
}
function scan() {
  chatManagementUi.scan();
  for (const skills of document.querySelectorAll('a.navitem[href="#/skills"]')) {
    if (skills.nextElementSibling?.dataset.sxExtensions !== undefined) continue;
    skills.after(el('a',{class:'navitem',href:'#/settings',title:'Расширения','aria-label':'Расширения','data-sx-extensions':'',onclick:event => {event.preventDefault(); const [page,query]=location.hash.split('?');const parameters=new URLSearchParams(query);parameters.set('settings','1');openManager=true;location.hash=(page || '#/chat')+'?'+parameters;requestAnimationFrame(scan);}},el('span',{class:'sx-glyph'},'⊞'),el('span',{class:'navitem__text'},'Расширения')));
  }
  document.querySelectorAll('.settings-layout').forEach(attachSettings);
  const tab = document.querySelector('[data-sx-tab="extensions"]');
  if (openManager && tab) { openManager=false; tab.click(); const panel=document.querySelector('[data-sx-manager]'); if(panel) manager(panel); }
  for (const [node, cleanup] of mounted) if (!node.isConnected) { cleanup?.(); mounted.delete(node); }
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i], parent = document.querySelector(slot.name === 'chat' ? '.composer__inner' : '#root');
    if (!parent || parent.querySelector(`[data-sx-slot="${i}"]`)) continue;
    const node = el('div', { 'data-sx-slot': i }); parent.append(node);
    try { mounted.set(node, slot.mount(node, hostApi)); } catch (e) { node.textContent = e.message; }
  }
}
const chatManagementUi=installChatManagement(hostApi);

try {
  session = await api('');
  for (const record of session.active.filter(r => r.ui)) {
    try { const module = await import(`/extensions/${record.id}/${record.ui}`); await module.activate(hostApi); }
    catch (e) { notice = `${record.id}: ${e.message}`; }
  }
  scan(); let scheduled = false;
  new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; scan(); }); } }).observe(document.body, { childList: true, subtree: true });
} catch (e) {
  console.error('[Strata Extensions]', e);
  startupError(e);
  const notice = el('div', { role: 'alert', class: 'sx-notice' }, 'Strata Extensions не загрузилась: ' + e.message);
  Object.assign(notice.style, { position: 'fixed', bottom: '20px', left: '20px', right: '20px', zIndex: '9999' });
  document.body.append(notice);
}
