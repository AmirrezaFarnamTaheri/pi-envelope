/**
 * Explicit, offline-by-default bridge to a user-pinned Graphify CLI executable.
 * No installer, shell, hook, provider keys, automatic build or background watcher.
 * Human-only build/update; Pi agent tools may only read an existing graph.
 * This is a subprocess adapter, never an Envelope native AST assertion.
 */
import {spawn} from 'node:child_process';
import {accessSync, constants, realpathSync, statSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {ExternalGraphReader} from './graphify-adapter.mjs';

const ACTIONS=new Set(['status','query','path','explain','build','update']);
const OUTPUT_LIMIT=16_384;
const STDERR_LIMIT=2_048;
const MAX_TIMEOUT=120_000;
const ENV_ALLOW=['HOME','USERPROFILE','PATH','SYSTEMROOT','WINDIR','TMPDIR','TMP','TEMP','LANG','LC_ALL','XDG_CACHE_HOME','XDG_CONFIG_HOME'];
function isWithin(root,path){return path===root||path.startsWith(root+sep);}
function boundedInt(value,defaultValue,min,max,label){
  const n=value===undefined?defaultValue:value;
  if(!Number.isInteger(n)||n<min||n>max)throw new RangeError(`${label} must be ${min}..${max}`);
  return n;
}
function safeInput(value,label,max=240){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value)||value.startsWith('-')||value==='.'||value==='..'||value.includes('../')||value.includes('..\\')){
    throw new TypeError(`invalid ${label} argument`);
  }
  return value;
}
export function normalizeGraphifyExecutable(value){
  if(typeof value!=='string'||value.length<2||value.length>1024||!isAbsolute(value)||/[\u0000-\u001f\u007f]/.test(value))throw new TypeError('Graphify binary must be an absolute executable path');
  return value;
}
function executableStatus(root,executable){
  if(!executable)return {available:false,reason:'no-executable-pinned'};
  try{
    normalizeGraphifyExecutable(executable);
    const path=realpathSync(executable);
    if(isWithin(root,path)||isWithin(root,resolve(executable)))return {available:false,reason:'executable-inside-project'};
    const stat=statSync(path);
    if(!stat.isFile())return {available:false,reason:'executable-not-file'};
    if(process.platform!=='win32')accessSync(path,constants.X_OK);
    return {available:true,path};
  }catch{return {available:false,reason:'executable-unavailable-or-unsafe'};}
}
function localStatus(root){
  const reader=new ExternalGraphReader(root);
  try{return reader.query({root:reader.root},{action:'status'});}
  finally{reader.close();}
}
const ORIENTATION_START='<ENVELOPE_GRAPHIFY_ORIENTATION>';
const ORIENTATION_END='</ENVELOPE_GRAPHIFY_ORIENTATION>';
function removeOrientation(text){
  if(typeof text!=='string')return text;
  const first=text.indexOf(ORIENTATION_START);
  if(first<0)return text;
  const last=text.indexOf(ORIENTATION_END,first);
  if(last<0)return text;
  return (text.slice(0,first)+text.slice(last+ORIENTATION_END.length)).trimEnd();
}
/** The existing before_agent_start owner may call this; never register another hook. */
export function composeGraphifyOrientation(prompt,projectRoot,enabled){
  if(typeof prompt!=='string'&&!Array.isArray(prompt))return null;
  const original=Array.isArray(prompt)?prompt:[prompt];
  const had=original.some(x=>typeof x==='string'&&x.includes(ORIENTATION_START));
  let status=null;
  if(enabled){
    try{status=localStatus(realpathSync(resolve(projectRoot)));}
    catch{/* A missing workspace must never block the host prompt. */}
  }
  const show=enabled&&status&&status.state!=='missing';
  if(!show&&!had)return null;
  const clean=original.map(removeOrientation);
  if(show){
    const state=status.state;
    const body=`${ORIENTATION_START}\nExternal Graphify graph: ${state}. Start with envelope_code_external_graph status before broad graph exploration; prefer bounded graph nodes/paths and verify findings against original source before editing. ${state==='stale'?'Graph is stale; avoid relying on its edges until an explicit user rebuild, or acknowledge stale reads.':'Graph edges are untrusted assertions, not native static or runtime proof.'} No automatic rebuild, provider calls or source-text disclosure.\n${ORIENTATION_END}`;
    if(had&&original.some(x=>typeof x==='string'&&x.includes(body)))return {systemPrompt:prompt};
    clean.push(body);
  }
  return {systemPrompt:Array.isArray(prompt)?clean:clean.join('\n\n')};
}

function processEnv(){
  const env=Object.create(null);
  for(const name of ENV_ALLOW)if(typeof process.env[name]==='string')env[name]=process.env[name];
  // All operations, including build, explicitly disable provider discovery and
  // Graphify's optional query logs. No API keys are passed to the process.
  env.GRAPHIFY_BACKEND='none';
  env.GRAPHIFY_QUERY_LOG_DISABLE='1';
  env.GRAPHIFY_NO_TIPS='1';
  env.GRAPHIFY_FORCE='0';
  return env;
}
async function spawnBounded(binary,args,{cwd,timeoutMs,signal,spawnProcess=spawn}){
  if(signal?.aborted)throw new Error('Graphify operation cancelled before launch');
  return new Promise((resolvePromise,rejectPromise)=>{
    let child;
    try{child=spawnProcess(binary,args,{cwd,env:processEnv(),shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true});}
    catch{rejectPromise(new Error('Graphify process could not be launched'));return;}
    let stdout=[],stderr=[],outBytes=0,errBytes=0,oversized=false,timedOut=false,cancelled=false,done=false;
    let escalation,stopping=false;
    const kill=()=>{
      if(stopping)return;
      stopping=true;
      try{child.kill('SIGTERM');}catch{/* already exited */}
      escalation=setTimeout(()=>{try{child.kill('SIGKILL');}catch{/* already exited */}},250);escalation.unref?.();
    };
    const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);timer.unref?.();
    const onAbort=()=>{cancelled=true;kill();};
    signal?.addEventListener('abort',onAbort,{once:true});
    const finish=(error,output)=>{
      if(done)return;
      done=true;clearTimeout(timer);if(escalation)clearTimeout(escalation);
      signal?.removeEventListener('abort',onAbort);
      if(error)rejectPromise(error);else resolvePromise(output);
    };
    const read=(data,isError)=>{
      const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);
      if(isError){if(errBytes<STDERR_LIMIT){const kept=chunk.subarray(0,STDERR_LIMIT-errBytes);stderr.push(kept);errBytes+=kept.length;}return;}
      outBytes+=chunk.length;
      if(outBytes>OUTPUT_LIMIT){oversized=true;kill();return;}
      stdout.push(chunk);
    };
    child.stdout?.on('data',data=>read(data,false));
    child.stderr?.on('data',data=>read(data,true));
    child.once('error',()=>finish(new Error('Graphify process could not be launched')));
    child.once('close',(code,signalName)=>{
      if(cancelled)return finish(new Error('Graphify operation cancelled'));
      if(timedOut)return finish(new Error('Graphify process timed out'));
      if(oversized)return finish(new Error('Graphify output exceeded the 16 KiB limit; incomplete output discarded'));
      if(code!==0||signalName)return finish(new Error(`Graphify process failed (exit ${code??'signal'})${stderr.length?': '+Buffer.concat(stderr).toString('utf8').slice(0,300):''}`));
      finish(null,Buffer.concat(stdout).toString('utf8'));
    });
  });
}

export class GraphifyCliBridge {
  constructor({spawnProcess=spawn}={}){this.spawnProcess=spawnProcess;this.active=new Set();}
  close(){for(const controller of this.active)controller.abort();}
  async run(projectRoot,config,params={},signal,{humanCommand=false}={}){
    if(!params||typeof params!=='object'||Array.isArray(params))throw new TypeError('Graphify params required');
    const action=params.action??'status';
    if(!ACTIONS.has(action))throw new TypeError('unsupported Graphify action');
    const root=realpathSync(resolve(projectRoot));
    if(!statSync(root).isDirectory())throw new Error('invalid project root');
    const setting=config&&typeof config==='object'?config:{};
    const candidate=executableStatus(root,setting.executable);
    const artifact=localStatus(root);
    const base={runtime:'graphifyy-cli',enabled:setting.enabled===true,available:candidate.available,
      ...(!candidate.available?{availabilityReason:candidate.reason}:{}),artifactState:artifact.state,
      provenance:'external-graphify-cli',trust:'external-assertions-not-native-AST',
      reasons:artifact.reasons??[],graphHash:artifact.graphSha256??null};
    if(action==='status')return {...base,action,notes:'Binary presence does not prove Graphify compatibility; no process was launched.'};
    if(setting.enabled!==true)throw new Error('Graphify CLI disabled; enable with /envelope graphify on');
    if(!candidate.available)throw new Error(`Graphify CLI unavailable or unsafe: ${candidate.reason}`);
    const write=action==='build'||action==='update';
    if(write&&!humanCommand)throw new Error('Graphify mutations require the human /envelope graphify build|update slash command');
    let args;
    if(action==='query'){
      const question=safeInput(params.question,'question');
      const budget=boundedInt(params.budget,1200,200,3000,'query budget');
      const depth=boundedInt(params.depth,2,1,5,'query depth');
      args=['query',question,'--budget',String(budget),'--depth',String(depth),'--graph','graphify-out/graph.json'];
    }else if(action==='path'){
      args=['path',safeInput(params.source,'source',200),safeInput(params.target,'target',200)];
    }else if(action==='explain'){
      args=['explain',safeInput(params.source,'source',200)];
    }else if(action==='build'){
      args=['extract','.','--code-only','--no-cluster','--out','graphify-out'];
    }else if(action==='update'){
      args=['update','.','--no-cluster'];
    }
    if(!write){
      if(artifact.state==='missing'||artifact.state==='invalid')throw new Error(`Graphify artifact ${artifact.state}; cannot run read query`);
      if(artifact.state==='stale'&&params.allowStale!==true)throw new Error('Graphify artifact is stale; acknowledge with allowStale:true');
    }
    const timeoutMs=boundedInt(setting.timeoutMs,30_000,50,MAX_TIMEOUT,'Graphify timeout');
    const task=new AbortController();
    const cancel=()=>task.abort();
    if(signal?.aborted)cancel();
    signal?.addEventListener('abort',cancel,{once:true});
    this.active.add(task);
    let output;
    try{output=await spawnBounded(candidate.path,args,{cwd:root,timeoutMs,signal:task.signal,spawnProcess:this.spawnProcess});}
    finally{signal?.removeEventListener('abort',cancel);this.active.delete(task);}
    const after=write?localStatus(root):artifact;
    return {...base,action,artifactState:after.state,reasons:after.reasons??[],
      ...(write?{writeRequested:true,artifactChanged:after.graphSha256!==artifact.graphSha256,graphHash:after.graphSha256??null}:{}),
      output,outputBytes:Buffer.byteLength(output),
      notes:write?'Explicit local code-only Graphify run; a zero exit code alone does not prove graph completeness.':'CLI text comes from an external engine; verify source evidence before acting.'};
  }
}

const textResult=(value,error=false)=>({isError:error,content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}],details:{}});
export function registerGraphifyCliFeature(pi,{project,getConfig,observe,cli=new GraphifyCliBridge()}={}){
  if(typeof project!=='function'||typeof getConfig!=='function')throw new TypeError('Graphify CLI feature requires project/config access');
  const run=async(ctx,params,signal,{humanCommand=false}={})=>{
    const started=performance.now(),action=params.action??'status';
    try{
      if(!getConfig().code.enabled&&action!=='status')throw new Error('Code intelligence disabled; use /envelope code on');
      const outcome=await cli.run(project(ctx),getConfig().graphify,params,signal,{humanCommand});
      observe?.(ctx,'graphify_cli',{action,outcome:'ok',durationMs:performance.now()-started});
      return outcome;
    }catch(err){
      observe?.(ctx,'graphify_cli',{action,outcome:'error',durationMs:performance.now()-started});
      throw err;
    }
  };
  pi.registerTool?.({
    name:'envelope_graphify_cli',label:'Envelope: Explicit Graphify CLI Read Adapter',
    description:'Read-only Graphify CLI status, bounded question query, node path or explanation against the current project artifact. Requires a user-pinned executable and /envelope graphify on. No auto-install, provider calls, graph rebuild or agent-invoked update. External output is not native AST proof.',
    parameters:{type:'object',properties:{
      action:{type:'string',enum:['status','query','path','explain']},
      question:{type:'string',description:'Graph question, max 240 chars, no option injection'},
      source:{type:'string',description:'Graph node identifier for path/explain'},
      target:{type:'string',description:'Graph node identifier for path'},
      budget:{type:'integer',minimum:200,maximum:3000},
      depth:{type:'integer',minimum:1,maximum:5},
      allowStale:{type:'boolean',description:'Explicit acknowledgement of known-stale graph'}},
      additionalProperties:false},
    async execute(_id,params,signal,_onUpdate,ctx){
      try{return textResult(await run(ctx,params??{},signal));}
      catch(err){return textResult(`Graphify CLI: ${err.message}`,true);}
    }
  });
  return {run,close:()=>cli.close()};
}
