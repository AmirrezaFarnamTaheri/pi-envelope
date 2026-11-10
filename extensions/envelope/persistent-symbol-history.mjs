/**
 * Opt-in, durable, project-scoped snapshots of the existing AST symbol index.
 * Stores project-relative filenames, symbol identifiers/lines, SHA-256s and
 * coverage metadata only. Never stores source bodies, executes project code,
 * infers renames, or automatically captures a session.
 */
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,closeSync,constants,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';

const DB_VERSION=1,MAX_SNAPSHOTS=20,MAX_FILES=1000,MAX_SYMBOLS=20000;
const MAX_SOURCE_BYTES=1_000_000,MAX_VERIFIED_BYTES=20_000_000,MAX_SYMBOLS_PER_FILE=512;
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const sortedUnique=values=>[...new Set(values)].sort();
function numeric(value,def,min,max,name){
  if(value===undefined)return def;
  if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`${name} must be ${min}..${max}`);
  return value;
}
function validId(id){if(typeof id!=='string'||!ID.test(id))throw new TypeError('invalid snapshot ID');return id;}
function scoped(index){
  if(!index?.root||!index.files||typeof index.checkedPath!=='function')throw new TypeError('current CodeIndex required');
  return hash(realpathSync(index.root));
}
function sourceBytes(index,key){
  // Reject symlinks at every component rather than trusting a cached AST path.
  let path=realpathSync(index.root);
  for(const part of key.split('/')){
    if(!part||part==='.'||part==='..')throw new Error('invalid indexed source path');
    path=join(path,part);
    const st=lstatSync(path);
    if(st.isSymbolicLink())throw new Error('symlink source path refused');
  }
  if(index.checkedPath(key)!==key)throw new Error('source path outside indexed project');
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.size>MAX_SOURCE_BYTES)throw new RangeError('source file exceeds snapshot verification budget');
    const bytes=readFileSync(fd);
    const after=fstatSync(fd);
    if(after.size!==before.size||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)
      throw new Error('source changed while verifying; refresh CodeIndex');
    return bytes;
  }finally{closeSync(fd);}
}
function symbolRecord(symbol){
  const {name,kind,container='',line}=symbol;
  if(typeof name!=='string'||!name||name.length>128||typeof kind!=='string'||!kind||kind.length>40||
    typeof container!=='string'||container.length>128||!Number.isInteger(line)||line<1||line>2_000_000)
    throw new TypeError('invalid or excessive indexed symbol evidence');
  return {name,kind,container,line};
}
function symbolKey(path,s){return JSON.stringify([path,s.kind,s.container,s.name]);}
function manifest(index){
  if(!index.lastRefresh)throw new Error('CodeIndex must be refreshed before snapshotting');
  const reasons=[];
  if(index.lastRefresh.unavailable?.length)reasons.push('parser-unavailable');
  if(index.files.size>=index.maxFiles)reasons.push('index-file-limit');
  const files=[];
  let verifiedBytes=0,symbols=0,ambiguous=false;
  for(const [path,record] of [...index.files].sort(([a],[b])=>a.localeCompare(b))){
    if(files.length>=MAX_FILES){reasons.push('snapshot-file-budget');break;}
    if(typeof path!=='string'||Buffer.byteLength(path)>512||!SHA.test(record.contentSha256))throw new TypeError('invalid indexed file evidence');
    const bytes=sourceBytes(index,path);
    if(hash(bytes)!==record.contentSha256)throw new Error('source changed since CodeIndex refresh; refresh before snapshot');
    if(verifiedBytes+bytes.length>MAX_VERIFIED_BYTES){reasons.push('verification-byte-budget');break;}
    verifiedBytes+=bytes.length;
    const sym=(record.symbols||[]);
    if(sym.length>MAX_SYMBOLS_PER_FILE||symbols+sym.length>MAX_SYMBOLS){reasons.push('symbol-budget');break;}
    const items=sym.map(symbolRecord).sort((a,b)=>a.line-b.line||a.name.localeCompare(b.name)||a.kind.localeCompare(b.kind));
    const seen=new Set();
    for(const entry of items){const key=symbolKey(path,entry);if(seen.has(key))ambiguous=true;seen.add(key);}
    symbols+=items.length;
    if(record.diagnostics?.length)reasons.push('source-diagnostics');
    files.push({path,sha:record.contentSha256,language:record.language,symbols:items});
  }
  if(ambiguous)reasons.push('ambiguous-symbol-identity');
  const all=sortedUnique(reasons);
  return {revision:index.lastRevision??null,files:files.length,symbols,complete:all.length===0,reasons:all,entries:files};
}
function snapshotDigest(snapshot){
  return hash(JSON.stringify({revision:snapshot.revision,files:snapshot.files,symbols:snapshot.symbols,
    complete:snapshot.complete,reasons:snapshot.reasons,entries:snapshot.entries}));
}
function metadata(row){return {snapshotSha256:row.snapshot_sha,id:row.id,createdAt:row.created_at,revision:row.revision,files:row.files,symbols:row.symbols,
  complete:Boolean(row.complete),reasons:JSON.parse(row.reasons)};}
function groupSymbols(entries){
  const result=new Map();
  for(const file of entries)for(const sym of file.symbols){
    const id=symbolKey(file.path,sym),items=result.get(id)||[];
    items.push({...sym,path:file.path});result.set(id,items);
  }
  return result;
}
function bounded(values,limit){return {total:values.length,items:values.slice(0,limit)};}
function delta(before,after,limit){
  const original=new Map(before.entries.map(x=>[x.path,x]));
  const newer=new Map(after.entries.map(x=>[x.path,x]));
  const paths=sortedUnique([...original.keys(),...newer.keys()]);
  const addedFiles=[],removedFiles=[],modifiedFiles=[];
  for(const path of paths){
    const a=original.get(path),b=newer.get(path);
    if(!a)addedFiles.push(path);
    else if(!b)removedFiles.push(path);
    else if(a.sha!==b.sha)modifiedFiles.push({path,beforeSha256:a.sha,afterSha256:b.sha});
  }
  const first=groupSymbols(before.entries),second=groupSymbols(after.entries);
  const added=[],removed=[],relocated=[];
  let ambiguous=false;
  for(const key of sortedUnique([...first.keys(),...second.keys()])){
    const a=first.get(key)||[],b=second.get(key)||[];
    if(a.length>1||b.length>1)ambiguous=true;
    if(a.length===1&&b.length===1){
      if(a[0].line!==b[0].line)relocated.push({path:a[0].path,name:a[0].name,kind:a[0].kind,
        container:a[0].container,before:a[0].line,after:b[0].line});
      continue;
    }
    if(b.length>a.length)added.push(...b.slice(0,b.length-a.length));
    if(a.length>b.length)removed.push(...a.slice(0,a.length-b.length));
  }
  const files={added:bounded(addedFiles,limit),removed:bounded(removedFiles,limit),modified:bounded(modifiedFiles,limit)};
  const symbols={added:bounded(added,limit),removed:bounded(removed,limit),relocated:bounded(relocated,limit)};
  const truncated=Object.values(files).concat(Object.values(symbols)).some(group=>group.total>group.items.length);
  const reasons=sortedUnique([...before.reasons,...after.reasons,
    ...(ambiguous?['ambiguous-symbol-identity']:[]),...(truncated?['result-limit']:[])]);
  return {files,symbols,truncated,complete:reasons.length===0,reasons,
    note:'Exact indexed syntactic symbol identities only; changes within function bodies, runtime resolution and declaration renames are not inferred.'};
}

export class SymbolDeltaLedger {
  constructor(home){
    if(typeof home!=='string'||!home)throw new TypeError('snapshot home required');
    if(lstatSync(home,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error('snapshot home may not be a symlink');
    mkdirSync(home,{recursive:true,mode:0o700});chmodSync(home,0o700);
    const file=join(home,'symbol-delta.sqlite'),stat=lstatSync(file,{throwIfNoEntry:false});
    if(stat&&(!stat.isFile()||stat.isSymbolicLink()))throw new Error('snapshot database may not be a symlink');
    this.db=new DatabaseSync(file);this.closed=false;
    try{
      chmodSync(file,0o600);
      const version=this.db.prepare('PRAGMA user_version').get().user_version;
      if(version!==0&&version!==DB_VERSION)throw new Error('unsupported symbol delta schema version');
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if(version===0)this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE snapshots(scope TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,revision TEXT,
          files INTEGER NOT NULL,symbols INTEGER NOT NULL,complete INTEGER NOT NULL,reasons TEXT NOT NULL,snapshot_sha TEXT NOT NULL,
          PRIMARY KEY(scope,id));
        CREATE TABLE source_facts(scope TEXT NOT NULL,snapshot_id TEXT NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,
          language TEXT NOT NULL,symbols_json TEXT NOT NULL,PRIMARY KEY(scope,snapshot_id,path),
          FOREIGN KEY(scope,snapshot_id) REFERENCES snapshots(scope,id) ON DELETE CASCADE);
        CREATE INDEX snapshot_created ON snapshots(scope,created_at DESC,id DESC);
        PRAGMA user_version=1;COMMIT;`);
      this.count=this.db.prepare('SELECT COUNT(*) AS total FROM snapshots WHERE scope=?');
      this.listRows=this.db.prepare('SELECT * FROM snapshots WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?');
      this.getOne=this.db.prepare('SELECT * FROM snapshots WHERE scope=? AND id=?');
      this.getFiles=this.db.prepare('SELECT path,sha,language,symbols_json FROM source_facts WHERE scope=? AND snapshot_id=? ORDER BY path');
      this.insertSnapshot=this.db.prepare('INSERT INTO snapshots(scope,id,created_at,revision,files,symbols,complete,reasons,snapshot_sha) VALUES(?,?,?,?,?,?,?,?,?)');
      this.insertFile=this.db.prepare('INSERT INTO source_facts(scope,snapshot_id,path,sha,language,symbols_json) VALUES(?,?,?,?,?,?)');
      this.deleteOne=this.db.prepare('DELETE FROM snapshots WHERE scope=? AND id=?');
    }catch(err){this.db.close();this.closed=true;throw err;}
  }
  ensureOpen(){if(this.closed)throw new Error('symbol delta ledger is closed');}
  read(scope,id){
    validId(id);
    const row=this.getOne.get(scope,id);
    if(!row)throw new Error('snapshot not found in this project');
    const entries=this.getFiles.all(scope,id).map(x=>({path:x.path,sha:x.sha,language:x.language,symbols:JSON.parse(x.symbols_json)}));
    if(entries.length!==row.files||entries.reduce((n,x)=>n+x.symbols.length,0)!==row.symbols)throw new Error('snapshot metadata corrupted');
    const parsed={revision:row.revision,files:row.files,symbols:row.symbols,
      complete:Boolean(row.complete),reasons:JSON.parse(row.reasons),entries};
    if(!SHA.test(row.snapshot_sha)||snapshotDigest(parsed)!==row.snapshot_sha)throw new Error('snapshot integrity check failed');
    return {...metadata(row),entries};
  }
  query(index,{action='status',id,from,to='current',limit=20,allowIncomplete=false}={}){
    this.ensureOpen();const scope=scoped(index);
    if(!['status','capture','erase','diff'].includes(action))throw new TypeError('invalid symbol delta action');
    if(typeof allowIncomplete!=='boolean')throw new TypeError('allowIncomplete must be boolean');
    limit=numeric(limit,20,1,50,'limit');
    if(action==='status'){
      const total=this.count.get(scope).total;
      return {action,total,snapshots:this.listRows.all(scope,limit).map(metadata),truncated:total>limit,autoCapture:false};
    }
    if(action==='erase'){
      validId(id);
      return {action,id,deleted:this.deleteOne.run(scope,id).changes===1,note:'SQLite deletion does not securely erase WAL pages or backups.'};
    }
    if(action==='capture'){
      const current=manifest(index);
      if(!current.complete&&!allowIncomplete)throw new Error('incomplete symbol evidence; pass allowIncomplete:true to capture anyway');
      if(this.count.get(scope).total>=MAX_SNAPSHOTS)throw new RangeError('snapshot quota of 20 reached; explicitly erase old snapshots');
      const snapshotId=randomUUID(),date=new Date().toISOString();
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.insertSnapshot.run(scope,snapshotId,date,current.revision,current.files,current.symbols,
          current.complete?1:0,JSON.stringify(current.reasons),snapshotDigest(current));
        for(const file of current.entries)this.insertFile.run(scope,snapshotId,file.path,file.sha,file.language,JSON.stringify(file.symbols));
        this.db.exec('COMMIT');
      }catch(err){this.db.exec('ROLLBACK');throw err;}
      return {action,id:snapshotId,createdAt:date,revision:current.revision,files:current.files,symbols:current.symbols,
        complete:current.complete,reasons:current.reasons,snapshotSha256:snapshotDigest(current),autoCapture:false};
    }
    validId(from);
    const left=this.read(scope,from);
    let right;
    if(to==='current'){
      right=manifest(index);
    }else right=this.read(scope,validId(to));
    const compared=delta(left,right,limit);
    return {action,from,to,fromRevision:left.revision,toRevision:right.revision,...compared};
  }
  close(){if(!this.closed){this.closed=true;this.db.close();}}
}
