import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EmbeddingWatchCoordinator} from '../extensions/envelope/local-embedding-watch.mjs';

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-vector-watch-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src','entry.ts'),'export const x=1;');
 const handles=[],changes=[],status=[];
 const watchFactory=(dir,opts,callback)=>{
  assert.equal(opts.persistent,false);
  const h={dir,callback,closed:false,close(){this.closed=true;}};handles.push(h);return h;
 };
 const coordinator=new EmbeddingWatchCoordinator({watchFactory});
 let ready=true,enabled=true;
 const refresh=async()=>({root,checked:true});
 const preflight=async()=>{status.push('preflight');if(!ready)throw new Error('manifest stale; manual sync required');};
 const update=async(index,signal)=>{changes.push({index,signal});return {embedded:1};};
 const checkEnabled=()=>{if(!enabled)throw new Error('embedding watch revoked');};
 const emit=(name,dir='src')=>{
  const handle=handles.find(h=>!h.closed&&h.dir===join(root,dir));assert.ok(handle);
  handle.callback('change',name);
 };
 return {root,handles,changes,status,coordinator,refresh,preflight,update,checkEnabled,emit,
  setReady:v=>ready=v,setEnabled:v=>enabled=v};
}
test('off by default; explicit verified opt-in performs no encoding until a source event',async t=>{
 const f=setup(t);
 assert.equal(f.coordinator.status(f.root).active,false);
 const started=await f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:f.update,checkEnabled:f.checkEnabled,debounceMs:250});
 assert.equal(started.active,true);
 assert.equal(f.status.length,2,'check completeness before and after registering filesystem handles');
 assert.equal(f.changes.length,0,'watch on and status may not generate embeddings');
 f.emit('entry.ts');
 await f.coordinator.flush(f.root);
 assert.equal(f.changes.length,1);
 assert.equal(f.changes[0].index.root,f.root);
 assert.equal(f.coordinator.status(f.root).batches,1);
 await f.coordinator.stopAndWait(f.root);
 assert.ok(f.handles.every(h=>h.closed),'off closes all filesystem watchers');
});
test('coalesces burst edits and refuses automatic updates after ambiguous or non-code events',async t=>{
 const f=setup(t);
 await f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:f.update,checkEnabled:f.checkEnabled,debounceMs:250});
 f.emit('entry.ts');f.emit('entry.ts');
 await f.coordinator.flush(f.root);
 assert.equal(f.changes.length,1);
 f.emit('new-directory');
 assert.equal(f.coordinator.status(f.root).manualRebuildRequired,true);
 f.emit('entry.ts');await f.coordinator.flush(f.root);
 assert.equal(f.changes.length,1,'no automatic reactivation after manual warning');
 assert.equal(f.coordinator.status(f.root).active,true);
 assert.equal(f.coordinator.status(f.root).lastOutcome,'ok');
 await f.coordinator.stopAndWait(f.root);
});
test('missing, unsafe or changed source provenance at start leaves no watcher running',async t=>{
 const f=setup(t);
 f.setReady(false);
 await assert.rejects(f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:f.update,checkEnabled:f.checkEnabled}),/stale|manual sync/i);
 assert.equal(f.coordinator.status(f.root).active,false);
 assert.equal(f.handles.length,0);
 f.setReady(true);
 let inspections=0;
 await assert.rejects(f.coordinator.start(f.root,{refresh:f.refresh,
   preflight:async()=>{if(++inspections===2)throw new Error('sources changed during watch activation');},
   update:f.update,checkEnabled:f.checkEnabled}),/changed during watch activation/);
 assert.equal(f.coordinator.status(f.root).active,false);
 assert.ok(f.handles.every(h=>h.closed));
});
test('revoking consent or a failed encoder run disables further automatic updates',async t=>{
 const f=setup(t);
 await f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:f.update,checkEnabled:f.checkEnabled});
 f.setEnabled(false);
 f.emit('entry.ts');await f.coordinator.flush(f.root);
 assert.equal(f.changes.length,0);
 assert.equal(f.coordinator.status(f.root).manualRebuildRequired,true);
 assert.equal(f.coordinator.status(f.root).active,false);
 await f.coordinator.stopAndWait(f.root);
});
test('stop waits for pending worker abort before acknowledging revoked consent',async t=>{
 const f=setup(t);let onRelease,workerSignal;
 await f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:async(_,signal)=>{workerSignal=signal;return new Promise(resolve=>onRelease=resolve);},
  checkEnabled:f.checkEnabled,debounceMs:250});
 f.emit('entry.ts');const flushing=f.coordinator.flush(f.root);
 // Async refresh may defer update until a microtask.
 for(let i=0;i<20&&!workerSignal;i++)await Promise.resolve();
 assert.ok(workerSignal);
 let stopped=false;
 const stop=f.coordinator.stopAndWait(f.root).then(()=>{stopped=true;});
 assert.equal(workerSignal.aborted,true);
 assert.equal(stopped,false);
 onRelease();await flushing;await stop;
 assert.equal(f.coordinator.status(f.root).active,false);
 assert.ok(f.handles.every(h=>h.closed));
});


test('ambiguous file event aborts an already running automatic encoder update',async t=>{
 const f=setup(t);let workerSignal,release;
 await f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:async(_,signal)=>{workerSignal=signal;return new Promise(resolve=>release=resolve);},
  checkEnabled:f.checkEnabled,debounceMs:250});
 f.emit('entry.ts');
 const current=f.coordinator.flush(f.root);
 for(let i=0;i<30&&!workerSignal;i++)await Promise.resolve();
 assert.ok(workerSignal,'the automatic worker must have started');
 f.emit('untracked-config.yaml');
 assert.equal(f.coordinator.status(f.root).manualRebuildRequired,true);
 assert.equal(workerSignal.aborted,true,'source-universe uncertainty must cancel the running job');
 release();await current;
 await f.coordinator.stopAndWait(f.root);
});


test('a language absent from the current embedding index cannot masquerade as a clean sync',async t=>{
 const f=setup(t);
 await f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:f.update,checkEnabled:f.checkEnabled,debounceMs:250});
 f.emit('unindexed.rs');
 assert.equal(f.coordinator.status(f.root).manualRebuildRequired,true,
   'unsupported source languages must require review, not a successful no-op');
 await f.coordinator.flush(f.root);
 assert.equal(f.changes.length,0,'no encoder work should run for unsupported language changes');
 await f.coordinator.stopAndWait(f.root);
});


test('watcher pushes bounded active, syncing, recovery and stop states for native Pi status',async t=>{
 const f=setup(t),events=[];
 await f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:f.update,checkEnabled:f.checkEnabled,debounceMs:250,
  onStatus:s=>events.push({...s})});
 assert.ok(events.some(s=>s.active===true&&!s.updating));
 f.emit('entry.ts');
 await f.coordinator.flush(f.root);
 assert.ok(events.some(s=>s.updating),'visible indicator must distinguish a running encoder');
 assert.ok(events.some(s=>s.batches===1&&!s.updating),'batch completion must be visible');
 f.emit('settings.yaml');
 assert.ok(events.some(s=>s.manualRebuildRequired),'unsafe events must publish recovery state');
 await f.coordinator.stopAndWait(f.root);
 assert.equal(events.at(-1).active,false);
 assert.doesNotMatch(JSON.stringify(events),/settings[.]yaml|entry[.]ts|export const/);
});

test('UI status callback failures cannot break a source-sync operation or prevent stop',async t=>{
 const f=setup(t);
 await f.coordinator.start(f.root,{refresh:f.refresh,preflight:f.preflight,
  update:f.update,checkEnabled:f.checkEnabled,onStatus:()=>{throw Error('UI unavailable');}});
 f.emit('entry.ts');
 await f.coordinator.flush(f.root);
 assert.equal(f.coordinator.status(f.root).batches,1);
 await f.coordinator.stopAndWait(f.root);
 assert.equal(f.coordinator.status(f.root).active,false);
});
