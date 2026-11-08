/**
 * Native Git worktree adapter. A worktree isolates Git state and working files,
 * not process permissions or filesystem access outside the worktree.
 * All Git calls use direct argv via the Pi host runner, never a shell.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const FILE_LIMIT = 5_000_000;
const UNTRACKED_TOTAL_LIMIT = 10_000_000;
const DIFF_LIMIT = 2_000_000;
const MAX_UNTRACKED = 100;
const MAX_CHANGED = 500;
const hash = v => createHash('sha256').update(v).digest('hex');

function mustText(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new TypeError(`${name} must be nonempty text`);
  return v;
}
function ensureId(v, re, what) {
  if (typeof v !== 'string' || !re.test(v)) throw new TypeError(`invalid ${what}`);
  return v;
}
function gitError(args, value) {
  const error = String(value?.stderr || value?.stdout || `exit ${value?.code}`);
  return new Error(`Git ${args[0]} failed: ${error.slice(0,300).trim()}`);
}
async function git(exec, cwd, args, signal) {
  if (signal?.aborted) throw new Error('Git operation aborted');
  if (typeof exec !== 'function') throw new TypeError('Git runner unavailable');
  const result = await exec('git', args, {cwd,signal});
  if (result?.code !== 0 || result?.killed === true) throw gitError(args,result);
  if (typeof result.stdout !== 'string') throw new Error('Git runner returned no text stdout');
  return result.stdout;
}
function canonical(path) {return realpathSync(resolve(mustText(path,'project')));}
function checkedPath(root, candidate) {
  const target = resolve(root,candidate);
  if (!target.startsWith(root+sep)) throw new Error('untracked file escapes worktree');
  const info=lstatSync(target);
  if (!info.isFile()) throw new Error(`Untracked file is a symbolic link or unsupported file: ${candidate}`);
  return {target,info};
}
function paths(stdout) {return stdout.split('\0').filter(Boolean).sort();}

/** Reject dirty/non-root Git checkouts before allocating a task claim. */
export async function preflightWorktree({exec,project,signal}) {
  const cwd=canonical(project);
  const top=(await git(exec,cwd,['rev-parse','--show-toplevel'],signal)).trim();
  if (canonical(top)!==cwd) throw new Error('Isolated worker requires the Git repository root');
  const head=(await git(exec,cwd,['rev-parse','--verify','HEAD'],signal)).trim();
  if (!SHA.test(head)) throw new Error('Git HEAD is missing or invalid');
  const dirty=await git(exec,cwd,['status','--porcelain=v1','--untracked-files=all'],signal);
  if (dirty.length) throw new Error('Isolated worker requires a clean Git working tree (including untracked files)');
  return {project:cwd,baseHead:head};
}

/** Leaves the created worktree intact even if later execution fails. */
export async function prepareWorktree({exec,project,home,workflowId,taskId,attempt,signal,preflight}) {
  ensureId(workflowId,UUID,'workflow ID');
  ensureId(taskId,TASK,'task ID');
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1_000_000) throw new TypeError('invalid task attempt');
  const {project:cwd,baseHead}=preflight??await preflightWorktree({exec,project,signal});
  if(canonical(project)!==cwd) throw new Error('Preflight project changed');
  if(!SHA.test(baseHead)) throw new Error('Invalid pinned HEAD');
  // Validate that the base commit is unchanged in the parent between preflight and creation.
  const freshHead=(await git(exec,cwd,['rev-parse','--verify','HEAD'],signal)).trim();
  if(freshHead!==baseHead) throw new Error('Project HEAD changed after worktree preflight');
  const clean=await git(exec,cwd,['status','--porcelain=v1','--untracked-files=all'],signal);
  if(clean.length) throw new Error('Project became dirty after worktree preflight; a clean Git working tree is required');
  const root=resolve(mustText(home,'home'));
  const bucket=hash(cwd).slice(0,24);
  const path=join(root,'envelope-workflows','worktrees',bucket,workflowId,`${taskId}-a${attempt}`);
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  // Never replace a previous attempt (including a dangling symlink).
  try {lstatSync(path);throw new Error('Worktree path already exists; collision, refusing overwrite');}
  catch(err) {if(err.code!=='ENOENT') throw err;}
  await git(exec,cwd,['worktree','add','--detach',path,baseHead],signal);
  if (canonical(path)!==resolve(path)) throw new Error('Git worktree resolved to a symbolic link');
  return {path,baseHead};
}

/** Stable content fingerprint used to detect a stale or tampered handoff. */
export async function captureHandoff({exec,workspace,baseHead,signal}) {
  if(!SHA.test(baseHead)) throw new TypeError('Invalid handoff base HEAD');
  const cwd=canonical(workspace);
  if(cwd!==resolve(workspace)) throw new Error('Worktree path is a symbolic link');
  const top=(await git(exec,cwd,['rev-parse','--show-toplevel'],signal)).trim();
  if(canonical(top)!==cwd) throw new Error('Worktree path is no longer the Git repository root');
  const head=(await git(exec,cwd,['rev-parse','--verify','HEAD'],signal)).trim();
  if(head!==baseHead) throw new Error('Child changed Git HEAD or made a commit; handoff rejected');
  const changedTracked=paths(await git(exec,cwd,['diff','--name-only','-z','HEAD'],signal));
  const untracked=paths(await git(exec,cwd,['ls-files','--others','--exclude-standard','-z'],signal));
  const changedFiles=[...new Set([...changedTracked,...untracked])].sort();
  if(changedFiles.length>MAX_CHANGED) throw new Error(`Too many changed files for a handoff (${MAX_CHANGED} limit)`);
  if(untracked.length>MAX_UNTRACKED) throw new Error(`Too many untracked files for a handoff (${MAX_UNTRACKED} limit)`);
  const patch=await git(exec,cwd,['diff','--binary','HEAD'],signal);
  if(Buffer.byteLength(patch)>DIFF_LIMIT) throw new Error('Tracked diff exceeds handoff capture limit');
  const trackedDiffHash=hash(patch),untrackedHashes=Object.create(null);
  let total=0;
  for(const name of untracked){
    const {target,info}=checkedPath(cwd,name);
    total+=info.size;
    if(info.size>FILE_LIMIT || total>UNTRACKED_TOTAL_LIMIT) throw new Error('Untracked file too large for verified handoff limit');
    untrackedHashes[name]=hash(readFileSync(target));
  }
  const fingerprint=hash(JSON.stringify({baseHead,head,changedFiles,trackedDiffHash,untrackedHashes}));
  return {path:cwd,baseHead,head,changedFiles,fingerprint,trackedDiffHash,untrackedHashes};
}
