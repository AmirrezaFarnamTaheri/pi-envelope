import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {buildContextSlice} from '../extensions/envelope/context-slice.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-slice-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'src'));
 const files={
   'src/auth.ts':"import {lookup} from './db';\nexport function authenticate(){return lookup('PRIVATE_BODY_NEVER_SHOWN')}\n",
   'src/db.ts':'export function lookup(id:string){return id;}\n',
   'src/main.ts':"import {authenticate} from './auth';\nexport function main(){return authenticate()}\n",
   'src/unrelated.ts':'export function idle(){return 1;}\n'
 };
 for(const [p,v] of Object.entries(files))writeFileSync(join(root,p),v);
 const index=new CodeIndex(root,{ts,maxFiles:30,maxBytesPerFile:100_000});index.refresh();
 return {root,index,write:(p,v)=>writeFileSync(join(root,p),v)};
}

test('a lexical task expands across deterministic static import edges with verified cards',t=>{
 const {index}=fixture(t);
 const result=buildContextSlice(index,{query:'authenticate',direction:'both',depth:1,limit:10,maxChars:12000});
 const paths=result.items.map(x=>x.path);
 assert.equal(result.provenance,'source-verified-CodeIndex');
 assert.equal(result.externalProvidersUsed,false);
 assert.equal(result.seedPaths[0],'src/auth.ts');
 assert.deepEqual(paths,['src/auth.ts','src/db.ts','src/main.ts']);
 assert.ok(result.items.every(x=>['card','skeleton','ref'].includes(x.tier)));
 assert.equal(result.items[0].distance,0);
 assert.equal(result.items[1].distance,1);
 assert.equal(result.items[0].card.source.path,'src/auth.ts');
 assert.match(result.items[0].etag,/^[0-9a-f]{64}$/);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_BODY_NEVER_SHOWN/);
 assert.ok(Buffer.byteLength(JSON.stringify(result),'utf8')<=12000);
});

test('an explicit entry path scopes traversal direction and never drags unrelated files',t=>{
 const {index}=fixture(t);
 const result=buildContextSlice(index,{path:'src/auth.ts',direction:'outgoing',depth:1,limit:10,maxChars:12000});
 assert.deepEqual(result.items.map(x=>x.path),['src/auth.ts','src/db.ts']);
 assert.equal(result.seedPaths[0],'src/auth.ts');
 assert.equal(result.method,'exact-entry-and-static-import-traversal');
});

test('tight byte budgets degrade from full cards to compact evidence instead of truncating JSON',t=>{
 const {index}=fixture(t);
 const result=buildContextSlice(index,{path:'src/auth.ts',direction:'both',depth:1,limit:10,maxChars:1100});
 assert.ok(result.items.length>=1);
 assert.ok(result.items.some(x=>x.tier!=='card'));
 assert.ok(Buffer.byteLength(JSON.stringify(result),'utf8')<=1100);
 assert.ok(result.truncated || result.items.length===result.totalCandidates);
});

test('known card etags permit conditional references with no duplicate card body',t=>{
 const {index}=fixture(t);
 const first=buildContextSlice(index,{path:'src/auth.ts',depth:0,limit:4,maxChars:4000});
 const tag=first.items[0].etag;
 const second=buildContextSlice(index,{path:'src/auth.ts',depth:0,limit:4,maxChars:4000,knownEtags:[tag]});
 assert.equal(second.items[0].tier,'ref');
 assert.equal(second.items[0].etag,tag);
 assert.equal('card' in second.items[0],false);
 assert.equal(second.version,first.version);
});

test('continuation cursors bind to exact current index and task selection',t=>{
 const {index,write}=fixture(t);
 const first=buildContextSlice(index,{path:'src/auth.ts',depth:2,limit:1,maxChars:4000});
 assert.equal(first.totalCandidates,3);
 assert.equal(first.nextOffset,1);
 assert.throws(()=>buildContextSlice(index,{path:'src/auth.ts',depth:2,offset:1}),/version|cursor/i);
 const second=buildContextSlice(index,{path:'src/auth.ts',depth:2,offset:1,ifVersion:first.version,limit:1,maxChars:4000});
 assert.equal(second.items.length,1);
 assert.notEqual(first.items[0].path,second.items[0].path);
 write('src/db.ts','export function lookup(id:string){return id+"new";}');index.refresh();
 assert.throws(()=>buildContextSlice(index,{path:'src/auth.ts',depth:2,offset:1,ifVersion:first.version}),/stale|version/i);
});

test('a stale indexed source is rejected before returning a believable context card',t=>{
 const {index,write}=fixture(t);
 write('src/auth.ts','export function authenticate(){return 999;}');
 assert.throws(()=>buildContextSlice(index,{path:'src/auth.ts'}),/changed since|refresh|source/i);
});

test('a missing lexical seed reports absence rather than inventing connected evidence',t=>{
 const {index}=fixture(t);
 const result=buildContextSlice(index,{query:'zzyyxxnonexistent',limit:6,maxChars:4000});
 assert.equal(result.totalCandidates,0);
 assert.deepEqual(result.items,[]);
 assert.equal(result.complete,false);
 assert.ok(result.reasons.includes('no-lexical-seeds'));
});

test('invalid requests, traversal, impossible budgets and invalid known-etags fail closed',t=>{
 const {index}=fixture(t);
 for(const options of [
  {},{query:'',path:'src/auth.ts'}, {query:'hello',path:'src/auth.ts'},
  {path:'../../outside.ts'}, {path:'src/auth.ts',depth:6},
  {path:'src/auth.ts',limit:0}, {path:'src/auth.ts',maxChars:200},
  {path:'src/auth.ts',knownEtags:['bogus']},
  {query:'x'.repeat(200)},
 ])assert.throws(()=>buildContextSlice(index,options),/required|invalid|exact|path|budget|limit|depth|exclusive|query|etag|indexed|outside|must/i);
});

test('only one Pi tool is added and no source/content hooks are registered',async t=>{
 const {root}=fixture(t),tools=new Map(),events=[];
 registerCodeFeature({registerTool:x=>tools.set(x.name,x),on:x=>events.push(x)},
   {project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,languagesEnabled:false,treeEnabled:false}}),loadCompiler:()=>ts});
 const tool=tools.get('envelope_code_slice');
 assert.ok(tool);
 const response=await tool.execute('s',{path:'src/auth.ts',depth:1,maxChars:4000},null,null,{cwd:root});
 assert.equal(response.isError,false,response.content[0].text);
 assert.ok(JSON.parse(response.content[0].text).totalCandidates>=2);
 assert.deepEqual(events,[]);
});
