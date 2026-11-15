import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {atomicJSON,readJSON,defaultConfig,validate} from '../runtime/core/storage.mjs';
import {workspaceChats} from '../runtime/core/workspace-chats.mjs';
import {workspaceUploads} from '../runtime/core/workspace-uploads.mjs';
import {chatManagement} from '../runtime/core/chat-management.mjs';
import {editPlan} from '../runtime/core/chat-edit.mjs';
import {earlierConversation} from '../runtime/core/chat-context.mjs';
import {excludeDeleted} from '../runtime/core/chat-recovery.mjs';
import {attachRules} from '../runtime/core/harness-rules.mjs';
import {dismissDialog} from '../runtime/core/surfaces.mjs';

const release=path.resolve(process.env.STRATA_TEST_CLEAN_RELEASE??'.work/upgrade-0213/release');
const nativeStore=path.join(release,'host/server/chat-store.mjs');
const nativeUploads=path.join(release,'host/server/chat-uploads.mjs');
const hasNative=fs.existsSync(nativeStore)&&fs.existsSync(nativeUploads);

/** Optional official modules are exercised only with synthetic data under .work.
 * No test locates an installed application or discovers a user's profile. */
async function fixture(t){
  const parent=path.resolve('.work/tests');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'chat-storage-'));
  t.after(()=>{assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true});});
  const paths=validate({...defaultConfig('./data'),strict:false},root,{probe:true});
  const second=path.join(root,'other-workspace');fs.mkdirSync(second);
  const {createChatStore}=await import(pathToFileURL(nativeStore));
  const {createUploads}=await import(pathToFileURL(nativeUploads));
  let responding=false;
  const locations=workspaceChats(paths,{busy:()=>responding});
  const store=locations.wrap(createChatStore,{dir:path.join(paths.home,'data')});
  const options={dir:path.join(paths.home,'data/uploads'),folderOf:()=>paths.workspace,attachments:{add(){}}};
  const uploads=workspaceUploads(createUploads,options,locations,paths.home);
  const calls=[];
  const native={workspaces:()=>[{id:'root',path:paths.workspace},{id:'second',path:second}],busy:()=>responding,
    reset:chat=>calls.push(['reset',chat]),folder:(chat,folder)=>calls.push(['folder',chat,folder]),changed:(chat,rev)=>calls.push(['changed',chat,rev])};
  const management=chatManagement({locations,store:()=>store,uploads:()=>uploads,native:()=>native,base:root});
  return {root,paths,second,locations,store,uploads,management,calls,respond:value=>{responding=value;}};
}
const session=workspace=>({id:'alpha',title:'Synthetic chat',workspace,permissionMode:'ask',customSetting:{retained:true},
  messages:[{id:'u1',role:'user',content:'Keep this exact wording.',photos:['photo-a']},{id:'a1',role:'assistant',content:'Earlier answer'},
    {id:'u2',role:'user',content:'Revise the last paragraph.',photos:['photo-b'],customField:7},{id:'a2',role:'assistant',content:'Later answer'}]});

test('editing preserves user fields and original attachments while bounding the surviving history',()=>{
  const original=session('synthetic-workspace'),before=structuredClone(original);
  const plan=editPlan(original,'u2',{text:'A different request'});
  assert.deepEqual(original,before);
  assert.equal(plan.session.permissionMode,'ask');assert.deepEqual(plan.session.customSetting,{retained:true});
  assert.deepEqual(plan.original,{...before.messages[2],content:'A different request'});
  assert.deepEqual(plan.cleanup.messages,['a2']);assert.equal(plan.session.messages.length,3);
  assert.match(earlierConversation(plan.session.messages,'current'),/Keep this exact wording/);
  assert.doesNotMatch(earlierConversation(plan.session.messages,'current'),/Later answer/);
  assert.throws(()=>editPlan(original,'a1',{retry:true}),/последнего/);
  assert.equal(editPlan(original,'a2',{retry:true}).original.id,'u2');
});

test('deletion markers filter stale recovery without dropping unsaved local chats',()=>{
  const recovered={sessions:[{id:'removed'},{id:'offline'},{id:'kept'}],ids:['removed','offline','kept'],other:true};
  assert.deepEqual(excludeDeleted(recovered,['removed']),{sessions:[{id:'offline'},{id:'kept'}],ids:['offline','kept'],other:true});
});

test('chat rules wrap normal and prepared calls once and leave unrelated session calls alone',async()=>{
  const seen=[],llm={stream(options){seen.push(options);},async prepareCall(){return {stream:options=>seen.push(options)};}};
  const read=id=>id==='alpha'?'Synthetic user preference':'';
  attachRules(llm,read);attachRules(llm,read);
  llm.stream({sessionId:'alpha',system:'Base'});
  const call=await llm.prepareCall();call.stream({sessionId:'alpha'});
  llm.stream({sessionId:'beta',system:'Other'});llm.stream({sessionId:'alpha',purpose:'summary',system:'Utility'});
  assert.equal(seen[0].system,'Base\n\nSynthetic user preference');
  assert.equal(seen[1].system,'Synthetic user preference');assert.equal(seen[2].system,'Other');assert.equal(seen[3].system,'Utility');
});

test('dialog backdrop dismissal leaves clicks inside the settings form intact',()=>{
  let closed=0;const node={getBoundingClientRect:()=>({left:10,right:110,top:10,bottom:110}),close:()=>closed++};
  assert.equal(dismissDialog(node,{target:node,clientX:40,clientY:40}),false);
  assert.equal(dismissDialog(node,{target:{},clientX:5,clientY:5}),false);
  assert.equal(dismissDialog(node,{target:node,clientX:5,clientY:5}),true);assert.equal(closed,1);
});

test('native chat move preserves bytes and settings, rules follow a branch, and deletion leaves a tombstone',{skip:!hasNative},async t=>{
  const f=await fixture(t),initial=session(f.paths.workspace);
  await f.store.save('alpha',JSON.stringify(initial));
  const old=f.locations.directory('alpha'),note=path.join(old,'notes.txt');fs.writeFileSync(note,'synthetic notes\n');
  atomicJSON(f.locations.data('alpha','chat-rules','rules.json'),{rules:'Use compact paragraphs.'});
  const moved=await f.management.run({action:'move',chat:'alpha',workspaceId:'second',rev:f.store.rev('alpha')});
  assert.equal(moved.session.workspace,f.second);assert.deepEqual(moved.session.customSetting,initial.customSetting);
  assert.equal(fs.existsSync(old),false);assert.equal(fs.readFileSync(path.join(f.locations.directory('alpha'),'notes.txt'),'utf8'),'synthetic notes\n');
  assert.equal(f.locations.workingDirectory('alpha',f.second),path.join(f.second,'alpha'));
  const branch={...moved.session,id:'branch',sxBranchSource:'alpha'};await f.store.save('branch',JSON.stringify(branch));
  assert.deepEqual(readJSON(f.locations.data('branch','chat-rules','rules.json')),{rules:'Use compact paragraphs.'});
  await f.store.remove('alpha');f.uploads.remove('alpha');f.locations.cleanup('alpha');
  assert.equal(fs.existsSync(path.join(f.second,'alpha')),false);
  assert.deepEqual(f.store.list().deleted,['alpha']);assert.equal(f.store.has('branch'),true);
  await assert.rejects(f.store.save('alpha',JSON.stringify(initial)),/удалён/);
});

test('native attachment cleanup removes only discarded uploads and preserves settings through edit',{skip:!hasNative},async t=>{
  const f=await fixture(t);await f.store.save('alpha',JSON.stringify(session(f.paths.workspace)));
  const kept=f.uploads.accept('alpha',{body:Buffer.from('keep'),contentType:'text/plain',name:'kept.txt'})[0];
  const dropped=f.uploads.accept('alpha',{body:Buffer.from('drop'),contentType:'text/plain',name:'dropped.txt'})[0];
  const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const photo=f.uploads.accept('alpha',{body:png,contentType:'image/png',name:'synthetic.png'})[0];
  const source=session(f.paths.workspace);source.messages[0].content+=' @'+kept.path;
  source.messages[3].content+=' @'+dropped.path;source.messages[3].photos=[photo.id];
  await f.store.save('alpha',JSON.stringify(source),{baseRev:f.store.rev('alpha')});
  assert.deepEqual(f.uploads.image(photo.id).bytes,png);
  const result=await f.management.run({action:'edit',chat:'alpha',messageId:'u2',text:'Replacement',rev:f.store.rev('alpha')});
  assert.equal(result.warning,undefined);assert.equal(result.session.permissionMode,'ask');
  assert.equal(fs.existsSync(kept.path),true);assert.equal(fs.existsSync(dropped.path),false);assert.equal(f.uploads.image(photo.id),null);
  assert.equal(fs.existsSync(f.locations.data('alpha','core','edit-cleanup.json')),false);
});

test('native revision checks refuse stale edits and a restored history cancels pending cleanup',{skip:!hasNative},async t=>{
  const f=await fixture(t),source=session(f.paths.workspace);await f.store.save('alpha',JSON.stringify(source));
  const first=f.store.rev('alpha');await f.store.save('alpha',JSON.stringify({...source,title:'Changed elsewhere'}),{baseRev:first});
  await assert.rejects(f.management.run({action:'edit',chat:'alpha',messageId:'u2',text:'Stale',rev:first}),/другом окне/);
  f.respond(true);await assert.rejects(f.management.run({action:'move',chat:'alpha',workspaceId:'second',rev:f.store.rev('alpha')}),/ответ модели/);f.respond(false);
  const file=f.locations.data('alpha','core','edit-cleanup.json');
  atomicJSON(file,{version:1,beforeRev:first,messages:['a2'],uploads:[]});
  assert.equal((await f.management.finish('alpha')).reason,'history_restored');assert.equal(fs.existsSync(file),false);
  assert.equal(JSON.parse(await f.store.read('alpha')).session.messages.at(-1).id,'a2');
  atomicJSON(file,{version:1,beforeRev:first,messages:['a2'],uploads:[]});
  await f.store.remove('alpha');assert.equal((await f.management.finish('alpha')).reason,'history_absent');
});

test('workspace routing rejects aliases before touching their linked contents',{skip:!hasNative},async t=>{
  const f=await fixture(t),linked=path.join(f.paths.workspace,'alpha'),target=path.join(f.root,'unrelated');fs.mkdirSync(target);
  fs.writeFileSync(path.join(target,'keep.txt'),'untouched');fs.symlinkSync(target,linked,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.locations.workingDirectory('alpha',f.paths.workspace),/Ссылка/);
  assert.equal(fs.readFileSync(path.join(target,'keep.txt'),'utf8'),'untouched');
});

test('restart deletion recovery waits for native attachments before removing the owned directory',{skip:!hasNative},async t=>{
  const f=await fixture(t),previous=process.env.STRATA_EXTENSIONS_CONFIG;
  t.after(()=>{if(previous===undefined)delete process.env.STRATA_EXTENSIONS_CONFIG;else process.env.STRATA_EXTENSIONS_CONFIG=previous;});
  const file=path.join(f.root,'storage.json');atomicJSON(file,{...defaultConfig('./data'),strict:false});
  process.env.STRATA_EXTENSIONS_CONFIG=file;
  await f.store.save('alpha',JSON.stringify(session(f.paths.workspace)));
  const attachment=f.uploads.accept('alpha',{body:Buffer.from('owned'),contentType:'text/plain',name:'owned.txt'})[0];
  const directory=f.locations.directory('alpha');await f.store.remove('alpha');
  const pending=path.join(f.paths.extensionData,'core/pending-chat-cleanup.json');atomicJSON(pending,{version:1,chats:['alpha']});
  const host=await import(pathToFileURL(path.resolve('runtime/core/host.mjs')).href+'?cleanup='+Date.now());
  assert.equal(fs.existsSync(attachment.path),true);
  const {createChatStore}=await import(pathToFileURL(nativeStore)),{createUploads}=await import(pathToFileURL(nativeUploads));
  host.createChatStore(createChatStore,{dir:path.join(f.paths.home,'data')});
  host.createUploads(createUploads,{dir:path.join(f.paths.home,'data/uploads'),folderOf:()=>f.paths.workspace,attachments:{add(){}}});
  host.attachChatManagement({busy:()=>false,workspaces:()=>[],reset(){},changed(){},folder(){}});
  assert.equal(fs.existsSync(directory),false);assert.deepEqual(readJSON(pending).chats,[]);
  assert.deepEqual(readJSON(path.join(f.paths.home,'data/upload-locations.json')),{});
});
