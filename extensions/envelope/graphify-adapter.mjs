/** Explicit, read-only Graphify node-link artifact inspection.
 * External assertions are NEVER merged into Envelope's live AST graph.
 * Only a separate, locally supplied hash manifest can attest declared inputs.
 */
import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,lstatSync,openSync,readSync,realpathSync,watch as fsWatch} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

const GRAPH_PATH='graphify-out/graph.json';
const MANIFEST_PATH='graphify-out/envelope-sources.json';
const MARKER_PATH='graphify-out/needs_update';
const GRAPH_BYTES=2_000_000;
const MANIFEST_BYTES=150_000;
const SOURCE_BYTES=512_000;
const MAX_SOURCES=128;
const MAX_NODES=2000;
const MAX_EDGES=8000;
const MAX_WATCH_DIRS=16;
const HASH=/^[a-f0-9]{64}$/;
const TRUST='external-assertion-not-native-AST';
const ACTIONS=new Set(['status','nodes','neighbors','communities','path','watch']);
const DIRS=new Set(['outgoing','incoming','both']);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeString=(value,max)=>typeof value==='string' && value.length>0 && value.length<=max && !/[\u0000-\u001f\u007f]/.test(value);
const bounded=(value,fallback,min,max,name)=>{
  if(value===undefined)return fallback;
  if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`${name} must be ${min}..${max}`);
  return value;
};
function cleanPath(path){
  if(typeof path!=='string'||!path||path.length>250||path.includes('\\')||path.includes('\0')||isAbsolute(path)||path.startsWith('/'))throw new Error('invalid project-relative path');
  const parts=path.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('~')||part.includes(':')))throw new Error('invalid project-relative path');
  return parts;
}
function rootSafeRead(root,path,maxBytes){
  const parts=cleanPath(path);
  let current=root;
  for(let i=0;i<parts.length;i++){
    current=join(current,parts[i]);
    const st=lstatSync(current);
    if(st.isSymbolicLink())throw new Error('symbolic links are not permitted in graph artifacts or source evidence');
    if(i<parts.length-1 && !st.isDirectory())throw new Error('artifact parent is not a directory');
    if(i===parts.length-1 && !st.isFile())throw new Error('artifact is not a regular file');
  }
  // Defense in depth: reject paths that resolve outside the original project.
  const actual=realpathSync(current),rel=relative(root,actual);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('artifact outside project');
  const fd=openSync(current,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const st=fstatSync(fd);
    if(!st.isFile()||st.size>maxBytes)throw new Error('artifact exceeds bounded size or is not regular');
    const output=Buffer.alloc(st.size);
    let offset=0;
    while(offset<output.length){
      const count=readSync(fd,output,offset,output.length-offset,offset);
      if(count<=0)throw new Error('artifact changed while reading');
      offset+=count;
    }
    const after=fstatSync(fd);
    if(after.size!==st.size||after.ino!==st.ino||after.mtimeMs!==st.mtimeMs)throw new Error('artifact changed while reading');
    return output;
  } finally {closeSync(fd);}
}
function fileExists(root,path){
  try {lstatSync(join(root,...cleanPath(path)));return true;}
  catch(err){if(err.code==='ENOENT')return false;throw err;}
}
/** Graphify stores filenames in source_file; never display or follow out-of-root paths. */
function graphSourcePath(root,value){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>250)throw new Error('invalid graph source path');
  const rel=isAbsolute(value)?relative(root,value).split(sep).join('/'):value;
  return cleanPath(rel).join('/');
}
/** .NET Graphify serializes `file_path` and metadata.source_file, often as
 * absolute paths from a different checkout. Never follow or display them:
 * only relative paths can serve as local source evidence. */
function externalFilePath(root,value,counters){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>250)throw new Error('invalid external source path');
  if(isAbsolute(value)||/^[a-zA-Z]:[\\/]/u.test(value)||value.startsWith('\\\\')){
    counters.externalSourcePathsRedacted++;
    return null;
  }
  return graphSourcePath(root,value);
}
function decodeGraph(bytes,root){
  let raw;
  try {raw=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('invalid graph JSON');}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid graph object');
  // NetworkX node_link_data emits a top-level graph metadata object, but
  // keeps nodes and links on the ROOT. Only accept nested graphs explicitly.
  const data=Array.isArray(raw.nodes)?raw:
    raw.graph&&typeof raw.graph==='object'&&!Array.isArray(raw.graph)?raw.graph:raw;
  const records=data.nodes, links=data.edges??data.links;
  if(!Array.isArray(records)||!Array.isArray(links)||records.length>MAX_NODES||links.length>MAX_EDGES)throw new Error('unsupported or oversized Graphify node-link schema');
  const nodes=[],ids=new Set(),counters={externalSourcePathsRedacted:0};
  for(const record of records){
    if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('invalid graph node');
    const id=record.id??record.name;
    if(!safeString(id,200)||ids.has(id))throw new Error('duplicate or invalid graph node ID');
    ids.add(id);
    const name=record.label??record.name??id;
    const type=record.type??record.file_type??record.kind??'unknown';
    if(!safeString(name,240)||!safeString(type,100))throw new Error('invalid graph node attributes');
    const path=record.source_file!==undefined||record.file!==undefined||record.path!==undefined
      ?graphSourcePath(root,record.source_file??record.file??record.path)
      :externalFilePath(root,record.file_path,counters);
    const location=record.source_location??record.metadata?.source_location;
    if(location!==undefined&&!safeString(location,120))throw new Error('invalid graph node location');
    const community=record.community;
    if(community!==undefined&&community!==null&&!((Number.isInteger(community)&&community>=0&&community<=100000)||safeString(community,80)))throw new Error('invalid graph node community');
    const confidence=record.confidence;
    if(confidence!==undefined&&!['EXTRACTED','INFERRED','AMBIGUOUS'].includes(confidence))throw new Error('invalid graph node confidence');
    nodes.push({id,name,type,...(path?{path}:{}),...(location?{sourceLocation:location}:{}),
      ...(confidence?{confidence}:{}),...(community===null||community===undefined?{}:{community}),evidence:'external-graph-assertion'});
  }
  const edges=[];
  for(const edge of links){
    if(!edge||typeof edge!=='object'||Array.isArray(edge))throw new Error('invalid graph edge');
    const source=typeof edge.source==='object'&&edge.source!==null?edge.source.id:edge.source;
    const target=typeof edge.target==='object'&&edge.target!==null?edge.target.id:edge.target;
    const type=edge.relation??edge.type??edge.relationship??edge.label??'related_to';
    if(!safeString(source,200)||!safeString(target,200)||!ids.has(source)||!ids.has(target)||!safeString(type,100))throw new Error('dangling or invalid graph edge');
    const confidence=edge.confidence,score=edge.confidence_score;
    if(confidence!==undefined&&!['EXTRACTED','INFERRED','AMBIGUOUS'].includes(confidence))throw new Error('invalid graph edge confidence');
    if(score!==undefined&&!(typeof score==='number'&&Number.isFinite(score)&&score>=0&&score<=1))throw new Error('invalid graph confidence score');
    const sourcePath=edge.source_file!==undefined?graphSourcePath(root,edge.source_file):
      externalFilePath(root,edge.metadata?.source_file,counters);
    const location=edge.source_location??edge.metadata?.source_location;
    if(location!==undefined&&!safeString(location,120))throw new Error('invalid graph edge location');
    edges.push({source,target,type,evidence:'external-graph-assertion',
      ...(confidence?{confidence}:{}),...(score!==undefined?{confidenceScore:score}:{}),
      ...(sourcePath?{sourcePath}:{}),...(location?{sourceLocation:location}:{})});
  }
  nodes.sort((a,b)=>a.id.localeCompare(b.id));
  edges.sort((a,b)=>a.source.localeCompare(b.source)||a.target.localeCompare(b.target)||a.type.localeCompare(b.type));
  return {nodes,edges,...counters};
}
function decodeManifest(bytes){
  let raw;
  try {raw=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('invalid graph source manifest JSON');}
  if(!raw||typeof raw!=='object'||raw.version!==1||!HASH.test(raw.graphSha256)||!Array.isArray(raw.files)||raw.files.length<1||raw.files.length>MAX_SOURCES)throw new Error('invalid graph source manifest');
  const paths=new Set();
  for(const row of raw.files){
    if(!row||typeof row!=='object'||!HASH.test(row.sha256))throw new Error('invalid graph source hash');
    const path=cleanPath(row.path).join('/');
    if(paths.has(path))throw new Error('duplicate graph source path');
    paths.add(path);
  }
  return raw;
}
function graphStatus(root){
  let graphBytes;
  try {graphBytes=rootSafeRead(root,GRAPH_PATH,GRAPH_BYTES);}
  catch(err){
    if(err.code==='ENOENT')return {state:'missing',nodes:0,edges:0,verifiedFiles:0,reasons:['graph-not-found'],trust:TRUST};
    return {state:'invalid',nodes:0,edges:0,verifiedFiles:0,reasons:['graph-unreadable-or-unsafe'],trust:TRUST};
  }
  let graph;
  try {graph=decodeGraph(graphBytes,root);}
  catch{return {state:'invalid',nodes:0,edges:0,verifiedFiles:0,reasons:['graph-schema-invalid'],trust:TRUST};}
  const graphSha256=sha256(graphBytes);
  const sourcePaths=new Set([...graph.nodes.map(n=>n.path),...graph.edges.map(e=>e.sourcePath)].filter(Boolean));
  const noAttestation={declaredFiles:0,coveredGraphSources:0,unattestedNodeSources:sourcePaths.size,
    externalSourcePathsRedacted:graph.externalSourcePathsRedacted,
    allGraphSourcesCovered:sourcePaths.size===0&&graph.externalSourcePathsRedacted===0};
  const base={state:'unverified',nodes:graph.nodes.length,edges:graph.edges.length,graphSha256,verifiedFiles:0,
    externalSourcePathsRedacted:graph.externalSourcePathsRedacted,
    attestation:noAttestation,trust:TRUST,
    reasons:['no-source-hash-manifest',...(graph.externalSourcePathsRedacted?['external-source-path-redacted']:[])]};
  const marker=fileExists(root,MARKER_PATH);
  let manifest;
  try {manifest=decodeManifest(rootSafeRead(root,MANIFEST_PATH,MANIFEST_BYTES));}
  catch(err){
    if(err.code!=='ENOENT')return {...base,state:'invalid',reasons:['manifest-unreadable-or-invalid'],graph:null};
  }
  if(!manifest){
    if(marker)return {...base,state:'stale',reasons:['graphify-needs-update'],graph};
    return {...base,graph};
  }
  const reasons=graph.externalSourcePathsRedacted?['external-source-path-redacted']:[];
  if(manifest.graphSha256!==graphSha256)reasons.push('artifact-hash-mismatch');
  if(marker)reasons.push('graphify-needs-update');
  let verifiedFiles=0;
  try {
    for(const item of manifest.files){
      const source=rootSafeRead(root,item.path,SOURCE_BYTES);
      if(sha256(source)!==item.sha256)reasons.push('source-hash-mismatch');
      else verifiedFiles++;
    }
  } catch(err){
    if(err.code==='ENOENT')reasons.push('source-missing');
    else return {...base,state:'invalid',reasons:['source-evidence-unreadable-or-unsafe'],graph:null};
  }
  const declared=new Set(manifest.files.map(x=>x.path));
  const unattestedNodeSources=[...sourcePaths].filter(p=>!declared.has(p)).length;
  const attestation={declaredFiles:manifest.files.length,coveredGraphSources:sourcePaths.size-unattestedNodeSources,
    unattestedNodeSources,externalSourcePathsRedacted:graph.externalSourcePathsRedacted,
    allGraphSourcesCovered:unattestedNodeSources===0&&graph.externalSourcePathsRedacted===0};
  if(unattestedNodeSources)reasons.push('partial-source-attestation');
  const stale=reasons.some(x=>!['partial-source-attestation','external-source-path-redacted'].includes(x));
  return {...base,verifiedFiles,declaredFiles:manifest.files.length,attestation,
    state:stale?'stale':'declared-sources-match',reasons,graph,
    manifestFiles:manifest.files.map(x=>x.path)};
}
function adjacency(graph,direction){
  const neighbors=new Map(graph.nodes.map(n=>[n.id,[]]));
  for(const edge of graph.edges){
    if(direction!=='incoming')neighbors.get(edge.source).push({id:edge.target,edge});
    if(direction!=='outgoing')neighbors.get(edge.target).push({id:edge.source,edge});
  }
  for(const rows of neighbors.values())rows.sort((a,b)=>a.id.localeCompare(b.id)||a.edge.type.localeCompare(b.edge.type));
  return neighbors;
}
export class ExternalGraphReader {
  constructor(root,{watchFactory=fsWatch}={}){
    this.root=realpathSync(root);this.watchFactory=watchFactory;
    this.handles=[];this.timer=null;this.changeSeen=false;this.pending=false;this.batches=0;
  }
  watchStatus(){return {active:this.handles.length>0,watchedDirectories:this.handles.length,
    changedSinceStart:this.changeSeen,pending:this.pending,batches:this.batches,
    automaticRebuild:false};}
  stop(){
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    for(const handle of this.handles){try {handle.close();}catch{/* already closed */}}
    this.handles=[];this.pending=false;
  }
  close(){this.stop();}
  configureWatch(status,{enabled,debounceMs}={}){
    if(typeof enabled!=='boolean')throw new TypeError('watch enabled boolean required');
    this.stop();this.changeSeen=false;this.batches=0;
    if(!enabled)return {action:'watch',watch:this.watchStatus()};
    const delay=bounded(debounceMs,750,100,5000,'debounceMs');
    if(status.state==='invalid')throw new Error('invalid graph artifact; cannot monitor');
    const parents=new Set(['graphify-out']);
    for(const path of status.manifestFiles||[])parents.add(dirname(path));
    if(parents.size>MAX_WATCH_DIRS)throw new RangeError('graph watcher directory budget exceeded');
    const dirs=[...parents].sort();
    try {
      for(const dir of dirs){
        const normalized=dir==='.'?'':dir;
        const folder=normalized?join(this.root,...cleanPath(normalized.replaceAll('\\','/'))):this.root;
        const st=lstatSync(folder);
        if(!st.isDirectory()||st.isSymbolicLink())throw new Error('unsafe graph watch directory');
        const handle=this.watchFactory(folder,{persistent:false},()=>{
          this.changeSeen=true;this.pending=true;
          if(this.timer)clearTimeout(this.timer);
          this.timer=setTimeout(()=>{this.pending=false;this.batches++;this.timer=null;},delay);
          this.timer.unref?.();
        });
        this.handles.push(handle);
      }
    }catch(err){this.stop();throw new Error('graph watch setup failed: '+(err.code||'unsafe-directory'));}
    return {action:'watch',watch:this.watchStatus()};
  }
  query(index,args={}){
    if(!index||index.root!==this.root)throw new TypeError('live project CodeIndex required');
    if(!args||typeof args!=='object'||Array.isArray(args))throw new TypeError('graph query object required');
    const action=args.action??'status';
    if(!ACTIONS.has(action))throw new TypeError('invalid external graph action');
    if(args.direction!==undefined&&!DIRS.has(args.direction))throw new TypeError('direction must be outgoing, incoming or both');
    const status=graphStatus(this.root);
    if(action==='watch')return this.configureWatch(status,args);
    const {graph,...metadata}=status;
    const watch=this.watchStatus();
    if(action==='status')return {...metadata,watch};
    if(status.state==='invalid'||status.state==='missing')throw new Error('external graph '+status.state);
    if(status.state==='stale'&&args.allowStale!==true)throw new Error('external graph is stale; use allowStale:true to acknowledge');
    const warning=status.state==='stale'?['stale']:status.state==='unverified'?['unverified-external-assertions']:[];
    const common={state:status.state,trust:TRUST,reasons:[...status.reasons,...warning],
      complete:false,watch};
    const limit=bounded(args.limit,15,1,25,'limit');
    if(action==='communities'){
      const groups=new Map();
      for(const node of graph.nodes){
        if(node.community===undefined)continue;
        const id=node.community,key=String(id);
        if(!groups.has(key))groups.set(key,{id,members:[]});
        groups.get(key).members.push(node.id);
      }
      const ranked=[...groups.values()].map(c=>({id:c.id,size:c.members.length,sample:c.members.sort().slice(0,8),
        sampleTruncated:c.members.length>8})).sort((a,b)=>b.size-a.size||String(a.id).localeCompare(String(b.id)));
      return {action,...common,evidence:'exporter-declared-community-not-inferred',
        total:ranked.length,communities:ranked.slice(0,limit),truncated:ranked.length>limit};
    }
    if(action==='nodes'){
      const term=typeof args.query==='string'?args.query.toLowerCase():'';
      if(term.length>150)throw new RangeError('query length exceeded');
      const all=graph.nodes.filter(n=>n.id.toLowerCase().includes(term)||n.name.toLowerCase().includes(term)||n.type.toLowerCase().includes(term));
      return {action, ...common,total:all.length,nodes:all.slice(0,limit),truncated:all.length>limit};
    }
    const source=args.source,target=args.target;
    const ids=new Set(graph.nodes.map(x=>x.id));
    if(!safeString(source,200)||!ids.has(source))throw new Error('unknown external graph source node');
    const direction=args.direction??'outgoing';
    const links=adjacency(graph,direction);
    if(action==='neighbors'){
      const all=links.get(source);
      return {action,...common,source,direction,total:all.length,
        neighbors:all.slice(0,limit).map(({id,edge})=>({id,...edge})),truncated:all.length>limit};
    }
    if(!safeString(target,200)||!ids.has(target))throw new Error('unknown external graph target node');
    const maxDepth=bounded(args.maxDepth,5,1,8,'maxDepth');
    let reached=source===target,depthLimited=false,visitLimited=false;
    const visited=new Set([source]),queue=[{id:source,depth:0}],prev=new Map();
    for(let i=0;i<queue.length&&!reached;i++){
      const cur=queue[i],next=links.get(cur.id);
      if(cur.depth>=maxDepth){if(next.some(n=>!visited.has(n.id)))depthLimited=true;continue;}
      for(const n of next){
        if(visited.has(n.id))continue;
        if(visited.size>=350){visitLimited=true;break;}
        visited.add(n.id);prev.set(n.id,{from:cur.id,edge:n.edge});
        if(n.id===target){reached=true;break;}
        queue.push({id:n.id,depth:cur.depth+1});
      }
      if(visitLimited)break;
    }
    const reasons=[...common.reasons,'external-assertions-not-exhaustive'];
    if(depthLimited)reasons.push('depth-limit');
    if(visitLimited)reasons.push('visit-limit');
    if(!reached)return {action,...common,reasons,source,target,direction,maxDepth,found:false,
      nodes:[],edges:[],visited:visited.size};
    const path=[target],edges=[];
    for(let current=target;current!==source;){
      const step=prev.get(current);
      if(!step)throw new Error('external graph predecessor unavailable');
      path.push(step.from);edges.push(step.edge);current=step.from;
    }
    path.reverse();edges.reverse();
    return {action,...common,reasons,source,target,direction,maxDepth,found:true,nodes:path,edges,
      visited:visited.size};
  }
}
