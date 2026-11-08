import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { prepareWorktree, preflightWorktree, captureHandoff } from '../extensions/envelope/worktree-adapter.mjs';

const run = promisify(execFile);
async function runner(file,args,options){
  assert.equal(file,'git','adapter must call git by argv, never a shell');
  try {const {stdout,stderr}=await run(file,args,{cwd:options?.cwd,signal:options?.signal,encoding:'utf8',maxBuffer:4_000_000});return {code:0,stdout,stderr};}
  catch(err){return {code:typeof err.code==='number'?err.code:1,stdout:err.stdout??'',stderr:err.stderr??String(err),killed:err.killed===true};}
}
function git(cwd,...args){return execFileSync('git',args,{cwd,encoding:'utf8'}).trim();}
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'envelope-worktree-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const project=join(root,'project'),home=join(root,'state');
  mkdirSync(project);mkdirSync(home);
  git(project,'init','-q');git(project,'config','user.name','Test');git(project,'config','user.email','test@example.invalid');
  writeFileSync(join(project,'module.js'),'export const answer = 41;\n');
  git(project,'add','module.js');git(project,'commit','-q','-m','Initial');
  const workflowId='10000000-0000-4000-8000-000000000000';
  const make=(attempt=1)=>prepareWorktree({exec:runner,project,home,workflowId,taskId:'first',attempt});
  return {root,project,home,workflowId,make};
}

test('isolates a clean Git project at pinned HEAD, leaving parent unchanged and preventing collision overwrite',async t=>{
  const f=fixture(t);const initial=git(f.project,'rev-parse','HEAD');
  const ws=await f.make();
  assert.equal(ws.baseHead,initial);
  assert.equal(git(ws.path,'rev-parse','HEAD'),initial);
  assert.equal(git(ws.path,'rev-parse','--abbrev-ref','HEAD'),'HEAD');
  assert.match(ws.path,/worktrees/);
  writeFileSync(join(ws.path,'module.js'),'export const answer = 42;\n');
  assert.match(readFileSync(join(f.project,'module.js'),'utf8'),/41/);
  await assert.rejects(f.make(),/exists|collision|already/i);
  assert.equal(readFileSync(join(ws.path,'module.js'),'utf8'),'export const answer = 42;\n');
});

test('rejects dirty, non-Git, and nested-working-directory project before creating a worktree',async t=>{
  const f=fixture(t);
  writeFileSync(join(f.project,'extra.txt'),'pending');
  await assert.rejects(f.make(),/clean|uncommitted|untracked/i);
  rmSync(join(f.project,'extra.txt'));
  const nested=join(f.project,'sub');mkdirSync(nested);
  await assert.rejects(prepareWorktree({exec:runner,project:nested,home:f.home,workflowId:f.workflowId,taskId:'first',attempt:1}),/root/i);
  const empty=join(f.root,'not-git');mkdirSync(empty);
  await assert.rejects(prepareWorktree({exec:runner,project:empty,home:f.home,workflowId:f.workflowId,taskId:'first',attempt:1}),/git|repository/i);
});

test('fingerprint detects staged, unstaged and untracked bytes, and is stable while unchanged',async t=>{
  const f=fixture(t);const ws=await f.make();
  writeFileSync(join(ws.path,'module.js'),'export const answer = 43;\n');
  git(ws.path,'add','module.js');
  writeFileSync(join(ws.path,'module.js'),'export const answer = 44;\n');
  writeFileSync(join(ws.path,'new.js'),'export const extra = 1;\n');
  const a=await captureHandoff({exec:runner,workspace:ws.path,baseHead:ws.baseHead});
  const b=await captureHandoff({exec:runner,workspace:ws.path,baseHead:ws.baseHead});
  assert.equal(a.fingerprint,b.fingerprint);
  assert.deepEqual(a.changedFiles,['module.js','new.js']);
  assert.match(a.trackedDiffHash,/^[0-9a-f]{64}$/);
  assert.match(a.untrackedHashes['new.js'],/^[0-9a-f]{64}$/);
  assert.equal(a.baseHead,ws.baseHead);
  writeFileSync(join(ws.path,'new.js'),'export const extra = 2;\n');
  const c=await captureHandoff({exec:runner,workspace:ws.path,baseHead:ws.baseHead});
  assert.notEqual(c.fingerprint,a.fingerprint,'untracked bytes are bound to fingerprint');
  writeFileSync(join(ws.path,'module.js'),'export const answer = 45;\n');
  const d=await captureHandoff({exec:runner,workspace:ws.path,baseHead:ws.baseHead});
  assert.notEqual(d.fingerprint,c.fingerprint,'tracked diff is bound to fingerprint');
});

test('retains attempt worktrees separately and rejects changed HEAD, symlinks or oversized untracked assets',async t=>{
  const f=fixture(t);const first=await f.make(1),second=await f.make(2);
  assert.notEqual(first.path,second.path);
  assert.equal(git(first.path,'rev-parse','HEAD'),git(second.path,'rev-parse','HEAD'));
  symlinkSync(join(f.root,'other'),join(second.path,'link'));
  await assert.rejects(captureHandoff({exec:runner,workspace:second.path,baseHead:second.baseHead}),/symbolic link|symlink/i);
  rmSync(join(second.path,'link'));
  writeFileSync(join(second.path,'huge.bin'),Buffer.alloc(6_000_000));
  await assert.rejects(captureHandoff({exec:runner,workspace:second.path,baseHead:second.baseHead}),/large|limit/i);
  rmSync(join(second.path,'huge.bin'));
  git(second.path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-q','-m','Unwanted commit');
  await assert.rejects(captureHandoff({exec:runner,workspace:second.path,baseHead:second.baseHead}),/HEAD|commit/i);
});


test('refuses to create a worktree if parent becomes dirty between preflight and Git add',async t=>{
  const f=fixture(t);const checked=await preflightWorktree({exec:runner,project:f.project});
  writeFileSync(join(f.project,'late.txt'),'created after preflight');
  await assert.rejects(prepareWorktree({exec:runner,project:f.project,home:f.home,workflowId:f.workflowId,taskId:'first',attempt:1,preflight:checked}),/clean|dirty|untracked/i);
});

test('untracked Git filename __proto__ is included in content hashes rather than inherited from an object prototype',async t=>{
  const f=fixture(t);const ws=await f.make();
  writeFileSync(join(ws.path,'__proto__'),'must not skip hashing');
  const handoff=await captureHandoff({exec:runner,workspace:ws.path,baseHead:ws.baseHead});
  assert.deepEqual(handoff.changedFiles,['__proto__']);
  assert.equal(Object.hasOwn(handoff.untrackedHashes,'__proto__'),true);
  assert.match(handoff.untrackedHashes['__proto__'],/^[0-9a-f]{64}$/);
});
