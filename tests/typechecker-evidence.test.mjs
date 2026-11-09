import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {inspectTypedSource} from '../extensions/envelope/typechecker-evidence.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-ts-checker-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'src'));
 const write=(p,body)=>writeFileSync(join(root,'src',p),body);
 write('api.ts','export function twice(n: number): number { return n * 2; }\n');
 write('entry.ts',"import { twice } from './api';\nexport const answer = twice(21);\n");
 const index=new CodeIndex(root,{ts,maxFiles:60,maxBytesPerFile:100000});index.refresh();
 return {root,index,write};
}
test('TypeScript compiler resolves imported function type and exact declaration without source body',t=>{
 const f=fixture(t),r=inspectTypedSource(f.index,{action:'symbol',path:'src/entry.ts',line:2,column:24});
 assert.equal(r.mode,'typescript-compiler-evidence');
 assert.equal(r.provider,'TypeScript 5.8.3');
 assert.equal(r.status,'resolved');assert.equal(r.symbol,'twice');
 assert.match(r.type,/\(n: number\).*number/);
 assert.deepEqual(r.declarations.map(x=>x.path),['src/api.ts']);
 assert.match(r.version,/^[0-9a-f]{64}$/);
 assert.doesNotMatch(JSON.stringify(r),/return n \* 2|twice\(21\)/);
});
test('real TypeScript diagnostics report incompatible call argument under strict mode',t=>{
 const f=fixture(t);
 f.write('entry.ts',"import { twice } from './api';\nexport const answer = twice('oops');\n");f.index.refresh();
 const r=inspectTypedSource(f.index,{action:'diagnostics',path:'src/entry.ts',limit:6,maxChars:4000});
 assert.equal(r.status,'diagnostics');assert.ok(r.errors>=1);
 assert.ok(r.diagnostics.some(d=>d.code===2345));
 assert.ok(Buffer.byteLength(JSON.stringify(r),'utf8')<=4000);
});
test('missing compiler imports are called incomplete, not a clean verified program',t=>{
 const f=fixture(t);
 f.write('entry.ts',"import { ghost } from './not-indexed';\nexport const answer = ghost(1);\n");f.index.refresh();
 const r=inspectTypedSource(f.index,{action:'diagnostics',path:'src/entry.ts'});
 assert.equal(r.complete,false);assert.ok(r.reasons.includes('unresolved-compiler-module'));
 assert.ok(r.errors>=1);
});
test('outdated CodeIndex source hashes prevent stale compiler evidence',t=>{
 const f=fixture(t);f.write('api.ts','export const secret=12345;');
 assert.throws(()=>inspectTypedSource(f.index,{action:'diagnostics',path:'src/entry.ts'}),/stale|changed|refresh/i);
});
test('symlinks, non-indexed parser languages and traversal never yield typed evidence',t=>{
 const f=fixture(t);
 assert.throws(()=>inspectTypedSource(f.index,{action:'symbol',path:'../../secret.ts',line:1,column:1}),/path|outside|index/i);
 f.write('example.py','def foo(): pass');f.index.refresh();
 assert.throws(()=>inspectTypedSource(f.index,{action:'diagnostics',path:'src/example.py'}),/typescript|javascript|unsupported|ignored|indexed/i);
 const outside=mkdtempSync(join(tmpdir(),'external-ts-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
 writeFileSync(join(outside,'evil.ts'),'export const evil=1;');unlinkSync(join(f.root,'src','api.ts'));
 symlinkSync(join(outside,'evil.ts'),join(f.root,'src','api.ts'));
 assert.throws(()=>inspectTypedSource(f.index,{action:'diagnostics',path:'src/entry.ts'}),/unsafe|symlink|changed|stale/i);
});
test('invalid cursor, limits and impossible result budgets fail closed',t=>{
 const f=fixture(t);
 assert.throws(()=>inspectTypedSource(f.index,{action:'symbol',path:'src/entry.ts',line:0,column:2}),/line|position/i);
 assert.throws(()=>inspectTypedSource(f.index,{action:'symbol',path:'src/entry.ts',line:2,column:9999}),/column|position|bounds/i);
 assert.throws(()=>inspectTypedSource(f.index,{action:'diagnostics',path:'src/entry.ts',limit:0}),/limit/i);
 assert.throws(()=>inspectTypedSource(f.index,{action:'diagnostics',path:'src/entry.ts',maxChars:12}),/maxChars/i);
});
test('one native tool reuses shared CodeIndex without new lifecycle hooks',async t=>{
 const f=fixture(t),tools=new Map(),events=[];
 registerCodeFeature({registerTool:x=>tools.set(x.name,x),on:x=>events.push(x)},
   {project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,languagesEnabled:false,treeEnabled:false}}),loadCompiler:()=>ts});
 const tool=tools.get('envelope_code_typecheck');assert.ok(tool);
 assert.deepEqual(tool.parameters.properties.action.enum,['diagnostics','symbol']);
 const out=await tool.execute('one',{action:'diagnostics',path:'src/entry.ts'},undefined,undefined,{cwd:f.root});
 assert.equal(out.isError,false,out.content[0].text);
 assert.equal(JSON.parse(out.content[0].text).provider,'TypeScript 5.8.3');
 assert.equal(events.length,0);
});
