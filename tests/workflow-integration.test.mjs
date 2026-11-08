import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const executeGit=promisify(execFile);
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerEnvelope from '../extensions/envelope/index.mjs';

const plan={name:'Delivery',tasks:[
  {id:'first',title:'Build module',instructions:'Implement module, run tests, report verification evidence'},
  {id:'second',title:'Document module',instructions:'Write README notes',dependsOn:['first']}
]};
function fixture(t,runner) {
  const root=mkdtempSync(join(tmpdir(),'envelope-workflow-api-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const project=join(root,'workspace');mkdirSync(project);
  execFileSync('git',['init','-q'],{cwd:project});
  writeFileSync(join(project,'code.js'),'export const initial=1;\n');
  execFileSync('git',['add','code.js'],{cwd:project});
  execFileSync('git',['-c','user.name=Envelope Tests','-c','user.email=envelope@test.invalid','commit','-q','-m','baseline'],{cwd:project});
  const handlers=new Map(),tools=new Map(),commands=new Map(),notices=[],spawned=[];
  const pi={cwd:project,logger:{warn(){}},on(name,fn){handlers.set(name,[...(handlers.get(name)||[]),fn]);},
    registerTool(tool){assert.ok(!tools.has(tool.name),`duplicate ${tool.name}`);tools.set(tool.name,tool);},
    registerCommand(name,command){commands.set(name,command);},
    async exec(cmd,args,opts){
      spawned.push({cmd,args,opts});
      if(cmd==='git'){
        try {const {stdout,stderr}=await executeGit('git',args,{cwd:opts.cwd,signal:opts.signal,encoding:'utf8',maxBuffer:4_000_000});return {code:0,stdout,stderr};}
        catch(err){return {code:typeof err.code==='number'?err.code:1,stdout:err.stdout||'',stderr:err.stderr||String(err),killed:err.killed===true};}
      }
      assert.equal(cmd,'pi');
      return runner?runner(cmd,args,opts):{code:0,stdout:'Verified 8 tests; created source file',stderr:''};
    }
  };
  const ext=registerEnvelope(pi,{home:join(root,'state')});
  const ctx={cwd:project,sessionManager:{getSessionId:()=> 'session-1'},ui:{notify:(text,level)=>notices.push({text,level})}};
  const call=(name,args={},context=ctx,signal)=>tools.get(name).execute('test-call',args,signal,undefined,context);
  const command=args=>commands.get('envelope').handler(args,ctx);
  return {root,project,pi,tools,handlers,notices,spawned,ext,ctx,call,command};
}
function obj(result){assert.equal(result.isError,false,result.content[0].text);return JSON.parse(result.content[0].text);}

test('registers one native workflow surface, retaining one output/context hook and no competing shell hook',t=>{
  const h=fixture(t);
  for(const name of ['create','status','claim','finish','review','retry','events','run']) assert.ok(h.tools.has(`envelope_workflow_${name}`),name);
  assert.equal(h.handlers.get('context').length,1);
  assert.equal(h.handlers.get('tool_result').length,1);
  assert.equal(h.handlers.get('tool_call').length,1); // opt-in only
});

test('creates project-scoped DAG and transitions manual claims through review with event evidence',async t=>{
  const h=fixture(t);
  const {workflowId}=obj(await h.call('envelope_workflow_create',plan));
  const status=obj(await h.call('envelope_workflow_status',{workflowId}));
  assert.deepEqual(status.ready,['first']);
  assert.equal(Object.hasOwn(status.tasks[0],'instructions'),false,'status must not flood model context with full task prompts');
  assert.match(status.tasks[0].instructionsPreview,/Implement module/);
  const claimed=obj(await h.call('envelope_workflow_claim',{workflowId,worker:'manual-agent'}));
  assert.equal(claimed.id,'first');
  obj(await h.call('envelope_workflow_finish',{workflowId,taskId:'first',token:claimed.token,outcome:'review',summary:'Ran tests'}));
  assert.deepEqual(obj(await h.call('envelope_workflow_status',{workflowId})).ready,[]);
  obj(await h.call('envelope_workflow_review',{workflowId,taskId:'first',outcome:'completed',evidence:'Verified diff and tests'}));
  assert.deepEqual(obj(await h.call('envelope_workflow_status',{workflowId})).ready,['second']);
  assert.ok(obj(await h.call('envelope_workflow_events',{workflowId})).some(e=>e.type==='review'));
  assert.equal((await h.call('envelope_workflow_status',{workflowId}, {...h.ctx,cwd:join(h.root,'elsewhere')})).isError,true);
});

test('one-shot child is disabled by default and explicit /envelope workflow run on persists opt-in',async t=>{
  const h=fixture(t);
  const {workflowId}=obj(await h.call('envelope_workflow_create',{name:'Single',tasks:[plan.tasks[0]]}));
  const denied=await h.call('envelope_workflow_run',{workflowId});
  assert.equal(denied.isError,true);
  assert.equal(h.spawned.filter(x=>x.cmd==='pi').length,0);
  assert.equal(obj(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'pending');
  await h.command('workflow run on');
  const config=JSON.parse(readFileSync(join(h.root,'state','settings.json'),'utf8'));
  assert.equal(config.envelope.workflow.runEnabled,true);
  assert.equal(config.envelope.code.enabled,true);
  const running=obj(await h.call('envelope_workflow_run',{workflowId}));
  assert.equal(running.status,'review');
  assert.equal(h.spawned.filter(x=>x.cmd==='pi').length,1);
  assert.equal(h.spawned.find(x=>x.cmd==='pi').cmd,'pi');
  assert.deepEqual(h.spawned.find(x=>x.cmd==='pi').args.slice(0,3),['--print','--no-session','--no-mcp']);
  assert.ok(h.spawned.find(x=>x.cmd==='pi').args.includes('--exclude-tools'));
  assert.ok(h.spawned.find(x=>x.cmd==='pi').args.includes('envelope_workflow_*'),'child must not recursively delegate workflow');
  assert.notEqual(h.spawned.find(x=>x.cmd==='pi').opts.cwd,h.project);
  assert.ok(h.spawned.find(x=>x.cmd==='pi').opts.signal instanceof AbortSignal);
  assert.ok(h.spawned.find(x=>x.cmd==='pi').args.some(v=>v.includes('Implement module')));
  assert.equal(obj(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'review');
  assert.ok(running.outputId);
  const exact=await h.call('envelope_recall_output',{id:running.outputId});
  assert.equal(exact.isError,false);
  assert.match(exact.content[0].text,/Verified 8 tests/);
  assert.deepEqual(obj(await h.call('envelope_workflow_status',{workflowId})).ready,[]);
});

test('nonzero child exit is recorded as failed and cannot run again without explicit retry',async t=>{
  const h=fixture(t,async()=>({code:7,stdout:'Tests failed',stderr:'build failure'}));
  const {workflowId}=obj(await h.call('envelope_workflow_create',{name:'Bad build',tasks:[plan.tasks[0]]}));
  await h.command('workflow run on');
  const result=await h.call('envelope_workflow_run',{workflowId});
  assert.equal(result.isError,true);
  assert.equal(obj(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'failed');
  assert.equal((await h.call('envelope_workflow_run',{workflowId})).isError,true);
  assert.equal(h.spawned.filter(x=>x.cmd==='pi').length,1);
  obj(await h.call('envelope_workflow_retry',{workflowId,taskId:'first'}));
  assert.equal(obj(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'pending');
});

test('child spawn errors record a failed task and a concurrent second run never launches another child',async t=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve});
  const h=fixture(t,async()=>pending);
  const {workflowId}=obj(await h.call('envelope_workflow_create',{name:'Race',tasks:[plan.tasks[0]]}));
  await h.command('workflow run on');
  const first=h.call('envelope_workflow_run',{workflowId});
  for(let i=0;i<100&&!h.spawned.some(x=>x.cmd==='pi');i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(h.spawned.some(x=>x.cmd==='pi'),'first child reached Pi after Git worktree setup');
  const second=await h.call('envelope_workflow_run',{workflowId});
  assert.equal(second.isError,true);
  assert.equal(h.spawned.filter(x=>x.cmd==='pi').length,1);
  release({code:0,stdout:'Success',stderr:''});
  assert.equal((await first).isError,false);
  const next=obj(await h.call('envelope_workflow_create',{name:'Other',tasks:[plan.tasks[0]]}));
  h.pi.exec=async()=>{throw new Error('No executable on PATH')};
  const spawn=await h.call('envelope_workflow_run',{workflowId:next.workflowId});
  assert.equal(spawn.isError,true);
  assert.equal(obj(await h.call('envelope_workflow_status',{workflowId:next.workflowId})).tasks[0].status,'pending');
});

test('workflow settings are independent and host shutdown closes the ledger',async t=>{
  const h=fixture(t);
  const created=obj(await h.call('envelope_workflow_create',{name:'Persist',tasks:[plan.tasks[0]]}));
  await h.command('workflow off');
  assert.equal((await h.call('envelope_workflow_create',plan)).isError,true);
  assert.equal(obj(await h.call('envelope_workflow_status',{workflowId:created.workflowId})).workflow.id,created.workflowId);
  await h.command('workflow on');
  await h.handlers.get('session_shutdown')[0]();
  const response=await h.call('envelope_workflow_create',plan);
  assert.equal(response.isError,true);
});

test('cancelled execution does not claim a task and oversized child output cannot mark review',async t=>{
  const h=fixture(t,async()=>({code:0,stdout:'x'.repeat(2_000_000),stderr:''}));
  const {workflowId}=obj(await h.call('envelope_workflow_create',{name:'Bounded',tasks:[plan.tasks[0]]}));
  await h.command('workflow run on');
  const ctrl=new AbortController();ctrl.abort();
  assert.equal((await h.call('envelope_workflow_run',{workflowId},h.ctx,ctrl.signal)).isError,true);
  assert.equal(h.spawned.filter(x=>x.cmd==='pi').length,0);
  const outcome=await h.call('envelope_workflow_run',{workflowId});
  assert.equal(outcome.isError,true);
  assert.equal(h.spawned.filter(x=>x.cmd==='pi').length,1);
  assert.equal(obj(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'failed');
});

test('killed child with exit code zero is not accepted as a successful submission',async t=>{
  const h=fixture(t,async()=>({code:0,killed:true,stdout:'worker was stopped',stderr:''}));
  const {workflowId}=obj(await h.call('envelope_workflow_create',{name:'Kill',tasks:[plan.tasks[0]]}));
  await h.command('workflow run on');
  const result=await h.call('envelope_workflow_run',{workflowId});
  assert.equal(result.isError,true);
  assert.equal(obj(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'failed');
});
