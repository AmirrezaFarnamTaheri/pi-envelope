import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-callgraph-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(file,source)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),source);};
 put('src/lib.ts','export function compute(n: number) { return n+1; }\nfunction internal() { return compute(1); }\n');
 put('src/app.ts',`import { compute as calc } from './lib';
export function request() { return calc(3); }
export function shadow(calc: () => number) { return calc(); }
export function local() { return helper(); }
function helper() { return 42; }
export function dynamic(client: any) { return client.compute(4); }
export class Service { method() { return calc(9); } }
`);
 put('src/other.ts','export function unused(){ return 0; }\n');
 assert.equal(spawnSync('git',['init','-q'],{cwd:root}).status,0);
 const index=new CodeIndex(root,{ts});return {root,put,index};
}

test('unambiguous direct and aliased imports link incoming and outgoing source positions',t=>{
 const {index}=fixture(t);index.refresh();
 const app=index.calls('src/app.ts');
 assert.equal(app.mode,'static-syntax-call-evidence');
 assert.ok(app.outgoing.some(x=>x.caller.name==='request'&&x.target.path==='src/lib.ts'&&x.target.name==='compute'&&x.name==='calc'));
 assert.ok(app.outgoing.some(x=>x.caller.name==='local'&&x.target.path==='src/app.ts'&&x.target.name==='helper'));
 assert.ok(app.outgoing.some(x=>x.caller.name==='Service.method'&&x.target.name==='compute'));
 assert.ok(app.outgoing.every(x=>x.line>=1&&x.column>=1));
 const lib=index.calls('src/lib.ts');
 assert.ok(lib.incoming.some(x=>x.path==='src/app.ts'&&x.caller.name==='request'));
 assert.ok(lib.incoming.some(x=>x.path==='src/app.ts'&&x.caller.name==='Service.method'));
 assert.ok(lib.outgoing.some(x=>x.name==='compute'&&x.caller.name==='internal'));
});

test('shadowed names, dynamic receivers, non-function exports and unknown targets remain unresolved',t=>{
 const {index,put}=fixture(t);
 put('src/extra.ts',`import { compute } from './lib';
export function local(compute: Function) { return compute(); }
export function method(c: any) { return c.compute() }
export function unknown() { return neverDeclared(); }
`);
 index.refresh();
 const app=index.calls('src/app.ts');
 assert.ok(app.unresolved.some(x=>x.caller.name==='shadow'&&x.name==='calc'&&x.reason==='shadowed'));
 assert.ok(app.unresolved.some(x=>x.caller.name==='dynamic'&&x.name==='compute'&&x.reason==='dynamic-member'));
 const extra=index.calls('src/extra.ts');
 assert.ok(extra.unresolved.some(x=>x.name==='compute'&&x.reason==='shadowed'));
 assert.ok(extra.unresolved.some(x=>x.name==='neverDeclared'&&x.reason==='unknown-target'));
 assert.ok(extra.outgoing.every(x=>x.caller.name!=='local'&&x.caller.name!=='method'));
});

test('cached call evidence invalidates on edits and deleted files without stale reverse edges',t=>{
 const {index,put,root}=fixture(t);const first=index.refresh();
 assert.ok(first.callSites>0);
 assert.equal(index.refresh().reparsed,0);
 assert.equal(index.refresh().reused,3);
 put('src/app.ts',"export function replaced() { return unavailable(); }\n");
 assert.equal(index.refresh().reparsed,1);
 assert.ok(index.calls('src/lib.ts').incoming.every(x=>x.path!=='src/app.ts'));
 assert.ok(index.calls('src/app.ts').unresolved.some(x=>x.name==='unavailable'));
 unlinkSync(join(root,'src','app.ts'));index.refresh();
 assert.throws(()=>index.calls('src/app.ts'),/not indexed|path|file/i);
 assert.equal(index.lookup('replaced').length,0);
});

test('bounded symbol lookup disambiguates callers and preserves calls on timestamp-only churn',t=>{
 const {root,index}=fixture(t);index.refresh();
 const request=index.calls('src/app.ts',{symbol:'request',limit:1});
 assert.equal(request.outgoing.length,1);
 assert.equal(request.outgoing[0].caller.name,'request');
 assert.equal(request.unresolved.length,0);
 const lib=index.calls('src/lib.ts',{symbol:'compute',limit:1});
 assert.equal(lib.incoming.length,1);assert.equal(lib.totalIncoming,3);
 assert.equal(lib.truncated,true);
 const file=join(root,'src','app.ts');const before=statSync(file);
 const now=new Date(before.mtimeMs+5000);utimesSync(file,now,now);
 assert.equal(index.refresh().reparsed,0);
 assert.equal(index.calls('src/app.ts').outgoing.length>=2,true);
 assert.throws(()=>index.calls('src/app.ts',{limit:0}),/limit/i);
});

test('caller reports reject traversal and unindexed sources',t=>{
 const {index}=fixture(t);index.refresh();
 assert.throws(()=>index.calls('../secrets.ts'),/outside|root/i);
 assert.throws(()=>index.calls('missing.ts'),/not indexed|ENOENT/i);
});

test('TypeScript overload signatures do not masquerade as extra runtime implementations',t=>{
 const {index,put}=fixture(t);
 put('src/overload.ts',`export function build(v: string): string;
export function build(v: number): number;
export function build(v: any) { return v; }
export function consume() { return build(2); }
`);
 index.refresh();
 const graph=index.calls('src/overload.ts',{symbol:'consume'});
 assert.equal(graph.outgoing.length,1);
 assert.equal(graph.outgoing[0].target.name,'build');
 assert.equal(graph.outgoing[0].target.line,3);
});

test('syntax-invalid source never yields an apparently complete call graph',t=>{
 const {index,put}=fixture(t);
 put('src/broken.ts','export function broken( { return compute(1)\n');
 index.refresh();
 const report=index.calls('src/broken.ts');
 assert.equal(report.complete,false);
 assert.ok(report.incompleteReasons.includes('syntax-errors'));
 assert.equal(report.totalOutgoing,0);
});

test('explicit namespace imports link only when receiver is not locally shadowed',t=>{
 const {index,put}=fixture(t);
 put('src/namespace.ts',`import * as api from './lib';
export function linked() { return api.compute(2); }
export function shadowed(api: any) { return api.compute(3); }
`);
 index.refresh();const graph=index.calls('src/namespace.ts');
 assert.ok(graph.outgoing.some(x=>x.name==='compute'&&x.target.path==='src/lib.ts'));
 assert.ok(graph.unresolved.some(x=>x.name==='compute'&&x.caller.name==='shadowed'&&x.reason==='shadowed'));
});

test('large files cap call evidence and never report complete coverage after omission',t=>{
 const {index,put}=fixture(t);
 put('src/many.ts',`export function hit() {return 1;}\nexport function start(){\n${'hit();\n'.repeat(250)}}\n`);
 index.refresh();const data=index.calls('src/many.ts',{limit:5});
 assert.equal(data.complete,false);
 assert.ok(data.incompleteReasons.includes('call-fact-limit'));
 assert.equal(data.omittedCallSites,50);
 assert.equal(data.totalOutgoing,200);
 assert.equal(data.outgoing.length,5);
 assert.equal(data.truncated,true);
});
