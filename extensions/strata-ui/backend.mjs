import {systemStatus} from './system-status.mjs';
import {lanManagement} from './lan-management.mjs';

/** Application-wide presentation has one owner. Native credentials are exposed
 * only through the host's scoped capability; they never enter settings or UI. */
export function activate(api, {collectStatus, manageLan} = {}) {
  const readSettings = () => ({showTelemetry: true, ...api.storage.read()});
  const telemetry = collectStatus ?? systemStatus();
  const lan = manageLan ?? (api.application?.base && api.application?.lanAuth
    ? lanManagement(api.application.base, {auth: api.application.lanAuth}) : null);
  api.route('GET', '/settings', readSettings);
  api.route('POST', '/settings', ({body}) => {
    if (typeof body?.showTelemetry !== 'boolean') throw Error('Укажите, показывать ли показатели компьютера.');
    api.storage.write({...readSettings(), showTelemetry: body.showTelemetry});
    return readSettings();
  });
  api.route('GET', '/system-status', () => readSettings().showTelemetry ? telemetry() : {disabled: true});
  api.route('GET', '/lan', () => lan ? lan.status() : {configured: false});
  api.route('POST', '/lan', ({body}) => {
    if (!lan) throw Error('Управление удалённым доступом недоступно в этой установке.');
    return lan.action(body);
  });
  // No generic command is registered for LAN administration: the gateway can
  // block these two routes without an alternate /command bypass.
}
