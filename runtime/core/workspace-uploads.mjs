import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJSON,readJSON} from './storage.mjs';
import {checkChat,safe} from './chat-paths.mjs';

/** Keep native upload parsing/validation; only replace ownership and retention.
 * The small locator contains IDs, never image bytes. Historical uploads remain
 * readable, and referenced chat images no longer expire after one day. */
export function workspaceUploads(create,options,locations,home){
  const stores=new Map();
  const indexFile=path.join(home,'data','upload-locations.json');
  let index=readJSON(indexFile,{});
  const oldByChat=new Map(),migrated=new Set();
  for(const name of (fs.existsSync(options.dir)?fs.readdirSync(options.dir):[]).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){
    const meta=readJSON(safe(options.dir,name),null);
    if(meta?.kind==='image'&&meta.chatId){const list=oldByChat.get(meta.chatId)??[];list.push(meta);oldByChat.set(meta.chatId,list);}
  }
  function store(chat){
    checkChat(chat);
    if(!locations.data(chat,'uploads'))locations.ensure(chat,options.folderOf(chat));
    const dir=locations.data(chat,'uploads');
    if(!dir)throw Error('Сначала сохраните чат в выбранной рабочей папке.');
    const key=chat+'\n'+dir;
    if(!stores.has(key))stores.set(key,create({...options,dir,folderOf:()=>locations.directory(chat)}));
    return stores.get(key);
  }
  return {
    discarded(chat,removed,retained){
      const old=JSON.stringify(removed),keep=JSON.stringify(retained);
      return Object.entries(index).filter(([id,row])=>row.chat===chat&&(row.kind==='file'?old.includes(row.name)&&!keep.includes(row.name):old.includes(id)&&!keep.includes(id))).map(([id])=>id);
    },
    prune(chat,ids){
      const dir=locations.data(chat,'uploads');
      for(const id of ids??[]){
        const row=index[id];if(!row||row.chat!==chat)continue;
        if(row.kind==='file')fs.rmSync(safe(locations.directory(chat),'.strata','attachments',row.name),{force:true});
        else if(dir){const metaFile=safe(dir,id+'.json'),meta=readJSON(metaFile,null);if(meta?.chatId===chat){fs.rmSync(safe(dir,path.basename(meta.file)),{force:true});fs.rmSync(metaFile,{force:true});}}
        delete index[id];
      }
      atomicJSON(indexFile,index);
    },
    migrate(chat){
      if(migrated.has(chat)||!locations.data(chat,'uploads'))return;
      const next={...index},verified=[];
      for(const meta of oldByChat.get(chat)??[]){
        const src=safe(options.dir,path.basename(meta.file));if(!fs.existsSync(src))continue;
        const dir=locations.data(chat,'uploads'),target=safe(dir,path.basename(meta.file));fs.mkdirSync(dir,{recursive:true});
        const bytes=fs.readFileSync(src);
        if(fs.existsSync(target)&&!fs.readFileSync(target).equals(bytes))throw Error('Конфликт переноса вложения чата.');
        if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx'});
        if(!fs.readFileSync(target).equals(bytes))throw Error('Вложение скопировано неверно.');
        const targetMeta=safe(dir,meta.id+'.json'),existing=readJSON(targetMeta,null);
        if(existing&&(existing.id!==meta.id||existing.chatId!==chat))throw Error('Конфликт владельца вложения чата.');
        atomicJSON(targetMeta,{...meta,...existing,file:target});next[meta.id]={chat,kind:'image'};
        verified.push({src,target,bytes,metadata:safe(options.dir,meta.id+'.json'),metadataBytes:fs.readFileSync(safe(options.dir,meta.id+'.json'))});
      }
      atomicJSON(indexFile,next);index=next;
      // Only prune exact legacy files after the new data and locator commit.
      // A conflict keeps its original; unrelated files and chats are untouched.
      for(const item of verified){
        if(!fs.readFileSync(item.target).equals(item.bytes)||!fs.readFileSync(item.src).equals(item.bytes)||!fs.readFileSync(item.metadata).equals(item.metadataBytes))throw Error('Вложение изменилось во время переноса.');
        fs.unlinkSync(item.src);fs.unlinkSync(item.metadata);
      }
      if(fs.existsSync(options.dir)&&fs.readdirSync(options.dir).length===0)fs.rmdirSync(options.dir);
      oldByChat.delete(chat);migrated.add(chat);
    },
    accept(chat,request){
      const files=store(chat).accept(chat,request),next={...index};
      for(const file of files)next[file.id??('file-'+randomUUID())]={chat,kind:file.kind,name:file.kind==='file'?path.basename(file.path):null};
      atomicJSON(indexFile,next);index=next;return files;
    },
    image(id){const row=index[id];if(!row){if(!/^[a-f0-9-]{36}$/.test(id))return null;const meta=readJSON(safe(options.dir,id+'.json'),null);if(!meta?.chatId||meta.kind!=='image')return null;try{return {bytes:fs.readFileSync(safe(options.dir,path.basename(meta.file))),type:meta.type,name:meta.name,chatId:meta.chatId};}catch{return null;}}const chat=typeof row==='string'?row:row.chat;const dir=locations.data(chat,'uploads');if(!dir)return null;const meta=readJSON(safe(dir,id+'.json'),null);if(!meta||meta.chatId!==chat)return null;try{return {bytes:fs.readFileSync(safe(dir,path.basename(meta.file))),type:meta.type,name:meta.name,chatId:chat};}catch{return null;}},
    dataUrls(chat,ids){
      if(!Array.isArray(ids)||ids.length>4)throw Error('Прикрепите не более четырёх изображений.');
      return ids.map(id=>{const img=this.image(id);if(!img||img.chatId!==chat)throw Error('Изображение недоступно в этом чате.');return {url:`data:${img.type};base64,${img.bytes.toString('base64')}`,name:img.name};});
    },
    // Retention is tied to explicit chat deletion, never the age of the image.
    sweep(){return 0;},
    remove(chat){
      checkChat(chat);const dir=locations.data(chat,'uploads');
      for(const [id,row] of Object.entries(index))if((typeof row==='string'?row:row.chat)===chat){
        if(row.kind==='file'){const file=safe(locations.directory(chat),'.strata','attachments',row.name);fs.rmSync(file,{force:true});delete index[id];continue;}
        if(dir){const metadata=safe(dir,id+'.json'),meta=readJSON(metadata,null);if(meta?.chatId===chat){const bytes=safe(dir,path.basename(meta.file));if(fs.existsSync(bytes))fs.unlinkSync(bytes);fs.rmSync(metadata,{force:true});}}
        delete index[id];
      }
      atomicJSON(indexFile,index);
      for(const meta of oldByChat.get(chat)??[]){fs.rmSync(safe(options.dir,path.basename(meta.file)),{force:true});fs.rmSync(safe(options.dir,meta.id+'.json'),{force:true});}
      oldByChat.delete(chat);
    },
  };
}
