import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {inspectGoTypes} from '../extensions/envelope/go-typechecker-evidence.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';

const hasGo=spawnSync('go',['version'],{timeout:4000,stdio:'ignore'}).status===0;
const goTest=(name,fn)=>test(name,{skip:!hasGo&&'Go binary unavailable on PATH'},fn);
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-go-types-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'pkg'));writeFileSync(join(root,'go.mod'),'module example.com/offline\n\ngo 1.23\n');
 const write=(p,text)=>writeFileSync(join(root,'pkg',p),text);
 write('math.go','package pkg\nfunc Add(n int) int { return n+2 }\n');
 write('api.go','package pkg\nfunc Use() int { return Add(3) }\n');
 const index=new CodeIndex(root,{ts,languagesEnabled:true,maxFiles:40,maxBytesPerFile:100_000});index.refresh();
 return {root,index,write};
}
goTest('real go/types resolves a same-package symbol definition and function signature',t=>{
 const f=fixture(t);const r=inspectGoTypes(f.index,{action:'symbol',path:'pkg/api.go',line:2,column:25});
 assert.equal(r.mode,'go-compiler-evidence');assert.equal(r.status,'resolved');
 assert.equal(r.symbol,'Add');assert.match(r.type,/func\(n int\) int/);
 assert.deepEqual(r.declarations.map(d=>d.path),['pkg/math.go']);
 assert.equal(r.complete,true);assert.doesNotMatch(JSON.stringify(r),/return n\+2|return Add\(3\)/);
});
goTest('real go/types catches mismatched argument types with redacted source literals',t=>{
 const f=fixture(t);f.write('api.go','package pkg\nfunc Use() int { return Add("PRIVATE_SECRET") }\n');f.index.refresh();
 const r=inspectGoTypes(f.index,{action:'diagnostics',path:'pkg/api.go'});
 assert.ok(r.errors>=1);assert.equal(r.complete,false);
 assert.ok(r.diagnostics.some(d=>d.code==='GO_TYPE'));
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_SECRET|return Add/);
});
goTest('unsupported external module references remain unresolved instead of proof',t=>{
 const f=fixture(t);f.write('api.go','package pkg\nimport "does.not.exist/thing"\nfunc Use() int { return thing.Do() }\n');f.index.refresh();
 const r=inspectGoTypes(f.index,{action:'diagnostics',path:'pkg/api.go'});
 assert.equal(r.complete,false);assert.ok(r.errors>=1);
 assert.ok(r.reasons.some(x=>/import|unresolved|type/i.test(x)));
});
goTest('a modified source without index refresh is rejected',t=>{
 const f=fixture(t);f.write('math.go','package pkg\nfunc Add(n int) int { return n+88 }');
 assert.throws(()=>inspectGoTypes(f.index,{action:'diagnostics',path:'pkg/api.go'}),/changed|hash|refresh/i);
});
goTest('unsafe symlinks and outside-root requests do not acquire compiler evidence',t=>{
 const f=fixture(t);assert.throws(()=>inspectGoTypes(f.index,{path:'../../not-go.go'}),/outside|path|indexed/i);
 const external=mkdtempSync(join(tmpdir(),'go-types-outside-'));t.after(()=>rmSync(external,{recursive:true,force:true}));
 writeFileSync(join(external,'secret.go'),'package pkg\nfunc Stolen() int { return 1 }\n');
 unlinkSync(join(f.root,'pkg','math.go'));symlinkSync(join(external,'secret.go'),join(f.root,'pkg','math.go'));
 assert.throws(()=>inspectGoTypes(f.index,{path:'pkg/api.go'}),/symlink|unsafe|source/i);
});
goTest('invalid cursor, budget and unsupported language are rejected',t=>{
 const f=fixture(t);
 assert.throws(()=>inspectGoTypes(f.index,{action:'symbol',path:'pkg/api.go',line:0,column:1}),/line/i);
 assert.throws(()=>inspectGoTypes(f.index,{action:'symbol',path:'pkg/api.go',line:2,column:99999}),/column|bounds/i);
 assert.throws(()=>inspectGoTypes(f.index,{action:'diagnostics',path:'pkg/api.go',maxChars:50}),/maxChars/i);
 assert.throws(()=>inspectGoTypes(f.index,{action:'diagnostics',path:'pkg/api.go',limit:0}),/limit/i);
 assert.throws(()=>inspectGoTypes(f.index,{action:'invalid',path:'pkg/api.go'}),/action/i);
});
goTest('Pi go/types query reuses one CodeIndex and no extra lifecycle hooks',async t=>{
 const f=fixture(t),tools=new Map(),events=[];
 registerCodeFeature({registerTool:tool=>tools.set(tool.name,tool),on:event=>events.push(event)},
   {project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,languagesEnabled:true,treeEnabled:false}}),loadCompiler:()=>ts});
 const tool=tools.get('envelope_code_go_types');assert.ok(tool);
 const out=await tool.execute('id',{action:'symbol',path:'pkg/api.go',line:2,column:25},undefined,undefined,{cwd:f.root});
 assert.equal(out.isError,false,out.content?.[0]?.text);
 assert.equal(JSON.parse(out.content[0].text).symbol,'Add');
 assert.equal(events.length,0);
});

goTest('offline go/types resolves available fmt standard-library export data',t=>{
 const f=fixture(t);
 f.write('api.go','package pkg\nimport "fmt"\nfunc Use() string { return fmt.Sprintf("%d",Add(3)) }\n');
 f.index.refresh();
 const result=inspectGoTypes(f.index,{action:'diagnostics',path:'pkg/api.go'});
 if(result.reasons.includes('unresolved-package-import')){t.skip('Go stdlib export data unavailable on this toolchain');return;}
 assert.equal(result.errors,0,JSON.stringify(result));
 assert.equal(result.complete,true);
});
