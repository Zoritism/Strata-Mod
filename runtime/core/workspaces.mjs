import path from 'node:path';
import { readJSON, atomicJSON } from './storage.mjs';
// Aliases identify old chats; they are never destinations for new writes.
export function maintainWorkspaces(paths, aliases = []) {
  const file = path.join(paths.home, 'data', 'workspaces.json'), rows = readJSON(file, []);
  if (!Array.isArray(rows)) throw Error('Неверный список рабочих папок. Исходник сохранён.');
  const old = rows.find(r => r.id === 'root');
  const root = { ...old, id: 'root', name: old?.name ?? 'Strata', path: paths.workspace, aliases: [...new Set([...(old?.aliases ?? []), old?.path, ...aliases].filter(p => typeof p === 'string' && p && p !== paths.workspace))] };
  const next = [root, ...rows.filter(r => r.id !== 'root')];
  if (JSON.stringify(next) !== JSON.stringify(rows)) atomicJSON(file, next);
  return next;
}
