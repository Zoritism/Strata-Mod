import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {digest,effective,inside,readJSON} from '../runtime/core/storage.mjs';
import {detectLayout,nativeConfiguration,planOverlayInstall,applyOverlayInstall,rollbackOverlayInstall,assertTargetClosed,parseArguments,publicPackages} from '../scripts/overlay-install.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),work=path.join(root,'.work','overlay-installer-tests');
fs.mkdirSync(work,{recursive:true});
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value,null,2):value);}
function inventory(folder){
  const result={};
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else result[path.relative(folder,file)]=digest(fs.readFileSync(file));}}
  walk(folder);return result;
}
function fixture(t,{legacy=false}={}){
  const dir=fs.mkdtempSync(path.join(work,'case-')),base=path.join(dir,'Strata'),app=legacy?path.join(base,'app'):base,home=path.join(dir,'native-user');
  write(path.join(app,'strata-desktop.exe'),'synthetic exe');write(path.join(app,'node','node.exe'),'synthetic runtime');
  write(path.join(app,'host','package.json'),{version:'0.2.13'});write(path.join(app,'host','server','test.mjs'),'original bridge input');
  fs.mkdirSync(home,{recursive:true});
  const options={home,env:{},documents:path.join(home,'Documents'),checkClosed:()=>{},buildArtifacts(stage){for(const name of ['Strata Extensions.exe','extensions/bin/RevealFile.exe','extensions/bin/WindowIcon.exe'])write(path.join(stage,name),'synthetic built '+name);},
    planBridge(){const file='host/server/test.mjs',before=digest(fs.readFileSync(path.join(app,file))),after=digest('patched bridge input');return {inputs:['host/package.json',file],writes:before===after?[]:[{file,before,after,bytes:20}]};},
    applyBridge(stage){write(path.join(stage,'host','server','test.mjs'),'patched bridge input');}};
  t.after(()=>{assert(inside(work,fs.realpathSync(dir)));assert(!fs.lstatSync(dir).isSymbolicLink());fs.rmSync(dir,{recursive:true});});
  return {dir,base,app,home,options};
}

test('flat and legacy layouts are detected without changing native profile files',t=>{
  const f=fixture(t),l=fixture(t,{legacy:true});
  assert.equal(detectLayout(f.base).appDir,'.');assert.equal(detectLayout(l.base).appDir,'app');
  write(path.join(l.base,'installation.json'),{custom:true});assert.equal(detectLayout(l.app).base,l.base);
  const before=inventory(f.dir),plan=planOverlayInstall(f.base,f.options);
  assert.deepEqual(inventory(f.dir),before);assert.equal(plan.storage.profileMode,'native');assert.equal(plan.storage.strict,false);
  assert.equal(plan.installation.userDataImported,undefined);
  const metadata=JSON.parse(plan.files.find(row=>row.target===path.join(f.base,'installation.json')).content);
  assert.equal(metadata.appDir,'.');assert.equal(metadata.userDataImported,true);
  assert.deepEqual(Object.keys(plan.registry.extensions).sort(),[...publicPackages].sort());
  const packageIds=[...new Set(plan.files.filter(row=>row.kind==='package').map(row=>path.relative(plan.paths.extensionPackages,row.target).split(path.sep)[0]))].sort();
  assert.deepEqual(packageIds,[...publicPackages].sort());
});

test('native inheritance projects only path fields and preserves saved direct models',t=>{
  const f=fixture(t),nativeHome=path.join(f.home,'.strata'),models=path.join(nativeHome,'models'),install=path.join(f.home,'custom-control');
  write(path.join(nativeHome,'data','state.json'),{modelsDir:models,serving:{apiKey:'synthetic-private-value'},unknown:'retained'});
  write(path.join(nativeHome,'data','native-host.json'),{installDir:install,downloadDirectory:path.join(f.home,'unused-download'),password:'synthetic-secret'});
  const before=inventory(f.dir),storage=nativeConfiguration(f.base,{...f.options,dataRoot:path.join(f.dir,'overlay-data')}),p=effective(storage,f.base);
  assert.equal(p.models,models);assert.equal(p.install,install);assert.equal(p.home,nativeHome);assert.equal(storage.nativePaths.inherited.models,models);
  assert.equal(storage.nativePaths.settingsFile,path.join(f.home,'AppData','Local','Strata','app-settings.json'));
  assert.equal(storage.nativePaths.terminalSettingsFile,path.join(f.home,'AppData','Roaming','Strata','settings.json'));
  for(const key of ['desktop','cache','temp','compat','extensionData'])assert(!Object.hasOwn(storage.nativePaths.inherited,key));
  assert.equal(p.extensionPackages,path.join(f.base,'extensions','packages'));assert.equal(p.extensionData,path.join(f.dir,'overlay-data','extensions'));
  assert(!JSON.stringify(storage).includes('synthetic-private-value'));assert(!JSON.stringify(storage).includes('synthetic-secret'));
  assert.deepEqual(inventory(f.dir),before);
});

test('unsaved native models preserve a legacy library and respect explicit environment selection',t=>{
  const f=fixture(t),legacy=path.join(f.home,'.strata','models');write(path.join(legacy,'group','existing.gguf'),'synthetic filename fixture');
  assert.equal(effective(nativeConfiguration(f.base,f.options),f.base).models,legacy);
  const selected=path.join(f.home,'selected-models');
  assert.equal(effective(nativeConfiguration(f.base,{...f.options,env:{STRATA_MODELS_DIR:selected}}),f.base).models,selected);
});

test('existing storage, add-ons, disabled state and settings survive a complete overlay install',t=>{
  const f=fixture(t,{legacy:true}),storage={schema:1,revision:7,root:'../custom-data',strict:false,paths:{extensionPackages:'../custom-packages'},custom:{keep:true}};
  write(path.join(f.base,'storage.json'),storage);write(path.join(f.base,'installation.json'),{schema:1,userDataImported:false,customMetadata:'keep'});
  write(path.join(f.base,'extensions.json'),{schema:1,unknown:'keep',extensions:{addon:{id:'addon',version:'2.0.0',enabled:true,custom:'keep'},'chat-rules':{id:'chat-rules',version:'0.0.1',enabled:false,userFlag:42}}});
  const settings=path.join(f.dir,'custom-data','extensionData','addon','settings.json');write(settings,{secret:'synthetic-settings'});
  const storageBytes=fs.readFileSync(path.join(f.base,'storage.json')),settingsBytes=fs.readFileSync(settings);
  const result=applyOverlayInstall(planOverlayInstall(f.base,f.options),f.options),registry=readJSON(path.join(f.base,'extensions.json'));
  assert.deepEqual(fs.readFileSync(path.join(f.base,'storage.json')),storageBytes);assert.deepEqual(fs.readFileSync(settings),settingsBytes);
  assert.deepEqual(registry.extensions.addon,{id:'addon',version:'2.0.0',enabled:true,custom:'keep'});assert.equal(registry.unknown,'keep');
  assert.equal(registry.extensions['chat-rules'].enabled,false);assert.equal(registry.extensions['chat-rules'].userFlag,42);assert.equal(registry.extensions['chat-rules'].previous,'0.0.1');
  const metadata=readJSON(path.join(f.base,'installation.json'));assert.equal(metadata.customMetadata,'keep');assert.equal(metadata.userDataImported,false);assert.equal(metadata.appDir,'app');
  const receipt=readJSON(path.join(result.backupRoot,'receipt.json'));assert.equal(receipt.status,'installed');
  assert(!receipt.files.some(row=>row.target===settings||row.target.endsWith('storage.json')));
  assert.equal(fs.readFileSync(path.join(f.base,'tools','lan-ui','gateway.mjs'),'utf8'),fs.readFileSync(path.join(root,'scripts','lan-ui','gateway.mjs'),'utf8'));
  assert.throws(()=>planOverlayInstall(f.base,{...f.options,dataRoot:'new-root'}),/cannot replace/);
});

test('unknown anchors and immutable version conflicts fail before any installation write',t=>{
  const f=fixture(t),before=inventory(f.dir);
  assert.throws(()=>planOverlayInstall(f.base,{...f.options,planBridge(){throw Error('unknown upstream anchor');}}),/unknown upstream/);assert.deepEqual(inventory(f.dir),before);
  const info=readJSON(path.join(root,'extensions','chat-rules','extension.json'));
  write(path.join(f.base,'extensions','packages','chat-rules',info.version,'changed.mjs'),'user-modified');const withConflict=inventory(f.dir);
  assert.throws(()=>planOverlayInstall(f.base,f.options),/immutable version/);assert.deepEqual(inventory(f.dir),withConflict);
});

test('concurrent checked-file change aborts before installed files or backups are written',t=>{
  const f=fixture(t),plan=planOverlayInstall(f.base,f.options);write(path.join(f.app,'host','server','test.mjs'),'concurrent upstream edit');
  const before=inventory(f.dir);assert.throws(()=>applyOverlayInstall(plan,f.options),/checked file changed/);assert.deepEqual(inventory(f.dir),before);
});

test('a late commit failure restores every replaced file and removes only newly written files',t=>{
  const f=fixture(t);write(path.join(f.base,'extensions','core','existing.mjs'),'user-owned unknown core file');
  const before=inventory(f.base),plan=planOverlayInstall(f.base,f.options);
  assert.throws(()=>applyOverlayInstall(plan,{...f.options,afterWrite(row){if(row.kind==='bridge')throw Error('synthetic disk failure');}}),/synthetic disk failure/);
  const after=inventory(f.base);for(const [file,hash]of Object.entries(before))assert.equal(after[file],hash);
  assert(!Object.keys(after).some(file=>!Object.hasOwn(before,file)&&!file.startsWith('extensions'+path.sep+'backups'+path.sep)));
  const backup=fs.readdirSync(path.join(f.base,'extensions','backups'))[0],receipt=readJSON(path.join(f.base,'extensions','backups',backup,'receipt.json'));assert.equal(receipt.status,'rolled-back');
});

test('explicit rollback rejects later edits as a whole, then restores original bytes',t=>{
  const f=fixture(t),before=inventory(f.base),result=applyOverlayInstall(planOverlayInstall(f.base,f.options),f.options),registryFile=path.join(f.base,'extensions.json'),registryBytes=fs.readFileSync(registryFile);
  write(registryFile,'later user edit');const edited=inventory(f.base);
  assert.throws(()=>rollbackOverlayInstall(f.base,result.backupRoot,f.options),/changed since installation/);assert.deepEqual(inventory(f.base),edited);
  fs.writeFileSync(registryFile,registryBytes);const preview=rollbackOverlayInstall(f.base,result.backupRoot,{...f.options,dryRun:true});assert(preview.files>0);assert(fs.existsSync(registryFile));
  assert.equal(rollbackOverlayInstall(f.base,result.backupRoot,f.options).rolledBack,true);
  const after=inventory(f.base);for(const [file,hash]of Object.entries(before))assert.equal(after[file],hash);
  assert(!Object.keys(after).some(file=>!Object.hasOwn(before,file)&&!file.startsWith('extensions'+path.sep+'backups'+path.sep)));
});

test('closed-app preflight scopes desktop and host processes to the selected installation',t=>{
  const f=fixture(t),layout=detectLayout(f.base),run=rows=>()=>JSON.stringify(rows);
  assert.doesNotThrow(()=>assertTargetClosed(layout,{platform:'win32',pid:10,run:run([{ProcessId:11,ExecutablePath:path.join(f.dir,'other','strata-desktop.exe')},{ProcessId:10,ExecutablePath:path.join(f.app,'node','node.exe'),CommandLine:f.app}])}));
  assert.throws(()=>assertTargetClosed(layout,{platform:'win32',pid:10,run:run([{ProcessId:12,ExecutablePath:path.join(f.app,'strata-desktop.exe')}])}),/Close Strata/);
  assert.throws(()=>assertTargetClosed(layout,{platform:'win32',pid:10,run:run([{ProcessId:13,ExecutablePath:path.join(f.app,'node','node.exe'),CommandLine:'node '+path.join(f.app,'host','server','index.mjs')}])}),/Close Strata/);
  assert.throws(()=>assertTargetClosed(layout,{platform:'win32',run(){throw Error('denied');}}),/Could not verify/);
});

test('interrupted commit recovers only after its recorded lock owner is dead',t=>{
  const f=fixture(t),result=applyOverlayInstall(planOverlayInstall(f.base,f.options),f.options),receiptFile=path.join(result.backupRoot,'receipt.json'),receipt=readJSON(receiptFile);
  // A crash may leave some files original and others replaced. Recovery accepts
  // exactly those two hashes, independently of how far the commit progressed.
  const bridge=receipt.files.find(row=>row.kind==='bridge');fs.writeFileSync(bridge.target,fs.readFileSync(path.join(result.backupRoot,bridge.backup)));
  receipt.status='prepared';write(receiptFile,receipt);const lock=path.join(f.base,'.strata-overlay-install.lock');write(lock,'424242');
  const before=inventory(f.base);assert.throws(()=>rollbackOverlayInstall(f.base,result.backupRoot,{...f.options,isProcessAlive:()=>true}),/installation lock/);assert.deepEqual(inventory(f.base),before);
  assert.equal(rollbackOverlayInstall(f.base,result.backupRoot,{...f.options,isProcessAlive:pid=>{assert.equal(pid,424242);return false;}}).rolledBack,true);
  assert(!fs.existsSync(lock));assert.equal(fs.readFileSync(bridge.target,'utf8'),'original bridge input');assert(!fs.existsSync(path.join(f.base,'storage.json')));
});

const cleanRelease=path.resolve(process.env.STRATA_TEST_CLEAN_RELEASE??path.join(root,'.work','upgrade-0213','release'));
test('real 0.2.13 bridge and Windows helpers install only staged local source', {skip:!fs.existsSync(path.join(cleanRelease,'strata-desktop.exe'))||process.platform!=='win32'},t=>{
  const f=fixture(t),release=cleanRelease,bridgeScript=path.join(root,'scripts','bridge.mjs');
  const upstreamPlan=JSON.parse(execFileSync(process.execPath,[bridgeScript,release,'--plan'],{encoding:'utf8'}));
  for(const file of upstreamPlan.inputs)if(fs.existsSync(path.join(release,file)))write(path.join(f.app,file),fs.readFileSync(path.join(release,file)));
  write(path.join(f.app,'strata-desktop.exe'),fs.readFileSync(path.join(release,'strata-desktop.exe')));
  const {planBridge,applyBridge,buildArtifacts,...options}=f.options;
  const plan=planOverlayInstall(f.base,options),result=applyOverlayInstall(plan,options);
  assert.deepEqual(fs.readdirSync(plan.paths.extensionPackages).sort(),[...publicPackages].sort());
  for(const row of plan.files)assert.equal(digest(fs.readFileSync(row.target)),row.after);
  assert(fs.statSync(path.join(f.base,'Strata Extensions.exe')).size>2000);
  const repeated=planOverlayInstall(f.base,options);assert.equal(repeated.bridge.writes.length,0);
  assert(!repeated.files.some(row=>['configuration','registry','metadata','core','package'].includes(row.kind)));
  assert.equal(readJSON(path.join(result.backupRoot,'receipt.json')).status,'installed');
});

test('CLI parser accepts dry-run and explicit rollback without ambiguous extra targets',()=>{
  assert.deepEqual(parseArguments(['target','--rollback','backup','--dry-run']),{target:'target',options:{rollback:'backup',dryRun:true}});
  assert.throws(()=>parseArguments(['target','--data-root']),/requires/);assert.throws(()=>parseArguments(['target','second']),/Usage/);
});
