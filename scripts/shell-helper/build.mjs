import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

/** Build with the existing Windows Framework compiler. No download or system installation. */
export function buildShellHelper(target){
  return build(target,'RevealFile');
}
/** The optional desktop helper shares the existing compiler, not a new runtime. */
export function buildWindowIcon(target){
  return build(target,'WindowIcon');
}
function build(target,name){
  if(process.platform!=='win32')return null;
  const source=fileURLToPath(new URL('./'+name+'.cs',import.meta.url));
  const compiler=path.join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  if(!fs.existsSync(compiler))throw Error('Не найден установленный компилятор .NET Framework для помощника Проводника. Новые инструменты автоматически не устанавливаются.');
  const folder=path.join(target,'extensions','bin');fs.mkdirSync(folder,{recursive:true});
  const output=path.join(folder,name+'.exe'),temporary=path.join(folder,name+'.build.exe');
  try{
    execFileSync(compiler,['/nologo','/target:winexe','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:Microsoft.CSharp.dll','/out:'+temporary,source],{windowsHide:true,stdio:'pipe'});
    fs.renameSync(temporary,output);
  }finally{fs.rmSync(temporary,{force:true});}
  return {file:'extensions/bin/'+name+'.exe',sha256:createHash('sha256').update(fs.readFileSync(output)).digest('hex'),source:'scripts/shell-helper/'+name+'.cs'};
}
