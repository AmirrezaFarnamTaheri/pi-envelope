/**
 * Operator-only, reproducible evaluation harness for an installed local encoder.
 * This is a benchmark runner, NOT evidence that a specific model was measured:
 * the executable and any held-out corpus must be supplied by the operator.
 * Never downloads models, sends provider requests, or stores source in Envelope.
 */
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {LocalEmbeddingRuntime} from '../extensions/envelope/local-embedding-runtime.mjs';
import {retrieveCodeEvidence} from '../extensions/envelope/code-retrieval.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const safePath=p=>typeof p==='string'&&p.length>=7&&p.length<=240&&
  /^src\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(p)&&
  p.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.startsWith('.'));
const round=n=>Number(n.toFixed(6));
/** Compute hit@k, recall@k and reciprocal rank from ordered, independently labeled paths. */
export function measureRanks(ranked,relevant,k){
 if(!Array.isArray(ranked)||!Array.isArray(relevant)||!relevant.length||
    !Number.isInteger(k)||k<1||k>8)throw new TypeError('valid ranked paths, relevance labels and k=1..8 required');
 const top=ranked.slice(0,k),truth=new Set(relevant);
 const first=top.findIndex(path=>truth.has(path));
 const matched=new Set(top.filter(path=>truth.has(path)));
 return {hit:first<0?0:1,recall:matched.size/truth.size,reciprocalRank:first<0?0:1/(first+1)};
}
/** Validate a bounded, independently labeled corpus before creating temporary files. */
function parseDataset(datasetPath){
 if(typeof datasetPath!=='string'||!isAbsolute(datasetPath))throw new Error('absolute dataset path required');
 const stat=lstatSync(datasetPath);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<20||stat.size>500_000)
   throw new Error('unsafe or oversized semantic benchmark dataset');
 const bytes=readFileSync(datasetPath);
 let data;
 try{data=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('invalid benchmark JSON dataset');}
 if(data?.schema!==1||!Array.isArray(data.documents)||data.documents.length<2||data.documents.length>32||
    !Array.isArray(data.queries)||data.queries.length<1||data.queries.length>32)
   throw new Error('benchmark requires schema 1, 2..32 documents and 1..32 queries');
 const paths=new Set();
 for(const doc of data.documents){
   if(!safePath(doc?.path)||paths.has(doc.path)||typeof doc.content!=='string'||
      !doc.content.trim()||doc.content.length>6000||Buffer.byteLength(doc.content)>12000)
     throw new Error('unsafe or duplicate benchmark document path or contents');
   paths.add(doc.path);
 }
 const ids=new Set();
 for(const q of data.queries){
   if(typeof q?.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(q.id)||ids.has(q.id)||
      typeof q.text!=='string'||!q.text.trim()||q.text.length>120||
      !/[a-zA-Z0-9]/.test(q.text)||!Array.isArray(q.relevant)||!q.relevant.length||
      q.relevant.length>data.documents.length||new Set(q.relevant).size!==q.relevant.length||
      q.relevant.some(path=>!paths.has(path)))
     throw new Error('invalid query or unknown relevant source path in benchmark labels');
   ids.add(q.id);
 }
 return {data,datasetSha256:sha(bytes)};
}
/** Evaluate vector-only, source-verified hybrid and lexical baselines on identical labels.
 * No source text, query text, input vectors or child stderr is returned.
 */
export async function runSemanticBenchmark({datasetPath,encoderPath,topK=5,timeoutMs=30000}={}){
 if(!Number.isInteger(topK)||topK<1||topK>8)throw new RangeError('topK must be 1..8');
 if(!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>120000)throw new RangeError('timeoutMs must be 50..120000');
 if(typeof encoderPath!=='string'||!isAbsolute(encoderPath))throw new Error('absolute operator-pinned encoder required');
 const {data,datasetSha256}=parseDataset(datasetPath);
 const temp=realpathSync(mkdtempSync(join(tmpdir(),'envelope-semantic-benchmark-')));
 const runtime=new LocalEmbeddingRuntime();
 try{
   for(const doc of data.documents){
     const relativeDir=dirname(doc.path),parts=relativeDir.split('/');
     let directory=temp;
     for(const part of parts){directory=join(directory,part);mkdirSync(directory,{recursive:true,mode:0o700});}
     writeFileSync(join(temp,doc.path),doc.content,{flag:'wx',mode:0o600});
   }
   const index=new CodeIndex(temp,{ts,maxFiles:65,maxBytesPerFile:12_000});
   index.refresh();
   if(index.files.size!==data.documents.length)throw new Error('incomplete benchmark index; no quality result available');
   const buildStarted=performance.now();
   const built=await runtime.build(index,{executable:encoderPath,timeoutMs});
   const buildMs=performance.now()-buildStarted;
   const observed={vector:[],hybrid:[],lexical:[]},queryDurations=[],individual=[];
   for(const q of data.queries){
     const started=performance.now();
     const results=await runtime.find(index,{executable:encoderPath,query:q.text,
       timeoutMs,compare:true});
     const queryMs=performance.now()-started;
     const lexical=retrieveCodeEvidence(index,{query:q.text,limit:topK,includeSnippet:false});
     const ranked={
       vector:results.vector.results.slice(0,topK).map(row=>row.path),
       hybrid:results.hybrid.results.slice(0,topK).map(row=>row.path),
       lexical:lexical.results.slice(0,topK).map(row=>row.path)
     };
     const quality={};
     for(const key of Object.keys(ranked)){
       quality[key]=measureRanks(ranked[key],q.relevant,topK);
       observed[key].push(quality[key]);
     }
     queryDurations.push(queryMs);
     individual.push({id:q.id,labels:q.relevant.length,...quality});
   }
   const average=(rows,key)=>round(rows.reduce((sum,row)=>sum+row[key],0)/rows.length);
   const measures={};
   for(const [key,rows] of Object.entries(observed)){
     measures[key]={hitRate:average(rows,'hit'),meanRecall:average(rows,'recall'),
       meanReciprocalRank:average(rows,'reciprocalRank')};
   }
   const times=[...queryDurations].sort((a,b)=>a-b);
   const percentile=p=>round(times[Math.ceil(p*times.length)-1]);
   return {schema:1,kind:'operator-supplied-offline-retrieval-evaluation',
     datasetSha256,documentCount:data.documents.length,queryCount:data.queries.length,
     model:built.model,dimensions:built.dimensions,topK,
     encoderInvocations:1+data.queries.length,sourceBodyReturned:false,
     modelQualityVerified:false,modelProvenance:'self-reported-by-operator-pinned-binary',
     latencyMs:{build:round(buildMs),queryP50:percentile(.5),queryP95:percentile(.95)},
     results:measures,queries:individual,
     notes:'This is measurement infrastructure. A fixture encoder or self-declared model name is not an independent semantic-model benchmark; use a real, pinned model and held-out labeled corpus, plus reproducible hardware/model provenance, before making quality claims.'};
 }finally{
   runtime.close();
   rmSync(temp,{recursive:true,force:true});
 }
}
/** Parse an explicit command; no implicit model selection, automatic download or provider call. */
function cliOptions(args){
 const fields={};
 for(let i=0;i<args.length;i+=2){
   const flag=args[i],value=args[i+1];
   if(!value||!['--dataset','--encoder','--k','--timeout-ms'].includes(flag)||fields[flag]!==undefined)
     throw new Error('Usage: npm run benchmark:semantic -- --dataset /absolute/corpus.json --encoder /absolute/trusted-executable [--k 5] [--timeout-ms 30000]');
   fields[flag]=value;
 }
 return {datasetPath:fields['--dataset'],encoderPath:fields['--encoder'],
   ...(fields['--k']!==undefined?{topK:Number(fields['--k'])}:{}),
   ...(fields['--timeout-ms']!==undefined?{timeoutMs:Number(fields['--timeout-ms'])}:{})};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 runSemanticBenchmark(cliOptions(process.argv.slice(2))).then(result=>{
   process.stdout.write(JSON.stringify(result,null,2)+'\n');
 },error=>{
   process.stderr.write('Semantic benchmark refused: '+String(error.message||'unknown').slice(0,200)+'\n');
   process.exitCode=1;
 });
}
