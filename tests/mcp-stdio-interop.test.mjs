import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {GraphVersionStore} from '../extensions/envelope/graph-versions.mjs';
import {createMcpHandler,runMcpStdio} from '../scripts/envelope-mcp-stdio.mjs';
function fixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'env-mcp-repo-'))),home=realpathSync(mkdtempSync(join(tmpdir(),'env-mcp-home-')));
 t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});});
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src','a.ts'),'export const a=1;');
 const index=new CodeIndex(root,{ts});index.refresh();
 const store=new GraphVersionStore(join(home,'envelope-graph-versions')),first=store.capture(index);
 return {root,home,index,store,first};
}
const req=(id,method,params)=>({jsonrpc:'2.0',id,method,...(params?{params}:{})});
const init=()=>req(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
test('handshake and tools expose only explicitly captured file metadata',t=>{
 const f=fixture(t),handle=createMcpHandler(f.store,f.index);
 assert.equal(handle(req(0,'tools/list')).error.code,-32002);
 assert.equal(handle(init()).result.protocolVersion,'2025-11-25');
 assert.equal(handle({jsonrpc:'2.0',method:'notifications/initialized'}),null);
 const tools=handle(req(2,'tools/list')).result.tools;
 assert.deepEqual(tools.map(x=>x.name),['envelope.graph.versions','envelope.graph.snapshot','envelope.graph.compare']);
 assert.ok(tools.every(x=>x.annotations.readOnlyHint===true));
 const result=handle(req(3,'tools/call',{name:'envelope.graph.snapshot',arguments:{version:f.first.version,limit:4}}));
 assert.equal(result.result.isError,false);
 assert.equal(result.result.structuredContent.files[0].path,'src/a.ts');
 assert.doesNotMatch(JSON.stringify(result),/export const a=1/);
 assert.deepEqual(handle(req(4,'ping')).result,{});
});
test('unknown mutation tools and invalid versions fail without disclosing private files',t=>{
 const f=fixture(t),h=createMcpHandler(f.store,f.index);
 assert.equal(h(req(1,'tools/call',{name:'envelope.graph.versions'})).error.code,-32002);
 assert.equal(h(req(2,'initialize',{protocolVersion:'bad'})).error.code,-32602);
 h(init());h({jsonrpc:'2.0',method:'notifications/initialized'});
 assert.equal(h(req(3,'tools/call',{name:'envelope.graph.capture',arguments:{}})).error.code,-32602);
 assert.equal(h(req(4,'arbitrary/command')).error.code,-32601);
 assert.equal(h(req(5,'tools/call',{name:'envelope.graph.snapshot',arguments:{version:'../malicious'}})).result.isError,true);
});
async function run(project,home,requests){
 const script=join(import.meta.dirname,'..','scripts','envelope-mcp-stdio.mjs');
 const child=spawn(process.execPath,[script,'--project',project,'--home',home],{stdio:['pipe','pipe','pipe'],env:{...process.env,NODE_NO_WARNINGS:'1'}});
 let stdout='',stderr='';
 child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
 child.stdin.end(requests.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('\n')+'\n');
 const status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 return {status,stderr,lines:stdout.trim().split('\n').filter(Boolean).map(JSON.parse)};
}
test('a genuine newline-delimited stdio subprocess handles MCP initialize and read calls',async t=>{
 const f=fixture(t),requests=[init(),{jsonrpc:'2.0',method:'notifications/initialized'},req(2,'tools/list'),
   req(3,'tools/call',{name:'envelope.graph.versions',arguments:{}}),
   req(4,'tools/call',{name:'envelope.graph.snapshot',arguments:{version:f.first.version}})];
 const result=await run(f.root,f.home,requests);
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(result.lines.map(x=>x.id),[1,2,3,4]);
 assert.equal(result.lines[3].result.structuredContent.files.length,1);
 assert.ok(result.lines.every(x=>x.jsonrpc==='2.0'));
 assert.doesNotMatch(JSON.stringify(result),/export const a=1/);
});
test('bad and oversized frames yield bounded protocol errors',async t=>{
 const f=fixture(t),r=await run(f.root,f.home,['{bad-json','X'.repeat(20000)]);
 assert.equal(r.status,0,r.stderr);
 assert.deepEqual(r.lines.map(x=>x.error.code),[-32700,-32600]);
 assert.ok(r.lines.every(x=>JSON.stringify(x).length<400));
});

test('MCP budgets the complete doubled JSON-RPC payload, not just the graph metadata',t=>{
 const f=fixture(t);
 const fake=createMcpHandler({list:()=>({data:'z'.repeat(12000)})},f.index);
 fake(init());fake({jsonrpc:'2.0',method:'notifications/initialized'});
 const reply=fake(req(8,'tools/call',{name:'envelope.graph.versions',arguments:{}}));
 assert.equal(reply.result.isError,true);
 assert.ok(Buffer.byteLength(JSON.stringify(reply),'utf8')<20000);
});
test('raw stream rejects enormous unterminated frames then processes valid later requests',async t=>{
 const f=fixture(t),input=Readable.from([Buffer.from('Q'.repeat(100_000)),Buffer.from('\n'+JSON.stringify(init())+'\n')]);
 let output='';
 const sink=new Writable({highWaterMark:5,write(chunk,_enc,done){
   output+=chunk.toString('utf8');
   setImmediate(done); // Force actual backpressure and a drain event.
 }});
 await runMcpStdio(['node','server','--project',f.root,'--home',f.home],input,sink);
 const frames=output.trim().split('\n').map(JSON.parse);
 assert.deepEqual(frames.map(x=>x.id),[null,1]);
 assert.equal(frames[0].error.code,-32600);
 assert.equal(frames[1].result.protocolVersion,'2025-11-25');
});
