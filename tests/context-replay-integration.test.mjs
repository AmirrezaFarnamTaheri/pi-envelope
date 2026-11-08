import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerEnvelope from '../extensions/envelope/index.mjs';

const payload=`Test diagnostics\n${'PASS repeatable fixture output 1234567890\n'.repeat(150)}`;
function source(){
  return [
    {role:'user',content:'Verify before checkpoint'},
    {role:'assistant',content:[{type:'toolCall',id:'shell-1',name:'bash',arguments:{command:'npm test'}}]},
    {role:'toolResult',toolName:'bash',toolCallId:'shell-1',isError:false,content:[{type:'text',text:payload}]},
    {role:'assistant',content:[{type:'toolCall',id:'checkpoint-1',name:'envelope_context_checkpoint',arguments:{name:'phase-a'}}]},
    {role:'toolResult',toolName:'envelope_context_checkpoint',toolCallId:'checkpoint-1',isError:false,content:[{type:'text',text:'saved'}]},
    {role:'user',content:'Carry on'},
    {role:'assistant',content:[{type:'text',text:'Implementing'}]},
    ...Array.from({length:8},(_,i)=>({role:'assistant',content:[{type:'text',text:`Working step ${i}`}]})),
  ];
}
function register(root){
  const hooks=new Map(),tools=new Map(),commands=new Map();
  const pi={cwd:'/repo/a',on(n,fn){hooks.set(n,[...(hooks.get(n)||[]),fn]);},registerTool(v){tools.set(v.name,v);},registerCommand(n,v){commands.set(n,v);},logger:{warn(){}}};
  const app=registerEnvelope(pi,{home:join(root,'home')});
  let session='s1';
  const ctx={cwd:'/repo/a',sessionManager:{getSessionId:()=>session},ui:{notify(){}}};
  const tool=(n,id,p)=>tools.get(n).execute(id,p,undefined,undefined,ctx);
  const run=()=>hooks.get('context')[0]({messages:source()},ctx);
  const command=(args)=>commands.get('envelope').handler(args,ctx);
  return {app,hooks,tools,command,tool,run,ctx,setSession(id){session=id;}};
}
function setup(t){
  const root=mkdtempSync(join(tmpdir(),'envelope-replay-integ-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,instance:register(root)};
}

test('existing context hook exposes only scoped replay block metadata on the timeline',async t=>{
  const {instance:h}=setup(t);
  assert.equal(h.hooks.get('context').length,1);
  await h.command('context on');
  assert.equal((await h.tool('envelope_context_checkpoint','checkpoint-1',{name:'phase-a'})).isError,false);
  assert.equal((await h.tool('envelope_context_prune','activate-1',{checkpoint:'phase-a'})).isError,false);
  const output=await h.run();
  assert.ok(output?.messages[2].content[0].text.includes('envelope_recall_output'));
  const timeline=JSON.parse((await h.tool('envelope_context_timeline','timeline',{})).content[0].text);
  assert.equal(timeline.active,'phase-a');
  assert.equal(timeline.replay?.version,1);
  assert.equal(timeline.replay?.total,1);
  assert.equal(timeline.replay.blocks.length,1);
  assert.doesNotMatch(JSON.stringify(timeline.replay),/npm test|PASS repeatable|\/repo\/a/);
  h.app.close();
});

test('replay blocks survive shutdown; deletion prevents silent recapture and restore leaves transcript exact',async t=>{
  const {root,instance:h}=setup(t);
  await h.command('context on');
  await h.tool('envelope_context_checkpoint','checkpoint-1',{name:'phase-a'});
  await h.tool('envelope_context_prune','activate-1',{checkpoint:'phase-a'});
  const initial=await h.run();
  const id=initial.messages[2].content[0].text.match(/id=([a-f0-9]{64})/)[1];
  h.app.close();
  const restarted=register(root);
  assert.equal((await restarted.run()).messages[2].content[0].text,initial.messages[2].content[0].text);
  await restarted.command(`output erase ${id}`);
  assert.equal(await restarted.run(),undefined,'deleted raw output must not be archived again merely by context projection');
  const exact=source();
  assert.equal((await restarted.tool('envelope_context_restore','restore',{})).isError,false);
  assert.equal(await restarted.run(),undefined);
  assert.deepEqual(source(),exact);
  restarted.app.close();
});

test('when context frontier database is unavailable, no archive preview is displayed',async t=>{
  const {root,instance:h}=setup(t);
  h.app.close();
  const folder=join(root,'home','envelope-context');
  mkdirSync(folder,{recursive:true});
  // A symlinked file must fail closed, without disabling other extension modules.
  const existing=join(folder,'frontier.sqlite');
  const target=join(root,'external.txt');
  writeFileSync(target,'sensitive');
  rmSync(existing,{force:true});
  const {symlinkSync}=await import('node:fs');
  symlinkSync(target,existing);
  const restarted=register(root);
  await restarted.command('context on');
  await restarted.tool('envelope_context_checkpoint','checkpoint-1',{name:'phase-a'});
  const denied=await restarted.tool('envelope_context_prune','activate-1',{checkpoint:'phase-a'});
  assert.equal(denied.isError,true);
  assert.match(denied.content[0].text,/frontier|replay|unavailable/i);
  assert.equal(await restarted.run(),undefined);
  assert.equal(readFileSync(target,'utf8'),'sensitive');
  restarted.app.close();
});
