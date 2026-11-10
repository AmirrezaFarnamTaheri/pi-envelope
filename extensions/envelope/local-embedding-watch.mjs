/** Explicitly authorized, session-local incremental embedding refresh.
 *
 * No timers, watchers or encoder processes exist until the user explicitly
 * issues /envelope code vectors watch on. Reuse the bounded Graphify watcher
 * but NEVER write Graphify's stale marker for embedding events.
 */
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {GraphifyWatchCoordinator} from './graphify-watch.mjs';
const EMBEDDING_SUFFIXES=new Set(['.ts','.tsx','.js','.jsx','.mts','.cts','.mjs','.cjs']);
const EMBEDDING_LANGUAGE_SUFFIXES=['.py','.pyi','.go'];

export class EmbeddingWatchCoordinator {
 constructor({watchFactory}={}){
  this.watcher=new GraphifyWatchCoordinator({watchFactory,markStale:()=>{}});
 }
 status(root){return this.watcher.status(root);}
 flush(root){return this.watcher.flush(root);}
 async start(root,{refresh,preflight,update,checkEnabled,debounceMs=1200}={}){
  if([refresh,preflight,update,checkEnabled].some(fn=>typeof fn!=='function'))
    throw new TypeError('embedding watch requires explicit consent and verified source/update handlers');
  if(!Number.isInteger(debounceMs)||debounceMs<250||debounceMs>10000)
    throw new RangeError('embedding watch debounce must be 250..10000 ms');
  const canonical=realpathSync(resolve(root));
  if(this.status(canonical).active)
    throw new Error('embedding watch is already active; explicitly turn off before restarting');
  const currentIndex=async()=>{
   const index=await refresh();
   if(!index||index.root!==canonical)throw new Error('embedding watch project identity changed');
   return index;
  };
  checkEnabled();
  const initial=await currentIndex();
  await preflight(initial); // No model execution on enable
  checkEnabled();
  const codeSuffixes=new Set(EMBEDDING_SUFFIXES);
  if(initial.languagesEnabled===true)for(const suffix of EMBEDDING_LANGUAGE_SUFFIXES)codeSuffixes.add(suffix);
  const status=this.watcher.start(canonical,{debounceMs,codeSuffixes,
   runUpdate:async(_root,signal)=>{
    if(signal.aborted)throw new Error('embedding watch cancelled');
    checkEnabled();
    const index=await currentIndex();
    if(signal.aborted)throw new Error('embedding watch cancelled');
    checkEnabled();
    return update(index,signal); // LocalEmbeddingRuntime.sync owns the writer lock
   }
  });
  try{
   // Close the race between preflight and newly installed filesystem watches.
   checkEnabled();
   await preflight(await currentIndex());
   checkEnabled();
  }catch(error){
   await this.watcher.stopAndWait(canonical);
   throw error;
  }
  return status;
 }
 stopAndWait(root){return this.watcher.stopAndWait(root);}
 stop(root){return this.watcher.stop(root);}
 close(){this.watcher.close();}
}
