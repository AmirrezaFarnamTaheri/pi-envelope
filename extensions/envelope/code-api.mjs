/** Pi-native code intelligence over one shared lazy TypeScript AST index per root. */
import { CodeIndex } from './code-index.mjs';
import { analyzeChangeImpact } from './change-evidence.mjs';
import { inspectCodeGraph } from './graph-intelligence.mjs';
import { ExternalGraphReader } from './graphify-adapter.mjs';
import {inspectCodeHistory} from './code-history.mjs';
import {projectContextCard} from './context-card.mjs';
import { TreeSitterBroker, treeCaptureGroups } from './tree-sitter-broker.mjs';

const result = (value,isError=false) => ({
  isError,content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}],details:{}
});
const intProp = (description,min,max) => ({type:'integer',minimum:min,maximum:max,description});
function schema(properties,required=[]) {return {type:'object',properties,required,additionalProperties:false};}

export function registerCodeFeature(pi,{project,getConfig,loadCompiler=()=>import('typescript'),observe,loadTreeRuntime,getTreeGrammarPath,watchGraphFactory}={}) {
  const indices=new Map();
  const treeBrokers=new Map();
  const graphReaders=new Map();
  function graphReader(index) {
    if(!graphReaders.has(index.root))graphReaders.set(index.root,new ExternalGraphReader(index.root,{...(watchGraphFactory?{watchFactory:watchGraphFactory}:{})}));
    return graphReaders.get(index.root);
  }
  function treeBroker(index) {
    if(!treeBrokers.has(index.root)) treeBrokers.set(index.root,new TreeSitterBroker({
      ...(loadTreeRuntime?{loadRuntime:loadTreeRuntime}:{}),
      ...(getTreeGrammarPath?{getGrammarPath:getTreeGrammarPath}:{})
    }));
    return treeBrokers.get(index.root);
  }
  function requireTreeEnabled(){
    if(!getConfig().code.treeEnabled)throw new Error('Tree-sitter is disabled. Use /envelope code tree on.');
  }
  let compilerPromise;
  async function indexOf(ctx) {
    if(!getConfig().code.enabled) throw new Error('Code intelligence is disabled. Use /envelope code on.');
    compilerPromise??=Promise.resolve().then(loadCompiler);
    let ts;
    try {const loaded=await compilerPromise;ts=loaded.default||loaded;}
    catch(err) {throw new Error(`TypeScript AST parser unavailable. Run npm install in this package: ${err.message}`);}
    const root=project(ctx);
    let index=indices.get(root);
    if(!index) {
      index=new CodeIndex(root,{ts,maxFiles:1000,maxBytesPerFile:512_000,languagesEnabled:getConfig().code.languagesEnabled});
      indices.set(root,index);
    }
    index.languagesEnabled=getConfig().code.languagesEnabled;
    index.refresh();
    return index;
  }
  const tool=(name,label,description,parameters,run)=>{
    pi.registerTool?.({name,label,description,parameters,
      async execute(_id,params,_signal,_onUpdate,ctx){
        const started=performance.now();
        let output;
        try {output=result(await run(await indexOf(ctx),params||{}));}
        catch(err) {output=result(`Code intelligence: ${err.message}`,true);}
        observe?.(ctx,'code_query',{action:name,outcome:output.isError?'error':'ok',durationMs:performance.now()-started});
        return output;
      }});
  };
  tool('envelope_code_overview','Envelope: Codebase Overview',
    'Inspect a small ranked repository map using AST symbols and relative import centrality; no embeddings or full runtime call graph.',
    schema({limit:intProp('Maximum ranked files, defaults to 12',1,15)}),
    (index,params)=>index.overview({limit:Math.min(params.limit||12,15)}));
  tool('envelope_code_graph','Envelope: Native Graph Exploration',
    'Read-only, deterministic file graph over the current indexed project. Supports status, imports/calls neighbors, shortest paths, hubs, weak components, architecture boundary auditing, and bounded JSON/Mermaid exports. Does not infer semantic/runtime relationships.',
    schema({
      action:{type:'string',enum:['status','neighbors','path','hubs','components','boundaries','export']},
      source:{type:'string',description:'Indexed source file, required for neighbors or path'},
      target:{type:'string',description:'Indexed destination file, required for path'},
      relation:{type:'string',enum:['imports','calls','both']},
      direction:{type:'string',enum:['incoming','outgoing','both']},
      maxDepth:intProp('Shortest-path depth bound, 1-8',1,8),
      limit:intProp('Maximum results or exported nodes, 1-100; action-specific smaller limits apply',1,100),
      format:{type:'string',enum:['json','mermaid']},
      rules:{type:'array',maxItems:12,items:{type:'object',properties:{from:{type:'string'},forbid:{type:'array',minItems:1,maxItems:12,items:{type:'string'}}},required:['from','forbid'],additionalProperties:false}}
    }), (index,params)=>inspectCodeGraph(index,params));
  tool('envelope_code_external_graph','Envelope: External Graphify Artifact',
    'Explicitly inspect a local graphify-out/graph.json node-link graph as untrusted external assertions. Check hash-attested source freshness, bounded nodes/paths/edges, and opt-in debounce watcher. Never merges edges with native AST, runs Graphify or makes model calls.',
    schema({action:{type:'string',enum:['status','nodes','neighbors','path','watch']},
      source:{type:'string',description:'External node ID for neighbors or path'},
      target:{type:'string',description:'External destination node ID for path'},
      query:{type:'string',description:'Optional node name/ID/type substring filter'},
      direction:{type:'string',enum:['outgoing','incoming','both']},
      limit:intProp('Maximum nodes or adjacent edges (1-25)',1,25),
      maxDepth:intProp('Path search bound (1-8)',1,8),
      allowStale:{type:'boolean',description:'Explicitly acknowledge that a known-stale graph may be used'},
      enabled:{type:'boolean',description:'Explicit watch enable or disable (action: watch)'},
      debounceMs:intProp('Debounce invalidations between 100 and 5000 ms (action: watch)',100,5000)}),
    (index,params)=>graphReader(index).query(index,params));
  tool('envelope_code_history','Envelope: Bounded Git Co-change Evidence',
    'Read-only bounded Git commit co-occurrence, indexed-source churn and window completeness. Historical co-changes are NOT causal dependencies, authorship ownership or runtime call evidence.',
    schema({action:{type:'string',enum:['status','cochange','churn']},
      path:{type:'string',description:'Project-relative indexed source file for cochange'},
      maxCommits:intProp('Maximum Git commits examined, 1-100',1,100),
      limit:intProp('Maximum reported related/churn files, 1-20',1,20)}),
    (index,params)=>inspectCodeHistory(index,params));
  tool('envelope_code_context_card','Envelope: Bounded Source Context Card',
    'One compact, hash-verified source symbol, imports, inbound/outbound syntactic call evidence and explicit uncertainty. Does not automatically expose source text or make model calls.',
    schema({path:{type:'string',description:'Indexed project-relative source path'},symbol:{type:'string',description:'Optional exact declaration name'},
      limit:intProp('Maximum items per evidence category (1-16)',1,16),includeSnippet:{type:'boolean',description:'Explicitly include <=450 source code points near indexed declaration'}} ,['path']),
    (index,params)=>projectContextCard(index,params));
  tool('envelope_code_languages','Envelope: Structural Parser Status',
    'Display available indexed languages, skipped parser reasons, and whether optional local Python/Go AST parsing is enabled.',
    schema({}), (index)=>index.languageStatus());
  tool('envelope_code_tree_status','Envelope: Tree-sitter Status',
    'Report opt-in Tree-sitter WASM engine availability and grammar query coverage. Engine availability does not imply every grammar is installed.',
    schema({}), async index=>({
      enabled:getConfig().code.treeEnabled,
      runtime:await treeBroker(index).availability(),
      grammarProfiles:['javascript','typescript','tsx',...(index.languagesEnabled?['python','go']:[])],
      groupsByGrammar:Object.fromEntries(['javascript','typescript','tsx',...(index.languagesEnabled?['python','go']:[])].map(name=>[name,treeCaptureGroups(name)])),
      note:'Grammar files are loaded lazily on first query; no parser result is fabricated when unavailable.'
    }));
  tool('envelope_code_tree_query','Envelope: Tree-sitter S-expression Query',
    'Run a bounded, read-only Tree-sitter S-expression query against an indexed JS/TS or enabled Python/Go source file using installed local WASM grammar assets. Off by default; fails explicitly when runtime/grammar is missing.',
    schema({path:{type:'string',description:'Project-relative indexed source file'},
      query:{type:'string',description:'Tree-sitter S-expression with named @captures; maximum 2048 characters'},
      limit:intProp('Maximum returned matches (max 25)',1,25)},['path','query']),
    async(index,params)=>{requireTreeEnabled();return treeBroker(index).run(index,{...params,mode:'query'});});
  tool('envelope_code_tree_capture','Envelope: Tree-sitter Named Capture',
    'Run a named Tree-sitter capture preset (functions, classes, imports, calls, comments, identifiers; Go types); capture availability is grammar-specific. Read-only; no fallback.',
    schema({path:{type:'string',description:'Project-relative indexed source file'},
      group:{type:'string',description:'Grammar-specific named group: identifiers/comments/functions/classes/types/imports/calls'},
      limit:intProp('Maximum returned captures (max 25)',1,25)},['path','group']),
    async(index,params)=>{requireTreeEnabled();return treeBroker(index).run(index,{...params,mode:'capture'});});
  tool('envelope_code_lookup','Envelope: Code Symbol Lookup',
    'Find JavaScript, TypeScript and (when enabled) Python/Go function, class, method and type declarations with exact project-relative path and line.',
    schema({query:{type:'string',description:'Identifier or path substring'},limit:intProp('Maximum symbol results',1,25)},['query']),
    (index,params)=>index.lookup(params.query,{limit:Math.min(params.limit||15,25)}));
  tool('envelope_code_calls','Envelope: Syntactic Call Evidence',
    'Inspect bounded direct-function callers, callees and explicitly unresolved calls using the shared cached JS/TS and opt-in Python/Go AST. Static syntax candidates are not type-checked/runtime call graphs.',
    schema({path:{type:'string',description:'Project-relative indexed source file'},
      symbol:{type:'string',description:'Optional exact caller or target declaration name'},
      limit:intProp('Maximum evidence entries per list (1-25, default 15)',1,25)},['path']),
    (index,params)=>index.calls(params.path,{symbol:params.symbol,limit:params.limit??15}));
  tool('envelope_code_impact','Envelope: Static Import Impact',
    'Inspect importers of a source file through statically resolved relative JS/TS, local Python, and Go module imports; NOT a dynamic call graph or test coverage.',
    schema({path:{type:'string',description:'Project-relative indexed source file'},depth:intProp('Transitive import hops, 1-3',1,3)},['path']),
    (index,params)=>{
      const data=index.impact(params.path,{depth:params.depth||3});
      return {...data,totalImporters:data.importers.length,truncated:data.importers.length>35,importers:data.importers.slice(0,35)};
    });
  tool('envelope_code_change_impact','Envelope: Commit-Pinned Change Impact',
    'Read-only Git base..HEAD analysis grounded in the exact clean working tree and shared cached AST index. Includes changed line ranges, static import dependents and heuristic test neighbors, not verified coverage.',
    schema({base:{type:'string',description:'Exact, full 40- or 64-character base commit SHA'},
      head:{type:'string',description:'Optional full head commit SHA; must match checked-out HEAD'},
      limit:intProp('Maximum returned impacted files (1-25)',1,25)},['base']),
    (index,params)=>analyzeChangeImpact(index,{base:params.base,head:params.head,limit:params.limit??15}));
  tool('envelope_code_verify','Envelope: Syntax Verification',
    'Parse a JS/TS or enabled Python/Go file, or proposed replacement text, and return syntax diagnostics only; never writes to disk or typechecks.',
    schema({path:{type:'string',description:'Project-relative indexed source file'},
      content:{type:'string',description:'Optional proposed source to check without writing'},},['path']),
    (index,params)=>{
      const report=index.verify(params.path,{content:params.content});
      return {...report,diagnostics:report.diagnostics.slice(0,20).map(d=>({...d,message:d.message.slice(0,400)}))};
    });
  return {loaded:()=>indices.size,indexOf,close:()=>{for(const reader of graphReaders.values())reader.close();graphReaders.clear();}};
}
