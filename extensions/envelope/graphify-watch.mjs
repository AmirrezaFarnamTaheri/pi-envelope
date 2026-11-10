/** Session-scoped, consent-only Graphify refresh watcher.
 * Reacts ONLY to code-like paths with a locally configured, offline AST-only
 * CLI update. Docs/media/unknown files are marked for manual rebuild.
 * Never reads source bodies, walks symlinks, starts a server or registers hooks.
 */
import {lstatSync,readdirSync,realpathSync,openSync,closeSync,writeSync,watch as fsWatch} from 'node:fs';
import {constants} from 'node:fs';
import {extname,join,resolve,sep} from 'node:path';

const SKIP_DIRS=new Set(['.git','node_modules','graphify-out','dist','build','coverage','.cache','.next','.turbo','vendor','__pycache__','.venv','.tox','.pnpm-store']);
const CODE_SUFFIXES=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.mts','.cts','.py','.pyi','.go','.rs','.java','.c','.h','.cc','.cpp','.hpp','.cxx','.rb','.swift','.kt','.scala','.php','.lua','.zig','.dart','.ex','.exs','.vue','.svelte','.cs','.fs','.fsx','.sh','.bash']);
const MANUAL_SUFFIXES=new Set(['.md','.mdx','.txt','.rst','.pdf','.png','.jpg','.jpeg','.svg','.gif','.webp','.json','.jsonc','.yml','.yaml','.toml','.xml','.csv','.docx','.pptx','.html','.css','.scss','.sql','.lock']);
const MAX_DIRS=64;
const MAX_PENDING=256;
const EMPTY=Object.freeze({active:false,watchedDirectories:0,pendingCodeFiles:0,pending:false,updating:false,manualRebuildRequired:false,queueOverflow:false,batches:0,lastOutcome:'never',automaticLLM:false,sessionScoped:true});

function normalizeRoot(root){
  if(typeof root!=='string'||!root.trim())throw new TypeError('project root required');
  const canonical=realpathSync(resolve(root));
  if(!lstatSync(canonical).isDirectory())throw new TypeError('project root is not a directory');
  return canonical;
}
function storedKey(sessions,root){
 try{return normalizeRoot(root);}
 catch{
   // The already-authorized canonical path survives a rename/deletion even if
   // realpathSync no longer succeeds. Never resolve a new, untracked project.
   if(typeof root!=='string'||!root.trim())return null;
   const previous=resolve(root);
   return sessions.has(previous)?previous:null;
 }
}
function markGraphStale(root){
 // Graphify's existing needs_update marker is honored by *both* read adapters
 // and survives the current Pi session. Watcher consent authorizes this
 // metadata invalidation, never code/model execution.
 const dir=join(root,'graphify-out');let st;
 try{st=lstatSync(dir);}catch(err){if(err.code==='ENOENT')return;throw err;}
 if(st.isSymbolicLink()||!st.isDirectory())throw new Error('unsafe graph output directory');
 const path=join(dir,'needs_update');let fd;
 try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);}
 catch(err){
   if(err.code==='EEXIST'){
     const existing=lstatSync(path);
     if(existing.isFile()&&!existing.isSymbolicLink())return;
   }
   throw err;
 }
 try{writeSync(fd,Buffer.from('manual-rebuild-required'));}
 finally{closeSync(fd);}
}
function checkedDirectory(root,dir){
  const st=lstatSync(dir),canonical=realpathSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||canonical!==dir||
    (dir!==root&&!dir.startsWith(root+sep)))
    throw new Error('unsafe graph watch source directory or symlink');
  return {ino:st.ino,dev:st.dev};
}
function sourceDirectories(root){
  const dirs=[],queue=[root];
  for(let index=0;index<queue.length;index++){
    const dir=queue[index];
    if(dirs.length>=MAX_DIRS)throw new RangeError('graph watch directory budget exceeded');
    checkedDirectory(root,dir);
    dirs.push(dir);
    let entries;
    try{entries=readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));}
    catch{throw new Error('graph watch source directory unavailable');}
    for(const entry of entries){
      if(!entry.isDirectory()||entry.isSymbolicLink()||SKIP_DIRS.has(entry.name)||entry.name.startsWith('.'))continue;
      if(queue.length>=MAX_DIRS)throw new RangeError('graph watch directory budget exceeded');
      queue.push(join(dir,entry.name));
    }
  }
  return dirs;
}
function safeFilename(value){
  if(Buffer.isBuffer(value))value=value.toString('utf8');
  if(typeof value!=='string'||value.length<1||value.length>180||value==='.'||value==='..'||
    value.includes('/')||value.includes('\\')||/[\u0000-\u001f\u007f]/.test(value))return null;
  return value;
}
function isTemporary(name){
  return name.startsWith('.')||name.endsWith('~')||name.endsWith('.swp')||
    name.endsWith('.swx')||name.endsWith('.tmp')||name.endsWith('.bak')||
    name.endsWith('.orig');
}
function watchSnapshot(session){
  if(!session)return {...EMPTY};
  if(session.closed)return {...EMPTY,manualRebuildRequired:session.manual,queueOverflow:session.overflow,lastOutcome:session.lastOutcome,batches:session.batches};
  return {active:true,watchedDirectories:session.handles.length,
    pendingCodeFiles:session.pending.size,pending:session.timer!==null,
    updating:session.running!==null,manualRebuildRequired:session.manual,
    queueOverflow:session.overflow,batches:session.batches,lastOutcome:session.lastOutcome,
    automaticLLM:false,sessionScoped:true};
}
export class GraphifyWatchCoordinator {
  constructor({watchFactory=fsWatch,markStale=markGraphStale}={}){
    if(typeof watchFactory!=='function'||typeof markStale!=='function')throw new TypeError('watch factory and stale reporter required');
    this.watchFactory=watchFactory;
    this.markStale=markStale;
    this.sessions=new Map();
  }
  status(root){
    const key=storedKey(this.sessions,root);
    return watchSnapshot(key?this.sessions.get(key):null);
  }
  flagManual(session){
    session.manual=true;
    session.controller?.abort(); // Never accept a running result after source-universe uncertainty.
    try{this.markStale(session.root);}catch{session.lastOutcome='failed';}
  }
  start(root,{runUpdate,debounceMs=1200,codeSuffixes=CODE_SUFFIXES}={}){
    if(typeof runUpdate!=='function')throw new TypeError('Graphify watch requires an authorized code update runner');
    if(!(codeSuffixes instanceof Set)||[...codeSuffixes].some(s=>typeof s!=='string'||!/^[.][a-z0-9]{1,8}$/.test(s)))
      throw new TypeError('watch source suffix set is invalid');
    if(!Number.isInteger(debounceMs)||debounceMs<250||debounceMs>10000)throw new RangeError('Graphify watch debounce must be 250..10000 ms');
    const key=normalizeRoot(root);
    const dirs=sourceDirectories(key); // fail before disrupting an existing watch
    if(this.sessions.get(key)?.running)throw new Error('Graphify watch update still running; stop and wait before restart');
    this.stop(key);
    const session={root:key,debounceMs,runUpdate,codeSuffixes:new Set(codeSuffixes),handles:[],pending:new Set(),
      timer:null,running:null,controller:null,manual:false,overflow:false,
      batches:0,lastOutcome:'never',closed:false};
    try{
      for(const dir of dirs){
        const before=checkedDirectory(key,dir);
        const handle=this.watchFactory(dir,{persistent:false},(_event,filename)=>this.change(session,dir,filename));
        if(!handle||typeof handle.close!=='function')throw new Error('invalid watcher handle');
        session.handles.push(handle);
        const after=checkedDirectory(key,dir);
        if(before.dev!==after.dev||before.ino!==after.ino)throw new Error('graph watch directory replaced during start');
        // fs.FSWatcher emits an error event on watch failure. Without a listener
        // Node would terminate the entire Pi process. Fail closed instead.
        handle.on?.('error',()=>{
          if(session.closed)return;
          this.flagManual(session);session.lastOutcome='failed';
          this.halt(session);
        });
      }
    }catch{
      for(const h of session.handles){try{h.close();}catch{/* closing */}}
      throw new Error('Graphify watch setup failed: directory watch unavailable');
    }
    this.sessions.set(key,session);
    return watchSnapshot(session);
  }
  change(session,dir,rawName){
    if(session.closed)return;
    const name=safeFilename(rawName);
    if(!name){this.flagManual(session);return;}
    if(SKIP_DIRS.has(name)||isTemporary(name))return;
    let st;
    try{st=lstatSync(join(dir,name));}catch{/* Source can be deleted; Graphify update handles removal. */}
    if(st?.isDirectory()||st?.isSymbolicLink()){this.flagManual(session);return;}
    if(st&&!st.isFile()){this.flagManual(session);return;}
    const suffix=extname(name).toLowerCase();
    if(!session.codeSuffixes.has(suffix)){
      if(MANUAL_SUFFIXES.has(suffix)||suffix||name)this.flagManual(session);
      return;
    }
    if(session.overflow)return;
    if(!session.pending.has(join(dir,name))&&session.pending.size>=MAX_PENDING){
      session.pending.clear();session.overflow=true;this.flagManual(session);
      if(session.timer){clearTimeout(session.timer);session.timer=null;}
      return;
    }
    session.pending.add(join(dir,name));
    this.schedule(session);
  }
  schedule(session){
    if(session.closed||session.manual||session.overflow||session.pending.size===0)return;
    if(session.timer)clearTimeout(session.timer);
    session.timer=setTimeout(()=>{session.timer=null;void this.flush(session.root);},session.debounceMs);
    session.timer.unref?.();
  }
  async flush(root){
    const key=storedKey(this.sessions,root);
    const session=key?this.sessions.get(key):null;
    if(!session||session.closed)return {...EMPTY};
    if(session.timer){clearTimeout(session.timer);session.timer=null;}
    if(session.running)return session.running;
    if(session.manual||session.overflow||!session.pending.size)return watchSnapshot(session);
    session.pending.clear();
    const controller=new AbortController();
    session.controller=controller;
    session.lastOutcome='running';
    // Invoke the approved runner immediately (existing synchronous contract),
    // but defer both success and failure cleanup to promise microtasks, after
    // session.running has been assigned. A synchronous throw is normalized.
    let executing;
    try{executing=Promise.resolve(session.runUpdate(key,controller.signal));}
    catch(error){executing=Promise.reject(error);}
    const settled=executing.then(()=>{
      if(!session.closed){
        if(session.manual||controller.signal.aborted){session.lastOutcome='manual-required';this.halt(session);}
        else{session.batches++;session.lastOutcome='ok';}
      }
    },()=>{
      if(!session.closed){
        session.lastOutcome='failed';this.flagManual(session);
        this.halt(session); // no uncontrolled retry after a failed update
      }
    }).finally(()=>{
      session.controller=null;
      session.running=null;
      if(!session.closed&&session.pending.size&&!session.overflow)this.schedule(session);
    });
    session.running=settled.then(()=>watchSnapshot(session));
    return session.running;
  }
  halt(session){
    if(session.closed)return;
    session.closed=true;
    if(session.timer){clearTimeout(session.timer);session.timer=null;}
    session.controller?.abort();
    for(const handle of session.handles){try{handle.close();}catch{/* close only */}}
    session.handles=[];session.pending.clear();
  }
  /** Cancel now, but wait for in-flight writes to settle before manual writes. */
  async stopAndWait(root){
    const key=storedKey(this.sessions,root);
    const running=key?this.sessions.get(key)?.running:null;
    if(key)this.stop(key);
    if(running)await running;
    return {...EMPTY};
  }
  stop(root){
    if(root===undefined){for(const key of [...this.sessions.keys()])this.stop(key);return;}
    const key=storedKey(this.sessions,root);
    const session=key?this.sessions.get(key):null;if(!session)return;
    this.halt(session);
    this.sessions.delete(key);
  }
  close(){this.stop();}
}
