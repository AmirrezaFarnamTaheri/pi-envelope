/** Bounded, read-only historical co-change evidence from the current Git root.
 * Git co-occurrence is not a static/runtime dependency or code ownership proof.
 */
import {spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
const SHA=/^[a-f0-9]{40}$/;
const HIST_MAX=100,MAX_BYTES=512_000,MAX_FILES_PER_COMMIT=40;
const bounded=(value,fallback,min,max,label)=>{
  if(value===undefined)return fallback;
  if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`${label} must be ${min}..${max}`);
  return value;
};
function git(root,args){
  const result=spawnSync('git',['-c','color.ui=false',...args],{cwd:root,encoding:'utf8',timeout:4000,maxBuffer:MAX_BYTES});
  if(result.error||result.signal||result.status!==0||result.stdout.length>=MAX_BYTES)return null;
  return result.stdout;
}
function readHistory(index,maxCommits){
  const root=index.root;
  const top=git(root,['rev-parse','--show-toplevel']);
  if(!top||realpathSync(resolve(top.trim()))!==root)return {available:false,reason:'git-not-at-project-root'};
  // A sentinel prevents ambiguous file names being interpreted as commits.
  const lines=git(root,['log','--no-merges','--no-renames',`--max-count=${maxCommits+1}`,'--format=ENVELOPE_REV:%H','--name-only','--']);
  if(lines===null)return {available:false,reason:'git-log-unavailable-or-over-budget'};
  const revisions=[];let current=null;
  for(const line of lines.split(/\r?\n/)){
    if(line.startsWith('ENVELOPE_REV:')){
      const sha=line.slice('ENVELOPE_REV:'.length);
      if(!SHA.test(sha))return {available:false,reason:'unexpected-git-log-format'};
      current={sha,paths:new Set()};revisions.push(current);
    }else if(line&&current&&index.files.has(line))current.paths.add(line);
  }
  const windowLimited=revisions.length>maxCommits;
  const selected=revisions.slice(0,maxCommits),commitOmitted=[];
  const valid=[];
  for(const commit of selected){
    if(commit.paths.size>MAX_FILES_PER_COMMIT){commitOmitted.push(commit.sha);continue;}
    valid.push(commit);
  }
  const reasons=[];
  if(windowLimited)reasons.push('history-window-limit');
  if(commitOmitted.length)reasons.push('large-commit-omitted');
  return {available:true,revisions:valid,commitCount:selected.length,omittedLargeCommits:commitOmitted.length,
    complete:reasons.length===0,reasons};
}
/** Inspect only the already-refreshed shared CodeIndex and bounded Git metadata. */
export function inspectCodeHistory(index,args={}){
  if(!index?.files||typeof index.checkedPath!=='function')throw new TypeError('current CodeIndex required');
  if(!args||typeof args!=='object'||Array.isArray(args))throw new TypeError('history query object required');
  const action=args.action??'status';
  if(!['status','cochange','churn'].includes(action))throw new TypeError('history action must be status, cochange, or churn');
  const maxCommits=bounded(args.maxCommits,60,1,HIST_MAX,'maxCommits');
  const limit=bounded(args.limit,12,1,20,'limit');
  const data=readHistory(index,maxCommits);
  if(!data.available)return {action,available:false,complete:false,reason:data.reason,
    mode:'historical-cochange-not-causal-dependency',maxCommits};
  const general={action,available:true,mode:'historical-cochange-not-causal-dependency',commitCount:data.commitCount,
    maxCommits,omittedLargeCommits:data.omittedLargeCommits,complete:data.complete,reasons:data.reasons};
  if(action==='status')return {...general,indexedFiles:index.files.size,distinctChangedFiles:new Set(data.revisions.flatMap(c=>[...c.paths])).size};
  if(action==='churn'){
    const counts=new Map();
    for(const c of data.revisions)for(const path of c.paths)counts.set(path,(counts.get(path)||0)+1);
    const files=[...counts.entries()].map(([path,commits])=>({path,commits}))
      .sort((a,b)=>b.commits-a.commits||a.path.localeCompare(b.path));
    return {...general,total:files.length,truncated:files.length>limit,files:files.slice(0,limit)};
  }
  const path=index.checkedPath(args.path);
  const paired=new Map();let sourceCommits=0;
  for(const c of data.revisions){
    if(!c.paths.has(path))continue;
    sourceCommits++;
    for(const other of c.paths){if(other!==path)paired.set(other,(paired.get(other)||0)+1);}
  }
  const related=[...paired.entries()].map(([path,sharedCommits])=>({path,sharedCommits,
    withinSourceHistoryRatio:sourceCommits?Number((sharedCommits/sourceCommits).toFixed(3)):0}))
    .sort((a,b)=>b.sharedCommits-a.sharedCommits||a.path.localeCompare(b.path));
  return {...general,path,sourceCommits,total:related.length,truncated:related.length>limit,related:related.slice(0,limit)};
}
