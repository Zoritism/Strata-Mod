import fs from 'node:fs';
import path from 'node:path';

/** IDs are names inside one chat root, never arbitrary paths or device names. */
export function checkChat(chat) {
  if(typeof chat!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(chat)||/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(chat))throw Error('Неверный чат.');
}

/** Refuse aliases at every existing component before touching an owned tree. */
export function safe(root,...parts) {
  const base=path.resolve(root),target=path.resolve(base,...parts),relative=path.relative(base,target);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Файл вне папки чата.');
  for(let current=target;current!==path.dirname(current);current=path.dirname(current)){
    if(fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('Ссылки в папке чата не поддерживаются.');
  }
  return target;
}
