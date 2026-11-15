import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {applicationDirectory, atomicJSON, defaultConfig, effective, nativeEnvironment, readJSON, storagePresentation, validate} from '../runtime/core/storage.mjs';
import {applyPending, stage} from '../runtime/core/migration.mjs';
import {attachWindowIcon} from '../runtime/core/window-icon.mjs';

/** Everything in these fixtures is synthetic, including native settings and
 * images. No test discovers or imports a real user profile. */
function fixture(t) {
  const parent = path.resolve('.work/tests'); fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'native-overlay-'));
  t.after(() => {assert.equal(path.dirname(root), parent); fs.rmSync(root, {recursive: true});});
  const home = path.join(root, 'native-home'), models = path.join(home, 'models');
  const config = {...defaultConfig('./owned'), strict: false, profileMode: 'native', paths: {home, models},
    nativePaths: {settingsFile: path.join(root, 'native-settings.json'), terminalSettingsFile: path.join(root, 'native-terminal.json'),
      inherited: {home, models, webview: path.join(root, 'owned/webview')}}};
  const file = path.join(root, 'storage.json'); atomicJSON(file, config);
  const paths = validate(config, root, {probe: true});
  return {root, file, config, paths};
}

test('native environment preserves OS identity, native settings and the unfixed native model picker', t => {
  const {config, paths} = fixture(t);
  const identity = {HOME: 'original-home', USERPROFILE: 'original-user', APPDATA: 'original-appdata', LOCALAPPDATA: 'original-local', NODE_OPTIONS: '--no-warnings'};
  const env = nativeEnvironment(config, paths, identity);
  for (const [key, value] of Object.entries(identity)) assert.equal(env[key], value);
  assert.equal(env.STRATA_SETTINGS_FILE, config.nativePaths.settingsFile);
  assert.equal(env.STRATA_TERMINAL_SETTINGS_FILE, config.nativePaths.terminalSettingsFile);
  assert.equal(env.STRATA_MODELS_DIR, undefined); assert.equal(env.WEBVIEW2_USER_DATA_FOLDER, undefined);
  assert.equal(env.TEMP, paths.temp); assert.equal(env.STRATA_HOME, paths.home);
  assert.equal(nativeEnvironment(config, paths, {STRATA_MODELS_DIR: 'native-explicit'}).STRATA_MODELS_DIR, 'native-explicit');
  const moved = {...paths, models: path.join(paths.models, '..', '..', 'new-models'), webview: path.join(paths.webview, '..', 'new-webview')};
  assert.equal(nativeEnvironment(config, moved, identity).STRATA_MODELS_DIR, moved.models);
  assert.equal(nativeEnvironment(config, moved, identity).WEBVIEW2_USER_DATA_FOLDER, moved.webview);
  assert.deepEqual(identity, {HOME: 'original-home', USERPROFILE: 'original-user', APPDATA: 'original-appdata', LOCALAPPDATA: 'original-local', NODE_OPTIONS: '--no-warnings'});
});

test('metadata selects flat or managed application and icon targets even if both executable trees exist', t => {
  const {root} = fixture(t), calls = [];
  const options = {platform: 'win32', processId: 123, exists: () => true,
    launch: (file, args) => {calls.push({file, args}); return {on() {}, unref() {}};}};
  assert.equal(applicationDirectory(root), path.join(root, 'app'));
  for (const appDir of ['.', 'app']) {
    atomicJSON(path.join(root, 'installation.json'), {appDir});
    assert.equal(applicationDirectory(root), path.resolve(root, appDir));
    assert.equal(attachWindowIcon(root, options), true);
    assert.equal(calls.at(-1).args[0], path.join(path.resolve(root, appDir), 'strata-desktop.exe'));
  }
  atomicJSON(path.join(root, 'installation.json'), {appDir: '../foreign'});
  assert.throws(() => applicationDirectory(root), /каталог/); assert.equal(attachWindowIcon(root, options), false);
});

test('native inherited overlaps are narrow and cannot be forged by a path-edit request', t => {
  const {root, file, config, paths} = fixture(t);
  assert.doesNotThrow(() => validate(config, root));
  const overlap = structuredClone(config); overlap.paths.temp = path.join(paths.home, 'temp');
  assert.throws(() => stage(file, overlap, config.revision, 'copy'), /перекрываются/);
  overlap.nativePaths.inherited.temp = overlap.paths.temp;
  assert.throws(() => stage(file, overlap, config.revision, 'copy'), /исходном профиле/);
  assert.throws(() => stage(file, {...config, profileMode: 'managed'}, config.revision, 'copy'), /исходном профиле/);
  assert.equal(fs.existsSync(file + '.pending'), false); assert.deepEqual(readJSON(file), config);
});

test('copying a native parent refuses nested categories; a child-only copy stays supported and keeps its original', async t => {
  const {root, file, config, paths} = fixture(t);
  const source = path.join(paths.models, 'synthetic.gguf'); fs.writeFileSync(source, 'synthetic model bytes');
  assert.throws(() => stage(file, {...config, paths: {...config.paths, home: path.join(root, 'new-home')}}, 1, 'copy'), /содержит категорию models/);
  const target = path.join(root, 'new-models');
  stage(file, {...config, paths: {...config.paths, models: target}}, 1, 'copy');
  await applyPending(file);
  assert.equal(fs.readFileSync(path.join(target, 'synthetic.gguf'), 'utf8'), 'synthetic model bytes');
  assert.equal(fs.readFileSync(source, 'utf8'), 'synthetic model bytes');
  assert.deepEqual(readJSON(file).nativePaths, config.nativePaths);
  const current = readJSON(file);
  assert.throws(() => stage(file, {...current, paths: {...current.paths, home: path.join(root, 'later-home')}}, current.revision, 'copy'), /остались прежние данные/);
});

test('native folder presentation and migration follow a later picker choice without rewriting settings on read', async t => {
  const {root, file, config, paths} = fixture(t), chosen = path.join(root, 'native-picked'), target = path.join(root, 'moved-picked');
  fs.mkdirSync(chosen); fs.mkdirSync(path.join(paths.home, 'data'), {recursive: true});
  fs.writeFileSync(path.join(chosen, 'picked.gguf'), 'latest native model');
  const stateFile = path.join(paths.home, 'data/state.json'); atomicJSON(stateFile, {modelsDir: chosen, nativeSetting: 'preserved'});
  const bytes = fs.readFileSync(file), stateBytes = fs.readFileSync(stateFile);
  const view = storagePresentation(config, root);
  assert.equal(view.paths.models, chosen); assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(fs.readFileSync(stateFile), stateBytes);
  // Saving another option must not silently pin the native model picker.
  const noMove = stage(file, {...view, strict: false}, 1, 'copy'); assert.equal(noMove.changes.length, 0);
  await applyPending(file); assert.equal(readJSON(file).nativeModelOverride, undefined);
  const current = readJSON(file), currentView = storagePresentation(current, root);
  const pending = stage(file, {...currentView, paths: {...currentView.paths, models: target}}, current.revision, 'copy');
  assert.deepEqual(pending.changes, [{id: 'models', from: chosen, to: target}]);
  await applyPending(file);
  assert.equal(fs.readFileSync(path.join(target, 'picked.gguf'), 'utf8'), 'latest native model');
  assert.equal(readJSON(file).nativeModelOverride, true); assert.deepEqual(readJSON(file).nativePaths, config.nativePaths);
  assert.deepEqual(fs.readFileSync(stateFile), stateBytes);
});

test('pending native relocation refuses a changed picker source before touching its destination', async t => {
  const {root, file, config, paths} = fixture(t), chosen = path.join(root, 'picked'), target = path.join(root, 'destination');
  fs.mkdirSync(chosen); fs.mkdirSync(path.join(paths.home, 'data'), {recursive: true});
  const stateFile = path.join(paths.home, 'data/state.json'); atomicJSON(stateFile, {modelsDir: chosen});
  stage(file, {...storagePresentation(config, root), paths: {...config.paths, models: target}}, 1, 'copy');
  atomicJSON(stateFile, {modelsDir: path.join(root, 'picked-again')});
  await assert.rejects(applyPending(file), /изменился после подготовки/);
  assert.equal(fs.existsSync(target), false); assert.deepEqual(readJSON(file), config);
});

test('existing native relocation rewrites a nested model path by its most specific old category', async t => {
  const {root, file, config, paths} = fixture(t);
  const newHome = path.join(root, 'chosen-home'), newModels = path.join(root, 'chosen-models');
  fs.mkdirSync(newHome); fs.mkdirSync(newModels);
  const modelConfig = path.join(paths.install, 'strata-synthetic.json');
  atomicJSON(modelConfig, {model: path.join(paths.models, 'synthetic.gguf'), state: path.join(paths.home, 'data/state.json'), unrelated: 'unchanged'});
  stage(file, {...config, paths: {...config.paths, home: newHome, models: newModels}}, 1, 'existing');
  await applyPending(file);
  assert.deepEqual(readJSON(modelConfig), {model: path.join(newModels, 'synthetic.gguf'), state: path.join(newHome, 'data/state.json'), unrelated: 'unchanged'});
});

test('native host returns the real saved picker choice, while an explicitly relocated category is fixed', async t => {
  const {file, root, config, paths} = fixture(t), previous = process.env.STRATA_EXTENSIONS_CONFIG;
  t.after(() => {if (previous === undefined) delete process.env.STRATA_EXTENSIONS_CONFIG; else process.env.STRATA_EXTENSIONS_CONFIG = previous;});
  process.env.STRATA_EXTENSIONS_CONFIG = file;
  const hostUrl = pathToFileURL(path.resolve('runtime/core/host.mjs')).href;
  const native = await import(hostUrl + '?native=' + Date.now());
  assert.equal(native.paths.models(undefined), undefined);
  assert.equal(native.paths.models(path.join(root, 'picked-later')), path.join(root, 'picked-later'));
  const changed = {...config, paths: {...config.paths, models: path.join(root, 'moved-models')}};
  atomicJSON(file, changed);
  const relocated = await import(hostUrl + '?relocated=' + Date.now());
  assert.equal(relocated.paths.models(path.join(root, 'picked-later')), effective(changed, root).models);
  assert.equal(native.paths.home(), paths.home);
});

test('native launch selects either layout without rewriting native files or OS identity', {skip: process.platform !== 'win32', timeout: 15000}, t => {
  const {root, file, config, paths} = fixture(t);
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const source = path.join(root, 'Probe.cs'), probe = path.join(root, 'Probe.exe');
  fs.writeFileSync(source, `using System; using System.IO; using System.Reflection;
class Probe {
static void Main(string[] args) {
 if(args.Length==2){var type=Assembly.LoadFile(args[0]).GetType("Launcher"); Console.Write(type.GetMethod("ApplicationDirectory",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{args[1]}));return;}
 var names=new[]{"HOME","USERPROFILE","APPDATA","LOCALAPPDATA","STRATA_MODELS_DIR","STRATA_SETTINGS_FILE","STRATA_TERMINAL_SETTINGS_FILE","NODE_OPTIONS"};
 using(var output=new StreamWriter(Environment.GetEnvironmentVariable("SX_NATIVE_PROBE"))){foreach(var key in names)output.WriteLine(key+"="+(Environment.GetEnvironmentVariable(key)??""));}
}}
`);
  execFileSync(compiler, ['/nologo', '/target:exe', '/out:' + probe, source], {windowsHide: true, stdio: 'pipe'});
  const launcher = path.join(root, 'CompiledLauncher.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', '/reference:System.Runtime.Serialization.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/out:' + launcher, path.resolve('bridges/Launcher.cs')], {windowsHide: true, stdio: 'pipe'});
  const nativeState = path.join(paths.home, 'data/native-host.json');
  for (const nativeFile of [nativeState, config.nativePaths.settingsFile, config.nativePaths.terminalSettingsFile]) {
    fs.mkdirSync(path.dirname(nativeFile), {recursive: true}); fs.writeFileSync(nativeFile, '{"preserve":"synthetic original bytes"}\n');
  }
  const originals = [file, nativeState, config.nativePaths.settingsFile, config.nativePaths.terminalSettingsFile].map(name => [name, fs.readFileSync(name)]);
  const inherited = {HOME: path.join(root, 'os-home'), USERPROFILE: path.join(root, 'os-user'), APPDATA: path.join(root, 'os-appdata'), LOCALAPPDATA: path.join(root, 'os-local')};
  const environment = {...process.env, ...inherited, NODE_OPTIONS: '--no-warnings', SX_NATIVE_PROBE: path.join(root, 'result.txt')};
  delete environment.STRATA_MODELS_DIR; delete environment.STRATA_DOCUMENTS_DIR;
  for (const appDir of ['.', 'app']) {
    const app = path.resolve(root, appDir); fs.mkdirSync(app, {recursive: true}); fs.copyFileSync(probe, path.join(app, 'strata-desktop.exe'));
    atomicJSON(path.join(root, 'installation.json'), {appDir, kind: 'overlay', userDataImported: true});
    assert.equal(execFileSync(probe, [launcher, root], {encoding: 'utf8', windowsHide: true}).trim(), app);
    assert.match(execFileSync(process.execPath, [path.resolve('runtime/core/launch.mjs'), root], {env: environment, encoding: 'utf8', windowsHide: true, timeout: 5000}), /READY/);
    const result = Object.fromEntries(fs.readFileSync(environment.SX_NATIVE_PROBE, 'utf8').trim().split(/\r?\n/).map(row => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]));
    for (const [key, value] of Object.entries(inherited)) assert.equal(result[key], value);
    assert.equal(result.STRATA_MODELS_DIR, ''); assert.equal(result.STRATA_SETTINGS_FILE, config.nativePaths.settingsFile);
    assert.match(result.NODE_OPTIONS, /^--no-warnings --import=file:/); assert.match(result.NODE_OPTIONS, /mcp-image-compat\.mjs$/);
    for (const [name, bytes] of originals) assert.deepEqual(fs.readFileSync(name), bytes, name);
  }
});

// A valid uncompressed RGBA PNG is deliberately larger than the old regexp's
// stack limit. Its deterministic pixels are test data, not a user attachment.
function largePng() {
  const crcTable = Array.from({length: 256}, (_, n) => {for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0;});
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length);
    let value = 0xffffffff; for (const byte of body) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, crc]);
  };
  const width = 2048, height = 1024, header = Buffer.alloc(13), pixels = Buffer.alloc((width * 4 + 1) * height);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) pixels[y * (width * 4 + 1) + x + 1] = (x * 17 + y * 31) & 255;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, {level: 0})), chunk('IEND', Buffer.alloc(0))]);
}

const release = path.resolve(process.env.STRATA_TEST_CLEAN_RELEASE ?? '.work/upgrade-0213/release');
const dependency = path.join(release, 'harness/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js');
test('clean 0.2.13 Harness accepts an 8 MB PNG through the scoped loader without a disk patch', {skip: !fs.existsSync(dependency), timeout: 30000}, t => {
  const {root} = fixture(t), bytes = largePng(), png = path.join(root, 'synthetic.png'); fs.writeFileSync(png, bytes);
  assert(bytes.length > 8 * 1024 * 1024);
  const hash = value => createHash('sha256').update(value).digest('hex'), before = hash(fs.readFileSync(dependency));
  const child = path.join(root, 'mcp-probe.mjs');
  fs.writeFileSync(child, `import fs from 'node:fs';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const [dependency,attachment,png,root]=process.argv.slice(2);
const {createMcpToolDefinition}=await import(pathToFileURL(dependency));
const {saveImageFile,readImageFile}=await import(pathToFileURL(attachment));
const original=fs.readFileSync(png);let stored=0;
const limits={maxImageBytes:20*1024*1024,maxImagePixels:64000000,maxImageDimension:8192};
const policy={maxPixels:4194304,maxDimension:8192,maxBytes:20*1024*1024};
const ctx={get:name=>name==='attachments'?{saveImages:async inputs=>{stored++;return await Promise.all(inputs.map(input=>saveImageFile(root,input,limits,policy)));}}:name==='llm'?{resolveModelInfo:async()=>({inputModalities:['text','image']})}:undefined};
async function project(data,mimeType='image/png',vision=true){
 const exec={signal:new AbortController().signal,agent:{session:{requestHeader:()=>({config:{provider:'test',model:'synthetic'}})}}};
 const context=vision?ctx:{get:name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['text']})}:ctx.get(name)};
 const tool=createMcpToolDefinition(context,{name:'synthetic',rawName:'synthetic',description:'Synthetic image',inputSchema:{type:'object'},call:async()=>({content:[{type:'image',mimeType,data}]})});
 const value=await tool.execute({},exec);const content=tool.projectContent(exec,{value,content:tool.output.render({},value),isError:false});
 return content;
}
const result=await project(original.toString('base64'));
if(process.env.SX_EXPECT_COMPAT==='1'){
 assert.equal(result[0].type,'image',JSON.stringify(result));assert.equal(stored,1);
 const loaded=await readImageFile(root,result[0].attachment);assert.deepEqual(Buffer.from(loaded.data),original);
 for(const data of ['Zh==','Zg','Zg==\\n','Z=g=','Zg__','====','A']){
  // The MCP wire schema may reject malformed bytes before image projection.
  // Both refusal paths must leave the attachment store untouched.
  let refused=false;try{refused=(await project(data))[0].type==='text';}catch(error){assert.match(error.message,/invalid MCP result|base64/i);refused=true;}assert(refused);
 }
 assert.equal((await project(original.toString('base64'),'image/svg+xml'))[0].type,'text');
 assert.equal((await project(original.toString('base64'),'image/png',false))[0].type,'text');assert.equal(stored,1);
 console.log(JSON.stringify({accepted:true,bytes:original.length,stored,invalidRejected:true,visionGuard:true}));
}else{assert.equal(result[0].type,'text');assert.match(result[0].text,/Maximum call stack|stack overflow/i);assert.equal(stored,0);console.log(JSON.stringify({originalOverflow:true}));}
`);
  const attachment = path.join(release, 'harness/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js');
  const node = process.platform === 'win32' ? path.join(release, 'node/node.exe') : process.execPath;
  const args = [child, dependency, attachment, png, path.join(root, 'attachments')];
  const env = {...process.env, DSH_HOME: path.join(root, 'dsh'), NODE_OPTIONS: ''};
  const original = JSON.parse(execFileSync(node, args, {env, encoding: 'utf8', windowsHide: true, timeout: 12000}));
  assert.equal(original.originalOverflow, true);
  const accepted = JSON.parse(execFileSync(node, ['--import=' + pathToFileURL(path.resolve('runtime/core/mcp-image-compat.mjs')).href, ...args], {env:{...env, SX_EXPECT_COMPAT:'1'}, encoding:'utf8', windowsHide:true, timeout:15000}));
  assert.equal(accepted.accepted, true); assert.equal(accepted.bytes, bytes.length); assert.equal(accepted.invalidRejected, true);
  assert.equal(hash(fs.readFileSync(dependency)), before, 'dependency bytes unchanged');
  t.diagnostic('Synthetic PNG bytes: ' + accepted.bytes + '; unmodified dependency hash verified.');
});
