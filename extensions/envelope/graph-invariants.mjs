/** Checkable predicates on one SHA-verified static file-import graph, not programs. */
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
const sha=v=>createHash('sha256').update(v).digest('hex');
const within=(root,p)=>p===root||p.startsWith(root+sep);
const bytes=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
function bound(v,d,min,max,name){v??=d;if(!Number.isInteger(v)||v<min||v>max)throw new RangeError(name+' must be '+min+'..'+max);return v;}
function load(index,maxNodes){
 if(!index?.files||!index?.checkedPath||typeof index.root!=='string')throw new TypeError('CodeIndex required');
 if(realpathSync(index.root)!==index.root)throw new Error('project root changed');
 if(index.files.size>maxNodes)return {ready:false,reasons:['graph-node-budget']};
 const files=[...index.files.keys()].sort(),edges=new Map();let totalBytes=0;
 for(const path of files){
   if(path!==index.checkedPath(path))throw new Error('unsafe index path');
   const record=index.files.get(path),absolute=resolve(index.root,path),stat=lstatSync(absolute),canonical=realpathSync(absolute);
   if(!within(index.root,absolute)||!within(index.root,canonical)||stat.isSymbolicLink()||!stat.isFile())throw new Error('unsafe symlink source');
   totalBytes+=stat.size;if(totalBytes>24*1024*1024)throw new RangeError('graph verification source byte limit exceeded');
   if(sha(readFileSync(absolute))!==record.contentSha256)throw new Error('source changed since index refresh');
   edges.set(path,[...(index.edges?.get(path)||[])].filter(x=>index.files.has(x)).sort());
 }
 const reasons=[];
 if(index.lastRefresh?.unavailable?.length)reasons.push('parser-unavailable');
 if(index.lastRefresh?.discoveryTruncated)reasons.push('discovery-truncated');
 if(index.lastRefresh?.discoveryReadErrors)reasons.push('discovery-read-errors');
 if(index.files.size>=index.maxFiles)reasons.push('index-file-cap-possibly-reached');
 const version=sha(JSON.stringify(files.map(p=>[p,index.files.get(p).contentSha256,edges.get(p)])));
 return {ready:true,files,edges,version,reasons};
}
function dfsCycle(g){
 const color=new Map(),stack=[],order=[];let cycle=null;
 const dfs=p=>{
   color.set(p,1);stack.push(p);
   for(const target of g.edges.get(p)){
     if(!color.has(target)){dfs(target);if(cycle)return;}
     else if(color.get(target)===1){cycle=[...stack.slice(stack.indexOf(target)),target];return;}
   }
   color.set(p,2);stack.pop();order.push(p);
 };
 for(const p of g.files)if(!color.has(p)){dfs(p);if(cycle)break;}
 return {cycle,order};
}
function reachable(g,from,target){
 const seen=new Set([from]),queue=[[from]];
 for(let i=0;i<queue.length;i++){
   const path=queue[i],last=path.at(-1);
   if(last===target)return {path,seen:[...seen].sort()};
   for(const to of g.edges.get(last)||[]){if(!seen.has(to)){seen.add(to);queue.push([...path,to]);}}
 }
 return {path:null,seen:[...seen].sort()};
}
export function verifyGraphInvariant(index,{action='acyclic',source,target,maxNodes=200,maxChars=4000}={}){
 if(!['acyclic','reach','no-path'].includes(action))throw new TypeError('invalid graph invariant action');
 maxNodes=bound(maxNodes,200,1,500,'maxNodes');maxChars=bound(maxChars,4000,900,16000,'maxChars');
 const g=load(index,maxNodes);
 const property=action==='acyclic'?'acyclic-static-file-imports':action==='reach'?'reachable-in-static-file-imports':'no-path-in-static-file-imports';
 const base={mode:'checked-static-file-graph-invariant',property,version:g.version??null,
   complete:false,verdict:'unknown',reasons:[...g.reasons],certificate:null,
   notes:'This checks only indexed, currently SHA-verified syntactic file imports. It is not a runtime, semantic, type-system or program-correctness proof.'};
 if(!g.ready)return base;
 if(action==='acyclic'){
   const {cycle,order}=dfsCycle(g);
   if(cycle){base.verdict='violated';base.certificate={cycle};}
   else if(!g.reasons.length){base.verdict='holds';base.certificate={order};}
 }else{
   if(typeof source!=='string'||typeof target!=='string')throw new TypeError('source and target paths required');
   const from=index.checkedPath(source),to=index.checkedPath(target);
   if(!g.edges.has(from)||!g.edges.has(to))throw new Error('source/target not indexed');
   base.source=from;base.target=to;
   const r=reachable(g,from,to);
   if(action==='reach'){
     if(r.path){base.verdict='holds';base.certificate={path:r.path};}
     else if(!g.reasons.length){base.verdict='violated';base.certificate={explored:r.seen};}
   }else{
     if(r.path){base.verdict='violated';base.certificate={path:r.path};}
     else if(!g.reasons.length){base.verdict='holds';base.certificate={explored:r.seen};}
   }
 }
 base.complete=g.reasons.length===0;
 if(bytes(base)>maxChars){base.verdict='unknown';base.certificate=null;base.complete=false;base.reasons.push('certificate-output-budget');}
 if(bytes(base)>maxChars)throw new RangeError('maxChars too small for invariant response');
 return base;
}
export function checkGraphCertificate(index,result){
 try{
   if(!result||!['holds','violated'].includes(result.verdict)||!result.certificate||typeof result.certificate!=='object')return false;
   const g=load(index,500);if(!g.ready||g.version!==result.version)return false;
   const c=result.certificate,keys=Object.keys(c);
   if(keys.length!==1)return false;
   if(result.property==='acyclic-static-file-imports'){
     if(result.verdict==='violated'){
       if(!Array.isArray(c.cycle))return false;
       return c.cycle.length>=2&&c.cycle[0]===c.cycle.at(-1)&&c.cycle.slice(0,-1).every((x,i)=>g.edges.get(x)?.includes(c.cycle[i+1]));
     }
     if(!Array.isArray(c.order)||g.reasons.length>0||result.complete!==true)return false;
     if(c.order.length!==g.files.length||new Set(c.order).size!==g.files.length)return false;
     const position=new Map(c.order.map((p,i)=>[p,i]));
     return g.files.every(p=>position.has(p)&&g.edges.get(p).every(x=>position.get(x)<position.get(p)));
   }
   if(result.property==='reachable-in-static-file-imports'||result.property==='no-path-in-static-file-imports'){
     const expectsPath=(result.property==='reachable-in-static-file-imports'&&result.verdict==='holds')||
       (result.property==='no-path-in-static-file-imports'&&result.verdict==='violated');
     if(expectsPath){
       if(!Array.isArray(c.path)||!c.path.length)return false;
       return c.path[0]===result.source&&c.path.at(-1)===result.target&&c.path.slice(0,-1).every((p,i)=>g.edges.get(p)?.includes(c.path[i+1]));
     }
     if(!Array.isArray(c.explored)||g.reasons.length>0||result.complete!==true)return false;
     const actual=reachable(g,result.source,result.target);
     return !actual.path&&JSON.stringify(actual.seen)===JSON.stringify(c.explored);
   }
   return false;
 }catch{return false;}
}
