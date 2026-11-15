// Strata Extensions overlay installer. Author: Zoritism. No downloads or dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {atomicJSON,readJSON,effective,digest,inside,realLocation} from '../runtime/core/storage.mjs';
import {files,manifest} from '../runtime/core/packages.mjs';
import {buildShellHelper,buildWindowIcon} from './shell-helper/build.mjs';

export const publicPackages=['folder-paths','chat-rules','strata-ui'];
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hashFile=file=>{
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!stat)return null;
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('Expected a regular file without a link: '+file);
  return digest(fs.readFileSync(file));
};
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const relative=(base,target)=>path.relative(base,target).replaceAll('\\','/')||'.';

/** Accept a native flat directory, legacy root/app layout, or the desktop EXE. */
export function detectLayout(input){
  let folder=path.resolve(input);
  if(fs.existsSync(folder)&&fs.statSync(folder).isFile()){
    if(path.basename(folder).toLowerCase()!=='strata-desktop.exe')throw Error('Target must contain strata-desktop.exe.');
    folder=path.dirname(folder);
  }
  folder=fs.realpathSync(folder);
  let base=folder,app=folder;
  if(!fs.existsSync(path.join(app,'strata-desktop.exe')))app=path.join(folder,'app');
  else if(path.basename(folder).toLowerCase()==='app'&&['installation.json','storage.json'].some(name=>fs.existsSync(path.join(path.dirname(folder),name))))base=path.dirname(folder);
  for(const name of ['strata-desktop.exe','host/package.json','node/node.exe'])if(!fs.statSync(path.join(app,name),{throwIfNoEntry:false})?.isFile())throw Error('Incomplete Strata application: '+name);
  const version=readJSON(path.join(app,'host/package.json')).version;
  if(version!=='0.2.13')throw Error('Expected Strata 0.2.13; found '+version+'.');
  return {base,app,appDir:relative(base,app),version};
}

/** Read only path fields for inheritance. Do not retain or print native settings,
 * API keys, chats or histories in plans, receipts or backups. */
function pathSettings(file,keys){
  if(!fs.existsSync(file))return {};
  if(fs.statSync(file).size>4*1024*1024)throw Error('Native path settings exceed the expected size: '+path.basename(file));
  const value=readJSON(file),result={};
  for(const key of keys)if(typeof value?.[key]==='string'&&path.isAbsolute(value[key]))result[key]=path.resolve(value[key]);
  return result;
}

function documentsFolder(env,home){
  if(env.STRATA_DOCUMENTS_DIR)return path.resolve(env.STRATA_DOCUMENTS_DIR);
  if(process.platform==='win32'){
    try{return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments')"],{encoding:'utf8',timeout:5000,windowsHide:true}).trim()||path.join(home,'Documents');}catch{}
  }
  return path.join(home,'Documents');
}

// Match the native legacy-library choice without opening model contents. This
// bounded directory walk observes only filenames, and never follows links.
function hasLegacyWeights(folder,depth=0){
  try{return fs.readdirSync(folder,{withFileTypes:true}).some(entry=>
    entry.isFile()&&/\.gguf(?:\.part|\.partial)?$/i.test(entry.name)||
    entry.isDirectory()&&depth<4&&hasLegacyWeights(path.join(folder,entry.name),depth+1));}catch{return false;}
}
function writableAncestor(folder){
  let at=folder;
  while(!fs.existsSync(at)&&path.dirname(at)!==at)at=path.dirname(at);
  try{fs.accessSync(at,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);return true;}catch{return false;}
}

/** Native inheritance is explicit; --data-root moves only overlay-owned data.
 * Existing native files remain at their original paths and are never copied. */
export function nativeConfiguration(base,{dataRoot='./extension-data',env=process.env,home=os.homedir(),documents}={}){
  const root=path.resolve(base,dataRoot),nativeHome=path.resolve(env.STRATA_HOME||path.join(home,'.strata'));
  const local=env.LOCALAPPDATA||path.join(home,'AppData','Local'),roaming=env.APPDATA||path.join(home,'AppData','Roaming');
  const components=path.resolve(env.STRATA_COMPONENTS_DIR||path.join(local,'Strata','components'));
  const settings=path.resolve(env.STRATA_SETTINGS_FILE||path.join(path.dirname(components),'app-settings.json'));
  const nativeState=pathSettings(path.join(nativeHome,'data','state.json'),['modelsDir']);
  const nativeHost=pathSettings(path.join(nativeHome,'data','native-host.json'),['installDir']);
  const docs=documents??documentsFolder(env,home);
  const preferredModels=env.STRATA_MODELS_DIR||path.join(docs,'Strata','Models');
  const legacyModels=path.join(nativeHome,'models');
  const modelsDirectory=nativeState.modelsDir||(!env.STRATA_MODELS_DIR&&hasLegacyWeights(legacyModels)?realLocation(legacyModels):null)||(writableAncestor(preferredModels)?preferredModels:legacyModels);
  const workspaceHome=env.USERPROFILE||env.HOME||home;
  const workspace=env.STRATA_WORKSPACE||[path.join(workspaceHome,'Documents','Strata','Workspace'),path.join(workspaceHome,'Strata','Workspace'),workspaceHome].find(writableAncestor);
  const nativePaths={home:nativeHome,modelsDirectory:path.resolve(modelsDirectory),components,
    install:path.resolve(env.STRATA_INSTALL_DIR||nativeHost.installDir||path.join(path.dirname(components),'install')),
    profiles:path.resolve(env.STRATA_PROFILE_DIR||path.join(roaming,'Strata','profiles')),
    runtime:path.resolve(env.STRATA_RUNTIME_DIR||path.join(local,'Strata','runtime')),
    tuning:path.resolve(env.STRATA_TUNE_DIR||path.join(local,'Strata','tuning')),
    timeskip:path.resolve(env.STRATA_TIMESKIP_DIR||path.join(local,'Strata','time-skip')),
    workspace:path.resolve(workspace),
    webview:path.resolve(env.WEBVIEW2_USER_DATA_FOLDER||path.join(local,'ai.strata.desktop')),
    settingsFile:settings,terminalSettingsFile:path.resolve(env.STRATA_TERMINAL_SETTINGS_FILE||path.join(roaming,'Strata','settings.json'))};
  const inherited={home:nativePaths.home,models:nativePaths.modelsDirectory,components:nativePaths.components,install:nativePaths.install,
      profiles:nativePaths.profiles,runtime:nativePaths.runtime,tuning:nativePaths.tuning,timeskip:nativePaths.timeskip,
      workspace:nativePaths.workspace,webview:nativePaths.webview};
  nativePaths.inherited={...inherited};
  return {schema:1,revision:1,strict:false,profileMode:'native',root:relative(base,root),nativePaths,
    paths:{...inherited,extensionPackages:relative(root,path.join(base,'extensions','packages')),extensionData:'extensions'}};
}

/** Inspect process paths without printing command lines, which may contain
 * private values. Never terminate any process, including unrelated Strata. */
export function assertTargetClosed(layout,{platform=process.platform,run=execFileSync,pid=process.pid}={}){
  if(platform!=='win32')return;
  const script='$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress';
  let rows;
  try{rows=JSON.parse(run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000}));}catch{throw Error('Could not verify that this Strata installation is closed. Close it and retry.');}
  const base=layout.base.toLowerCase(),app=layout.app.toLowerCase();
  for(const row of Array.isArray(rows)?rows:[rows]){
    if(!row||row.ProcessId===pid)continue;
    const exe=String(row.ExecutablePath??'').toLowerCase(),command=String(row.CommandLine??'').toLowerCase();
    const runningDesktop=exe===path.join(app,'strata-desktop.exe').toLowerCase()||exe===path.join(base,'Strata Extensions.exe').toLowerCase();
    const ownedHost=/[\\/]node\.exe$/.test(exe)&&[path.join(app,'host'),path.join(base,'extensions','core')].some(folder=>command.includes(folder.toLowerCase()));
    if(runningDesktop||ownedHost)throw Error('Close Strata in the selected installation before applying this overlay (process '+row.ProcessId+').');
  }
}

function bridgePlan(app,sourceRoot){
  const output=execFileSync(process.execPath,[path.join(sourceRoot,'scripts','bridge.mjs'),app,'--plan'],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  return JSON.parse(output.trim());
}
function assertRelative(file){if(typeof file!=='string'||path.isAbsolute(file)||file.split(/[\\/]/).includes('..'))throw Error('Unsafe bridge path.');return file;}
function noParentLinks(file){
  for(let dir=path.dirname(file);;dir=path.dirname(dir)){
    const stat=fs.lstatSync(dir,{throwIfNoEntry:false});
    if(stat?.isSymbolicLink())throw Error('Installation refuses a linked destination directory: '+dir);
    if(path.dirname(dir)===dir)break;
  }
}
function addFile(plan,target,{source,content,kind}){
  target=path.resolve(target);
  noParentLinks(target);
  if(plan.files.some(row=>row.target===target))throw Error('Duplicate installer target: '+target);
  const after=content?digest(content):hashFile(source),before=hashFile(target);
  if(after!==before)plan.files.push({target,source,content,kind,before,after});
}

/** All anchors, package collisions and the existing registry are checked before
 * writing anything. The returned plan contains paths/hashes, no native settings. */
export function planOverlayInstall(input,options={}){
  const sourceRoot=path.resolve(options.sourceRoot??repository),layout=detectLayout(input);
  (options.checkClosed??assertTargetClosed)(layout);
  const storageFile=path.join(layout.base,'storage.json'),existingStorage=fs.existsSync(storageFile);
  for(const file of ['storage.json','installation.json','extensions.json'])hashFile(path.join(layout.base,file));
  if(existingStorage&&options.dataRoot!==undefined)throw Error('--data-root cannot replace an existing storage.json; change paths inside Strata.');
  const storage=existingStorage?readJSON(storageFile):nativeConfiguration(layout.base,options),paths=effective(storage,layout.base);
  const registryFile=path.join(layout.base,'extensions.json'),registry=readJSON(registryFile,{schema:1,extensions:{}});
  if(!registry.extensions||typeof registry.extensions!=='object'||Array.isArray(registry.extensions))throw Error('Invalid existing extension registry.');
  const installationFile=path.join(layout.base,'installation.json'),installation=readJSON(installationFile,{});
  const bridge=(options.planBridge??bridgePlan)(layout.app,sourceRoot);
  if(!Array.isArray(bridge.inputs)||!Array.isArray(bridge.writes))throw Error('Bridge does not provide a complete preflight plan.');
  bridge.inputs.forEach(assertRelative);bridge.writes.forEach(row=>assertRelative(row.file));
  const plan={...layout,sourceRoot,paths,storage,bridge,files:[],registry,installation,registryFile,installationFile,
    sourceInputs:[],guards:[storageFile,registryFile,installationFile].map(file=>({file,sha256:hashFile(file)}))};
  for(const file of ['scripts/bridge.mjs','scripts/shell-helper/build.mjs','scripts/shell-helper/RevealFile.cs','scripts/shell-helper/WindowIcon.cs','bridges/Launcher.cs']){
    const source=path.join(sourceRoot,file);plan.sourceInputs.push({file:source,sha256:hashFile(source)});
  }
  for(const file of bridge.inputs)plan.guards.push({file:path.join(layout.app,file),sha256:hashFile(path.join(layout.app,file))});
  for(const row of files(path.join(sourceRoot,'runtime','core'))){
    const source=path.join(sourceRoot,'runtime','core',row.file);plan.sourceInputs.push({file:source,sha256:row.sha256});
    addFile(plan,path.join(layout.base,'extensions','core',row.file),{source,kind:'core'});
  }
  // The public strata-ui package owns these local LAN helpers. Only known
  // source names ship; an operator's certificate/config files never enter it.
  for(const name of ['control.ps1','Enable-LAN.cmd','firewall.ps1','gateway.mjs','Launch.cmd','launch.ps1','layout.ps1','login.mjs','prepare.ps1','README.md','startup.ps1']){
    const source=path.join(sourceRoot,'scripts','lan-ui',name);plan.sourceInputs.push({file:source,sha256:hashFile(source)});
    addFile(plan,path.join(layout.base,'tools','lan-ui',name),{source,kind:'lan-helper'});
  }
  let registryChanged=false;
  for(const id of publicPackages){
    const folder=path.join(sourceRoot,'extensions',id),info=manifest(folder),inventory=files(folder),current=registry.extensions[id];
    if(info.id!==id)throw Error('Unexpected public package identity.');
    const destination=realLocation(path.join(paths.extensionPackages,id,info.version));
    if(fs.existsSync(destination)&&JSON.stringify(files(destination))!==JSON.stringify(inventory))throw Error('Installed package '+id+' '+info.version+' differs; review it before replacing an immutable version.');
    for(const row of inventory){const source=path.join(folder,row.file);plan.sourceInputs.push({file:source,sha256:row.sha256});addFile(plan,path.join(destination,row.file),{source,kind:'package'});}
    if(current?.version!==info.version||JSON.stringify(current.inventory)!==JSON.stringify(inventory)){
      registry.extensions[id]={...current,...info,enabled:current?.enabled??true,previous:current?.version??null,installedAt:new Date().toISOString(),inventory};registryChanged=true;
    }
  }
  if(!existingStorage)addFile(plan,storageFile,{content:json(storage),kind:'configuration'});
  if(registryChanged)addFile(plan,registryFile,{content:json(registry),kind:'registry'});
  const installed={...installation,schema:installation.schema??1,kind:'overlay',overlayVersion:'0.1.0',upstreamVersion:layout.version,
    appDir:layout.appDir,profileMode:storage.profileMode??installation.profileMode??'managed',userDataImported:existingStorage?installation.userDataImported??true:true,author:'Zoritism'};
  if(JSON.stringify(installed)!==JSON.stringify(installation))addFile(plan,installationFile,{content:json({...installed,overlayInstalledAt:new Date().toISOString()}),kind:'metadata'});
  for(const row of bridge.writes){const target=path.join(layout.app,row.file);noParentLinks(target);plan.files.push({target,kind:'bridge',before:row.before,after:row.after,bridgeFile:row.file});}
  // Compiled outputs are built in staging only, then enter the same transaction.
  plan.buildTargets=['Strata Extensions.exe','extensions/bin/RevealFile.exe','extensions/bin/WindowIcon.exe'];
  for(const target of plan.buildTargets)plan.guards.push({file:path.join(layout.base,target),sha256:hashFile(path.join(layout.base,target))});
  if(!options.buildArtifacts&&process.platform==='win32'&&!fs.existsSync(compilerPath()))throw Error('Existing .NET Framework compiler not found; no tool will be downloaded.');
  return plan;
}

const compilerPath=()=>path.join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
/** Build only our launcher/helpers with the installed Framework compiler. The
 * icon comes from the target EXE, never from redistributed upstream assets. */
function buildArtifacts(stage,plan){
  buildShellHelper(stage);buildWindowIcon(stage);
  const icon=path.join(stage,'desktop.ico');
  const script='$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Drawing; $icon=[Drawing.Icon]::ExtractAssociatedIcon($env:SX_OVERLAY_EXE); if(!$icon){throw "No desktop icon"}; $stream=[IO.File]::Create($env:SX_OVERLAY_ICON); try{$icon.Save($stream)}finally{$stream.Dispose();$icon.Dispose()}';
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,env:{...process.env,SX_OVERLAY_EXE:path.join(plan.app,'strata-desktop.exe'),SX_OVERLAY_ICON:icon}});
  execFileSync(compilerPath(),['/nologo','/target:winexe','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Runtime.Serialization.dll','/win32icon:'+icon,'/out:'+path.join(stage,'Strata Extensions.exe'),path.join(plan.sourceRoot,'bridges','Launcher.cs')],{windowsHide:true,stdio:'pipe'});
}

function verifyInputs(plan){
  for(const row of [...plan.guards,...plan.sourceInputs])if(hashFile(row.file)!==row.sha256)throw Error('A checked file changed during installation: '+row.file);
  for(const row of plan.files){noParentLinks(row.target);if(hashFile(row.target)!==row.before)throw Error('A destination changed during installation: '+row.target);}
}
function atomicBytes(file,bytes){
  fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.overlay-'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,bytes,{flag:'wx'});if(hashFile(temporary)!==digest(bytes))throw Error('Staged write verification failed.');fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function processAlive(pid){
  try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
/** Only explicit rollback may reclaim the installer's own stale lock. An
 * unreadable/unknown PID or a still-live owner always requires waiting. */
function acquireLock(lock,{recover=false,isProcessAlive=processAlive}={}){
  if(fs.existsSync(lock)){
    const before=hashFile(lock),owner=fs.readFileSync(lock,'utf8');
    if(!recover||!/^\d{1,10}$/.test(owner)||Number(owner)<1||isProcessAlive(Number(owner)))throw Error('An installation lock exists. Wait for its owner, or use --rollback with its backup after the owner has exited.');
    if(hashFile(lock)!==before)throw Error('The installation lock changed; retry recovery.');
    fs.unlinkSync(lock);
  }
  const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid));return fd;
}

/** Stage and verify first, back up each exact replaced file, then commit. A
 * failure restores changed files; no profile/settings directory is copied. */
export function applyOverlayInstall(plan,options={}){
  (options.checkClosed??assertTargetClosed)(plan);verifyInputs(plan);
  const backupRoot=path.join(plan.base,'extensions','backups','overlay-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  const stage=path.join(backupRoot,'stage'),stageApp=path.join(stage,'upstream'),lock=path.join(plan.base,'.strata-overlay-install.lock');
  const fd=acquireLock(lock);let receipt,committed=[];
  try{
    fs.mkdirSync(stageApp,{recursive:true});
    for(const file of plan.bridge.inputs){const source=path.join(plan.app,file);if(fs.existsSync(source)){const target=path.join(stageApp,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}}
    if(options.applyBridge)options.applyBridge(stageApp,plan);
    else execFileSync(process.execPath,[path.join(plan.sourceRoot,'scripts','bridge.mjs'),stageApp],{windowsHide:true,stdio:'pipe',maxBuffer:8*1024*1024});
    for(const row of plan.files.filter(row=>row.kind==='bridge')){row.source=path.join(stageApp,row.bridgeFile);if(hashFile(row.source)!==row.after)throw Error('Bridge staging differs from preflight: '+row.bridgeFile);}
    (options.buildArtifacts??buildArtifacts)(stage,plan);
    for(const name of plan.buildTargets)addFile(plan,path.join(plan.base,name),{source:path.join(stage,name),kind:'helper'});
    for(const row of plan.files){
      const content=row.content??fs.readFileSync(row.source);
      if(digest(content)!==row.after)throw Error('Source changed during staging: '+row.target);
      row.staged=path.join(stage,'files',String(plan.files.indexOf(row)));fs.mkdirSync(path.dirname(row.staged),{recursive:true});fs.writeFileSync(row.staged,content);
    }
    (options.checkClosed??assertTargetClosed)(plan);verifyInputs(plan);
    receipt={schema:1,target:plan.base,appDir:plan.appDir,upstreamVersion:plan.version,status:'prepared',at:new Date().toISOString(),files:plan.files.map((row,i)=>({target:row.target,before:row.before,after:row.after,kind:row.kind,backup:row.before?'files/'+i:null}))};
    for(const [i,row]of plan.files.entries())if(row.before){const backup=path.join(backupRoot,'files',String(i));fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(row.target,backup);if(hashFile(backup)!==row.before)throw Error('Backup verification failed.');}
    atomicJSON(path.join(backupRoot,'receipt.json'),receipt);
    for(const row of plan.files){atomicBytes(row.target,fs.readFileSync(row.staged));committed.push(row);options.afterWrite?.(row,committed.length);}
    for(const row of plan.files)if(hashFile(row.target)!==row.after)throw Error('Installed file verification failed.');
    receipt.status='installed';receipt.completedAt=new Date().toISOString();atomicJSON(path.join(backupRoot,'receipt.json'),receipt);
    return {installed:true,files:plan.files.length,backupRoot,appDir:plan.appDir,packages:publicPackages};
  }catch(error){
    const failures=[];
    for(const row of committed.reverse())try{
      if(hashFile(row.target)!==row.after)throw Error('File changed after installation began.');
      const record=receipt.files.find(record=>record.target===row.target);
      if(record.backup)atomicBytes(row.target,fs.readFileSync(path.join(backupRoot,record.backup)));else fs.unlinkSync(row.target);
    }catch(rollback){failures.push({target:row.target,reason:rollback.message});}
    if(receipt){receipt.status=failures.length?'rollback-incomplete':'rolled-back';receipt.rollbackFailures=failures;atomicJSON(path.join(backupRoot,'receipt.json'),receipt);}
    throw Error(error.message+(failures.length?' Rollback needs attention: '+backupRoot:''));
  }finally{
    fs.closeSync(fd);fs.unlinkSync(lock);
    // This exact stage is ours; keep backup files/receipt for explicit rollback.
    if(fs.existsSync(stage)&&inside(backupRoot,fs.realpathSync(stage))&&!fs.lstatSync(stage).isSymbolicLink())fs.rmSync(stage,{recursive:true});
  }
}

/** Explicit recovery also handles a process interrupted after a partial commit.
 * Validate every destination and backup before restoring any bytes. A newer
 * user edit stops rollback; the installer never silently overwrites it. */
export function rollbackOverlayInstall(input,backup,options={}){
  const layout=detectLayout(input),backupRoot=fs.realpathSync(backup),receiptFile=path.join(backupRoot,'receipt.json');
  if(!inside(path.join(layout.base,'extensions','backups'),backupRoot))throw Error('Rollback receipt must belong to this installation.');
  const receipt=readJSON(receiptFile);
  if(receipt.schema!==1||path.resolve(receipt.target)!==layout.base||!Array.isArray(receipt.files)||!['installed','prepared','rollback-incomplete','rolled-back'].includes(receipt.status))throw Error('Invalid overlay rollback receipt.');
  const storage=readJSON(path.join(layout.base,'storage.json'),{schema:1,root:'.',paths:{extensionPackages:'extensions/packages'}});
  const packageRoot=realLocation(effective(storage,layout.base).extensionPackages),seen=new Set(),changes=[];
  for(const row of receipt.files){
    const target=path.resolve(row.target);
    if(seen.has(target)||(!inside(layout.base,target)&&!inside(packageRoot,target)))throw Error('Unsafe rollback destination.');
    seen.add(target);noParentLinks(target);
    if(row.before!==null&&(!/^files\/\d+$/.test(row.backup)||hashFile(path.join(backupRoot,row.backup))!==row.before))throw Error('Rollback backup verification failed.');
    const current=hashFile(target);
    if(current!==row.before&&current!==row.after)throw Error('A file changed since installation; rollback stopped: '+target);
    if(current!==row.before)changes.push({...row,target});
  }
  (options.checkClosed??assertTargetClosed)(layout);
  if(options.dryRun)return {dryRun:true,rollback:true,files:changes.length,backupRoot};
  const lock=path.join(layout.base,'.strata-overlay-install.lock'),fd=acquireLock(lock,{recover:true,isProcessAlive:options.isProcessAlive??processAlive});
  try{
    for(const row of changes.reverse()){
      if(hashFile(row.target)!==row.after)throw Error('A file changed while rollback was running: '+row.target);
      if(row.before===null)fs.unlinkSync(row.target);else atomicBytes(row.target,fs.readFileSync(path.join(backupRoot,row.backup)));
    }
    receipt.status='rolled-back';receipt.rolledBackAt=new Date().toISOString();atomicJSON(receiptFile,receipt);
    return {rolledBack:true,files:changes.length,backupRoot};
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}

export function parseArguments(args){
  const options={};let target;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--dry-run')options.dryRun=true;
    else if(args[i]==='--rollback'){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('--rollback requires a backup directory.');options.rollback=args[++i];}
    else if(args[i]==='--data-root'){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('--data-root requires a directory.');options.dataRoot=args[++i];}
    else if(args[i].startsWith('--')||target)throw Error('Usage: install.cmd <Strata directory> [--data-root <directory>] [--dry-run]');
    else target=args[i];
  }
  if(!target)throw Error('Usage: install.cmd <Strata directory> [--data-root <directory>] [--dry-run]');
  return {target,options};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const {target,options}=parseArguments(process.argv.slice(2));
    if(options.rollback){if(options.dataRoot)throw Error('--rollback cannot be combined with --data-root.');console.log(JSON.stringify(rollbackOverlayInstall(target,options.rollback,options),null,2));}
    else{
    const plan=planOverlayInstall(target,options);
    if(options.dryRun)console.log(JSON.stringify({dryRun:true,target:plan.base,appDir:plan.appDir,profileMode:plan.storage.profileMode??'managed',packages:publicPackages,changes:plan.files.map(({target,kind,before,after})=>({target,kind,before,after})),builds:plan.buildTargets},null,2));
    else{console.log('Installing the local extension runtime and three packages. Native profile files remain in place.');console.log(JSON.stringify(applyOverlayInstall(plan),null,2));console.log('Start Strata Extensions.exe from the selected directory.');}
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
