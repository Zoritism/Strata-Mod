import {deviceStore} from './lan-auth.mjs';
import {formatRules} from './harness-rules.mjs';
import {attachWindowIcon} from './window-icon.mjs';
export {earlierConversation} from './chat-context.mjs';
export {prepareReplyRetry, replyCutNudge, replyCutNotice} from './reply-recovery.mjs';
import {workspaceUploads} from './workspace-uploads.mjs';
import {workspaceChats} from './workspace-chats.mjs';
import {chatManagement} from './chat-management.mjs';
import {checkChat,safe} from './chat-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readJSON, atomicJSON, effective, inspect, inside, validate, locked, storagePresentation, nativeModelSnapshot } from './storage.mjs';
import { stage } from './migration.mjs';
import { createPackages } from './packages.mjs';
import { createHistory } from './history.mjs';

const file = process.env.STRATA_EXTENSIONS_CONFIG;
if (!file) throw new Error('Запускайте модификацию через Strata Extensions.exe.');
const base = path.dirname(file), config = readJSON(file), activePaths = validate(config, base);
attachWindowIcon(base);
// Native assets keep upstream names and have an hour-long browser cache. A mod
// deployment changes their bridge bytes, so the loader needs its own revision.
const bootVersion=readJSON(path.join(base,'installation.json'),{}).deployedAt??new Date().toISOString();
// An official desktop installer would replace our HTML/host bridges. Updating the mod is a separate checked deployment.
delete process.env.STRATA_SHELL_BRIDGE;
delete process.env.STRATA_SHELL_TOKEN;
const chatLocations=workspaceChats(activePaths,{busy:chat=>nativeChats?.busy?.(chat)===true});
/** Resolve the native worker's cwd without changing the chat's sidebar folder. */
export function agentWorkspace(chat,workspace){
  return resolveChatWorkspace(chat,workspace,true);
}
export const chatWorkspace=(chat,workspace)=>resolveChatWorkspace(chat,workspace,false);
function resolveChatWorkspace(chat,workspace,create){
  const root=readJSON(path.join(activePaths.home,'data/workspaces.json'),[]).find?.(w=>w.id==='root');
  return chatLocations.workingDirectory(chat,root?.aliases?.includes(workspace)?activePaths.workspace:workspace,{create});
}
export const createChatStore=(create,options)=>{
  const native=chatLocations.wrap(create,options);managedChatStore=native;
  // Keep diagnostics separate from private chat bodies. A failed attachment
  // migration must never report a successfully committed native chat as unsaved.
  const diagnostic=path.join(activePaths.extensionData,'core','chat-storage-errors.json');
  const report=(chat,operation,error)=>{try{const rows=readJSON(diagnostic,[]);atomicJSON(diagnostic,[...rows,{at:new Date().toISOString(),chat,operation,code:error.code??null,message:String(error.message??error).slice(0,1000)}].slice(-40));}catch{}};
  const migrate=chat=>{try{chatUploads?.migrate(chat);}catch(error){report(chat,'attachment-migration',error);}};
  return {...native,
    async read(chat){const result=await native.read(chat);if(result)migrate(chat);return result;},
    async save(chat,...args){try{const result=await native.save(chat,...args);migrate(chat);return result;}catch(error){report(chat,'save',error);throw error;}},
    async remove(chat){try{return await native.remove(chat);}catch(error){report(chat,'remove',error);throw error;}}
  };
};
let chatUploads,managedChatStore,nativeChats;
const chatMutations=new Set();
const management=chatManagement({locations:chatLocations,store:()=>managedChatStore,uploads:()=>chatUploads,native:()=>nativeChats,base});
export function attachChatManagement(callbacks){
  nativeChats=callbacks;
  // Native uploads and the history store are attached before this callback.
  // Retrying sooner would remove directories without updating their locators.
  for(const chat of pendingCleanup){
    try{finishChatCleanup(chat);}catch(error){failures('core',error);}
  }
  for(const chat of chatLocations.ids())management.finish(chat).catch(error=>failures('folder-paths',error));
}
export const createUploads=(create,options)=>(chatUploads=workspaceUploads(create,options,chatLocations,activePaths.home));
const coreDir = path.dirname(fileURLToPath(import.meta.url));
const packages = createPackages({ registryFile: path.join(base, 'extensions.json'), packagesDir: activePaths.extensionPackages, dataDir: activePaths.extensionData });
const token = randomBytes(32).toString('hex');
const history = createHistory(activePaths.home);
const hooks = new Map(), routes = new Map(), commands = new Map(), errors = new Map();
const active = [], pendingRestart = new Set();
const failures = (id, error) => { errors.set(id, String(error?.message ?? error).slice(0, 1000)); console.error(`[extension:${id}]`, error?.message ?? error); };
export const paths = {
  home() { fs.mkdirSync(path.join(activePaths.home, 'models'), { recursive: true }); fs.mkdirSync(path.join(activePaths.home, 'data'), { recursive: true }); return activePaths.home; },
  models(saved) {
    if (config.profileMode !== 'native') return path.join(activePaths.models, 'models');
    // Respect later choices made in the native model picker until the user
    // explicitly changes the model category through the extension settings.
    // Undefined must remain undefined: the native picker then checks its own
    // default/legacy directory instead of treating our snapshot as a saved pick.
    return config.nativeModelOverride !== true && activePaths.models === config.nativePaths?.inherited?.models
      ? saved : activePaths.models;
  },
};
const core = {
  storage: {
    get: () => ({ config: storagePresentation(readJSON(file), base), activeConfig: config, paths: inspect(storagePresentation(config, base), base), pending: readJSON(file + '.pending', null), file, lastMigration: readJSON(path.join(base, 'last-migration.json'), null) }),
    stage: (value, revision, mode) => stage(file, value, revision, mode),
    cancel: () => locked(file, () => { if (fs.existsSync(file + '.pending')) fs.unlinkSync(file + '.pending'); }),
  },
};
export function chatRules(chat){return chat?formatRules(commands.get('chat-rules.read')?.(chat)):'';}
export function workerEnvironment(){return {STRATA_EXTENSIONS_CONFIG:file,STRATA_EXTENSIONS_ENTRY:process.env.STRATA_EXTENSIONS_ENTRY};}
export function bindSessionRules(session,chat){
  if(!session||!chat)return;
  const file=path.join(activePaths.home,'data','session-rules.json'),map=readJSON(file,{});
  if(commands.has('chat-rules.read'))map[session]=chatLocations.data(chat,'chat-rules','rules.json')??path.join(activePaths.extensionData,'chat-rules','chats',chat+'.json');
  else delete map[session];
  atomicJSON(file,map);
}
for (const record of packages.list().filter(r => r.enabled)) {
  const owned = [];
  const add = (map, name, fn) => { if (typeof fn !== 'function') throw new Error('Обработчик должен быть функцией.'); const row = { id: record.id, fn }; if (!map.has(name)) map.set(name, []); map.get(name).push(row); owned.push(() => map.set(name, map.get(name).filter(v => v !== row))); };
  try {
    const dataFile = path.join(activePaths.extensionData, record.id, 'settings.json');
    const api = Object.freeze({
      chatData:(chat,part='')=>chatLocations.data(chat,record.id,part),
      chatFile:chat=>chatLocations.file(chat),
      chatIds:()=>chatLocations.ids(),
      version: 1, id: record.id, paths: Object.freeze({ ...activePaths }),
      hook: (name, fn) => { if (!['chat.request', 'chat.before', 'chat.after', 'chat.frame', 'host.event', 'http.request'].includes(name)) throw new Error(`Неизвестный hook: ${name}`); add(hooks, name, fn); },
      route: (method, route, fn) => { if (!/^\/[a-z0-9/_-]*$/i.test(route)) throw new Error('Неверный маршрут.'); const key = `${method.toUpperCase()} /api/extensions/${record.id}${route}`; if (routes.has(key)) throw new Error('Маршрут уже зарегистрирован.'); routes.set(key, fn); owned.push(() => routes.delete(key)); },
      command: (name, fn) => { const key = `${record.id}.${name}`; if (commands.has(key)) throw new Error('Команда уже зарегистрирована.'); commands.set(key, fn); owned.push(() => commands.delete(key)); },
      // Local administration belongs to the UI package. Credentials remain in
      // the shared auth store so disabling the panel never resets paired devices.
      application:record.id==='strata-ui'?Object.freeze({base,lanAuth:deviceStore(path.join(base,'data','lan-ui'))}):undefined,
      invoke: (name,args) => commands.has(name) ? commands.get(name)(args) : null,
      storage: Object.freeze({ read: () => readJSON(dataFile, {}), write: value => atomicJSON(dataFile, value) }),
      core: record.id === 'folder-paths' ? core : undefined,
      log: message => console.log(`[extension:${record.id}] ${String(message).slice(0, 2000)}`),
    });
    const module = await packages.load(record);
    if (module?.activate) await module.activate(api);
    active.push(record);
  } catch (e) { owned.reverse().forEach(fn => fn()); failures(record.id, e); }
}
async function filter(name, value, context) {
  let current = value;
  for (const { id, fn } of hooks.get(name) ?? []) try { current = await fn(current, context) ?? current; } catch (e) { if(name==='chat.request'&&e.code==='SX_INPUT_INVALID')throw e;failures(id, e); }
  return current;
}
export async function transform(name, value, context) {
  if(name==='chat.request'&&chatMutations.has(value?.sessionId))throw Error('Сначала дождитесь сохранения изменения чата.');
  if (name === 'chat.request') {
    const root = readJSON(path.join(activePaths.home, 'data/workspaces.json'), []).find?.(w => w.id === 'root');
    if (root?.aliases?.includes(value.workspace)) value = { ...value, workspace: activePaths.workspace };
  }
  const result=await filter(name,value,context);
  return result;
}
function syncFilter(name, value) {
  let current = value;
  for (const { id, fn } of hooks.get(name) ?? []) try { const next = fn(current); if (next && typeof next.then === 'function') { next.catch(e => failures(id, e)); throw new Error(`${name} требует синхронный обработчик.`); } current = next ?? current; } catch (e) { failures(id, e); }
  return current;
}
export async function chat(options, original, meta = {}) {
  const context={...meta,options};
  const input = await filter('chat.before', options, context);
  const send = input.onFrame;
  const result = await original({ ...input, onFrame: frame => {
    const frameContext={...meta,options:input};
    let frames=[frame];
    for(const {id,fn} of hooks.get('chat.frame') ?? []){
      const next=[];
      for(const current of frames){
        try{
          const value=fn(current,frameContext);
          if(value===undefined)next.push(current);
          else if(Array.isArray(value))next.push(...value.filter(item=>item&&typeof item==='object'));
          else if(value&&typeof value==='object')next.push(value);
        }catch(e){failures(id,e);next.push(current);}
      }
      frames=next;
    }
    for(const current of frames)send?.(current);
  } });
  return await filter('chat.after', result, context);
}
const pendingCleanupFile=path.join(activePaths.extensionData,'core','pending-chat-cleanup.json');
const savedCleanup=readJSON(pendingCleanupFile,{version:1,chats:[]});
const pendingCleanup=new Set(Array.isArray(savedCleanup.chats)?savedCleanup.chats.filter(chat=>{try{checkChat(chat);return true;}catch{return false;}}):[]);
function savePendingCleanup(){atomicJSON(pendingCleanupFile,{version:1,chats:[...pendingCleanup]});}
/** A committed chat deletion owns its attachments and rules. Retain the intent
 * across restarts until all exact owned paths have been removed successfully. */
function finishChatCleanup(chat){
  if(!pendingCleanup.has(chat)||!nativeChats||!chatUploads||nativeChats.busy?.(chat))return false;
  const legacy=safe(activePaths.extensionData,'chat-rules','chats',chat+'.json');
  const current=chatLocations.data(chat,'chat-rules','rules.json');
  for(const file of new Set([legacy,current].filter(Boolean)))if(fs.existsSync(file))fs.unlinkSync(file);
  chatUploads?.remove(chat);
  chatLocations.cleanup(chat);
  pendingCleanup.delete(chat);
  savePendingCleanup();
  return true;
}
/** Persist the deletion request so a restart cannot strand owned attachments. */
function requestChatCleanup(chat){
  checkChat(chat);
  pendingCleanup.add(chat);
  savePendingCleanup();
  finishChatCleanup(chat);
}
export function event(name, payload) {
  const result=syncFilter('host.event', { name, payload });
  if(name==='chats'&&payload?.deleted===true&&typeof payload.id==='string'){
    try{requestChatCleanup(payload.id);}catch(error){failures('core',error);}
  }
  return result;
}
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) throw new Error('Запрос слишком большой.'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
function json(res, code, value) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); }
function sameOrigin(req) {
  const host = req.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  return !['cross-site'].includes(req.headers['sec-fetch-site']);
}
function asset(req, res, url) {
  let root, name;
  if (url.pathname.startsWith('/extensions/core/')) { root = coreDir; name = url.pathname.slice('/extensions/core/'.length); if (!['ui.mjs', 'ui.css', 'boot.mjs', 'history-merge.mjs', 'surfaces.mjs','chat-management-ui.mjs','chat-recovery.mjs'].includes(name)) return json(res, 404, { error: 'Not found' }); }
  else {
    const [, , id, ...parts] = url.pathname.split('/'); const record = active.find(r => r.id === id);
    if (!record) return json(res, 404, { error: 'Not found' });
    root = packages.folder(record); name = decodeURIComponent(parts.join('/'));
  }
  const full = path.resolve(root, name);
  if (!inside(root, full) || !fs.existsSync(full) || !inside(fs.realpathSync(root), fs.realpathSync(full)) || !fs.statSync(full).isFile()) return json(res, 404, { error: 'Not found' });
  const ext = path.extname(full); const mime = { '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext];
  if (!mime) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': mime + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); fs.createReadStream(full).pipe(res);
}
export async function request(req, res) {
  await filter('http.request', { req, res });
  // A streaming extension owns the response as soon as headers are sent.
  // writableEnded stays false until the file stream completes.
  if (res.headersSent || res.writableEnded) return true;
  const url = new URL(req.url, 'http://localhost'), route = url.pathname, method = req.method ?? 'GET';
  if (config.profileMode !== 'native' && method !== 'GET' && (route.startsWith('/api/native/models-folder/') || route === '/api/native/directory' || route === '/api/storage/models' || route === '/api/storage/models-directory')) {
    json(res, 409, { error: 'Изменяйте папки через Настройки → Папки и пути: пути закреплены загрузчиком.' }); return true;
  }
  if (!route.startsWith('/api/extensions') && !route.startsWith('/extensions/')) return false;
  // Upstream has permissive CORS for inference; management routes deliberately do not inherit it.
  res.removeHeader('access-control-allow-origin');
  if (!sameOrigin(req)) { json(res, 403, { error: 'Откройте расширения из локального окна Strata.' }); return true; }
  try {
    if (route.startsWith('/extensions/')) { if (method !== 'GET') json(res, 405, { error: 'GET only' }); else asset(req, res, url); return true; }
    if (route === '/api/extensions/history' && method === 'GET') { json(res, 200, history.get()); return true; }
    if (method !== 'GET' && req.headers['x-strata-extension-token'] !== token) { json(res, 403, { error: 'Обновите окно перед изменением настроек.' }); return true; }
    if(route==='/api/extensions/lan' && ['GET','POST'].includes(method)){
      // Keep existing local clients working without exposing administration
      // through the generic command endpoint available to paired devices.
      const handler=routes.get(`${method} /api/extensions/strata-ui/lan`);
      if(!handler){json(res,409,{error:'Включите расширение «Интерфейс Strata» для управления удалённым доступом.'});return true;}
      json(res,200,await handler({body:method==='POST'?await body(req):{},query:Object.fromEntries(url.searchParams)}));return true;
    }
    if(route==='/api/extensions/chat-management'&&method==='POST'){
      const input=await body(req),lock=['edit','move'].includes(input.action);
      if(lock&&chatMutations.has(input.chat))throw Error('Чат уже изменяется. Дождитесь завершения.');
      if(lock)chatMutations.add(input.chat);
      try{json(res,200,await management.run(input));}finally{if(lock)chatMutations.delete(input.chat);}return true;
    }
    if (route.startsWith('/api/extensions/history/') && method === 'POST') { json(res, 200, history.write(route.slice('/api/extensions/history/'.length), await body(req))); return true; }
    if (route === '/api/extensions' && method === 'GET') json(res, 200, { api: 1, version: '0.1.0', bootVersion, token, extensions: packages.list().map(({ inventory, ...r }) => ({ ...r, active: active.some(a => a.id === r.id), error: errors.get(r.id) })), active: active.map(({ id, ui }) => ({ id, ui })), restartRequired: pendingRestart.size > 0, locations: { packages: activePaths.extensionPackages, data: activePaths.extensionData, registry: path.join(base, 'extensions.json') } });
    else if (route === '/api/extensions/install' && method === 'POST') { const b = await body(req); if (b.trusted !== true) throw new Error('Подтвердите, что доверяете автору расширения.'); const result = packages.install(b.path); pendingRestart.add(result.id); json(res, 200, result); }
    else if (route === '/api/extensions/toggle' && method === 'POST') { const b = await body(req); packages.toggle(b.id, b.enabled); pendingRestart.add(b.id); json(res, 200, { ok: true }); }
    else if (route === '/api/extensions/rollback' && method === 'POST') { const b = await body(req); packages.rollback(b.id); pendingRestart.add(b.id); json(res, 200, { ok: true }); }
    else if (route === '/api/extensions/remove' && method === 'POST') { const b = await body(req); packages.remove(b.id); pendingRestart.add(b.id); json(res, 200, { ok: true, retained: 'Package versions and user data retained on disk' }); }
    else if (route === '/api/extensions/command' && method === 'POST') { const b = await body(req), fn = commands.get(b.id); if (!fn) throw new Error('Команда не найдена.');if(chatMutations.has(b.args?.chat))throw Error('Сначала дождитесь сохранения изменения чата.'); json(res, 200, await fn(b.args) ?? { ok: true }); }
    else if (route === '/api/extensions/folder' && method === 'POST') {
      const { chooseFolder } = await import(process.env.STRATA_EXTENSIONS_FOLDER_DIALOG);
      json(res, 200, await chooseFolder('Strata Extensions — выберите папку'));
    }
    else if (route === '/api/extensions/open-folder' && method === 'POST') {
      const b = await body(req); const folder = b.id === 'models' ? nativeModelSnapshot(config, base)?.path ?? activePaths.models : activePaths[b.id];
      if (!folder) throw new Error('Неизвестная категория.');
      const child = spawn('explorer.exe', [folder], { windowsHide: true, detached: true, stdio: 'ignore' }); child.on('error', e => failures('folder-paths', e)); child.unref(); json(res, 200, { ok: true });
    }
    else if (route === '/api/extensions/open-chat-folder' && method === 'POST') {
      const {chat}=await body(req);
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(chat??''))throw new Error('Неверный идентификатор чата.');
      const file=chatLocations.file(chat),chats=chatLocations.directory(chat);
      if(!inside(chats,file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw new Error('Файл этого чата не найден в текущем хранилище.');
      for(let at=chats;at!==path.dirname(at);at=path.dirname(at))if(fs.existsSync(at)&&fs.lstatSync(at).isSymbolicLink())throw new Error('Ссылка в каталоге чатов не поддерживается.');
      const child=spawn('explorer.exe',[chats],{windowsHide:false,detached:true,stdio:'ignore'});child.on('error',error=>failures('folder-paths',error));child.unref();json(res,200,{ok:true});
    }
    else if (routes.has(`${method} ${route}`)) {
      const value=method==='GET'?{}:await body(req);if(chatMutations.has(value.chat))throw Error('Сначала дождитесь сохранения изменения чата.');
      json(res,200,await routes.get(`${method} ${route}`)({body:value,query:Object.fromEntries(url.searchParams)})??{ok:true});
    }
    else json(res, 404, { error: 'Маршрут расширения не найден.' });
  } catch (e) { json(res, 400, { error: e.message }); }
  return true;
}
