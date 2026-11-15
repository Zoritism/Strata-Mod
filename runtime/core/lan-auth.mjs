import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readJSON,atomicJSON,locked} from './storage.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const day=86400000;
export const deviceCookie='__Host-strata-device';
export function cookie(token,remember=true){
  return `${deviceCookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax${remember?'; Max-Age=31536000':''}`;
}
export function tokenFromCookie(value=''){
  return String(value).split(';').map(s=>s.trim()).find(s=>s.startsWith(deviceCookie+'='))?.slice(deviceCookie.length+1)??'';
}

/** Shared by the local settings host and gateway. Only hashes are persisted;
 * each check rereads the bounded registry so revocation works across processes. */
export function deviceStore(directory,{now=Date.now}={}){
  const file=path.join(directory,'devices.json');
  const read=()=>{
    const state=readJSON(file,{schema:1,devices:[],pairings:[]});
    if(state.schema!==1||!Array.isArray(state.devices)||!Array.isArray(state.pairings))throw Error('Не удалось прочитать список подключённых устройств.');
    return state;
  };
  function change(fn){
    fs.mkdirSync(directory,{recursive:true});
    // A machine restart can leave the small process-owned lock behind. Recover
    // only a provably dead owner; live/unknown owners remain protected.
    const lock=file+'.lock';
    if(fs.existsSync(lock)){
      const raw=fs.readFileSync(lock,'utf8');
      try{
        const pid=JSON.parse(raw).pid;
        if(Number.isInteger(pid)&&pid>0){
          try{process.kill(pid,0);}catch(error){
            if(error.code==='ESRCH'&&fs.readFileSync(lock,'utf8')===raw)fs.unlinkSync(lock);
          }
        }
      }catch{/* An incomplete/live lock is never guessed away. */}
    }
    return locked(file,()=>{
      const state=read();
      state.devices=state.devices.filter(d=>d.expires>now());
      state.pairings=state.pairings.filter(p=>p.expires>now());
      const result=fn(state);
      atomicJSON(file,state);
      return result;
    });
  }
  function add(state,label,remember){
    if(state.devices.length>=32)throw Error('Подключено 32 устройства. Отключите ненужное в настройках Strata.');
    const token=randomBytes(32).toString('hex');
    state.devices.push({id:randomUUID(),hash:hash(token),label:String(label||'Телефон').replace(/[\x00-\x1f]/g,'').slice(0,80),remember,created:now(),lastUsed:now(),expires:now()+(remember?365*day:day)});
    return {token,remember};
  }
  return {
    list:()=>read().devices.filter(d=>d.expires>now()).map(({hash,...d})=>d),
    issue:(label,remember=true)=>change(s=>add(s,label,remember)),
    check(token){
      if(!/^[a-f0-9]{64}$/.test(token))return null;
      const found=read().devices.find(d=>d.hash===hash(token)&&d.expires>now());
      if(!found)return null;
      // Coalesce last-seen writes; request authentication never depends on cache.
      if(now()-found.lastUsed>3600000)return change(s=>{
        const d=s.devices.find(d=>d.id===found.id);
        if(!d)return null;
        d.lastUsed=now();
        if(d.remember)d.expires=now()+365*day;
        return {...d,hash:undefined};
      });
      return {...found,hash:undefined};
    },
    revoke:id=>change(s=>{s.devices=s.devices.filter(d=>d.id!==id);}),
    pair(){
      return change(s=>{
        const token=randomBytes(32).toString('hex'),expires=now()+300000;
        // A new QR replaces the previous outstanding one, never existing devices.
        s.pairings=[{hash:hash(token),expires}];
        return {token,expires};
      });
    },
    redeem:(token,label)=>change(s=>{
      if(!/^[a-f0-9]{64}$/.test(token)||!s.pairings.some(p=>p.hash===hash(token)))throw Error('QR-код истёк или уже использован. Создайте новый на компьютере.');
      const result=add(s,label,true);
      s.pairings=s.pairings.filter(p=>p.hash!==hash(token));
      return result;
    })
  };
}
