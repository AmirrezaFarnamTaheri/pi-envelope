import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerEnvelope from '../extensions/envelope/index.mjs';

function makeHarness(root) {
  const hooks=new Map(), tools=new Map(), commands=new Map(), notices=[];
  const pi={
    cwd:'/repo/a',
    on(name,handler){hooks.set(name,[...(hooks.get(name)||[]),handler]);},
    registerTool(tool){assert.equal(tools.has(tool.name),false);tools.set(tool.name,tool);},
    registerCommand(name,cmd){commands.set(name,cmd);},
    logger:{warn(){}}
  };
  const registration=registerEnvelope(pi,{home:join(root,'state')});
  let currentSession='session-1';
  const ctx={ cwd:'/repo/a', sessionManager:{getSessionId:()=>currentSession}, ui:{notify:(text,level)=>notices.push([text,level])} };
  const setSession=id=>{currentSession=id;};
  const tool=(name,id,params,context=ctx)=>tools.get(name).execute(id,params,undefined,undefined,context);
  const command=(args,context=ctx)=>commands.get('envelope').handler(args,context);
  return {hooks,tools,commands,ctx,notices,tool,command,registration,setSession};
}
function history() {
  const original=`start full suite\n${'PASS - case with large diagnostic payload xyz 1234567890\n'.repeat(120)}112 passed`;
  const messages=[
    {role:'user',content:'Check all the tests'},
    {role:'assistant',content:[{type:'toolCall',id:'run-1',name:'bash',arguments:{command:'npm test'}}]},
    {role:'toolResult',toolCallId:'run-1',toolName:'bash',content:[{type:'text',text:original}],isError:false},
    {role:'assistant',content:[{type:'toolCall',id:'checkpoint-1',name:'envelope_context_checkpoint',arguments:{name:'checkpoint-one'}}]},
    {role:'toolResult',toolCallId:'checkpoint-1',toolName:'envelope_context_checkpoint',content:[{type:'text',text:'saved'}],isError:false},
    {role:'user',content:'Now implement change'},
    {role:'assistant',content:[{type:'text',text:'Working'}]},
    {role:'toolResult',toolCallId:'tail-1',toolName:'bash',content:[{type:'text',text:original}],isError:false},
    ...Array.from({length:6},(_,i)=>({role:'assistant',content:[{type:'text',text:`Continuing task ${i}`}]}))
  ];
  return {original,messages};
}
function fresh(t){
  const root=mkdtempSync(join(tmpdir(),'envelope-context-int-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,h:makeHarness(root)};
}

test('registers a single context hook and context tools under the existing Pi extension', (t)=>{
  const {h}=fresh(t);
  assert.equal(h.hooks.get('context').length,1);
  assert.equal(h.hooks.has('context_with_system'),false);
  assert.equal(h.hooks.get('tool_call').length,1); // inert unless code guard enabled
  for(const name of ['envelope_context_checkpoint','envelope_context_timeline','envelope_context_prune','envelope_context_restore']){
    assert.ok(h.tools.has(name),`missing ${name}`);
  }
  assert.ok(h.commands.has('envelope'));
});

test('context is off until explicitly enabled, checkpointed and activated',async(t)=>{
  const {h}=fresh(t);
  const {messages,original}=history();
  const hook=h.hooks.get('context')[0];
  assert.equal(await hook({messages},h.ctx),undefined);
  const c=await h.tool('envelope_context_checkpoint','checkpoint-1',{name:'checkpoint-one'});
  assert.equal(c.isError,false);
  const denied=await h.tool('envelope_context_prune','prune-1',{checkpoint:'checkpoint-one'});
  assert.equal(denied.isError,true);
  await h.command('context on');
  assert.equal(await hook({messages},h.ctx),undefined,'enabled without activated checkpoint remains inert');
  const armed=await h.tool('envelope_context_prune','prune-2',{checkpoint:'checkpoint-one'});
  assert.equal(armed.isError,false);
  const transformed=await hook({messages},h.ctx);
  assert.ok(transformed?.messages[2].content[0].text.length<original.length);
  assert.equal(transformed.messages[5].content,messages[5].content);
  const id=transformed.messages[2].content[0].text.match(/envelope_recall_output id=([a-f0-9]{64})/)[1];
  const recalled=await h.tool('envelope_recall_output','r1',{id});
  assert.equal(recalled.content[0].text,original);
  const timeline=await h.tool('envelope_context_timeline','timeline',{});
  assert.match(timeline.content[0].text,/"active": "checkpoint-one"/);
  assert.match(timeline.content[0].text,/"name": "checkpoint-one"/);
  assert.equal((await hook({messages},h.ctx)).messages[2].content[0].text,transformed.messages[2].content[0].text);
});

test('off and restore do not rewrite the saved transcript and stop future pruning',async(t)=>{
  const {h}=fresh(t);const {messages}=history();
  await h.command('context on');
  await h.tool('envelope_context_checkpoint','checkpoint-1',{name:'checkpoint-one'});
  await h.tool('envelope_context_prune','prune-1',{checkpoint:'checkpoint-one'});
  assert.ok(await h.hooks.get('context')[0]({messages},h.ctx));
  const restored=await h.tool('envelope_context_restore','restore-1',{});
  assert.equal(restored.isError,false);
  assert.equal(await h.hooks.get('context')[0]({messages},h.ctx),undefined);
  await h.tool('envelope_context_prune','prune-2',{checkpoint:'checkpoint-one'});
  await h.command('context off');
  assert.equal(await h.hooks.get('context')[0]({messages},h.ctx),undefined);
  await h.command('context on');
  assert.equal(await h.hooks.get('context')[0]({messages},h.ctx),undefined,'off clears active checkpoint to avoid surprise on re-enable');
});

test('state persists across new registration, but cannot affect another session or branch',async(t)=>{
  const {h,root}=fresh(t);const {messages}=history();
  await h.command('context on');
  await h.tool('envelope_context_checkpoint','checkpoint-1',{name:'checkpoint-one'});
  await h.tool('envelope_context_prune','prune-1',{checkpoint:'checkpoint-one'});
  h.registration.close();
  const resumed=makeHarness(root);
  const projection=await resumed.hooks.get('context')[0]({messages},resumed.ctx);
  assert.ok(projection?.messages[2].content[0].text.includes('envelope_recall_output'));
  resumed.setSession('session-2');
  assert.equal(await resumed.hooks.get('context')[0]({messages},resumed.ctx),undefined);
  resumed.setSession('session-1');
  const otherBranch=messages.filter(m=>m.toolCallId!=='checkpoint-1');
  assert.equal(await resumed.hooks.get('context')[0]({messages:otherBranch},resumed.ctx),undefined);
  const otherProject={...resumed.ctx,cwd:'/repo/b'};
  assert.equal(await resumed.hooks.get('context')[0]({messages},otherProject),undefined);
  resumed.registration.close();
});

test('invalid or unavailable session manager produces explicit tool failures without context modification',async(t)=>{
  const {h}=fresh(t);const invalid={cwd:'/repo/a'};const {messages}=history();
  await h.command('context on');
  assert.equal((await h.tool('envelope_context_checkpoint','id',{name:'a'},invalid)).isError,true);
  assert.equal((await h.tool('envelope_context_prune','id',{checkpoint:'a'},invalid)).isError,true);
  assert.equal(await h.hooks.get('context')[0]({messages},invalid),undefined);
  assert.equal((await h.tool('envelope_context_checkpoint','id',{name:'../bad'})).isError,true);
  assert.equal((await h.tool('envelope_context_prune','id',{checkpoint:'not-created'})).isError,true);
});


test('context toggles persist without overwriting Tersio settings or output/policy modes',async(t)=>{
  const {h,root}=fresh(t);
  const file=join(root,'state','settings.json');
  await h.command('policy on');
  await h.command('output off');
  await h.command('context on');
  const saved=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(saved.envelope.context.enabled,true);
  assert.equal(saved.envelope.output.enabled,false);
  assert.equal(saved.envelope.policy.enabled,true);
  assert.equal(saved.envelope.context.recentMessages,8);
  await h.command('context off');
  const after=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(after.envelope.context.enabled,false);
  assert.equal(after.envelope.output.enabled,false);
  assert.equal(after.envelope.policy.enabled,true);
});
