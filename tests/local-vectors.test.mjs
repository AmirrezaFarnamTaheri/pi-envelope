import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {searchLocalVectors} from '../extensions/envelope/local-vectors.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';
const v=(n)=>[n,0,0,0,0,0,0,0];
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-vector-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'src'));mkdirSync(join(root,'.envelope'));
 const put=(path,body)=>writeFileSync(join(root,'src',path),body);
 put('apple.ts','export function apple(){return 1;}');
 put('berry.ts','export function berry(){return 2;}');
 const index=new CodeIndex(root,{ts});index.refresh();
 const manifest=join(root,'.envelope','embeddings.json');
 const make=(rows)=>writeFileSync(manifest,JSON.stringify({schema:1,model:'user-test-model',dimensions:8,entries:rows}));
 const row=(path,vector)=>({path:'src/'+path,sha256:index.files.get('src/'+path).contentSha256,vector});
 make([row('apple.ts',v(1)),row('berry.ts',[0,1,0,0,0,0,0,0])]);
 return {root,index,manifest,put,make,row};
}
test('offline cosine ranks real source-hash-matched embeddings without revealing vectors or code',t=>{
 const f=fixture(t),r=searchLocalVectors(f.index,{queryVector:v(1),limit:5,maxChars:3000});
 assert.equal(r.mode,'user-supplied-vector-search');
 assert.equal(r.results[0].path,'src/apple.ts');
 assert.ok(r.results[0].cosine>0.99);
 assert.equal(r.results[1].path,'src/berry.ts');
 assert.equal(r.results[1].cosine,0);
 assert.equal(r.model,'user-test-model');
 assert.equal(r.provenance,'external-vectors-with-verified-current-source');
 assert.doesNotMatch(JSON.stringify(r),/"vector"|return 1|return 2/);
});
test('hybrid reranking includes explicit local lexical evidence with no provider',t=>{
 const f=fixture(t),result=searchLocalVectors(f.index,{queryVector:v(1),query:'berry',limit:4,maxChars:3000});
 assert.equal(result.queryMode,'weighted-local-hybrid');
 assert.ok(result.results.find(x=>x.path==='src/berry.ts').lexicalRank>0);
 assert.equal(result.externalCalls,0);
});
test('stale, missing and not-indexed artifact rows cannot masquerade as verified answers',t=>{
 const f=fixture(t),rows=[f.row('apple.ts',v(1)),f.row('berry.ts',v(1))];
 rows[0].sha256='0'.repeat(64);rows.push({path:'src/missing.ts',sha256:'0'.repeat(64),vector:v(1)});f.make(rows);
 const r=searchLocalVectors(f.index,{queryVector:v(1)});
 assert.equal(r.skippedStale,2);
 assert.deepEqual(r.results.map(x=>x.path),['src/berry.ts']);
 assert.equal(r.complete,false);
 f.put('berry.ts','export function berry(){return 333;}');
 assert.throws(()=>searchLocalVectors(f.index,{queryVector:v(1)}),/changed|refresh|stale/i);
});
test('symlinked manifest and malformed vectors refuse execution without reading outside root',t=>{
 const f=fixture(t),outside=mkdtempSync(join(tmpdir(),'envelope-vector-outside-'));
 t.after(()=>rmSync(outside,{recursive:true,force:true}));
 const leak=join(outside,'vector.json');writeFileSync(leak,JSON.stringify({schema:1,model:'x',dimensions:8,entries:[]}));
 unlinkSync(f.manifest);symlinkSync(leak,f.manifest);
 assert.throws(()=>searchLocalVectors(f.index,{queryVector:v(1)}),/symlink|unsafe/i);
 unlinkSync(f.manifest);f.make([f.row('apple.ts',[1,2,3])]);
 assert.throws(()=>searchLocalVectors(f.index,{queryVector:v(1)}),/dimension|invalid/i);
});
test('query vector dimensions and finite magnitudes must match manifest',t=>{
 const f=fixture(t);
 assert.throws(()=>searchLocalVectors(f.index,{queryVector:[1,2]}),/dimension|length/i);
 assert.throws(()=>searchLocalVectors(f.index,{queryVector:[NaN,0,0,0,0,0,0,0]}),/finite|numeric|vector/i);
 assert.throws(()=>searchLocalVectors(f.index,{queryVector:v(0)}),/zero|norm/i);
 assert.throws(()=>searchLocalVectors(f.index,{queryVector:v(1),maxChars:15}),/maxChars/i);
});
test('paged vector results have version-guarded stable cursors and serialized byte limits',t=>{
 const f=fixture(t),first=searchLocalVectors(f.index,{queryVector:v(1),limit:1,maxChars:1500});
 assert.equal(first.nextOffset,1);assert.equal(first.truncated,true);
 const next=searchLocalVectors(f.index,{queryVector:v(1),offset:1,ifVersion:first.version,limit:1,maxChars:1500});
 assert.equal(next.results[0].path,'src/berry.ts');
 assert.ok(Buffer.byteLength(JSON.stringify(next),'utf8')<=1500);
 f.put('apple.ts','export function apple(){return 66;}');f.index.refresh();
 assert.throws(()=>searchLocalVectors(f.index,{queryVector:v(1),offset:1,ifVersion:first.version}),/stale|version/i);
});
test('Pi vector retrieval is off by default, requires a human opt-in, and registers no competing hooks',async t=>{
 const f=fixture(t),home=mkdtempSync(join(tmpdir(),'vector-home-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const tools=new Map(),commands=new Map(),hooks=new Map(),notices=[];
 const pi={cwd:f.root,registerTool:x=>tools.set(x.name,x),registerCommand:(name,x)=>commands.set(name,x),
  on:(name,x)=>hooks.set(name,[...(hooks.get(name)||[]),x]),logger:{warn(){}}};
 registerEnvelope(pi,{home,loadCompiler:()=>ts});
 const ctx={cwd:f.root,ui:{notify:x=>notices.push(x)},sessionManager:{getSessionId:()=> 'vectors-test'}};
 const vectorTool=tools.get('envelope_code_vector');assert.ok(vectorTool);
 const call=params=>vectorTool.execute('call',params,undefined,undefined,ctx);
 assert.equal((await call({action:'search',queryVector:v(1)})).isError,true);
 assert.equal(JSON.parse((await call({action:'status'})).content[0].text).enabled,false);
 await commands.get('envelope').handler('code vectors on',ctx);
 const found=await call({action:'search',queryVector:v(1),limit:2});
 assert.equal(found.isError,false,found.content[0].text);
 assert.equal(JSON.parse(found.content[0].text).results[0].path,'src/apple.ts');
 await commands.get('envelope').handler('code vectors off',ctx);
 assert.equal((await call({action:'search',queryVector:v(1)})).isError,true);
 assert.equal(hooks.get('before_agent_start').length,1);
 assert.equal(hooks.get('tool_result').length,1);
});
