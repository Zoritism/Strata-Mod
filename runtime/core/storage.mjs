// Strata Extensions — Zoritism. No third-party dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const fields = [
  ['home', 'Данные приложения', 'Общие настройки, агенты, индексы и прежние чаты до переноса в рабочие папки.'],
  ['models', 'Библиотека моделей', 'Корень с models, packs, MTP и файлами чтения изображений.'],
  ['components', 'Компоненты', 'Установленные движки и обновляемые компоненты.'],
  ['install', 'Конфигурации моделей', 'Рабочие конфигурации Control; сами веса находятся в библиотеке моделей.'],
  ['profiles', 'Профили запуска', 'Сохранённые профили Control.'],
  ['workspace', 'Рабочая папка', 'Корень чатов по умолчанию. В выбранной рабочей папке каждый чат получает каталог с историей, вложениями и данными расширений.'],
  ['webview', 'Профиль интерфейса', 'WebView: настройки окна, Local Storage и кэш. Источник старой истории до нативного импорта 0.2.11; текущие чаты — в выбранных рабочих папках.'],
  ['runtime', 'Состояние движка', 'Процессы, журналы сервера и текущее состояние запуска.'],
  ['tuning', 'Настройки производительности', 'Измерения и результаты подбора параметров.'],
  ['timeskip', 'Time-skip', 'Данные фоновых вычислений.'],
  ['desktop', 'Журналы приложения', 'Журналы оболочки в подпапке logs; последние 10 запусков.'],
  ['cache', 'Кэши библиотек', 'Hugging Face, Torch, CUDA, XDG и загрузочные кэши.'],
  ['temp', 'Временные файлы', 'TEMP, TMP и TMPDIR только для Strata и её дочерних процессов.'],
  ['compat', 'Служебный профиль', 'Перенаправленные HOME, USERPROFILE, AppData, Downloads и резервные пути библиотек.'],
  ['extensionPackages', 'Пакеты расширений', 'Версии внешнего кода расширений.'],
  ['extensionData', 'Данные расширений', 'Отдельные настройки и рабочие данные каждого расширения.'],
].map(([id, label, description]) => ({ id, label, description }));
const ids = new Set(fields.map(f => f.id));
export const digest = data => createHash('sha256').update(data).digest('hex');
export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw e; }
}
/** The install receipt selects the application tree. Do not guess from stale
 * executables left beside a different layout after an upgrade. */
export function applicationDirectory(base, installation = readJSON(path.join(base, 'installation.json'), {})) {
  const appDir = installation.appDir ?? 'app';
  if (!['.', 'app'].includes(appDir)) throw new Error('Неверный каталог приложения в installation.json.');
  return path.resolve(base, appDir);
}
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.readFileSync(tmp, 'utf8') !== bytes) throw new Error('Проверка записи не пройдена.');
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function locked(file, fn) {
  let fd;
  try { fd = fs.openSync(file + '.lock', 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Настройки уже изменяются другим процессом. Повторите позже.'); throw e; }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); return fn(); }
  finally { fs.closeSync(fd); fs.unlinkSync(file + '.lock'); }
}
export function effective(config, base) {
  if (config?.schema !== 1 || typeof config.root !== 'string' || !config.root.trim()) throw new Error('Неверный формат storage.json.');
  if (!config.paths || typeof config.paths !== 'object' || Array.isArray(config.paths)) throw new Error('Неверная карта путей.');
  for (const key of Object.keys(config.paths)) if (!ids.has(key)) throw new Error(`Неизвестная категория: ${key}`);
  const root = path.resolve(base, config.root);
  const result = {};
  for (const { id } of fields) {
    const raw = config.paths[id] ?? id;
    if (typeof raw !== 'string' || !raw.trim() || /[\0\r\n]/.test(raw)) throw new Error(`Пустой или неверный путь: ${id}`);
    result[id] = path.resolve(root, raw);
  }
  return result;
}
export function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export function realLocation(folder) {
  let at = folder; const tail = [];
  while (!fs.existsSync(at)) { const next = path.dirname(at); if (next === at) throw new Error(`Диск недоступен: ${folder}`); tail.unshift(path.basename(at)); at = next; }
  return path.join(fs.realpathSync.native(at), ...tail);
}
export function validate(config, base, { probe = false } = {}) {
  const resolved = effective(config, base), physical = {};
  for (const [id, folder] of Object.entries(resolved)) {
    if (folder === path.parse(folder).root) throw new Error(`${id}: нельзя использовать корень диска.`);
    if (process.platform === 'win32' && (/[<>"|?*]/.test(folder) || /(^|[\\/])(con|prn|aux|nul|com[1-9]|lpt[1-9])([.\\/]|$)/i.test(folder))) throw new Error(`${id}: недопустимое имя папки.`);
    const actual = physical[id] = realLocation(folder);
    if (config.strict !== false && process.platform === 'win32' && /^[cC]:/.test(actual)) throw new Error(`${id}: строгий режим запрещает запись на C:, в том числе через ссылку.`);
    if (fs.existsSync(actual) && !fs.statSync(actual).isDirectory()) throw new Error(`${id}: это файл, а не папка.`);
    if (probe) {
      fs.mkdirSync(folder, { recursive: true });
      const test = path.join(folder, '.strata-write-' + randomUUID());
      try { fs.writeFileSync(test, '', { flag: 'wx' }); } finally { if (fs.existsSync(test)) fs.unlinkSync(test); }
    }
  }
  const entries = Object.entries(physical);
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    if (inside(entries[i][1], entries[j][1]) || inside(entries[j][1], entries[i][1])) {
      // Native installs may keep components or models inside HOME. Accept only
      // the exact inherited pair; moving either still invokes the normal guard.
      const inherited = config.profileMode === 'native' && config.nativePaths?.inherited;
      const unchanged = inherited && [entries[i], entries[j]].every(([id, folder]) =>
        inherited[id] && realLocation(inherited[id]) === folder);
      if (!unchanged) throw new Error(`Папки ${entries[i][0]} и ${entries[j][0]} перекрываются. Выберите отдельные папки.`);
    }
  }
  return resolved;
}
export function defaultConfig(root) { return { schema: 1, revision: 1, strict: true, root, paths: {} }; }
/** Read only the native picker's selected directory. The install snapshot is a
 * fallback, not authority over choices the user made later in the native UI. */
export function nativeModelSnapshot(config, base) {
  const paths = effective(config, base);
  if (config.profileMode !== 'native' || config.nativeModelOverride === true || paths.models !== config.nativePaths?.inherited?.models) return null;
  const file = path.join(paths.home, 'data', 'state.json');
  const state = readJSON(file, {});
  const saved = typeof state.modelsDir === 'string' && state.modelsDir.trim() ? state.modelsDir : null;
  if (saved && !path.isAbsolute(saved)) throw new Error('Штатный каталог моделей должен быть абсолютным путём.');
  return {file, saved, path: saved ? path.resolve(saved) : paths.models};
}
/** Derived settings view; opening the panel never rewrites native settings or
 * the persisted snapshot. stage() distinguishes this view from a real move. */
export function storagePresentation(config, base) {
  const native = nativeModelSnapshot(config, base);
  return native ? {...config, paths: {...config.paths, models: native.path}} : config;
}
/** Keep native identity/settings while applying the configurable category paths.
 * Overlay installation never redirects the user's OS home or AppData. */
export function nativeEnvironment(config, p, baseEnv = process.env) {
  const env = {...baseEnv,
    STRATA_HOME: p.home,
    STRATA_COMPONENTS_DIR: p.components, STRATA_INSTALL_DIR: p.install,
    STRATA_PROFILE_DIR: p.profiles, STRATA_RUNTIME_DIR: p.runtime,
    STRATA_WORKSPACE: p.workspace, STRATA_TUNE_DIR: p.tuning,
    STRATA_TIMESKIP_DIR: p.timeskip, STRATA_DESKTOP_DATA_DIR: p.desktop,
    TEMP: p.temp, TMP: p.temp, TMPDIR: p.temp,
  };
  const native = config.nativePaths ?? {};
  // Upstream distinguishes its default model picker from an environment-fixed
  // directory when choosing the download root. Preserve that distinction until
  // the user explicitly relocates this category through our path settings.
  if (config.nativeModelOverride === true || native.inherited?.models !== p.models) env.STRATA_MODELS_DIR = p.models;
  if (native.settingsFile) env.STRATA_SETTINGS_FILE = native.settingsFile;
  if (native.terminalSettingsFile) env.STRATA_TERMINAL_SETTINGS_FILE = native.terminalSettingsFile;
  if (native.inherited?.webview !== p.webview) env.WEBVIEW2_USER_DATA_FOLDER = p.webview;
  return env;
}
export function environment(p, baseEnv = process.env) {
  return { ...baseEnv,
    STRATA_HOME: p.home, STRATA_MODELS_DIR: path.join(p.models, 'models'),
    STRATA_COMPONENTS_DIR: p.components, STRATA_INSTALL_DIR: p.install,
    STRATA_PROFILE_DIR: p.profiles, STRATA_RUNTIME_DIR: p.runtime,
    STRATA_SETTINGS_FILE: path.join(p.compat, 'app-settings.json'),
    STRATA_TERMINAL_SETTINGS_FILE: path.join(p.compat, 'terminal-settings.json'),
    STRATA_WORKSPACE: p.workspace, STRATA_DOCUMENTS_DIR: path.join(p.compat, 'Documents'),
    STRATA_TUNE_DIR: p.tuning, STRATA_TIMESKIP_DIR: p.timeskip,
    STRATA_DESKTOP_DATA_DIR: p.desktop, WEBVIEW2_USER_DATA_FOLDER: p.webview,
    TEMP: p.temp, TMP: p.temp, TMPDIR: p.temp,
    HOME: p.compat, USERPROFILE: p.compat, HOMEDRIVE: path.parse(p.compat).root.replace(/[\\/]$/, ''), HOMEPATH: p.compat.slice(path.parse(p.compat).root.length - 1),
    APPDATA: path.join(p.compat, 'Roaming'), LOCALAPPDATA: path.join(p.compat, 'Local'),
    XDG_CACHE_HOME: p.cache, XDG_CONFIG_HOME: path.join(p.compat, 'config'), XDG_DATA_HOME: path.join(p.compat, 'data'), XDG_STATE_HOME: path.join(p.compat, 'state'),
    HF_HOME: path.join(p.cache, 'huggingface'), HUGGINGFACE_HUB_CACHE: path.join(p.cache, 'huggingface', 'hub'),
    TORCH_HOME: path.join(p.cache, 'torch'), CUDA_CACHE_PATH: path.join(p.cache, 'cuda'),
    PYTHONPYCACHEPREFIX: path.join(p.cache, 'python'), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    PIP_CACHE_DIR: path.join(p.cache, 'pip'), npm_config_cache: path.join(p.cache, 'npm'),
  };
}
export function inspect(config, base) {
  const p = effective(config, base);
  return fields.map(f => {
    const folder = p[f.id]; let disk = null;
    try { let at = folder; while (!fs.existsSync(at)) at = path.dirname(at); const st = fs.statfsSync(at); disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch {}
    return { ...f, path: folder, exists: fs.existsSync(folder), disk };
  });
}
