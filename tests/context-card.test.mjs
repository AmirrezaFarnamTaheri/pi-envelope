import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {spawnSync} from 'node:child_process';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {projectContextCard} from '../extensions/envelope/context-card.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';
function repo(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-context-card-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(path,source)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),source)};
 put('src/a.ts','import {b} from "./b";\nexport function a(){return b();}\n');
 put('src/b.ts','export function b(){return 1;}\n');
 put('src/c.ts','import {a} from "./a";export const c=a();\n');
 const res=spawnSync('git',['init','-q'],{cwd:root,timeout:3000});assert.equal(res.status,0);
 const index=new CodeIndex(root,{ts});index.refresh();return {root,index,put};
}
test('returns short, provenance-grounded symbol and import context without raw source',t=>{
 const {index}=repo(t);const card=projectContextCard(index,{path:'src/a.ts'});
 assert.equal(card.mode,'bounded-syntactic-context-card');
 assert.match(card.source.sha256,/^[a-f0-9]{64}$/);
 assert.equal(card.source.path,'src/a.ts');
 assert.deepEqual(card.imports.outgoing,['src/b.ts']);
 assert.deepEqual(card.imports.incoming,['src/c.ts']);
 assert.ok(card.symbols.some(s=>s.name==='a'));
 assert.equal(card.calls.totalOutgoing,1);
 assert.ok(!JSON.stringify(card).includes('return b();'));
 assert.equal(card.provenance,'indexed-source-hash-verified');
});
test('exact symbol filtering, unknown symbol, dynamic receiver and explicit incompleteness',t=>{
 const {index,put}=repo(t);
 const card=projectContextCard(index,{path:'src/a.ts',symbol:'a'});
 assert.deepEqual(card.symbols.map(x=>x.name),['a']);
 assert.throws(()=>projectContextCard(index,{path:'src/a.ts',symbol:'missing'}),/symbol.*not indexed/i);
 put('src/a.ts','export function dynamic(){return unknown.dispatch();}\n');index.refresh();
 const unresolved=projectContextCard(index,{path:'src/a.ts'});
 assert.equal(unresolved.complete,false);
 assert.ok(unresolved.reasons.includes('unresolved-call-sites'));
});
test('refuses stale cached AST evidence if source has changed after refresh',t=>{
 const {index,put}=repo(t);put('src/b.ts','export function b(){return 9;}\n');
 assert.throws(()=>projectContextCard(index,{path:'src/b.ts'}),/source changed|refresh/i);
});
test('limits every list and excerpt, never traverses outside indexed root',t=>{
 const {index}=repo(t);
 const card=projectContextCard(index,{path:'src/a.ts',limit:1,includeSnippet:true});
 assert.ok(card.imports.outgoing.length<=1&&card.imports.incoming.length<=1);
 assert.ok(card.snippet.length<=500);
 assert.throws(()=>projectContextCard(index,{path:'../outside.ts'}),/outside/i);
 assert.throws(()=>projectContextCard(index,{path:'src/a.ts',limit:101}),/limit/i);
});
test('Pi tool exposes the card on the existing code API without another event hook',async t=>{
 const {root}=repo(t),tools=new Map(),events=[];
 const pi={registerTool(x){tools.set(x.name,x)},on(name){events.push(name)}};
 const feat=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,treeEnabled:false,languagesEnabled:false}}),loadCompiler:async()=>ts});
 assert.ok(tools.has('envelope_code_context_card'));
 const result=await tools.get('envelope_code_context_card').execute('id',{path:'src/a.ts'},null,null,{cwd:root});
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(JSON.parse(result.content[0].text).source.path,'src/a.ts');
 assert.equal(events.length,0);feat.close();
});
