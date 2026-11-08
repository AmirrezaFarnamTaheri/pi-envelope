import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {ExternalGraphReader} from '../extensions/envelope/graphify-adapter.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
function fixture(t, graph){
  const root=mkdtempSync(join(tmpdir(),'envelope-dotnet-json-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'graphify-out'),{recursive:true});mkdirSync(join(root,'src'),{recursive:true});
  writeFileSync(join(root,'src','service.ts'),'export const service = true;\n');
  writeFileSync(join(root,'graphify-out','graph.json'),JSON.stringify(graph));
  const index=new CodeIndex(root,{ts,maxFiles:100});index.refresh();
  const reader=new ExternalGraphReader(root);t.after(()=>reader.close());
  return {root,index,reader};
}
test('actual Graphify.NET JSON exporter format preserves relationship, node and edge confidence and metadata',t=>{
 const graph={nodes:[
  {id:'user_service',label:'UserService.cs',type:'Entity',community:4,
    file_path:'src/service.ts',confidence:'EXTRACTED',metadata:{source_location:'L4'}},
  {id:'user_repository',label:'UserRepository',type:'Entity',confidence:'INFERRED'}],
  edges:[{source:'user_service',target:'user_repository',relationship:'calls',weight:1,
    confidence:'AMBIGUOUS',metadata:{source_file:'src/service.ts',source_location:'L12'}}],
  metadata:{nodeCount:2,edgeCount:1,communityCount:1}};
 const {root,index,reader}=fixture(t,graph);
 const manifest={version:1,graphSha256:hash(JSON.stringify(graph)),files:[{path:'src/service.ts',sha256:hash(readFileSync(join(root,'src/service.ts')))}]};
 writeFileSync(join(root,'graphify-out/envelope-sources.json'),JSON.stringify(manifest));
 const status=reader.query(index,{action:'status'});
 assert.equal(status.state,'declared-sources-match',JSON.stringify(status));
 assert.equal(status.attestation?.allGraphSourcesCovered,true);
 const nodes=reader.query(index,{action:'nodes'}).nodes;
 const service=nodes.find(n=>n.id==='user_service');
 assert.equal(service.path,'src/service.ts');
 assert.equal(service.sourceLocation,'L4');
 assert.equal(service.confidence,'EXTRACTED');
 const path=reader.query(index,{action:'path',source:'user_service',target:'user_repository'});
 assert.equal(path.edges[0].type,'calls');
 assert.equal(path.edges[0].confidence,'AMBIGUOUS');
 assert.equal(path.edges[0].sourceLocation,'L12');
 assert.equal(path.edges[0].sourcePath,'src/service.ts');
 assert.equal(path.edges[0].evidence,'external-graph-assertion');
});
test('Windows-absolute .NET source paths are redacted rather than dereferenced or echoed',t=>{
 const graph={nodes:[
  {id:'user_service',label:'Service',type:'Entity',file_path:'C:\\src\\otherproject\\secret.env',confidence:'EXTRACTED'},
  {id:'db',label:'Database',type:'Entity',file_path:'\\\\server\\share\\credentials.json'}],
  edges:[{source:'user_service',target:'db',relationship:'depends_on',confidence:'INFERRED',metadata:{source_file:'C:\\src\\otherproject\\secret.env'}}]};
 const {index,reader}=fixture(t,graph);
 const status=reader.query(index,{action:'status'});
 assert.equal(status.state,'unverified',JSON.stringify(status));
 assert.ok(status.externalSourcePathsRedacted>=2);
 const nodes=reader.query(index,{action:'nodes'}).nodes;
 assert.ok(nodes.every(n=>!Object.hasOwn(n,'path')));
 const edge=reader.query(index,{action:'neighbors',source:'user_service'}).neighbors[0];
 assert.equal(edge.type,'depends_on');
 assert.equal(edge.confidence,'INFERRED');
 assert.equal(Object.hasOwn(edge,'sourcePath'),false);
 assert.doesNotMatch(JSON.stringify({status,nodes,edge}),/secret\.env|credentials\.json|otherproject|server/);
});
test('malicious relative traversal is still rejected rather than sanitized into trusted source',t=>{
 const graph={nodes:[{id:'a',label:'A',source_file:'../../bad.env'}],edges:[]};
 const {reader,index}=fixture(t,graph);
 assert.equal(reader.query(index,{action:'status'}).state,'invalid');
});
test('Graphify.NET declared community labels support bounded, non-semantic read-only grouping',t=>{
 const graph={nodes:[
   {id:'a',label:'A',type:'Entity',community:4},
   {id:'b',label:'B',type:'Entity',community:4},
   {id:'c',label:'C',type:'Entity',community:7},
   {id:'unknown',label:'Unknown',type:'Entity'}],
   edges:[{source:'a',target:'b',relationship:'calls'}]};
 const {reader,index}=fixture(t,graph);
 const response=reader.query(index,{action:'communities',limit:5});
 assert.equal(response.total,2);
 assert.deepEqual(response.communities.map(c=>[c.id,c.size]),[[4,2],[7,1]]);
 assert.deepEqual(response.communities[0].sample,['a','b']);
 assert.equal(response.complete,false);
 assert.equal(response.evidence,'exporter-declared-community-not-inferred');
 assert.throws(()=>reader.query(index,{action:'communities',limit:27}),/limit/i);
});
