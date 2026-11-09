import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,rmSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {LocalEmbeddingRuntime} from '../extensions/envelope/local-embedding-runtime.mjs';
import {searchLocalVectors} from '../extensions/envelope/local-vectors.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';

const sourceA = 'export function documentOne(){ return "auth retry backoff"; }';
const sourceB = 'export function documentTwo(){ return "database query"; }';
const encoderJS = String.raw`
const fs=require('node:fs');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(process.env.PRIVATE_LLM_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) process.exit(31);
if(process.env.HF_HUB_OFFLINE!=='1' || process.env.TRANSFORMERS_OFFLINE!=='1')process.exit(32);
if(process.env.HOME===process.env.ORIGINAL_HOME_TEST) process.exit(33);
if(input.schema!==1 || !['embed-documents','embed-query'].includes(input.task))process.exit(34);
const vector=t=>[...Array(8)].map((_,i)=>i===0?(t.includes('auth')?1:0.1):(i===1?(t.includes('database')?1:0.1):0));
if(input.task==='embed-documents'){
 const entries=input.documents.map(item=>({path:item.path,vector:vector(item.text)}));
 process.stdout.write(JSON.stringify({schema:1,model:'trusted-local-fixture-encoder',dimensions:8,entries}));
}else{
 process.stdout.write(JSON.stringify({schema:1,model:'trusted-local-fixture-encoder',dimensions:8,vector:vector(input.text)}));
}
`;
function fixture(t,script=encoderJS){
 const root=mkdtempSync(join(tmpdir(),'env-embedding-source-'));
 const trusted=mkdtempSync(join(tmpdir(),'env-embedding-trusted-'));
 const home=mkdtempSync(join(tmpdir(),'env-embedding-home-'));
 t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(trusted,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});});
 mkdirSync(join(root,'src'));
 const put=(path,content)=>writeFileSync(join(root,'src',path),content);
 put('first.ts',sourceA);put('second.ts',sourceB);
 const encoder=join(trusted,'embedder');
 writeFileSync(encoder,'#!/usr/bin/env node\n'+script+'\n',{mode:0o700});
 const index=new CodeIndex(root,{ts,maxFiles:20,maxBytesPerFile:100000});index.refresh();
 return {root,trusted,home,encoder,index,put,manifest:join(root,'.envelope','embeddings.json')};
}

test('explicit build calls pinned trusted encoder once and writes private source-bound manifest',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 const prior=process.env.PRIVATE_LLM_KEY;
 process.env.PRIVATE_LLM_KEY='must-never-enter-encoder-env';
 try{
  const result=await runtime.build(f.index,{executable:f.encoder});
  assert.equal(result.created,true);assert.equal(result.files,2);
  assert.equal(result.model,'trusted-local-fixture-encoder');assert.equal(result.dimensions,8);
  assert.equal(lstatSync(f.manifest).mode&0o777,0o600);
  const data=JSON.parse(readFileSync(f.manifest,'utf8'));
  assert.deepEqual(data.entries.map(x=>x.path),['src/first.ts','src/second.ts']);
  assert.equal(data.entries[0].sha256,f.index.files.get('src/first.ts').contentSha256);
  assert.ok(data.entries.every(x=>x.vector.length===8));
  assert.doesNotMatch(JSON.stringify(result),/auth retry|database query|must-never-enter/);
  const ranked=searchLocalVectors(f.index,{queryVector:[1,.1,0,0,0,0,0,0]});
  assert.equal(ranked.results[0].path,'src/first.ts');
 }finally{if(prior===undefined)delete process.env.PRIVATE_LLM_KEY;else process.env.PRIVATE_LLM_KEY=prior;}
});

test('a human must explicitly replace existing vectors; a failed replace keeps old bytes',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 await runtime.build(f.index,{executable:f.encoder});
 const old=readFileSync(f.manifest,'utf8');
 await assert.rejects(runtime.build(f.index,{executable:f.encoder}),/exists|replace/i);
 const broken=join(f.trusted,'broken');writeFileSync(broken,'#!/usr/bin/env node\nprocess.stdout.write("bad json");\n',{mode:0o700});
 await assert.rejects(runtime.build(f.index,{executable:broken,replace:true}),/encoder|invalid|JSON/i);
 assert.equal(readFileSync(f.manifest,'utf8'),old);
 f.put('first.ts','export const changed=3;');f.index.refresh();
 const result=await runtime.build(f.index,{executable:f.encoder,replace:true});
 assert.equal(result.replaced,true);
 assert.notEqual(readFileSync(f.manifest,'utf8'),old);
});

test('text search embeds query with same pinned model and uses already hash-verified vector retriever',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 await runtime.build(f.index,{executable:f.encoder});
 const result=await runtime.find(f.index,{executable:f.encoder,query:'auth retry'});
 assert.equal(result.results[0].path,'src/first.ts');
 assert.equal(result.queryMode,'weighted-local-hybrid');
 assert.ok(!JSON.stringify(result).includes('auth retry backoff'));
 const wrong=join(f.trusted,'other-model');
 writeFileSync(wrong,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({schema:1,model:"different-model",dimensions:8,vector:[1,0,0,0,0,0,0,0]}));',{mode:0o700});
 await assert.rejects(runtime.find(f.index,{executable:wrong,query:'auth retry'}),/model|mismatch/i);
});

test('refuses stale files and symlink substitutions without writing an embeddings manifest',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 f.put('first.ts','export const a=9;');
 await assert.rejects(runtime.build(f.index,{executable:f.encoder}),/stale|changed|refresh/i);
 assert.throws(()=>lstatSync(f.manifest),/ENOENT/);
 f.index.refresh();
 const out=join(f.trusted,'outside.ts');writeFileSync(out,'export const secret=42;');
 unlinkSync(join(f.root,'src','second.ts'));symlinkSync(out,join(f.root,'src','second.ts'));
 await assert.rejects(runtime.build(f.index,{executable:f.encoder}),/symlink|unsafe/i);
 assert.throws(()=>lstatSync(f.manifest),/ENOENT/);
});

test('rejects project-local encoders, dangerous output paths and malicious vector responses',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 const local=join(f.root,'bad-encoder');writeFileSync(local,'#!/usr/bin/env node\nprocess.exit(0);',{mode:0o700});
 await assert.rejects(runtime.build(f.index,{executable:local}),/outside|unsafe|executable/i);
 mkdirSync(join(f.root,'.envelope'));
 const target=join(f.trusted,'sensitive');mkdirSync(target);
 rmSync(join(f.root,'.envelope'),{recursive:true});symlinkSync(target,join(f.root,'.envelope'));
 await assert.rejects(runtime.build(f.index,{executable:f.encoder}),/symlink|unsafe/i);
 rmSync(join(f.root,'.envelope'));
 const malformed=join(f.trusted,'malformed');
 writeFileSync(malformed,'#!/usr/bin/env node\nconst j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(JSON.stringify({schema:1,model:"bad",dimensions:8,entries:j.documents.map(d=>({path:d.path,vector:[Infinity,0,0,0,0,0,0,0]}))}));',{mode:0o700});
 await assert.rejects(runtime.build(f.index,{executable:malformed}),/vector|finite|dimension|invalid/i);
 assert.throws(()=>lstatSync(f.manifest),/ENOENT/);
});

test('cancellation, timeouts and output overflow fail closed and never write partial manifests',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime(),hang=join(f.trusted,'hang');
 writeFileSync(hang,'#!/usr/bin/env node\nsetInterval(()=>{},1000);',{mode:0o700});
 await assert.rejects(runtime.build(f.index,{executable:hang,timeoutMs:100}),/time|timeout/i);
 const ctrl=new AbortController();ctrl.abort();
 await assert.rejects(runtime.build(f.index,{executable:f.encoder,signal:ctrl.signal}),/cancel|abort/i);
 const huge=join(f.trusted,'huge');writeFileSync(huge,'#!/usr/bin/env node\nprocess.stdout.write("z".repeat(2_000_000));',{mode:0o700});
 await assert.rejects(runtime.build(f.index,{executable:huge}),/budget|size|limit/i);
 assert.throws(()=>lstatSync(f.manifest),/ENOENT/);
});

test('source changed during slow encoder execution cannot be accepted as a valid snapshot',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime(),sneaky=join(f.trusted,'sneaky');
 const target=join(f.root,'src','first.ts');
 writeFileSync(sneaky,'#!/usr/bin/env node\nconst fs=require("node:fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); fs.writeFileSync('+JSON.stringify(target)+',"modified mid-build"); process.stdout.write(JSON.stringify({schema:1,model:"test",dimensions:8,entries:j.documents.map(x=>({path:x.path,vector:[1,0,0,0,0,0,0,0]}))}));',{mode:0o700});
 await assert.rejects(runtime.build(f.index,{executable:sneaky}),/changed|stale|source|refresh/i);
 assert.throws(()=>lstatSync(f.manifest),/ENOENT/);
});

test('human-only Pi commands pin encoder and build/find; agent-facing vector tool cannot call encoder',async t=>{
 const f=fixture(t),tools=new Map(),commands=new Map(),hooks=new Map(),notices=[];
 const pi={cwd:f.root,registerTool:x=>tools.set(x.name,x),registerCommand:(name,x)=>commands.set(name,x),
  on:(name,x)=>hooks.set(name,[...(hooks.get(name)||[]),x]),logger:{warn(){}}};
 registerEnvelope(pi,{home:f.home,loadCompiler:()=>ts});
 const ctx={cwd:f.root,ui:{notify:x=>notices.push(x)},sessionManager:{getSessionId:()=> 'embedding-test'}};
 const call=async command=>commands.get('envelope').handler(command,ctx);
 await call('code vectors build');assert.ok(notices.some(x=>/disabled|not configured|pinned/i.test(x)),notices.join('\n'));
 await call('code vectors encoder '+f.encoder);
 await call('code vectors on');
 await call('code vectors build');
 assert.equal(lstatSync(f.manifest).mode&0o777,0o600);
 await call('code vectors sync');
 assert.ok(notices.some(x=>/local vector sync: embedded 0, reused 2, removed 0/.test(x)),notices.join('\n'));

 await call('code vectors find auth retry');
 assert.ok(notices.some(x=>/src\/first\.ts/.test(x)),notices.join('\n'));
 const tool=tools.get('envelope_code_vector');assert.ok(tool);
 const forbidden=await tool.execute('one',{action:'build'},null,null,ctx);
 assert.equal(forbidden.isError,true);
 assert.equal(hooks.get('before_agent_start').length,1);
 assert.equal(hooks.get('tool_result').length,1);
 assert.equal(hooks.get('session_shutdown').length,1);
});


test('manual sync embeds only changed/new sources and keeps verified unchanged vectors',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 await runtime.build(f.index,{executable:f.encoder});
 const old=JSON.parse(readFileSync(f.manifest,'utf8'));
 f.put('first.ts','export function documentOne(){ return "changed auth retry"; }');
 f.index.refresh();
 const onlyChanged=join(f.trusted,'only-changed');
 writeFileSync(onlyChanged,'#!/usr/bin/env node\n'+
  'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));\n'+
  'if(j.task!=="embed-documents"||j.documents.length!==1||j.documents[0].path!=="src/first.ts")process.exit(41);\n'+
  'process.stdout.write(JSON.stringify({schema:1,model:"trusted-local-fixture-encoder",dimensions:8,entries:[{path:"src/first.ts",vector:[0,1,0,0,0,0,0,0]}]}));\n',{mode:0o700});
 const result=await runtime.sync(f.index,{executable:onlyChanged});
 assert.equal(result.embedded,1);assert.equal(result.reused,1);assert.equal(result.removed,0);
 const next=JSON.parse(readFileSync(f.manifest,'utf8'));
 assert.equal(next.entries.length,2);
 assert.deepEqual(next.entries[1],old.entries[1],'unchanged verified vector must be retained');
 assert.notDeepEqual(next.entries[0].vector,old.entries[0].vector);
 assert.equal(next.entries[0].sha256,f.index.files.get('src/first.ts').contentSha256);
});

test('manual sync with no source changes is a true no-op and never invokes encoder',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 await runtime.build(f.index,{executable:f.encoder});
 const before=readFileSync(f.manifest,'utf8');
 const failIfCalled=join(f.trusted,'should-not-run');
 writeFileSync(failIfCalled,'#!/usr/bin/env node\nprocess.exit(97);\n',{mode:0o700});
 const report=await runtime.sync(f.index,{executable:failIfCalled});
 assert.equal(report.unchanged,true);assert.equal(report.embedded,0);assert.equal(report.reused,2);
 assert.equal(readFileSync(f.manifest,'utf8'),before);
});

test('manual sync removes only deleted indexed files without launching an encoder',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 await runtime.build(f.index,{executable:f.encoder});
 unlinkSync(join(f.root,'src','second.ts'));f.index.refresh();
 const failIfCalled=join(f.trusted,'should-not-run');
 writeFileSync(failIfCalled,'#!/usr/bin/env node\nprocess.exit(97);\n',{mode:0o700});
 const report=await runtime.sync(f.index,{executable:failIfCalled});
 assert.equal(report.embedded,0);assert.equal(report.reused,1);assert.equal(report.removed,1);
 const rows=JSON.parse(readFileSync(f.manifest,'utf8')).entries;
 assert.deepEqual(rows.map(x=>x.path),['src/first.ts']);
});

test('manual sync rejects model drift and stale bytes without overwriting previous vectors',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 await runtime.build(f.index,{executable:f.encoder});
 const original=readFileSync(f.manifest,'utf8');
 f.put('first.ts','export const changed = true;');
 await assert.rejects(runtime.sync(f.index,{executable:f.encoder}),/stale|changed|refresh/i);
 assert.equal(readFileSync(f.manifest,'utf8'),original);
 f.index.refresh();
 const badModel=join(f.trusted,'bad-model');
 writeFileSync(badModel,'#!/usr/bin/env node\n'+
 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));\n'+
 'process.stdout.write(JSON.stringify({schema:1,model:"unexpected-model",dimensions:8,entries:j.documents.map(x=>({path:x.path,vector:[1,0,0,0,0,0,0,0]}))}));\n',{mode:0o700});
 await assert.rejects(runtime.sync(f.index,{executable:badModel}),/model|mismatch/i);
 assert.equal(readFileSync(f.manifest,'utf8'),original);
});


test('incremental sync rejects concurrent manifest changes rather than overwriting another writer',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 await runtime.build(f.index,{executable:f.encoder});
 f.put('first.ts','export const changed = 1234;');f.index.refresh();
 const concurrent=join(f.trusted,'concurrent-writer');
 writeFileSync(concurrent,'#!/usr/bin/env node\n'+
  'const fs=require("node:fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));\n'+
  'const path='+JSON.stringify(f.manifest)+';\n'+
  'const prior=JSON.parse(fs.readFileSync(path,"utf8"));prior.concurrentWriterMarker=true;fs.writeFileSync(path,JSON.stringify(prior));\n'+
  'process.stdout.write(JSON.stringify({schema:1,model:"trusted-local-fixture-encoder",dimensions:8,entries:j.documents.map(x=>({path:x.path,vector:[1,0,0,0,0,0,0,0]}))}));\n',{mode:0o700});
 await assert.rejects(runtime.sync(f.index,{executable:concurrent}),/manifest changed|retry/i);
 const after=JSON.parse(readFileSync(f.manifest,'utf8'));
 assert.equal(after.concurrentWriterMarker,true);
 assert.equal(after.entries[0].sha256!==f.index.files.get('src/first.ts').contentSha256,true,'runtime must not overwrite the concurrent manifest');
});

test('incremental sync requires an existing validated manifest and never implicitly builds one',async t=>{
 const f=fixture(t),runtime=new LocalEmbeddingRuntime();
 await assert.rejects(runtime.sync(f.index,{executable:f.encoder}),/missing or invalid|build explicitly/i);
 assert.throws(()=>lstatSync(f.manifest),/ENOENT/);
});
