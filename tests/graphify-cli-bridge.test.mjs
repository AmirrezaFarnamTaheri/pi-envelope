import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GraphifyCliBridge,composeGraphifyOrientation} from '../extensions/envelope/graphify-cli.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';
import {MetricsLedger} from '../extensions/envelope/metrics-ledger.mjs';
import {inspectCapabilityCockpit} from '../extensions/envelope/capability-cockpit.mjs';

function fixture(t, {scriptBody, graph=true, stale=false, binaryName='graphify-test'}={}) {
  const home=mkdtempSync(join(tmpdir(),'envelope-cli-integration-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'repository');
  mkdirSync(root);
  mkdirSync(join(root,'graphify-out'));
  if (graph) writeFileSync(join(root,'graphify-out','graph.json'),JSON.stringify({directed:false,nodes:[{id:'A'},{id:'B'}],links:[{source:'A',target:'B',relation:'calls'}]}));
  if (stale)writeFileSync(join(root,'graphify-out','needs_update'),'1');
  const executable=join(home,binaryName);
  writeFileSync(executable,`#!/usr/bin/env node\n${scriptBody ?? "process.stdout.write(JSON.stringify({argv:process.argv.slice(2),backend:process.env.GRAPHIFY_BACKEND,log:process.env.GRAPHIFY_QUERY_LOG_DISABLE,hasKey:Boolean(process.env.OPENAI_API_KEY)}))"}\n`);
  chmodSync(executable,0o700);
  return {root,home,executable,config:{enabled:true,executable,timeoutMs:2500}};
}

const bridge=new GraphifyCliBridge();

test('status detects executable and graph without running a command; feature is off by default',async t=>{
  const f=fixture(t,{scriptBody:"require('node:fs').writeFileSync(process.argv[1]+'.ran','bad')"});
  const status=await bridge.run(f.root,{...f.config,enabled:false},{action:'status'});
  assert.equal(status.enabled,false);
  assert.equal(status.available,true);
  assert.equal(status.artifactState,'unverified');
  assert.equal(existsSync(f.executable+'.ran'),false);
  await assert.rejects(()=>bridge.run(f.root,{...f.config,enabled:false},{action:'query',question:'which files call A?'}),/disabled/i);
});

test('query/path/explain use bounded fixed arguments, a pinned executable and an environment without LLM keys',async t=>{
  const f=fixture(t);
  const old=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-key-must-not-escape';
  t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
  const q=await bridge.run(f.root,f.config,{action:'query',question:'who calls parseSession?',budget:800,depth:2});
  const parsed=JSON.parse(q.output);
  assert.deepEqual(parsed.argv,['query','who calls parseSession?','--budget','800','--depth','2','--graph','graphify-out/graph.json']);
  assert.equal(parsed.backend,'none');
  assert.equal(parsed.log,'1');
  assert.equal(parsed.hasKey,false);
  assert.equal(q.provenance,'external-graphify-cli');
  assert.equal(q.artifactState,'unverified');
  assert.deepEqual(JSON.parse((await bridge.run(f.root,f.config,{action:'path',source:'A',target:'B'})).output).argv,['path','A','B']);
  assert.deepEqual(JSON.parse((await bridge.run(f.root,f.config,{action:'explain',source:'A'})).output).argv,['explain','A']);
});

test('reads refuse stale, missing and unsafe graph artifacts unless a stale artifact is explicitly acknowledged',async t=>{
  const f=fixture(t,{stale:true});
  await assert.rejects(()=>bridge.run(f.root,f.config,{action:'query',question:'node'}),/stale/i);
  const result=await bridge.run(f.root,f.config,{action:'query',question:'node',allowStale:true});
  assert.equal(result.artifactState,'stale');
  assert.ok(result.reasons.includes('graphify-needs-update'));
  const missing=fixture(t,{graph:false});
  await assert.rejects(()=>bridge.run(missing.root,missing.config,{action:'path',source:'A',target:'B'}),/missing/i);
});

test('mutating Graphify commands require direct human command path and remain AST-only with LLM disabled',async t=>{
  const f=fixture(t);
  await assert.rejects(()=>bridge.run(f.root,f.config,{action:'build'}),/human|slash|mutation/i);
  const build=await bridge.run(f.root,f.config,{action:'build'},undefined,{humanCommand:true});
  assert.deepEqual(JSON.parse(build.output).argv,['extract','.','--code-only','--no-cluster']);
  const update=await bridge.run(f.root,f.config,{action:'update'},undefined,{humanCommand:true});
  assert.deepEqual(JSON.parse(update.output).argv,['update','.','--no-cluster']);
  assert.equal(build.writeRequested,true);
  assert.equal(update.writeRequested,true);
});

test('argument injection and repository-owned executable are rejected',async t=>{
  const f=fixture(t);
  for(const params of [
    {action:'path',source:'--help',target:'B'},
    {action:'query',question:'--help'},
    {action:'query',question:'hello\0bad'},
    {action:'query',question:'x'.repeat(400)},
    {action:'query',question:'ok',budget:1000000},
    {action:'explain',source:'../secret'},
    {action:'list-files'},
  ])await assert.rejects(()=>bridge.run(f.root,f.config,params),/invalid|limit|unsupported|argument|must/i);
  const unsafe=join(f.root,'local-graphify');
  writeFileSync(unsafe,"#!/usr/bin/env node\nprocess.stdout.write('oops')\n");chmodSync(unsafe,0o700);
  await assert.rejects(()=>bridge.run(f.root,{...f.config,executable:unsafe},{action:'query',question:'x'}),/project|repository/i);
});

test('output is fail-closed when oversized or process exits nonzero',async t=>{
  const huge=fixture(t,{scriptBody:"process.stdout.write('x'.repeat(60000))"});
  await assert.rejects(()=>bridge.run(huge.root,huge.config,{action:'query',question:'hello'}),/limit|large|output/i);
  const failed=fixture(t,{scriptBody:"process.stderr.write('error');process.exitCode=3"});
  await assert.rejects(()=>bridge.run(failed.root,failed.config,{action:'query',question:'hello'}),/exit|failed|3/i);
});

test('timeouts and cancellation terminate graphify subprocess rather than reporting success',async t=>{
  const hung=fixture(t,{scriptBody:"setInterval(()=>{},10000)"});
  await assert.rejects(()=>bridge.run(hung.root,{...hung.config,timeoutMs:100},{action:'query',question:'x'}),/timed out|timeout/i);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>bridge.run(hung.root,hung.config,{action:'query',question:'x'},controller.signal),/cancel|abort/i);
});

test('Pi integrates exactly one extra opt-in tool and human-only build command without new hooks',async t=>{
  const f=fixture(t,{binaryName:'Graphify Stub'});
  const tools=new Map(), commands=new Map(),hooks=new Map(),notices=[];
  const pi={cwd:f.root,logger:{warn(){}},on(name,fn){hooks.set(name,(hooks.get(name)||0)+1);},
    registerTool(tool){assert.ok(!tools.has(tool.name));tools.set(tool.name,tool);},
    registerCommand(name,cmd){commands.set(name,cmd);}};
  registerEnvelope(pi,{home:join(f.home,'state')});
  assert.ok(tools.has('envelope_graphify_cli'));
  assert.equal(hooks.get('before_agent_start'),1);
  assert.equal(hooks.get('tool_call'),1);
  assert.equal(hooks.get('tool_result'),1);
  const ctx={cwd:f.root,sessionManager:{getSessionId:()=> 's'},ui:{notify:(s)=>notices.push(s)}};
  const call=async params=>tools.get('envelope_graphify_cli').execute('call',params,undefined,undefined,ctx);
  assert.equal((await call({action:'query',question:'A'})).isError,true);
  await commands.get('envelope').handler(`graphify binary ${f.executable}`,ctx);
  await commands.get('envelope').handler('graphify on',ctx);
  const ok=await call({action:'query',question:'A'});
  assert.equal(ok.isError,false,ok.content?.[0]?.text);
  assert.equal((await call({action:'build'})).isError,true);
  await commands.get('envelope').handler('graphify build',ctx);
  assert.ok(notices.some(x=>/code-only|build|graph/i.test(x)));
  assert.equal((await call({action:'status'})).isError,false);
  await commands.get('envelope').handler('graphify off',ctx);
  assert.equal((await call({action:'query',question:'A'})).isError,true);
});

test('Graphify runtime metrics accept only payload-free known actions',t=>{
  const f=fixture(t);
  const ledger=new MetricsLedger(join(f.home,'metric-state'));
  t.after(()=>ledger.close());
  ledger.record(f.root,'graphify_cli',{action:'query',outcome:'ok',durationMs:4});
  assert.equal(ledger.snapshot(f.root).byKind.graphify_cli.count,1);
  assert.throws(()=>ledger.record(f.root,'graphify_cli',{action:'arbitrary',outcome:'ok'}),/unrecognized/i);
});


test('opt-in Graphify orientation is concise, idempotent, fresh-aware and removable',t=>{
  const f=fixture(t);
  assert.equal(composeGraphifyOrientation('Base Pi prompt',f.root,false),null);
  const once=composeGraphifyOrientation('Base Pi prompt',f.root,true);
  assert.ok(once.systemPrompt.includes('ENVELOPE_GRAPHIFY_ORIENTATION'));
  assert.match(once.systemPrompt,/unverified|source/i);
  assert.ok(once.systemPrompt.length<750);
  const twice=composeGraphifyOrientation(once.systemPrompt,f.root,true);
  assert.equal(twice.systemPrompt,once.systemPrompt);
  writeFileSync(join(f.root,'graphify-out','needs_update'),'1');
  const stale=composeGraphifyOrientation(twice.systemPrompt,f.root,true);
  assert.match(stale.systemPrompt,/stale/i);
  assert.equal((stale.systemPrompt.match(/<ENVELOPE_GRAPHIFY_ORIENTATION>/g)||[]).length,1);
  const disabled=composeGraphifyOrientation(stale.systemPrompt,f.root,false);
  assert.equal(disabled.systemPrompt,'Base Pi prompt');
});

test('Pi orientation reuses the single existing before_agent_start hook and does not invoke CLI',async t=>{
  const f=fixture(t);
  const hooks=new Map(),cmds=new Map(),pi={cwd:f.root,logger:{warn(){}},
    on(n,cb){hooks.set(n,[...(hooks.get(n)||[]),cb]);},registerTool(){},registerCommand(n,cmd){cmds.set(n,cmd);}};
  registerEnvelope(pi,{home:join(f.home,'state')});
  const ctx={cwd:f.root,ui:{notify(){}}};
  assert.equal(await hooks.get('before_agent_start')[0]({systemPrompt:'Original Pi'},ctx),undefined);
  await cmds.get('envelope').handler('graphify orientation on',ctx);
  const orient=await hooks.get('before_agent_start')[0]({systemPrompt:'Original Pi'},ctx);
  assert.match(orient?.systemPrompt||'',/ENVELOPE_GRAPHIFY_ORIENTATION/);
  assert.equal(hooks.get('before_agent_start').length,1);
  await cmds.get('envelope').handler('graphify orientation off',ctx);
  assert.equal(await hooks.get('before_agent_start')[0]({systemPrompt:'Original Pi'},ctx),undefined);
});

test('session close cancels a running Graphify command and leaves no background subprocess',async t=>{
  const f=fixture(t,{scriptBody:"setInterval(()=>{},10000)"});
  const active=new GraphifyCliBridge();
  const operation=active.run(f.root,{...f.config,timeoutMs:5000},{action:'query',question:'x'});
  setTimeout(()=>active.close(),70);
  await assert.rejects(operation,/cancel|abort/i);
});

test('capability cockpit routes the optional Graphify CLI only when explicitly configured',t=>{
  const f=fixture(t);
  const config={code:{enabled:true},graphify:{enabled:true,executable:f.executable}};
  const active=inspectCapabilityCockpit(config,{intent:'graph',pathEnv:''});
  assert.equal(active.capabilities.graphifyCli,'configured-unverified');
  assert.equal(active.plan[1].tool,'envelope_graphify_cli');
  assert.equal(active.plan[1].state,'suggested');
  assert.equal(active.toolExecution,false);
  const off=inspectCapabilityCockpit({...config,graphify:{...config.graphify,enabled:false}},{intent:'graph',pathEnv:''});
  assert.equal(off.capabilities.graphifyCli,'disabled');
  assert.ok(!off.plan.some(x=>x.tool==='envelope_graphify_cli'));
});
