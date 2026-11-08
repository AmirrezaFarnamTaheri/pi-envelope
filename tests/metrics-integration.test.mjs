import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerEnvelope from '../extensions/envelope/index.mjs';

const noisy=['RUN v3.1.0',...Array.from({length:120},(_,i)=>`  ✓ service ${i+1} passes with fixtures`),'Test Files  1 passed (1)','Tests  120 passed (120)'].join('\n');
function harness(t,{brokenMetrics=false}={}){
  const root=mkdtempSync(join(tmpdir(),'envelope-obs-integration-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'state');const project=join(root,'project');mkdirSync(project);
  if(brokenMetrics){mkdirSync(home);writeFileSync(join(home,'envelope-metrics'),'not a directory');}
  const hooks=new Map(),tools=new Map(),notices=[],warnings=[];let commands=new Map();
  const pi={cwd:project,on(name,fn){hooks.set(name,[...(hooks.get(name)||[]),fn]);},
    registerTool(tool){assert.equal(tools.has(tool.name),false);tools.set(tool.name,tool);},
    registerCommand(name,cmd){commands.set(name,cmd);},logger:{warn(message){warnings.push(message)}}};
  const ext=registerEnvelope(pi,{home});
  const ctx={cwd:project,sessionManager:{getSessionId:()=> 'session-a'},ui:{notify(message){notices.push(message);}}};
  const call=(name,params={},context=ctx)=>tools.get(name).execute('tool-id',params,undefined,undefined,context);
  const command=(args)=>commands.get('envelope').handler(args,ctx);
  return{root,home,project,hooks,tools,notices,warnings,ext,ctx,call,command};
}
const snapshot=async(h,ctx=h.ctx)=>{
  const res=await h.call('envelope_metrics_snapshot',{},ctx);
  assert.equal(res.isError,false,res.content[0]?.text);
  return JSON.parse(res.content[0].text);
};

test('registers one read-only Pi usage hook and disjoint metrics tools',t=>{
  const h=harness(t);
  assert.equal(h.hooks.get('message_end').length,1);
  assert.equal(h.hooks.get('context').length,1);
  assert.equal(h.hooks.get('tool_result').length,1);
  assert.equal(h.hooks.get('tool_call').length,1); // inert unless code guard enabled
  for(const name of ['envelope_metrics_snapshot','envelope_metrics_events'])assert.ok(h.tools.has(name),name);
});

test('Pi assistant usage is measured only from finalized assistant messages, with reported-versus-estimated billing',async(t)=>{
  const h=harness(t);
  const hook=h.hooks.get('message_end')[0];
  assert.equal(await hook({message:{role:'user',usage:{input:999}}},h.ctx),undefined);
  assert.equal(await hook({message:{role:'toolResult',usage:{input:999}}},h.ctx),undefined);
  assert.equal(await hook({message:{role:'assistant'}},h.ctx),undefined);
  assert.equal(await hook({message:{role:'assistant',usage:{input:1100,output:220,cacheRead:400,cacheWrite:30,cost:{total:0.021,totalFromProvider:true}}}},h.ctx),undefined);
  assert.equal(await hook({message:{role:'assistant',usage:{input:900,output:120,cacheRead:300,cacheWrite:0,cost:{total:0.01,totalFromProvider:false}}}},h.ctx),undefined);
  const s=await snapshot(h);
  assert.equal(s.modelUsage.messages,2);
  assert.equal(s.modelUsage.inputTokens,2000);
  assert.equal(s.modelUsage.cacheReadTokens,700);
  assert.equal(s.modelUsage.providerBilledUsd,0.021);
  assert.equal(s.modelUsage.catalogEstimatedUsd,0.01);
  assert.equal((await snapshot(h,{cwd:join(h.root,'else')})).totalEvents,0);
});

test('actual output, context, code and workflow operations emit separate scoped numeric events',async(t)=>{
  const h=harness(t);
  const output=await h.hooks.get('tool_result')[0]({toolName:'bash',isError:false,content:[{type:'text',text:noisy}]},h.ctx);
  assert.match(output?.content?.[0]?.text,/envelope_recall_output/);
  const codefile=join(h.project,'hello.ts');writeFileSync(codefile,'export function hello() { return 42; }\n');
  const lookup=await h.call('envelope_code_lookup',{query:'hello'});
  assert.equal(lookup.isError,false,lookup.content[0].text);
  const create=await h.call('envelope_workflow_create',{name:'Evaluate',tasks:[{id:'check',title:'Check',instructions:'Run tests'}]});
  assert.equal(create.isError,false,create.content[0].text);
  const checkpoint=await h.call('envelope_context_checkpoint',{name:'done'});
  assert.equal(checkpoint.isError,false);
  await h.command('context on');
  assert.equal((await h.call('envelope_context_prune',{checkpoint:'done'})).isError,false);
  const messages=[
    {role:'user',content:'Inspect'},
    {role:'assistant',content:[{type:'toolCall',id:'call-1',name:'bash',arguments:{command:'npm test'}}]},
    {role:'toolResult',toolCallId:'call-1',toolName:'bash',content:[{type:'text',text:'line with content'.repeat(300)}],isError:false},
    {role:'assistant',content:[{type:'toolCall',id:'tool-id',name:'envelope_context_checkpoint',arguments:{name:'done'}}]},
    {role:'toolResult',toolCallId:'tool-id',toolName:'envelope_context_checkpoint',content:[{type:'text',text:'saved'}],isError:false},
    {role:'user',content:'new step'},
    ...Array.from({length:10},(_,i)=>({role:'assistant',content:[{type:'text',text:`step ${i}`}] }))
  ];
  const projected=await h.hooks.get('context')[0]({messages},h.ctx);
  assert.ok(projected?.messages?.length,'context projection activated');
  const s=await snapshot(h);
  for(const kind of ['output_compaction','context_projection','code_query','workflow_action']) assert.ok(s.byKind[kind]?.count>=1,kind);
  assert.ok(s.byKind.output_compaction.rawBytes>s.byKind.output_compaction.renderedBytes);
  assert.ok(s.byKind.context_projection.rawBytes>s.byKind.context_projection.renderedBytes);
  const events=await h.call('envelope_metrics_events',{limit:20});
  assert.equal(events.isError,false);
  const records=JSON.parse(events.content[0].text);
  assert.ok(!JSON.stringify(records).includes('line with content'));
  assert.ok(!JSON.stringify(records).includes(h.project));
});

test('local observability can be disabled and reenabled without changing existing coding behavior',async(t)=>{
  const h=harness(t);
  await h.command('observability off');
  await h.hooks.get('message_end')[0]({message:{role:'assistant',usage:{input:99,output:9,cost:{total:0.01}}}},h.ctx);
  const output=await h.hooks.get('tool_result')[0]({toolName:'bash',content:[{type:'text',text:noisy}]},h.ctx);
  assert.match(output.content[0].text,/envelope_recall_output/);
  assert.equal((await snapshot(h)).totalEvents,0);
  await h.command('observability on');
  await h.hooks.get('message_end')[0]({message:{role:'assistant',usage:{input:5,output:2,cost:{total:0.0001}}}},h.ctx);
  assert.equal((await snapshot(h)).modelUsage.messages,1);
  await h.command('metrics');
  assert.ok(h.notices.some(x=>x.includes('model input 5')));
});

test('metrics database initialization failure leaves other Pi functionality intact',async(t)=>{
  const h=harness(t,{brokenMetrics:true});
  const result=await h.hooks.get('tool_result')[0]({toolName:'bash',content:[{type:'text',text:noisy}]},h.ctx);
  assert.match(result.content[0].text,/envelope_recall_output/);
  const denied=await h.call('envelope_metrics_snapshot');
  assert.equal(denied.isError,true);
  assert.ok(h.warnings.some(x=>x.includes('metrics')));
  await h.hooks.get('session_shutdown')[0]({reason:'quit'},h.ctx);
});

test('metrics survive restart on the same project and closed ledger remains fail-open',async(t)=>{
  const h=harness(t);
  await h.hooks.get('message_end')[0]({message:{role:'assistant',usage:{input:10,output:5}}},h.ctx);
  h.ext.close();
  const pi={cwd:h.project,on(){},registerTool(tool){if(tool.name==='envelope_metrics_snapshot') this.snap=tool;},registerCommand(){},logger:{warn(){}}};
  const second=registerEnvelope(pi,{home:h.home});
  const res=await pi.snap.execute('id',{},undefined,undefined,h.ctx);
  assert.equal(JSON.parse(res.content[0].text).modelUsage.inputTokens,10);
  second.close();
});
