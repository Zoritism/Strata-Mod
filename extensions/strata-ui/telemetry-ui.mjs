const valid = value => typeof value === 'number' && Number.isFinite(value);
const percent = value => valid(value) ? Math.max(0, Math.min(100, value)) : null;
const memoryPercent = memory => valid(memory?.used) && valid(memory?.total) && memory.total > 0 ? percent(100 * memory.used / memory.total) : null;
const bytes = memory => memoryPercent(memory) === null ? 'нет данных' : `${(memory.used / 1024 ** 3).toFixed(1)} / ${(memory.total / 1024 ** 3).toFixed(1)} ГиБ`;

/** Project local counters into readable values and accessibility labels.
 * An unavailable counter stays unknown rather than reporting zero load. */
export function telemetryMetrics(snapshot = {}) {
  const host = 'Компьютер Strata' + (snapshot.host ? ' · ' + snapshot.host : '');
  const rows = [
    {id: 'cpu', label: 'CPU', percent: percent(snapshot.cpu), details: host, family: 'processor'},
    {id: 'ram', label: 'RAM', percent: memoryPercent(snapshot.ram), details: host + ' · ' + bytes(snapshot.ram), family: 'memory'},
  ];
  const devices = snapshot.devices ?? [];
  for (const [index, device] of devices.entries()) {
    const suffix = devices.length > 1 ? ' ' + (index + 1) : '';
    rows.push({id: 'gpu-' + index, label: 'GPU' + suffix, percent: percent(device.load), details: host + ' · ' + device.name, family: 'processor'},
      {id: 'vram-' + index, label: 'VRAM' + suffix, percent: memoryPercent(device), details: host + ' · ' + device.name + ' · ' + bytes(device), family: 'memory'});
  }
  if (!devices.length) rows.push({id: 'gpu', label: 'GPU', percent: null, details: host + ' · нет данных драйвера', family: 'processor'},
    {id: 'vram', label: 'VRAM', percent: null, details: host + ' · нет данных драйвера', family: 'memory'});
  return rows.map(row => ({...row, value: row.percent === null ? '—' : Math.round(row.percent) + '%',
    level: row.percent === null ? 'unknown' : row.percent >= 95 ? 'high' : row.percent >= 80 ? 'elevated' : 'normal'}));
}

/** Stable meter nodes preserve selection/focus across polling and native page
 * rerenders. The app slot owns disposal; no timers are attached to cards. */
export function installSystemMeters(api, {observe = true} = {}) {
  const strip = api.el('div', {class: 'sx-system-strip', 'aria-label': 'Показатели компьютера'});
  const nodes = new Map();
  let stopped = false, busy = false, queued = false, enabled = true, lastAt = 0;
  function render(snapshot) {
    const rows = telemetryMetrics(snapshot), live = new Set(rows.map(row => row.id));
    for (const row of rows) {
      let node = nodes.get(row.id);
      if (!node) {
        const label = api.el('span', {class: 'sx-system-label'}), value = api.el('span', {class: 'sx-system-value'});
        const fill = api.el('span', {class: 'sx-system-fill'}), bar = api.el('span', {class: 'sx-system-bar', 'aria-hidden': 'true'}, fill);
        const meter = api.el('div', {class: 'sx-system-meter', role: 'meter', tabIndex: 0, 'aria-valuemin': 0, 'aria-valuemax': 100}, label, value, bar);
        node = {meter, label, value, fill}; nodes.set(row.id, node); strip.append(meter);
      }
      const {meter, label, value, fill} = node;
      if (label.textContent !== row.label) label.textContent = row.label;
      if (value.textContent !== row.value) value.textContent = row.value;
      meter.dataset.level = row.level; meter.dataset.family = row.family;
      meter.title = row.details + (row.percent === null ? ' · нет данных' : ' · ' + row.value);
      meter.setAttribute('aria-label', row.label + ' · ' + row.details);
      meter.setAttribute('aria-valuetext', row.percent === null ? 'Нет данных' : row.value);
      if (row.percent === null) meter.removeAttribute('aria-valuenow'); else meter.setAttribute('aria-valuenow', String(Math.round(row.percent)));
      fill.style.width = (row.percent ?? 0) + '%';
    }
    for (const [id, node] of nodes) if (!live.has(id)) {node.meter.remove(); nodes.delete(id);}
    strip.title = 'Показатели компьютера Strata' + (snapshot.host ? ' · ' + snapshot.host : '');
  }
  async function poll() {
    if (stopped || busy || document.hidden || !strip.isConnected || !enabled) return;
    busy = true;
    try {
      const snapshot = await api.request('/strata-ui/system-status');
      if (!stopped) {
        if (snapshot.disabled) {enabled = false; strip.remove();}
        else if (snapshot.at !== lastAt || !lastAt) {render(snapshot); lastAt = snapshot.at ?? 0;}
      }
    } catch {if (!stopped) render({});} finally {busy = false;}
  }
  function sync() {
    if (stopped) return;
    const header = document.querySelector('.chat-toolbar') ?? document.querySelector('.main__head');
    if (enabled && header) {if (strip.parentNode !== header) {header.append(strip); void poll();}}
    else strip.remove();
  }
  const schedule = () => {if (!queued && !stopped) {queued = true; requestAnimationFrame(() => {queued = false; sync();});}};
  // The full extension shares one native-layout observer with its other panels.
  // Standalone consumers can retain automatic attachment with this default.
  const observer = observe ? new MutationObserver(schedule) : null;
  observer?.observe(document.body, {childList: true, subtree: true});
  const timer = setInterval(poll, 3000), wake = () => {sync(); void poll();};
  const changed = event => {enabled = event.detail?.showTelemetry !== false; wake();};
  document.addEventListener('visibilitychange', wake);
  if (observe) window.addEventListener('hashchange', wake);
  window.addEventListener('strata-ui-settings', changed);
  render({}); sync();
  return {scan: sync, dispose() {
    stopped = true; observer?.disconnect(); clearInterval(timer);
    document.removeEventListener('visibilitychange', wake);
    if (observe) window.removeEventListener('hashchange', wake);
    window.removeEventListener('strata-ui-settings', changed); strip.remove();
  }};
}
