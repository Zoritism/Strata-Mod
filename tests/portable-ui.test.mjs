import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {systemStatus, parseGpuCounters} from '../extensions/strata-ui/system-status.mjs';
import {telemetryMetrics} from '../extensions/strata-ui/telemetry-ui.mjs';
import {defaultConfig, validate, atomicJSON} from '../runtime/core/storage.mjs';
import {createPackages} from '../runtime/core/packages.mjs';

/** Injected local counters keep these tests independent of the machine's
 * hardware and never launch a driver executable. */
test('local system samples coalesce concurrent readers and expire their bounded cache', async () => {
  let now = 1000, idle = 100, user = 100, finish, calls = 0;
  const system = {cpus: () => [{times: {idle, user}}], hostname: () => 'synthetic-host', totalmem: () => 16 * 1024 ** 3, freemem: () => 4 * 1024 ** 3};
  const read = systemStatus({clock: () => now, system, run: () => {calls++; return new Promise(resolve => {finish = resolve;});}});
  const first = read(), concurrent = read(); assert.equal(calls, 1);
  finish({stdout: 'Synthetic GPU, 96, 2048, 8192'});
  const snapshot = await first; assert.equal(await concurrent, snapshot); assert.equal(await read(), snapshot); assert.equal(calls, 1);
  assert.equal(snapshot.cpu, null); assert.equal(snapshot.ram.used, 12 * 1024 ** 3);
  assert.equal(snapshot.devices[0].used, 2 * 1024 ** 3);
  now += 3001; idle += 50; user += 50;
  const second = read(); assert.equal(calls, 2); finish({stdout: 'Synthetic GPU, 40, 1024, 8192'});
  assert.equal((await second).cpu, 50);
});

test('missing driver data leaves local CPU/RAM available and unknown counters visibly unknown', async () => {
  const system = {cpus: () => [{times: {idle: 1, user: 1}}], hostname: () => 'synthetic-host', totalmem: () => 8 * 1024 ** 3, freemem: () => 2 * 1024 ** 3};
  const snapshot = await systemStatus({system, run: async () => {throw Error('Driver unavailable');}})();
  assert.deepEqual(snapshot.devices, []); assert.equal(snapshot.ram.used, 6 * 1024 ** 3);
  const rows = telemetryMetrics(snapshot);
  assert.equal(rows.find(row => row.id === 'cpu').value, '—');
  assert.equal(rows.find(row => row.id === 'ram').value, '75%');
  assert.equal(rows.find(row => row.id === 'gpu').level, 'unknown');
  const unsupported = parseGpuCounters('Synthetic GPU, [N/A], [Not Supported], 8192')[0];
  assert.equal(unsupported.load, null); assert.equal(unsupported.used, null);
});

test('local GPU meters keep percentage, memory units and load levels distinct', () => {
  const rows = telemetryMetrics({cpu: 20, ram: {used: 8 * 1024 ** 3, total: 16 * 1024 ** 3}, devices: parseGpuCounters('Synthetic GPU, 96, 2048, 8192')});
  assert.equal(rows.find(row => row.id === 'gpu-0').value, '96%'); assert.equal(rows.find(row => row.id === 'gpu-0').level, 'high');
  assert.equal(rows.find(row => row.id === 'vram-0').value, '25%'); assert.match(rows.find(row => row.id === 'vram-0').details, /2\.0 \/ 8\.0 ГиБ/);
});

test('portable host loads only the three public packages and serves their complete browser graph', async t => {
  const parent = path.resolve('.work/tests'); fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'portable-ui-host-'));
  const file = path.join(root, 'storage.json'), config = {...defaultConfig('./data'), strict: false};
  atomicJSON(file, config);
  const paths = validate(config, root, {probe: true});
  const manager = createPackages({registryFile: path.join(root, 'extensions.json'), packagesDir: paths.extensionPackages, dataDir: paths.extensionData});
  const ids = ['folder-paths', 'chat-rules', 'strata-ui'];
  for (const id of ids) manager.install(path.resolve('extensions', id));
  const previous = process.env.STRATA_EXTENSIONS_CONFIG; process.env.STRATA_EXTENSIONS_CONFIG = file;
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.STRATA_EXTENSIONS_CONFIG; else process.env.STRATA_EXTENSIONS_CONFIG = previous;
    assert.equal(path.dirname(root), parent); fs.rmSync(root, {recursive: true});
  });
  const host = await import(pathToFileURL(path.resolve('runtime/core/host.mjs')).href + '?portable=' + Date.now());
  server = http.createServer(async (req, res) => {
    try {if (!await host.request(req, res)) {res.writeHead(404); res.end();}}
    catch (error) {res.writeHead(500); res.end(error.message);}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const registry = await (await fetch(origin + '/api/extensions')).json();
  assert.deepEqual(registry.active.map(row => row.id).sort(), ids.toSorted());
  assert(registry.extensions.every(row => !row.error));
  const queue = ['/extensions/core/ui.mjs', ...registry.active.map(row => '/extensions/' + row.id + '/' + row.ui)], seen = new Set();
  while (queue.length) {
    const asset = queue.shift(); if (seen.has(asset)) continue; seen.add(asset);
    const response = await fetch(origin + asset); assert.equal(response.status, 200, asset);
    const source = await response.text();
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) queue.push(new URL(match[1], origin + asset).pathname);
    }
  }
  assert(seen.has('/extensions/strata-ui/telemetry-ui.mjs'));
  assert.equal((await fetch(origin + '/extensions/strata-ui/ui.css')).status, 200);
  assert.equal((await fetch(origin + '/extensions/core/host.mjs')).status, 404);
  assert.equal((await (await fetch(origin + '/api/extensions/strata-ui/lan')).json()).configured, false);
  const headers = {'content-type': 'application/json', 'x-strata-extension-token': registry.token};
  const saved = await fetch(origin + '/api/extensions/chat-rules/rules', {method: 'POST', headers, body: JSON.stringify({chat: 'portable', rules: 'Synthetic style preference'})});
  assert.equal(saved.status, 200);
  assert.equal((await (await fetch(origin + '/api/extensions/chat-rules/rules?chat=portable')).json()).rules, 'Synthetic style preference');
});

test('LAN launcher validates Strata layout and private network settings without launching components', {skip: process.platform !== 'win32'}, t => {
  const parent = path.resolve('.work/tests'); fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'portable-lan-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, {recursive: true});
  });
  const scripts = path.join(root, 'tools/lan-ui'), data = path.join(root, 'data/lan-ui');
  fs.mkdirSync(scripts, {recursive: true}); fs.mkdirSync(data, {recursive: true});
  for (const name of ['launch.ps1', 'firewall.ps1', 'startup.ps1', 'layout.ps1']) fs.copyFileSync(path.join('scripts/lan-ui', name), path.join(scripts, name));
  fs.writeFileSync(path.join(root, 'Strata Extensions.exe'), 'Synthetic placeholder, never executed');
  let config = {address: '10.123.45.67', subnet: 24, port: 50443, upstreamPort: 48999};
  const save = () => fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  const validate = name => execFileSync(process.env.STRATA_TEST_POWERSHELL ?? 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(scripts, name), '-ValidateOnly'], {encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 10000});
  save(); assert.doesNotThrow(() => validate('launch.ps1'));
  assert.match(validate('firewall.ps1'), /StrataMod-LanUi-50443 10\.123\.45\.67:50443\/24/);
  const probe = path.join(scripts, 'layout-probe.ps1');
  fs.writeFileSync(probe, '. (Join-Path $PSScriptRoot "layout.ps1")\nResolve-StrataApplicationDirectory ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../..")))');
  const layout = () => execFileSync(process.env.STRATA_TEST_POWERSHELL ?? 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', probe], {encoding:'utf8', windowsHide:true, stdio:'pipe', timeout:10000}).trim();
  assert.equal(layout(), path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({appDir: '.'}));
  assert.equal(layout(), root); assert.doesNotThrow(() => validate('launch.ps1')); assert.doesNotThrow(() => validate('firewall.ps1'));
  fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({appDir: 'app'}));
  assert.equal(layout(), path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({appDir: '../other'}));
  assert.throws(layout); assert.throws(() => validate('launch.ps1')); assert.throws(() => validate('firewall.ps1'));
  fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({appDir: '.'}));
  config.port = 48443; save(); assert.match(validate('firewall.ps1'), /StrataMod-LanUi-48443/);
  config.port = 65536; save(); assert.throws(() => validate('firewall.ps1'));
  config.port = 50443; config.address = '203.0.113.7'; save(); assert.throws(() => validate('firewall.ps1'));
});
