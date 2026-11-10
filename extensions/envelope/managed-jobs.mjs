/** Persistent, project-scoped jobs with a detached Node supervisor and bounded logs. */
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, openSync, closeSync, writeSync, readSync, rmSync} from 'node:fs';
import {basename, delimiter, dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {terminateTree, treeSpawnOptions} from './process-tree.mjs';

const SELF=fileURLToPath(import.meta.url);
const IDENTIFIER=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FINISHED=new Set(['completed','failed','cancelled','interrupted']);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const respond=(data,isError=false)=>({isError,content:[{type:'text',text:typeof data==='string'?data:JSON.stringify(data)}],details:{}});
const inside=(root,path)=>path===root||path.startsWith(root+sep);

/**
 * Use a real Node binary for detached workers, even when Pi itself is a Bun
 * compiled executable. In compiled Bun, process.execPath is pi.exe, not node.
 * PATH is considered only for absolute directories outside the project root.
 * The caller controls which trusted Node installation is on PATH.
 */
export function resolveTrustedNodeExecutable(project,{
  pathEnv=process.env.PATH||'',
  compiledBun=Boolean(process.versions.bun),
  runtimeExecPath=process.execPath
}={}){
  const root=realpathSync(resolve(project));
  const accept=(candidate,checkName=true)=>{
    if(typeof candidate!=='string'||!isAbsolute(candidate))return null;
    let path,stat;
    try{path=realpathSync(candidate);stat=statSync(path);}catch{return null;}
    if(!stat.isFile()||inside(root,path))return null;
    if(checkName&&!/^node(?:\.exe)?$/i.test(basename(path)))return null;
    if(process.platform!=='win32'&&(stat.mode&0o111)===0)return null;
    return path;
  };
  if(!compiledBun){
    const native=accept(runtimeExecPath,false);
    if(native)return native;
  }
  for(const dir of pathEnv.split(delimiter)){
    if(!isAbsolute(dir))continue;
    const node=accept(join(dir,process.platform==='win32'?'node.exe':'node'));
    if(node)return node;
  }
  throw new Error('A trusted Node.js executable outside the project is required for background jobs (Node.js 22.19+). Add Node to PATH.');
}

/**
 * Resolve a project-external Pi CLI before spawning it with the project as cwd.
 * PATH entries that are relative or within the project are not trusted.
 * Windows .cmd npm shims are not supported by shell:false: select a trusted
 * absolute .js/.mjs CLI entrypoint with ENVELOPE_PI_CLI_ENTRYPOINT instead.
 */
export function resolveTrustedAgentCommand(project,{pathEnv=process.env.PATH||'',configured=process.env.ENVELOPE_PI_CLI_ENTRYPOINT||''}={}){
  const root=realpathSync(resolve(project));
  const choose=(entry,explicit)=>{
    if(!isAbsolute(entry)||inside(root,resolve(entry)))return null;
    let file,stat;
    try{file=realpathSync(entry);stat=statSync(file);}catch{return null;}
    if(!stat.isFile()||inside(root,file))return null;
    if(/\.[cm]?js$/i.test(file))return {command:resolveTrustedNodeExecutable(root,{pathEnv}),prefix:[file]};
    if(process.platform==='win32'){
      if(/\.exe$/i.test(file))return {command:file,prefix:[]};
      return null;
    }
    return (stat.mode&0o111)!==0?{command:file,prefix:[]}:null;
  };
  if(configured){
    const selected=choose(configured,true);
    if(!selected)throw new Error('ENVELOPE_PI_CLI_ENTRYPOINT must be an absolute, trusted executable or Node script outside the project');
    return selected;
  }
  for(const entry of pathEnv.split(delimiter)){
    if(!entry||!isAbsolute(entry))continue;
    const selected=choose(join(entry,process.platform==='win32'?'pi.exe':'pi'),false);
    if(selected)return selected;
  }
  throw new Error('No trusted Pi executable outside the project; configure ENVELOPE_PI_CLI_ENTRYPOINT to an absolute installed Pi CLI script');
}
const schema=(props,required=[])=>({type:'object',properties:props,required,additionalProperties:false});

function atomicJson(path,value){
  const temp=path+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});
  renameSync(temp,path);
}
function snapshot(dir){return JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));}
function scope(home,project){
  const root=realpathSync(resolve(project));
  const key=createHash('sha256').update(root).digest('hex').slice(0,32);
  return {root,dir:join(home,'envelope-jobs',key)};
}
function jobDir(home,project,id){
  if(!IDENTIFIER.test(id))throw new Error('Invalid job ID');
  const path=join(scope(home,project).dir,id);
  if(!existsSync(join(path,'state.json')))throw new Error('Job not found in this project');
  return path;
}
function decorate(dir){
  const state=snapshot(dir);
  if(!FINISHED.has(state.status)){
    let heartbeat=state.updatedAt;
    try{heartbeat=statSync(join(dir,'heartbeat')).mtimeMs;}catch{}
    if(Date.now()-heartbeat>15000)return {...state,status:'interrupted',reason:'Worker heartbeat expired; no automatic retry'};
    if(existsSync(join(dir,'cancel')))return {...state,status:'cancelling'};
  }
  return state;
}

/** Local job manager: one durable record per job and no cross-project lookup. */
export class ManagedJobs {
  constructor(home){this.home=resolve(home);}
  async start({project,command,args=[],kind='command',sessionId=null,maxLogBytes=2_000_000}){
    if(typeof command!=='string'||!command.trim()||command.length>4096||/\0/.test(command))throw new Error('Invalid executable');
    if(!Array.isArray(args)||args.length>128||args.some(arg=>typeof arg!=='string'||arg.length>16384||arg.includes('\0')))throw new Error('Invalid argv');
    if(!Number.isSafeInteger(maxLogBytes)||maxLogBytes<1024||maxLogBytes>10_000_000)throw new Error('Invalid output byte limit');
    const {root,dir}=scope(this.home,project);
    // Validate the detached worker runtime before creating a persistent job record.
    const nodeExecutable=resolveTrustedNodeExecutable(root);
    const id=randomUUID(),folder=join(dir,id);
    mkdirSync(folder,{recursive:true,mode:0o700});
    writeFileSync(join(folder,'output.log'),'',{flag:'wx',mode:0o600});
    const state={version:1,id,kind,project:root,command,args,sessionId,maxLogBytes,status:'starting',createdAt:Date.now(),updatedAt:Date.now(),exitCode:null,workerPid:null,childPid:null};
    atomicJson(join(folder,'state.json'),state);
    try{
      // The supervisor must never hold the project directory as its own cwd:
      // on Windows, completed jobs can otherwise prevent project cleanup (EBUSY).
      // The supervised child still runs with cwd=state.project in runWorker().
      const worker=spawn(nodeExecutable,[SELF,'--worker',folder],{
        cwd:dirname(nodeExecutable),detached:true,stdio:'ignore',windowsHide:true
      });
      await new Promise((resolve,reject)=>{worker.once('spawn',resolve);worker.once('error',reject);});
      worker.unref();
      return {id,status:'starting',kind,sessionId,createdAt:state.createdAt};
    }catch(error){
      atomicJson(join(folder,'state.json'),{...state,status:'failed',updatedAt:Date.now(),error:String(error.message)});
      throw error;
    }
  }
  status(project,id){return decorate(jobDir(this.home,project,id));}
  list(project,{limit=30}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid list limit');
    const dir=scope(this.home,project).dir;
    if(!existsSync(dir))return [];
    return readdirSync(dir).filter(id=>IDENTIFIER.test(id)).map(id=>{
      try{return decorate(jobDir(this.home,project,id));}catch{return null;}
    }).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt).slice(0,limit);
  }
  logs(project,id,{maxBytes=16000,fromByte}={}){
    if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>32000)throw new Error('Invalid log byte limit');
    if(fromByte!==undefined&&(!Number.isSafeInteger(fromByte)||fromByte<0))throw new Error('Invalid log cursor');
    const dir=jobDir(this.home,project,id);
    const file=join(dir,'output.log'),fd=openSync(file,'r');
    try{
      const length=statSync(file).size;
      const offset=fromByte===undefined?Math.max(0,length-maxBytes):Math.min(fromByte,length);
      const size=Math.min(maxBytes,length-offset);
      const data=Buffer.alloc(size),n=size?readFileChunk(fd,data,offset):0;
      // Cursor reads stop on complete UTF-8 codepoint boundaries so the next
      // page can resume without replacement characters or dropped bytes.
      const consumed=utf8PageEnd(data.subarray(0,n),fromByte===undefined);
      const displayStart=fromByte===undefined?utf8LeadingContinuation(data.subarray(0,consumed)):0;
      return {id,text:data.subarray(displayStart,consumed).toString('utf8'),fromByte:offset,
        nextByte:offset+consumed,remainingBytes:Math.max(0,length-offset-consumed),
        truncated:fromByte===undefined&&offset>0,bytes:length};
    }finally{closeSync(fd);}
  }
  prune(project,{olderThanDays=30}={}){
    if(!Number.isInteger(olderThanDays)||olderThanDays<0||olderThanDays>365)throw new Error('Invalid retention days');
    const root=scope(this.home,project).dir;
    const items=!existsSync(root)?[]:readdirSync(root).filter(id=>IDENTIFIER.test(id)).flatMap(id=>{try{return [decorate(jobDir(this.home,project,id))];}catch{return [];}});
    const threshold=Date.now()-olderThanDays*86_400_000;
    let removed=0;
    for(const item of items){
      if(['completed','failed','cancelled'].includes(item.status)&&(item.finishedAt??item.updatedAt)<threshold){
        rmSync(jobDir(this.home,project,item.id),{recursive:true,force:true});removed++;
      }
    }
    return {removed,olderThanDays};
  }
  cancel(project,id){
    const dir=jobDir(this.home,project,id),state=decorate(dir);
    if(FINISHED.has(state.status))return {id,requested:false,status:state.status};
    try{writeFileSync(join(dir,'cancel'),'1',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    return {id,requested:true,status:'cancelling'};
  }
  async wait(project,id,{timeoutMs=1000}={}){
    if(!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>10000)throw new Error('Invalid wait timeout');
    const until=Date.now()+timeoutMs;
    while(true){
      const state=this.status(project,id);
      if(FINISHED.has(state.status)||Date.now()>=until)return state;
      await pause(Math.min(100,until-Date.now()));
    }
  }
}
function utf8LeadingContinuation(buf){
  let i=0;
  while(i<buf.length&&(buf[i]&0xc0)===0x80)i++;
  return i;
}
function utf8PageEnd(buf,tail){
  if(!buf.length)return 0;
  const start=tail?utf8LeadingContinuation(buf):0;
  let i=buf.length-1;
  while(i>=start&&(buf[i]&0xc0)===0x80)i--;
  if(i<start)return buf.length; // No complete codepoint; advance tiny pages.
  const b=buf[i];
  const bytes=b<0x80?1:b>=0xc2&&b<=0xdf?2:b>=0xe0&&b<=0xef?3:b>=0xf0&&b<=0xf4?4:1;
  const complete=i+bytes<=buf.length?buf.length:i;
  return complete<=start?buf.length:complete; // maxBytes<one glyph: make progress.
}
function readFileChunk(fd,data,offset){
  let total=0;
  while(total<data.length){
    const n=readSync(fd,data,total,data.length-total,offset+total);
    if(n===0)break;
    total+=n;
  }
  return total;
}

/** Register one job-control surface and a separately authorized single-agent launcher. */
export function registerManagedJobs(pi,{home,project,allowStarts=()=>false,allowAgentRuns=()=>false}={}){
  const jobs=new ManagedJobs(home);
  pi.registerTool?.({
    name:'envelope_job',label:'Envelope: Managed Jobs',
    description:'Start/list/status/logs/wait/cancel persistent project-local jobs. Start uses an explicit executable and argv, never a shell. Foreground execution stays the default.',
    parameters:schema({
      action:{type:'string',enum:['start','list','status','logs','wait','cancel','prune']},
      jobId:{type:'string'},command:{type:'string'},args:{type:'array',items:{type:'string'},maxItems:128},
      waitMs:{type:'integer',minimum:0,maximum:10000},maxBytes:{type:'integer',minimum:1,maximum:32000},fromByte:{type:'integer',minimum:0},retentionDays:{type:'integer',minimum:0,maximum:365}
    },['action']),
    async execute(_callId,p,_signal,_update,ctx){
      const cwd=project(ctx);
      try{
        switch(p.action){
          case 'start':{
            if(!allowStarts())throw new Error('Background job starts are disabled; enable /envelope jobs on');
            return respond(await jobs.start({project:cwd,command:p.command,args:p.args??[]}));
          }
          case 'list':return respond(jobs.list(cwd).map(({command,args,...safe})=>safe));
          case 'status':{const {args,...safe}=jobs.status(cwd,p.jobId);return respond(safe);}
          case 'logs':return respond(jobs.logs(cwd,p.jobId,{maxBytes:p.maxBytes??16000,fromByte:p.fromByte}));
          case 'wait':{const {args,...safe}=await jobs.wait(cwd,p.jobId,{timeoutMs:p.waitMs??1000});return respond(safe);}
          case 'cancel':return respond(jobs.cancel(cwd,p.jobId));
          case 'prune':return respond(jobs.prune(cwd,{olderThanDays:p.retentionDays??30}));
          default:return respond('Unknown job action',true);
        }
      }catch(error){return respond('Envelope job: '+error.message,true);}
    }
  });
  pi.registerTool?.({
    name:'envelope_agent_start',label:'Envelope: Background Single-Agent Session',
    description:'Explicit opt-in: run one read-only Pi session as a managed job. No task DAG, subagent, or shared-directory writes. Inspect with envelope_job and resume via --session-id only after completion.',
    parameters:schema({prompt:{type:'string',minLength:1,maxLength:12000},name:{type:'string',maxLength:120}},['prompt']),
    async execute(_callId,p,_signal,_update,ctx){
      try{
        if(!allowAgentRuns())throw new Error('Background agent sessions are disabled; enable /envelope jobs agent on');
        const sessionId='envelope-'+randomUUID();
        const argv=['--print','--no-mcp','--no-extensions','--session-id',sessionId,'--tools','read,grep,find,ls','--name',p.name||'Envelope background review','--',p.prompt];
        const cwd=project(ctx),trusted=resolveTrustedAgentCommand(cwd);
        const started=await jobs.start({project:cwd,command:trusted.command,args:[...trusted.prefix,...argv],kind:'agent',sessionId});
        return respond({...started,resumeCommand:'pi --session-id '+sessionId,readOnly:true});
      }catch(error){return respond('Envelope agent: '+error.message,true);}
    }
  });
  return jobs;
}

/** Node supervisor process: owns child exit status even when the interactive Pi exits. */
async function runWorker(dir){
  const file=join(dir,'state.json');let state=snapshot(dir);
  const write=patch=>{state={...state,...patch,updatedAt:Date.now()};atomicJson(file,state);};
  const cancelFile=join(dir,'cancel');
  if(existsSync(cancelFile)){write({status:'cancelled'});return;}
  const fd=openSync(join(dir,'output.log'),'a');
  let written=0,outputTruncated=false;
  const emit=buf=>{
    const block=Buffer.isBuffer(buf)?buf:Buffer.from(buf);
    const remaining=state.maxLogBytes-written;
    if(remaining>0){const n=Math.min(remaining,block.length);writeSync(fd,block,0,n);written+=n;if(n<block.length)outputTruncated=true;}
    else if(block.length>0)outputTruncated=true;
  };
  let child;
  try{
    child=spawn(state.command,state.args,{cwd:state.project,windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe'],...treeSpawnOptions(spawn)});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    write({status:'running',workerPid:process.pid,childPid:child.pid});
    child.stdout.on('data',emit);child.stderr.on('data',emit);
    const heartbeat=setInterval(()=>writeFileSync(join(dir,'heartbeat'),'1',{mode:0o600}),500);
    let emergency;
    const cancelCheck=setInterval(()=>{
      if(existsSync(cancelFile)){
        clearInterval(cancelCheck);
        terminateTree(child,'SIGTERM');
        emergency=setTimeout(()=>terminateTree(child,'SIGKILL'),1500);emergency.unref();
      }
    },100);
    const result=await new Promise(resolve=>{
      child.once('error',error=>resolve({code:null,error:error.message}));
      child.once('exit',()=>{
        const guard=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();},1000);guard.unref();
      });
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    clearInterval(heartbeat);clearInterval(cancelCheck);if(emergency)clearTimeout(emergency);
    write({status:existsSync(cancelFile)?'cancelled':result.code===0?'completed':'failed',exitCode:result.code,signal:result.signal??null,error:result.error??null,outputTruncated,finishedAt:Date.now()});
  }catch(error){write({status:existsSync(cancelFile)?'cancelled':'failed',error:error.message,finishedAt:Date.now()});}
  finally{closeSync(fd);}
}
if(process.argv[1]&&resolve(process.argv[1])===SELF&&process.argv[2]==='--worker'){
  runWorker(process.argv[3]).catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
}
