import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareReplyRetry, replyCutNudge, replyCutNotice, replyRoom} from '../runtime/core/reply-recovery.mjs';

test('a nearly full context is compacted before a truncated call may continue', async () => {
  const events = [];
  const result = await prepareReplyRetry({cut:{tokens:5385}, context:async()=>({tokens:64100,window:65536}),
    compact:async()=>{events.push('compact');return {ok:true,after:{tokens:21000,window:65536}};},report:()=>events.push('status')});
  assert.equal(result.ok,true);assert.equal(result.compacted,true);
  assert.deepEqual(events,['status','compact']);assert(replyRoom(result.after)>0);
});

for (const tokens of [5385,405,1]) test('a failed compaction never admits another '+tokens+'-token continuation', async () => {
  let calls=0;
  const result=await prepareReplyRetry({cut:{tokens},context:async()=>({tokens:65100,window:65536}),compact:async()=>{calls++;return {ok:false};}});
  assert.equal(result.ok,false);assert.match(result.message,/История сохранена/);assert.equal(calls,1);
});

test('a normal output-cap cutoff with ample room does not compact unnecessarily',async()=>{
  const result=await prepareReplyRetry({cut:{tokens:32768},context:async()=>({tokens:22000,window:65536}),compact:()=>{throw Error('should not compact');}});
  assert.deepEqual(result,{ok:true,compacted:false});
});

for(const after of [null,{tokens:64000,window:65536},{tokens:62000,window:65536},{tokens:20000,window:0}])
test('compaction must produce verified usable headroom '+JSON.stringify(after),async()=>{
  const result=await prepareReplyRetry({cut:{tokens:1},context:async()=>({tokens:62000,window:65536}),compact:async()=>({ok:true,after})});
  assert.equal(result.ok,false);
});

test('a short cutoff forces recovery even if the token estimator says there is room',async()=>{
  let compacted=0;
  const result=await prepareReplyRetry({cut:{tokens:405},context:async()=>({tokens:10000,window:65536}),compact:async()=>{compacted++;return {ok:true,after:{tokens:5000,window:65536}};}});
  assert.equal(compacted,1);assert.equal(result.ok,true);
});

test('stop during compaction prevents the queued continuation',async()=>{
  let stopped=false;
  const result=await prepareReplyRetry({cut:{tokens:405},context:async()=>({tokens:62000,window:65536}),stopped:()=>stopped,compact:async()=>{stopped=true;return {ok:true,after:{tokens:20000,window:65536}};}});
  assert.deepEqual(result,{ok:false,cancelled:true});
});

test('a compacted context can fit a continuation below the ordinary output reservation',async()=>{
  const result=await prepareReplyRetry({cut:{tokens:5385},context:async()=>({tokens:58385,window:65536}),
    compact:async()=>({ok:true,after:{tokens:50503,window:65536}})});
  assert.equal(result.ok,true);
});

test('a provider output cutoff can continue when history is already short',async()=>{
  const result=await prepareReplyRetry({cut:{tokens:4096},context:async()=>({tokens:8000,window:65536}),
    compact:async()=>({ok:false,reason:'nothing'})});
  assert.deepEqual(result,{ok:true,compacted:false});
});

test('a one-token cutoff on a short history does not trigger a blind retry',async()=>{
  const result=await prepareReplyRetry({cut:{tokens:1},context:async()=>({tokens:8000,window:65536}),
    compact:async()=>({ok:false,reason:'nothing'})});
  assert.equal(result.ok,false);
  assert.match(result.message,/лимита вывода/);
});

test('failed context RPCs preserve data and do not start blind retries',async()=>{
  const result=await prepareReplyRetry({context:async()=>{throw Error('offline');},compact:()=>assert.fail()});
  assert.equal(result.ok,false);
});

test('non-file tools receive atomic retry advice, not instructions to edit a file',()=>{
  const cut={calls:[{name:'mcp__example__render',bytes:100}],tokens:5385};
  const nudge=replyCutNudge(cut);assert.match(nudge,/did NOT execute/);assert.match(nudge,/complete, schema-valid/);
  assert.doesNotMatch(nudge,/150 lines|read the end of the file/);
  assert.match(replyCutNotice({...cut,retrying:true}).text,/команды инструмента/);
  assert.equal(replyCutNudge({calls:[{name:'write',target:'example.txt'}]}),undefined);
  assert.equal(replyCutNotice({calls:[{name:'edit',target:'example.txt'}]}),undefined);
  assert.equal(replyCutNotice({recoveryError:'Recovery failed'}).text,'Recovery failed');
});
