import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerEnvelope from '../extensions/envelope/index.mjs';

const execute=promisify(execFile);
function git(cwd,...argv){return execFileSync('git',argv,{cwd,encoding:'utf8'}).trim();}
const single={name:'Release',tasks:[{id:'implement',title:'Implement tested change',instructions:'Update source and tests'}]};
function fixture(t,{run,dirty=false}={}){
  const root=mkdtempSync(join(tmpdir(),'envelope-isolated-api-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const project=join(root,'source');mkdirSync(project);
  git(project,'init','-q');git(project,'config','user.name','Test');git(project,'config','user.email','test@example.invalid');
  writeFileSync(join(project,'code.js'),'export const number = 1;\n');
  git(project,'add','code.js');git(project,'commit','-q','-m','baseline');
  if(dirty) writeFileSync(join(project,'dirty.txt'),'not committed\n');
  const commands=new Map(),tools=new Map(),hooks=new Map(),spawned=[];
  const pi={cwd:project,logger:{warn(){}},on(event,fn){hooks.set(event,[...(hooks.get(event)||[]),fn]);},
    registerTool(tool){assert.equal(tools.has(tool.name),false,`duplicate ${tool.name}`);tools.set(tool.name,tool);},
    registerCommand(name,details){commands.set(name,details);},
    async exec(file,args,options){
      spawned.push({file,args,options});
      if(file==='pi') return run ? run({cwd:options.cwd,args}) : {code:0,stdout:'worker complete',stderr:''};
      assert.equal(file,'git');
      try {const {stdout,stderr}=await execute(file,args,{cwd:options.cwd,signal:options.signal,encoding:'utf8',maxBuffer:4_000_000});return {code:0,stdout,stderr};}
      catch(error){return {code:typeof error.code==='number'?error.code:1,stdout:error.stdout||'',stderr:error.stderr||String(error),killed:error.killed===true};}
    }
  };
  const ext=registerEnvelope(pi,{home:join(root,'state')});
  t.after(()=>ext.close());
  const ctx={cwd:project,sessionManager:{getSessionId:()=> 'isolation-session'},ui:{notify(){}}};
  const call=(tool,p={},signal)=>tools.get(tool).execute('call',p,signal,undefined,ctx);
  const command=async(p)=>commands.get('envelope').handler(p,ctx);
  const parse=(r)=>{assert.equal(r.isError,false,r.content[0].text);return JSON.parse(r.content[0].text)};
  return {root,project,tools,hooks,spawned,call,command,parse};
}

test('isolated run is default, child edits only detached worktree, and handoff is durable and reviewable',async t=>{
  const h=fixture(t,{run:async({cwd})=>{
    assert.notEqual(cwd,h.project);
    assert.equal(git(cwd,'rev-parse','--abbrev-ref','HEAD'),'HEAD');
    writeFileSync(join(cwd,'code.js'),'export const number = 2;\n');
    writeFileSync(join(cwd,'test.txt'),'new test\n');
    return {code:0,stdout:'PASS: 10 tests',stderr:''};
  }});
  const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  const result=h.parse(await h.call('envelope_workflow_run',{workflowId}));
  assert.equal(result.status,'review');
  assert.equal(result.isolated,true);
  assert.notEqual(result.workspace,h.project);
  assert.match(readFileSync(join(h.project,'code.js'),'utf8'),/number = 1/);
  const saved=h.parse(await h.call('envelope_workflow_handoff',{workflowId,taskId:'implement'}));
  assert.equal(saved.workspace,result.workspace);
  assert.equal(saved.outputId,result.outputId);
  assert.match(saved.fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(saved.changedFiles,['code.js','test.txt']);
  assert.equal(h.hooks.get('context').length,1);
  assert.equal(h.hooks.get('tool_result').length,1);
  assert.equal(h.hooks.get('tool_call').length,1); // inert unless code guard enabled
  assert.ok(h.spawned.some(row=>row.file==='git'&&row.args.includes('worktree')));
  const approved=h.parse(await h.call('envelope_workflow_review',{workflowId,taskId:'implement',outcome:'completed',evidence:'Independently checked changes and test output'}));
  assert.equal(approved.status,'completed');
  const audit=h.parse(await h.call('envelope_workflow_events',{workflowId}));
  assert.ok(audit.some(row=>row.type==='handoff'));
});

test('review rejects content changed after handoff; restores successful review only on exact match',async t=>{
  const h=fixture(t,{run:async({cwd})=>{writeFileSync(join(cwd,'code.js'),'export const number = 2;\n');return {code:0,stdout:'Done',stderr:''}}});
  const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  const run=h.parse(await h.call('envelope_workflow_run',{workflowId}));
  writeFileSync(join(run.workspace,'code.js'),'export const number = 3;\n');
  const rejected=await h.call('envelope_workflow_review',{workflowId,taskId:'implement',outcome:'completed',evidence:'Stale approval'});
  assert.equal(rejected.isError,true);
  assert.match(rejected.content[0].text,/changed|fingerprint|stale/i);
  assert.equal(h.parse(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'review');
  writeFileSync(join(run.workspace,'code.js'),'export const number = 2;\n');
  const approved=h.parse(await h.call('envelope_workflow_review',{workflowId,taskId:'implement',outcome:'completed',evidence:'Reviewed current exact bytes'}));
  assert.equal(approved.status,'completed');
});

test('dirty parent preflight fails without claiming or launching Pi',async t=>{
  const h=fixture(t,{dirty:true});const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  const result=await h.call('envelope_workflow_run',{workflowId});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/clean/i);
  assert.ok(h.spawned.every(row=>row.file==='git'));
  assert.equal(h.parse(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'pending');
});

test('failed child retains worktree, leaves auditable handoff when capturable, and requires explicit retry',async t=>{
  const h=fixture(t,{run:async({cwd})=>{writeFileSync(join(cwd,'code.js'),'broken');return {code:1,stdout:'Fail',stderr:'Syntax error'}}});
  const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  const failed=await h.call('envelope_workflow_run',{workflowId});
  assert.equal(failed.isError,true);
  const result=JSON.parse(failed.content[0].text);
  assert.equal(result.status,'failed');
  assert.match(readFileSync(join(result.workspace,'code.js'),'utf8'),/broken/);
  const handoff=h.parse(await h.call('envelope_workflow_handoff',{workflowId,taskId:'implement'}));
  assert.equal(handoff.workspace,result.workspace);
  h.parse(await h.call('envelope_workflow_retry',{workflowId,taskId:'implement'}));
  assert.equal(h.parse(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'pending');
});

test('retired shared-tree execution mode is rejected before a task is claimed',async t=>{
  const h=fixture(t,{dirty:true});
  const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  const res=await h.call('envelope_workflow_run',{workflowId,isolated:false});
  assert.equal(res.isError,true);
  assert.match(res.content[0].text,/unsupported|removed|worktree|isolation/i);
  assert.equal(h.spawned.length,0);
  assert.equal(h.parse(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'pending');
});

test('child Git commit is rejected despite exit zero and never enters review',async t=>{
  const h=fixture(t,{run:async({cwd})=>{
    writeFileSync(join(cwd,'code.js'),'export const number = 9;\n');
    git(cwd,'add','code.js');git(cwd,'commit','-q','-m','unexpected');
    return {code:0,stdout:'Success',stderr:''};
  }});
  const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  const raw=await h.call('envelope_workflow_run',{workflowId});
  assert.equal(raw.isError,true);
  const result=JSON.parse(raw.content[0].text);
  assert.equal(result.status,'failed');
  assert.ok(result.workspace);
  assert.equal((await h.call('envelope_workflow_handoff',{workflowId,taskId:'implement'})).isError,true);
  assert.equal(h.parse(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'failed');
  assert.match(readFileSync(join(h.project,'code.js'),'utf8'),/number = 1/);
});

test('untracked byte changes and deleted worktrees block completion',async t=>{
  const h=fixture(t,{run:async({cwd})=>{writeFileSync(join(cwd,'fresh.txt'),'original');return {code:0,stdout:'Done',stderr:''}}});
  const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  const result=h.parse(await h.call('envelope_workflow_run',{workflowId}));
  writeFileSync(join(result.workspace,'fresh.txt'),'tampered');
  assert.match((await h.call('envelope_workflow_review',{workflowId,taskId:'implement',outcome:'completed',evidence:'Changed after run'})).content[0].text,/changed|stale/i);
  rmSync(result.workspace,{recursive:true,force:true});
  const missing=await h.call('envelope_workflow_review',{workflowId,taskId:'implement',outcome:'completed',evidence:'Missing workspace'});
  assert.equal(missing.isError,true);
  assert.equal(h.parse(await h.call('envelope_workflow_status',{workflowId})).tasks[0].status,'review');
});

test('retry writes attempt two to a distinct worktree while old failed attempt stays inspectable',async t=>{
  let runs=0;
  const h=fixture(t,{run:async({cwd})=>{
    runs++;
    writeFileSync(join(cwd,'code.js'),`export const number = ${runs+1};\n`);
    return {code:runs===1?1:0,stdout:`attempt ${runs}`,stderr:''};
  }});
  const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  const failed=JSON.parse((await h.call('envelope_workflow_run',{workflowId})).content[0].text);
  assert.equal(failed.status,'failed');
  h.parse(await h.call('envelope_workflow_retry',{workflowId,taskId:'implement'}));
  const passed=h.parse(await h.call('envelope_workflow_run',{workflowId}));
  assert.equal(passed.status,'review');
  assert.notEqual(failed.workspace,passed.workspace);
  assert.equal(readFileSync(join(failed.workspace,'code.js'),'utf8'),'export const number = 2;\n');
  assert.equal(readFileSync(join(passed.workspace,'code.js'),'utf8'),'export const number = 3;\n');
  const handoff=h.parse(await h.call('envelope_workflow_handoff',{workflowId,taskId:'implement'}));
  assert.equal(handoff.attempt,2);
  assert.equal(handoff.workspace,passed.workspace);
});

test('large handoff tool response is bounded while the durable ledger keeps all changed paths',async t=>{
  const h=fixture(t,{run:async({cwd})=>{
    for(let n=0;n<58;n++) writeFileSync(join(cwd,`file-${n.toString().padStart(3,'0')}.txt`),`data ${n}`);
    return {code:0,stdout:'58 fixtures changed',stderr:''};
  }});
  const {workflowId}=h.parse(await h.call('envelope_workflow_create',single));
  await h.command('workflow run on');
  h.parse(await h.call('envelope_workflow_run',{workflowId}));
  const handoff=h.parse(await h.call('envelope_workflow_handoff',{workflowId,taskId:'implement'}));
  assert.equal(handoff.changedFileCount,58);
  assert.ok(handoff.changedFiles.length<=30);
  assert.equal(handoff.changedFilesTruncated,true);
  assert.ok(Object.keys(handoff.untrackedHashes).length<=15);
  assert.equal(handoff.untrackedHashesTruncated,true);
  assert.match(handoff.fingerprint,/^[a-f0-9]{64}$/);
});
