/**
 * Native, deterministic code-file graph queries from Envelope's single CodeIndex.
 *
 * This is deliberately a projection of current AST evidence, not a second
 * index, an LLM-derived graph, a runtime dependency resolver, or an export
 * of third-party Graphify's semantic assertions. Call links are syntactic.
 */
const FILE_LIMIT=2_000;
const EDGE_LIMIT=15_000;
const VISIT_LIMIT=400;
const MAX_RULES=12;
const ACTIONS=new Set(['status','neighbors','path','hubs','components','boundaries','export']);
const RELATIONS=new Set(['imports','calls','both']);
const DIRECTIONS=new Set(['outgoing','incoming','both']);

function boundedInteger(value,fallback,min,max,name){
  if(value===undefined)return fallback;
  if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function nativeGraph(index,relation){
  const nodes=[...index.files.keys()].sort();
  if(nodes.length>FILE_LIMIT)throw new RangeError('graph exceeds bounded file limit');
  const included=new Set(nodes);
  const edges=[];
  let omitted=0;
  function push(edge){
    if(edges.length>=EDGE_LIMIT){omitted++;return;}
    edges.push(edge);
  }
  if(relation==='imports'||relation==='both'){
    for(const source of nodes){
      for(const target of [...(index.edges.get(source)||[])].sort()){
        if(included.has(target))push({source,target,type:'imports',sites:1,evidence:'parsed-static-import'});
      }
    }
  }
  if(relation==='calls'||relation==='both'){
    const calls=new Map();
    for(const source of nodes){
      for(const call of index.callGraph?.outgoing.get(source)||[]){
        const target=call.target?.path;
        if(!included.has(target))continue;
        const key=JSON.stringify([source,target]);
        const prior=calls.get(key);
        if(prior){prior.sites++;continue;}
        calls.set(key,{source,target,type:'calls',sites:1,evidence:'resolved-syntactic-call'});
      }
    }
    for(const edge of [...calls.values()].sort(compareEdges))push(edge);
  }
  edges.sort(compareEdges);
  const reasons=[];
  if(omitted)reasons.push('graph-edge-limit');
  if(index.lastRefresh?.unavailable?.length)reasons.push('parser-unavailable');
  if(index.lastRefresh?.discoveryTruncated)reasons.push('discovery-truncated');
  if(index.lastRefresh?.discoveryReadErrors)reasons.push('discovery-read-errors');
  if(index.lastRefresh?.files>=index.maxFiles)reasons.push('index-file-limit-may-be-reached');
  if(relation!=='imports'&&index.callGraph?.omittedCalls)reasons.push('call-fact-limit');
  if(relation!=='imports'&&index.callGraph?.unresolvedCalls)reasons.push('unresolved-call-sites');
  return {nodes,edges,edgeOmitted:omitted,reasons};
}
function compareEdges(a,b){
  return a.source.localeCompare(b.source)||a.target.localeCompare(b.target)||a.type.localeCompare(b.type);
}
function adjacentEdge(e,at,direction){
  if((direction==='outgoing'||direction==='both')&&e.source===at)return {path:e.target,edge:e};
  if((direction==='incoming'||direction==='both')&&e.target===at)return {path:e.source,edge:e};
  return null;
}
function adjacency(graph,direction){
  const links=new Map(graph.nodes.map(n=>[n,[]]));
  for(const edge of graph.edges){
    if(direction!=='incoming')links.get(edge.source)?.push({path:edge.target,edge});
    if(direction!=='outgoing')links.get(edge.target)?.push({path:edge.source,edge});
  }
  for(const items of links.values())items.sort((a,b)=>a.path.localeCompare(b.path)||compareEdges(a.edge,b.edge));
  return links;
}
function status(index,graph){
  const edgeTypes={imports:0,calls:0};
  let callSites=0;
  for(const edge of graph.edges){edgeTypes[edge.type]++;if(edge.type==='calls')callSites+=edge.sites;}
  return {mode:'native-static-evidence',files:graph.nodes.length,edges:graph.edges.length,
    edgeTypes,callSites,edgeOmitted:graph.edgeOmitted,complete:graph.reasons.length===0,reasons:graph.reasons,
    lastRefresh:{revision:index.lastRevision??null,reparsed:index.lastRefresh?.reparsed??0,
      reused:index.lastRefresh?.reused??0,removed:index.lastRefresh?.removed??0,
      unavailable:index.lastRefresh?.unavailable??[]},
    callEvidence:{linkedCalls:index.callGraph?.linkedCalls??0,
      unresolvedCalls:index.callGraph?.unresolvedCalls??0,omittedCalls:index.callGraph?.omittedCalls??0},
    externalExecution:false,
    notes:'Current project AST evidence only. Imports are static, calls are uniquely resolved syntax candidates. No runtime, inferred semantic, or type-system proof.'};
}
function checked(index,path){return index.checkedPath(path);}
function pathQuery(index,graph,args){
  const source=checked(index,args.source),target=checked(index,args.target);
  const direction=args.direction||'outgoing';
  const maxDepth=boundedInteger(args.maxDepth,4,1,8,'maxDepth');
  const links=adjacency(graph,direction);
  const seen=new Set([source]),queue=[{path:source,depth:0}],prev=new Map();
  let reached=source===target,depthLimited=false,visitLimited=false;
  for(let q=0;q<queue.length&&!reached;q++){
    const here=queue[q];
    const next=links.get(here.path)||[];
    if(here.depth>=maxDepth){
      if(next.some(entry=>!seen.has(entry.path)))depthLimited=true;
      continue;
    }
    for(const item of next){
      if(seen.has(item.path))continue;
      if(seen.size>=VISIT_LIMIT){visitLimited=true;break;}
      seen.add(item.path);prev.set(item.path,{from:here.path,edge:item.edge});
      if(item.path===target){reached=true;break;}
      queue.push({path:item.path,depth:here.depth+1});
    }
    if(visitLimited)break;
  }
  const reasons=[...graph.reasons];
  if(depthLimited)reasons.push('depth-limit');
  if(visitLimited)reasons.push('visit-limit');
  if(!reached)return {action:'path',source,target,direction,relation:args.relation||'both',maxDepth,
    found:false,nodes:[],edges:[],visited:seen.size,complete:reasons.length===0,reasons};
  const nodes=[target],edges=[];
  let current=target;
  while(current!==source){
    const step=prev.get(current);
    if(!step)throw new Error('graph reconstruction missing predecessor');
    edges.push(step.edge);nodes.push(step.from);current=step.from;
  }
  nodes.reverse();edges.reverse();
  return {action:'path',source,target,direction,relation:args.relation||'both',maxDepth,
    found:true,nodes,edges,visited:seen.size,complete:graph.reasons.length===0,reasons:graph.reasons};
}
function neighbors(index,graph,args){
  const source=checked(index,args.source),direction=args.direction||'both';
  const limit=boundedInteger(args.limit,12,1,30,'limit');
  const found=[];
  for(const edge of graph.edges){
    const result=adjacentEdge(edge,source,direction);
    if(result)found.push({...result,relation:edge.type,evidence:edge.evidence,sites:edge.sites,
      source:edge.source,target:edge.target});
  }
  found.sort((a,b)=>a.path.localeCompare(b.path)||a.relation.localeCompare(b.relation));
  return {action:'neighbors',source,direction,relation:args.relation||'both',
    total:found.length,neighbors:found.slice(0,limit).map(({edge,...fields})=>fields),
    truncated:found.length>limit,complete:graph.reasons.length===0,reasons:graph.reasons};
}
function hubs(graph,args){
  const limit=boundedInteger(args.limit,12,1,100,'limit');
  const numbers=new Map(graph.nodes.map(path=>[path,{path,incomingFiles:0,outgoingFiles:0,callSitesIn:0,callSitesOut:0,importsIn:0,importsOut:0}]));
  const inbound=new Map(graph.nodes.map(path=>[path,new Set()]));
  const outbound=new Map(graph.nodes.map(path=>[path,new Set()]));
  for(const edge of graph.edges){
    if(!numbers.has(edge.source)||!numbers.has(edge.target))continue;
    if(edge.source!==edge.target){
      inbound.get(edge.target).add(edge.source);
      outbound.get(edge.source).add(edge.target);
    }
    numbers.get(edge.target)[edge.type==='imports'?'importsIn':'callSitesIn']+=edge.sites;
    numbers.get(edge.source)[edge.type==='imports'?'importsOut':'callSitesOut']+=edge.sites;
  }
  for(const [path,data] of numbers){data.incomingFiles=inbound.get(path).size;data.outgoingFiles=outbound.get(path).size;}
  const sorted=[...numbers.values()].sort((a,b)=>b.incomingFiles-a.incomingFiles||b.callSitesIn-a.callSitesIn||a.path.localeCompare(b.path));
  return {action:'hubs',mode:'incoming-file-degree-not-semantic-importance',relation:args.relation||'both',
    hubs:sorted.slice(0,limit),total:sorted.length,truncated:sorted.length>limit,
    complete:graph.reasons.length===0,reasons:graph.reasons};
}
function components(graph,args){
  const limit=boundedInteger(args.limit,12,1,25,'limit');
  const links=adjacency(graph,'both');
  const seen=new Set(),groups=[];
  for(const root of graph.nodes){
    if(seen.has(root))continue;
    const members=[],queue=[root];seen.add(root);
    for(let q=0;q<queue.length;q++){
      const p=queue[q];members.push(p);
      for(const {path} of links.get(p)||[]){if(!seen.has(path)){seen.add(path);queue.push(path);}}
    }
    members.sort();groups.push({size:members.length,sample:members.slice(0,10),sampleTruncated:members.length>10});
  }
  groups.sort((a,b)=>b.size-a.size||a.sample[0].localeCompare(b.sample[0]));
  return {action:'components',method:'weakly-connected-components',relation:args.relation||'both',
    total:groups.length,components:groups.slice(0,limit),truncated:groups.length>limit,
    complete:graph.reasons.length===0,reasons:graph.reasons};
}
function prefix(value){
  if(typeof value!=='string'||!value||value.length>200||value.startsWith('/')||
    value.includes('\\')||value.includes('\0'))throw new TypeError('invalid project-relative directory prefix');
  const trimmed=value.endsWith('/')?value.slice(0,-1):value;
  if(trimmed.split('/').some(part=>!part||part==='.'||part==='..')){
    throw new TypeError('invalid project-relative directory prefix');
  }
  return `${trimmed}/`;
}
function boundaries(graph,args){
  const limit=boundedInteger(args.limit,20,1,50,'limit');
  if(!Array.isArray(args.rules)||!args.rules.length||args.rules.length>MAX_RULES)throw new RangeError('boundary rules must have 1..12 entries');
  const rules=args.rules.map((r,i)=>{
    if(!r||typeof r!=='object'||Array.isArray(r)||!Array.isArray(r.forbid)||!r.forbid.length||r.forbid.length>12)throw new TypeError(`boundary rule ${i} requires 1..12 forbid prefixes`);
    return {from:prefix(r.from),forbid:r.forbid.map(prefix)};
  });
  const found=[];
  for(const e of graph.edges){
    for(let i=0;i<rules.length;i++){
      const r=rules[i];
      if(e.source.startsWith(r.from)&&r.forbid.some(target=>e.target.startsWith(target))){
        found.push({source:e.source,target:e.target,type:e.type,rule:i,evidence:e.evidence});
      }
    }
  }
  found.sort((a,b)=>a.source.localeCompare(b.source)||a.target.localeCompare(b.target)||a.rule-b.rule||a.type.localeCompare(b.type));
  return {action:'boundaries',mode:'advisory-static-dependency-audit',relation:args.relation||'both',
    ruleCount:rules.length,total:found.length,violations:found.slice(0,limit),truncated:found.length>limit,
    complete:graph.reasons.length===0,reasons:graph.reasons};
}
function safeMermaid(path){
  // Mermaid quoted-string lexer does not treat JSON backslash escapes as
  // escaped quotes. Use Mermaid's own numeric entities instead.
  return '"'+String(path).replace(/&/g,'#amp;').replace(/"/g,'#quot;')
    .replace(/</g,'#lt;').replace(/>/g,'#gt;')
    .replace(/[`\r\n]/g,ch=>ch==='`'?'#96;':'#10;')+'"';
}
function exported(graph,args){
  const limit=boundedInteger(args.limit,30,1,100,'limit');
  const format=args.format||'json';
  if(!['json','mermaid','obsidian','svg'].includes(format))throw new TypeError('format must be json, mermaid, obsidian or svg');
  if(format==='svg'&&limit>30)throw new RangeError('svg limit must be 1..30');
  const nodes=graph.nodes.slice(0,limit).map(path=>({path}));
  const selected=new Set(nodes.map(n=>n.path));
  const edges=graph.edges.filter(e=>selected.has(e.source)&&selected.has(e.target)).slice(0,250);
  const truncated=nodes.length<graph.nodes.length||edges.length<graph.edges.filter(e=>selected.has(e.source)&&selected.has(e.target)).length||graph.edgeOmitted>0;
  if(format==='json')return {action:'export',format,mode:'project-relative-static-evidence',nodes,edges,truncated,
    totalFiles:graph.nodes.length,totalEdges:graph.edges.length,complete:graph.reasons.length===0,reasons:graph.reasons};
  const ids=new Map(nodes.map((n,i)=>[n.path,`n${i}`]));
  const mermaid=['flowchart LR',...nodes.map(n=>`  ${ids.get(n.path)}[${safeMermaid(n.path)}]`),
    ...edges.map(e=>`  ${ids.get(e.source)} -->|${e.type}| ${ids.get(e.target)}`)].join('\n');
  if(format==='obsidian'){
    // Percent-encode path targets and escape Markdown wiki-link delimiters.
    // No raw Graphify HTML, script, vault write or Markdown template execution.
    const wikiDisplay=path=>String(path).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/[\[\]|\r\n`]/g,'_');
    const links=nodes.map(n=>`- [[${encodeURIComponent(n.path)}|${wikiDisplay(n.path)}]]`).join('\n');
    const content=`# Native static code graph\n\nEvidence: indexed imports / syntactic calls only.\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n## Indexed files\n${links}\n`;
    return {action:'export',format,content,truncated,totalFiles:graph.nodes.length,totalEdges:graph.edges.length,
      complete:graph.reasons.length===0,reasons:graph.reasons};
  }
  if(format==='svg'){
    const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])).replace(/[\r\n]/g,'&#10;');
    const cols=Math.max(1,Math.ceil(Math.sqrt(nodes.length)));
    const rows=Math.ceil(nodes.length/cols);
    const layout=new Map(nodes.map((n,i)=>[n.path,{x:155+245*(i%cols),y:90+145*Math.floor(i/cols)}]));
    const lines=edges.map(e=>{
      const a=layout.get(e.source),b=layout.get(e.target);
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#777" stroke-width="1.5"/>`;
    });
    const circles=nodes.map(n=>{
      const p=layout.get(n.path);
      return `<circle cx="${p.x}" cy="${p.y}" r="16" fill="#e1e7ef" stroke="#526480"/><text x="${p.x}" y="${p.y+29}" font-size="10" text-anchor="middle" fill="#17253c">${esc(n.path)}</text>`;
    });
    const width=cols*245+40,height=rows*145+40;
    const content=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Static source dependency diagram">${lines.join('')}${circles.join('')}</svg>`;
    return {action:'export',format,content,truncated,totalFiles:graph.nodes.length,totalEdges:graph.edges.length,
      complete:graph.reasons.length===0,reasons:graph.reasons};
  }
  return {action:'export',format,content:mermaid,truncated,totalFiles:graph.nodes.length,totalEdges:graph.edges.length,
    complete:graph.reasons.length===0,reasons:graph.reasons};
}
/** Inspect the live already-refreshed index. No disk writes, providers or execution. */
export function inspectCodeGraph(index,args={}){
  if(!index?.files||!index?.edges||!index?.checkedPath)throw new TypeError('current CodeIndex required');
  if(!args||typeof args!=='object'||Array.isArray(args))throw new TypeError('graph query object required');
  const action=args.action||'status',relation=args.relation||'both',direction=args.direction||'outgoing';
  if(!ACTIONS.has(action))throw new TypeError('unknown graph query action');
  if(!RELATIONS.has(relation))throw new TypeError('relation must be imports, calls or both');
  if(!DIRECTIONS.has(direction))throw new TypeError('direction must be incoming, outgoing or both');
  const graph=nativeGraph(index,relation);
  if(action==='status')return status(index,graph);
  if(action==='neighbors')return neighbors(index,graph,args);
  if(action==='path')return pathQuery(index,graph,args);
  if(action==='hubs')return hubs(graph,args);
  if(action==='components')return components(graph,args);
  if(action==='boundaries')return boundaries(graph,args);
  return exported(graph,args);
}
