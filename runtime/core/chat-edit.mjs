/** Produce the replacement boundary without writing. A retry can only target
 * the final assistant reply; Edit targets a user message and keeps its identity. */
export function editPlan(session,messageId,{retry=false,text}={}){
  const messages=session.messages??[];
  let at=messages.findIndex(m=>m.id===messageId);
  if(retry){
    if(at!==messages.length-1||messages[at]?.role!=='assistant')throw Error('Спросить ещё раз можно только для последнего ответа.');
    while(at>=0&&messages[at].role!=='user')at--;
  }
  if(at<0||messages[at].role!=='user')throw Error('Сообщение для редактирования не найдено.');
  const original=messages[at],kept=messages.slice(0,at);
  const replacement={...original,content:typeof text==='string'?text:original.content};
  const retained=[...kept,replacement];
  const removed=messages.slice(at+1);
  return {original:replacement,retained,removed,session:{...session,messages:retained,updatedAt:new Date().toISOString(),tokensIn:0,tokensOut:kept.reduce((sum,m)=>sum+(m.tokens??0),0),agents:[],contextUsed:0},
    cleanup:{version:1,messages:removed.map(m=>m.id)}};
}
