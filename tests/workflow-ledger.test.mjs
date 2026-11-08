import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowLedger } from '../extensions/envelope/workflow-ledger.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'envelope-workflow-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let time=1_800_000_000_000;
  const open=()=>new WorkflowLedger(join(root,'state'),{now:()=>time});
  const ledger=open();
  t.after(()=>ledger.close());
  return {root,ledger,open,advance:(ms)=>{time+=ms}, project:join(root,'repo-a'), other:join(root,'repo-b')};
}
const graph=[
  {id:'spec',title:'Write spec',instructions:'Draft requirements'},
  {id:'code',title:'Build',instructions:'Implement and test',dependsOn:['spec']},
  {id:'docs',title:'Docs',instructions:'Write docs',dependsOn:['spec']},
  {id:'ship',title:'Ship',instructions:'Validate artifacts',dependsOn:['code','docs']}
];

test('validates full DAG before persistence and rejects cycles, duplicates and missing dependency references',t=>{
  const {ledger,project}=fixture(t);
  for(const tasks of [
    [{id:'a',title:'A',instructions:'A',dependsOn:['none']}],
    [{id:'a',title:'A',instructions:'A',dependsOn:['b']},{id:'b',title:'B',instructions:'B',dependsOn:['a']}],
    [{id:'a',title:'A',instructions:'A'},{id:'a',title:'Duplicate',instructions:'Duplicate'}],
    [{id:'a',title:'A',instructions:'A',dependsOn:['a']}]
  ]) assert.throws(()=>ledger.create(project,{name:'invalid',tasks}),/depend|cycle|duplicate/i);
  assert.equal(ledger.status(project).workflow,null);
});

test('creates persistent project-scoped workflow and schedules only unblocked tasks after verified completion',t=>{
  const {ledger,project,other,open,root}=fixture(t);
  const created=ledger.create(project,{name:'Release',tasks:graph});
  assert.match(created.workflowId,/^[a-f\d-]{36}$/);
  assert.equal(statSync(join(root,'state')).mode & 0o777,0o700);
  assert.equal(statSync(join(root,'state','workflow.sqlite')).mode & 0o777,0o600);
  assert.deepEqual(ledger.status(project,created.workflowId).ready,['spec']);
  assert.equal(ledger.status(other,created.workflowId).workflow,null);
  assert.throws(()=>ledger.claim(other,created.workflowId,{worker:'agent-a'}),/unknown workflow/i);
  const task=ledger.claim(project,created.workflowId,{worker:'agent-a'});
  assert.equal(task.id,'spec');
  assert.ok(task.token);
  assert.equal(ledger.claim(project,created.workflowId,{worker:'agent-b'}),null);
  ledger.finish(project,created.workflowId,'spec',{token:task.token,outcome:'review',summary:'Ran tests'});
  assert.deepEqual(ledger.status(project,created.workflowId).ready,[]);
  ledger.review(project,created.workflowId,'spec',{outcome:'completed',evidence:'Test suite passed'});
  assert.deepEqual(ledger.status(project,created.workflowId).ready,['code','docs']);
  const reopened=open();
  try {assert.deepEqual(reopened.status(project,created.workflowId).ready,['code','docs']);}
  finally {reopened.close();}
  const sanitized=ledger.status(project,created.workflowId).tasks[0];
  assert.equal(Object.hasOwn(sanitized,'token'),false);
  assert.equal(sanitized.status,'completed');
});

test('only current lease token can submit results; review cannot be bypassed and retry is explicit',t=>{
  const {ledger,project}=fixture(t);
  const {workflowId}=ledger.create(project,{name:'One',tasks:[graph[0]]});
  assert.throws(()=>ledger.review(project,workflowId,'spec',{outcome:'completed',evidence:'none'}),/review/i);
  const task=ledger.claim(project,workflowId,{worker:'agent'});
  assert.throws(()=>ledger.finish(project,workflowId,'spec',{token:'wrong',outcome:'review',summary:'ok'}),/token|holder/i);
  assert.throws(()=>ledger.finish(project,workflowId,'spec',{token:task.token,outcome:'completed',summary:'ok'}),/outcome/i);
  ledger.finish(project,workflowId,'spec',{token:task.token,outcome:'failed',summary:'tests failed'});
  assert.throws(()=>ledger.finish(project,workflowId,'spec',{token:task.token,outcome:'review',summary:'late'}),/running/i);
  assert.equal(ledger.status(project,workflowId).tasks[0].status,'failed');
  assert.throws(()=>ledger.review(project,workflowId,'spec',{outcome:'completed',evidence:'none'}),/review/i);
  ledger.retry(project,workflowId,'spec');
  assert.equal(ledger.claim(project,workflowId,{worker:'new-agent'}).attempts,2);
});

test('expired leases are interrupted and never automatically stolen or retried',t=>{
  const {ledger,project,advance}=fixture(t);
  const {workflowId}=ledger.create(project,{name:'Recovery',tasks:[graph[0]]});
  const running=ledger.claim(project,workflowId,{worker:'agent',leaseMs:60_000});
  advance(60_001);
  assert.equal(ledger.claim(project,workflowId,{worker:'other'}),null);
  assert.equal(ledger.status(project,workflowId).tasks[0].status,'interrupted');
  assert.throws(()=>ledger.finish(project,workflowId,'spec',{token:running.token,outcome:'review',summary:'stale'}),/running|lease|holder/i);
  ledger.retry(project,workflowId,'spec');
  assert.equal(ledger.claim(project,workflowId,{worker:'other'}).attempts,2);
});

test('two database instances serialize exclusive claims across workflows in a project',t=>{
  const {ledger,open,project}=fixture(t);
  const other=open();t.after(()=>other.close());
  const wf1=ledger.create(project,{name:'First',tasks:[graph[0]]}).workflowId;
  const wf2=other.create(project,{name:'Second',tasks:[{id:'another',title:'Task',instructions:'Do task'}]}).workflowId;
  assert.equal(ledger.claim(project,wf1,{worker:'one'}).id,'spec');
  assert.equal(other.claim(project,wf2,{worker:'two'}),null);
});

test('records bounded, project-isolated audit events and refuses invalid ownership transitions',t=>{
  const {ledger,project,other}=fixture(t);
  const {workflowId}=ledger.create(project,{name:'Audit',tasks:[graph[0]]});
  const task=ledger.claim(project,workflowId,{worker:'worker'});
  ledger.finish(project,workflowId,'spec',{token:task.token,outcome:'review',summary:'Prepared result'});
  ledger.review(project,workflowId,'spec',{outcome:'completed',evidence:'Inspected diff and tests'});
  const events=ledger.events(project,workflowId,{limit:2});
  assert.equal(events.length,2);
  assert.equal(events.at(-1).type,'review');
  assert.deepEqual(ledger.events(other,workflowId),[]);
  assert.throws(()=>ledger.retry(project,workflowId,'spec'),/failed|interrupted/i);
  assert.throws(()=>ledger.claim(project,workflowId,{worker:'!bad'}),/worker/i);
});

test('real paths and symlink aliases share one project ownership scope',t=>{
  const {ledger,root,project}=fixture(t);
  mkdirSync(project);
  const alias=join(root,'alias');symlinkSync(project,alias,'dir');
  const {workflowId}=ledger.create(project,{name:'Alias',tasks:[graph[0]]});
  assert.equal(ledger.status(alias,workflowId).workflow.id,workflowId);
  assert.equal(ledger.claim(alias,workflowId,{worker:'alias-worker'}).id,'spec');
  assert.equal(ledger.claim(project,workflowId,{worker:'true-worker'}),null);
});

function handoff(claim){return {
  token:claim.token,attempt:claim.attempts,workspace:'/tmp/worktree-for-review',
  baseHead:'a'.repeat(40),head:'a'.repeat(40),fingerprint:'b'.repeat(64),
  trackedDiffHash:'c'.repeat(64),changedFiles:['src/app.js'],
  untrackedHashes:{'new-file.js':'d'.repeat(64)},outputId:'e'.repeat(64)
};}

test('durably binds worktree handoffs to a valid running attempt and isolates project scope',t=>{
  const {ledger,project,other,open}=fixture(t);
  const {workflowId}=ledger.create(project,{name:'Handoff',tasks:[graph[0]]});
  const claim=ledger.claim(project,workflowId,{worker:'child'});
  const record=ledger.recordHandoff(project,workflowId,'spec',handoff(claim));
  assert.equal(record.fingerprint,'b'.repeat(64));
  assert.equal(record.attempt,1);
  assert.equal(record.workspace,'/tmp/worktree-for-review');
  assert.deepEqual(record.changedFiles,['src/app.js']);
  assert.equal(ledger.handoff(other,workflowId,'spec'),null);
  const reopened=open();
  try{assert.deepEqual(reopened.handoff(project,workflowId,'spec'),record);}
  finally{reopened.close();}
  assert.ok(ledger.events(project,workflowId).some(e=>e.type==='handoff'));
  ledger.finish(project,workflowId,'spec',{token:claim.token,outcome:'review',summary:'worker finished'});
  assert.equal(ledger.handoff(project,workflowId,'spec').outputId,'e'.repeat(64));
});

test('rejects forged claim token, bad attempts, duplication and non-running handoffs',t=>{
  const {ledger,project}=fixture(t);
  const {workflowId}=ledger.create(project,{name:'Protect',tasks:[graph[0]]});
  const claim=ledger.claim(project,workflowId,{worker:'child'});
  assert.throws(()=>ledger.recordHandoff(project,workflowId,'spec',{...handoff(claim),token:'f'.repeat(36)}),/token/i);
  assert.throws(()=>ledger.recordHandoff(project,workflowId,'spec',{...handoff(claim),attempt:2}),/attempt/i);
  ledger.recordHandoff(project,workflowId,'spec',handoff(claim));
  assert.throws(()=>ledger.recordHandoff(project,workflowId,'spec',handoff(claim)),/already|duplicate/i);
  ledger.finish(project,workflowId,'spec',{token:claim.token,outcome:'failed',summary:'bad build'});
  assert.throws(()=>ledger.recordHandoff(project,workflowId,'spec',handoff(claim)),/running/i);
  ledger.retry(project,workflowId,'spec');
  const second=ledger.claim(project,workflowId,{worker:'other'});
  assert.equal(second.attempts,2);
  assert.equal(ledger.handoff(project,workflowId,'spec').attempt,1,'old evidence remains auditable but not current');
  const next=ledger.recordHandoff(project,workflowId,'spec',{...handoff(second),fingerprint:'f'.repeat(64)});
  assert.equal(next.attempt,2);
  assert.equal(ledger.handoff(project,workflowId,'spec').fingerprint,'f'.repeat(64));
});
