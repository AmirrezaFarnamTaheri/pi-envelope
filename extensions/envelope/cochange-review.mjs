/** Bounded read-only historic co-change review on the existing CodeIndex.
 * A missing direct import is NOT evidence that there is no dependency.
 * No model, semantic index, author/ownership inference, or risk score.
 */
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {inspectCodeHistory} from './code-history.mjs';

const SHA=/^[0-9a-f]{64}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const length=obj=>Buffer.byteLength(JSON.stringify(obj),'utf8');
const inside=(root,path)=>root===path||path.startsWith(root+sep);
function integer(value,fallback,min,max,name){
 if(value===undefined)return fallback;
 if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(name+' must be '+min+'..'+max);
 return value;
}
function verify(index,root,path){
 const key=index.checkedPath(path),record=index.files?.get(key);
 if(!record||!SHA.test(record.contentSha256||''))throw new Error('source not indexed with a SHA-256');
 const target=resolve(root,key);
 if(!inside(root,target))throw new Error('unsafe source outside project');
 const stat=lstatSync(target),resolved=realpathSync(target);
 if(!stat.isFile()||stat.isSymbolicLink()||!inside(root,resolved))throw new Error('unsafe symlink or non-file source');
 if(stat.size>500_000)throw new RangeError('co-change source verification byte limit exceeded');
 if(hash(readFileSync(target))!==record.contentSha256)throw new Error('source changed since CodeIndex refresh; retry after reindex');
 return key;
}
export function inspectCochangeCoupling(index,{path,maxCommits=60,minShared=2,
 includeDirect=false,limit=8,offset=0,ifVersion,maxChars=3000}={}){
 if(!index?.files||typeof index.checkedPath!=='function'||typeof index.root!=='string')throw new TypeError('current CodeIndex required');
 if(typeof includeDirect!=='boolean')throw new TypeError('includeDirect must be boolean');
 maxCommits=integer(maxCommits,60,1,100,'maxCommits');
 minShared=integer(minShared,2,1,20,'minShared');
 limit=integer(limit,8,1,10,'limit');
 offset=integer(offset,0,0,20,'offset');
 maxChars=integer(maxChars,3000,900,16000,'maxChars');
 const root=realpathSync(index.root);
 if(root!==index.root)throw new Error('project root changed');
 const source=verify(index,root,path);
 const history=inspectCodeHistory(index,{action:'cochange',path:source,maxCommits,limit:20});
 if(!history.available)return {mode:'advisory-historical-cochange-with-static-import-context',available:false,
   complete:false,reason:history.reason,source,notes:'No Git history signal is available; never infer absence of change coupling.'};
 const candidates=[];
 for(const other of history.related){
   if(other.sharedCommits<minShared)continue;
   verify(index,root,other.path);
   const direct=index.edges?.get(source)?.has(other.path)===true||index.edges?.get(other.path)?.has(source)===true;
   if(direct&&!includeDirect)continue;
   candidates.push({path:other.path,sharedCommits:other.sharedCommits,
     withinSourceHistoryRatio:other.withinSourceHistoryRatio,
     directStaticImport:direct?'detected':'not-detected',
     reviewHint:direct?'cochange-with-direct-static-import':'cochange-without-direct-static-import'});
 }
 const version=hash(JSON.stringify({source,sha:index.files.get(source).contentSha256,
   revision:index.lastRevision??null,maxCommits,minShared,includeDirect,
   neighbors:[...(index.edges?.get(source)||[])].sort(),
   candidates}));
 if(offset>0&&(typeof ifVersion!=='string'||version!==ifVersion))
   throw new Error('stale or missing co-change result version cursor; restart at offset 0');
 if(offset>candidates.length)throw new RangeError('offset exceeds reported co-change candidates');
 const reasons=[...(history.reasons??[])];
 if(history.truncated)reasons.push('top-20-related-file-window');
 if(index.lastRefresh?.unavailable?.length)reasons.push('parser-unavailable');
 const report={mode:'advisory-historical-cochange-with-static-import-context',available:true,
   provenance:'bounded-git-cochange-and-source-verified-static-imports',source,
   maxCommits,commitCount:history.commitCount,sourceCommits:history.sourceCommits,
   inspectedRelated:history.related.length,totalRelatedInHistory:history.total,
   minShared,includeDirect,version,totalCandidates:candidates.length,offset,returned:0,
   truncated:false,complete:reasons.length===0,reasons:[...new Set(reasons)],items:[],
   notes:'Co-edits are not causal dependencies, architecture defects or ownership proof. No detected direct static import does not imply no runtime/indirect link; the review hint is not a numeric risk score.'};
 for(let i=offset;i<candidates.length&&report.returned<limit;i++){
   const item=candidates[i],next={...report,items:[...report.items,item],returned:report.returned+1};
   const more=i+1<candidates.length;
   if(more){next.truncated=true;next.complete=false;next.reasons=[...next.reasons,'result-budget-or-limit'];next.nextOffset=i+1;}
   if(length(next)>maxChars){
     if(report.returned===0)throw new RangeError('maxChars budget too small for one verified co-change item');
     break;
   }
   report.items.push(item);report.returned++;
 }
 if(offset+report.returned<candidates.length){
   report.truncated=true;report.nextOffset=offset+report.returned;
   report.complete=false;report.reasons.push('result-budget-or-limit');
 }
 if(length(report)>maxChars)throw new RangeError('maxChars budget too small for co-change response');
 return report;
}
