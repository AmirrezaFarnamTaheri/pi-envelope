/** Read-only Pi/Tersio smoke: no provider requests, no user prompts, no installs. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUpstreamBundle, verifyAstParserBundle } from './verify-bundle.mjs';

const SELF=fileURLToPath(import.meta.url);
const ROOT=dirname(dirname(SELF));
const check=(name,ok,detail)=>({name,ok:!!ok,detail});
const boundedTimeout=(ms)=>Number.isInteger(ms)&&ms>=100&&ms<=12000?ms:8000;
const MAX_STDERR_BYTES=8192;
const STDIN_ERROR_GRACE_MS=350;

/** Convert stderr to an allowlisted, redacted diagnostic without echoing raw data. */
function rpcStartupHint(stderr, stderrBytes) {
  if (/failed to load extension|error loading extension|extension load failed/i.test(stderr))
    return 'Pi reported extension load failure';
  if (/unknown (?:argument|option)|unrecognized (?:argument|option)|invalid option/i.test(stderr))
    return 'Pi rejected RPC command-line options';
  if (/cannot find module|ERR_MODULE_NOT_FOUND|module not found/i.test(stderr))
    return 'Pi reported a missing module';
  if (/missing.*(?:model|provider)|no (?:models|providers) (?:available|configured)/i.test(stderr))
    return 'Pi reported a model/provider configuration issue';
  return stderrBytes ? `Pi wrote ${stderrBytes} bytes on stderr (redacted)` : 'no stderr diagnostics';
}

/** A probe uses exactly the upstream resource list and Envelope's one native entrypoint. */
export async function probePiRpc({root,piCommand='pi',piPrefixArgs=[],upstream,timeoutMs=8000}={}) {
  const project=resolve(root);
  const resources=upstream.extensions.map(p=>join(project,'node_modules/@krtclcdy/tersio',p));
  const flags=['--mode','rpc','--no-session','--no-extensions',...resources.flatMap(p=>['--extension',p]),'--extension',join(project,'extensions/envelope/index.js')];
  const args=[...piPrefixArgs,...flags];
  return new Promise(resolveResult=>{
    let done=false,buffer=Buffer.alloc(0),child,stderrBytes=0,stderrCaptured=0,stdinError=false,stdoutBytes=0;
    const stderrChunks=[];
    const rpcEventTypes=new Set();
    const rpcUiMethods=new Set();
    let cancelledDialogs=0,stdinGrace=null;
    /** Report only raw byte counts and allowlisted event names, never request bodies. */
    const diagnostics=()=>{
      const stderr=Buffer.concat(stderrChunks,stderrCaptured).toString('utf8');
      return `stdout ${stdoutBytes} bytes; ${rpcStartupHint(stderr,stderrBytes)}${rpcEventTypes.size?`; event types: ${[...rpcEventTypes].join(',')}`:''}${rpcUiMethods.size?`; UI methods: ${[...rpcUiMethods].join(',')}`:''}${stderrBytes>MAX_STDERR_BYTES?`; stderr truncated at ${MAX_STDERR_BYTES} bytes`:''}${stdinError?'; stdin closed early':''}`;
    };
    /** Resolve once and stop both watchdogs; never leave a child process running. */
    const settle=(value)=>{
      if(done)return;
      done=true;clearTimeout(timeout);clearTimeout(stdinGrace);
      if(child){try{child.stdin.end();}catch{/* Child closed stdin before cleanup. */}
        if(child.exitCode===null)child.kill('SIGTERM');
        const force=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},300);force.unref();child.once('close',()=>clearTimeout(force));}
      resolveResult(value);
    };
    /** Allow the child a short grace period to close and flush its diagnostics. */
    const markStdinFailure=()=>{
      if(done||stdinError)return;
      stdinError=true;
      stdinGrace=setTimeout(()=>settle({ok:false,reason:`Pi RPC stdin write failed (${diagnostics()})`}),STDIN_ERROR_GRACE_MS);
    };
    const timeout=setTimeout(()=>settle({ok:false,reason:`Pi RPC command discovery timed out (${diagnostics()})`}),boundedTimeout(timeoutMs));
    try { child=spawn(piCommand,args,{cwd:project,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true}); }
    catch {settle({ok:false,reason:'Pi RPC could not start'});return;}
    child.on('error',()=>settle({ok:false,reason:'Pi executable unavailable'}));
    // Close, unlike exit, fires after stdout/stderr have been fully drained.
    child.on('close',(status,signal)=>{
      if(!done)settle({ok:false,reason:`Pi RPC closed before discovery (code ${status??'unknown'}${signal?`, signal ${signal}`:''}; ${diagnostics()})`});
    });
    child.stderr.on('data',chunk=>{
      stderrBytes+=chunk.length;
      if(stderrCaptured<MAX_STDERR_BYTES){
        const sample=Buffer.from(chunk.subarray(0,MAX_STDERR_BYTES-stderrCaptured));
        stderrChunks.push(sample);
        stderrCaptured+=sample.length;
      }
    });
    child.stdout.on('data',chunk=>{
      if(done)return;
      stdoutBytes+=chunk.length;
      if(buffer.length+chunk.length>1_000_000){settle({ok:false,reason:`Pi RPC output exceeded 1MB (${diagnostics()})`});return;}
      buffer=Buffer.concat([buffer,chunk]);
      for(;;){
        const n=buffer.indexOf(10);if(n<0)break;
        const line=buffer.subarray(0,n).toString('utf8').replace(/\r$/,'');
        buffer=buffer.subarray(n+1);
        if(!line)continue;
        let response;try{response=JSON.parse(line);}catch{settle({ok:false,reason:'Pi RPC sent invalid JSON'});return;}
        if(response?.type!=='response'){
          // Only report event *types*, never untrusted text, paths or other payload fields.
          const kind=String(response?.type??'unknown');
          if(/^[a-z][a-z_0-9]{0,39}$/.test(kind)&&rpcEventTypes.size<12)rpcEventTypes.add(kind);
          if(kind==='extension_ui_request'){
            const method=String(response.method??'');
            if(/^(select|confirm|input|editor|notify|setStatus|setWidget|setTitle|set_editor_text)$/.test(method)){
              rpcUiMethods.add(method);
            }
            if(/^(select|confirm|input|editor)$/.test(method)&&typeof response.id==='string'&&
               response.id.length>0&&response.id.length<=128){
              // Explicitly cancel; never approve a command or submit fake user input.
              if(++cancelledDialogs>4){settle({ok:false,reason:'Too many startup UI dialogs'});return;}
              try {child.stdin.write(JSON.stringify({type:'extension_ui_response',id:response.id,cancelled:true})+'\n');}
              catch {markStdinFailure();}
            }
          }
          continue;
        }
        if(response.id!=='envelope-smoke-commands'||response.command!=='get_commands'||response.success!==true){
          settle({ok:false,reason:'Unexpected Pi RPC discovery response'});return;
        }
        const commands=response.data?.commands;
        if(!Array.isArray(commands)){settle({ok:false,reason:'Pi returned no command list'});return;}
        const registered=commands.filter(x=>x?.source==='extension');
        const envelope=registered.filter(x=>x.name==='envelope').length;
        const tersio=registered.filter(x=>x.name==='tersio').length;
        if(envelope!==1||tersio!==1){
          settle({ok:false,reason:`Expected exactly one Envelope and Tersio command (found ${envelope}/${tersio})`});return;
        }
        settle({ok:true,reason:'Pi RPC loaded native Envelope and Tersio commands'});return;
      }
    });
    child.stdin.on('error',markStdinFailure);
    try {child.stdin.write(JSON.stringify({id:'envelope-smoke-commands',type:'get_commands'})+'\n');}
    catch {markStdinFailure();}
  });
}

/** Check installed pinned resources before attempting a read-only real Pi RPC handshake. */
export async function probeRuntime({root=ROOT,piCommand='pi',piPrefixArgs=[],timeoutMs=8000}={}) {
  const checks=[];
  let upstream,manifest;
  try {
    upstream=JSON.parse(readFileSync(join(root,'fixtures/tersio-pi-manifest.json'),'utf8'));
    manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  }catch{return {status:'failed',checks:[check('manifest',false,'Package manifest or Tersio fixture unavailable')]};}
  const bundle=verifyUpstreamBundle(root,{version:upstream.version,pi:{extensions:upstream.extensions,skills:upstream.skills}});
  checks.push(check('tersio',bundle.ok,bundle.ok?'Pinned upstream resources found':bundle.errors.join('; ')));
  const parser=verifyAstParserBundle(root,manifest.dependencies?.typescript);
  checks.push(check('typescript',parser.ok,parser.ok?'Pinned AST parser found':parser.errors.join('; ')));
  const version=spawnSync(piCommand,[...piPrefixArgs,'--version'],{cwd:root,encoding:'utf8',timeout:boundedTimeout(timeoutMs),maxBuffer:128_000,shell:false});
  const installed=version.status===0&&!version.error;
  checks.push(check('pi',installed,installed?'Pi executable responded':'Pi binary unavailable or failed version check'));
  if(!bundle.ok||!parser.ok||!installed)return {status:'blocked',checks};
  const rpc=await probePiRpc({root,piCommand,piPrefixArgs,upstream,timeoutMs});
  checks.push(check('rpc-commands',rpc.ok,rpc.reason));
  return {status:rpc.ok?'ready':'failed',checks};
}

if(process.argv[1]&&resolve(process.argv[1])===SELF){
  const report=await probeRuntime();
  console.log(JSON.stringify(report,null,2));
  if(report.status!=='ready')process.exitCode=report.status==='blocked'?2:1;
}
