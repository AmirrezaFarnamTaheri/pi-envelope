import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {inspectCodeGraph} from '../extensions/envelope/graph-intelligence.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';

function fixture(t,files){
  const root=mkdtempSync(join(tmpdir(),'envelope-graph-evidence-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const [path,source] of Object.entries(files)){
    mkdirSync(dirname(join(root,path)),{recursive:true});
    writeFileSync(join(root,path),source);
  }
  assert.equal(spawnSync('git',['init','-q'],{cwd:root,timeout:5000}).status,0);
  const index=new CodeIndex(root,{ts,maxFiles:100,maxBytesPerFile:50_000});
  index.refresh();
  return {root,index};
}
const chain={
 'src/alpha.ts':'import { beta } from "./beta";\nexport function alpha(){ return beta(); }\n',
 'src/beta.ts':'import { gamma } from "./gamma";\nexport function beta(){ return gamma(); }\n',
 'src/gamma.ts':'export function gamma(){ return 42; }\n',
 'src/unused.ts':'export const unrelated = 123;\n',
};

test('shortest path over typed static imports is deterministic, directional and source-grounded',t=>{
 const {index}=fixture(t,chain);
 const p=inspectCodeGraph(index,{action:'path',source:'src/alpha.ts',target:'src/gamma.ts',relation:'imports'});
 assert.equal(p.found,true);
 assert.deepEqual(p.nodes,['src/alpha.ts','src/beta.ts','src/gamma.ts']);
 assert.deepEqual(p.edges.map(e=>e.type),['imports','imports']);
 assert.ok(p.edges.every(e=>e.evidence==='parsed-static-import'));
 assert.equal(p.complete,true);
 const reverse=inspectCodeGraph(index,{action:'path',source:'src/gamma.ts',target:'src/alpha.ts',direction:'incoming',relation:'imports'});
 assert.deepEqual(reverse.nodes,['src/gamma.ts','src/beta.ts','src/alpha.ts']);
 const none=inspectCodeGraph(index,{action:'path',source:'src/gamma.ts',target:'src/alpha.ts',relation:'imports'});
 assert.equal(none.found,false);
 assert.equal(none.complete,true);
});

test('path exploration reports depth limits as incomplete, not proof of no relationship',t=>{
 const {index}=fixture(t,chain);
 const p=inspectCodeGraph(index,{action:'path',source:'src/alpha.ts',target:'src/gamma.ts',relation:'imports',maxDepth:1});
 assert.equal(p.found,false);
 assert.equal(p.complete,false);
 assert.ok(p.reasons.includes('depth-limit'));
});

test('call-only graph links uniquely resolved syntax and refuses uncertain dynamic receivers',t=>{
 const {index}=fixture(t,{
 'src/a.ts':'import { run } from "./b";\nexport function caller(){run(); unknown.run();}\n',
 'src/b.ts':'export function run(){return 1;}\n'
 });
 const route=inspectCodeGraph(index,{action:'path',source:'src/a.ts',target:'src/b.ts',relation:'calls'});
 assert.equal(route.found,true,JSON.stringify(route));
 assert.equal(route.edges[0].type,'calls');
 assert.equal(route.edges[0].evidence,'resolved-syntactic-call');
 assert.equal(route.edges[0].sites,1);
 const status=inspectCodeGraph(index,{action:'status',relation:'calls'});
 assert.ok(status.callEvidence.unresolvedCalls>=1);
 assert.ok(status.edgeTypes.calls>=1);
});

test('file-neighbors report exact direction and cap output independently of full degree',t=>{
 const {index}=fixture(t,{
 'src/hub.ts':'export const hub = 1;\n',
 'src/a.ts':'import {hub} from "./hub"; export const a=hub;\n',
 'src/b.ts':'import {hub} from "./hub"; export const b=hub;\n',
 'src/c.ts':'import {hub} from "./hub"; export const c=hub;\n'
 });
 const result=inspectCodeGraph(index,{action:'neighbors',source:'src/hub.ts',direction:'incoming',relation:'imports',limit:2});
 assert.equal(result.total,3);
 assert.equal(result.neighbors.length,2);
 assert.equal(result.truncated,true);
 assert.deepEqual(result.neighbors.map(n=>n.path),['src/a.ts','src/b.ts']);
 const hubs=inspectCodeGraph(index,{action:'hubs',relation:'imports'});
 assert.equal(hubs.hubs[0].path,'src/hub.ts');
 assert.equal(hubs.hubs[0].incomingFiles,3);
});

test('components are honest weakly connected sets, not inferred semantic communities',t=>{
 const {index}=fixture(t,chain);
 const result=inspectCodeGraph(index,{action:'components',relation:'imports'});
 assert.equal(result.method,'weakly-connected-components');
 assert.equal(result.total,2);
 assert.deepEqual(result.components.map(x=>x.size),[3,1]);
 assert.deepEqual(result.components[0].sample,['src/alpha.ts','src/beta.ts','src/gamma.ts']);
});

test('architecture boundary audits produce only observed import violations with evidence',t=>{
 const {index}=fixture(t,{
 'src/domain/model.ts':'export const model=3;\n',
 'src/domain/use.ts':'import {db} from "../infra/db"; export const use=db;\n',
 'src/infra/db.ts':'export const db=1;\n'
 });
 const before=readFileSync(join(index.root,'src/domain/use.ts'),'utf8');
 const result=inspectCodeGraph(index,{action:'boundaries',relation:'imports',rules:[{from:'src/domain/',forbid:['src/infra/']}]});
 assert.equal(result.total,1);
 assert.deepEqual(result.violations[0],{source:'src/domain/use.ts',target:'src/infra/db.ts',type:'imports',rule:0,evidence:'parsed-static-import'});
 assert.equal(readFileSync(join(index.root,'src/domain/use.ts'),'utf8'),before);
 assert.throws(()=>inspectCodeGraph(index,{action:'boundaries',rules:[{from:'../secret',forbid:['src/infra/']}]}),/prefix|invalid/i);
 assert.throws(()=>inspectCodeGraph(index,{action:'boundaries',rules:[]}),/rules/i);
 assert.throws(()=>inspectCodeGraph(index,{action:'boundaries',rules:[{from:'src//domain/',forbid:['src/infra/']}]}),/prefix/i);
 assert.throws(()=>inspectCodeGraph(index,{action:'boundaries',rules:[{from:'src/domain/',forbid:['src/../infra/']}]}),/prefix/i);
});

test('graph export is bounded JSON and Mermaid with escaping and no disk writes',t=>{
 const {index}=fixture(t,chain);
 const json=inspectCodeGraph(index,{action:'export',relation:'imports',format:'json',limit:2});
 assert.equal(json.format,'json');
 assert.equal(json.nodes.length,2);
 assert.equal(json.truncated,true);
 assert.ok(json.edges.every(e=>json.nodes.some(n=>n.path===e.source)&&json.nodes.some(n=>n.path===e.target)));
 const mermaid=inspectCodeGraph(index,{action:'export',relation:'imports',format:'mermaid',limit:10});
 assert.match(mermaid.content,/^flowchart LR/);
 assert.match(mermaid.content,/src\/alpha\.ts/);
 assert.ok(mermaid.content.length<10_000);
});

test('graph scopes inputs to indexed files, never follows symlinks and never executes source',t=>{
 const {index,root}=fixture(t,{
 'src/a.ts':'throw Error("should never execute"); export const a=1;\n',
 'src/b.ts':'import {a} from "./a"; export const b=a;\n'
 });
 const out=join(root,'outside.md');writeFileSync(out,'secret');
 symlinkSync(out,join(root,'src','shortcut.ts'));
 index.refresh();
 assert.throws(()=>inspectCodeGraph(index,{action:'neighbors',source:'src/shortcut.ts'}),/symlink|not indexed/i);
 assert.throws(()=>inspectCodeGraph(index,{action:'path',source:'../outside.md',target:'src/a.ts'}),/outside/i);
 const result=inspectCodeGraph(index,{action:'status'});
 assert.equal(result.files,2);
 assert.equal(result.externalExecution,false);
});

test('Pi registers a single graph query tool with no new hooks and bounded output',async t=>{
 const {root}=fixture(t,chain);
 const registered=new Map(),events=[];
 const pi={cwd:root,registerTool(tool){registered.set(tool.name,tool);},on(e){events.push(e);}};
 const feature=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,languagesEnabled:false,treeEnabled:false}}),loadCompiler:async()=>ts});
 assert.equal(registered.has('envelope_code_graph'),true);
 assert.equal(events.length,0);
 const call=registered.get('envelope_code_graph').execute;
 const result=await call('call',{action:'path',source:'src/alpha.ts',target:'src/gamma.ts',relation:'imports'},null,null,{cwd:root});
 assert.equal(result.isError,false,result.content?.[0]?.text);
 assert.deepEqual(JSON.parse(result.content[0].text).nodes,['src/alpha.ts','src/beta.ts','src/gamma.ts']);
 assert.equal(feature.loaded(),1);
});
