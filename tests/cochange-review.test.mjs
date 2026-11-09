import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {inspectCochangeCoupling} from '../extensions/envelope/cochange-review.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';

function shell(cwd,args){
 const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',timeout:4000});
 if(r.status!==0)throw new Error('git fixture operation failed '+JSON.stringify(args)+': '+r.stderr);
}
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-coupling-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'src'));
 shell(root,['init','-q']);
 const a=n=>"import {common} from './c';\nexport const a="+n+";\n";
 const b=n=>'export const b='+n+';\n';
 const c=n=>'export const common='+n+';\n';
 const put=(filename,text)=>writeFileSync(join(root,'src',filename),text);
 const commit=(label)=>{
  shell(root,['add','.']);shell(root,['-c','user.name=Test','-c','user.email=test@example.com','commit','-q','-m',label]);
 };
 put('a.ts',a(1));put('b.ts',b(1));put('c.ts',c(1));commit('initial');
 for(let n=2;n<=4;n++){put('a.ts',a(n));put('b.ts',b(n));commit('pair '+n);}
 put('a.ts',a(5));put('c.ts',c(2));commit('with direct dependency');
 const index=new CodeIndex(root,{ts,maxFiles:50,maxBytesPerFile:100_000});index.refresh();
 return {root,index,put,commit};
}

test('surfaces historical co-change without direct static imports and without causal risk claims',t=>{
 const {index}=fixture(t);
 const data=inspectCochangeCoupling(index,{path:'src/a.ts',minShared:3,maxCommits:20,limit:10});
 assert.equal(data.available,true);
 assert.equal(data.mode,'advisory-historical-cochange-with-static-import-context');
 assert.deepEqual(data.items.map(x=>x.path),['src/b.ts']);
 assert.equal(data.items[0].sharedCommits,4);
 assert.equal(data.items[0].directStaticImport,'not-detected');
 assert.equal(data.items[0].reviewHint,'cochange-without-direct-static-import');
 assert.equal(data.complete,true);
 assert.ok(!('riskScore' in data));
 assert.doesNotMatch(JSON.stringify(data),/export const a|import \{common\}|return |PRIVATE/i);
});

test('opt-in direct static imports remain separately distinguished from co-change coupling',t=>{
 const {index}=fixture(t);
 const data=inspectCochangeCoupling(index,{path:'src/a.ts',minShared:2,includeDirect:true,limit:10,maxCommits:20});
 assert.deepEqual(data.items.map(x=>x.path),['src/b.ts','src/c.ts']);
 assert.equal(data.items[1].directStaticImport,'detected');
 assert.equal(data.items[1].reviewHint,'cochange-with-direct-static-import');
 assert.equal(data.items[1].sharedCommits,2);
});

test('strict byte and page caps retain deterministic version-bound continuations',t=>{
 const {index}=fixture(t);
 const first=inspectCochangeCoupling(index,{path:'src/a.ts',minShared:2,includeDirect:true,limit:1,maxChars:1200,maxCommits:20});
 assert.equal(first.returned,1);
 assert.equal(first.truncated,true);
 assert.equal(first.nextOffset,1);
 assert.ok(Buffer.byteLength(JSON.stringify(first),'utf8')<=1200);
 const second=inspectCochangeCoupling(index,{path:'src/a.ts',minShared:2,includeDirect:true,limit:1,offset:1,ifVersion:first.version,maxChars:1200,maxCommits:20});
 assert.equal(second.returned,1);
 assert.notEqual(first.items[0].path,second.items[0].path);
 assert.throws(()=>inspectCochangeCoupling(index,{path:'src/a.ts',minShared:2,includeDirect:true,offset:1}),/version|cursor/i);
});

test('new Git history and code invalidate paginated co-change evidence even with previous result path',t=>{
 const f=fixture(t);
 const first=inspectCochangeCoupling(f.index,{path:'src/a.ts',includeDirect:true,limit:1,minShared:2,maxCommits:20});
 f.put('b.ts','export const b=900;');f.commit('b only');f.index.refresh();
 assert.throws(()=>inspectCochangeCoupling(f.index,{path:'src/a.ts',includeDirect:true,offset:1,ifVersion:first.version,minShared:2,maxCommits:20}),/stale|version/i);
});

test('refuses stale original source or symlinked source before suggesting a coupling',t=>{
 const f=fixture(t);
 f.put('a.ts','export const a=100000;');
 assert.throws(()=>inspectCochangeCoupling(f.index,{path:'src/a.ts'}),/source|stale|refresh|SHA/i);
 f.index.refresh();
 const outside=mkdtempSync(join(tmpdir(),'envelope-coupling-out-'));
 t.after(()=>rmSync(outside,{recursive:true,force:true}));
 writeFileSync(join(outside,'other.ts'),'export const privateData=42;');
 unlinkSync(join(f.root,'src/a.ts'));
 symlinkSync(join(outside,'other.ts'),join(f.root,'src/a.ts'));
 assert.throws(()=>inspectCochangeCoupling(f.index,{path:'src/a.ts'}),/unsafe|symlink|indexed|outside/i);
});

test('outside repository or invalid history data fail closed without fabricated signals',t=>{
 const f=fixture(t);
 assert.throws(()=>inspectCochangeCoupling(f.index,{path:'../../secret.ts'}),/outside|indexed|path/i);
 assert.throws(()=>inspectCochangeCoupling(f.index,{path:'src/a.ts',minShared:0}),/minShared/i);
 assert.throws(()=>inspectCochangeCoupling(f.index,{path:'src/a.ts',maxChars:2}),/maxChars/i);
 assert.throws(()=>inspectCochangeCoupling(f.index,{path:'src/a.ts',limit:40}),/limit/i);
 const other=mkdtempSync(join(tmpdir(),'envelope-coupling-nogit-'));
 t.after(()=>rmSync(other,{recursive:true,force:true}));
 writeFileSync(join(other,'a.ts'),'export const a=1');
 const idx=new CodeIndex(other,{ts});idx.refresh();
 const report=inspectCochangeCoupling(idx,{path:'a.ts'});
 assert.equal(report.available,false);
 assert.equal(report.complete,false);
 assert.ok(report.reason);
});

test('registers exactly one read-only Pi code-review tool without a second agent hook',async t=>{
 const f=fixture(t),tools=new Map(),events=[];
 registerCodeFeature({registerTool:tool=>tools.set(tool.name,tool),on:event=>events.push(event)},
  {project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,languagesEnabled:false,treeEnabled:false}}),loadCompiler:()=>ts});
 const tool=tools.get('envelope_code_coupling');assert.ok(tool);
 const result=await tool.execute('q',{path:'src/a.ts',minShared:3,maxCommits:20},null,null,{cwd:f.root});
 assert.equal(result.isError,false,result.content?.[0]?.text);
 assert.deepEqual(JSON.parse(result.content[0].text).items.map(x=>x.path),['src/b.ts']);
 assert.deepEqual(events,[]);
});

test('cochange checks indexable 500001..512000-byte sources without suppressing eligible candidates',t=>{
 const f=fixture(t);
 f.put('b.ts','export const b=7;'+(' '.repeat(509980)));
 f.commit('large indexed cochange source');
 f.index.maxBytesPerFile=512_000;f.index.refresh();
 assert.ok(f.index.files.has('src/b.ts'));
 const report=inspectCochangeCoupling(f.index,{path:'src/a.ts',minShared:2,maxCommits:30,limit:10});
 assert.ok(report.items.some(x=>x.path==='src/b.ts'),JSON.stringify(report));
});
