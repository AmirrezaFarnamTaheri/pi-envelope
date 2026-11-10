import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GraphifyWatchCoordinator} from '../extensions/envelope/graphify-watch.mjs';

function fixture(t){
  const top=mkdtempSync(join(tmpdir(),'envelope-graphify-watch-'));
  t.after(()=>rmSync(top,{recursive:true,force:true}));
  const repo=join(top,'repo');mkdirSync(repo);
  for(const dir of ['src','src/shared','node_modules','graphify-out','.git'])mkdirSync(join(repo,dir),{recursive:true});
  writeFileSync(join(repo,'src','base.ts'),'export function base() {return 1}');
  const handles=[],updates=[];
  const watchFactory=(dir,options,callback)=>{
    assert.equal(options.persistent,false);
    const h={dir,callback,closed:false,close(){this.closed=true;}};handles.push(h);return h;
  };
  const coordinator=new GraphifyWatchCoordinator({watchFactory});
  const emit=(directory,name,event='change')=>{
    const h=handles.find(x=>!x.closed&&x.dir===join(repo,directory));
    assert.ok(h,'missing directory watcher '+directory);h.callback(event,name);
  };
  const runUpdate=(root,signal)=>{updates.push({root,signal});return Promise.resolve({action:'update'});};
  return {repo,top,handles,updates,coordinator,emit,runUpdate};
}
test('session-scoped watcher is off by default, excludes generated and symlink directories',t=>{
  const f=fixture(t),outside=join(f.top,'elsewhere');mkdirSync(outside);symlinkSync(outside,join(f.repo,'outside-link'));
  assert.equal(f.coordinator.status(f.repo).active,false);
  const s=f.coordinator.start(f.repo,{runUpdate:f.runUpdate,debounceMs:250});
  assert.equal(s.active,true);assert.equal(s.watchedDirectories,3);
  assert.ok(!f.handles.some(x=>/node_modules|graphify-out|\.git|outside-link/.test(x.dir)));
  f.coordinator.close();assert.ok(f.handles.every(x=>x.closed));
});
test('multiple code events coalesce into one update and never leak source filenames',async t=>{
  const f=fixture(t);f.coordinator.start(f.repo,{runUpdate:f.runUpdate,debounceMs:250});
  f.emit('src','base.ts');f.emit('src','base.ts');f.emit('src','new.ts');
  assert.equal(f.coordinator.status(f.repo).pendingCodeFiles,2);
  await f.coordinator.flush(f.repo);
  const s=f.coordinator.status(f.repo);
  assert.equal(s.pendingCodeFiles,0);assert.equal(s.batches,1);assert.equal(s.lastOutcome,'ok');
  assert.equal(f.updates.length,1);assert.equal(f.updates[0].root,f.repo);
  assert.doesNotMatch(JSON.stringify(s),/base\.ts|new\.ts/);f.coordinator.close();
});
test('docs/media/unknown/temporary files require manual rebuild, never an automatic update',async t=>{
  const f=fixture(t);f.coordinator.start(f.repo,{runUpdate:f.runUpdate,debounceMs:250});
  for(const name of ['architecture.md','guide.pdf','diagram.png','config.yaml','readme.mdx','image.tmp','component.ts.bak','base.ts.swp'])f.emit('src',name);
  await f.coordinator.flush(f.repo);
  assert.equal(f.updates.length,0);assert.equal(f.coordinator.status(f.repo).manualRebuildRequired,true);
  f.coordinator.close();
});
test('invalid and escaped filenames never cause a project read or update',async t=>{
  const f=fixture(t);f.coordinator.start(f.repo,{runUpdate:f.runUpdate,debounceMs:250});
  for(const name of ['../../escape.ts','sub/file.ts','..\\escape.ts',null,Buffer.from('../bad.ts')])f.emit('src',name);
  await f.coordinator.flush(f.repo);assert.equal(f.updates.length,0);
  assert.equal(f.coordinator.status(f.repo).manualRebuildRequired,true);f.coordinator.close();
});
test('updates serialize and coalesce new changes arriving during an active update',async t=>{
  const f=fixture(t);let release,calls=0;
  const runUpdate=()=>{calls++;return calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({action:'update'});};
  f.coordinator.start(f.repo,{runUpdate,debounceMs:250});f.emit('src','base.ts');
  const pending=f.coordinator.flush(f.repo);
  assert.equal(calls,1);assert.equal(f.coordinator.status(f.repo).updating,true);
  f.emit('src','new.ts');assert.equal(calls,1);
  release({action:'update'});await pending;
  assert.equal(f.coordinator.status(f.repo).pendingCodeFiles,1);
  await f.coordinator.flush(f.repo);
  assert.equal(calls,2);assert.equal(f.coordinator.status(f.repo).batches,2);f.coordinator.close();
});
test('stop aborts a running update, closes handles and never restarts',async t=>{
  const f=fixture(t);let signal,release;
  const runUpdate=(_root,s)=>{signal=s;return new Promise(resolve=>{release=resolve;});};
  f.coordinator.start(f.repo,{runUpdate,debounceMs:250});f.emit('src','base.ts');
  const pending=f.coordinator.flush(f.repo);
  assert.equal(signal.aborted,false);f.coordinator.stop(f.repo);assert.equal(signal.aborted,true);
  release();await pending;
  assert.equal(f.coordinator.status(f.repo).active,false);assert.ok(f.handles.every(x=>x.closed));
});
test('failure and queue overflow stop automatic updates and require manual rebuild',async t=>{
  const f=fixture(t);let calls=0;
  const runUpdate=()=>{calls++;throw Error('private project secrets must not leak');};
  f.coordinator.start(f.repo,{runUpdate,debounceMs:250});
  f.emit('src','base.ts');await f.coordinator.flush(f.repo);
  const s=f.coordinator.status(f.repo);
  assert.equal(s.lastOutcome,'failed');assert.equal(s.manualRebuildRequired,true);
  assert.doesNotMatch(JSON.stringify(s),/private project secrets|base\.ts/);
  await f.coordinator.flush(f.repo);assert.equal(calls,1);
  f.coordinator.stop(f.repo);f.coordinator.start(f.repo,{runUpdate,debounceMs:250});
  for(let i=0;i<260;i++)f.emit('src','a-'+i+'.ts');
  await f.coordinator.flush(f.repo);assert.equal(calls,1);
  assert.equal(f.coordinator.status(f.repo).manualRebuildRequired,true);
  assert.equal(f.coordinator.status(f.repo).queueOverflow,true);f.coordinator.close();
});
test('new directories are explicitly uncovered until watch is restarted',async t=>{
  const f=fixture(t);f.coordinator.start(f.repo,{runUpdate:f.runUpdate,debounceMs:250});
  mkdirSync(join(f.repo,'src','newdir'));f.emit('src','newdir','rename');await f.coordinator.flush(f.repo);
  assert.equal(f.updates.length,0);
  assert.equal(f.coordinator.status(f.repo).manualRebuildRequired,true);
  assert.equal(f.handles.some(h=>h.dir===join(f.repo,'src','newdir')),false);f.coordinator.close();
});
test('invalid configuration and oversized directory fanout fail closed',t=>{
  const f=fixture(t);
  assert.throws(()=>f.coordinator.start(f.repo,{debounceMs:250}),/update/i);
  assert.throws(()=>f.coordinator.start(f.repo,{runUpdate:f.runUpdate,debounceMs:3}),/debounce/i);
  for(let i=0;i<70;i++)mkdirSync(join(f.repo,'module-'+i));
  assert.throws(()=>f.coordinator.start(f.repo,{runUpdate:f.runUpdate,debounceMs:250}),/budget|directory|limit/i);
  assert.equal(f.coordinator.status(f.repo).active,false);
});

test('ambiguous and directory events invalidate graph persistently and stop further automatic updates',async t=>{
 const f=fixture(t);
 f.coordinator.start(f.repo,{runUpdate:f.runUpdate,debounceMs:250});
 mkdirSync(join(f.repo,'src','newdir'));
 f.emit('src','newdir');
 assert.equal(f.coordinator.status(f.repo).manualRebuildRequired,true);
 assert.equal(existsSync(join(f.repo,'graphify-out','needs_update')),true);
 f.emit('src','base.ts');await f.coordinator.flush(f.repo);
 assert.equal(f.updates.length,0,'manual recovery must block code auto-updates');
 f.coordinator.close();
 assert.equal(existsSync(join(f.repo,'graphify-out','needs_update')),true);
});

test('stopAndWait finds and cancels authorized session after project root is renamed',async t=>{
 const f=fixture(t);let resolveUpdate,signal;
 f.coordinator.start(f.repo,{runUpdate:(_root,s)=>{signal=s;return new Promise(res=>{resolveUpdate=res;});}});
 f.emit('src','base.ts');const running=f.coordinator.flush(f.repo);
 const moved=join(f.top,'renamed');renameSync(f.repo,moved);
 assert.equal(f.coordinator.status(f.repo).updating,true);
 let finished=false;
 const stopped=f.coordinator.stopAndWait(f.repo).then(()=>{finished=true;});
 assert.equal(signal.aborted,true);
 assert.equal(finished,false);
 resolveUpdate();await running;await stopped;
 assert.equal(f.coordinator.status(f.repo).active,false);
 assert.ok(f.handles.every(h=>h.closed));
});


test('synchronous watch runner failure clears running so an explicit restart is permitted',async t=>{
 const f=fixture(t);
 f.coordinator.start(f.repo,{runUpdate:()=>{throw Error('untrusted update failed');}});
 f.emit('src','base.ts');
 await f.coordinator.flush(f.repo);
 const result=f.coordinator.status(f.repo);
 assert.equal(result.active,false);assert.equal(result.manualRebuildRequired,true);
 const restarted=f.coordinator.start(f.repo,{runUpdate:async()=>{},debounceMs:250});
 assert.equal(restarted.active,true);
 f.coordinator.close();
});

test('watch activation refuses a directory replaced by a symlink during handle creation',t=>{
 const f=fixture(t),outside=join(f.top,'outside-subtree');mkdirSync(outside);
 let swapped=false;
 const coordinator=new GraphifyWatchCoordinator({watchFactory:(dir,_opt,_cb)=>{
   if(!swapped&&dir===join(f.repo,'src')){
     swapped=true;
     const renamed=join(f.repo,'source-original');
     renameSync(dir,renamed);
     symlinkSync(outside,dir);
   }
   const h={closed:false,close(){this.closed=true;}};
   return h;
 }});
 assert.throws(()=>coordinator.start(f.repo,{runUpdate:async()=>{}}),/unsafe|replaced|setup failed|symlink/i);
 assert.equal(coordinator.status(f.repo).active,false);
});

test('embedding-only stale-source retry runs once when fresh changes are pending',async t=>{
  const f=fixture(t);let rejectFirst,calls=0;
  f.coordinator.start(f.repo,{debounceMs:250,retryStaleSource:true,
    runUpdate:()=>{calls++;return calls===1?new Promise((_,reject)=>{rejectFirst=reject;}):Promise.resolve({action:'ok'});}});
  f.emit('src','base.ts');
  const pending=f.coordinator.flush(f.repo);
  f.emit('src','base.ts');
  rejectFirst(new Error('source changed during embedding; retry after index refresh'));
  await pending;
  assert.equal(calls,2);
  assert.equal(f.coordinator.status(f.repo).lastOutcome,'ok');
  assert.equal(f.coordinator.status(f.repo).active,true);
  f.coordinator.close();
});

test('stale-source error may retry only once; a second failure always halts',async t=>{
  const f=fixture(t);let rejectFirst,calls=0;
  f.coordinator.start(f.repo,{debounceMs:250,retryStaleSource:true,
    runUpdate:()=>{calls++;return calls===1?new Promise((_,reject)=>{rejectFirst=reject;}):Promise.reject(new Error('source changed during embedding; retry after index refresh'));}});
  f.emit('src','base.ts');
  const pending=f.coordinator.flush(f.repo);
  f.emit('src','base.ts');
  rejectFirst(new Error('source changed during embedding; retry after index refresh'));
  await pending;
  assert.equal(calls,2);
  const s=f.coordinator.status(f.repo);
  assert.equal(s.lastOutcome,'failed');assert.equal(s.manualRebuildRequired,true);
  f.coordinator.close();
});
