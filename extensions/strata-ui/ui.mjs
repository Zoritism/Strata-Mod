import {scanRemoteAccess, installPhoneShortcut, mountLan} from './lan-ui.mjs';
import {installFileDisclosures} from './file-disclosures.mjs';
import {installSystemMeters} from './telemetry-ui.mjs';

/** Own the application chrome. Native page
 * rerenders only trigger a cheap scan; expanded panels keep the same DOM node. */
export function activate(api) {
  api.settings('strata-ui', 'Интерфейс Strata', async container => {
    const settings = await api.request('/strata-ui/settings');
    const toggle = api.el('input', {type: 'checkbox', checked: settings.showTelemetry});
    const status = api.el('p', {role: 'status'});
    container.append(api.el('h2', {}, 'Интерфейс Strata'), api.el('label', {}, toggle, ' Показывать загрузку компьютера в верхней панели'), status);
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        const saved = await api.request('/strata-ui/settings', {showTelemetry: toggle.checked});
        window.dispatchEvent(new CustomEvent('strata-ui-settings', {detail: saved}));
        status.textContent = 'Настройка сохранена.';
      } catch (error) {toggle.checked = !toggle.checked; status.textContent = error.message;}
      finally {toggle.disabled = false;}
    });
    const access = api.el('section', {class: 'sx-card sx-remote-access'}); container.append(access); await mountLan(access, api);
  });
  api.slot('app', () => {
    const styles = api.el('link', {rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href}); document.head.append(styles);
    const shortcut = installPhoneShortcut(), disclosure = installFileDisclosures(api), meters = installSystemMeters(api, {observe: false});
    let disposed = false, queued = false;
    const scan = () => {if (!disposed) {scanRemoteAccess(api); disclosure.scan(); meters.scan();}};
    const schedule = () => {if (!queued && !disposed) {queued = true; requestAnimationFrame(() => {queued = false; scan();});}};
    const observer = new MutationObserver(schedule); observer.observe(document.body, {childList: true, subtree: true});
    window.addEventListener('hashchange', schedule); scan();
    return () => {
      disposed = true; observer.disconnect(); window.removeEventListener('hashchange', schedule);
      meters.dispose(); shortcut?.(); disclosure.dispose(); styles.remove();
      document.querySelectorAll('[data-sx-remote-access]').forEach(node => node.remove());
    };
  });
}
