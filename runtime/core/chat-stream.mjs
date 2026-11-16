/** Reconnect only to an already identified native turn. Never repeat the user's
 * POST: its tools may already have run. Native attach sends resync, so a partial
 * answer is replaced rather than appended twice. No conversation is logged. */
export function installChatStreamRecovery(target=globalThis,{wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const original=target.fetch.bind(target),encoder=new TextEncoder();
  target.fetch=async function(input,init){
    let url,body;
    try{
      url=new URL(typeof input==='string'||input instanceof URL?input:input.url,target.location?.href);
      if(url.origin!==target.location?.origin||init?.method!=='POST'||!['/api/chat/stream','/api/chat/attach','/api/plan/start-goal'].includes(url.pathname)||typeof init.body!=='string')return original(input,init);
      body=JSON.parse(init.body);
      if(typeof body.sessionId!=='string')return original(input,init);
    }catch{return original(input,init);}
    let response=await original(input,init);
    if(!response.ok||!response.body)return response;
    let requestId=body.requestId,terminal=false,retries=0,reader,cancelled=false;
    const stream=new ReadableStream({
      async start(controller){
        try{
          while(!cancelled){
            let failure=null,pending='',decoder=new TextDecoder();reader=response.body.getReader();
            const forward=line=>{
              try{const frame=JSON.parse(line);if(!requestId&&typeof frame.requestId==='string')requestId=frame.requestId;if(frame.type==='done'||frame.type==='error')terminal=true;}catch{}
              if(!cancelled)controller.enqueue(encoder.encode(line));
            };
            try{
              for(;;){
                const {value,done}=await reader.read();
                if(done){
                  // Native NDJSON also permits a complete last frame without a
                  // newline. Never forward an interrupted partial JSON object.
                  pending+=decoder.decode();
                  if(pending.trim()){try{JSON.parse(pending);forward(pending+'\n');}catch{}}
                  break;
                }
                pending+=decoder.decode(value,{stream:true});let at;
                while((at=pending.indexOf('\n'))>=0){
                  const line=pending.slice(0,at+1);pending=pending.slice(at+1);
                  forward(line);
                }
              }
            }catch(error){failure=error;}finally{reader.releaseLock();reader=null;}
            if(cancelled)return;
            // A network failure after a complete terminal frame changes nothing.
            if(terminal){controller.close();return;}
            if(init.signal?.aborted)throw init.signal.reason??new DOMException('Aborted','AbortError');
            if(!requestId||retries>=3)throw failure??new Error('Соединение с ответом оборвалось. Не удалось восстановить этот ответ; проверьте состояние Strata.');
            const status={type:'status',phase:'waiting',code:'reconnecting',text:'Восстанавливаю соединение с текущим ответом…'};
            controller.enqueue(encoder.encode(JSON.stringify(status)+'\n'));
            await wait([500,1500,3000][retries++]);
            if(cancelled)return;
            if(init.signal?.aborted)throw init.signal.reason??new DOMException('Aborted','AbortError');
            // Exact request identity prevents attaching a later turn from another
            // window. The server owns both liveness and the replay snapshot.
            const attach=new URL('/api/chat/attach',url);
            try{response=await original(attach.href,{...init,body:JSON.stringify({sessionId:body.sessionId,requestId})});}
            catch(error){if(retries>=3)throw error;response=new Response(new ReadableStream({start(c){c.error(error);}}));continue;}
            if(!response.ok||!response.body)throw new Error('Не удалось подключиться к прежнему ответу Strata (HTTP '+response.status+'). Новый запрос автоматически не отправлен.');
          }
        }catch(error){if(!cancelled)controller.error(error);}
      },
      cancel(reason){cancelled=true;void reader?.cancel(reason).catch(()=>{});},
    });
    const headers=new Headers(response.headers);headers.delete('content-length');
    return new Response(stream,{status:response.status,statusText:response.statusText,headers});
  };
  return ()=>{target.fetch=original;};
}

/** Reserve only known storage directories inside this particular chat folder.
 * An unrelated project directory named "chats" must keep normal file tracking. */
export function chatDataExclusions(chatFile,workspace,path){
  if(!chatFile||!workspace)return [];
  const folder=path.dirname(path.dirname(chatFile));
  const same=(a,b)=>path.sep==='\\'?a.toLowerCase()===b.toLowerCase():a===b;
  if(!same(path.resolve(workspace),path.resolve(folder)))return [];
  return [path.dirname(chatFile),path.join(folder,'extensions')];
}
