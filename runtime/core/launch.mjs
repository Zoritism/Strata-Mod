import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { readJSON, atomicJSON, validate, environment, nativeEnvironment, effective, applicationDirectory } from './storage.mjs';
import { applyPending } from './migration.mjs';
import { importProfile } from './import-profile.mjs';
import { maintainWorkspaces } from './workspaces.mjs';
import { attachWindowIcon } from './window-icon.mjs';

const base = path.resolve(process.argv[2] ?? '.'), file = path.join(base, 'storage.json');
try {
  const installation = readJSON(path.join(base, 'installation.json'));
  const app = applicationDirectory(base, installation);
  const previousWorkspace = effective(readJSON(file), base).workspace;
  if (fs.existsSync(file + '.pending')) { console.log('Копирование и проверка данных…'); await applyPending(file); }
  const config = readJSON(file), paths = validate(config, base, { probe: true });
  const nativeProfile = config.profileMode === 'native';
  if (!nativeProfile) {
    await importProfile(base, paths);
    maintainWorkspaces(paths, [...readJSON(path.join(base, 'profile-workspaces.json'), []), previousWorkspace]);
  }
  const env = nativeProfile ? nativeEnvironment(config, paths) : environment(paths);
  for (const folder of [env.APPDATA, env.LOCALAPPDATA, env.STRATA_DOCUMENTS_DIR].filter(Boolean)) fs.mkdirSync(folder, { recursive: true });
  if (!nativeProfile) {
  const stateFile = path.join(paths.home, 'data', 'native-host.json');
  const prefs = readJSON(stateFile, {});
  atomicJSON(stateFile, { ...prefs, installDir: paths.install, downloadDirectory: paths.models });
  for (const settings of [env.STRATA_SETTINGS_FILE, env.STRATA_TERMINAL_SETTINGS_FILE]) {
    atomicJSON(settings, { ...readJSON(settings, {}), data_dir: paths.models, data_dir_at: Date.now() / 1000, installs: [paths.install] });
  }
  }
  env.STRATA_EXTENSIONS_CONFIG = file;
  // The dependency fix is inherited by native Node children without rewriting
  // Harness files. Its loader is restricted to the exact known validator.
  const compatibility = pathToFileURL(path.join(base, 'extensions', 'core', 'mcp-image-compat.mjs')).href;
  env.NODE_OPTIONS = [env.NODE_OPTIONS, '--import=' + compatibility].filter(Boolean).join(' ');
  env.STRATA_EXTENSIONS_ENTRY = pathToFileURL(path.join(base, 'extensions', 'core', 'host.mjs')).href;
  env.STRATA_EXTENSIONS_FOLDER_DIALOG = pathToFileURL(path.join(app, 'host', 'server', 'folder-dialog.mjs')).href;
  // Early process environment is inherited by desktop logging, WebView, Node, Control and the engine.
  const exe = path.join(app, 'strata-desktop.exe');
  const child = spawn(exe, [], { cwd: path.dirname(exe), env, windowsHide: false, stdio: 'ignore' });
  child.on('spawn', () => {
    // Host reuse must not make the icon depend on a one-time host import. Bind
    // the helper to this desktop launch, before its first window is shown.
    attachWindowIcon(base, { processId: child.pid });
    console.log('READY');
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code) throw new Error(`Оболочка завершилась с кодом ${code}. Журналы: ${paths.desktop}`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
