/**
 * Shared TS/JS + opt-in Python/Go AST index for Envelope.
 * Inspired by repomap's structural outlines, open-codebase-index's bounded
 * evidence retrieval and pi-shazam's verification/impact separation.
 * Deliberately conservative: import edges are static relative modules only.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { parseLanguageBatch } from './parser-bridge.mjs';
import { scanTsCallFacts, buildCallEvidence, reportCalls } from './code-call-evidence.mjs';

const SOURCE_SUFFIXES = ['.ts','.tsx','.js','.jsx','.mts','.cts','.mjs','.cjs'];
const PYTHON_SUFFIXES = new Set(['.py','.pyi']);
const GO_SUFFIXES = new Set(['.go']);
const SOURCE_SET = new Set([...SOURCE_SUFFIXES,...PYTHON_SUFFIXES,...GO_SUFFIXES]);
const languageFor = (path) => PYTHON_SUFFIXES.has(extname(path).toLowerCase()) ? 'python' : GO_SUFFIXES.has(extname(path).toLowerCase()) ? 'go' : 'typescript';
const DEFAULT_SKIP = new Set(['.git','node_modules','.next','dist','build','coverage','.turbo','vendor','.cache']);
const SKIP_SUFFIXES = ['.min.js','.bundle.js'];
const SLASH = (path) => path.split(sep).join('/');
const MAX_DIAGNOSTICS = 30;

function isWithin(root, path) { return path === root || path.startsWith(root + sep); }
function isSource(path) {
  return SOURCE_SET.has(extname(path).toLowerCase()) && !SKIP_SUFFIXES.some((x)=>path.endsWith(x));
}

/** Parse only simple folder exclusions for the no-Git fallback; Git itself owns full gitignore semantics. */
function ignoredDirectories(root) {
  const ignored=new Set(DEFAULT_SKIP);
  try {
    const lines=readFileSync(join(root,'.gitignore'),'utf8').split(/\r?\n/);
    for(const line of lines){
      const pattern=line.trim();
      if (!pattern || pattern.startsWith('#') || pattern.startsWith('!') || /[*?\[\]{}]/.test(pattern)) continue;
      if (pattern.endsWith('/')) ignored.add(pattern.replace(/^\//,'').replace(/\/$/,''));
    }
  } catch { /* no .gitignore */ }
  return ignored;
}

/** Discover candidates and report a potentially truncated source universe BEFORE
 * unsupported-language and file-size filters can shrink the parsed file count.
 */
function discoverByWalking(root,maxFiles) {
  const skip=ignoredDirectories(root),found=[],stack=[{dir:root,rel:''}];
  let readErrors=0;
  while(stack.length&&found.length<maxFiles){
    const {dir,rel}=stack.pop();
    let entries;
    try{entries=readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));}
    catch{readErrors++;continue;}
    for(const entry of entries){
      const key=rel?`${rel}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){
        if(!skip.has(entry.name)&&!skip.has(key))stack.push({dir:join(dir,entry.name),rel:key});
      }else if(entry.isFile()&&isSource(key))found.push(key);
      if(found.length>=maxFiles)break;
    }
  }
  return {paths:found.sort(),truncated:found.length>=maxFiles,readErrors};
}

/** Git supplies the complete candidate count before applying the public limit.
 * When a fallback walk is necessary, inaccessible directories are reported.
 */
function discoverFromGit(root,maxFiles){
  const result=spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{
    cwd:root,encoding:'utf8',timeout:5000,maxBuffer:8*1024*1024
  });
  if(result.status!==0)return null;
  const candidates=[...new Set(result.stdout.split('\0').filter(isSource))].sort();
  return {paths:candidates.slice(0,maxFiles),truncated:candidates.length>=maxFiles,readErrors:0};
}

function scanSymbols(ts,sf,path) {
  const symbols=[];
  function visit(node,container='') {
    let kind=null,name=null;
    if(ts.isFunctionDeclaration(node)) kind='function';
    else if(ts.isClassDeclaration(node)) kind='class';
    else if(ts.isInterfaceDeclaration(node)) kind='interface';
    else if(ts.isTypeAliasDeclaration(node)) kind='type';
    else if(ts.isEnumDeclaration(node)) kind='enum';
    else if(ts.isMethodDeclaration(node)) kind='method';
    else if(ts.isConstructorDeclaration(node)) {kind='constructor';name='constructor';}
    else if(ts.isVariableDeclaration(node)) kind='variable';
    if (!name && kind && node.name && ts.isIdentifier(node.name)) name=node.name.text;
    const nextContainer=(kind==='class'||kind==='interface') && name ? name:container;
    if(kind && name){
      const start=sf.getLineAndCharacterOfPosition(node.getStart(sf));
      symbols.push({path,name,kind,container:kind==='method'||kind==='constructor' ? container : '',line:start.line+1,column:start.character+1});
    }
    ts.forEachChild(node,child=>visit(child,nextContainer));
  }
  visit(sf);
  return symbols;
}

function scanImports(ts,sf) {
  const refs=[];
  ts.forEachChild(sf,node=>{
    if ((ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) refs.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      refs.push(node.moduleReference.expression.text);
    }
  });
  return [...new Set(refs)];
}

function resolveModule(from,spec,available){
  if(!spec.startsWith('.')) return null;
  const base=posix.normalize(posix.join(posix.dirname(from),spec));
  if (base === '..' || base.startsWith('../') || posix.isAbsolute(base)) return null;
  const ext=extname(base);
  const candidates=[];
  if (ext) {
    candidates.push(base);
    if(['.js','.jsx','.mjs','.cjs'].includes(ext)){
      const without=base.slice(0,-ext.length);
      candidates.push(`${without}.ts`,`${without}.tsx`,`${without}.mts`,`${without}.cts`);
    }
  } else {
    for(const suffix of SOURCE_SUFFIXES) candidates.push(base+suffix);
    for(const suffix of SOURCE_SUFFIXES) candidates.push(base+'/index'+suffix);
  }
  return candidates.find(candidate=>available.has(candidate))||null;
}


/** Python import resolution only links actual indexed local module files. */
function resolvePythonModule(from, spec, available) {
  if(typeof spec!=='string'||!spec||spec.length>512)return [];
  const dots=/^\.+/.exec(spec)?.[0].length||0;
  const names=spec.slice(dots).split('.').filter(Boolean);
  let parts=[];
  if(dots){
    const folder=posix.dirname(from);
    const segments=folder==='.'?[]:folder.split('/');
    if(dots>segments.length)return []; // Relative imports cannot ascend beyond the enclosing package.
    parts=segments.slice(0, segments.length-(dots-1));
  }
  parts.push(...names);
  if(!parts.length||parts.some(part=>part==='..'||part==='.'||!part))return [];
  const key=parts.join('/');
  const candidates=[`${key}.py`,`${key}.pyi`,`${key}/__init__.py`,`${key}/__init__.pyi`];
  return candidates.filter(candidate=>available.has(candidate));
}

/** An existing but ignored, oversized, unreadable or unparsed Python initializer
 * cannot be treated like an absent namespace-package initializer. */
function initializerUnavailable(root,from,spec,files){
  const dots=/^\.+/.exec(spec)?.[0].length||0;
  if(!dots)return false;
  const folder=posix.dirname(from);
  const segments=folder==='.'?[]:folder.split('/');
  if(dots>segments.length)return true;
  const names=spec.slice(dots).split('.').filter(Boolean);
  const base=[...segments.slice(0,segments.length-(dots-1)),...names].join('/');
  for(const suffix of ['__init__.py','__init__.pyi']){
    const key=base?`${base}/${suffix}`:suffix;
    if(files.has(key)){
      const record=files.get(key);
      if(record?.diagnostics?.length || record?.moduleBindingsTruncated)return true;
      continue;
    }
    try{lstatSync(join(root,key));return true;}catch(err){if(err?.code!=='ENOENT')return true;}
  }
  return false;
}

/** Go import edges are package-level: all indexed .go files in the imported module directory. */
function goModule(root) {
  try {
    const text=readFileSync(join(root,'go.mod'),'utf8').slice(0,100_000);
    const name=/^\s*module\s+([^\s]+)\s*$/m.exec(text)?.[1];
    return name&&name.length<=256 ? name.replace(/^['\"]|['\"]$/g,'') : null;
  } catch {return null;}
}
function resolveGoPackage(spec,moduleName,available){
  if(!moduleName || (spec!==moduleName && !spec.startsWith(moduleName+'/')))return [];
  const key=spec===moduleName?'':spec.slice(moduleName.length+1);
  const folder=posix.normalize(key||'.');
  if(folder==='..'||folder.startsWith('../')||posix.isAbsolute(folder))return [];
  return [...available].filter(path=>path.endsWith('.go')&&posix.dirname(path)===folder).sort();
}

function parseDiagnostics(ts,sf) {
  return (sf.parseDiagnostics||[]).slice(0,MAX_DIAGNOSTICS).map(d=>{
    const position=sf.getLineAndCharacterOfPosition(d.start||0);
    return {line:position.line+1,column:position.character+1,code:d.code,
      message:ts.flattenDiagnosticMessageText(d.messageText,' ')};
  });
}

export class CodeIndex {
  constructor(root,{ts,maxFiles=1500,maxBytesPerFile=1_000_000,languagesEnabled=false,parserOptions={},parser=parseLanguageBatch}={}) {
    if(!ts?.createSourceFile) throw new Error('TypeScript compiler API is required for AST indexing');
    this.root=realpathSync(resolve(root));
    this.ts=ts;
    this.maxFiles=maxFiles;
    this.maxBytesPerFile=maxBytesPerFile;
    this.languagesEnabled=languagesEnabled;
    this.parserOptions=parserOptions;
    this.parser=parser;
    this.lastRefresh=null;
    this.lastRevision=null;
    this.files=new Map();
    this.edges=new Map();
    this.importers=new Map();
    this.callGraph=null;
  }

  /** Refuse paths outside the root, ignored/unindexed paths and symlinks. */
  checkedPath(requested) {
    if (typeof requested!=='string' || !requested.trim()) throw new TypeError('source path required');
    const absolute=resolve(this.root,requested);
    if(!isWithin(this.root,absolute)) throw new Error('path outside project root');
    let canonical;
    try {
      if(lstatSync(absolute).isSymbolicLink()) throw new Error('symlink source paths are not allowed');
      canonical=realpathSync(absolute);
    } catch(err) {
      if(err?.message==='symlink source paths are not allowed')throw err;
      throw new Error('source file unavailable or not indexed');
    }
    if(!isWithin(this.root,canonical)) throw new Error('path outside project root');
    const key=SLASH(relative(this.root,canonical));
    if(!this.files.has(key)) throw new Error(`source is not indexed or is ignored: ${key}`);
    return key;
  }

  refresh() {
    const revisionCommand=spawnSync('git',['rev-parse','--verify','HEAD^{commit}'],{cwd:this.root,encoding:'utf8',timeout:5000});
    const revision=revisionCommand.status===0?revisionCommand.stdout.trim():null;
    // Preserve parsed records across Git revisions only when their actual bytes match.
    this.lastRevision=revision;
    const discovery=discoverFromGit(this.root,this.maxFiles)??discoverByWalking(this.root,this.maxFiles);
    const discovered=discovery.paths;
    const next=new Map();
    const pending={python:[],go:[]};
    const unavailable=[];
    let reparsed=0;
    let reused=0;
    for (const key of discovered) {
      if(!isSource(key) || key.split('/').some(part=>DEFAULT_SKIP.has(part))) continue;
      const language=languageFor(key);
      if(language!=='typescript'&&!this.languagesEnabled)continue;
      const absolute=resolve(this.root,key);
      if(!isWithin(this.root,absolute))continue;
      let stat;
      try {stat=lstatSync(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>this.maxBytesPerFile)continue;
        if(!isWithin(this.root,realpathSync(absolute)))continue;
      } catch {continue;}
      const signature=`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const old=this.files.get(key);
      // Fast path: stable size/mtime/ctime means the same prior bytes.
      // If timestamps change, hash the bytes before deciding to reparse.
      if(old?.signature===signature && old.language===language){
        next.set(key,old);
        reused++;
        continue;
      }
      let source;
      try{source=readFileSync(absolute,'utf8');}
      catch{continue;}
      const contentSha256=createHash('sha256').update(source).digest('hex');
      if(old?.contentSha256===contentSha256 && old.language===language){
        next.set(key,{...old,signature});
        reused++;
        continue;
      }
      if(language!=='typescript'){
        pending[language].push({path:key,content:source,signature,contentSha256});
        continue;
      }
      const mode=['.tsx','.jsx'].includes(extname(key))?this.ts.ScriptKind.TSX:
        ['.js','.mjs','.cjs'].includes(extname(key))?this.ts.ScriptKind.JS:this.ts.ScriptKind.TS;
      const sf=this.ts.createSourceFile(key,source,this.ts.ScriptTarget.Latest,true,mode);
      const diagnostics=parseDiagnostics(this.ts,sf);
      const callFacts=diagnostics.length?{declarations:[],bindings:[],calls:[],omittedCalls:0}:scanTsCallFacts(this.ts,sf);
      next.set(key,{path:key,signature,contentSha256,language,symbols:scanSymbols(this.ts,sf,key),imports:scanImports(this.ts,sf),
        diagnostics,...callFacts});
      reparsed++;
    }
    // Each optional language starts at most one fixed-argv subprocess per refresh.
    for(const language of ['python','go']){
      const files=pending[language];if(!files.length)continue;
      const inputSize=Buffer.byteLength(JSON.stringify({files}));
      if(inputSize>3_000_000){unavailable.push({language,reason:'parser batch exceeds 3MB cap'});continue;}
      const response=this.parser(language,files.map(({path,content})=>({path,content})),this.parserOptions);
      if(!response.ok){unavailable.push({language,reason:response.reason});continue;}
      for(let i=0;i<files.length;i++){
        const result=response.records[i],file=files[i];
        if(!result||result.path!==file.path)continue;
        next.set(file.path,{path:file.path,signature:file.signature,contentSha256:file.contentSha256,language,
          symbols:result.symbols,imports:result.imports,diagnostics:result.diagnostics,
          declarations:result.declarations||[],bindings:result.bindings||[],calls:result.calls||[],
          moduleAssigned:result.moduleAssigned||[],moduleBindingsTruncated:result.moduleBindingsTruncated||false,
          package:result.package||null,omittedCalls:result.omittedCalls||0});
        reparsed++;
      }
    }
    const removed=[...this.files.keys()].filter(key=>!next.has(key)).length;
    this.files=next;
    this.edges=new Map();
    this.importers=new Map();
    const available=new Set(this.files.keys());
    const moduleName=goModule(this.root);
    for(const [file,record] of this.files){
      const imports=new Set(record.imports.flatMap(spec=>{
        if(record.language==='python')return resolvePythonModule(file,spec,available);
        if(record.language==='go')return resolveGoPackage(spec,moduleName,available);
        const target=resolveModule(file,spec,available);
        return target?[target]:[];
      }).filter(target=>target!==file));
      this.edges.set(file,imports);
      for(const imported of imports){
        if(!this.importers.has(imported))this.importers.set(imported,new Set());
        this.importers.get(imported).add(file);
      }
    }
    this.callGraph=buildCallEvidence(this.files,{resolveModule,resolvePythonModule,resolveGoPackage,goModule:moduleName,
      initializerUnavailable:(file,spec)=>initializerUnavailable(this.root,file,spec,this.files)});
    const languages={};
    for(const record of this.files.values())languages[record.language]=(languages[record.language]||0)+1;
    this.lastRefresh={revision:this.lastRevision,files:this.files.size,symbols:[...this.files.values()].reduce((n,r)=>n+r.symbols.length,0),
      reparsed,reused,removed,languages,unavailable,
      discoveryTruncated:discovery.truncated,discoveryReadErrors:discovery.readErrors,
      callSites:this.callGraph.callSites,
      linkedCalls:this.callGraph.linkedCalls,unresolvedCalls:this.callGraph.unresolvedCalls,omittedCalls:this.callGraph.omittedCalls};
    return this.lastRefresh;
  }

  languageStatus(){
    return {enabled:this.languagesEnabled,parserFamilies:['typescript',...(this.languagesEnabled?['python','go']:[])],
      ...(this.lastRefresh||{files:0,symbols:0,languages:{},unavailable:[]})};
  }

  calls(path,options={}){return reportCalls(this,path,options);}

  lookup(query,{limit=15}={}) {
    const needle=String(query??'').trim().toLowerCase();
    if(!needle)return [];
    const matches=[];
    for(const {symbols} of this.files.values())for(const symbol of symbols){
      const s=symbol.name.toLowerCase();
      if(s.includes(needle) || symbol.path.toLowerCase().includes(needle)) {
        matches.push({ ...symbol, score:s===needle?0:s.startsWith(needle)?1:2 });
      }
    }
    return matches.sort((a,b)=>a.score-b.score||a.path.localeCompare(b.path)||a.line-b.line)
      .slice(0,Math.max(1,Math.min(limit,50))).map(({score,...s})=>s);
  }

  impact(path,{depth=3}={}) {
    const key=this.checkedPath(path);
    const bounded=Math.max(1,Math.min(Number.isInteger(depth)?depth:3,5));
    const visited=new Set([key]);
    let queue=[{path:key,distance:0}], affected=[];
    while(queue.length){
      const current=queue.shift();
      if(current.distance>=bounded)continue;
      for(const importer of [...(this.importers.get(current.path)||[])].sort()){
        if(visited.has(importer))continue;
        visited.add(importer);
        const entry={path:importer,distance:current.distance+1,via:current.path};
        affected.push(entry);queue.push(entry);
      }
    }
    affected.sort((a,b)=>a.distance-b.distance||a.path.localeCompare(b.path));
    return {path:key,mode:'static-imports',importers:affected,notes:'Evidence is statically resolved imports: relative TS/JS, local Python modules, or Go module package imports; never runtime calls or test coverage.'};
  }

  overview({limit=12}={}) {
    const files=[...this.files.keys()];
    const count=files.length;
    if(!count)return {files:0,symbols:0,topFiles:[],graph:'static relative imports and bounded local module imports'};
    let rank=new Map(files.map(f=>[f,1/count]));
    for(let i=0;i<12;i++){
      const next=new Map(files.map(f=>[f,(1-0.85)/count]));
      let dangling=0;
      for(const [source,targets] of this.edges){
        if(!targets.size){dangling+=rank.get(source);continue;}
        const share=rank.get(source)*0.85/targets.size;
        for(const target of targets)next.set(target,next.get(target)+share);
      }
      for(const file of files)next.set(file,next.get(file)+0.85*dangling/count);
      rank=next;
    }
    const bounded=Math.max(1,Math.min(Number.isInteger(limit)?limit:12,30));
    const topFiles=files.sort((a,b)=>rank.get(b)-rank.get(a)||a.localeCompare(b)).slice(0,bounded)
      .map(f=>({path:f,symbols:this.files.get(f).symbols.length,importers:this.importers.get(f)?.size||0,
        symbolsPreview:this.files.get(f).symbols.slice(0,5).map(s=>`${s.kind} ${s.name}:${s.line}`)}));
    return {files:count,symbols:[...this.files.values()].reduce((n,r)=>n+r.symbols.length,0),topFiles,
      graph:'PageRank over statically resolved imports for indexed languages'};
  }

  verify(path,{content}={}) {
    const key=this.checkedPath(path);
    if(content!==undefined && typeof content!=='string')throw new TypeError('proposed content must be text');
    const source=content===undefined?readFileSync(join(this.root,key),'utf8'):content;
    if(Buffer.byteLength(source)>this.maxBytesPerFile)throw new RangeError('source exceeds per-file parser limit');
    const language=languageFor(key);
    if(language!=='typescript'){
      const response=this.parser(language,[{path:key,content:source}],this.parserOptions);
      if(!response.ok)throw new Error(`${language} parser unavailable: ${response.reason}`);
      const diagnostics=response.records[0].diagnostics;
      return {path:key,ok:diagnostics.length===0,mode:'syntax-only',parser:language,diagnostics};
    }
    const ext=extname(key);
    const mode=['.tsx','.jsx'].includes(ext)?this.ts.ScriptKind.TSX:
      ['.js','.mjs','.cjs'].includes(ext)?this.ts.ScriptKind.JS:this.ts.ScriptKind.TS;
    const sf=this.ts.createSourceFile(key,source,this.ts.ScriptTarget.Latest,true,mode);
    const diagnostics=parseDiagnostics(this.ts,sf);
    return {path:key,ok:diagnostics.length===0,mode:'syntax-only',diagnostics};
  }
}
