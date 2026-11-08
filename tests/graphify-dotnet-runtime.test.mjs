import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GraphifyDotnetBridge} from '../extensions/envelope/graphify-dotnet-runtime.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';
function fixture(t,script){
 const top=mkdtempSync(join(tmpdir(),'env-dotnet-test-'));
 t.after(()=>rmSync(top,{recursive:true,force:true}));
 const root=join(top,'repo');mkdirSync(root);mkdirSync(join(root,'src'));
 writeFileSync(join(root,'src','a.ts'),'export function foo(){return 1;}');
 const executable=join(top,'trusted-graphify');
 const payload=script??[
  "const {mkdirSync,writeFileSync}=require('node:fs');const {join}=require('node:path');",
  "if(process.argv.slice(2).join(' ')!=='run . --format json --output .envelope/graphify-dotnet-out')process.exit(21);",
  "if(process.env.GRAPHIFY__Provider!=='None')process.exit(22);",
  "if(process.env.GRAPHIFY__AzureOpenAI__ApiKey)process.exit(23);",
  "if(!process.env.DOTNET_CLI_HOME)process.exit(24);",
  "mkdirSync(join(process.cwd(),'.envelope','graphify-dotnet-out'),{recursive:true});",
  "writeFileSync(join(process.cwd(),'.envelope','graphify-dotnet-out','graph.json'),JSON.stringify({nodes:[{id:'a'},{id:'b'}],edges:[{source:'a',target:'b'}]}));",
  "console.log('safe output');"
 ].join('\n');
 writeFileSync(executable,'#!/usr/bin/env node\n'+payload+'\n',{mode:0o700});chmodSync(executable,0o700);
 return {top,root,executable,bridge:new GraphifyDotnetBridge(),config:{enabled:true,executable,timeoutMs:3000}};
}
test('status is read-only and never launches the binary',async t=>{
 const f=fixture(t,'process.exit(11)');
 const report=await f.bridge.run(f.root,f.config,{action:'status'});
 assert.equal(report.available,true);assert.equal(report.artifactState,'missing');
});
test('explicit human build uses fixed argv, isolated environment and separate output',async t=>{
 const f=fixture(t);
 await assert.rejects(()=>f.bridge.run(f.root,f.config,{action:'build'}),/human|explicit/i);
 const prev=process.env.GRAPHIFY__AzureOpenAI__ApiKey;
 process.env.GRAPHIFY__AzureOpenAI__ApiKey='PRIVATE_KEY_MUST_NOT_REACH_CHILD';
 try{
  const report=await f.bridge.run(f.root,f.config,{action:'build'},undefined,{humanCommand:true});
  assert.equal(report.artifactState,'unverified');assert.equal(report.nodes,2);assert.equal(report.edges,1);
  assert.equal(report.artifactChanged,true);assert.match(report.graphHash,/^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_KEY|safe output|export function foo/);
  assert.equal((await f.bridge.run(f.root,f.config,{action:'status'})).graphHash,report.graphHash);
 }finally{if(prev===undefined)delete process.env.GRAPHIFY__AzureOpenAI__ApiKey;else process.env.GRAPHIFY__AzureOpenAI__ApiKey=prev;}
});
test('project-side executables and output symlinks are rejected',async t=>{
 const f=fixture(t),inside=join(f.root,'malicious');
 writeFileSync(inside,'#!/bin/sh\nexit 0\n',{mode:0o700});
 assert.equal((await f.bridge.run(f.root,{...f.config,executable:inside},{action:'status'})).available,false);
 await assert.rejects(()=>f.bridge.run(f.root,{...f.config,executable:inside},{action:'build'},undefined,{humanCommand:true}),/unavailable|unsafe/i);
 mkdirSync(join(f.root,'.envelope'));
 const outside=join(f.top,'outside');mkdirSync(outside);
 symlinkSync(outside,join(f.root,'.envelope','graphify-dotnet-out'));
 await assert.rejects(()=>f.bridge.run(f.root,f.config,{action:'build'},undefined,{humanCommand:true}),/symlink|unsafe/i);
});
test('timeouts, cancellation and high stdout volumes fail closed',async t=>{
 const f=fixture(t,"setInterval(()=>{},5000);process.stderr.write('SECRET_TOKEN');");
 await assert.rejects(()=>f.bridge.run(f.root,{...f.config,timeoutMs:100},{action:'build'},undefined,{humanCommand:true}),/timed out/i);
 const signal=new AbortController();signal.abort();
 await assert.rejects(()=>f.bridge.run(f.root,f.config,{action:'build'},signal.signal,{humanCommand:true}),/cancel/i);
 const noisy=fixture(t,"process.stdout.write('X'.repeat(20000));");
 await assert.rejects(()=>noisy.bridge.run(noisy.root,noisy.config,{action:'build'},undefined,{humanCommand:true}),/limit|exceeded/i);
});
test('disabled and malformed graph never report verified success',async t=>{
 const f=fixture(t,[
  "const {mkdirSync,writeFileSync}=require('node:fs');const {join}=require('node:path');",
  "mkdirSync(join(process.cwd(),'.envelope','graphify-dotnet-out'),{recursive:true});",
  "writeFileSync(join(process.cwd(),'.envelope','graphify-dotnet-out','graph.json'),'{bad json');"
 ].join('\n'));
 await assert.rejects(()=>f.bridge.run(f.root,{...f.config,enabled:false},{action:'build'},undefined,{humanCommand:true}),/disabled/i);
 const result=await f.bridge.run(f.root,f.config,{action:'build'},undefined,{humanCommand:true});
 assert.equal(result.artifactState,'invalid');assert.equal(result.artifactChanged,false);
});
test('Pi agent can only read status; human command alone builds; original hooks remain single-owned',async t=>{
 const f=fixture(t),tools=new Map(),commands=new Map(),hooks=new Map(),notices=[];
 const pi={cwd:f.root,registerTool:x=>tools.set(x.name,x),registerCommand:(n,x)=>commands.set(n,x),
  on:(n,x)=>hooks.set(n,[...(hooks.get(n)||[]),x]),logger:{warn(){}}};
 registerEnvelope(pi,{home:join(f.top,'state'),graphifyDotnetBridge:f.bridge});
 const ctx={cwd:f.root,sessionManager:{getSessionId:()=> 'dotnet-1'},ui:{notify:x=>notices.push(x)}};
 const tool=tools.get('envelope_graphify_dotnet');assert.ok(tool);
 assert.deepEqual(tool.parameters.properties.action.enum,['status']);
 const command=x=>commands.get('envelope').handler(x,ctx);
 assert.equal(JSON.parse((await tool.execute('id',{action:'status'},undefined,undefined,ctx)).content[0].text).enabled,false);
 await command('graphify-dotnet build');
 assert.ok(notices.some(s=>/not enabled|disabled/i.test(s)));
 await command('graphify-dotnet binary '+f.executable);
 await command('graphify-dotnet on');
 await command('graphify-dotnet build');
 assert.ok(notices.some(s=>/2 nodes|2 node/i.test(s)),notices.join('\n'));
 assert.equal(JSON.parse((await tool.execute('id',{action:'status'},undefined,undefined,ctx)).content[0].text).nodes,2);
 await command('graphify-dotnet off');
 for(const hook of ['before_agent_start','tool_result','session_shutdown'])assert.equal(hooks.get(hook).length,1);
});
