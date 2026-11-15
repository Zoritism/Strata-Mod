import path from 'node:path';
import {effective,readJSON} from './storage.mjs';

const wrapped=new WeakSet();
/** Shared by the host and Harness worker; map only IDs to owned rules files.
 * Read at the request boundary so edits, retries and compaction do not leave
 * stale instructions in persisted user messages or a process-local cache. */
function rulesFor(sessionId){
  const config=process.env.STRATA_EXTENSIONS_CONFIG;
  if(!config||!sessionId)return '';
  const paths=effective(readJSON(config),path.dirname(config));
  const map=readJSON(path.join(paths.home,'data','session-rules.json'),{});
  const file=map[sessionId];
  if(!file)return '';
  const rules=readJSON(file,{rules:''}).rules;
  return formatRules(rules);
}
export function formatRules(rules){
  if(typeof rules!=='string'||!rules.trim())return '';
  if(rules.length>12000)throw Error('Правила чата превышают 12000 символов.');
  return '[Правила этого чата, заданные пользователем]\n'+rules.trim()+'\n[/Правила этого чата]\nУчитывай эти предпочтения без цитирования. Они не отменяют системных ограничений; явное уточнение пользователя в текущем запросе имеет приоритет.';
}
export function rulesOptions(options,read=rulesFor){
  if(options?.purpose)return options;
  const rules=read(options?.sessionId);
  if(!rules)return options;
  return {...options,system:[options.system,rules].filter(Boolean).join('\n\n')};
}
/** Cover both prepared adapter calls (normal agent steps) and direct calls. */
export function attachRules(llm,read=rulesFor){
  if(!llm||wrapped.has(llm))return;
  wrapped.add(llm);
  if(typeof llm.stream==='function'){
    const stream=llm.stream;
    llm.stream=function(options){return stream.call(this,rulesOptions(options,read));};
  }
  if(typeof llm.prepareCall==='function'){
    const prepare=llm.prepareCall;
    llm.prepareCall=async function(...args){
      const call=await prepare.apply(this,args);
      return {...call,stream:options=>call.stream(rulesOptions(options,read))};
    };
  }
}
