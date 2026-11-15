import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {atomicJSON,readJSON} from './storage.mjs';
import {checkChat,safe} from './chat-paths.mjs';
import {editPlan} from './chat-edit.mjs';

/** The native ChatStore owns revisions; this layer coordinates file ownership
 * with resetting Harness context. No model call or UI process is started here. */
export function chatManagement({locations,store,uploads,native,base}){
  const pending=chat=>locations.data(chat,'core','edit-cleanup.json');
  const finishing=new Map();
  // Startup recovery and a user edit can reach the same pending intent. Share
  // its completion so an older cleanup cannot unlink a newer edit's intent.
  function finish(chat){
    if(finishing.has(chat))return finishing.get(chat);
    const work=finishPending(chat).finally(()=>finishing.delete(chat));
    finishing.set(chat,work);return work;
  }
  async function finishPending(chat){
    const file=pending(chat);if(!file)return;
    const cleanup=readJSON(file,null);if(!cleanup)return;
    const text=await store().read(chat);
    if(!text){fs.unlinkSync(file);return {cancelled:true,reason:'history_absent'};}
    const saved=JSON.parse(text);
    if(saved.rev<=cleanup.beforeRev){fs.unlinkSync(file);return;}
    if(saved.session.messages.some(m=>cleanup.messages.includes(m.id))){
      // A failed history commit or a later restore supersedes this deletion
      // intent. Keep its files and retire only the stale intent. Retrying it
      // forever would lock all subsequent edits and moves.
      fs.unlinkSync(file);
      return {cancelled:true,reason:'history_restored'};
    }
    const outcome=await store().withCommittedHistory(chat,current=>{
      // Recheck under the same queue as saves before deleting attachments:
      // another window may have restored the history after this edit.
      if(!current||current.rev<=cleanup.beforeRev||current.session.messages.some(m=>cleanup.messages.includes(m.id))){
        fs.unlinkSync(file);return {cancelled:true,reason:'history_restored'};
      }
      uploads()?.prune(chat,cleanup.uploads);
      return {cancelled:false};
    });
    if(outcome.cancelled)return outcome;
    fs.unlinkSync(file);
  }
  async function open(directory){
    // Existing native Shell helper runs outside the host, including the user's
    // real Explorer environment. Do not hide the window it is asked to open.
    if(!path.isAbsolute(directory)||!fs.statSync(directory).isDirectory())throw Error('Рабочая папка недоступна.');
    safe(path.dirname(directory),path.basename(directory));
    const helper=path.join(base,'extensions','bin','RevealFile.exe');
    await new Promise((resolve,reject)=>{
      const child=spawn(helper,['--open-folder',directory],{windowsHide:false,stdio:['ignore','pipe','pipe']});
      let output='',error='';const timer=setTimeout(()=>{child.kill();reject(Error('Windows не подтвердила открытие папки за 20 секунд.'));},20000);
      child.stdout.on('data',chunk=>output=(output+chunk).slice(-4000));child.stderr.on('data',chunk=>error=(error+chunk).slice(-2000));
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);try{if(code!==0||!JSON.parse(output).ok)throw Error(error||'Проводник не подтвердил действие.');resolve();}catch(e){reject(e);}});
    });return {ok:true};
  }
  return {finish,async run(input){
    const n=native();if(!n)throw Error('Мост управления чатами не подключён.');
    if(input.action==='open-workspace'){
      const workspace=n.workspaces().find(w=>w.id===input.workspaceId);if(!workspace)throw Error('Папка отсутствует в списке Strata.');
      return open(workspace.path);
    }
    const chat=input.chat;checkChat(chat);
    if(!store().has(chat))throw Error('Чат ещё не сохранён.');
    if(input.action==='open-chat')return open(locations.directory(chat));
    if(!['move','edit'].includes(input.action))throw Error('Неизвестное действие с чатом.');
    if(n.busy(chat))throw Error('В этом чате ещё выполняется ответ модели. Дождитесь его окончания.');
    await finish(chat);
    let plan,workspace;
    if(input.action==='move'){
      workspace=n.workspaces().find(w=>w.id===input.workspaceId);if(!workspace)throw Error('Папка отсутствует в списке Strata.');
    }
    const saved=await store().mutate(chat,input.rev,async session=>{
      if(input.action==='edit'){
        if(typeof input.text!=='string'||!input.text.trim())throw Error('Новая версия сообщения пуста.');
        plan=editPlan(session,input.messageId,{retry:input.retry===true,text:input.text});
        plan.cleanup.uploads=uploads()?.discarded(chat,plan.removed,plan.retained)??[];
        atomicJSON(pending(chat),{...plan.cleanup,beforeRev:input.rev});
      }
      // A new Harness context is rebuilt from the surviving native history.
      // Forgetting a mapping is safe even if a subsequent disk save fails.
      n.reset(chat);
      return plan?.session??{...session,workspace:workspace.path,updatedAt:new Date().toISOString()};
    });
    if(workspace)n.folder(chat,workspace.path);
    n.changed?.(chat,saved.rev);
    let warning;
    if(plan)try{await finish(chat);}catch(e){warning='История сохранена. Уборка материалов будет повторена при следующем запуске: '+e.message;}
    // Caller adopts this exact native revision before its next streaming save.
    return {...saved,original:plan?.original,warning};
  }};
}
