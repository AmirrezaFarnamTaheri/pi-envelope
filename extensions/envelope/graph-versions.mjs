/** Explicit, durable and bounded CodeIndex metadata snapshots; no source bodies. */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,lstatSync,realpathSync,readFileSync,readdirSync,openSync,writeSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {O_RDONLY,O_WRONLY,O_CREAT,O_EXCL,O_NOFOLLOW} from 'node:constants';
import {isAbsolute,join,parse,relative,resolve,sep} from 'node:path';

const DIGEST=/^[0-9a-f]{64}$/;
const MAX_FILES=512,MAX_SYMBOLS=12000,MAX_SOURCE_BYTES=16*1024*1024,MAX_STORED_BYTES=2*1024*1024,MAX_VERSIONS=16;
const hash=value=>createHash('sha256').update(value).digest('hex');
const safe=(root,target)=>root===target||target.startsWith(root+sep);
const size=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
function int(v,d,min,max,name){v??=d;if(!Number.isInteger(v)||v<min||v>max)throw new RangeError(name+' must be '+min+'..'+max);return v;}
function safeDirs(path,create=false){
 if(!isAbsolute(path))throw new Error('absolute graph version storage path required');
 let current=parse(path).root;
 for(const part of relative(current,path).split(sep).filter(Boolean)){
   current=join(current,part);
   if(!existsSync(current)){if(!create)return false;mkdirSync(current,{mode:0o700});}
   const s=lstatSync(current);
   if(s.isSymbolicLink()||!s.isDirectory())throw new Error('unsafe graph storage symlink or non-directory');
 }
 return true;
}
function keyOf(index){
 if(!index?.root||!index?.files||!index?.checkedPath)throw new TypeError('CodeIndex required');
 const canonical=realpathSync(index.root);
 if(canonical!==index.root)throw new Error('source project root changed');
 return {root:canonical,key:hash(canonical)};
}
function sourceMetadata(index,root){
 if(index.files.size>MAX_FILES)throw new RangeError('graph snapshot file limit exceeded');
 let byteCount=0,symbolCount=0;
 const paths=[...index.files.keys()].sort();const files=[];
 for(const path of paths){
   if(typeof path!=='string'||path!==index.checkedPath(path)||path.length>256)throw new Error('unsafe indexed file path');
   const absolute=resolve(root,path),record=index.files.get(path);
   if(!safe(root,absolute)||!DIGEST.test(record?.contentSha256||''))throw new Error('unverified source index');
   const stat=lstatSync(absolute),canonical=realpathSync(absolute);
   if(stat.isSymbolicLink()||!stat.isFile()||!safe(root,canonical))throw new Error('unsafe source symlink or file');
   byteCount+=stat.size;
   if(byteCount>MAX_SOURCE_BYTES)throw new RangeError('graph snapshot source verification byte limit exceeded');
   if(hash(readFileSync(absolute))!==record.contentSha256)throw new Error('source changed since index refresh; refusing stale graph snapshot');
   const symbols=(record.symbols||[]).map(s=>({name:String(s.name).slice(0,160),kind:String(s.kind).slice(0,60),container:String(s.container||'').slice(0,160)}))
      .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   symbolCount+=symbols.length;
   if(symbolCount>MAX_SYMBOLS)throw new RangeError('graph snapshot symbol limit exceeded');
   const imports=[...(index.edges?.get(path)||[])].filter(other=>index.files.has(other)).sort();
   files.push({path,sha256:record.contentSha256,language:record.language,symbols,imports});
 }
 const payload={schema:1,files};
 if(size(payload)>MAX_STORED_BYTES-128)throw new RangeError('graph snapshot persisted metadata byte limit exceeded');
 return {payload,symbolCount,byteCount};
}
function directory(store,index,create=false){
 const {key}=keyOf(index);
 if(!safeDirs(store,create))return {key,dir:null};
 const dir=join(store,key);
 if(!safeDirs(dir,create))return {key,dir:null};
 return {key,dir};
}
function filesAt(dir){return dir?readdirSync(dir).filter(name=>/^[0-9a-f]{64}\.json$/.test(name)).sort():[];}
function fetchRecord(dir,version){
 if(!DIGEST.test(version||''))throw new TypeError('valid graph snapshot version required');
 if(!dir)throw new Error('graph snapshot not found');
 const path=join(dir,version+'.json');let fd;
 try{
   const stat=lstatSync(path);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_STORED_BYTES)throw new Error('graph snapshot integrity or size invalid');
   fd=openSync(path,O_RDONLY|O_NOFOLLOW);
   const serialized=readFileSync(fd,'utf8');let parsed;
   try{parsed=JSON.parse(serialized);}catch{throw new Error('graph snapshot corrupt JSON');}
   if(!parsed||parsed.version!==version||!parsed.payload||hash(JSON.stringify(parsed.payload))!==version||
      parsed.payload.schema!==1||!Array.isArray(parsed.payload.files)||parsed.payload.files.length>MAX_FILES)
     throw new Error('graph snapshot integrity failure');
   return parsed;
 }catch(err){if(err?.code==='ENOENT')throw new Error('graph snapshot not found');throw err;}
 finally{if(fd!==undefined)closeSync(fd);}
}
export class GraphVersionStore {
 constructor(storage){if(typeof storage!=='string'||!isAbsolute(storage))throw new TypeError('absolute storage directory required');this.storage=resolve(storage);}
 list(index){
   const {key,dir}=directory(this.storage,index);
   const records=filesAt(dir).map(name=>fetchRecord(dir,name.slice(0,-5)));
   records.sort((a,b)=>b.capturedAt.localeCompare(a.capturedAt)||b.version.localeCompare(a.version));
   return {persisted:true,projectKey:key,count:records.length,
     versions:records.map(x=>({version:x.version,capturedAt:x.capturedAt,files:x.payload.files.length,
       symbols:x.payload.files.reduce((n,f)=>n+f.symbols.length,0)}))};
 }
 status(index){const x=this.list(index);return {...x,versions:x.versions.slice(0,4)};}
 capture(index){
   const {root}=keyOf(index),{payload,byteCount,symbolCount}=sourceMetadata(index,root);
   const version=hash(JSON.stringify(payload));
   const {dir,key}=directory(this.storage,index,true),target=join(dir,version+'.json'),present=filesAt(dir);
   if(present.includes(version+'.json')){
     fetchRecord(dir,version);
     return {version,projectKey:key,files:payload.files.length,symbols:symbolCount,verifiedSourceBytes:byteCount,existing:true};
   }
   if(present.length>=MAX_VERSIONS)throw new RangeError('graph version retention limit reached; use explicit prune');
   const record={version,capturedAt:new Date().toISOString(),payload};
   if(size(record)>MAX_STORED_BYTES)throw new RangeError('graph snapshot record too large');
   const temp=join(dir,version+'.'+process.pid+'.'+Date.now().toString(36)+'.tmp');let fd;
   try{fd=openSync(temp,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0o600);writeSync(fd,JSON.stringify(record));closeSync(fd);fd=undefined;renameSync(temp,target);}
   catch(error){if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}throw error;}
   return {version,projectKey:key,files:payload.files.length,symbols:symbolCount,verifiedSourceBytes:byteCount,existing:false};
 }
 compare(index,{from,to,limit=10,offset=0,ifVersion,maxChars=4000}={}){
   limit=int(limit,10,1,25,'limit');offset=int(offset,0,0,512,'offset');maxChars=int(maxChars,4000,900,16000,'maxChars');
   const {dir}=directory(this.storage,index),a=fetchRecord(dir,from),b=fetchRecord(dir,to);
   const prior=new Map(a.payload.files.map(f=>[f.path,f])),later=new Map(b.payload.files.map(f=>[f.path,f]));
   const changes=[];
   for(const path of [...new Set([...prior.keys(),...later.keys()])].sort()){
     const old=prior.get(path),now=later.get(path);
     if(old?.sha256===now?.sha256&&JSON.stringify(old?.imports||[])===JSON.stringify(now?.imports||[]))continue;
     changes.push({path,change:!old?'added':!now?'removed':'modified',
       addedImports:(now?.imports||[]).filter(x=>!old?.imports.includes(x)),
       removedImports:(old?.imports||[]).filter(x=>!now?.imports.includes(x)),
       symbolCountBefore:old?.symbols.length??0,symbolCountAfter:now?.symbols.length??0});
   }
   const version=hash(from+':'+to+':'+JSON.stringify(changes));
   if(offset>0&&ifVersion!==version)throw new Error('stale or missing graph diff comparison version cursor');
   const result={mode:'persistent-file-graph-versions',precision:'file-byte-and-static-import-graph',from,to,version,
     filesChanged:changes.length,totalChanges:changes.length,offset,returned:0,truncated:false,changes:[],
     notes:'Metadata only. File hashes and static imports are not compiler-backed proof, semantic equivalence or a runtime call graph.'};
   for(let i=offset;i<changes.length&&result.returned<limit;i++){
     result.changes.push(changes[i]);result.returned++;
     if(size({...result,truncated:true,nextOffset:i+1})>maxChars){result.changes.pop();result.returned--;break;}
   }
   if(offset+result.returned<changes.length){result.truncated=true;result.nextOffset=offset+result.returned;}
   if(size(result)>maxChars||(!result.returned&&result.truncated))throw new RangeError('maxChars budget too small for graph diff response');
   return result;
 }
 snapshot(index,{version,limit=30,offset=0}={}){
   limit=int(limit,30,1,50,'limit');offset=int(offset,0,0,512,'offset');
   const {dir}=directory(this.storage,index),x=fetchRecord(dir,version);
   if(offset>x.payload.files.length)throw new RangeError('snapshot offset exceeds file count');
   const files=x.payload.files.slice(offset,offset+limit).map(f=>({path:f.path,sha256:f.sha256,language:f.language,
      symbols:f.symbols.slice(0,30),imports:f.imports.slice(0,100),
      truncatedSymbols:f.symbols.length>30,truncatedImports:f.imports.length>100}));
   return {mode:'persisted-static-file-graph-metadata',version,
     capturedAt:x.capturedAt,totalFiles:x.payload.files.length,offset,returned:files.length,
     truncated:offset+files.length<x.payload.files.length,
     ...(offset+files.length<x.payload.files.length?{nextOffset:offset+files.length}:{}),files,
     notes:'Only explicitly captured private file metadata. Historical content-addressed integrity is verified; source bodies and semantic code proofs are absent.'};
 }
 prune(index,{keep=8}={}){
   keep=int(keep,8,1,16,'keep');const {dir}=directory(this.storage,index);
   const {versions}=this.list(index),toRemove=versions.slice(keep);
   for(const v of toRemove)unlinkSync(join(dir,v.version+'.json'));
   return {removed:toRemove.length,remaining:versions.length-toRemove.length,projectScoped:true};
 }
}
