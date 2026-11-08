/**
 * Local, source-verified, symbol-and-path rank fusion over the existing CodeIndex.
 * The code index owns source evidence. No embeddings, external services,
 * project code execution, vector DB, or independent index state.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const CANDIDATE_BUDGET=300;
const VERIFIED_BYTE_BUDGET=3_000_000;
const sha256=text=>createHash('sha256').update(text).digest('hex');
const normalized=text=>String(text).normalize('NFD').replace(/\p{M}/gu,'').replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu,'$1 $2')
  .replace(/[^\p{L}\p{N}]+/gu,' ').toLowerCase().trim();
function tokens(text){return [...new Set(normalized(text).split(' ').filter(Boolean))];}
function bounded(value,fallback,min,max,name){
 if(value===undefined)return fallback;
 if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`${name} must be ${min}..${max}`);
 return value;
}
function excerpt(source,line){
 const lines=source.split(/\r?\n/);
 const start=Math.max(0,(line||1)-2);
 const value=lines.slice(start,Math.min(lines.length,start+7)).join('\n');
 const points=Array.from(value);
 return {snippet:points.slice(0,450).join(''),snippetTruncated:points.length>450,snippetStartLine:start+1};
}
/** Every returned result is checked against an exact original-source hash. */
export function retrieveCodeEvidence(index,{query,limit=10,includeSnippet=false}={}){
 if(!index?.files||typeof index.checkedPath!=='function')throw new TypeError('current CodeIndex required');
 if(typeof query!=='string'||!query.trim()||Array.from(query).length>120)throw new TypeError('query must be nonempty and within 120 characters');
 limit=bounded(limit,10,1,25,'limit');
 if(typeof includeSnippet!=='boolean')throw new TypeError('includeSnippet must be boolean');
 const rawTerms=tokens(query);if(!rawTerms.length)throw new TypeError('query must include searchable terms');
 const searchTerms=rawTerms.slice(0,8);
 const partialReasons=[];if(rawTerms.length>8)partialReasons.push('query-term-limit');
 if(index.lastRefresh?.unavailable?.length)partialReasons.push('parser-unavailable');
 if(index.files.size>=index.maxFiles)partialReasons.push('index-file-limit-possibly-reached');
 const candidates=[];
 for(const [path,record] of index.files){
   const pathTerms=new Set(tokens(path));
   const pathMatched=searchTerms.filter(t=>pathTerms.has(t)).length;
   let bestSymbol=null,bestScore=0;
   const symbols=record.symbols||[];
   for(const symbol of symbols){
     const symbolTerms=new Set(tokens(symbol.name));
     const matched=searchTerms.filter(t=>symbolTerms.has(t)).length;
     if(!matched)continue;
     const exact=normalized(symbol.name)===normalized(query);
     const score=matched*12+(exact?40:0)+(matched===searchTerms.length?15:0);
     if(score>bestScore||(score===bestScore && (!bestSymbol||symbol.line<bestSymbol.line))){
       bestSymbol={name:symbol.name,kind:symbol.kind,line:symbol.line};bestScore=score;
     }
   }
   if(!pathMatched&&!bestSymbol)continue;
   const combined=new Set([...pathTerms,...(bestSymbol?tokens(bestSymbol.name):[])]);
   candidates.push({path,record,bestSymbol,symbolScore:bestScore,pathScore:pathMatched*14,
     termCoverage:searchTerms.filter(t=>combined.has(t)).length,
     incoming:index.importers.get(path)?.size||0});
 }
 const sortRank=(a,b,key)=>b[key]-a[key]||b.termCoverage-a.termCoverage||a.path.localeCompare(b.path);
 const symbolRank=new Map([...candidates].sort((a,b)=>sortRank(a,b,'symbolScore')).map((x,i)=>[x.path,i+1]));
 const pathRank=new Map([...candidates].sort((a,b)=>sortRank(a,b,'pathScore')).map((x,i)=>[x.path,i+1]));
 for(const c of candidates){
  c.rank=1/(60+symbolRank.get(c.path))+1/(60+pathRank.get(c.path));
 }
 candidates.sort((a,b)=>b.termCoverage-a.termCoverage||b.rank-a.rank||b.symbolScore-a.symbolScore||a.path.localeCompare(b.path));
 const candidateLimited=candidates.length>CANDIDATE_BUDGET;
 if(candidateLimited)partialReasons.push('candidate-budget');
 const results=[];let skippedUnverified=0,verifiedBytes=0,verificationLimited=false;
 for(const c of candidates.slice(0,CANDIDATE_BUDGET)){
  if(results.length>=limit)break;
  let canonical;
  try{canonical=index.checkedPath(c.path);}catch{skippedUnverified++;continue;}
  if(canonical!==c.path){skippedUnverified++;continue;}
  let source;
  try{source=readFileSync(join(index.root,c.path),'utf8');}catch{skippedUnverified++;continue;}
  verifiedBytes+=Buffer.byteLength(source);
  if(verifiedBytes>VERIFIED_BYTE_BUDGET){verificationLimited=true;break;}
  if(!c.record.contentSha256||sha256(source)!==c.record.contentSha256){skippedUnverified++;continue;}
  const incoming=[...(index.importers.get(c.path)||[])].sort();
  const related=incoming.slice(0,3);
  results.push({path:c.path,sha256:c.record.contentSha256,language:c.record.language,
    bestSymbol:c.bestSymbol,termCoverage:c.termCoverage,importedBy:related,
    importerCount:incoming.length,rank:Number(c.rank.toFixed(6)),
    evidence:'indexed-source-hash-verified',...(includeSnippet?excerpt(source,c.bestSymbol?.line):{})});
 }
 if(skippedUnverified)partialReasons.push('unverified-source-skipped');
 if(verificationLimited)partialReasons.push('source-verification-budget');
 const truncated=results.length<Math.max(0,candidates.length-skippedUnverified);
 if(truncated)partialReasons.push('result-limit');
 return {mode:'local-symbol-and-path-rank-fusion',terms:searchTerms,queryTermsLimited:rawTerms.length>8,
  externalProvidersUsed:false,scannedIndexedFiles:index.files.size,candidates:candidates.length,
  skippedUnverified,verifiedBytes,truncated,complete:partialReasons.length===0,reasons:[...new Set(partialReasons)],results,
  note:'Lexical declarations and file paths from current AST index; importedBy is static evidence, not semantic/runtype proof.'};
}
