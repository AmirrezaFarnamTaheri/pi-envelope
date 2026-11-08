import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GraphifyWatchCoordinator} from '../extensions/envelope/graphify-watch.mjs';
import {GraphifyCliBridge} from '../extensions/envelope/graphify-cli.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';

function fixture(t){
 const base=mkdtempSync(join(tmpdir(),'graphify-watch-safety-'));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=join(base,'repo');mkdirSync(root);mkdirSync(join(root,'src'));
 writeFileSync(join(root,'src','entry.ts'),'export const x=1;');
 const handles=[];
 const watcher=new GraphifyWatchCoordinator({watchFactory(dir,_opts,cb){
   const handle=new EventEmitter();
   Object.assign(handle,{dir,callback:cb,closed:false,close(){this.closed=true;}});
   handles.push(handle);return handle;
 }});
 const emit=name=>{
   const h=handles.find(v=>!v.closed&&v.dir===join(root,'src'));
   assert.ok(h,'source watcher exists');h.callback('change',name);
 };
 return {root,base,handles,watcher,emit};
}

test('filesystem watcher errors never crash Pi; they halt refresh and preserve a redacted manual rebuild warning',t=>{
 const f=fixture(t);
 f.watcher.start(f.root,{runUpdate:async()=>{}});
 const h=f.handles.find(v=>v.dir===join(f.root,'src'));
 assert.doesNotThrow(()=>h.emit('error',new Error('PRIVATE_PATH_OR_KEY')));
 const s=f.watcher.status(f.root);
 assert.equal(s.active,false);
 assert.equal(s.manualRebuildRequired,true);
 assert.equal(s.lastOutcome,'failed');
 assert.ok(f.handles.every(v=>v.closed));
 assert.doesNotMatch(JSON.stringify(s),/PRIVATE_PATH_OR_KEY/);
});

test('failed automatic updates do not retry after later file events without new explicit opt-in',async t=>{
 const f=fixture(t);let called=0;
 f.watcher.start(f.root,{runUpdate:()=>{called++;throw Error('untrusted file');}});
 f.emit('entry.ts');await f.watcher.flush(f.root);
 assert.equal(called,1);
 assert.equal(f.watcher.status(f.root).active,false);
 assert.equal(f.watcher.status(f.root).manualRebuildRequired,true);
 for(const h of f.handles)h.callback('change','entry.ts');
 await f.watcher.flush(f.root);
 assert.equal(called,1);
});

test('stopAndWait aborts and waits for the previous write to settle before manual changes',async t=>{
 const f=fixture(t);let finish,signal;
 f.watcher.start(f.root,{runUpdate:(_root,s)=>{
   signal=s;return new Promise(resolve=>{finish=resolve;});
 }});
 f.emit('entry.ts');
 const running=f.watcher.flush(f.root);
 assert.equal(signal.aborted,false);
 let settled=false;
 const stopped=f.watcher.stopAndWait(f.root).then(()=>{settled=true;});
 await Promise.resolve();
 assert.equal(signal.aborted,true);
 assert.equal(settled,false);
 finish();await running;await stopped;
 assert.equal(settled,true);
 assert.equal(f.watcher.status(f.root).active,false);
});

function executableFixture(t,script){
 const f=fixture(t);
 mkdirSync(join(f.root,'graphify-out'));
 writeFileSync(join(f.root,'graphify-out','graph.json'),JSON.stringify({nodes:[{id:'A'},{id:'B'}],links:[{source:'A',target:'B',relation:'calls'}]}));
 const executable=join(f.base,'graphify-test');
 writeFileSync(executable,'#!/usr/bin/env node\n'+script+'\n');
 chmodSync(executable,0o700);
 return {...f,config:{enabled:true,executable,timeoutMs:3000}};
}

test('the CLI rejects simultaneous project graph mutations, then releases its write guard on cancellation',async t=>{
 const f=executableFixture(t,'setInterval(()=>{},5000)');
 const cli=new GraphifyCliBridge();
 const controller=new AbortController();
 const first=cli.run(f.root,f.config,{action:'update'},controller.signal,{humanCommand:true});
 const caught=first.then(()=>null,e=>e);
 await assert.rejects(()=>cli.run(f.root,f.config,{action:'build'},undefined,{humanCommand:true}),/in progress|concurrent|busy/i);
 controller.abort();
 assert.match((await caught).message,/cancel/i);
});

test('Graphify child stderr cannot reveal tokens or source paths in agent error messages',async t=>{
 const f=executableFixture(t,"process.stderr.write('PRIVATE_API_KEY');process.exit(4)");
 const cli=new GraphifyCliBridge();
 await assert.rejects(()=>cli.run(f.root,f.config,{action:'query',question:'dependency'}),error=>{
   assert.equal(error.message.includes('PRIVATE_API_KEY'),false);
   assert.match(error.message,/exit|failed/i);
   return true;
 });
});

test('Pi manual build waits for a cancelled automatic refresh and keeps single hook ownership',async t=>{
 const f=fixture(t);let release,signal;
 const operations=[],commands=new Map(),hooks=new Map();
 const cli={
   async run(_root,_config,params,providedSignal){
     operations.push(params.action);
     if(params.action==='status')return {available:true,artifactState:'unverified'};
     if(params.action==='update'){
       signal=providedSignal;return new Promise(resolve=>{release=()=>resolve({artifactState:'unverified'});});
     }
     return {action:'build',artifactState:'unverified',artifactChanged:true,output:''};
   },close(){}
 };
 const pi={cwd:f.root,logger:{warn(){}},
   on(name,handler){hooks.set(name,[...(hooks.get(name)||[]),handler]);},
   registerTool(){},registerCommand(name,command){commands.set(name,command)}
 };
 registerEnvelope(pi,{home:join(f.base,'home'),graphifyCliBridge:cli,graphifyWatcher:f.watcher});
 const ctx={cwd:f.root,ui:{notify(){}}};
 const command=words=>commands.get('envelope').handler(words,ctx);
 await command('graphify on');await command('graphify watch on 250');
 assert.equal(hooks.get('before_agent_start').length,1);
 f.emit('entry.ts');
 const running=f.watcher.flush(f.root);
 assert.equal(operations.filter(x=>x==='update').length,1);
 let settled=false;
 const build=command('graphify build').then(()=>{settled=true;});
 await Promise.resolve();
 assert.equal(signal.aborted,true);
 assert.equal(operations.includes('build'),false);
 assert.equal(settled,false);
 release();await running;await build;
 assert.deepEqual(operations,['status','update','build']);
 assert.equal(f.watcher.status(f.root).active,false);
});
