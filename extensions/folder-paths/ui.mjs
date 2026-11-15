export function activate(api) {
  api.settings('folder-paths', 'Папки и пути', async container => {
    const { el, button } = api;
    let state = await api.request('/folder-paths/settings'), inputs = new Map();
    function render(message = '') {
      inputs = new Map(); container.replaceChildren(el('h2', { class: 'h3' }, 'Папки и пути'), el('p', {}, 'Пути применяются при каждом запуске, даже если отключить панель расширения.'), el('p', { class:'sx-muted' }, state.config.profileMode === 'native'
        ? 'Каталог моделей — выбранная в Strata папка с моделями, без добавления подпапки models. Пока вы не перенесёте эту категорию здесь, учитывается выбор штатного интерфейса Strata. Перенос копирует фактическую текущую папку и проверяет, что её выбор не изменился.'
        : 'Нативный каталог GGUF Strata направляется в подпапку models выбранной библиотеки. Packs и вспомогательные файлы используют тот же корень библиотеки. Изменение и перенос каталога выполняются здесь, чтобы настройки Strata и расширения оставались согласованы.'));
      const status = el('p', { role: 'status', class: 'sx-notice', hidden: !message }, message); container.append(status);
      const report = text => { status.textContent = text; status.hidden = false; };
      if (state.pending) {
        container.append(el('section', { class: 'sx-card' }, el('strong', {}, 'Изменения ожидают перезапуска'), el('p', {}, 'Закройте Strata и запустите её тем же ярлыком. Во время копирования больших папок запуск займёт больше времени. Исходные данные останутся на месте.'), el('pre', { class: 'sx-preview' }, state.pending.changes.map(c => c.id + ':\n' + c.from + '\n→ ' + c.to).join('\n\n')), button('Отменить изменения', async () => { try { await api.request('/folder-paths/cancel', {}); state = await api.request('/folder-paths/settings'); render('Отложенные изменения отменены.'); } catch (e) { report(e.message); } })));
        return;
      }
      const root = el('input', { type: 'text', value: state.config.root, 'aria-label': 'Основная папка данных' });
      const strict = el('input', { type: 'checkbox', checked: state.config.strict !== false });
      const browse = input => async () => { try { const choice = await api.request('/folder', {}); if (choice.path) input.value = choice.path; } catch (e) { report(e.message); } };
      container.append(el('section', { class: 'sx-card' }, el('h3', {}, 'Основная папка данных'), el('div', { class: 'sx-row' }, root, button('Обзор…', browse(root))), el('p', { class: 'sx-muted' }, 'Пустое поле категории использует её подпапку в основном корне. Можно указать относительный путь или полный путь на другом диске.'), el('label', {}, strict, ' Строгий режим: не записывать данные Strata на диск C:'), el('p', { class: 'sx-muted' }, 'Если папка недоступна, запуск остановится с ошибкой. Системные журналы Windows и явно выбранные агентом внешние файлы не управляются этой настройкой.')));
      const rows = el('section', { class: 'sx-card' });
      for (const f of state.paths) {
        const input = el('input', { type: 'text', value: state.config.paths[f.id] ?? '', placeholder: f.id, 'aria-label': f.label }); inputs.set(f.id, input);
        rows.append(el('div', { class: 'sx-field' }, el('label', {}, el('strong', {}, f.label)), el('p', { class: 'sx-muted' }, f.description), el('div', { class: 'sx-row' }, input, button('Обзор…', browse(input)), button('Открыть', async () => { try { await api.request('/open-folder', { id: f.id }); } catch (e) { report(e.message); } })), el('small', { class: 'sx-muted sx-path' }, 'Сейчас: ' + f.path + (f.disk ? ' · свободно ' + (f.disk.free / 1073741824).toFixed(1) + ' ГБ' : ''))));
      }
      container.append(rows);
      const mode = el('select', { 'aria-label': 'Способ применения' }, el('option', { value: 'copy' }, 'Скопировать данные в новые пустые папки'), el('option', { value: 'existing' }, 'Использовать существующие папки без копирования'));
      const confirm = el('input', { type: 'checkbox' });
      const preview = el('pre', { class: 'sx-preview', hidden: true });
      const proposed = () => ({ ...state.config, root: root.value.trim(), strict: strict.checked, paths: Object.fromEntries([...inputs].filter(([, input]) => input.value.trim()).map(([key, input]) => [key, input.value.trim()])) });
      container.append(el('section', { class: 'sx-card' }, el('h3', {}, 'Применение'), mode, el('p', { class: 'sx-muted' }, 'Копирование проверяет каждый файл по SHA256. Для моделей понадобится столько же свободного места, сколько занимают переносимые файлы. Использование готовых папок переключает данные: содержимое старых папок не объединяется с новыми.'), el('label', {}, confirm, ' Я проверил новые пути и выбранный способ применения.'), button('Сохранить для следующего запуска', async () => {
        try { if (!confirm.checked) throw new Error('Проверьте пути и отметьте подтверждение.'); await api.request('/folder-paths/settings', { config: proposed(), revision: state.config.revision, mode: mode.value }); state = await api.request('/folder-paths/settings'); render('Сохранено.'); } catch (e) { report(e.message); }
      }), preview));
      container.append(el('p', { class: 'sx-muted sx-path' }, 'Настройки загрузчика: ' + state.file));
      if (state.lastMigration) container.append(el('p', { class: 'sx-muted' }, 'Последнее применение: ' + new Date(state.lastMigration.date).toLocaleString() + '. Предыдущие данные сохранены; их удаление выполняется отдельно.'));
    }
    render();
  });
}
