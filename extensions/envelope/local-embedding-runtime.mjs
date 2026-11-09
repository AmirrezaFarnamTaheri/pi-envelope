/** Human-only, operator-pinned local embedding subprocess: no model shipped or downloaded. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {O_WRONLY,O_CREAT,O_EXCL,O_NOFOLLOW} from 'node:constants';
import {lstatSync,realpathSync,readFileSync,mkdirSync,mkdtempSync,rmSync,writeSync,openSync,closeSync,renameSync,unlinkSync,accessSync,constants,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,isAbsolute,sep} from 'node:path';

const MAX_FILES=64,MAX_VERIFIED_BYTES=4*1024*1024,MAX_PAYLOAD_BYTES=450000;
const MAX_OUTPUT_BYTES=1150000,MAX_MANIFEST_BYTES=1024*1024;
const SHA=/^[0-9a-f]{64}$/;
const hash=x=>createHash('sha256').update(x).digest('hex');
const inside=(root,p)=>root===p||p.startsWith(root+sep);
const bufferSize=x=>Buffer.byteLength(JSON.stringify(x),'utf8');
function checkVector(v,dim){
 if(!Array.isArray(v)||v.length!==dim)throw new Error('encoder vector dimensions invalid');
 let sum=0;
 for(const n of v){if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1_000_000)throw new Error('encoder vector contains non-finite or invalid values');sum+=n*n;}
 if(!Number.isFinite(sum)||sum<=1e-20)throw new Error('encoder vector has invalid norm');
}
function checkModel(response){
 if(!response||response.schema!==1||typeof response.model!=='string'||!response.model.trim()||response.model.length>100||/[\u0000-\u001f\u007f]/.test(response.model)||
 !Number.isInteger(response.dimensions)||response.dimensions<8||response.dimensions>1024)throw new Error('encoder returned invalid model/dimension metadata');
}
function rootOf(index){
 if(!index?.files||!(index.files instanceof Map)||typeof index.checkedPath!=='function'||typeof index.root!=='string')throw new TypeError('current CodeIndex required');
 const root=realpathSync(index.root);
 if(index.root!==root)throw new Error('indexed project root changed');
 return root;
}
/** Refuse destructive indexing when the source scope may be partial.
 * CodeIndex silently bounds discoveries and can omit unavailable parser families.
 * A saved manifest must not be pruned against that incomplete set.
 */
function checkedIndexScope(index){
 const state=index.lastRefresh;
 if(!state||!Array.isArray(state.unavailable)||state.unavailable.length)
   throw new Error('incomplete embedding index: refresh/parser unavailable; do not prune vectors');
 if(!Number.isInteger(index.maxFiles)||index.maxFiles<1||index.files.size>=index.maxFiles)
   throw new Error('incomplete embedding index: discovery may have reached the file cap');
 if(!Number.isInteger(index.maxBytesPerFile)||index.maxBytesPerFile<1)
   throw new Error('invalid embedding indexing byte scope');
 return {languagesEnabled:index.languagesEnabled===true,maxFiles:index.maxFiles,maxBytesPerFile:index.maxBytesPerFile};
}
/** Persist the bounded index policy to distinguish real deletions from lost coverage. */
function checkScopeEqual(saved,current){
 if(!saved||typeof saved!=='object'||Array.isArray(saved)||
    typeof saved.languagesEnabled!=='boolean'||!Number.isInteger(saved.maxFiles)||
    !Number.isInteger(saved.maxBytesPerFile))
   throw new Error('legacy embeddings manifest missing index scope; explicit replace required');
 if(saved.languagesEnabled!==current.languagesEnabled||
    saved.maxFiles!==current.maxFiles||saved.maxBytesPerFile!==current.maxBytesPerFile)
   throw new Error('embedding indexing scope mismatch; explicit replace required');
}
function checkedEncoder(executable,root){
 if(typeof executable!=='string'||!isAbsolute(executable)||executable.length>1024||/[\u0000-\u001f\u007f]/.test(executable))throw new Error('pinned absolute encoder executable required');
 let file,st;
 try {st=lstatSync(executable);file=realpathSync(executable);}catch{throw new Error('encoder executable unavailable');}
 if(!st.isFile()||st.isSymbolicLink()||inside(root,resolve(executable))||inside(root,file))throw new Error('unsafe encoder executable: select trusted non-symlink file outside project');
 if(process.platform!=='win32')accessSync(file,constants.X_OK);
 return file;
}
function readSource(index,root,{include=()=>true,allowEmpty=false}={}){
 if((!allowEmpty&&index.files.size<1)||index.files.size>MAX_FILES)throw new RangeError('embedding source file cap exceeded; capture smaller index');
 const documents=[],provenance=[];let verifiedBytes=0,truncatedTexts=0;
 for(const [path,record] of [...index.files].sort(([a],[b])=>a.localeCompare(b))){
   if(typeof path!=='string'||path!==index.checkedPath(path)||!SHA.test(record?.contentSha256||''))throw new Error('unsafe or unverified indexed source');
   const absolute=resolve(root,path),stat=lstatSync(absolute),canonical=realpathSync(absolute);
   if(!inside(root,absolute)||!inside(root,canonical)||stat.isSymbolicLink()||!stat.isFile())throw new Error('unsafe source symlink or non-file');
   verifiedBytes+=stat.size;
   if(verifiedBytes>MAX_VERIFIED_BYTES)throw new RangeError('embedding source byte budget exceeded');
   const source=readFileSync(absolute);
   if(hash(source)!==record.contentSha256)throw new Error('source changed since CodeIndex refresh');
   provenance.push({path,sha256:record.contentSha256});
   if(include(path,record.contentSha256)){
     const text=source.toString('utf8'),slice=text.slice(0,6000);
     if(slice.length<text.length)truncatedTexts++;
     documents.push({path,text:slice});
   }
 }
 const request={schema:1,task:'embed-documents',documents};
 if(bufferSize(request)>MAX_PAYLOAD_BYTES)throw new RangeError('embedding request byte budget exceeded');
 return {request,provenance,verifiedBytes,truncatedTexts};
}
function checkUnchanged(index,root,provenance){
 if(index.files.size!==provenance.length)throw new Error('indexed source set changed during embedding; refresh required');
 for(const {path,sha256} of provenance){
   try{
     const record=index.files.get(path);
     if(!record||record.contentSha256!==sha256||index.checkedPath(path)!==path)throw new Error('changed');
     const absolute=resolve(root,path),stat=lstatSync(absolute),canonical=realpathSync(absolute);
     if(!stat.isFile()||stat.isSymbolicLink()||!inside(root,canonical)||hash(readFileSync(absolute))!==sha256)throw new Error('changed');
   }catch{throw new Error('source changed during embedding; retry after index refresh');}
 }
}
function privateManifestPath(root,{create=false}={}){
 const dir=join(root,'.envelope'),target=join(dir,'embeddings.json');
 if(!existsSync(dir)){
   if(!create)return target;
   mkdirSync(dir,{mode:0o700});
 }
 const stat=lstatSync(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||!inside(root,realpathSync(dir)))throw new Error('unsafe embedding output directory symlink');
 if(existsSync(target)){
   const file=lstatSync(target);
   if(!file.isFile()||file.isSymbolicLink())throw new Error('unsafe embeddings manifest: non-file or symlink');
 }
 return target;
}
function readManifest(root){
 const target=privateManifestPath(root,{create:false});
 let raw,stat,manifest;
 try{
   stat=lstatSync(target);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size<20||stat.size>MAX_MANIFEST_BYTES)throw new Error('unsafe');
   raw=readFileSync(target,'utf8');
   manifest=JSON.parse(raw);
 }catch{throw new Error('missing or invalid embeddings manifest; build explicitly first');}
 checkModel(manifest);
 if(!Array.isArray(manifest.entries)||manifest.entries.length>MAX_FILES)throw new Error('invalid embedding manifest entry count');
 const seen=new Set(),entries=[];
 for(const entry of manifest.entries){
   const path=entry?.path;
   if(typeof path!=='string'||path.length<1||path.length>256||path.startsWith('/')||
      path.includes('\\')||/[\u0000-\u001f\u007f]/.test(path)||
      path.split('/').some(part=>!part||part==='.'||part==='..')||
      !SHA.test(entry?.sha256||'')||seen.has(path))throw new Error('invalid or duplicate embedding manifest source');
   checkVector(entry.vector,manifest.dimensions);
   seen.add(path);entries.push({path,sha256:entry.sha256,vector:entry.vector});
 }
 return {data:{schema:1,model:manifest.model,dimensions:manifest.dimensions,entries,indexScope:manifest.indexScope},manifestHash:hash(raw)};
}
function outputResponse(response,sourceFiles){
 checkModel(response);
 if(!Array.isArray(response.entries)||response.entries.length!==sourceFiles.length)throw new Error('encoder returned missing or extra document embeddings');
 const expected=new Set(sourceFiles.map(f=>f.path)),seen=new Set(),vectors=new Map();
 for(const x of response.entries){
  if(!x||typeof x.path!=='string'||!expected.has(x.path)||seen.has(x.path))throw new Error('encoder returned duplicate or unknown source path');
  checkVector(x.vector,response.dimensions);seen.add(x.path);vectors.set(x.path,x.vector);
 }
 return {schema:1,model:response.model,dimensions:response.dimensions,
   entries:sourceFiles.map(x=>({...x,vector:vectors.get(x.path)}))};
}
function writeManifest(root,payload,{replace=false,expectedManifestHash}={}){
 const target=privateManifestPath(root,{create:true});
 if(existsSync(target)&&!replace)throw new Error('embeddings manifest already exists; explicit replace required');
 if(bufferSize(payload)>MAX_MANIFEST_BYTES)throw new RangeError('embedding manifest byte budget exceeded');
 const serialized=JSON.stringify(payload);
 const tmp=join(dirname(target),'.embeddings-'+process.pid+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'.tmp');
 let fd;
 try{
  fd=openSync(tmp,O_WRONLY|O_CREAT|O_EXCL|(O_NOFOLLOW||0),0o600);
  const bytes=Buffer.from(serialized,'utf8');let at=0;
  while(at<bytes.length)at+=writeSync(fd,bytes,at,bytes.length-at);
  closeSync(fd);fd=undefined;
  if(existsSync(target)&&!replace)throw new Error('embeddings manifest already exists; explicit replace required');
  privateManifestPath(root,{create:false});
  if(expectedManifestHash!==undefined){
    if(!SHA.test(expectedManifestHash)||!existsSync(target)||hash(readFileSync(target))!==expectedManifestHash)
      throw new Error('embeddings manifest changed during sync; retry with current manifest');
  }
  renameSync(tmp,target);
 }catch(error){if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch{}throw error;}
 return {manifestHash:hash(serialized)};
}

async function callEncoder(binary,root,input,{timeoutMs,signal,spawnProcess,controllers}={}){
 const temp=mkdtempSync(join(tmpdir(),'envelope-encoder-home-'));
 const controller=new AbortController();controllers.add(controller);
 const env={PATH:process.env.PATH||'',HOME:temp,USERPROFILE:temp,TMP:temp,TEMP:temp,TMPDIR:temp,
   HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_DATASETS_OFFLINE:'1',PIP_NO_INDEX:'1',GIT_TERMINAL_PROMPT:'0',
   NO_PROXY:'*',no_proxy:'*',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',GOPROXY:'off',GOSUMDB:'off'};
 if(process.platform==='win32'){env.SYSTEMROOT=process.env.SYSTEMROOT||'';env.WINDIR=process.env.WINDIR||'';}
 try{return await new Promise((resolvePromise,rejectPromise)=>{
   if(signal?.aborted){rejectPromise(new Error('embedding operation cancelled'));return;}
   let child;
   try{child=spawnProcess(binary,[],{cwd:root,env,shell:false,stdio:['pipe','pipe','pipe'],windowsHide:true});}
   catch{rejectPromise(new Error('encoder launch failed'));return;}
   let stdout=[],length=0,done=false,timeout=false,cancelled=false,oversized=false,killTimer;
   const kill=()=>{try{child.kill('SIGTERM');}catch{}killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},250);killTimer.unref?.();};
   const timer=setTimeout(()=>{timeout=true;kill();},timeoutMs);timer.unref?.();
   const cancel=()=>{cancelled=true;kill();};
   signal?.addEventListener('abort',cancel,{once:true});controller.signal.addEventListener('abort',cancel,{once:true});
   const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',cancel);
     if(error)rejectPromise(error);else{
       try{resolvePromise(JSON.parse(Buffer.concat(stdout).toString('utf8')));}catch{rejectPromise(new Error('invalid encoder JSON response'));}
     }};
   child.stdout?.on('data',chunk=>{length+=chunk.length;if(length>MAX_OUTPUT_BYTES){oversized=true;kill();return;}stdout.push(chunk);});
   child.stderr?.on('data',()=>{}); // never expose stderr: it might contain source content/credentials
   child.on('error',()=>finish(new Error('encoder launch failed')));
   child.on('close',(code,term)=>{
     if(cancelled)return finish(new Error('embedding operation cancelled'));
     if(timeout)return finish(new Error('embedding operation timed out'));
     if(oversized)return finish(new Error('encoder response size budget exceeded'));
     if(code!==0||term)return finish(new Error('encoder subprocess failed; stderr redacted'));
     finish();
   });
   child.stdin?.on('error',()=>{});
   child.stdin?.end(JSON.stringify(input));
 });}finally{controllers.delete(controller);rmSync(temp,{recursive:true,force:true});}
}

export class LocalEmbeddingRuntime {
 constructor({spawnProcess=spawn}={}){this.spawnProcess=spawnProcess;this.controllers=new Set();this.activeRoots=new Set();}
 close(){for(const c of this.controllers)c.abort();}
 async build(index,{executable,replace=false,timeoutMs=30000,signal}={}){
  const root=rootOf(index),binary=checkedEncoder(executable,root);
  if(typeof replace!=='boolean')throw new TypeError('replace must be boolean');
  if(!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>120000)throw new RangeError('invalid encoder timeout');
  const target=privateManifestPath(root,{create:false});
  if(existsSync(target)&&!replace)throw new Error('embeddings manifest already exists; explicit replace required');
  if(this.activeRoots.has(root))throw new Error('embedding build already running for project');
  this.activeRoots.add(root);
  try{
   const scope=checkedIndexScope(index);
   const {request,provenance,verifiedBytes,truncatedTexts}=readSource(index,root);
   const response=await callEncoder(binary,root,request,{timeoutMs,signal,spawnProcess:this.spawnProcess,controllers:this.controllers});
   const payload={...outputResponse(response,provenance),indexScope:scope};
   checkUnchanged(index,root,provenance);
   checkScopeEqual(scope,checkedIndexScope(index));
   const oldExists=existsSync(target),result=writeManifest(root,payload,{replace});
   return {created:true,replaced:oldExists,files:provenance.length,model:payload.model,dimensions:payload.dimensions,
    manifestHash:result.manifestHash,verifiedSourceBytes:verifiedBytes,truncatedTexts,
    notes:'Vectors originate from the operator-pinned executable. Offline settings do not sandbox the trusted encoder; retrieval quality is unmeasured.'};
  }finally{this.activeRoots.delete(root);}
 }
 async sync(index,{executable,timeoutMs=30000,signal}={}){
  const root=rootOf(index),binary=checkedEncoder(executable,root);
  if(!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>120000)throw new RangeError('invalid encoder timeout');
  if(this.activeRoots.has(root))throw new Error('embedding operation already running for project');
  this.activeRoots.add(root);
  try{
   const scope=checkedIndexScope(index);
   const {data:previous,manifestHash:expectedManifestHash}=readManifest(root);
   checkScopeEqual(previous.indexScope,scope);
   if(index.files.size===0&&previous.entries.length>0)
     throw new Error('refuse to delete every embedding row from an empty indexed source set');
   const prior=new Map(previous.entries.map(row=>[row.path,row]));
   const {request,provenance,verifiedBytes,truncatedTexts}=readSource(index,root,{
     include:(path,sha256)=>prior.get(path)?.sha256!==sha256,allowEmpty:true
   });
   const changed=new Set(request.documents.map(row=>row.path));
   const changedProvenance=provenance.filter(row=>changed.has(row.path));
   const removed=previous.entries.filter(row=>!index.files.has(row.path)).length;
   const reused=provenance.length-changedProvenance.length;
   if(!changedProvenance.length&&!removed){
     checkUnchanged(index,root,provenance);
     checkScopeEqual(scope,checkedIndexScope(index));
     return {unchanged:true,files:provenance.length,embedded:0,reused,removed:0,
       model:previous.model,dimensions:previous.dimensions,manifestHash:expectedManifestHash,
       verifiedSourceBytes:verifiedBytes,truncatedTexts,
       notes:'No source changes; encoder was not invoked. Verified index scope only; semantic quality is unmeasured.'};
   }
   let updates=new Map();
   if(changedProvenance.length){
     const response=await callEncoder(binary,root,request,{timeoutMs,signal,spawnProcess:this.spawnProcess,controllers:this.controllers});
     const generated=outputResponse(response,changedProvenance);
     if(generated.model!==previous.model||generated.dimensions!==previous.dimensions)
       throw new Error('encoder model/dimension mismatch with existing source vectors; explicit replace required');
     updates=new Map(generated.entries.map(row=>[row.path,row]));
   }
   checkUnchanged(index,root,provenance);
   checkScopeEqual(scope,checkedIndexScope(index));
   const entries=provenance.map(({path})=>updates.get(path)||prior.get(path));
   if(entries.some(row=>!row))throw new Error('incomplete embeddings sync manifest');
   const payload={schema:1,model:previous.model,dimensions:previous.dimensions,entries,indexScope:scope};
   const written=writeManifest(root,payload,{replace:true,expectedManifestHash});
   return {unchanged:false,files:provenance.length,embedded:changedProvenance.length,reused,removed,
     model:payload.model,dimensions:payload.dimensions,manifestHash:written.manifestHash,
     verifiedSourceBytes:verifiedBytes,truncatedTexts,
     notes:'Explicit incremental sync only: reuses matching source-hash vectors, never auto-runs encoders; model metadata is not attested.'};
  }finally{this.activeRoots.delete(root);}
 }
 async find(index,{executable,query,timeoutMs=30000,signal}={}){
  const root=rootOf(index),binary=checkedEncoder(executable,root);
  if(typeof query!=='string'||!query.trim()||query.length>160)throw new TypeError('text query must be 1..160 chars');
  if(!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>120000)throw new RangeError('invalid encoder timeout');
  const target=privateManifestPath(root,{create:false});
  let manifest;
  try{const st=lstatSync(target);if(st.size>MAX_MANIFEST_BYTES||!st.isFile()||st.isSymbolicLink())throw new Error('unsafe embeddings manifest');manifest=JSON.parse(readFileSync(target,'utf8'));}
  catch{throw new Error('missing or invalid embeddings manifest; build explicitly first');}
  checkModel(manifest);
  const response=await callEncoder(binary,root,{schema:1,task:'embed-query',text:query},{timeoutMs,signal,spawnProcess:this.spawnProcess,controllers:this.controllers});
  checkModel(response);checkVector(response.vector,response.dimensions);
  if(response.model!==manifest.model||response.dimensions!==manifest.dimensions)throw new Error('query encoder model/dimension mismatch with source vectors');
  const {searchLocalVectors}=await import('./local-vectors.mjs');
  return searchLocalVectors(index,{queryVector:response.vector,query,limit:8,maxChars:4000});
 }
}
