/** Bounded TypeScript/JavaScript compiler facts, not execution or formal proof. */
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {basename,dirname,resolve,relative,sep} from 'node:path';
const TS_EXT=/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const sha=x=>createHash('sha256').update(x).digest('hex');
const within=(root,p)=>p===root||p.startsWith(root+sep);
const int=(x,d,min,max,name)=>{x??=d;if(!Number.isInteger(x)||x<min||x>max)throw new RangeError(name+' must be '+min+'..'+max);return x;};
const byteSize=x=>Buffer.byteLength(JSON.stringify(x),'utf8');
export function inspectTypedSource(index,{action='diagnostics',path,line,column,limit=20,maxChars=4000}={}){
 if(!index?.files||!index?.ts?.createProgram||!index.checkedPath)throw new TypeError('TypeScript CodeIndex required');
 if(!['diagnostics','symbol'].includes(action))throw new TypeError('invalid compiler evidence action');
 limit=int(limit,20,1,30,'limit');maxChars=int(maxChars,4000,900,16000,'maxChars');
 const key=index.checkedPath(path),selected=index.files.get(key);
 if(!selected||!TS_EXT.test(key))throw new Error('unsupported source: indexed TypeScript/JavaScript file required');
 if(realpathSync(index.root)!==index.root)throw new Error('project root changed');
 const root=index.root,ts=index.ts,rows=[],sources=new Map(),reasons=[];
 const selectedPaths=new Set([key]),queue=[key];
 let sourceSetTruncated=false,sourceBytesTruncated=false,scanned=0;
 // Only the selected file and bounded, indexed *forward* static imports are
 // relevant to this compiler query. Other files are not loaded, or attested.
 for(let i=0;i<queue.length;i++){
   const dependencies=[...(index.edges?.get(queue[i])||[])].filter(x=>TS_EXT.test(x)&&index.files.has(x)).sort();
   for(const dep of dependencies){
     if(selectedPaths.has(dep))continue;
     if(selectedPaths.size>=100){sourceSetTruncated=true;continue;}
     selectedPaths.add(dep);queue.push(dep);
   }
 }
 for(const sourcePath of queue){
   const record=index.files.get(sourcePath);
   if(sourcePath!==index.checkedPath(sourcePath))throw new Error('noncanonical source path');
   const absolute=resolve(root,sourcePath),st=lstatSync(absolute),canonical=realpathSync(absolute);
   if(!within(root,absolute)||!within(root,canonical)||!st.isFile()||st.isSymbolicLink())throw new Error('unsafe symlink or source path');
   if(scanned+st.size>8*1024*1024){
     if(sourcePath===key)throw new RangeError('selected TypeScript source exceeds verification byte budget');
     sourceBytesTruncated=true;continue;
   }
   const buffer=readFileSync(absolute);if(sha(buffer)!==record.contentSha256)throw new Error('source changed since index refresh; TypeScript evidence refused');
   scanned+=buffer.length;rows.push(absolute);sources.set(absolute,buffer.toString('utf8'));
 }
 if(sourceSetTruncated)reasons.push('compiler-file-budget');
 if(sourceBytesTruncated)reasons.push('compiler-source-byte-budget');
 const options={noEmit:true,allowJs:true,checkJs:true,skipLibCheck:true,strict:true,
   target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
   jsx:ts.JsxEmit.Preserve,types:[]};
 const host=ts.createCompilerHost(options,true),originalRead=host.readFile,originalExists=host.fileExists;
 // TypeScript's own installed standard-library declarations are compiler
 // runtime inputs, even if node_modules happens to live under the project.
 const compilerLib=dirname(resolve(ts.getDefaultLibFilePath(options)));
 const normalize=p=>resolve(p);
 const trustedLib=p=>within(compilerLib,p)&&/^lib[.][a-z0-9._-]+[.]d[.]ts$/i.test(basename(p));
 host.readFile=p=>{
   const abs=normalize(p);
   return sources.has(abs)?sources.get(abs):trustedLib(abs)?originalRead(p):undefined;
 };
 host.fileExists=p=>{
   const abs=normalize(p);
   return sources.has(abs)||(trustedLib(abs)&&originalExists(p));
 };
 const program=ts.createProgram(rows,options,host),sf=program.getSourceFile(resolve(root,key));
 if(!sf)throw new Error('TypeScript compiler did not load indexed source');
 if(index.lastRefresh?.unavailable?.length)reasons.push('parser-unavailable');
 if(index.lastRefresh?.discoveryTruncated)reasons.push('discovery-truncated');
 if(index.lastRefresh?.discoveryReadErrors)reasons.push('discovery-read-errors');
 if(index.files.size>=index.maxFiles)reasons.push('index-file-cap-possibly-reached');
 const diagnostics=ts.getPreEmitDiagnostics(program,sf);
 if(diagnostics.some(d=>d.code===2307||d.code===2792))reasons.push('unresolved-compiler-module');
 const general={mode:'typescript-compiler-evidence',provider:'TypeScript '+ts.version,action,path:key,
    version:sha(JSON.stringify(rows.map(p=>[relative(root,p),index.files.get(relative(root,p).split(sep).join('/'))?.contentSha256]))),
    filesLoaded:rows.length,filesSelected:selectedPaths.size,scopedToRequestedImportClosure:true,
    complete:reasons.length===0,reasons,
    notes:'Real TS compiler type facts only across indexed JS/TS files; no runtime execution, cross-language resolution, formal program proof or complete project build.'};
 if(action==='diagnostics'){
   const normalize=d=>({code:d.code,severity:ts.DiagnosticCategory[d.category]?.toLowerCase()||'unknown',
       line:d.file?.getLineAndCharacterOfPosition(d.start??0).line+1||0,
       column:d.file?.getLineAndCharacterOfPosition(d.start??0).character+1||0,
       message:ts.flattenDiagnosticMessageText(d.messageText,' ').slice(0,200)});
   const result={...general,status:'diagnostics',errors:diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).length,
     warnings:diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Warning).length,
     totalDiagnostics:diagnostics.length,truncated:diagnostics.length>limit,
     diagnostics:diagnostics.slice(0,limit).map(normalize)};
   if(byteSize(result)>maxChars)throw new RangeError('maxChars too small for diagnostic response');
   return result;
 }
 line=int(line,undefined,1,100000,'line');column=int(column,undefined,1,100000,'column');
 const lines=sf.getLineStarts();
 if(line>lines.length)throw new RangeError('compiler cursor line outside file bounds');
 const boundary=line<lines.length?lines[line]:sf.end;
 if(lines[line-1]+column-1>=boundary)throw new RangeError('compiler cursor column outside file bounds');
 const start=lines[line-1]+column-1;
 const node=ts.getTokenAtPosition(sf,start),checker=program.getTypeChecker();
 let symbol=checker.getSymbolAtLocation(node);
 if(symbol&&(symbol.flags&ts.SymbolFlags.Alias))symbol=checker.getAliasedSymbol(symbol);
 if(!symbol)return {...general,status:'unresolved',complete:false,reasons:[...reasons,'no-compiler-symbol'],type:null,declarations:[]};
 const type=checker.typeToString(checker.getTypeAtLocation(node));
 const declarations=[];
 for(const d of symbol.getDeclarations()||[]){
   const file=d.getSourceFile(),abs=resolve(file.fileName);
   if(!within(root,abs)||!sources.has(abs))continue;
   const loc=file.getLineAndCharacterOfPosition(d.getStart(file));
   declarations.push({path:relative(root,abs).split(sep).join('/'),line:loc.line+1,column:loc.character+1});
 }
 const result={...general,status:'resolved',symbol:symbol.getName().slice(0,140),type:type.slice(0,220),
   ...(type==='any'||type==='unknown'?{complete:false,reasons:[...reasons,'unresolved-any-or-unknown-type']}:{}),
   declarations:declarations.slice(0,10),truncatedDeclarations:declarations.length>10};
 if(byteSize(result)>maxChars)throw new RangeError('maxChars too small for typed symbol result');
 return result;
}
