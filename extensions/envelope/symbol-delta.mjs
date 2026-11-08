/**
 * SDL-inspired, session-local symbol delta ledger over Envelope's single CodeIndex.
 * Does not persist source bodies, invoke models, start a second parser service,
 * or claim semantic equivalence from syntactic fingerprints.
 */
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {extname,join,resolve,sep} from 'node:path';

const MAX_CAPTURE_FILES=1_000;
const MAX_CAPTURE_SYMBOLS=25_000;
const MAX_CAPTURE_BYTES=24_000_000;
const MAX_SESSIONS=4;
const HASH=/^[0-9a-f]{64}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const within=(root,path)=>root===path||path.startsWith(root+sep);
function number(value,fallback,min,max,name){
  if(value===undefined)return fallback;
  if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(name+' must be '+min+'..'+max);
  return value;
}
function assertIndex(index){
  if(!index?.files||!(index.files instanceof Map)||typeof index.checkedPath!=='function'||
    typeof index.root!=='string')throw new TypeError('current CodeIndex required');
  const root=realpathSync(index.root);
  if(root!==index.root)throw new Error('project root changed since index construction');
  return root;
}
function typeScriptNodes(index,source,path){
  const ts=index.ts;
  if(!ts?.createSourceFile)throw new Error('TypeScript AST unavailable for symbol delta');
  const ext=extname(path).toLowerCase();
  const mode=['.tsx','.jsx'].includes(ext)?ts.ScriptKind.TSX:
    ['.js','.mjs','.cjs'].includes(ext)?ts.ScriptKind.JS:ts.ScriptKind.TS;
  const sf=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,mode);
  const nodes=[];
  function visit(node,container=''){
    let kind=null,name=null;
    if(ts.isFunctionDeclaration(node))kind='function';
    else if(ts.isClassDeclaration(node))kind='class';
    else if(ts.isInterfaceDeclaration(node))kind='interface';
    else if(ts.isTypeAliasDeclaration(node))kind='type';
    else if(ts.isEnumDeclaration(node))kind='enum';
    else if(ts.isMethodDeclaration(node))kind='method';
    else if(ts.isConstructorDeclaration(node)){kind='constructor';name='constructor';}
    else if(ts.isVariableDeclaration(node))kind='variable';
    if(!name&&kind&&node.name&&ts.isIdentifier(node.name))name=node.name.text;
    const next=(kind==='class'||kind==='interface')&&name?name:container;
    if(kind&&name){
      const point=sf.getLineAndCharacterOfPosition(node.getStart(sf));
      nodes.push({name,kind,container:(kind==='method'||kind==='constructor')?container:'',
        line:point.line+1,column:point.character+1,
        fingerprint:hash(source.slice(node.getStart(sf),node.getEnd()))});
    }
    ts.forEachChild(node,child=>visit(child,next));
  }
  visit(sf);
  return nodes;
}
function readVerified(index,root,key,record,bytesSoFar){
  if(typeof key!=='string'||key!==index.checkedPath(key))throw new Error('indexed path is no longer canonical');
  if(!HASH.test(record?.contentSha256||''))throw new Error('source has no valid index SHA-256');
  const target=resolve(root,key);
  if(!within(root,target))throw new Error('indexed path escapes project root');
  let stat,canonical;
  try{stat=lstatSync(target);canonical=realpathSync(target);}catch{throw new Error('indexed source unavailable; refresh required');}
  if(stat.isSymbolicLink()||!stat.isFile()||!within(root,canonical))throw new Error('unsafe symlink or nonfile source');
  if(stat.size>MAX_CAPTURE_BYTES||bytesSoFar+stat.size>MAX_CAPTURE_BYTES)throw new RangeError('symbol snapshot verification byte budget exceeded');
  let source;
  try{source=readFileSync(target,'utf8');}catch{throw new Error('indexed source unavailable; refresh required');}
  if(hash(source)!==record.contentSha256)throw new Error('source changed since CodeIndex refresh; retry after reindex');
  return source;
}
function snapshot(index){
  const root=assertIndex(index),files=new Map();
  if(index.files.size>MAX_CAPTURE_FILES)throw new RangeError('symbol snapshot file budget exceeded');
  let bytes=0,symbols=0;
  const paths=[...index.files.keys()].sort();
  for(const path of paths){
    const record=index.files.get(path);
    const source=readVerified(index,root,path,record,bytes);
    bytes+=Buffer.byteLength(source,'utf8');
    if(bytes>MAX_CAPTURE_BYTES)throw new RangeError('symbol snapshot verification byte budget exceeded');
    const indexed=record.symbols||[];
    if(!Array.isArray(indexed))throw new Error('invalid CodeIndex symbols');
    symbols+=indexed.length;
    if(symbols>MAX_CAPTURE_SYMBOLS)throw new RangeError('symbol snapshot declaration budget exceeded');
    const ast=record.language==='typescript'?typeScriptNodes(index,source,path):null;
    if(ast&&ast.length!==indexed.length)throw new Error('symbol AST and index disagree; reindex required');
    const grouped=new Map();
    const positions=new Map();
    if(ast)for(const entry of ast){
      const point=[entry.line,entry.column,entry.kind,entry.name,entry.container].join('\0');
      if(positions.has(point))throw new Error('ambiguous AST declaration positions');
      positions.set(point,entry);
    }
    for(const symbol of indexed){
      if(typeof symbol.name!=='string'||typeof symbol.kind!=='string'||!Number.isInteger(symbol.line))
        throw new Error('invalid indexed symbol metadata');
      const id=[symbol.container||'',symbol.kind,symbol.name].join('\0');
      const pt=[symbol.line,symbol.column,symbol.kind,symbol.name,symbol.container||''].join('\0');
      const resolved=ast?positions.get(pt):null;
      if(ast&&!resolved)throw new Error('symbol AST and index positions disagree; reindex required');
      const item={path,name:symbol.name,kind:symbol.kind,container:symbol.container||'',line:symbol.line,
        fingerprint:resolved?.fingerprint||null,precision:resolved?'ast-node-text-hash':'file-hash-only'};
      if(!grouped.has(id))grouped.set(id,[]);
      grouped.get(id).push(item);
    }
    files.set(path,{sha256:record.contentSha256,language:record.language,symbols:grouped,
      importers:[...(index.importers?.get(path)||[])].sort()});
  }
  const version=hash(paths.map(p=>p+'\0'+files.get(p).sha256).join('\n'));
  const reasons=[];
  if(index.files.size>=index.maxFiles)reasons.push('index-file-cap-possibly-reached');
  if(index.lastRefresh?.unavailable?.length)reasons.push('parser-unavailable');
  return {version,files,bytes,symbols,reasons};
}
function removedSafe(root,path){
  const file=resolve(root,path);
  if(!within(root,file))throw new Error('unsafe removed source path');
  try{
    const stat=lstatSync(file),canonical=realpathSync(file);
    if(stat.isSymbolicLink()||!stat.isFile()||!within(root,canonical))throw new Error('unsafe symlink replacing indexed source');
    return false;
  }catch(error){
    if(error?.code==='ENOENT')return true;
    if(error?.message==='unsafe symlink replacing indexed source')throw error;
    throw new Error('unable to verify source absent from current index');
  }
}
function clampLabel(text){const points=Array.from(text);return {value:points.slice(0,128).join(''),truncated:points.length>128};}
function changesBetween(index,base,current){
  const items=[],reasons=[...new Set([...base.reasons,...current.reasons])];
  let byteChanges=0,unattributedFileChanges=0;
  const allPaths=[...new Set([...base.files.keys(),...current.files.keys()])].sort();
  for(const path of allPaths){
    const before=base.files.get(path),after=current.files.get(path);
    if(before?.sha256===after?.sha256)continue;
    byteChanges++;
    let physicallyDeleted=false;
    if(before&&!after){
      physicallyDeleted=removedSafe(index.root,path);
      if(!physicallyDeleted)reasons.push('file-no-longer-indexed');
    }
    const changeCountBefore=items.length;
    const importers=(after||before)?.importers||[];
    const groups=[...new Set([...(before?.symbols.keys()||[]),...(after?.symbols.keys()||[])])].sort();
    for(const id of groups){
      const b=before?.symbols.get(id)||[],a=after?.symbols.get(id)||[];
      if(!b.length&&!a.length)continue;
      const reference=a[0]||b[0];
      let change=null,precision='ast-node-text-hash';
      if(b.length>1||a.length>1){
        if(b.length===a.length&&b.map(s=>s.fingerprint).join('|')===a.map(s=>s.fingerprint).join('|'))continue;
        change='uncertain';precision='duplicate-symbol-identity';reasons.push('duplicate-symbol-identity');
      }else if(!b.length){
        change=before&&!after&&!physicallyDeleted?'uncertain':'added';
        if(!after)change='uncertain';
        precision=a[0]?.precision||'file-hash-only';
      }else if(!a.length){
        change=before&&!after&&!physicallyDeleted?'uncertain':'removed';
        precision=b[0]?.precision||'file-hash-only';
      }else if(!b[0].fingerprint||!a[0].fingerprint){
        change='uncertain';precision='file-hash-only';reasons.push('symbol-body-precision-unavailable');
      }else if(b[0].fingerprint!==a[0].fingerprint){
        change='modified';
      }
      if(!change)continue;
      if(precision==='file-hash-only')reasons.push('symbol-body-precision-unavailable');
      if(change==='uncertain'&&precision==='ast-node-text-hash')precision='file-no-longer-indexed';
      const label=clampLabel(reference.name);
      if(label.truncated)reasons.push('symbol-name-truncated');
      items.push({change,path,symbol:label.value,kind:reference.kind,
        ...(reference.container?{container:clampLabel(reference.container).value}:{}),
        ...(b[0]?{lineBefore:b[0].line}:{}),...(a[0]?{lineAfter:a[0].line}:{}),
        precision,staticImporters:importers.slice(0,3),staticImporterCount:importers.length,
        ...(label.truncated?{symbolTruncated:true}:{})});
    }
    if(items.length===changeCountBefore){unattributedFileChanges++;reasons.push('file-bytes-changed-without-attributed-declaration');}
  }
  items.sort((a,b)=>a.path.localeCompare(b.path)||a.symbol.localeCompare(b.symbol)||a.change.localeCompare(b.change));
  return {items,reasons:[...new Set(reasons)].sort(),byteChanges,unattributedFileChanges};
}
export class SymbolDeltaLedger {
  constructor(){this.baselines=new Map();}
  status(index){
    const root=assertIndex(index),base=this.baselines.get(root);
    return base?{captured:true,version:base.version,files:base.files.size,symbols:base.symbols,
      complete:base.reasons.length===0,reasons:base.reasons,sessionLocal:true}:
      {captured:false,sessionLocal:true,notes:'Call capture before editing; no implicit baseline or disk history is stored.'};
  }
  capture(index){
    const root=assertIndex(index),captured=snapshot(index);
    if(!this.baselines.has(root)&&this.baselines.size>=MAX_SESSIONS)
      throw new RangeError('symbol delta has too many concurrent project baselines');
    this.baselines.set(root,captured);
    return this.status(index);
  }
  compare(index,options={}){
    const root=assertIndex(index),base=this.baselines.get(root);
    if(!base)throw new Error('no symbol delta baseline for this project; capture before editing');
    if(options===null||typeof options!=='object'||Array.isArray(options))throw new TypeError('invalid delta options');
    const offset=number(options.offset,0,0,25000,'offset');
    const limit=number(options.limit,12,1,30,'limit');
    const maxChars=number(options.maxChars,3000,900,16000,'maxChars budget');
    const current=snapshot(index);
    const comparisonVersion=hash(base.version+'\n'+current.version);
    if(offset>0&&(!HASH.test(options.ifVersion||'')||options.ifVersion!==comparisonVersion))
      throw new Error('stale or absent comparison version cursor; restart delta from offset 0');
    const {items,reasons,byteChanges,unattributedFileChanges}=changesBetween(index,base,current);
    if(offset>items.length)throw new RangeError('offset exceeds delta size');
    const report={mode:'session-symbol-delta',provenance:'source-verified-CodeIndex',
      baselineVersion:base.version,currentVersion:current.version,comparisonVersion,
      notModified:items.length===0,totalChanges:items.length,filesWithByteChanges:byteChanges,
      filesWithoutAttributedDeclarationChanges:unattributedFileChanges,
      offset,returned:0,truncated:false,complete:reasons.length===0,reasons,
      items:[],notes:'AST node text hashes for TypeScript/JavaScript, file-level uncertainty for other parsers; static importers are not runtime impact or test coverage. notModified is declaration-only and does not prove file/behavior equivalence. No raw source or measured token savings.'};
    for(let i=offset;i<items.length&&report.items.length<limit;i++){
      report.items.push(items[i]);report.returned++;
      report.truncated=i+1<items.length;
      if(report.truncated)report.nextOffset=i+1;
      if(Buffer.byteLength(JSON.stringify(report),'utf8')>maxChars){
        report.items.pop();report.returned--;
        if(report.returned===0)throw new RangeError('maxChars budget too small for a single delta item');
        report.truncated=true;report.nextOffset=i;
        break;
      }
    }
    if(offset+report.returned<items.length){report.truncated=true;report.nextOffset=offset+report.returned;}
    else{report.truncated=false;delete report.nextOffset;}
    if(Buffer.byteLength(JSON.stringify(report),'utf8')>maxChars)throw new RangeError('maxChars budget too small for delta response');
    return report;
  }
  clear(index){this.baselines.delete(assertIndex(index));return this.status(index);}
  close(){this.baselines.clear();}
}
