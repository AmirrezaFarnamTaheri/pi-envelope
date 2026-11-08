import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {ExternalGraphReader} from '../extensions/envelope/graphify-adapter.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t,{withManifest=true}={}) {
  const root=mkdtempSync(join(tmpdir(),'envelope-external-graph-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'graphify-out'),{recursive:true});
  mkdirSync(join(root,'src'),{recursive:true});
  const source='export function auth() { return 42; }\n';
  writeFileSync(join(root,'src/auth.ts'),source);
  writeFileSync(join(root,'src/db.ts'),'export const db = 1;\n');
  const graph={nodes:[{id:'Auth',name:'Auth service',type:'component',file:'src/auth.ts'},
                      {id:'DB',name:'DB service',type:'component',file:'src/db.ts'},
                      {id:'Logs',name:'Logs',type:'concept'}],
               edges:[{source:'Auth',target:'DB',type:'depends_on'},
                      {source:'DB',target:'Logs',type:'observes'}]};
  const graphText=JSON.stringify(graph);
  writeFileSync(join(root,'graphify-out/graph.json'),graphText);
  const manifest={version:1,graphSha256:digest(graphText),files:[{path:'src/auth.ts',sha256:digest(source)}]};
  if(withManifest)writeFileSync(join(root,'graphify-out/envelope-sources.json'),JSON.stringify(manifest));
  const index=new CodeIndex(root,{ts,maxFiles:100});index.refresh();
  return {root,index,graph,graphText,manifest,source};
}

test('read-only Graphify node-link adapter preserves external assertion labels',t=>{
  const {root,index}=fixture(t);
  const api=new ExternalGraphReader(root);
  t.after(()=>api.close());
  const status=api.query(index,{action:'status'});
  assert.equal(status.state,'declared-sources-match');
  assert.equal(status.nodes,3);
  assert.equal(status.edges,2);
  assert.equal(status.verifiedFiles,1);
  assert.equal(status.trust,'external-assertion-not-native-AST');
  assert.match(status.graphSha256,/^[0-9a-f]{64}$/);
  const listed=api.query(index,{action:'nodes',query:'service',limit:1});
  assert.deepEqual(listed.nodes.map(n=>n.id),['Auth']);
  assert.equal(listed.truncated,true);
  const nearby=api.query(index,{action:'neighbors',source:'Auth'});
  assert.deepEqual(nearby.neighbors.map(n=>n.id),['DB']);
  assert.equal(nearby.neighbors[0].evidence,'external-graph-assertion');
  const path=api.query(index,{action:'path',source:'Auth',target:'Logs'});
  assert.deepEqual(path.nodes,['Auth','DB','Logs']);
  assert.deepEqual(path.edges.map(e=>e.type),['depends_on','observes']);
  const reversed=api.query(index,{action:'path',source:'Logs',target:'Auth'});
  assert.equal(reversed.found,false);
  assert.equal(reversed.complete,false,'external edges cannot prove no relationship');
});

test('freshness is unknown without a source-hash manifest, never advertised as verified',t=>{
  const {root,index}=fixture(t,{withManifest:false});
  const api=new ExternalGraphReader(root);
  const s=api.query(index,{action:'status'});
  assert.equal(s.state,'unverified');
  assert.equal(s.verifiedFiles,0);
  assert.deepEqual(api.query(index,{action:'nodes'}).nodes.map(x=>x.id),['Auth','DB','Logs']);
  api.close();
});

test('editing a declared source makes the graph stale and blocks traversal without explicit acknowledgement',t=>{
  const {root,index}=fixture(t);
  const api=new ExternalGraphReader(root);
  writeFileSync(join(root,'src/auth.ts'),'export function auth() { return -1; }\n');
  const s=api.query(index,{action:'status'});
  assert.equal(s.state,'stale');
  assert.ok(s.reasons.includes('source-hash-mismatch'));
  assert.throws(()=>api.query(index,{action:'path',source:'Auth',target:'Logs'}),/stale/);
  const acknowledged=api.query(index,{action:'path',source:'Auth',target:'Logs',allowStale:true});
  assert.equal(acknowledged.found,true);
  assert.equal(acknowledged.complete,false);
  assert.ok(acknowledged.reasons.includes('stale'));
  api.close();
});

test('updating graph bytes without re-attesting the manifest flags stale',t=>{
  const {root,index,graph}=fixture(t);
  const api=new ExternalGraphReader(root);
  writeFileSync(join(root,'graphify-out/graph.json'),JSON.stringify({...graph,edges:[]}));
  const s=api.query(index,{action:'status'});
  assert.equal(s.state,'stale');
  assert.ok(s.reasons.includes('artifact-hash-mismatch'));
  api.close();
});

test('Graphify needs_update marker always marks artifact stale',t=>{
  const {root,index}=fixture(t);
  writeFileSync(join(root,'graphify-out/needs_update'),'');
  const api=new ExternalGraphReader(root);
  assert.equal(api.query(index,{action:'status'}).state,'stale');
  assert.ok(api.query(index,{action:'status'}).reasons.includes('graphify-needs-update'));
  api.close();
});

test('missing graphs are reported without creating files or directories',t=>{
  const {root,index}=fixture(t);
  rmSync(join(root,'graphify-out'),{recursive:true});
  const api=new ExternalGraphReader(root);
  const s=api.query(index,{action:'status'});
  assert.equal(s.state,'missing');
  assert.equal(s.nodes,0);
  assert.throws(()=>api.query(index,{action:'nodes'}),/missing/);
  api.close();
});

test('rejects symlinks and traversal in graph or manifest source evidence',t=>{
  const {root,index,manifest}=fixture(t);
  const api=new ExternalGraphReader(root);
  const outside=join(root,'private');writeFileSync(outside,'{"nodes":[],"edges":[],"secret":"private"}');
  rmSync(join(root,'graphify-out/graph.json'));
  symlinkSync(outside,join(root,'graphify-out/graph.json'));
  const g=api.query(index,{action:'status'});
  assert.equal(g.state,'invalid');
  assert.doesNotMatch(JSON.stringify(g),/private/);
  rmSync(join(root,'graphify-out/graph.json'));
  writeFileSync(join(root,'graphify-out/graph.json'),JSON.stringify({nodes:[],edges:[]}));
  const poisoned={...manifest,graphSha256:digest('{"nodes":[],"edges":[]}'),files:[{path:'../private',sha256:digest('private')}]};
  writeFileSync(join(root,'graphify-out/envelope-sources.json'),JSON.stringify(poisoned));
  assert.equal(api.query(index,{action:'status'}).state,'invalid');
  api.close();
});

test('malformed graph IDs, duplicate nodes, dangling edges and oversized files fail closed',t=>{
  const {root,index}=fixture(t);
  const api=new ExternalGraphReader(root);
  const path=join(root,'graphify-out/graph.json');
  const bad=[{nodes:[{id:'a'},{id:'a'}],edges:[]},
    {nodes:[{id:'a'}],edges:[{source:'a',target:'absent'}]},
    {nodes:[{id:'a'.repeat(300)}],edges:[]},
    {nodes:[{id:'a'}],edges:[{source:'a',target:'a',type:'x'.repeat(1000)}]}];
  for(const graph of bad){writeFileSync(path,JSON.stringify(graph));assert.equal(api.query(index,{action:'status'}).state,'invalid');}
  writeFileSync(path,'x'.repeat(2_100_000));
  assert.equal(api.query(index,{action:'status'}).state,'invalid');
  api.close();
});

test('bounded query budgets and incomplete answers never imply semantic completeness',t=>{
  const {root,index}=fixture(t);
  const api=new ExternalGraphReader(root);
  assert.throws(()=>api.query(index,{action:'nodes',limit:101}),/limit/);
  assert.throws(()=>api.query(index,{action:'path',source:'Auth',target:'Logs',maxDepth:0}),/maxDepth/);
  const limit=api.query(index,{action:'path',source:'Auth',target:'Logs',maxDepth:1});
  assert.equal(limit.found,false);
  assert.equal(limit.complete,false);
  assert.ok(limit.reasons.includes('depth-limit'));
  api.close();
});

test('explicit opt-in watcher only invalidates state; events debounce and close',t=>{
  const {root,index}=fixture(t);
  const watches=[];
  const api=new ExternalGraphReader(root,{watchFactory:(dir,opts,handler)=>{
    const w={dir,handler,closed:false,close(){this.closed=true;}};watches.push(w);return w;
  }});
  const on=api.query(index,{action:'watch',enabled:true,debounceMs:100});
  assert.equal(on.watch.active,true);
  assert.ok(watches.length>=1);
  watches[0].handler('change','graph.json');
  watches[0].handler('change','graph.json');
  assert.equal(api.query(index,{action:'status'}).watch.changedSinceStart,true);
  assert.equal(api.query(index,{action:'status'}).state,'declared-sources-match','watch must not silently run Graphify or rewrite a graph');
  const off=api.query(index,{action:'watch',enabled:false});
  assert.equal(off.watch.active,false);
  assert.ok(watches.every(w=>w.closed));
  api.close();
});

test('Pi registers graph adapter under one CodeIndex and no new event owner',async t=>{
  const {root}=fixture(t);
  const tools=new Map(),events=[];
  const pi={registerTool(x){tools.set(x.name,x);},on(name){events.push(name);}};
  const code=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,languagesEnabled:false,treeEnabled:false}}),loadCompiler:async()=>ts});
  assert.equal(events.length,0);
  const adapter=tools.get('envelope_code_external_graph');
  assert.ok(adapter);
  const result=await adapter.execute('rpc',{action:'status'},undefined,undefined,{cwd:root});
  assert.equal(result.isError,false,result.content[0]?.text);
  assert.equal(JSON.parse(result.content[0].text).state,'declared-sources-match');
  assert.equal(code.loaded(),1);
  code.close();
});

test('accepts actual Graphify NetworkX node-link JSON with root graph metadata, links, source and confidence',t=>{
 const {root,index,manifest}=fixture(t);
 const graph={directed:true,multigraph:true,graph:{name:'metadata only'},nodes:[
  {id:'n_auth',label:'Auth component',file_type:'code',source_file:'src/auth.ts',source_location:'L1'},
  {id:'n_db',label:'Database',file_type:'code',source_file:'src/db.ts',source_location:'L2'}],
  links:[{source:'n_auth',target:'n_db',relation:'depends_on',confidence:'INFERRED',confidence_score:0.75,source_file:'src/auth.ts',source_location:'L3'}]};
 const body=JSON.stringify(graph);writeFileSync(join(root,'graphify-out/graph.json'),body);
 writeFileSync(join(root,'graphify-out/envelope-sources.json'),JSON.stringify({...manifest,graphSha256:digest(body),files:[
 {path:'src/auth.ts',sha256:digest(readFileSync(join(root,'src/auth.ts')))},
 {path:'src/db.ts',sha256:digest(readFileSync(join(root,'src/db.ts')))}]}));
 const reader=new ExternalGraphReader(root);t.after(()=>reader.close());
 const status=reader.query(index,{action:'status'});
 assert.equal(status.state,'declared-sources-match',JSON.stringify(status));
 assert.equal(status.attestation?.allGraphSourcesCovered,true);
 const nodes=reader.query(index,{action:'nodes'}).nodes;
 assert.deepEqual(nodes.map(n=>n.path),['src/auth.ts','src/db.ts']);
 assert.equal(nodes[0].name,'Auth component');
 assert.equal(nodes[0].type,'code');
 assert.equal(nodes[0].sourceLocation,'L1');
 const path=reader.query(index,{action:'path',source:'n_auth',target:'n_db'});
 assert.equal(path.found,true);
 assert.equal(path.edges[0].type,'depends_on');
 assert.equal(path.edges[0].confidence,'INFERRED');
 assert.equal(path.edges[0].confidenceScore,0.75);
 assert.equal(path.edges[0].sourcePath,'src/auth.ts');
});

test('does not imply complete source attestation for graph nodes absent from the manifest',t=>{
 const {root,index}=fixture(t);
 const reader=new ExternalGraphReader(root);t.after(()=>reader.close());
 const status=reader.query(index,{action:'status'});
 assert.equal(status.state,'declared-sources-match');
 assert.equal(status.attestation?.allGraphSourcesCovered,false);
 assert.equal(status.attestation?.unattestedNodeSources,1);
 const report=reader.query(index,{action:'nodes'});
 assert.equal(report.complete,false);
 assert.ok(report.reasons.includes('partial-source-attestation'));
});

test('rejects a graph whose node-link source_file escapes the project root, without exposing it',t=>{
 const {root,index,graph}=fixture(t);
 graph.nodes[0].source_file='../../private.env';delete graph.nodes[0].file;
 writeFileSync(join(root,'graphify-out/graph.json'),JSON.stringify(graph));
 const reader=new ExternalGraphReader(root);t.after(()=>reader.close());
 const status=reader.query(index,{action:'status'});
 assert.equal(status.state,'invalid');
 assert.doesNotMatch(JSON.stringify(status),/private.env/);
});

test('CodeFeature.close stops external graph watchers without modifying the indexed project',async t=>{
 const {root}=fixture(t);const handlers=[];const tools=new Map();
 const watchers=[];
 const pi={registerTool(x){tools.set(x.name,x)},on(name){handlers.push(name)}};
 const feature=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,languagesEnabled:false,treeEnabled:false}}),loadCompiler:async()=>ts,
  watchGraphFactory:(path,opts,cb)=>{const handle={path,cb,closed:false,close(){this.closed=true}};watchers.push(handle);return handle;}});
 assert.equal((await tools.get('envelope_code_external_graph').execute('call',{action:'watch',enabled:true},null,null,{cwd:root})).isError,false);
 assert.ok(watchers.length>0);
 feature.close();
 assert.ok(watchers.every(w=>w.closed));
 assert.equal(handlers.length,0);
});

test('Envelope session shutdown releases opted-in graph watchers',async t=>{
 const {root}=fixture(t);
 const {default:registerEnvelope}=await import('../extensions/envelope/index.mjs');
 const state=join(root,'envelope-state');const tools=new Map(),handlers=new Map(),watches=[];
 const pi={cwd:root,on(name,handler){handlers.set(name,handler)},registerTool(x){tools.set(x.name,x)},registerCommand(){},logger:{warn(){}}};
 const app=registerEnvelope(pi,{home:state,loadCompiler:async()=>ts,
   watchGraphFactory:(dir,opts,cb)=>{const w={closed:false,close(){this.closed=true}};watches.push(w);return w;}});
 t.after(()=>app.close());
 const ctx={cwd:root};
 assert.equal(handlers.has('session_shutdown'),true);
 assert.equal((await tools.get('envelope_code_external_graph').execute('call',{action:'watch',enabled:true},null,null,ctx)).isError,false);
 assert.ok(watches.length>0,'the supplied graph watcher factory must be used');
 handlers.get('session_shutdown')({reason:'reload'},ctx);
 assert.ok(watches.every(w=>w.closed),'session shutdown must release each fs.watch handle');
});

test('turning Envelope code intelligence off also stops an active graph watch',async t=>{
 const {root}=fixture(t);
 const {default:registerEnvelope}=await import('../extensions/envelope/index.mjs');
 const tools=new Map(),commands=new Map(),watches=[];
 const pi={cwd:root,on(){},registerTool(v){tools.set(v.name,v)},registerCommand(n,v){commands.set(n,v)},logger:{warn(){}}};
 const app=registerEnvelope(pi,{home:join(root,'envelope-state'),loadCompiler:async()=>ts,
  watchGraphFactory:()=>{const w={closed:false,close(){this.closed=true}};watches.push(w);return w;}});
 t.after(()=>app.close());
 const ctx={cwd:root,ui:{notify(){}}};
 assert.equal((await tools.get('envelope_code_external_graph').execute('call',{action:'watch',enabled:true},null,null,ctx)).isError,false);
 assert.ok(watches.length>0);
 await commands.get('envelope').handler('code off',ctx);
 assert.ok(watches.every(w=>w.closed),'disabling code must dispose opt-in graph watchers');
});
