/** Bounded symbol-first retrieval card from the one shared, current CodeIndex.
 * This card contains exact AST facts only; no model-generated interpretations.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const sha256=text=>createHash('sha256').update(text).digest('hex');
const bounded=(value,fallback,min,max,label)=>{
 if(value===undefined)return fallback;
 if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`${label} must be ${min}..${max}`);
 return value;
};
export function projectContextCard(index,{path,symbol,limit=8,includeSnippet=false}={}){
 if(!index?.files||typeof index.checkedPath!=='function')throw new TypeError('current CodeIndex required');
 const key=index.checkedPath(path),record=index.files.get(key);
 limit=bounded(limit,8,1,16,'limit');
 if(symbol!==undefined&&(typeof symbol!=='string'||!symbol.trim()||symbol.length>128))throw new TypeError('invalid symbol');
 if(typeof includeSnippet!=='boolean')throw new TypeError('includeSnippet must be boolean');
 const source=readFileSync(join(index.root,key),'utf8');
 if(sha256(source)!==record.contentSha256)throw new Error('source changed since CodeIndex refresh; retry the query');
 const qualifiedName=s=>s.container?`${s.container}.${s.name}`:s.name;
 const available=(record.symbols||[]).filter(s=>symbol===undefined||s.name===symbol||qualifiedName(s)===symbol);
 if(symbol&&!available.length)throw new Error('symbol not indexed at this path');
 const symbols=available.sort((a,b)=>a.line-b.line||a.name.localeCompare(b.name));
 // A qualified method and a top-level function can share the same bare name.
 // Retain only exact declaration identities, including the source line.
 const callerMatches=x=>available.some(s=>x.caller?.name===qualifiedName(s)&&x.caller?.line===s.line);
 const targetMatches=x=>available.some(s=>x.target?.path===key&&x.target?.name===s.name&&x.target?.line===s.line);
 const importerPaths=[...(index.importers.get(key)||[])].sort();
 const importPaths=[...(index.edges.get(key)||[])].sort();
 const outgoing=(index.callGraph?.outgoing.get(key)||[]).filter(x=>!symbol||callerMatches(x));
 const incoming=(index.callGraph?.incoming.get(key)||[]).filter(x=>!symbol||targetMatches(x));
 const unresolved=(index.callGraph?.unresolved.get(key)||[]).filter(x=>!symbol||callerMatches(x));
 const reasons=[];
 if(record.diagnostics?.length)reasons.push('source-diagnostics');
 if(record.omittedCalls)reasons.push('call-fact-limit');
 if(unresolved.length)reasons.push('unresolved-call-sites');
 if(importerPaths.length>limit||importPaths.length>limit||symbols.length>limit||outgoing.length>limit||incoming.length>limit||unresolved.length>limit)reasons.push('card-result-limit');
 if(index.lastRefresh?.unavailable?.length)reasons.push('some-parsers-unavailable');
 const mapEdge=e=>({caller:e.caller?.name||null,callee:e.target?.name||e.name,
  targetPath:e.target?.path||null,line:e.line,resolution:e.resolution||'unresolved'});
 const card={mode:'bounded-syntactic-context-card',provenance:'indexed-source-hash-verified',
   source:{path:key,sha256:record.contentSha256,language:record.language,diagnostics:record.diagnostics?.length||0},
   symbolFilter:symbol||null,
   symbols:symbols.slice(0,limit).map(s=>({name:s.name,kind:s.kind,line:s.line,container:s.container||null})),
   imports:{outgoing:importPaths.slice(0,limit),incoming:importerPaths.slice(0,limit),
     totalOutgoing:importPaths.length,totalIncoming:importerPaths.length},
   calls:{totalOutgoing:outgoing.length,totalIncoming:incoming.length,totalUnresolved:unresolved.length,
     outgoing:outgoing.slice(0,limit).map(mapEdge),incoming:incoming.slice(0,limit).map(mapEdge),
     unresolved:unresolved.slice(0,limit).map(e=>({name:e.name,line:e.line,reason:e.reason}))},
   complete:reasons.length===0,reasons,
   note:'Static indexed evidence only; no runtime call resolution or semantic truth claim.'};
 if(includeSnippet){
   const first=symbols[0]?.line||1;
   const lines=source.split(/\r?\n/);
   const begin=Math.max(0,first-2);
   const excerpt=lines.slice(begin,Math.min(lines.length,begin+8)).join('\n');
   card.snippet=Array.from(excerpt).slice(0,450).join('');
   card.snippetTruncated=Array.from(excerpt).length>450;
   card.snippetStartLine=begin+1;
 }
 return card;
}
