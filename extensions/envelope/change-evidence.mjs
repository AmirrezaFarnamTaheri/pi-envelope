/** Commit-pinned, read-only change-impact evidence over the existing CodeIndex.
 * A clean checkout of the exact head is required: index facts are never labeled
 * as evidence from a different commit or dirty working tree. */
import { spawnSync } from 'node:child_process';
import { extname, posix } from 'node:path';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_CHANGED = 200;
const MAX_DIFF_BUFFER = 2_000_000;
const CODE_SUFFIX = new Set(['.js','.jsx','.mjs','.cjs','.ts','.tsx','.mts','.cts','.py','.pyi','.go']);

function runGit(root,args){
  const result=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:7_000,maxBuffer:MAX_DIFF_BUFFER,windowsHide:true});
  if(result.error||result.status!==0)throw new Error(`Git evidence unavailable: ${result.error?.message||result.stderr?.slice(0,220)||'operation failed'}`);
  return result.stdout;
}
function resolveRevision(root,value){
  if(!SHA.test(value))throw new TypeError('commit revision must be a pinned 40- or 64-character lowercase SHA');
  let revision;
  try {revision=runGit(root,['rev-parse','--verify','--end-of-options',`${value}^{commit}`]).trim();}
  catch {throw new Error('Invalid or unknown pinned commit revision');}
  if(revision!==value)throw new Error('commit revision is not the exact pinned commit');
  return revision;
}
function statusName(raw){
  const kind=raw[0];
  return ({A:'added',M:'modified',D:'deleted',R:'renamed',C:'copied',T:'type-changed',U:'unmerged'})[kind]||'unknown';
}
function changedFiles(output){
  const tokens=output.split('\0').filter((_,i,a)=>i<a.length-1 || a[i]!==''), rows=[];
  for(let i=0;i<tokens.length && rows.length<=MAX_CHANGED;){
    const marker=tokens[i++];
    if(!/^[ACDMRTUXB][0-9]*$/.test(marker))throw new Error('unrecognized Git change-status output');
    const dual=/^[RC]/.test(marker);
    const previousPath=dual?tokens[i++]:undefined;
    const path=tokens[i++];
    if(typeof path!=='string'||path===''||(dual&&typeof previousPath!=='string'))throw new Error('incomplete Git diff path list');
    rows.push({path,status:statusName(marker),...(previousPath?{previousPath}:{})});
  }
  return rows;
}
function getNewLineRanges(root,base,head,path){
  const patch=runGit(root,['diff','--no-ext-diff','--no-textconv','--unified=0',base,head,'--',path]);
  const ranges=[];
  for(const line of patch.split('\n')){
    const match=/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if(!match)continue;
    const start=Number(match[1]),count=match[2]===undefined?1:Number(match[2]);
    if(count&&ranges.length<15)ranges.push({start,end:start+count-1});
  }
  return ranges;
}
function importImpact(index,changedPaths,limit,depth=3){
  const distance=new Map();
  const queue=[...changedPaths].filter(path=>index.files.has(path)).map(path=>({path,distance:0,via:path}));
  const seen=new Set(queue.map(x=>x.path));
  while(queue.length){
    const current=queue.shift();
    if(current.distance>=depth)continue;
    for(const importer of [...(index.importers.get(current.path)||[])].sort()){
      if(seen.has(importer))continue;
      seen.add(importer);
      distance.set(importer,{path:importer,distance:current.distance+1,via:current.path});
      queue.push({path:importer,distance:current.distance+1,via:current.path});
    }
  }
  const all=[...distance.values()].sort((a,b)=>a.distance-b.distance||a.path.localeCompare(b.path));
  return {all,limited:all.slice(0,limit)};
}
function likelyTests(index,changedPaths,impact){
  const names=new Set([...changedPaths,...impact].map(path=>posix.basename(path).replace(/\.(?:test|spec)(?=\.)/,'').replace(/\.[^.]+$/,'')));
  return [...index.files.keys()]
    .filter(path=>/\.(?:test|spec)\.[^.]+$/.test(path) || /(?:^|\/)test_[^/]+\.py$/.test(path)||/_(?:test)\.go$/.test(path))
    .filter(path=>names.has(posix.basename(path).replace(/\.(?:test|spec)(?=\.)/,'').replace(/\.[^.]+$/,'').replace(/^test_/,'').replace(/_test$/,'')))
    .sort().slice(0,25).map(path=>({path,reason:'filename-heuristic-not-test-coverage'}));
}

export function analyzeChangeImpact(index,{base,head,limit=15}={}){
  if(!index?.root || !index?.files || !index?.importers)throw new TypeError('a refreshed CodeIndex is required');
  if(!Number.isInteger(limit)||limit<1||limit>25)throw new RangeError('limit must be 1..25');
  const root=index.root;
  const current=runGit(root,['rev-parse','--verify','HEAD^{commit}']).trim();
  if(!SHA.test(current))throw new Error('HEAD is not a full Git commit');
  const atHead=head===undefined?current:resolveRevision(root,head);
  if(atHead!==current)throw new Error('Requested head does not match the current HEAD; checkout the pinned commit first');
  const baseSha=resolveRevision(root,base);
  const dirty=runGit(root,['status','--porcelain=v1','-z','--untracked-files=all']);
  if(dirty)throw new Error('A clean working tree is required for commit-pinned change evidence (uncommitted changes found)');
  if(index.lastRevision!==current)index.refresh();
  const changedAll=changedFiles(runGit(root,['diff','--no-ext-diff','--no-textconv','--find-renames','--name-status','-z',baseSha,atHead]));
  const truncated=changedAll.length>MAX_CHANGED;
  const changed=changedAll.slice(0,MAX_CHANGED).map(item=>{
    const indexed=index.files.has(item.path);
    const record=index.files.get(item.path);
    return {...item,indexed,language:record?.language??null,
      contentSha256:record?.contentSha256??null,
      lineRanges: indexed && item.status!=='deleted' ? getNewLineRanges(root,baseSha,atHead,item.path):[]};
  });
  const known=changed.filter(x=>x.indexed).map(x=>x.path);
  const impact=importImpact(index,known,limit);
  const incompleteReasons=[];
  if(truncated)incompleteReasons.push('changed-path-limit');
  if(changed.some(x=>!x.indexed&&CODE_SUFFIX.has(extname(x.path).toLowerCase())))incompleteReasons.push('deleted-or-unindexed-source');
  if(changed.some(x=>x.status==='renamed'||x.status==='deleted'||x.status==='type-changed'))incompleteReasons.push('old-revision-imports-not-reconstructed');
  if((index.lastRefresh?.unavailable||[]).length)incompleteReasons.push('optional-parsers-unavailable');
  if(changed.some(x=>x.indexed&&index.files.get(x.path)?.diagnostics?.length))incompleteReasons.push('syntax-errors');
  const candidates=likelyTests(index,known,impact.all.map(x=>x.path));
  return {
    base:baseSha,head:atHead,mode:'git-commit-pinned-static-impact',complete:incompleteReasons.length===0,
    incompleteReasons,changed,changedPathsTotal:changedAll.length,
    impacted:impact.limited,totalImpacted:impact.all.length,impactedTruncated:impact.all.length>limit,
    candidateTests:candidates,
    unresolvedCallSites:index.lastRefresh?.unresolvedCalls??null,
    notes:'Git head and clean checkout verified. Import edges are static candidates; filename-based test matches are NOT coverage, and unresolved dynamic calls are NOT safe absence evidence.'
  };
}
