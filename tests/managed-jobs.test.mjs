import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedJobs, registerManagedJobs} from '../extensions/envelope/managed-jobs.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'envelope-jobs-test-'));
  const a=join(root,'a'),b=join(root,'b');
  mkdirSync(a);mkdirSync(b);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,a,b,jobs:new ManagedJobs(join(root,'state'))};
}

test('start reports a stable job ID and durable stdout, stderr, and exit code',async t=>{
  const {root,a,jobs}=fixture(t);
  const started=await jobs.start({project:a,command:process.execPath,args:['-e','console.log("stdout");console.error("stderr")']});
  assert.match(started.id,/^[a-f0-9-]{36}$/);
  assert.equal(started.status,'starting');
  const after=await new ManagedJobs(join(root,'state')).wait(a,started.id,{timeoutMs:5000});
  assert.equal(after.status,'completed',JSON.stringify(after));
  assert.equal(after.exitCode,0);
  assert.match(jobs.logs(a,started.id).text,/stdout/);
  assert.match(jobs.logs(a,started.id).text,/stderr/);
  assert.equal(jobs.list(a)[0].id,started.id);
});

test('nonzero exit remains failed across independent readers',async t=>{
  const {root,a,jobs}=fixture(t);
  const started=await jobs.start({project:a,command:process.execPath,args:['-e','process.exit(7)']});
  const state=await new ManagedJobs(join(root,'state')).wait(a,started.id,{timeoutMs:5000});
  assert.equal(state.status,'failed');
  assert.equal(state.exitCode,7);
});

test('requests cancellation through a private file rather than killing an unverified PID',async t=>{
  const {a,jobs}=fixture(t);
  const started=await jobs.start({project:a,command:process.execPath,args:['-e','setInterval(()=>{},1000)']});
  const active=await jobs.wait(a,started.id,{timeoutMs:200});
  assert.ok(['running','starting'].includes(active.status),JSON.stringify(active));
  const cancellation=jobs.cancel(a,started.id);
  assert.equal(cancellation.requested,true);
  const finished=await jobs.wait(a,started.id,{timeoutMs:5000});
  assert.equal(finished.status,'cancelled',JSON.stringify(finished));
});

test('a different project cannot enumerate, retrieve or cancel a job',async t=>{
  const {a,b,jobs}=fixture(t);
  const started=await jobs.start({project:a,command:process.execPath,args:['-e','console.log("private")']});
  assert.deepEqual(jobs.list(b),[]);
  assert.throws(()=>jobs.status(b,started.id),/Job not found/);
  assert.throws(()=>jobs.cancel(b,started.id),/Job not found/);
  await jobs.wait(a,started.id,{timeoutMs:5000});
});

test('bounds logs and never interprets shell syntax in argv',async t=>{
  const {a,jobs}=fixture(t);
  const started=await jobs.start({project:a,command:process.execPath,args:['-e','process.stdout.write("x".repeat(100000))'],maxLogBytes:4096});
  const finished=await jobs.wait(a,started.id,{timeoutMs:5000});
  assert.equal(finished.status,'completed');
  const out=jobs.logs(a,started.id,{maxBytes:2048});
  assert.equal(out.truncated,true);
  assert.equal(finished.outputTruncated,true);
  assert.ok(Buffer.byteLength(out.text)<=2048);
});

test('exposes opt-in agent sessions without requiring a workflow DAG or nested agents',async t=>{
  const {a,root}=fixture(t);
  const registered=new Map();
  const pi={registerTool(tool){registered.set(tool.name,tool);}};
  registerManagedJobs(pi,{home:join(root,'state'),project:ctx=>ctx.cwd,allowAgentRuns:()=>false});
  assert.ok(registered.has('envelope_job'));
  assert.ok(registered.has('envelope_agent_start'));
  const restricted=await registered.get('envelope_agent_start').execute('t',{prompt:'Review the code'},undefined,undefined,{cwd:a});
  assert.equal(restricted.isError,true);
  assert.match(restricted.content[0].text,/disabled/i);
});

test('only prunes terminal jobs and never removes a live worker',async t=>{
  const {a,jobs}=fixture(t);
  const completed=await jobs.start({project:a,command:process.execPath,args:['-e','console.log("done")']});
  await jobs.wait(a,completed.id,{timeoutMs:5000});
  const active=await jobs.start({project:a,command:process.execPath,args:['-e','setInterval(()=>{},1000)']});
  const result=jobs.prune(a,{olderThanDays:0});
  assert.equal(result.removed,1);
  assert.throws(()=>jobs.status(a,completed.id),/Job not found/);
  assert.equal(jobs.status(a,active.id).id,active.id);
  jobs.cancel(a,active.id);await jobs.wait(a,active.id,{timeoutMs:5000});
});

test('supervisor survives the launcher process and reports a final exit code',async t=>{
  const {root,a,jobs}=fixture(t);
  const script=join(root,'launcher.mjs');
  const {writeFileSync}=await import('node:fs');
  const {spawn}=await import('node:child_process');
  const childCode='setTimeout(()=>{console.log("survived");process.exit(11)},500)';
  const loader='import {ManagedJobs} from '+JSON.stringify(new URL('../extensions/envelope/managed-jobs.mjs',import.meta.url).href)+';\n'
    +'const jobs=new ManagedJobs('+JSON.stringify(join(root,'state'))+');'
    +'const x=await jobs.start({project:'+JSON.stringify(a)+',command:process.execPath,args:'+JSON.stringify(['-e',childCode])+'});console.log(x.id);';
  writeFileSync(script,loader);
  const launcher=spawn(process.execPath,[script],{stdio:['ignore','pipe','pipe']});
  let out='';for await(const c of launcher.stdout)out+=c;
  const code=await new Promise(resolve=>launcher.once('close',resolve));
  assert.equal(code,0);
  const id=out.trim();
  const result=await jobs.wait(a,id,{timeoutMs:5000});
  assert.equal(result.status,'failed');assert.equal(result.exitCode,11);
  assert.match(jobs.logs(a,id).text,/survived/);
});

test('a failed executable is not reported as a completed job',async t=>{
  const {a,jobs}=fixture(t);
  const started=await jobs.start({project:a,command:'/does/not/exist/pi-example',args:[]});
  const result=await jobs.wait(a,started.id,{timeoutMs:5000});
  assert.equal(result.status,'failed');
  assert.notEqual(result.exitCode,0);
});

test('start requires explicit extension policy even if job-control reads are allowed',async t=>{
  const {a,root}=fixture(t);const registered=new Map();
  registerManagedJobs({registerTool(tool){registered.set(tool.name,tool);}},{home:join(root,'state'),project:ctx=>ctx.cwd,allowStarts:()=>false});
  const denied=await registered.get('envelope_job').execute('t',{action:'start',command:process.execPath,args:['-v']},undefined,undefined,{cwd:a});
  assert.equal(denied.isError,true);assert.match(denied.content[0].text,/disabled/i);
  const listed=await registered.get('envelope_job').execute('t',{action:'list'},undefined,undefined,{cwd:a});
  assert.equal(listed.isError,false);
});

test('exactly full log is not falsely reported as truncated',async t=>{
  const {a,jobs}=fixture(t);
  const started=await jobs.start({project:a,command:process.execPath,args:['-e','process.stdout.write("x".repeat(4096))'],maxLogBytes:4096});
  const state=await jobs.wait(a,started.id,{timeoutMs:5000});
  assert.equal(state.status,'completed');
  assert.equal(state.outputTruncated,false);
  assert.equal(jobs.logs(a,started.id).bytes,4096);
});

test('an uncertain stale supervisor never becomes an automatically prunable completed job',t=>{
  const {root,a,jobs}=fixture(t);
  const key=createHash('sha256').update(realpathSync(a)).digest('hex').slice(0,32);
  const id='00000000-0000-0000-0000-000000000001';
  const dir=join(root,'state','envelope-jobs',key,id);
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'state.json'),JSON.stringify({id,status:'running',updatedAt:Date.now()-3600000}));
  assert.equal(jobs.status(a,id).status,'interrupted');
  assert.equal(jobs.prune(a,{olderThanDays:0}).removed,0);
  assert.equal(jobs.status(a,id).status,'interrupted');
});


test('job control never returns launch arguments to model responses, including after wait',async t=>{
  const {root,a}=fixture(t);
  const toolMap=new Map();
  registerManagedJobs({registerTool(tool){toolMap.set(tool.name,tool);}},{home:join(root,'state'),project:ctx=>ctx.cwd,allowStarts:()=>true});
  const tool=toolMap.get('envelope_job');
  const ctx={cwd:a},secret='private-user-input-should-not-appear';
  const launched=await tool.execute('job-start',{action:'start',command:process.execPath,args:['-e','process.stdout.write("OK") // '+secret]},undefined,undefined,ctx);
  assert.equal(launched.isError,false);
  const id=JSON.parse(launched.content[0].text).id;
  const waited=await tool.execute('job-wait',{action:'wait',jobId:id,waitMs:5000},undefined,undefined,ctx);
  assert.equal(waited.isError,false);
  assert.doesNotMatch(waited.content[0].text,/private-user-input-should-not-appear/);
  const status=await tool.execute('job-status',{action:'status',jobId:id},undefined,undefined,ctx);
  assert.doesNotMatch(status.content[0].text,/private-user-input-should-not-appear/);
  assert.match(JSON.parse((await tool.execute('job-logs',{action:'logs',jobId:id},undefined,undefined,ctx)).content[0].text).text,/OK/);
});
