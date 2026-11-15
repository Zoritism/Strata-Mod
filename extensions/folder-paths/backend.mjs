export function activate(api) {
  api.route('GET', '/settings', () => api.core.storage.get());
  api.route('POST', '/settings', ({ body }) => api.core.storage.stage(body.config, body.revision, body.mode));
  api.route('POST', '/cancel', () => { api.core.storage.cancel(); return { ok: true }; });
}
