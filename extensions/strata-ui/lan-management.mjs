import path from 'node:path';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

/** Local-only administration; the LAN gateway blocks this entire endpoint. */
export function lanManagement(base,{auth,executeScript}={}){
  if(!auth)throw Error('Не подключено хранилище разрешённых устройств.');
  // Keep the existing credential/configuration directory. Moving UI ownership
  // does not relocate keys, invalidate remembered phones or rewrite settings.
  const directory=path.join(base,'data/lan-ui');
  const run=async (script,action)=>{
    if(executeScript)return executeScript(script,action);
    const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(base,'tools/lan-ui',script),'-Action',action],{windowsHide:true,timeout:15000,maxBuffer:16384});
    return stdout.trim();
  };
  async function status(){
    if(!fs.existsSync(path.join(directory,'config.json')))return {configured:false};
    const config=JSON.parse(fs.readFileSync(path.join(directory,'config.json'),'utf8'));
    const [gateway,startup]=await Promise.allSettled([run('control.ps1','Status'),run('startup.ps1','Status')]);
    // An unavailable Windows startup setting must not hide LAN or device controls.
    const warnings=[];
    if(gateway.status==='rejected')warnings.push('Не удалось проверить сетевой доступ. Повторите проверку.');
    if(startup.status==='rejected')warnings.push('Не удалось проверить автозапуск Windows. Сетевой доступ можно использовать отдельно.');
    return {configured:true,enabled:gateway.status==='fulfilled'?gateway.value.includes('https://'):null,url:`https://${config.address}:${config.port}/`,autostart:startup.status==='fulfilled'?startup.value.toLowerCase()==='true':null,warnings,devices:auth.list()};
  }
  return {status,async action(input){
    if(!input||typeof input!=='object')throw Error('Неизвестное действие.');
    if(input.action==='enable')await run('control.ps1','Start');
    else if(input.action==='disable')await run('control.ps1','Stop');
    else if(input.action==='autostart')await run('startup.ps1',input.enabled===true?'Enable':'Disable');
    else if(input.action==='revoke')auth.revoke(String(input.id));
    else if(input.action==='pair'){
      const state=await status();
      if(!state.enabled)throw Error('Сначала включите доступ по сети.');
      const pair=auth.pair();
      return {url:state.url+'__lan/pair#'+pair.token,expires:pair.expires};
    }else throw Error('Неизвестное действие.');
    return status();
  }};
}
