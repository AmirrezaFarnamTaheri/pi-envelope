/** Offline cosine retrieval over explicitly user-provided, source-hash-bound vectors. */
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {retrieveCodeEvidence} from './code-retrieval.mjs';
const MAX_BYTES=1024*1024,MAX_ROWS=256,MAX_VERIFY_BYTES=16*1024*1024;
const SHA=/^[0-9a-f]{64}$/;
const hash=x=>createHash('sha256').update(x).digest('hex');
const inside=(root,p)=>root===p||p.startsWith(root+sep);
const bound=(value,fallback,min,max,name)=>{const n=value===undefined?fallback:value;if(!Number.isInteger(n)||n<min||n>max)throw new RangeError(name+' must be '+min+'..'+max);return n;};
const bytes=x=>Buffer.byteLength(JSON.stringify(x),'utf8');
function checkedVector(value,dim,label){
 if(!Array.isArray(value)||value.length!==dim)throw new TypeError(label+' dimension mismatch');
 let sum=0;
 for(const x of value){if(typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>1_000_000)throw new TypeError(label+' vector must contain finite bounded numbers');sum+=x*x;}
 if(!Number.isFinite(sum)||sum<=1e-20)throw new TypeError(label+' zero or invalid norm');
 return Math.sqrt(sum);
}
function artifact(index){
 const root=realpathSync(index.root);
 if(root!==index.root)throw new Error('project root changed');
 const dir=join(root,'.envelope'),file=join(dir,'embeddings.json');
 let ds,fs;
 try{ds=lstatSync(dir);fs=lstatSync(file);}catch(err){if(err?.code==='ENOENT')throw new Error('local embeddings manifest missing; no automatic download');throw err;}
 if(!ds.isDirectory()||ds.isSymbolicLink()||!fs.isFile()||fs.isSymbolicLink()||fs.size>MAX_BYTES||fs.size<20)
   throw new Error('unsafe or oversized embedding artifact');
 if(!inside(root,realpathSync(file)))throw new Error('unsafe embedding artifact outside project');
 let raw=readFileSync(file,'utf8'),data;
 try{data=JSON.parse(raw);}catch{throw new Error('invalid embedding manifest JSON');}
 if(data?.schema!==1||typeof data.model!=='string'||data.model.length<1||data.model.length>100||/[\u0000-\u001f]/.test(data.model)||
  !Number.isInteger(data.dimensions)||data.dimensions<8||data.dimensions>1024||!Array.isArray(data.entries)||data.entries.length>MAX_ROWS)
   throw new Error('invalid embedding manifest schema or limits');
 return {root,data,manifestHash:hash(raw)};
}
export function searchLocalVectors(index,{queryVector,query,limit=8,offset=0,ifVersion,maxChars=3000}={}){
 if(!index?.files||!index.checkedPath)throw new TypeError('current CodeIndex required');
 limit=bound(limit,8,1,15,'limit');offset=bound(offset,0,0,256,'offset');maxChars=bound(maxChars,3000,900,16000,'maxChars');
 if(query!==undefined&&(typeof query!=='string'||!query.trim()||query.length>160))throw new TypeError('invalid lexical query');
 const {root,data,manifestHash}=artifact(index),dim=data.dimensions;
 const queryNorm=checkedVector(queryVector,dim,'query');
 const lex=query?retrieveCodeEvidence(index,{query,limit:20,includeSnippet:false}):null;
 const lexRanks=new Map((lex?.results||[]).map((x,i)=>[x.path,i+1]));
 let scanned=0,skippedStale=0;
 const rows=[],seen=new Set();
 for(const item of data.entries){
   if(!item||typeof item.path!=='string'||!item.path||item.path.length>256||item.path.startsWith('/')||item.path.split('/').some(p=>p==='..'||p==='.')||!SHA.test(item.sha256||''))throw new Error('invalid embedding row path/hash');
   const norm=checkedVector(item.vector,dim,'manifest');
   if(seen.has(item.path))throw new Error('duplicate embedding file path');seen.add(item.path);
   const record=index.files.get(item.path);
   if(!record||record.contentSha256!==item.sha256){skippedStale++;continue;}
   const key=index.checkedPath(item.path);if(key!==item.path)throw new Error('noncanonical embedding source path');
   const filename=resolve(root,key),stat=lstatSync(filename),canonical=realpathSync(filename);
   if(!inside(root,filename)||!inside(root,canonical)||stat.isSymbolicLink()||!stat.isFile())throw new Error('unsafe embedding source symlink');
   scanned+=stat.size;if(scanned>MAX_VERIFY_BYTES)throw new RangeError('embedding source verification byte budget exceeded');
   if(hash(readFileSync(filename))!==record.contentSha256)throw new Error('source changed since CodeIndex refresh; vector retrieval rejected');
   const dot=queryVector.reduce((acc,n,i)=>acc+n*item.vector[i],0);
   const cosine=Math.max(-1,Math.min(1,dot/(queryNorm*norm)));
   const lexicalRank=lexRanks.get(key)||null;
   const hybrid=query?0.7*((cosine+1)/2)+0.3*(lexicalRank?1/lexicalRank:0):cosine;
   rows.push({path:key,cosine:Math.round(cosine*1_000_000)/1_000_000,
      ...(query?{lexicalRank}:{}),score:Math.round(hybrid*1_000_000)/1_000_000,
      sourceSha256:record.contentSha256});
 }
 rows.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));
 const version=hash(JSON.stringify({manifestHash,queryVector,query,src:[...index.files].map(([p,r])=>[p,r.contentSha256]).sort()}));
 if(offset>0&&(ifVersion!==version))throw new Error('stale or missing vector comparison version cursor');
 if(offset>rows.length)throw new RangeError('offset exceeds vector candidates');
 const result={mode:'user-supplied-vector-search',queryMode:query?'weighted-local-hybrid':'vector-only',
   model:data.model,provenance:'external-vectors-with-verified-current-source',externalCalls:0,
   trust:'user-provided-numeric-embeddings-not-verified-semantic-quality',dimensions:dim,
   manifestHash,version,skippedStale,totalCandidates:rows.length,complete:skippedStale===0,
   offset,returned:0,truncated:false,results:[],
   notes:'Uses precomputed externally supplied embeddings. No encoder, network, downloaded model or measured provider tokens; source hashes verify bytes, not semantic relevance.'};
 for(let i=offset;i<rows.length&&result.returned<limit;i++){
   result.results.push(rows[i]);result.returned++;
   if(bytes({...result,truncated:true,nextOffset:i+1})>maxChars){result.results.pop();result.returned--;break;}
 }
 if(offset+result.returned<rows.length){result.truncated=true;result.nextOffset=offset+result.returned;}
 if(bytes(result)>maxChars||(!result.returned&&result.truncated))throw new RangeError('maxChars budget too small for one vector result');
 return result;
}
