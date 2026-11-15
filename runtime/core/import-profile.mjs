import fs from 'node:fs';
import path from 'node:path';
import { readJSON, atomicJSON, inside } from './storage.mjs';
import { copyVerified } from './migration.mjs';
// One-time, local, byte-verified copy. Never read the WebView databases while Strata is running.
// The native launcher checks for another desktop instance before invoking this module.
export async function importProfile(base, paths) {
  const file = path.join(base, 'installation.json'), installation = readJSON(file);
  if (installation.userDataImported) return;
  const original = installation.original;
  if (inside(base, original) || inside(original, base)) throw new Error('Профили исходной и новой Strata не должны перекрываться.');
  const pairs = [
    [path.join(original, 'user-data/home'), paths.home],
    [path.join(original, 'user-data/webview'), paths.webview],
    [path.join(original, 'user-data/profiles/profiles'), paths.profiles],
    [path.join(original, 'workspace'), paths.workspace],
  ];
  console.log('Копирование истории и настроек в отдельный профиль…');
  const counts = [];
  for (const [from, to] of pairs) {
    if (!fs.existsSync(from)) continue;
    await copyVerified(from, to);
    let files = 0, bytes = 0;
    const count = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const name = path.join(dir, e.name); if (e.isDirectory()) count(name); else if (e.isFile()) { files++; bytes += fs.statSync(name).size; } } };
    count(to); counts.push({ from, to, files, bytes, verification: 'Every file SHA256 matched before use' });
  }
  atomicJSON(path.join(base, 'profile-import.json'), { schema: 1, date: new Date().toISOString(), copies: counts, originalsRetained: true });
  const layout = readJSON(path.join(original, 'storage-layout.json'), {});
  const root = readJSON(path.join(paths.home, 'data/workspaces.json'), []).find?.(w => w.id === 'root');
  const aliases = [path.join(original, 'workspace'), root?.path, ...(root?.aliases ?? []), ...(layout.locations ?? []).filter(r => path.resolve(r.target) === path.join(original, 'workspace')).map(r => r.source)].filter(Boolean);
  atomicJSON(path.join(base, 'profile-workspaces.json'), [...new Set(aliases)]);
  atomicJSON(file, { ...installation, userDataImported: true, importedAt: new Date().toISOString() });
}
