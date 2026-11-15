import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJSON} from './storage.mjs';
import {checkChat} from './chat-paths.mjs';

/** Native ChatStore remains the history writer. This index only locates its files.
 * Migration copies verified bytes before switching the locator; sources are backups. */
export function workspaceChats(paths,{busy=()=>false}={}){
  const indexFile=path.join(paths.home,'data','chat-locations.json');
  let locations=fs.existsSync(indexFile)?JSON.parse(fs.readFileSync(indexFile,'utf8')):{};
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function persist(next=locations){atomicJSON(indexFile,next);locations=next;}
  function safe(target){
    for(let at=target;at!==path.dirname(at);at=path.dirname(at))if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('Ссылка в пути чата не поддерживается.');
    return target;
  }
  function directory(chat,workspace){
    checkChat(chat);
    const root=workspace||paths.workspace;
    if(!path.isAbsolute(root)||!fs.existsSync(root)||!fs.statSync(root).isDirectory())throw Error('Рабочая папка чата недоступна: '+root);
    return safe(path.join(root,chat));
  }
  const pendingWorkspaces=new Map();
  /** File tools and native deliverable tracking use the chat directory, while
   * Session.workspace remains the sidebar group. Never read a conversation to
   * resolve this path, or silently recreate a deleted/routed missing chat. */
  function workingDirectory(chat,workspace,{create=true}={}){
    checkChat(chat);
    const loc=locations[chat];
    if(loc?.deleted)throw Error('Чат удалён. Создайте новый чат.');
    if(loc){
      const expected=directory(chat,loc.workspace);
      if(path.resolve(loc.directory)!==path.resolve(expected))throw Error('Неверная граница папки чата.');
      if(!fs.existsSync(expected)||!fs.statSync(expected).isDirectory())throw Error('Рабочая папка чата недоступна.');
      pendingWorkspaces.delete(chat);
      return expected;
    }
    // Before the first native save, a second turn can supply Harness's cwd
    // instead of the group path. Do not create chat/chat in that case.
    const pending=pendingWorkspaces.get(chat);
    const root=pending&&workspace&&path.resolve(workspace)===path.resolve(pending.directory)?pending.workspace:(workspace||paths.workspace);
    const target=directory(chat,root);
    if(create){fs.mkdirSync(target,{recursive:true});pendingWorkspaces.set(chat,{workspace:root,directory:target});}
    // This is only a short-lived locator hint, not a second persistent index.
    if(pendingWorkspaces.size>256)pendingWorkspaces.delete(pendingWorkspaces.keys().next().value);
    return target;
  }
  function copy(source,dest){
    if(!fs.existsSync(source))return;
    safe(source);safe(dest);
    if(fs.statSync(source).isDirectory()){
      fs.mkdirSync(dest,{recursive:true});for(const name of fs.readdirSync(source))copy(path.join(source,name),path.join(dest,name));
    }else{
      fs.mkdirSync(path.dirname(dest),{recursive:true});
      if(fs.existsSync(dest)){if(hash(source)!==hash(dest))throw Error('Конфликт при переносе файла чата: '+dest);return;}
      fs.copyFileSync(source,dest);if(hash(source)!==hash(dest))throw Error('Не совпадает копия файла чата: '+dest);
    }
  }
  function data(chat,pkg,part=''){
    checkChat(chat);if(!/^[a-z-]+$/.test(pkg))throw Error('Неверная категория чата.');
    const loc=locations[chat];if(!loc)return null;if(!fs.existsSync(loc.workspace))throw Error('Рабочая папка чата недоступна: '+loc.workspace);const root=path.join(loc.directory,'extensions',pkg),target=path.resolve(root,part),rel=path.relative(root,target);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Путь вне категории чата.');return safe(target);
  }
  function file(chat){checkChat(chat);return locations[chat]?safe(path.join(locations[chat].directory,'chats',chat+'.json')):path.join(paths.home,'data','chats',chat+'.json');}
  let ensure;
  function wrap(create,options){
    const original=create(options),stores=new Map();
    let saving=Promise.resolve();
    const serialized=fn=>{const run=saving.then(fn,fn);saving=run.catch(()=>{});return run;};
    function routed(chat){const loc=locations[chat];if(!loc)return original;if(!fs.existsSync(path.dirname(loc.directory)))throw Error('Рабочая папка чата недоступна.');if(!stores.has(chat))stores.set(chat,create({...options,dir:loc.directory}));return stores.get(chat);}
    function relocate(chat,workspace){
      const dest=directory(chat,workspace),old=locations[chat];
      if(old?.directory===dest)return;
      // A newly created chat can receive its first native save while streaming.
      // Defer only its initial migration; explicit moves of routed chats fail.
      if(busy(chat)){if(!old)return;throw Error('Дождитесь окончания ответа перед переносом чата.');}
      if(old)copy(old.directory,dest);
      else{
        copy(file(chat),path.join(dest,'chats',chat+'.json'));
        copy(path.join(paths.extensionData,'chat-rules','chats',chat+'.json'),path.join(dest,'extensions','chat-rules','rules.json'));
      }
      persist({...locations,[chat]:{directory:dest,workspace:workspace||paths.workspace}});stores.delete(chat);
    }
    ensure=relocate;
    // Move the complete owned directory, including unknown user files. The
    // locator changes only after the destination has a committed native revision.
    // Source cleanup compares the original bytes, never recursively deletes a
    // path computed from a client request. An interrupted move keeps its source.
    async function saveSession(id,session,opts){
      if(locations[id]?.deleted)throw Error('Чат удалён. Создайте новый чат.');
      const old=locations[id];
      // A delayed writer may still hold the pre-move workspace. Keep its text,
      // but never let that stale snapshot undo a newer explicit move.
      if(old?.moveRev&&opts?.baseRev!=null&&opts.baseRev<old.moveRev)session={...session,workspace:old.workspace};
      const dest=directory(id,session.workspace);
      if(old&&old.directory!==dest){
        if(busy(id))throw Error('Дождитесь окончания ответа перед переносом чата.');
        const nested=(a,b)=>{const rel=path.relative(a,b);return !rel||(!rel.startsWith('..')&&!path.isAbsolute(rel));};
        if(nested(old.directory,dest)||nested(dest,old.directory))throw Error('Нельзя переносить чат внутрь его собственной папки.');
        const snapshot=[];
        const walk=dir=>{safe(dir);for(const name of fs.readdirSync(dir)){const f=safe(path.join(dir,name));if(fs.statSync(f).isDirectory())walk(f);else snapshot.push([f,hash(f)]);}};
        walk(old.directory);
        if(fs.existsSync(dest)&&fs.readdirSync(dest).length)throw Error('Папка назначения чата уже существует. Сначала разберите её содержимое: '+dest);
        const staging=fs.mkdtempSync(path.join(path.dirname(dest),'.strata-moving-'+id+'-'));
        // Native uploaded-file references contain absolute paths. Preserve their
        // filenames and update only paths inside this chat's owned attachment tree.
        const oldFiles=path.join(old.directory,'.strata','attachments'),newFiles=path.join(dest,'.strata','attachments');
        const rewrite=v=>typeof v==='string'?v.split(oldFiles).join(newFiles).split(oldFiles.replaceAll('\\','/')).join(newFiles.replaceAll('\\','/')):Array.isArray(v)?v.map(rewrite):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)])):v;
        session=rewrite(session);
        let saved,renamed=false,committed=false;
        try{
          copy(old.directory,staging);
          const next=create({...options,dir:staging});saved=await next.save(id,JSON.stringify(session,null,2),opts);
          if(fs.existsSync(dest))fs.rmdirSync(dest);fs.renameSync(staging,dest);renamed=true;
          persist({...locations,[id]:{directory:dest,workspace:session.workspace||paths.workspace,moveRev:saved.rev}});committed=true;stores.delete(id);
        }finally{
          // Both candidates were created by this operation and stay under the
          // already checked workspace. Never delete an existing user's target.
          const unused=renamed&&!committed?dest:staging;
          if(fs.existsSync(unused)&&path.dirname(unused)===path.dirname(dest)){safe(unused);fs.rmSync(unused,{recursive:true});}
        }
        for(const [file,sum] of snapshot)if(fs.existsSync(file)&&hash(file)===sum)fs.unlinkSync(safe(file));
        const empty=dir=>{safe(dir);for(const name of fs.readdirSync(dir)){const child=safe(path.join(dir,name));if(fs.statSync(child).isDirectory())empty(child);}if(!fs.readdirSync(dir).length)fs.rmdirSync(dir);};
        empty(old.directory);
        return saved;
      }
      relocate(id,session.workspace);if(locations[id]&&!routed(id).has(id))inherit(session);
      return routed(id).save(id,JSON.stringify(session,null,2),opts);
    }
    /** A native branch supplies its source identity, never arbitrary file paths.
     * Its explicit user rules follow that identity, without scanning other chats. */
    function inherit(session){
      const source=session.sxBranchSource;if(!source||source===session.id)return;
      checkChat(source);
      if(!routed(source).has(source))throw Error('Исходный чат ветки недоступен.');
      const legacy=path.join(paths.extensionData,'chat-rules','chats',source+'.json');
      copy(data(source,'chat-rules','rules.json')??legacy,data(session.id,'chat-rules','rules.json'));
    }
    const api={
      ...original,
      list(){const base=original.list();const chats=base.chats.filter(e=>!locations[e.id]);const damaged=[...base.damaged];for(const id of Object.keys(locations)){if(locations[id].deleted)continue;if(!fs.existsSync(locations[id].directory)){damaged.push(id);continue;}try{const r=routed(id).list();chats.push(...r.chats);damaged.push(...r.damaged);}catch{damaged.push(id);}}return {...base,chats,damaged,deleted:Object.keys(locations).filter(id=>locations[id].deleted)};},
      has:id=>!locations[id]?.deleted&&(!locations[id]||fs.existsSync(file(id)))&&routed(id).has(id),rev:id=>locations[id]&&(locations[id].deleted||!fs.existsSync(file(id)))?0:routed(id).rev(id),async read(id){return serialized(async()=>{if(locations[id]&&(locations[id].deleted||!fs.existsSync(file(id))))return null;const text=await routed(id).read(id);if(text&&!locations[id]){const saved=JSON.parse(text);relocate(id,saved.session?.workspace);}return text;});},
      save(id,text,opts){return serialized(async()=>{checkChat(id);const session=JSON.parse(text);if(session.id!==id)throw Error('Чат не совпадает с ID.');return saveSession(id,session,opts);});},
      /** Coordinate synchronous owned-file cleanup with native history writes.
       * The callback must not await or re-enter this store; any asynchronous
       * follow-up happens after releasing the serialization boundary. */
      withCommittedHistory(id,cleanup){return serialized(async()=>{
        checkChat(id);
        const absent=locations[id]&&(locations[id].deleted||!fs.existsSync(file(id)));
        const text=absent?null:await routed(id).read(id);
        const result=cleanup(text?JSON.parse(text):null);
        if(result?.then)throw Error('History cleanup must be synchronous.');
        return result;
      });},
      /** A destructive edit cannot use native conflict recovery to overwrite a
       * newer window. Check revision inside the same queue as normal saves. */
      mutate(id,rev,change){return serialized(async()=>{
        checkChat(id);const text=await routed(id).read(id);if(!text)throw Error('Чат не найден.');
        const old=JSON.parse(text);if(old.rev!==rev)throw Error('Чат изменился в другом окне. Обновите его перед изменением.');
        const session=await change(structuredClone(old.session));if(session.id!==id)throw Error('Неверный чат.');
        const saved=await saveSession(id,session,{baseRev:rev});return {...saved,session:JSON.parse(await routed(id).read(id)).session};
      });},
      remove(id){return serialized(async()=>{if(locations[id]?.deleted)return {id,removed:false};const result=locations[id]&&!fs.existsSync(locations[id].directory)?{id,removed:false}:await routed(id).remove(id);if(locations[id])persist({...locations,[id]:{...locations[id],deleted:true}});stores.delete(id);return result;});},
      async importMany(sessions){const result={imported:[],skipped:[],failed:[]};for(const s of sessions??[]){if(locations[s.id]?.deleted||api.has(s.id)){result.skipped.push(s.id);continue;}try{await api.save(s.id,JSON.stringify(s));result.imported.push(s.id);}catch(e){result.failed.push({id:s.id,error:e.message});}}return result;},
      async idle(){await saving;await original.idle();for(const store of stores.values())await store.idle();},
    };
    return api;
  }
  /** Called after a committed deletion. Keep a tombstone so old snapshots cannot reappear. */
  function cleanup(chat){
    checkChat(chat);const loc=locations[chat];if(!loc?.deleted)return;
    const target=path.resolve(loc.directory),expected=path.resolve(loc.workspace,chat);
    if(target!==expected||path.dirname(target)!==path.resolve(loc.workspace))throw Error('Неверная граница папки чата.');
    if(!fs.existsSync(target))return;
    if(fs.existsSync(path.join(target,'chats',chat+'.json')))throw Error('Файл чата ещё существует.');
    const inspect=dir=>{safe(dir);for(const item of fs.readdirSync(dir,{withFileTypes:true})){const child=safe(path.join(dir,item.name));if(item.isDirectory())inspect(child);}};
    inspect(target);fs.rmSync(target,{recursive:true});
  }
  return {wrap,data,file,cleanup,workingDirectory,ids:()=>Object.keys(locations),ensure:(chat,workspace)=>ensure?.(chat,workspace),directory:chat=>locations[chat]?.directory??path.dirname(file(chat))};
}
