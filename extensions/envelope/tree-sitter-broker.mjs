/**
 * Optional, project-scoped Tree-sitter query/capture adapter for the existing
 * CodeIndex. One indexed-path gate, no new Pi hook, source scanner or index.
 *
 * The real engine is web-tree-sitter and locally installed WASM grammars.
 * Never substitute regex/TypeScript parsing for missing WASM dependencies.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const EXTENSIONS=new Map([
  ['.js','javascript'],['.jsx','javascript'],['.mjs','javascript'],['.cjs','javascript'],
  ['.ts','typescript'],['.mts','typescript'],['.cts','typescript'],['.tsx','tsx'],
  ['.py','python'],['.pyi','python'],['.go','go']
]);
const MAX_QUERY_LENGTH=2048;
const MAX_SOURCE_BYTES=256_000;
const MAX_LIMIT=25;
const MAX_CAPTURES_PER_MATCH=10;
const MAX_CAPTURE_CHARS=200;
const MAX_MATCH_LIMIT=128;
const MAX_QUERY_TIME_MICROS=100_000;
const MAX_RESPONSE_BYTES=16_000;

const COMMON={
  identifiers:'(identifier) @name',
  comments:'(comment) @comment'
};
const GROUPS={
  javascript:{...COMMON,functions:'(function_declaration name: (identifier) @name)',
    classes:'(class_declaration name: (identifier) @name)',
    imports:'(import_statement) @import',
    calls:'(call_expression function: (identifier) @call)'},
  typescript:{...COMMON,functions:'(function_declaration name: (identifier) @name)',
    classes:'(class_declaration name: (type_identifier) @name)',
    imports:'(import_statement) @import',
    calls:'(call_expression function: (identifier) @call)'},
  tsx:{...COMMON,functions:'(function_declaration name: (identifier) @name)',
    classes:'(class_declaration name: (type_identifier) @name)',
    imports:'(import_statement) @import',
    calls:'(call_expression function: (identifier) @call)'},
  python:{...COMMON,functions:'(function_definition name: (identifier) @name)',
    classes:'(class_definition name: (identifier) @name)',
    imports:'(import_statement) @import',
    calls:'(call function: (identifier) @call)'},
  go:{...COMMON,functions:'(function_declaration name: (identifier) @name)',
    types:'(type_spec name: (type_identifier) @name)',
    imports:'(import_declaration) @import',
    calls:'(call_expression function: (identifier) @call)'}
};

export function treeGrammarForPath(path){return EXTENSIONS.get(extname(String(path)).toLowerCase())||null;}
export function namedTreeQuery(language,group){
  const profile=Object.hasOwn(GROUPS,language)?GROUPS[language]:null;
  return profile && Object.hasOwn(profile,group)?profile[group]:null;
}
export function treeCaptureGroups(language){return Object.keys(Object.hasOwn(GROUPS,language)?GROUPS[language]:{}).sort();}

const nodeRequire=createRequire(import.meta.url);
export async function loadTreeRuntime({requireModule=nodeRequire}={}){
  try {return requireModule('web-tree-sitter');}
  catch(err){throw new Error(`web-tree-sitter runtime unavailable (install optional packages with npm install --include=optional): ${err.message}`);}
}

export async function getTreeGrammarPath(language){
  let wasm;
  try {wasm=await import('tree-sitter-wasm');}
  catch(err){throw new Error(`tree-sitter-wasm grammar package unavailable (install optional packages with npm install --include=optional): ${err.message}`);}
  if(typeof wasm.getWasmPath!=='function')throw new Error('tree-sitter-wasm does not export getWasmPath');
  let path;
  try {path=wasm.getWasmPath(language);}
  catch(err){throw new Error(`Tree-sitter ${language} grammar unavailable: ${err.message}`);}
  if(path instanceof URL && path.protocol==='file:')path=fileURLToPath(path);
  if(typeof path!=='string'||!path.trim()||(!isAbsolute(path) && !path.startsWith('file:'))||/^https?:/i.test(path)){
    throw new Error(`Tree-sitter ${language} grammar path is not a local absolute filesystem path`);
  }
  return path.startsWith('file:')?fileURLToPath(path):path;
}

function boundedText(value){
  const chars=Array.from(String(value??''));
  return chars.length>MAX_CAPTURE_CHARS ? chars.slice(0,MAX_CAPTURE_CHARS).join('')+'…' : chars.join('');
}
function nodeCapture(capture){
  const node=capture?.node;
  if(!node || !node.startPosition || !node.endPosition)throw new Error('Tree-sitter capture returned an invalid node');
  const pos=(p)=>({line:p.row+1,column:p.column+1});
  return {
    name:String(capture.name??''),type:String(node.type??''),
    start:pos(node.startPosition),end:pos(node.endPosition),text:boundedText(node.text)
  };
}
function inRoot(root,path){return path===root||path.startsWith(root+sep);}
function checkedSource(index,key){
  const absolute=resolve(index.root,key);
  if(!inRoot(index.root,absolute))throw new Error('source outside project root');
  const stat=lstatSync(absolute);
  if(stat.isSymbolicLink() || !stat.isFile())throw new Error('symlink or nonfile source is not allowed');
  const real=realpathSync(absolute);
  if(!inRoot(index.root,real)||relative(index.root,real).startsWith('..'))throw new Error('source outside project root');
  if(stat.size>Math.min(index.maxBytesPerFile??MAX_SOURCE_BYTES,MAX_SOURCE_BYTES))throw new RangeError('source exceeds Tree-sitter byte limit');
  const source=readFileSync(absolute,'utf8');
  if(Buffer.byteLength(source)>MAX_SOURCE_BYTES)throw new RangeError('source exceeds Tree-sitter byte limit');
  return source;
}
function requiredQuery(mode,params,language){
  if(mode==='capture'){
    const name=params.group;
    if(typeof name!=='string'||name.length>32||!namedTreeQuery(language,name))throw new Error(`unsupported Tree-sitter capture group for ${language}: ${String(name??'')}`);
    return namedTreeQuery(language,name);
  }
  if(mode!=='query')throw new Error('Tree-sitter mode must be query or capture');
  const query=params.query;
  if(typeof query!=='string'||!query.trim())throw new TypeError('Tree-sitter query must be a nonempty S-expression');
  if(query.length>MAX_QUERY_LENGTH)throw new RangeError('Tree-sitter query exceeds 2048-character limit');
  return query;
}

export class TreeSitterBroker {
  constructor({loadRuntime=loadTreeRuntime,getGrammarPath=getTreeGrammarPath}={}){
    this.loadRuntime=loadRuntime;
    this.getGrammarPath=getGrammarPath;
    this.runtimePromise=null;
    this.grammarPromises=new Map();
  }
  async runtime(){
    this.runtimePromise??=Promise.resolve().then(this.loadRuntime).then(async mod=>{
      const impl=mod?.Parser?mod:mod?.default;
      if(typeof impl?.Parser!=='function'||typeof impl?.Language?.load!=='function'||typeof impl?.Query!=='function'){
        throw new Error('incompatible web-tree-sitter API: Parser, Language.load and Query are required');
      }
      await impl.Parser.init();
      return impl;
    });
    return this.runtimePromise;
  }
  async availability(){
    try {await this.runtime();return {available:true,engine:'web-tree-sitter',note:'Runtime initialized; individual grammars load on first query'};}
    catch(err){return {available:false,engine:'web-tree-sitter',reason:String(err.message).slice(0,280)};}
  }
  async grammar(language,runtime){
    if(!this.grammarPromises.has(language)){
      const promise=Promise.resolve().then(()=>this.getGrammarPath(language)).then(path=>runtime.Language.load(path));
      this.grammarPromises.set(language,promise);
    }
    return this.grammarPromises.get(language);
  }
  async run(index,params){
    const {path,mode='query'}=params??{};
    if(typeof path!=='string'||!path.trim())throw new TypeError('indexed source path required');
    // The shared index is the only file-discovery and project-scoping authority.
    const key=index.checkedPath(path);
    const language=treeGrammarForPath(key);
    if(!language)throw new Error(`Tree-sitter grammar unsupported for indexed path: ${key}`);
    if(['python','go'].includes(language)&&!index.languagesEnabled){
      throw new Error('Python/Go Tree-sitter queries require /envelope code languages on');
    }
    const queryText=requiredQuery(mode,params,language);
    const limit=Number.isInteger(params?.limit)?Math.max(1,Math.min(params.limit,MAX_LIMIT)):15;
    const source=checkedSource(index,key);
    let runtime;
    try {runtime=await this.runtime();}
    catch(err){throw new Error(`Tree-sitter unavailable: ${err.message}`);}
    let grammar;
    try {grammar=await this.grammar(language,runtime);}
    catch(err){throw new Error(`Tree-sitter ${language} grammar unavailable: ${err.message}`);}
    let parser,tree,query;
    try {
      parser=new runtime.Parser();
      parser.setLanguage(grammar);
      tree=parser.parse(source);
      if(!tree?.rootNode)throw new Error('Tree-sitter parser produced no syntax tree');
      query=new runtime.Query(grammar,queryText);
      const options={matchLimit:MAX_MATCH_LIMIT,timeoutMicros:MAX_QUERY_TIME_MICROS};
      const started=performance.now();
      const records=mode==='capture' ? query.captures(tree.rootNode,options) : query.matches(tree.rootNode,options);
      if(!Array.isArray(records))throw new Error('Tree-sitter query did not return matches/captures');
      // The WASM engine can return an empty array on timeout. Do not label
      // such an outcome as a verified, complete empty result.
      const timedOut=performance.now()-started >= MAX_QUERY_TIME_MICROS/1000;

      const exceeded=Boolean(query.didExceedMatchLimit?.());
      const hasSyntaxErrors=typeof tree.rootNode.hasError==='function' ? Boolean(tree.rootNode.hasError()) : Boolean(tree.rootNode.hasError);
      const result={path:key,language,engine:'web-tree-sitter',mode,hasSyntaxErrors,
        matchLimitExceeded:exceeded,timedOut,limitedTo:limit,truncated:exceeded||timedOut};
      if(mode==='query'){
        result.matches=records.slice(0,limit).map(match=>({
          patternIndex:Number.isInteger(match.patternIndex)?match.patternIndex:Number(match.pattern??0),
          captures:(match.captures??[]).slice(0,MAX_CAPTURES_PER_MATCH).map(nodeCapture)
        }));
        result.moreMatches=records.length>limit;
        result.truncated ||=result.moreMatches||result.matches.some((m,i)=>(records[i]?.captures??[]).length>MAX_CAPTURES_PER_MATCH);
      }else{
        result.captures=records.slice(0,limit).map(nodeCapture);
        result.moreCaptures=records.length>limit;
        result.truncated ||=result.moreCaptures;
      }
      // Keep the whole tool result bounded, not just the number of records.
      // Preserve early captures and label every omission; no silent clipping of JSON.
      const tooLarge=()=>Buffer.byteLength(JSON.stringify(result))>MAX_RESPONSE_BYTES;
      if(mode==='query'){
        for(let i=result.matches.length-1;i>=0&&tooLarge();i--){
          while(result.matches[i].captures.length&&tooLarge()){
            result.matches[i].captures.pop();
            result.truncated=true;
          }
          if(tooLarge()){
            result.matches.pop();
            result.moreMatches=true;
            result.truncated=true;
          }
        }
      }else{
        while(result.captures.length&&tooLarge()){
          result.captures.pop();
          result.moreCaptures=true;
          result.truncated=true;
        }
      }
      if(tooLarge())throw new Error('Tree-sitter output exceeded safe response budget');
      return result;
    }catch(err){
      throw new Error(`Tree-sitter ${mode} failed: ${String(err?.message??err).slice(0,280)}`);
    }finally{
      query?.delete?.();
      tree?.delete?.();
      parser?.delete?.();
    }
  }
}
