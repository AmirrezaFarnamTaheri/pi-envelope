/**
 * Conservative, bounded AST call evidence used by the ONE shared CodeIndex.
 * These are syntactic links, not type-checked, compiled, runtime or coverage facts.
 */
import { posix } from 'node:path';

const MAX_CALLS=200;
const MAX_TEXT=128;
const clean=(value)=>typeof value==='string'?value.slice(0,MAX_TEXT):'';

function namesInTsBinding(ts,node,names){
  if(!node)return;
  if(ts.isIdentifier(node)){names.add(node.text);return;}
  if(ts.isObjectBindingPattern(node)||ts.isArrayBindingPattern(node)){
    for(const el of node.elements||[])if(ts.isBindingElement(el))namesInTsBinding(ts,el.name,names);
  }
}

/** Collect direct callees in module-level functions / class methods only. */
export function scanTsCallFacts(ts,sf){
  const declarations=[];
  const bindings=[];
  const calls=[];
  let omittedCalls=0;
  const lineAt=(node)=>{const pos=sf.getLineAndCharacterOfPosition(node.getStart(sf));return {line:pos.line+1,column:pos.character+1};};
  const exported=(node)=>node.modifiers?.some(x=>x.kind===ts.SyntaxKind.ExportKeyword)??false;
  for(const statement of sf.statements){
    if(ts.isFunctionDeclaration(statement)&&statement.name&&statement.body){
      declarations.push({name:clean(statement.name.text),line:lineAt(statement.name).line,exported:exported(statement)});
    }
    if(ts.isImportDeclaration(statement)&&statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)){
      const spec=statement.moduleSpecifier.text;
      const imported=statement.importClause?.namedBindings;
      if(imported&&ts.isNamedImports(imported))for(const item of imported.elements){
        if(item.isTypeOnly||statement.importClause?.isTypeOnly)continue;
        bindings.push({kind:'named',local:clean(item.name.text),imported:clean(item.propertyName?.text||item.name.text),spec});
      }
      if(imported&&ts.isNamespaceImport(imported)&&!statement.importClause?.isTypeOnly){
        bindings.push({kind:'namespace',local:clean(imported.name.text),spec});
      }
    }
  }
  function scanBody(body,caller,params){
    if(!body)return;
    const shadowed=new Set();
    for(const param of params||[])namesInTsBinding(ts,param.name,shadowed);
    function collectLocals(n){
      if(n!==body && (ts.isFunctionLike(n)||ts.isClassDeclaration(n)||ts.isClassExpression(n))){
        if(n.name&&ts.isIdentifier(n.name))shadowed.add(n.name.text);
        return;
      }
      if(ts.isVariableDeclaration(n))namesInTsBinding(ts,n.name,shadowed);
      if(ts.isCatchClause(n)&&n.variableDeclaration)namesInTsBinding(ts,n.variableDeclaration.name,shadowed);
      ts.forEachChild(n,collectLocals);
    }
    collectLocals(body);
    function visit(n){
      if(n!==body&&(ts.isFunctionLike(n)||ts.isClassDeclaration(n)||ts.isClassExpression(n)))return;
      if(ts.isCallExpression(n)){
        const expr=n.expression;
        let name=null,form=null,receiver=null;
        if(ts.isIdentifier(expr)&&!n.questionDotToken){name=expr.text;form='direct';}
        else if(ts.isPropertyAccessExpression(expr)&&ts.isIdentifier(expr.expression)){
          name=expr.name.text;receiver=expr.expression.text;form='member';
        }
        else if(ts.isPropertyAccessExpression(expr)) {name=expr.name.text;form='member';}
        if(name){
          if(calls.length>=MAX_CALLS)omittedCalls++;
          else {
            const loc=lineAt(expr);
            calls.push({name:clean(name),form,receiver:clean(receiver),caller,
              line:loc.line,column:loc.column,shadowed:shadowed.has(form==='direct'?name:receiver)});
          }
        }
      }
      ts.forEachChild(n,visit);
    }
    visit(body);
  }
  for(const statement of sf.statements){
    if(ts.isFunctionDeclaration(statement)&&statement.name){
      scanBody(statement.body,{name:clean(statement.name.text),line:lineAt(statement.name).line},statement.parameters);
    }
    if(ts.isClassDeclaration(statement)&&statement.name){
      for(const method of statement.members){
        if(!ts.isMethodDeclaration(method)||!method.body||!ts.isIdentifier(method.name))continue;
        scanBody(method.body,{name:clean(`${statement.name.text}.${method.name.text}`),line:lineAt(method.name).line},method.parameters);
      }
    }
  }
  return {declarations,bindings,calls,omittedCalls};
}

function atMostOne(values){return values.length===1?values[0]:null;}
function chooseTarget(file,call,files,resolveImport,goModule,goPackageFunctions){
  if(call.form==='direct'&&call.shadowed)return {reason:'shadowed'};
  const record=files.get(file);
  const declarations=record.declarations||[];
  // The same local name can be introduced by a declaration and an import.
  // Python rebinding order can be dynamic; never guess which one is callable.
  const candidates=(record.bindings||[]).filter(b=>{
    if(call.form==='direct')return b.kind==='named'&&b.local===call.name;
    return call.form==='member'&&(b.kind==='namespace'||b.kind==='package')&&b.local===call.receiver;
  });
  if(record.language==='python'&&call.form==='direct'&&candidates.length&&
    declarations.some(decl=>decl.name===call.name))return {reason:'ambiguous-target'};
  if(record.language==='python'&&call.form==='member'&&call.receiver){
    // A named import can rebind a module alias even though it is not itself a
    // namespace candidate. Likewise, module-level functions/classes bind names.
    if((record.bindings||[]).filter(b=>b.local===call.receiver).length>1)return {reason:'ambiguous-import'};
    if(declarations.some(decl=>decl.name===call.receiver)||
      record.symbols?.some(s=>s.kind==='class'&&s.name===call.receiver))return {reason:'ambiguous-target'};
  }
  let matches=[];
  if(call.form==='direct'){
    if(record.language==='go'){
      const key=`${posix.dirname(file)}\0${record.package}\0${call.name}`;
      matches=goPackageFunctions.get(key)||[];
    } else {
      for(const decl of declarations)if(decl.name===call.name)matches.push({path:file,name:decl.name,line:decl.line});
    }
    if(matches.length>1)return {reason:'ambiguous-target'};
    if(matches.length===1)return {target:matches[0],resolution:record.language==='go'?'same-package':'same-file'};
  }
  // Named imports, Python modules, TS namespaces and Go package selectors.
  if(candidates.length>1)return {reason:'ambiguous-import'};
  const binding=atMostOne(candidates);
  if(binding&&call.shadowed)return {reason:'shadowed'};
  if(!binding)return {reason:call.form==='member'?'dynamic-member':'unknown-target'};
  if(call.form==='direct'&&binding.kind==='named'&&binding.imported==='*')return {reason:'ambiguous-import'};
  if(record.language==='python'&&binding.fromPackage){
    // "from . import module" can also resolve a same-named attribute in
    // __init__. A statically declared competing name makes this ambiguous.
    const parents=resolveImport(record,file,{spec:binding.fromPackage},goModule,files);
    if(parents.some(parent=>{
      const record=files.get(parent);
      return record?.moduleBindingsTruncated || record?.moduleAssigned?.includes(binding.imported) ||
        record?.bindings?.some(b=>b.local===binding.imported) ||
        record?.symbols?.some(s=>s.name===binding.imported);
    }))return {reason:'ambiguous-target'};
  }
  const targets=resolveImport(record,file,binding,goModule,files);
  for(const targetFile of targets){
    const targetRecord=files.get(targetFile);
    if(binding.kind==='package'&&!binding.explicit&&targetRecord?.package!==binding.local)continue;
    for(const decl of targetRecord?.declarations||[]){
      if(decl.name!==(binding.kind==='named'?binding.imported:call.name))continue;
      if(targetRecord.language==='typescript'&&!decl.exported)continue;
      if(targetRecord.language==='go'&&!/^[A-Z]/.test(decl.name))continue;
      matches.push({path:targetFile,name:decl.name,line:decl.line});
    }
  }
  // Ambiguous re-exports, namespace objects, and unavailable definitions do not yield edges.
  if(matches.length===1)return {target:matches[0],resolution:record.language==='python'&&binding.kind==='namespace'?'python-module-import':'named-import'};
  return {reason:matches.length>1?'ambiguous-target':'unknown-target'};
}

/** Link cached per-file facts without reparsing files, with deterministic source order. */
export function buildCallEvidence(files,{resolveModule,resolvePythonModule,resolveGoPackage,goModule}={}){
  const outgoing=new Map(),incoming=new Map(),unresolved=new Map();
  let linkedCalls=0,unresolvedCalls=0,callSites=0,omittedCalls=0;
  const available=new Set(files.keys());
  const goPackageFunctions=new Map(),importCache=new Map();
  for(const [path,record] of files)if(record.language==='go'&&record.package){
    for(const decl of record.declarations||[]){
      const key=`${posix.dirname(path)}\0${record.package}\0${decl.name}`;
      if(!goPackageFunctions.has(key))goPackageFunctions.set(key,[]);
      goPackageFunctions.get(key).push({path,name:decl.name,line:decl.line});
    }
  }
  const resolveImport=(record,from,binding,moduleName)=>{
    const cacheKey=`${record.language}\0${from}\0${binding.spec}`;
    if(importCache.has(cacheKey))return importCache.get(cacheKey);
    let targets=[];
    if(record.language==='typescript'){
      const target=resolveModule(from,binding.spec,available);
      if(target)targets=[target];
    }
    if(record.language==='python')targets=resolvePythonModule(from,binding.spec,available);
    if(record.language==='go')targets=resolveGoPackage(binding.spec,moduleName,available);
    importCache.set(cacheKey,targets);
    return targets;
  };
  for(const [path,record] of files){
    const resolved=[],missing=[];
    omittedCalls+=record.omittedCalls||0;
    for(const call of record.calls||[]){
      callSites++;
      const base={path,caller:call.caller,name:call.name,form:call.form,line:call.line,column:call.column};
      const verdict=chooseTarget(path,call,files,resolveImport,goModule,goPackageFunctions);
      if(verdict.target){
        const edge={...base,target:verdict.target,resolution:verdict.resolution};
        resolved.push(edge);linkedCalls++;
        if(!incoming.has(edge.target.path))incoming.set(edge.target.path,[]);
        incoming.get(edge.target.path).push(edge);
      }else{missing.push({...base,reason:verdict.reason});unresolvedCalls++;}
    }
    outgoing.set(path,resolved);
    unresolved.set(path,missing);
  }
  return {outgoing,incoming,unresolved,callSites,linkedCalls,unresolvedCalls,omittedCalls};
}

export function reportCalls(index,path,{symbol,limit=15}={}){
  const key=index.checkedPath(path);
  if(!Number.isInteger(limit)||limit<1||limit>40)throw new RangeError('limit must be an integer between 1 and 40');
  if(symbol!==undefined&&(typeof symbol!=='string'||!symbol.trim()||symbol.length>128))throw new TypeError('symbol must be a nonempty name of at most 128 characters');
  const outgoing=(index.callGraph?.outgoing.get(key)||[]).filter(x=>!symbol||x.caller?.name===symbol);
  const incoming=(index.callGraph?.incoming.get(key)||[]).filter(x=>!symbol||x.target.name===symbol);
  const unresolved=(index.callGraph?.unresolved.get(key)||[]).filter(x=>!symbol||x.caller?.name===symbol);
  const truncated=outgoing.length>limit||incoming.length>limit||unresolved.length>limit||((index.files.get(key).omittedCalls||0)>0);
  const record=index.files.get(key);
  const incompleteReasons=[...(record.diagnostics?.length?['syntax-errors']:[]),
    ...(record.omittedCalls?['call-fact-limit']:[])];
  return {path:key,mode:'static-syntax-call-evidence',symbol:symbol||null,
    complete:incompleteReasons.length===0,incompleteReasons,
    outgoing:outgoing.slice(0,limit),incoming:incoming.slice(0,limit),unresolved:unresolved.slice(0,limit),
    totalOutgoing:outgoing.length,totalIncoming:incoming.length,totalUnresolved:unresolved.length,
    omittedCallSites:index.files.get(key).omittedCalls||0,truncated,
    notes:'AST syntactic candidates only. Links require unique declarations/static imports; dynamic dispatch, shadowing, unresolved symbols and incomplete parser data are not claimed as runtime calls.'};
}
