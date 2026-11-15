import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const script=path.resolve('scripts/bridge.mjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
const run=(root,source=false,flags=[])=>spawnSync(process.execPath,[script,root,...(source?['--source']:[]),...flags],{encoding:'utf8',maxBuffer:1024*1024,windowsHide:true});
function plan(root,source=false){const result=run(root,source,['--plan']);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
const stages=[];
test.after(()=>{for(const destination of stages){assert.equal(path.dirname(destination),path.resolve('.work/tests'));fs.rmSync(destination,{recursive:true});}});
function stage(root,source=false){
  const description=plan(root,source),parent=path.resolve('.work/tests');fs.mkdirSync(parent,{recursive:true});
  const destination=fs.mkdtempSync(path.join(parent,'upstream-0213-'));
  stages.push(destination);
  for(const relative of description.inputs){const file=path.join(destination,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(root,relative),file);}
  return{destination,description};
}
function hashes(root,files){return Object.fromEntries(files.map(file=>[file,fs.existsSync(path.join(root,file))?hash(fs.readFileSync(path.join(root,file))):null]));}

// Optional official fixtures are supplied by the release validation, never
// downloaded by tests. Staging consumes the public preflight input contract.
const release=path.resolve(process.env.STRATA_TEST_CLEAN_RELEASE??'.work/upgrade-0213/release');
const upstreamSource=path.resolve(process.env.STRATA_TEST_UPSTREAM_SOURCE??'.work/upgrade-0213/upstream');
for(const source of [false,true]){
  const root=source?upstreamSource:release;
  test(`0.2.13 ${source?'source':'compiled'} bridge preflights, applies and repeats without changing bytes`,{skip:!fs.existsSync(path.join(root,source?'apps/host/package.json':'host/package.json'))},()=>{
    const{destination,description}=stage(root,source),files=[...description.inputs,...description.writes.map(row=>row.file)],initial=hashes(destination,files);
    assert.equal(description.upstream,'v0.2.13');assert.equal(description.commit,'d2f096475817d4666c364c820b0ca830f751cfc5');
    assert.equal(description.distribution,'strata-mod-public');assert.equal(description.bridgeSchema,1);
    const prefix=source?'apps/host/':'host/',gate=prefix+'server/agent/plugins/strata-gate.mjs';
    fs.copyFileSync(path.join(root,gate),path.join(destination,gate));
    const nativeGate=hash(fs.readFileSync(path.join(destination,gate)));
    const check=run(destination,source,['--check']);assert.equal(check.status,0,check.stderr);assert.deepEqual(hashes(destination,files),initial,'preflight does not write even generated adapters');
    assert.deepEqual(JSON.parse(check.stdout),description,'the listed inputs are sufficient to stage the complete bridge');
    const result=run(destination,source);assert.equal(result.status,0,result.stderr);
    for(const row of description.writes)assert.equal(hash(fs.readFileSync(path.join(destination,row.file))),row.after,row.file);
    const after=hashes(destination,files),again=plan(destination,source);assert.deepEqual(again.writes,[]);assert.deepEqual(hashes(destination,files),after);
    const repeated=stage(destination,source);assert.deepEqual(plan(repeated.destination,source).writes,[],'idempotent plan lists unchanged required inputs');
    assert.equal(hash(fs.readFileSync(path.join(destination,gate))),nativeGate,'native approval policy stays byte-identical');
    const server=fs.readFileSync(path.join(destination,prefix+'server/index.mjs'),'utf8');
    for(const hook of ['bridge?.chatRules(sessionId)','bridge?.attachChatManagement','bridge.createChatStore','bridge.createUploads'])assert(server.includes(hook),hook);
    assert(server.includes('tools: () => agentTools.profileView()'));
    for(const row of description.writes.filter(row=>/\.(mjs|js)$/.test(row.file))){const syntax=spawnSync(process.execPath,['--check',path.join(destination,row.file)],{encoding:'utf8',windowsHide:true});assert.equal(syntax.status,0,row.file+'\n'+syntax.stderr);}
    const application=source?'apps/host/src/lib/store.ts':description.writes.find(row=>/dist\/assets\/.+\.js$/.test(row.file)).file;
    const text=fs.readFileSync(path.join(destination,application),'utf8');for(const hook of ['strataExtensionsChatAdapter','strataExtensionsBranch','strataExtensionsChat?.beforeSend'])assert(text.includes(hook),hook);
  });
}

test('late anchor mismatch and modified receipts fail before any writes',{skip:!fs.existsSync(path.join(release,'host/package.json'))},()=>{
  const{destination,description}=stage(release),asset=description.writes.find(row=>/dist\/assets\/.+\.js$/.test(row.file)).file;
  const original=fs.readFileSync(path.join(destination,asset),'utf8');assert(original.includes('E=kNe(i,N,w);return{sessions:E.sessions'));
  fs.writeFileSync(path.join(destination,asset),original.replace('E=kNe(i,N,w);return{sessions:E.sessions','E=kNe(i,N,w);return{sessionsChanged:E.sessions'));
  const files=[...description.inputs,...description.writes.map(row=>row.file)],before=hashes(destination,files),failed=run(destination);
  assert.notEqual(failed.status,0);assert.match(failed.stderr,/Chat recovery bridge anchor mismatch/);assert.deepEqual(hashes(destination,files),before);
  fs.writeFileSync(path.join(destination,asset),original);assert.equal(run(destination).status,0);
  fs.appendFileSync(path.join(destination,asset),'\n// unauthorized late edit');const tampered=hashes(destination,files),rejected=run(destination,false,['--plan']);
  assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/Previously bridged file changed/);assert.deepEqual(hashes(destination,files),tampered);
});

test('an unrecognized receipt is rejected before any application bytes change',{skip:!fs.existsSync(path.join(release,'host/package.json'))},()=>{
  const{destination,description}=stage(release),receipt=path.join(destination,'strata-bridge-receipt.json');
  const files=[...description.inputs,'strata-bridge-receipt.json'];
  for(const extra of [{},{distribution:'another-overlay',bridgeSchema:1},{distribution:'strata-mod-public',bridgeSchema:2}]){
    fs.writeFileSync(receipt,JSON.stringify({upstream:'v0.2.13',commit:'d2f096475817d4666c364c820b0ca830f751cfc5',files:[],...extra}));
    const before=hashes(destination,files),result=run(destination,false,['--plan']);
    assert.notEqual(result.status,0);assert.match(result.stderr,/Unsupported bridge receipt/);assert.deepEqual(hashes(destination,files),before);
  }
});

test('generated adapters are never silently overwritten',{skip:!fs.existsSync(path.join(release,'host/package.json'))},()=>{
  const{destination,description}=stage(release),relative='host/server/strata-rules-bridge.mjs';fs.writeFileSync(path.join(destination,relative),'export const rulesBridge=null; // foreign adapter\n');
  const files=[...description.inputs,...description.writes.map(row=>row.file)],before=hashes(destination,files),result=run(destination);
  assert.notEqual(result.status,0);assert.match(result.stderr,/Generated bridge adapter changed/);assert.deepEqual(hashes(destination,files),before);
});
