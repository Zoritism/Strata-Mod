import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJSON, atomicJSON, validate, effective, inside, realLocation, locked, nativeModelSnapshot } from './storage.mjs';

export function changes(before, after, base) {
  const a = effective(before, base), b = effective(after, base);
  return Object.keys(a).filter(id => a[id].toLowerCase() !== b[id].toLowerCase()).map(id => ({ id, from: a[id], to: b[id] }));
}
export function stage(file, proposed, revision, mode) {
  if (!['copy', 'existing'].includes(mode)) throw new Error('Выберите копирование или существующие данные.');
  return locked(file, () => {
    const before = readJSON(file);
    if (revision !== before.revision) throw new Error('Настройки изменились. Обновите панель и повторите.');
    if (fs.existsSync(file + '.pending')) throw new Error('Уже есть ожидающее изменение. Примените его при запуске или отмените.');
    // The installer records inherited native overlaps. A path-edit request must
    // never be able to grant itself new overlap exceptions or change profiles.
    for (const key of ['profileMode', 'nativePaths', 'nativeModelOverride']) {
      if (JSON.stringify(proposed[key]) !== JSON.stringify(before[key])) throw new Error('Сведения об исходном профиле нельзя менять через настройку папок.');
    }
    const base = path.dirname(file), nativeModelSource = nativeModelSnapshot(before, base);
    const next = { ...proposed, paths: {...proposed.paths}, schema: 1, revision: before.revision + 1 };
    const requestedModel = effective(next, base).models;
    if (nativeModelSource) {
      if (requestedModel === nativeModelSource.path) next.paths.models = before.paths.models;
      else next.nativeModelOverride = true;
    }
    validate(next, path.dirname(file));
    let list = changes(before, next, path.dirname(file));
    const oldPaths = effective(before, path.dirname(file));
    if (nativeModelSource) {
      oldPaths.models = nativeModelSource.path;
      list = list.filter(change => change.id !== 'models');
      if (requestedModel !== nativeModelSource.path) list.push({id: 'models', from: nativeModelSource.path, to: requestedModel});
    }
    for (const c of list) {
      if (inside(realLocation(c.from), realLocation(c.to)) || inside(realLocation(c.to), realLocation(c.from))) throw new Error(`${c.id}: нельзя переносить папку внутрь себя или родительской папки.`);
      if (mode === 'existing' && !fs.existsSync(c.to)) throw new Error(`${c.id}: выбранная существующая папка не найдена.`);
      if (mode === 'copy' && fs.existsSync(c.to) && fs.readdirSync(c.to).length) throw new Error(`${c.id}: папка назначения должна быть пустой. Для готовой копии выберите «Использовать существующие».`);
      // Original native layouts can nest a second category under HOME. Copying
      // that whole parent would silently duplicate/relocate the child category.
      // Child-only relocation remains supported; relocate it first instead.
      if (mode === 'copy') for (const [id, folder] of Object.entries(oldPaths)) {
        if (id !== c.id && inside(realLocation(c.from), realLocation(folder))) throw new Error(`${c.id}: исходная папка содержит категорию ${id}. Сначала перенесите вложенную категорию отдельно; перенос всей папки сейчас скопировал бы и её данные.`);
      }
      // A verified copy retains its source. Do not later sweep those retained
      // native child files into a parent move after the active child has moved.
      if (mode === 'copy') for (const [id, folder] of Object.entries(before.nativePaths?.inherited ?? {})) {
        if (id !== c.id && fs.existsSync(folder) && fs.readdirSync(folder).length && inside(realLocation(c.from), realLocation(folder))) throw new Error(`${c.id}: внутри остались прежние данные категории ${id}. Сначала проверьте и отдельно уберите старую копию; перенос родительской папки скопировал бы её повторно.`);
      }
      for (const [id, folder] of Object.entries(oldPaths)) if (id !== c.id && (inside(realLocation(folder), realLocation(c.to)) || inside(realLocation(c.to), realLocation(folder)))) throw new Error(`${c.id}: новая папка пересекается с прежней папкой ${id}.`);
    }
    const pending = { schema: 1, before, next, mode, changes: list, ...(nativeModelSource ? {nativeModelSource} : {}), created: new Date().toISOString() };
    atomicJSON(file + '.pending', pending);
    return pending;
  });
}
export async function hashFile(file) {
  const h = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) h.update(bytes);
  return h.digest('hex');
}
export async function copyVerified(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Перенос ссылок требует отдельной проверки: ${from}`);
    if (entry.isDirectory()) { await copyVerified(from, to); continue; }
    if (!entry.isFile()) throw new Error(`Неподдерживаемый тип файла: ${from}`);
    if (fs.existsSync(to)) {
      if (fs.statSync(from).size === fs.statSync(to).size && await hashFile(from) === await hashFile(to)) continue;
      throw new Error(`Копия отличается от источника; данные оставлены для проверки: ${to}`);
    }
    const tmp = to + '.strata-copying';
    fs.copyFileSync(from, tmp);
    if (await hashFile(from) !== await hashFile(tmp)) throw new Error(`Ошибка сверки: ${from}`);
    fs.renameSync(tmp, to);
  }
}
// Called before the desktop, host and WebView exist. Originals are never deleted.
export async function applyPending(file) {
  if (!fs.existsSync(file + '.pending')) return null;
  const pending = readJSON(file + '.pending');
  const current = readJSON(file);
  if (JSON.stringify(current) === JSON.stringify(pending.next)) { fs.unlinkSync(file + '.pending'); return pending; }
  if (current.revision !== pending.before.revision) throw new Error('Отложенный перенос относится к другой версии настроек.');
  const checkNativeModel = () => {
    if (!pending.nativeModelSource) return;
    const now = nativeModelSnapshot(current, path.dirname(file));
    if (JSON.stringify(now) !== JSON.stringify(pending.nativeModelSource)) throw new Error('Штатный каталог моделей изменился после подготовки переноса. Отмените отложенный перенос и выберите папки заново.');
  };
  checkNativeModel();
  validate(pending.next, path.dirname(file));
  if (pending.phase !== 'copied') {
    for (const c of pending.changes) {
      if (pending.mode === 'copy' && fs.existsSync(c.from)) await copyVerified(c.from, c.to);
      else fs.mkdirSync(c.to, { recursive: true });
    }
    pending.phase = 'copied';
    atomicJSON(file + '.pending', pending);
  }
  checkNativeModel();
  validate(pending.next, path.dirname(file), { probe: true });
  // Model configs contain absolute paths. Rewrite only exact old path prefixes in copied JSON.
  const p = effective(pending.next, path.dirname(file));
  const backupFile = path.join(path.dirname(file), 'migration-config-backup.json');
  let backup = readJSON(backupFile, null);
  if (backup?.revision !== pending.next.revision) {
    backup = { revision: pending.next.revision, files: [] };
    for (const name of fs.readdirSync(p.install).filter(n => /^strata-.*\.json$/.test(n))) {
      const target = path.join(p.install, name);
      backup.files.push({ target, original: readJSON(target) });
    }
    atomicJSON(backupFile, backup);
  }
  for (const name of fs.readdirSync(p.install).filter(n => /^strata-.*\.json$/.test(n))) {
    const configFile = path.join(p.install, name), value = backup.files.find(f => f.target === configFile)?.original ?? readJSON(configFile);
    // When native categories overlap, the most specific old root owns a path.
    // Otherwise moving HOME and models in one operation maps model files to HOME.
    const specificChanges = pending.changes.toSorted((a, b) => b.from.length - a.from.length);
    const rewrite = v => {
      if (typeof v === 'string') { for (const c of specificChanges) if (v === c.from || v.startsWith(c.from + path.sep) || v.startsWith(c.from + '/')) return c.to + v.slice(c.from.length); return v; }
      if (Array.isArray(v)) return v.map(rewrite);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, rewrite(item)]));
      return v;
    };
    atomicJSON(configFile, rewrite(value));
  }
  atomicJSON(file + '.previous', current);
  // Copying may take minutes. The same native picker choice must still own the
  // source when the pending configuration is committed.
  checkNativeModel();
  atomicJSON(file, pending.next);
  atomicJSON(path.join(path.dirname(file), 'last-migration.json'), { date: new Date().toISOString(), mode: pending.mode, changes: pending.changes, verified: pending.mode === 'copy' ? 'SHA256 each file' : 'user selected existing directories', originalsRetained: true });
  fs.unlinkSync(file + '.pending');
  return pending;
}
