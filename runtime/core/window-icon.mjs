import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {applicationDirectory} from './storage.mjs';

/** Start the installation-specific icon owner for the desktop's lifetime. The
 * launcher supplies its exact PID; the host call remains a compatible fallback.
 * Neither path starts Strata, changes shortcuts or targets another install. */
export function attachWindowIcon(base,{processId,platform=process.platform,launch=spawn,exists=fs.existsSync}={}){
  if(platform!=='win32')return false;
  if(processId!==undefined&&(!Number.isSafeInteger(processId)||processId<=0))return false;
  const helper=path.join(base,'extensions','bin','WindowIcon.exe');
  let app;
  try{app=applicationDirectory(base);}catch{return false;}
  const desktop=path.join(app,'strata-desktop.exe');
  const icon=path.join(base,'Strata Extensions.exe');
  if(![helper,desktop,icon].every(exists))return false;
  const args=[desktop,icon];if(processId!==undefined)args.push(String(processId));
  const child=launch(helper,args,{windowsHide:true,stdio:'ignore'});
  child.on('error',error=>console.error('[window-icon]',error.message));child.unref();
  return true;
}
