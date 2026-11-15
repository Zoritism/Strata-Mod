// Exact-anchor bridges for audited upstream releases. A changed source stops
// deployment before any upstream file is written; --plan/--check are read-only.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root=path.resolve(process.argv[2] ?? '');
const source=process.argv.includes('--source');
const planning=process.argv.includes('--plan')||process.argv.includes('--check');
const host=source?path.join(root,'apps','host'):path.join(root,'host');
const pins={'0.2.13':'d2f096475817d4666c364c820b0ca830f751cfc5'};
const distribution='strata-mod-public',bridgeSchema=1;
const hostVersion=JSON.parse(fs.readFileSync(path.join(host,'package.json'),'utf8')).version;
if(!Object.hasOwn(pins,hostVersion))throw Error('Expected audited Strata '+Object.keys(pins).join(' or ')+', found '+hostVersion);
const upstream='v'+hostVersion,commit=pins[hostVersion];
const receiptPath=path.join(root,'strata-bridge-receipt.json');
const digest=value=>createHash('sha256').update(value).digest('hex');
if(fs.existsSync(receiptPath)){
  const previous=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  if(previous.distribution!==distribution||previous.bridgeSchema!==bridgeSchema)throw Error('Unsupported bridge receipt. Use a clean supported Strata release.');
  if(previous.upstream!==upstream||previous.commit!==commit)throw Error('Bridge receipt belongs to a different upstream release. Prepare the new clean release separately.');
  // Validate the complete previous overlay, including files whose current
  // hooks need no change. Otherwise a no-op update could bless a partial edit.
  if(!Array.isArray(previous.files))throw Error('Invalid bridge receipt.');
  const seen=new Set();
  for(const row of previous.files){
    if(typeof row.file!=='string'||seen.has(row.file))throw Error('Invalid or duplicate bridge receipt path.');
    seen.add(row.file);
    const file=path.resolve(host,row.file),relative=path.relative(host,file);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Bridge receipt path escapes host.');
    if(!fs.existsSync(file)||digest(fs.readFileSync(file))!==row.after)throw Error('Previously bridged file changed; review before updating: '+row.file);
  }
}
const records=[],writes=[];

function patch(relative,edits){
  const file=path.join(host,relative),original=fs.readFileSync(file,'utf8');
  const receiptFile=path.join(root,'strata-bridge-receipt.json');
  if(original.includes('strata-extensions-bridge')){
    if(!fs.existsSync(receiptFile))throw Error('Bridge marker exists without its hash receipt: '+relative);
    const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
    const expected=receipt.files.find(row=>row.file===relative)?.after;
    if(!expected||expected!==digest(original))throw Error('Previously bridged file changed; review before updating: '+relative);
    if(!planning)console.log('Already bridged: '+relative);return;
  }
  let text=original.replaceAll('\r\n','\n');
  for(const [from,to] of edits){
    if(text.split(from).length!==2)throw Error(`Bridge anchor mismatch: ${relative}: ${from.slice(0,100)}`);
    text=text.replace(from,to);
  }
  records.push({file:relative,before:digest(original),after:digest(text)});
  writes.push([file,text]);
}

const imp="import { bridge } from './strata-extensions-bridge.mjs';\n";
patch('server/store.mjs',[
  ["import { migrateSetup } from './setup.mjs';",imp+"import { migrateSetup } from './setup.mjs';"],
  ['function resolveHome() {','function resolveHome() {\n  if (bridge) return bridge.paths.home();'],
  ['const MODELS_PICK = pickModelsDirectory({ saved: state.modelsDir,','const MODELS_PICK = pickModelsDirectory({ saved: bridge ? bridge.paths.models(state.modelsDir, DEFAULT_MODELS_DIRECTORY) : state.modelsDir,'],
]);

patch('server/index.mjs',[
  ["import './system-ca.mjs';",imp+"import './system-ca.mjs';"],
]);

patch('server/agent/agent-bridge.mjs',[
  ["import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';", "import { bridge } from '../strata-extensions-bridge.mjs';\nimport { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';"],

]);

// These anchors occur in different scopes; keep the hub assignment and route bootstrap independently explicit.
const indexFile=path.join(host,'server','index.mjs');
{
  const staged=writes.find(([file])=>file===indexFile);
  let text=staged?.[1] ?? fs.readFileSync(indexFile,'utf8');
  const replace=(from,to)=>{
    // Bridge application is repeated on every deploy; accept only the exact single replacement recorded by this version.
    const already= text.split(to).length-1;
    if(already===1)return;
    if(already>1)throw Error('Duplicate bridge replacement: server/index.mjs: '+to.slice(0,100));
    if(text.split(from).length!==2)throw Error('Bridge anchor mismatch: server/index.mjs: '+from.slice(0,100));
    text=text.replace(from,to);
  };
  replace('hub.send = (event, payload) => {','hub.send = (event, payload) => {\n  if (bridge) ({ name: event, payload } = bridge.event(event, payload));');
  replace("const method = req.method ?? 'GET';","const method = req.method ?? 'GET';\n  if (await bridge?.request(req, res)) return;");
  replace('async function runTurn({ message,','async function runTurn(options) { return bridge ? bridge.chat(options, runTurnCore, {agent:false}) : runTurnCore(options); }\nasync function runTurnCore({ message,');
  replace('  const cwd = chatFolders.get(chatId) ?? (workspaceId ? workspaces.find(w => w.id === workspaceId)?.path : null) ?? WORKSPACE;',
    '  const chosen = chatFolders.get(chatId) ?? (workspaceId ? workspaces.find(w => w.id === workspaceId)?.path : null) ?? WORKSPACE;\n  const cwd = bridge?.agentWorkspace ? bridge.agentWorkspace(chatId, chosen) : chosen;');
  replace('const chatRoot = chatId => chatRootOf({ chosen: chatFolders.get(chatId), used: agent.workingFolder?.(chatId), fallback: workspaces[0]?.path ?? WORKSPACE });',
    'const chatRoot = chatId => bridge?.chatWorkspace ? bridge.chatWorkspace(chatId, chatRootOf({ chosen: chatFolders.get(chatId), used: agent.workingFolder?.(chatId), fallback: workspaces[0]?.path ?? WORKSPACE })) : chatRootOf({ chosen: chatFolders.get(chatId), used: agent.workingFolder?.(chatId), fallback: workspaces[0]?.path ?? WORKSPACE });');
  replace(': goalLine ? await agent.goalCommand({ ...turnOptions, line: goalLine[1] ?? \'\' }) : await agent.runTurn(turnOptions);',
    ": goalLine ? await agent.goalCommand({ ...turnOptions, line: goalLine[1] ?? '' }) : await (bridge ? bridge.chat(turnOptions, options => agent.runTurn(options), {agent:true}) : agent.runTurn(turnOptions));");
  replace("const body = await readBody(req,12*1024*1024);\n    if (path === '/api/plan/start-goal')", "const body = await (bridge ? bridge.transform('chat.request', await readBody(req,12*1024*1024), {req,res}) : readBody(req,12*1024*1024));\n    if (path === '/api/plan/start-goal')");
  replace('const chatStore = createChatStore({ dir: store.DATA_DIR, privateDir: makePrivateDir });','const chatStore = bridge?.createChatStore ? bridge.createChatStore(createChatStore,{ dir: store.DATA_DIR, privateDir: makePrivateDir }) : createChatStore({ dir: store.DATA_DIR, privateDir: makePrivateDir });');
  replace("const uploads = createUploads({ dir: join(store.DATA_DIR, 'uploads'), folderOf: chatId => chatRoot(chatId), attachments: chatAttachments });", "const uploads = (bridge?.createUploads ? options => bridge.createUploads(createUploads,options) : createUploads)({ dir: join(store.DATA_DIR, 'uploads'), folderOf: chatId => chatRoot(chatId), attachments: chatAttachments });");
  replace('async function runRemoteTurn({ selection, message, history, images = [], thinking, onFrame, signal, workspaceId }) {','async function runRemoteTurn({ selection, message, history, images = [], thinking, onFrame, signal, workspaceId, sessionId }) {');
  replace('return runRemoteTurn({ selection: remoteModel, message, history, images, thinking, onFrame, signal, workspaceId });','return runRemoteTurn({ selection: remoteModel, message, history, images, thinking, onFrame, signal, workspaceId, sessionId });');
  replace("conversation.', skillInstructions(appliedSkills)].filter(Boolean)", "conversation.', skillInstructions(appliedSkills), bridge?.chatRules(sessionId)].filter(Boolean)");
  replace('[SYSTEM_PROMPT,skillInstructions(applied)].filter(Boolean)', '[SYSTEM_PROMPT,skillInstructions(applied),bridge?.chatRules(sessionId)].filter(Boolean)');
  replace('[SYSTEM_PROMPT, skillInstructions(appliedSkills)].filter(Boolean)', '[SYSTEM_PROMPT, skillInstructions(appliedSkills), bridge?.chatRules(sessionId)].filter(Boolean)');
  const chatAttachment="bridge?.attachChatManagement({workspaces:()=>workspaces,reset:id=>agent.resetSession(id),busy:id=>agent.isRunning(id),folder:(id,folder)=>chatFolders.set(id,folder),changed:(id,rev)=>hub.send('chats',{id,rev})});";
  text=text.replace('bridge?.attachChatManagement({workspaces:()=>workspaces,reset:id=>agent.resetSession(id),busy:id=>agent.isRunning(id),folder:(id,folder)=>chatFolders.set(id,folder)});',chatAttachment);
  replace('const taskTimer = setInterval(() => tasks.tick(), 15000);','const taskTimer = setInterval(() => tasks.tick(), 15000);\n'+chatAttachment);
  const prior=staged?.[1] ?? fs.readFileSync(indexFile,'utf8');
  const record=records.find(row=>row.file==='server/index.mjs');
  if(record)record.after=digest(text);
  else if(staged)staged[1]=text;
  else if(text!==prior){records.push({file:'server/index.mjs',before:digest(prior),after:digest(text)});writes.push([indexFile,text]);}
  if(staged)staged[1]=text;
}

for(const [relative,from,to] of [
 ['server/agent/agent-bridge.mjs','            const cut = projector.cut();',`            const cut = projector.cut();
            turn.cutWaiting = true;
            const recovery = await bridge?.prepareReplyRetry?.({cut, context: () => contextOf(runtime, sessionId), compact: () => compactChat(runtime, sessionId), stopped: () => turn.finished || turn.stopping || signal?.aborted, report: text => reporter.set({phase:'waiting', code:'reply-recovery', text})});
            if (turn.finished || turn.stopping || signal?.aborted) { turn.cutWaiting = false; armSettle(); return; }
            if (recovery?.ok === false) { turn.cutWaiting = false; turn.replyRecoveryError = recovery.message; finishTurn(null); return; }`],
 ['server/agent/agent-bridge.mjs','const note = cutNotice({ ...cut, retrying: true });','const note = bridge?.replyCutNotice?.({ ...cut, retrying: true }) ?? cutNotice({ ...cut, retrying: true });'],
 ['server/agent/agent-bridge.mjs','const note = cutNotice({ ...projector.cut(), retrying: false });','const note = bridge?.replyCutNotice?.({ ...projector.cut(), retrying: false, recoveryError: turn.replyRecoveryError }) ?? cutNotice({ ...projector.cut(), retrying: false });'],
 ['server/agent/agent-bridge.mjs','text: cutNudge(cut)','text: (bridge?.replyCutNudge?.(cut) ?? cutNudge(cut))'],
 ['server/agent/agent-bridge.mjs','export function withEarlierConversation(history, message) {','export function withEarlierConversation(history, message) {\n  if (bridge?.earlierConversation) return bridge.earlierConversation(history, message);'],
 ['server/agent/agent-bridge.mjs','env: profile.env, nodePath, logFile:', 'env: {...profile.env,...bridge?.workerEnvironment()}, nodePath, logFile:'],
 ['server/agent/agent-bridge.mjs','    const { sessionId, fresh } = made ?? {};','    const { sessionId, fresh } = made ?? {};\n    bridge?.bindSessionRules(sessionId,chatId);'],
 ['server/agent/plugins/strata-context.mjs',"import { replyCap } from '../reply-cut.mjs';","import { rulesBridge } from '../../strata-rules-bridge.mjs';\nimport { replyCap } from '../reply-cut.mjs';"],
 ['server/agent/plugins/strata-context.mjs','  const llm = ctx.llm;','  const llm = ctx.llm;\n  rulesBridge?.attachRules(llm);'],
]){
 const file=path.join(host,relative),staged=writes.find(([f])=>f===file),old=staged?.[1]??fs.readFileSync(file,'utf8');
 if(!staged){
  const receiptPath=path.join(root,'strata-bridge-receipt.json');
  const receipt=fs.existsSync(receiptPath)?JSON.parse(fs.readFileSync(receiptPath,'utf8')).files.find(r=>r.file===relative):null;
  if(receipt?receipt.after!==digest(old):old.includes('strata-rules-bridge'))throw Error('Changed bridge '+relative);
 }
 if(old.includes(to))continue;
 if(old.split(from).length!==2)throw Error('Rules bridge anchor mismatch: '+relative);
 const text=old.replace(from,to),record=records.find(r=>r.file===relative);
 if(record)record.after=digest(text);else records.push({file:relative,before:digest(old),after:digest(text)});
 if(staged)staged[1]=text;else writes.push([file,text]);
}

const html=source?'index.html':'dist/index.html';
const markup=fs.readFileSync(path.join(host,html),'utf8');
const entry=markup.match(/<script type="module"(?: crossorigin)? src="(\/(?:assets\/[^/]+\.js|src\/main\.tsx))"><\/script>/);
const htmlEdits=[['</head>','  <!-- strata-extensions-bridge API 1 -->\n    <script type="module" src="/extensions/core/ui.mjs"></script>\n  </head>']];
if(entry)htmlEdits.unshift([entry[0],`<script type="module" src="/extensions/core/boot.mjs" data-strata-app="${entry[1]}"></script>`]);
else if(!markup.includes('data-strata-app'))throw Error('Application entry bridge anchor missing');
patch(html,htmlEdits);

if(source){
  patch('src/lib/store.ts',[["    title: `${source.title} (branch)`,", "    ...(globalThis as any).strataExtensionsBranch?.(source.id), // strata-extensions-bridge: provenance only\n    title: `${source.title} (branch)`,"]]);
}else{
  const assets=path.join(host,'dist','assets');
  if(fs.existsSync(assets))for(const name of fs.readdirSync(assets).filter(n=>n.endsWith('.js'))){
    const text=fs.readFileSync(path.join(assets,name),'utf8');
    const match=text.match(/title:`\$\{([A-Za-z_$][\w$]*)\.title\} \(branch\)`,/);
    if(match)patch('dist/assets/'+name,[[match[0], '...(globalThis.strataExtensionsBranch?.('+match[1]+'.id)??{}),/* strata-extensions-bridge */'+match[0]]]);
  }
}
// Native state stays authoritative. These tiny hooks delegate the edit policy
// and UI to external files; no copy of upstream streaming logic is maintained.
{
 const relative=source?'src/lib/store.ts':'dist'+(entry?.[1]??markup.match(/data-strata-app="([^"]+)"/)?.[1]),file=path.join(host,relative);
 const staged=writes.find(([f])=>f===file),old=staged?.[1]??fs.readFileSync(file,'utf8');
 let text=old;
 const edits=source?[
  ['export function rewindTo(messageId: string): string | null {','export function rewindTo(messageId: string): string | null {\n  if ((globalThis as any).strataExtensionsChat) return (globalThis as any).strataExtensionsChat.edit(messageId);'],
  ['export async function retryLast(messageId?: string) {','export async function retryLast(messageId?: string) {\n  if ((globalThis as any).strataExtensionsChat) return (globalThis as any).strataExtensionsChat.retry(messageId);'],
  ['  const pictures=reattach?[]:takeChatPhotos(state.activeSession);','  if (!reattach && await (globalThis as any).strataExtensionsChat?.beforeSend({text,options}) === false) return;\n  const pictures=reattach?[]:((globalThis as any).strataExtensionsChat?.photos(takeChatPhotos(state.activeSession)) ?? takeChatPhotos(state.activeSession));'],
  ['  // A taken-over turn goes on','  Object.assign(userMsg,(globalThis as any).strataExtensionsChat?.user(userMsg)??userMsg);\n  // A taken-over turn goes on'],
  ['export function addQuote(sessionId:', '(globalThis as any).strataExtensionsChatAdapter={get:()=>state,rev:(id:string)=>sessionWriter.rev(id),flush:flushSessions,send:sendMessage,adopt:(s:Session,rev:number)=>{sessionWriter.adopt(s,rev);set({sessions:state.sessions.map(row=>row.id===s.id?s:row)});},transient:(s:Session)=>set({sessions:state.sessions.map(row=>row.id===s.id?s:row)})};\nexport function addQuote(sessionId:'],
 ]:[
  ['function rm(s){if(A.streaming)','function rm(s){if(globalThis.strataExtensionsChat)return globalThis.strataExtensionsChat.edit(s);if(A.streaming)'],
  ['async function xh(s){const o=A.sessions','async function xh(s){if(globalThis.strataExtensionsChat)return globalThis.strataExtensionsChat.retry(s);const o=A.sessions'],
  ['const y=i?[]:tNe(A.activeSession),p=s.trim()','if(!i&&await globalThis.strataExtensionsChat?.beforeSend({text:s,options:o})===false)return;const y=i?[]:(globalThis.strataExtensionsChat?.photos(tNe(A.activeSession))??tNe(A.activeSession)),p=s.trim()'],
  ['lt(w,T=>i?{...T,messages:O?','Object.assign(S,globalThis.strataExtensionsChat?.user(S)??S);lt(w,T=>i?{...T,messages:O?'],
  ['function Mc(s,o,i,r){','globalThis.strataExtensionsChatAdapter={get:()=>A,rev:id=>pt.rev(id),flush:bh,send:Yt,adopt:(s,rev)=>{pt.adopt(s,rev);ie({sessions:A.sessions.map(row=>row.id===s.id?s:row)});},transient:s=>ie({sessions:A.sessions.map(row=>row.id===s.id?s:row)})};function Mc(s,o,i,r){'],
 ];
 for(const [from,to] of edits){if(text.includes(to))continue;if(text.split(from).length!==2)throw Error('Chat management bridge anchor mismatch: '+from.slice(0,80));text=text.replace(from,to);}
 if(text!==old){const record=records.find(r=>r.file===relative);if(record)record.after=digest(text);else records.push({file:relative,before:digest(old),after:digest(text)});if(staged)staged[1]=text;else writes.push([file,text]);}
}
// Reconcile explicit host deletions after browser/last-moment hydration.
{
 const relative=source?'src/lib/chat-sync.ts':'dist'+(entry?.[1]??markup.match(/data-strata-app="([^"]+)"/)?.[1]),file=path.join(host,relative);
 const staged=writes.find(([f])=>f===file),old=staged?.[1]??fs.readFileSync(file,'utf8');
 const from=source?'const recovered = takeLastMomentCopy(browser, sessions, revs);':'E=kNe(i,N,w);return{sessions:E.sessions';
 const to=source?"const recovered = (await import('/extensions/core/chat-recovery.mjs')).excludeDeleted(takeLastMomentCopy(browser, sessions, revs), Reflect.get(list, 'deleted'));":"E=(await import('/extensions/core/chat-recovery.mjs')).excludeDeleted(kNe(i,N,w),y.deleted);return{sessions:E.sessions";
 if(!old.includes(to)){
  if(old.split(from).length!==2)throw Error('Chat recovery bridge anchor mismatch');
  const text=old.replace(from,to),record=records.find(r=>r.file===relative);
  if(record)record.after=digest(text);else records.push({file:relative,before:digest(old),after:digest(text)});
  if(staged)staged[1]=text;else writes.push([file,text]);
 }
}
// Generated adapters are part of the same reviewed plan. A modified adapter
// stops the whole plan before any upstream file can be written.
for(const [relative,text]of [
 ['server/strata-rules-bridge.mjs',"// strata-extensions-bridge: lightweight worker adapter, no host initialization.\nexport const rulesBridge=process.env.STRATA_EXTENSIONS_ENTRY?await import(new URL('./harness-rules.mjs',process.env.STRATA_EXTENSIONS_ENTRY)):null;\n"],
 ['server/strata-extensions-bridge.mjs',"// strata-extensions-bridge ABI 1: implementation stays outside upstream.\nexport const bridge = process.env.STRATA_EXTENSIONS_ENTRY ? await import(process.env.STRATA_EXTENSIONS_ENTRY) : null;\n"],
]){
 const file=path.join(host,relative),old=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
 if(old!==null&&old!==text)throw Error('Generated bridge adapter changed; review before updating: '+relative);
 const previous=fs.existsSync(receiptPath)?JSON.parse(fs.readFileSync(receiptPath,'utf8')).files.find(row=>row.file===relative):null;
 if(previous&&previous.after!==digest(text))throw Error('Generated bridge adapter receipt mismatch: '+relative);
 if(old===null)writes.push([file,text]);
 if(!previous)records.push({file:relative,before:old===null?null:digest(old),after:digest(text)});
}
if(records.length){
  const receipt=path.join(root,'strata-bridge-receipt.json');
  const previous=fs.existsSync(receipt)?JSON.parse(fs.readFileSync(receipt,'utf8')).files:[];
  writes.push([receipt,JSON.stringify({distribution,bridgeSchema,upstream,commit,files:[...previous.filter(row=>!records.some(next=>next.file===row.file)),...records]},null,2)]);
}
if(planning){
 const relative=file=>path.relative(root,file).split(path.sep).join('/');
 // The installer can stage only these files. Include unchanged inputs too so
 // the same contract works when updating an already bridged installation.
 const required=['package.json','server/store.mjs','server/index.mjs','server/agent/agent-bridge.mjs','server/agent/plugins/strata-context.mjs',source?'index.html':'dist/index.html',...(source?['src/lib/store.ts','src/lib/chat-sync.ts']:['dist'+(entry?.[1]??markup.match(/data-strata-app="([^"]+)"/)?.[1])]),'server/strata-rules-bridge.mjs','server/strata-extensions-bridge.mjs'];
 const prior=fs.existsSync(receiptPath)?JSON.parse(fs.readFileSync(receiptPath,'utf8')).files.map(row=>path.join(host,row.file)):[];
 const inputs=[...required.map(file=>path.join(host,file)),...prior,...writes.map(([file])=>file),receiptPath].filter(file=>fs.existsSync(file));
 console.log(JSON.stringify({distribution,bridgeSchema,upstream,commit,source,inputs:[...new Set(inputs.map(relative))],writes:writes.map(([file,text])=>({file:relative(file),before:fs.existsSync(file)?digest(fs.readFileSync(file)):null,after:digest(text),bytes:Buffer.byteLength(text)}))}));
}else{
 for(const [file,text]of writes)fs.writeFileSync(file,text);
 console.log(JSON.stringify(records));
}
