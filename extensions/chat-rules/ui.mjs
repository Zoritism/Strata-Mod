export function activate(api) {
  api.slot('app', () => {
    let scheduled = false, button = null, activeChat = null;
    const headingId = 'sx-chat-rules-heading';
    const dialog = api.el('dialog', { class: 'sx-chat-rules-dialog', 'aria-labelledby': headingId });
    const heading = api.el('h2', { id: headingId }, 'Правила чата');
    const help = api.el('p', {}, 'Эти правила передаются отдельным системным блоком только для выбранного чата, не дописываясь в ваши сообщения; системные инструкции и ваша просьба в текущем сообщении имеют приоритет.');
    const textarea = api.el('textarea', { rows: 12, maxlength: 12000, 'aria-label': 'Постоянные правила этого чата', placeholder: 'Например: генерируй иллюстрации по мере повествования, когда это уместно.' });
    const status = api.el('p', { role: 'status', class: 'sx-chat-rules-status' });
    const cancel = api.el('button', { type: 'button', class: 'st-btn sx-button' }, 'Закрыть');
    const save = api.el('button', { type: 'button', class: 'st-btn st-btn--primary sx-button' }, 'Сохранить');
    const actions = api.el('div', { class: 'sx-row sx-chat-rules-actions' }, cancel, save);
    dialog.append(api.el('div', { class: 'sx-chat-rules-content' }, heading, help, textarea, status, actions));
    document.body.append(dialog);
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });

    async function open(chat) {
      activeChat = chat;
      button.disabled = true;
      textarea.disabled = true;
      save.disabled = true;
      status.textContent = 'Загружаю правила…';
      textarea.value = '';
      dialog.showModal();
      try {
        const saved = await api.request('/chat-rules/rules?chat=' + encodeURIComponent(chat));
        if (!dialog.open || activeChat !== chat) return;
        textarea.value = saved.rules;
        status.textContent = saved.updatedAt ? 'Сохранено: ' + new Date(saved.updatedAt).toLocaleString() : 'Для этого чата правила ещё не заданы.';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        if (button?.isConnected) button.disabled = false;
        textarea.disabled = false;
        save.disabled = false;
      }
    }

    button = api.el('button', { type: 'button', class: 'chat-agents sx-chat-rules-button', title: 'Постоянные правила этого чата', 'aria-label': 'Правила чата', 'data-sx-chat-rules': '' }, api.el('span', { class: 'chat-agents__label' }, 'Правила'));
    const ns='http://www.w3.org/2000/svg', icon=document.createElementNS(ns,'svg'), lines=document.createElementNS(ns,'path');
    for(const [k,v] of Object.entries({width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.6,'aria-hidden':'true'})) icon.setAttribute(k,v);
    lines.setAttribute('d','M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5');icon.append(lines);button.prepend(icon);
    button.addEventListener('click', () => {
      const chat = /^#\/chat\/([a-zA-Z0-9_-]{1,128})/.exec(location.hash)?.[1];
      if (chat) void open(chat);
    });
    save.addEventListener('click', async () => {
      const chat = activeChat;
      if (!chat) return;
      save.disabled = true;
      status.textContent = 'Сохраняю…';
      try {
        const result = await api.request('/chat-rules/rules', { chat, rules: textarea.value });
        if (activeChat === chat) {
          status.textContent = result.rules.trim() ? 'Сохранено. Правила применятся к следующим запросам.' : 'Правила удалены для этого чата.';
          dialog.close();
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });

    function scan() {
      scheduled = false;
      const chat = /^#\/chat\/([a-zA-Z0-9_-]{1,128})/.exec(location.hash)?.[1] ?? null;
      const subagents = document.querySelector('.chat-agents');
      if (!chat || !subagents) {
        button.remove();
        return;
      }
      if (button.parentElement !== subagents.parentElement || button.previousElementSibling !== subagents) subagents.after(button);
    }

    const observer = new MutationObserver(() => {
      if (!scheduled) { scheduled = true; requestAnimationFrame(scan); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', scan);
    scan();
    return () => { observer.disconnect(); window.removeEventListener('hashchange', scan); button.remove(); dialog.close(); dialog.remove(); };
  });
}
