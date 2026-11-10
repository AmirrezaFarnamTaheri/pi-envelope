/** Explicit Graphify.NET CLI AST-only bridge. Never imports provider credentials. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync,constants,statSync,realpathSync,lstatSync,mkdirSync,mkdtempSync,rmSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {join,resolve,isAbsolute,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {treeSpawnOptions,terminateTree} from './process-tree.mjs';
const OUT='.envelope/graphify-dotnet-out',OUTPUT_LIMIT=16384,GRAPH_LIMIT=2_000_000;
const hash=x=>createHash('sha256').update(x).digest('hex');
const within=(root,p)=>p===root||p.startsWith(root+sep);
export function normalizeGraphifyDotnetExecutable(path){
 if(typeof path!=='string'||path.length<2||path.length>1024||!isAbsolute(path)||/[\u0000-\u001f\u007f]/.test(path))throw new TypeError('Graphify.NET binary must be a pinned absolute executable');
 return path;
}
function executable(root,path){
 if(!path)return {available:false,reason:'not-configured'};
 try{
   normalizeGraphifyDotnetExecutable(path);
   const canonical=realpathSync(path),stat=statSync(canonical);
   if(within(root,canonical)||within(root,resolve(path)))return {available:false,reason:'executable-inside-project'};
   if(!stat.isFile())return {available:false,reason:'executable-not-file'};
   if(process.platform!=='win32')accessSync(canonical,constants.X_OK);
   return {available:true,path:canonical};
 }catch{return {available:false,reason:'executable-unavailable-or-unsafe'};}
}
function paths(root,create=false){
 const base=join(root,'.envelope'),out=join(base,'graphify-dotnet-out');
 for(const directory of [base,out]){
   try{if(create)mkdirSync(directory,{mode:0o700});}catch(err){if(err.code!=='EEXIST')throw err;}
   try{const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('unsafe Graphify.NET output symlink');}
   catch(err){if(!create&&err.code==='ENOENT')return null;throw err;}
 }
 return {out,graph:join(out,'graph.json')};
}
function validateWriteTarget(root){
 const graph=paths(root,true).graph;
 try{
   const st=lstatSync(graph);
   if(st.isSymbolicLink()||!st.isFile())throw new Error('unsafe Graphify.NET graph.json symlink or non-file target');
 }catch(err){if(err.code!=='ENOENT')throw err;}
}
function artifact(root){
 let graph;
 try{graph=paths(root,false)?.graph;}catch{return {artifactState:'invalid',nodes:0,edges:0,graphHash:null};}
 if(!graph)return {artifactState:'missing',nodes:0,edges:0,graphHash:null};
 let fd;
 try{
   const st=lstatSync(graph);
   if(!st.isFile()||st.isSymbolicLink()||st.size>GRAPH_LIMIT)throw new Error('invalid Graphify.NET graph artifact');
   fd=openSync(graph,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
   const opened=fstatSync(fd);
   if(!opened.isFile()||opened.size>GRAPH_LIMIT||opened.size<2)throw new Error('invalid graph size');
   const bytes=Buffer.alloc(opened.size);let at=0;
   while(at<bytes.length){
     const read=readSync(fd,bytes,at,bytes.length-at,at);
     if(read<=0)throw new Error('graph changed during read');
     at+=read;
   }
   const extra=Buffer.alloc(1);
   if(readSync(fd,extra,0,1,at)>0)throw new Error('graph grew during read');
   const after=fstatSync(fd);
   if(after.size!==opened.size||after.ino!==opened.ino||after.mtimeMs!==opened.mtimeMs)throw new Error('graph changed during read');
   const parsed=JSON.parse(bytes.toString('utf8'));
   const data=Array.isArray(parsed?.nodes)?parsed:parsed?.graph;
   const nodes=data?.nodes,edges=data?.links??data?.edges;
   if(!Array.isArray(nodes)||!Array.isArray(edges)||nodes.length>2000||edges.length>8000)throw new Error('invalid graph schema');
   return {artifactState:'unverified',nodes:nodes.length,edges:edges.length,graphHash:hash(bytes)};
 }catch(err){return {artifactState:err.code==='ENOENT'?'missing':'invalid',nodes:0,edges:0,graphHash:null};}
 finally{if(fd!==undefined)closeSync(fd);}
}
async function spawnOffline(binary,root,timeout,signal,spawnProcess,controllers){
 if(signal?.aborted)throw new Error('Graphify.NET operation cancelled');
 const temporary=mkdtempSync(join(tmpdir(),'envelope-graphify-dotnet-home-'));
 const controller=new AbortController();controllers.add(controller);
 const args=['run','.','--format','json','--output',OUT];
 const env={PATH:process.env.PATH||'',GRAPHIFY__Provider:'None',HOME:temporary,USERPROFILE:temporary,DOTNET_CLI_HOME:temporary,
   DOTNET_NOLOGO:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1',TMPDIR:tmpdir(),TMP:tmpdir(),TEMP:tmpdir()};
 if(process.platform==='win32'){env.SYSTEMROOT=process.env.SYSTEMROOT||'';env.WINDIR=process.env.WINDIR||'';}
 try{return await new Promise((resolvePromise,rejectPromise)=>{
   let child;try{child=spawnProcess(binary,args,{cwd:root,env,shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true,...treeSpawnOptions(spawnProcess)});}
   catch{rejectPromise(new Error('Graphify.NET process could not launch'));return;}
   let done=false,stdoutBytes=0,timeoutHit=false,cancelled=false,oversized=false,esc;
   let stopping=false;
   const kill=()=>{if(stopping)return;stopping=true;terminateTree(child,'SIGTERM',{spawnProcess});
     esc=setTimeout(()=>terminateTree(child,'SIGKILL',{spawnProcess}),250);esc.unref?.();};
   const timer=setTimeout(()=>{timeoutHit=true;kill();},timeout);timer.unref?.();
   const cancel=()=>{cancelled=true;kill();};signal?.addEventListener('abort',cancel,{once:true});controller.signal.addEventListener('abort',cancel,{once:true});
   const end=(err)=>{if(done)return;done=true;clearTimeout(timer);if(esc)clearTimeout(esc);signal?.removeEventListener('abort',cancel);
     if(err)rejectPromise(err);else resolvePromise({stdoutBytes});};
   child.stdout?.on('data',buf=>{stdoutBytes+=Buffer.byteLength(buf);if(stdoutBytes>OUTPUT_LIMIT){oversized=true;kill();}});
   child.stderr?.on('data',()=>{});
   child.on('error',()=>end(new Error('Graphify.NET process could not launch')));
   child.on('close',(code,sig)=>{
     if(cancelled)return end(new Error('Graphify.NET operation cancelled'));
     if(timeoutHit)return end(new Error('Graphify.NET process timed out'));
     if(oversized)return end(new Error('Graphify.NET output exceeded limit'));
     if(code!==0||sig)return end(new Error('Graphify.NET subprocess failed; stderr redacted'));
     end();
   });
 })}finally{controllers.delete(controller);rmSync(temporary,{recursive:true,force:true});}
}
export class GraphifyDotnetBridge {
 constructor({spawnProcess=spawn}={}){this.spawnProcess=spawnProcess;this.active=new Set();this.writing=new Set();}
 close(){for(const c of this.active)c.abort();}
 async run(project,config,params={},signal,{humanCommand=false}={}){
   if(!params||typeof params!=='object'||Array.isArray(params))throw new TypeError('Graphify.NET params required');
   const action=params.action??'status';if(!['status','build'].includes(action))throw new TypeError('unsupported Graphify.NET action');
   const root=realpathSync(resolve(project));if(!statSync(root).isDirectory())throw new Error('invalid project root');
   const binary=executable(root,config?.executable);
   const before=artifact(root);
   const state={runtime:'graphify-dotnet-cli',action,enabled:config?.enabled===true,available:binary.available,
     ...(binary.available?{}:{availabilityReason:binary.reason}),...before,
     trust:'unverified-external-graph-assertions',notes:'Status never launches Graphify.NET; source graph is not attested as native AST proof.'};
   if(action==='status')return state;
   if(!humanCommand)throw new Error('Graphify.NET mutation requires explicit human build command');
   if(config?.enabled!==true)throw new Error('Graphify.NET disabled');
   if(!binary.available)throw new Error('Graphify.NET executable unavailable or unsafe');
   if(this.writing.has(root))throw new Error('Graphify.NET build already running for this project');
   const timeout=config.timeoutMs??30000;
   if(!Number.isInteger(timeout)||timeout<50||timeout>120000)throw new RangeError('invalid Graphify.NET timeout');
   validateWriteTarget(root);
   this.writing.add(root);
   try{
     const proc=await spawnOffline(binary.path,root,timeout,signal,this.spawnProcess,this.active);
     const after=artifact(root);
     return {...state,action,artifactState:after.artifactState,nodes:after.nodes,edges:after.edges,
       graphHash:after.graphHash,artifactChanged:after.artifactState==='unverified'&&after.graphHash!==before.graphHash,
       stdoutBytes:proc.stdoutBytes,provider:'None',notes:'Explicit isolated AST-only Graphify.NET process; zero exit never proves full graph quality or source attestation.'};
   }finally{this.writing.delete(root);}
 }
}

/** Single native Pi tool; only the human-facing Envelope slash command can build. */
export function registerGraphifyDotnetFeature(pi,{project,getConfig,bridge=new GraphifyDotnetBridge()}={}){
 if(typeof project!=='function'||typeof getConfig!=='function')throw new TypeError('Graphify.NET Pi feature requires project and config');
 const status=ctx=>bridge.run(project(ctx),getConfig().graphifyDotnet,{action:'status'});
 pi.registerTool?.({
   name:'envelope_graphify_dotnet',label:'Envelope: Graphify.NET AST Graph Status',
   description:'Inspect separately pinned Graphify.NET code-graph artifact as unverified external assertions. Never builds, installs, configures providers, reads graph contents or launches the binary.',
   parameters:{type:'object',properties:{action:{type:'string',enum:['status']}},additionalProperties:false},
   async execute(_id,params,_signal,_update,ctx){
     try{
       if(params?.action&&params.action!=='status')throw new Error('Only Graphify.NET status is available to agents');
       return {content:[{type:'text',text:JSON.stringify(await status(ctx))}]};
     }catch{return {isError:true,content:[{type:'text',text:'Graphify.NET status unavailable or unsafe'}]};}
   }
 });
 return {status,build:(ctx,signal)=>bridge.run(project(ctx),getConfig().graphifyDotnet,{action:'build'},signal,{humanCommand:true}),close:()=>bridge.close()};
}
