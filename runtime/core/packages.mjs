import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { atomicJSON, readJSON, locked, inside, digest } from './storage.mjs';

export const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
export function manifest(folder) {
  const value = readJSON(path.join(folder, 'extension.json'));
  if (!idPattern.test(value.id) || !/^\d+\.\d+\.\d+$/.test(value.version) || value.api !== 1) throw new Error('Нужен extension.json с id, version и api: 1.');
  if (!value.name || typeof value.name !== 'string') throw new Error('Укажите название расширения.');
  if (value.dependencies && Object.keys(value.dependencies).length) throw new Error('Автоматическая установка зависимостей не поддерживается. Пакет должен быть самодостаточным.');
  if (!value.backend && !value.ui) throw new Error('В расширении нет точки входа.');
  for (const entry of [value.backend, value.ui].filter(Boolean)) {
    if (typeof entry !== 'string' || !entry.endsWith('.mjs') || !inside(folder, path.resolve(folder, entry)) || !fs.statSync(path.join(folder, entry)).isFile()) throw new Error('Точка входа должна быть файлом .mjs внутри расширения.');
  }
  return value;
}
export function files(folder) {
  const out = []; let bytes = 0;
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error('Пакет не должен содержать ссылки.');
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) throw new Error('Неподдерживаемый файл пакета.');
      const size = fs.statSync(full).size; bytes += size;
      if (size > 10 * 1024 * 1024 || bytes > 50 * 1024 * 1024 || out.length >= 2000) throw new Error('Пакет превышает лимит: 50 МБ, 10 МБ на файл, 2000 файлов.');
      out.push({ file: path.relative(folder, full).replaceAll('\\', '/'), bytes: size, sha256: digest(fs.readFileSync(full)) });
    }
  }
  walk(folder); return out.sort((a, b) => a.file.localeCompare(b.file));
}
export function createPackages({ registryFile, packagesDir, dataDir }) {
  const read = () => readJSON(registryFile, { schema: 1, extensions: {} });
  const folder = record => path.join(packagesDir, record.id, record.version);
  function list() { return Object.values(read().extensions); }
  function install(source) {
    return locked(registryFile, () => {
      source = fs.realpathSync(source);
      const inventory = files(source), info = manifest(source), registry = read();
      const target = path.join(packagesDir, info.id, info.version);
      if (fs.existsSync(target)) throw new Error('Эта версия уже установлена. Для изменённого кода увеличьте version.');
      const stage = path.join(packagesDir, '.staging-' + randomUUID());
      fs.mkdirSync(stage, { recursive: true });
      try {
        fs.cpSync(source, stage, { recursive: true, dereference: false });
        if (JSON.stringify(files(stage)) !== JSON.stringify(inventory)) throw new Error('Исходный пакет изменился во время копирования.');
        manifest(stage);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(stage, target);
        const previous = registry.extensions[info.id];
        registry.extensions[info.id] = { ...info, enabled: previous?.enabled ?? true, previous: previous?.version ?? null, installedAt: new Date().toISOString(), inventory };
        atomicJSON(registryFile, registry);
      } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
      return registry.extensions[info.id];
    });
  }
  function toggle(id, enabled) {
    return locked(registryFile, () => { const registry = read(); if (!registry.extensions[id]) throw new Error('Расширение не установлено.'); registry.extensions[id].enabled = !!enabled; atomicJSON(registryFile, registry); });
  }
  function rollback(id) {
    return locked(registryFile, () => {
      const registry = read(), current = registry.extensions[id];
      if (!current?.previous) throw new Error('Предыдущей версии нет.');
      const dir = path.join(packagesDir, id, current.previous), info = manifest(dir);
      registry.extensions[id] = { ...info, enabled: current.enabled, previous: current.version, installedAt: new Date().toISOString(), inventory: files(dir) };
      atomicJSON(registryFile, registry);
    });
  }
  function remove(id) {
    return locked(registryFile, () => {
      const registry = read(); if (!registry.extensions[id]) throw new Error('Расширение не установлено.');
      // Deactivate registration only. Do not delete a module that this host still executes, nor its user data.
      delete registry.extensions[id]; atomicJSON(registryFile, registry);
    });
  }
  async function load(record) {
    const dir = folder(record);
    manifest(dir);
    return record.backend ? import(pathToFileURL(path.join(dir, record.backend))) : null;
  }
  return { list, install, toggle, rollback, remove, load, folder, dataDir };
}
