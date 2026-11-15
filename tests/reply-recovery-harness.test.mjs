import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

const host=process.env.STRATA_TEST_HOST,source=process.env.STRATA_TEST_RECOVERY_BRIDGED_SOURCE,harness=process.env.STRATA_HARNESS_DIR;
const enabled=host&&source&&harness;
// Uses the actual host, Gateway, session log, compactor and pinned Harness.
// Only the model endpoint is scripted; no user chats or model server are read.
test('native max-token retry compacts first and returns with enough room',{skip:!enabled,timeout:120000},async t=>{
  const parent=path.resolve('.work/tests');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'reply-harness-')),server=path.join(root,'server');
  fs.cpSync(path.join(host,'server'),server,{recursive:true});
  fs.copyFileSync(path.join(source,'apps/host/server/agent/agent-bridge.mjs'),path.join(server,'agent/agent-bridge.mjs'));
  const shim=path.join(root,'shim.mjs');
  const moduleUrl=JSON.stringify(pathToFileURL(path.resolve('runtime/core/reply-recovery.mjs')).href);
  fs.writeFileSync(shim,`export * from ${moduleUrl};\nimport {prepareReplyRetry as prepare} from ${moduleUrl};\nexport const observations=[];\nexport const prepareReplyRetry=options=>prepare({...options,context:async()=>{const value=await options.context();observations.push({context:value});return value;},compact:async()=>{const value=await options.compact();observations.push({compact:value});return value;}});\nexport const workerEnvironment=()=>({});\nexport const bindSessionRules=()=>{};\n`);
  const previous=process.env.STRATA_EXTENSIONS_ENTRY;process.env.STRATA_EXTENSIONS_ENTRY=pathToFileURL(shim).href;
  let agent,endpoint;const steps=[],frames=[];let cuts=0,summaries=0,retries=0;
  t.after(async()=>{
    await agent?.close();if(endpoint)await new Promise(resolve=>endpoint.close(resolve));
    if(previous===undefined)delete process.env.STRATA_EXTENSIONS_ENTRY;else process.env.STRATA_EXTENSIONS_ENTRY=previous;
    assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,maxRetries:8,retryDelay:100});
  });
  const text=m=>typeof m?.content==='string'?m.content:(m?.content??[]).map(p=>p.text??'').join('\n');
  endpoint=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1000}');return;}
    const body=JSON.parse(raw||'{}'),messages=body.messages??[];
    const last=text([...messages].reverse().find(m=>m.role==='user'&&/FIXTURE_|last reply reached|compaction engine|structured checkpoint|Condense the conversation/i.test(text(m))));
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(delta,finish=null)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
    const done=(reason,input=1200,output=40)=>{send({},reason);res.write('data: '+JSON.stringify({id:'fixture',choices:[],usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output}})+'\n\n');res.end('data: [DONE]\n\n');};
    if(/compaction engine|structured checkpoint|Condense the conversation/i.test(last)){
      summaries++;steps.push('summary');send({role:'assistant',content:'The user requested a synthetic operation. Earlier work contains repeated fixture notes. The incomplete operation did not execute. Continue the unfinished request with a complete valid tool call.'});done('stop');return;
    }
    if(last.includes('FIXTURE_SEED')){send({role:'assistant',content:'Synthetic context, no private data. '.repeat(2000)});done('stop',1200,18000);return;}
    if(last.includes('last reply reached the output limit')){
      retries++;steps.push('retry');assert(summaries>0,'native compaction must finish before retry');
      assert(!last.includes('read the end of the file'));send({role:'assistant',content:'FIXTURE_RECOVERED'});done('stop');return;
    }
    if(last.includes('FIXTURE_CUT')){
      cuts++;steps.push('cut');send({role:'assistant',content:'',tool_calls:[{index:0,id:'unfinished',type:'function',function:{name:'mcp__example__render',arguments:'{"description":"unfinished'}}]});done('length',53000,5385);return;
    }
    send({role:'assistant',content:'Probe ready.'});done('stop');
  });
  await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
  const {createAgentBridge}=await import(pathToFileURL(path.join(server,'agent/agent-bridge.mjs')).href);
  agent=createAgentBridge({dataDir:path.join(root,'data'),localInstances:()=>[{id:'fixture',label:'Scripted fixture',baseUrl:'http://127.0.0.1:'+endpoint.address().port,modelId:'fixture',context:65536}],connections:()=>[],
    tools:()=>({off:new Set(),search:{provider:'builtin',key:''},webWithoutAsking:false,browserEnabled:false,servers:{}}),env:{STRATA_HARNESS_DIR:harness},startTimeoutMs:45000});
  const options={chatId:'fixture',history:[],workspacePath:root,mode:'bypass',onFrame:f=>frames.push(f)};
  await agent.runTurn({...options,message:'FIXTURE_SEED'});
  await agent.runTurn({...options,message:'FIXTURE_CUT'});
  const {observations}=await import(pathToFileURL(shim).href);
  const diagnostics=JSON.stringify({steps,observations,frames:frames.filter(f=>f.type==='error'||f.type==='delta'||f.type==='status').map(f=>({...f,text:f.text?.slice(0,300)}))});
  assert.equal(cuts,1,diagnostics);assert.equal(retries,1,diagnostics);assert(summaries>=1,diagnostics);
  assert(frames.some(f=>f.text?.includes('FIXTURE_RECOVERED')));
  assert(!frames.some(f=>f.type==='error'),JSON.stringify(frames.filter(f=>f.type==='error')));
  assert.deepEqual(steps.slice(0,3),['cut','summary','retry']);
});
