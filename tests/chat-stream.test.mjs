import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {installChatStreamRecovery,chatDataExclusions} from '../runtime/core/chat-stream.mjs';

const encoder=new TextEncoder();
const line=frame=>JSON.stringify(frame)+'\n';
function response(chunks,fail=false){
  let i=0;
  return new Response(new ReadableStream({pull(c){
    if(i<chunks.length)c.enqueue(typeof chunks[i]==='string'?encoder.encode(chunks[i++]):chunks[i++]);
    else if(fail)c.error(new Error('Synthetic network loss'));else c.close();
  }}));
}
function fixture(replies){
  const calls=[],target={location:new URL('http://localhost:1234/'),fetch:async(input,init)=>{
    calls.push({url:String(input),body:JSON.parse(init?.body??'{}')});
    const next=replies.shift();if(next instanceof Error)throw next;return next;
  }};
  installChatStreamRecovery(target,{wait:async()=>{}});
  return {target,calls,post:(options={})=>target.fetch('/api/chat/stream',{method:'POST',body:JSON.stringify({sessionId:'synthetic-chat',message:'Synthetic request'}),...options})};
}

for(const failed of [true,false])test('reattaches the exact request after '+(failed?'network loss':'premature EOF')+' without repeating POST',async()=>{
  const f=fixture([response([line({type:'start',requestId:'request-a'}),line({type:'delta',text:'partial'}),'partial broken JSON'],failed),response([
    line({type:'start',requestId:'request-a',resumed:true}),line({type:'resync',content:'complete response'}),line({type:'done'})
  ])]);
  const frames=(await(await f.post()).text()).trim().split('\n').map(JSON.parse);
  let text='';for(const frame of frames){if(frame.type==='delta')text+=frame.text;if(frame.type==='resync')text=frame.content;}
  assert.equal(text,'complete response');assert.equal(frames.at(-1).type,'done');assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].url,'http://localhost:1234/api/chat/attach');
  assert.deepEqual(f.calls[1].body,{sessionId:'synthetic-chat',requestId:'request-a'});
});

test('UTF-8 split across chunks and a terminal last line without newline are preserved',async()=>{
  const bytes=encoder.encode(line({type:'delta',text:'Привет'})),cut=bytes.indexOf(0xd0)+1;
  const f=fixture([response([line({type:'start',requestId:'a'}),bytes.slice(0,cut),bytes.slice(cut),JSON.stringify({type:'done'})])]);
  const text=await(await f.post()).text();assert(text.includes('Привет'));assert(text.includes('"done"'));assert.equal(f.calls.length,1);
});

for(const type of ['done','error'])test(type+' is terminal even if the transport fails afterwards',async()=>{
  const f=fixture([response([line({type:'start',requestId:'a'}),line({type})],true)]);
  assert((await(await f.post()).text()).includes('"'+type+'"'));assert.equal(f.calls.length,1);
});

test('unknown request identity and initial HTTP failures never repeat the user request',async()=>{
  const f=fixture([response(['{'],true)]);await assert.rejects(async()=>await(await f.post()).text());assert.equal(f.calls.length,1);
  const http=fixture([new Response('Unavailable',{status:503})]);assert.equal((await http.post()).status,503);assert.equal(http.calls.length,1);
});

test('a rejected request identity never attaches a newer turn',async()=>{
  const f=fixture([response([line({type:'start',requestId:'old'})],true),new Response('Different turn',{status:409})]);
  await assert.rejects(async()=>await(await f.post()).text(),/HTTP 409/);assert.equal(f.calls.length,2);
});

test('reconnect failures are bounded and never change into generation requests',async()=>{
  const f=fixture([response([line({type:'start',requestId:'a'})],true),new Error('offline'),new Error('offline'),new Error('offline')]);
  await assert.rejects(async()=>await(await f.post()).text(),/offline/);assert.equal(f.calls.length,4);
  assert(f.calls.slice(1).every(row=>row.url.endsWith('/api/chat/attach')&&!row.body.message));
});

test('explicit abort and reader cancellation never reconnect',async()=>{
  const controller=new AbortController(),f=fixture([response([line({type:'start',requestId:'a'})],true)]);controller.abort();
  await assert.rejects(async()=>await(await f.post({signal:controller.signal})).text());assert.equal(f.calls.length,1);
  let cancelled=false;
  const g=fixture([new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(line({type:'start',requestId:'a'})));},cancel(){cancelled=true;}}))]);
  const reader=(await g.post()).body.getReader();await reader.read();await reader.cancel();
  assert.equal(cancelled,true);assert.equal(g.calls.length,1);
});

test('unrelated fetch responses are untouched',async()=>{
  const original=new Response('plain'),f=fixture([original]);
  assert.equal(await f.target.fetch('/api/status'),original);assert.equal(f.calls.length,1);
});

test('file tracking excludes chat-owned storage, never ordinary project directories',()=>{
  assert.deepEqual(chatDataExclusions('/workspace/one/chats/one.json','/workspace/one',path.posix),['/workspace/one/chats','/workspace/one/extensions']);
  assert.deepEqual(chatDataExclusions('/workspace/one/chats/one.json','/workspace/project',path.posix),[]);
  assert.deepEqual(chatDataExclusions('C:\\fixture\\one\\chats\\one.json','c:\\fixture\\ONE',path.win32),['C:\\fixture\\one\\chats','C:\\fixture\\one\\extensions']);
});
