/**
 * Compact, task-anchored source context from the ONE shared CodeIndex.
 * Lexical seed ranking + statically resolved imports only; no semantic search,
 * provider calls, generated summaries, source excerpts or persistent graph.
 */
import {createHash} from 'node:crypto';
import {retrieveCodeEvidence} from './code-retrieval.mjs';
import {projectContextCard} from './context-card.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const MAX_EXPLORED=150;
const ETAG=/^[0-9a-f]{64}$/;
function integer(value,fallback,min,max,name){
  if(value===undefined)return fallback;
  if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(name+' must be '+min+'..'+max);
  return value;
}
function sourcesVersion(index,selector){
  if(!index?.files||!(index.files instanceof Map))throw new TypeError('current CodeIndex required');
  const rows=[];
  for(const [path,record] of [...index.files].sort(([a],[b])=>a.localeCompare(b))){
    if(typeof record?.contentSha256!=='string'||!ETAG.test(record.contentSha256))throw new Error('index has an unverified source SHA');
    const deps=[...(index.edges?.get(path)||[])].sort();
    rows.push([path,record.contentSha256,record.language,deps]);
  }
  return sha(JSON.stringify({selector,rows}));
}
function neighbors(index,path,direction){
  const out=direction==='incoming'?[]:[...(index.edges?.get(path)||[])].sort();
  const inc=direction==='outgoing'?[]:[...(index.importers?.get(path)||[])].sort();
  // Outbound dependencies before importers, to keep a readable graph-first path.
  return [...new Set([...out,...inc])];
}
function boundedGraph(index,seeds,depth,direction){
  const seen=new Set(),queue=[];
  for(const source of seeds){
    if(seen.has(source))continue;
    seen.add(source);queue.push({path:source,distance:0,via:null});
  }
  let hitBudget=false;
  for(let i=0;i<queue.length;i++){
    if(queue[i].distance>=depth)continue;
    for(const path of neighbors(index,queue[i].path,direction)){
      if(seen.has(path)||!index.files.has(path))continue;
      if(queue.length>=MAX_EXPLORED){hitBudget=true;break;}
      seen.add(path);queue.push({path,distance:queue[i].distance+1,via:queue[i].path});
    }
    if(hitBudget)break;
  }
  return {queue,hitBudget};
}
function skeleton(card){
  return {source:card.source,symbols:card.symbols.slice(0,3),
    imports:{incoming:card.imports.totalIncoming,outgoing:card.imports.totalOutgoing},
    calls:{incoming:card.calls.totalIncoming,outgoing:card.calls.totalOutgoing,unresolved:card.calls.totalUnresolved},
    complete:card.complete,reasons:card.reasons};
}
function bytes(value){return Buffer.byteLength(JSON.stringify(value),'utf8');}
/** One-shot context slice; no session handles, no source exposure. */
export function buildContextSlice(index,{query,path,direction='both',depth=1,limit=6,maxChars=4000,
  offset=0,ifVersion,knownEtags=[]}={}){
  if(!index?.files||typeof index.checkedPath!=='function')throw new TypeError('current CodeIndex required');
  const hasQuery=query!==undefined,hasPath=path!==undefined;
  if(hasQuery===hasPath)throw new TypeError('exactly one query or path is required');
  if(!['outgoing','incoming','both'].includes(direction))throw new TypeError('invalid traversal direction');
  if(hasQuery&&(typeof query!=='string'||!query.trim()||Array.from(query).length>120))
    throw new TypeError('invalid query; must be 1..120 characters');
  depth=integer(depth,1,0,3,'depth');
  limit=integer(limit,6,1,12,'limit');
  maxChars=integer(maxChars,4000,900,16000,'maxChars budget');
  offset=integer(offset,0,0,150,'offset');
  if(!Array.isArray(knownEtags)||knownEtags.length>30||knownEtags.some(tag=>typeof tag!=='string'||!ETAG.test(tag)))
    throw new TypeError('knownEtags must be at most 30 full SHA-256 tags');
  const lookup=hasQuery?retrieveCodeEvidence(index,{query,limit:5,includeSnippet:false}):null;
  const seeds=hasPath?[index.checkedPath(path)]:lookup.results.map(x=>x.path);
  const selector={path:hasPath?seeds[0]:null,query:hasQuery?query:null,depth,direction,seeds};
  const version=sourcesVersion(index,selector);
  if(offset>0&&(typeof ifVersion!=='string'||ifVersion!==version))
    throw new Error('stale or missing context slice version cursor; restart at offset 0');
  const {queue,hitBudget}=boundedGraph(index,seeds,depth,direction);
  if(offset>queue.length)throw new RangeError('offset exceeds candidate graph slice');
  const reasons=[...(lookup?.reasons||[])];
  if(!queue.length)reasons.push('no-lexical-seeds');
  if(hitBudget)reasons.push('graph-node-budget');
  const base={mode:'bounded-lexical-static-graph-slice',method:hasPath?'exact-entry-and-static-import-traversal':'lexical-seed-and-static-import-traversal',
    provenance:'source-verified-CodeIndex',externalProvidersUsed:false,
    seedPaths:seeds,version,direction,depth,totalCandidates:queue.length,offset,
    returned:0,truncated:false,complete:reasons.length===0,reasons:[...new Set(reasons)],items:[],
    notes:'Only lexical seeds and syntactic imports; no model, embeddings, runtime dependency proof, test coverage or raw source. maxChars measures output UTF-8 bytes, not billed tokens.'};
  const known=new Set(knownEtags);
  for(let i=offset;i<queue.length&&base.returned<limit;i++){
    const candidate=queue[i];
    // projectContextCard verifies source against the current CodeIndex SHA before
    // producing any card, including a conditional ETag-only reference.
    const card=projectContextCard(index,{path:candidate.path,limit:2,includeSnippet:false});
    const etag=sha(JSON.stringify(card));
    const common={path:candidate.path,distance:candidate.distance,
      ...(candidate.via?{via:candidate.via}:{}),etag};
    const variants=known.has(etag)?[{...common,tier:'ref',reason:'known-etag'}]:[
      {...common,tier:'card',card},
      {...common,tier:'skeleton',skeleton:skeleton(card)},
      {...common,tier:'ref',reason:'budget'}
    ];
    // For very small budgets prefer a compact rung over a one-card response.
    if(!known.has(etag)&&maxChars<=1200){const full=variants.shift();variants.push(full);}
    let chosen=null;
    for(const item of variants){
      const more=i+1<queue.length;
      const trial={...base,items:[...base.items,item],returned:base.returned+1,
        truncated:more,complete:base.complete&&!more,
        reasons:more?[...base.reasons,'result-budget-or-limit']:base.reasons,
        ...(more?{nextOffset:i+1}:{})};
      if(bytes(trial)<=maxChars){chosen=item;break;}
    }
    if(!chosen){
      if(base.returned===0)throw new RangeError('maxChars budget too small for a verified slice item');
      break;
    }
    base.items.push(chosen);base.returned++;
  }
  if(offset+base.returned<queue.length){base.truncated=true;base.nextOffset=offset+base.returned;base.complete=false;base.reasons.push('result-budget-or-limit');}
  else{base.truncated=false;delete base.nextOffset;}
  if(bytes(base)>maxChars)throw new RangeError('maxChars budget too small for context slice response');
  return base;
}
