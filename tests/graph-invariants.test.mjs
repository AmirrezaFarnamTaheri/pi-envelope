import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {verifyGraphInvariant,checkGraphCertificate} from '../extensions/envelope/graph-invariants.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';
function setup(t,withCycle=false){
 const root=mkdtempSync(join(tmpdir(),'graph-invariant-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,text)=>writeFileSync(join(root,p),text);
 put('a.ts',"import {b} from './b';\nexport const a=b;\n");
 put('b.ts',withCycle?"import {a} from './a';\nexport const b=a;\n":'export const b=1;\n');
 put('c.ts','export const c=2;\n');
 const index=new CodeIndex(root,{ts,maxFiles:20,maxBytesPerFile:100000});index.refresh();
 return {root,index,put};
}
test('DAG produces deterministic checkable topological witness, not program-correctness claim',t=>{
 const f=setup(t),r=verifyGraphInvariant(f.index,{action:'acyclic',maxNodes:20,maxChars:3000});
 assert.equal(r.verdict,'holds');assert.equal(r.complete,true);
 assert.equal(r.property,'acyclic-static-file-imports');
 assert.ok(r.certificate.order.indexOf('b.ts')<r.certificate.order.indexOf('a.ts'));
 assert.equal(checkGraphCertificate(f.index,r),true);
 assert.match(r.notes,/not.*(runtime|program|semantic)/i);
});
test('cycle produces an exact edge-by-edge counterexample and passes independent witness check',t=>{
 const f=setup(t,true),r=verifyGraphInvariant(f.index,{action:'acyclic'});
 assert.equal(r.verdict,'violated');assert.deepEqual(r.certificate.cycle,['a.ts','b.ts','a.ts']);
 assert.equal(checkGraphCertificate(f.index,r),true);
});
test('reachable and no-path properties have bounded exact static path witnesses',t=>{
 const f=setup(t),reach=verifyGraphInvariant(f.index,{action:'reach',source:'a.ts',target:'b.ts'});
 assert.equal(reach.verdict,'holds');assert.deepEqual(reach.certificate.path,['a.ts','b.ts']);
 assert.equal(checkGraphCertificate(f.index,reach),true);
 const absent=verifyGraphInvariant(f.index,{action:'no-path',source:'c.ts',target:'a.ts'});
 assert.equal(absent.verdict,'holds');assert.ok(absent.certificate.explored.includes('c.ts'));
 assert.equal(checkGraphCertificate(f.index,absent),true);
});
test('truncated graph or parser-unavailable never yields a positive completeness proof',t=>{
 const f=setup(t),small=verifyGraphInvariant(f.index,{action:'acyclic',maxNodes:2});
 assert.equal(small.verdict,'unknown');assert.equal(small.complete,false);
 f.index.lastRefresh.unavailable.push('python');
 const unclear=verifyGraphInvariant(f.index,{action:'acyclic'});
 assert.equal(unclear.verdict,'unknown');assert.equal(unclear.complete,false);
});
test('source edited after index refresh and unexpected paths block false proofs',t=>{
 const f=setup(t);f.put('b.ts','export const b=999;');
 assert.throws(()=>verifyGraphInvariant(f.index,{action:'acyclic'}),/changed|refresh|source/i);
 assert.throws(()=>verifyGraphInvariant(f.index,{action:'reach',source:'../../secret',target:'a.ts'}),/path|outside|index/i);
});
test('forged graph certificate is rejected by the independent checker',t=>{
 const f=setup(t,true),r=verifyGraphInvariant(f.index,{action:'acyclic'});
 r.certificate.cycle=['a.ts','c.ts','a.ts'];
 assert.equal(checkGraphCertificate(f.index,r),false);
});
test('bad budgets, unsafe rules and too-small serialized outputs reject',t=>{
 const f=setup(t);
 assert.throws(()=>verifyGraphInvariant(f.index,{action:'acyclic',maxChars:30}),/maxChars/i);
 assert.throws(()=>verifyGraphInvariant(f.index,{action:'acyclic',maxNodes:0}),/maxNodes/i);
 assert.throws(()=>verifyGraphInvariant(f.index,{action:'no-path',source:'a.ts'}),/target|path/i);
 assert.throws(()=>verifyGraphInvariant(f.index,{action:'bogus'}),/action/i);
});
test('Pi exposes one read-only invariant tool and no new hooks',async t=>{
 const f=setup(t),home=mkdtempSync(join(tmpdir(),'invariant-home-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const tools=new Map(),hooks=new Map();
 registerEnvelope({cwd:f.root,on:(name,fn)=>hooks.set(name,[...(hooks.get(name)||[]),fn]),
  registerTool:x=>tools.set(x.name,x),registerCommand(){},logger:{warn(){}}},
  {home,loadCompiler:()=>ts});
 const tool=tools.get('envelope_code_invariant');assert.ok(tool);
 assert.deepEqual(tool.parameters.properties.action.enum,['acyclic','reach','no-path']);
 const result=await tool.execute('one',{action:'acyclic'},null,null,{cwd:f.root});
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(JSON.parse(result.content[0].text).verdict,'holds');
 assert.equal(hooks.get('before_agent_start').length,1);
});
