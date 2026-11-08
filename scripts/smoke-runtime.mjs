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

/** A probe uses exactly the upstream resource list and Envelope's one native entrypoint. */
export async function probePiRpc({root,piCommand='pi',piPrefixArgs=[],upstream,timeoutMs=8000}={}) {
  const project=resolve(root);
  const resources=upstream.extensions.map(p=>join(project,'node_modules/@krtclcdy/tersio',p));
  const flags=['--mode','rpc','--no-session','--no-extensions',...resources.flatMap(p=>['--extension',p]),'--extension',join(project,'extensions/envelope/index.js')];
  const args=[...piPrefixArgs,...flags];
  return new Promise(resolveResult=>{
    let done=false,buffer=Buffer.alloc(0),child;
    const settle=(value)=>{
      if(done)return;
      done=true;clearTimeout(timeout);
      if(child){child.stdin.end();if(child.exitCode===null)child.kill('SIGTERM');
        const force=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},300);force.unref();child.once('close',()=>clearTimeout(force));}
      resolveResult(value);
    };
    const timeout=setTimeout(()=>settle({ok:false,reason:'Pi RPC command discovery timed out'}),boundedTimeout(timeoutMs));
    try { child=spawn(piCommand,args,{cwd:project,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true}); }
    catch {settle({ok:false,reason:'Pi RPC could not start'});return;}
    child.on('error',()=>settle({ok:false,reason:'Pi executable unavailable'}));
    child.on('exit',(status)=>{if(!done)settle({ok:false,reason:`Pi RPC exited before discovery (${status??'unknown'})`});});
    child.stderr.on('data',()=>{}); // discard diagnostic and potential credentials
    child.stdout.on('data',chunk=>{
      if(done)return;
      if(buffer.length+chunk.length>1_000_000){settle({ok:false,reason:'Pi RPC output exceeded 1MB'});return;}
      buffer=Buffer.concat([buffer,chunk]);
      for(;;){
        const n=buffer.indexOf(10);if(n<0)break;
        const line=buffer.subarray(0,n).toString('utf8').replace(/\r$/,'');
        buffer=buffer.subarray(n+1);
        if(!line)continue;
        let response;try{response=JSON.parse(line);}catch{settle({ok:false,reason:'Pi RPC sent invalid JSON'});return;}
        if(response?.type!=='response'||response.id!=='envelope-smoke-commands'||response.command!=='get_commands'||response.success!==true){
          // Non-response event records can be emitted during Pi startup.
          if(response?.type!=='response')continue;
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
    child.stdin.on('error',()=>settle({ok:false,reason:'Pi RPC stdin closed unexpectedly'}));
    child.stdin.write(JSON.stringify({id:'envelope-smoke-commands',type:'get_commands'})+'\n');
  });
}

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
