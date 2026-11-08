/** Opt-in, project-scoped human-authored memory: no automatic transcript capture.
 * Storage contains explicit Markdown plaintext; this is NOT encryption or secure erasure.
 */
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,constants,fstatSync,lstatSync,mkdirSync,openSync,readSync,closeSync,realpathSync} from 'node:fs';
import {basename,isAbsolute,join,relative,resolve,sep} from 'node:path';

const VERSION=1,MAX_BODY=8192,MAX_MARKDOWN=128*1024,MAX_NOTES=256;
const KINDS=new Set(['architecture','decision','fact','task','reference']);
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const projectKey=(project)=>hash(realpathSync(project));
function textField(value,label,max){
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max||(label==='title'&&/[\r\n]/.test(value))||/[\u0000-\u001f\u007f]/u.test(value.replaceAll('\n','').replaceAll('\t','')))
    throw new TypeError(`${label} must be nonempty, valid, and within ${max} bytes`);
  return value;
}
function idField(id){if(typeof id!=='string'||!UUID.test(id))throw new TypeError('invalid note ID');return id;}
function safePath(root,path){
  if(typeof path!=='string'||!path||path.length>250||isAbsolute(path)||path.includes('\\')||path.includes('\0'))throw new Error('invalid project-relative path');
  const parts=path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw new Error('invalid project-relative path');
  let current=realpathSync(root);
  for(let i=0;i<parts.length;i++){
    current=join(current,parts[i]);
    const st=lstatSync(current);
    if(st.isSymbolicLink())throw new Error('unsafe symlink source path');
    if(i===parts.length-1?!st.isFile():!st.isDirectory())throw new Error('memory import requires a regular file');
  }
  const canonical=realpathSync(current),rel=relative(realpathSync(root),canonical);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('source outside project');
  return current;
}
function readProjectFile(project,path,maxBytes=MAX_MARKDOWN){
  const current=safePath(project,path);
  const fd=openSync(current,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const st=fstatSync(fd);
    if(!st.isFile()||st.size>maxBytes)throw new RangeError('Markdown source exceeds import size limit');
    const bytes=Buffer.alloc(st.size);let off=0;
    while(off<bytes.length){const read=readSync(fd,bytes,off,bytes.length-off,off);if(read<=0)throw new Error('file changed during import');off+=read;}
    const after=fstatSync(fd);
    if(after.size!==st.size||after.ino!==st.ino||after.mtimeMs!==st.mtimeMs)throw new Error('file changed during import');
    return bytes;
  }finally{closeSync(fd);}
}
function normalize(value){return String(value).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();}
function summary(note,project){
  let sourceStatus='unanchored';
  if(note.source_path){
    try{sourceStatus=hash(readProjectFile(project,note.source_path))===note.source_sha?'fresh':'stale';}
    catch{sourceStatus='unavailable';}
  }
  return {id:note.id,kind:note.kind,title:note.title,tags:JSON.parse(note.tags),sourcePath:note.source_path??null,
    sourceStatus,createdAt:note.created_at};
}
export class ProjectMemory {
  constructor(home){
    if(lstatSync(home,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error('memory home may not be a symlink');
    mkdirSync(home,{recursive:true,mode:0o700});chmodSync(home,0o700);
    const path=join(home,'memory.sqlite'),existing=lstatSync(path,{throwIfNoEntry:false});
    if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw new Error('memory database may not be a symlink');
    this.db=new DatabaseSync(path);this.closed=false;
    try{
      chmodSync(path,0o600);
      const version=this.db.prepare('PRAGMA user_version').get().user_version;
      if(version!==0&&version!==VERSION)throw new Error('unsupported memory schema version');
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if(version===0){this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,
          body TEXT NOT NULL,tags TEXT NOT NULL,source_path TEXT,source_sha TEXT,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS notes_scope ON notes(scope,created_at,id);
        PRAGMA user_version=1;COMMIT;`);}
      this.insert=this.db.prepare('INSERT INTO notes(id,scope,kind,title,body,tags,source_path,source_sha,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
      this.count=this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE scope=?');
      this.single=this.db.prepare('SELECT * FROM notes WHERE scope=? AND id=?');
      this.all=this.db.prepare('SELECT * FROM notes WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?');
      this.imported=this.db.prepare('SELECT id FROM notes WHERE scope=? AND source_path=? AND source_sha=? LIMIT 1');
      this.delete=this.db.prepare('DELETE FROM notes WHERE scope=? AND id=?');
    }catch(err){this.db.close();this.closed=true;throw err;}
  }
  assertOpen(){if(this.closed)throw new Error('memory store is closed');}
  save(project,{kind,title,body,tags=[],sourcePath=null,sourceSha=null}={}){
    this.assertOpen();
    if(!KINDS.has(kind))throw new TypeError('invalid memory kind');
    textField(title,'title',160);textField(body,'body',MAX_BODY);
    if(!Array.isArray(tags)||tags.length>8||tags.some(t=>typeof t!=='string'||!/^[\p{L}\p{N}_-]{1,30}$/u.test(t)))throw new TypeError('invalid memory tags');
    if(sourcePath!==null && (!sourceSha||!SHA.test(sourceSha)))throw new TypeError('invalid source hash');
    const scope=projectKey(project);
    if(this.count.get(scope).n>=MAX_NOTES)throw new RangeError('project memory quota of 256 notes exceeded');
    const id=randomUUID(),date=new Date().toISOString();
    this.insert.run(id,scope,kind,title,body,JSON.stringify(tags),sourcePath,sourceSha,date);
    return {id,kind,title,createdAt:date,sourcePath,sourceStatus:sourcePath?'fresh':'unanchored'};
  }
  importMarkdown(project,path){
    this.assertOpen();
    if(!path.endsWith('.md'))throw new TypeError('Markdown import requires a .md file');
    const bytes=readProjectFile(project,path,MAX_BODY);
    const body=bytes.toString('utf8');
    if(!Buffer.from(body,'utf8').equals(bytes))throw new Error('Markdown source must be UTF-8');
    textField(body,'body',MAX_BODY);
    const scope=projectKey(project),sha=hash(bytes),old=this.imported.get(scope,path,sha);
    if(old)return {id:old.id,added:false};
    const title=/^#\s+(.+)$/m.exec(body)?.[1]?.trim()||basename(path,'.md');
    return {...this.save(project,{kind:'reference',title,body,sourcePath:path,sourceSha:sha}),added:true};
  }
  /** Explicit Claude Code JSONL fact import; no automatic hook, no raw tool
   * commands or assistant message bodies are retained in generated notes. */
  importClaudeTranscript(project,path){
    this.assertOpen();
    if(typeof path!=='string'||!path.endsWith('.jsonl'))throw new TypeError('session import requires a .jsonl file');
    const bytes=readProjectFile(project,path,MAX_MARKDOWN);
    const transcript=bytes.toString('utf8');
    if(!Buffer.from(transcript,'utf8').equals(bytes))throw new Error('session transcript must be UTF-8');
    const scope=projectKey(project),sha=hash(bytes),existing=this.imported.get(scope,path,sha);
    if(existing)return {id:existing.id,added:false};
    let userMessages=0,toolCalls=0,firstPrompt='';
    const files=new Set();
    const clean=s=>typeof s==='string'?s.replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim():'';
    const inputLines=transcript.split(/\r?\n/).filter(Boolean);
    const incomplete=inputLines.length>600;
    for(const rawLine of inputLines.slice(0,600)){
      if(!rawLine||rawLine.length>16384)continue;
      let entry;
      try{entry=JSON.parse(rawLine);}catch{continue;}
      if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
      const message=entry.message&&typeof entry.message==='object'?entry.message:{};
      const role=message.role||entry.type;
      const content=message.content;
      if(role==='user'){
        const text=typeof content==='string'?content:
          Array.isArray(content)?content.find(block=>block&&block.type==='text'&&typeof block.text==='string')?.text:null;
        const value=clean(text);
        if(value&&!value.startsWith('<')){
          userMessages++;
          if(!firstPrompt)firstPrompt=Array.from(value).slice(0,280).join('');
        }
      }
      if(role==='assistant'&&Array.isArray(content))for(const block of content){
        if(!block||block.type!=='tool_use')continue;
        toolCalls++;
        if(!['Edit','Write','MultiEdit','NotebookEdit','str_replace','create_file'].includes(block.name))continue;
        const input=block.input||{};
        let file=input.file_path||input.path;
        if(typeof file!=='string'||file.length>512||file.includes('\0'))continue;
        if(isAbsolute(file))file=relative(realpathSync(project),file).split(sep).join('/');
        try{
          const pieces=file.split('/');
          if(pieces.some(x=>!x||x==='.'||x==='..'||x.includes('\\')||x.includes(':')))continue;
          files.add(pieces.join('/').slice(0,200));
        }catch{/* Invalid source labels are never imported. */}
      }
    }
    if(!userMessages)throw new Error('no usable user messages in session transcript');
    const touched=[...files].sort().slice(0,20);
    const body=['## Objective (first user prompt)',firstPrompt,'',
      '## Files touched (reported by editor tool calls)',...(touched.length?touched.map(x=>`- ${x}`):['- Not recorded']),'',
      '## Counts',`User messages: ${userMessages}`,`Tool calls: ${toolCalls}`,
      '', `${Math.min(inputLines.length,600)} input lines examined${incomplete?' (incomplete session evidence; remaining lines omitted)':''}`,
      'Extracted mechanically from an explicitly selected local JSONL file. Commands and assistant bodies are deliberately not retained.'].join('\n');
    return {...this.save(project,{kind:'reference',title:`Claude session: ${firstPrompt.slice(0,110)}`,
      body,sourcePath:path,sourceSha:sha,tags:['claude-code','session']}),added:true};
  }
  read(project,id){this.assertOpen();const note=this.single.get(projectKey(project),idField(id));return note?{...summary(note,project),body:note.body}:null;}
  list(project,{limit=25}={}){
    this.assertOpen();if(!Number.isInteger(limit)||limit<1||limit>25)throw new RangeError('list limit must be 1..25');
    const scope=projectKey(project),total=this.count.get(scope).n;
    const notes=this.all.all(scope,limit).map(x=>summary(x,project));
    return {total,truncated:notes.length<total,notes};
  }
  search(project,query,{limit=15}={}){
    this.assertOpen();
    if(typeof query!=='string'||!query.trim()||query.length>150)throw new TypeError('invalid memory search query length');
    if(!Number.isInteger(limit)||limit<1||limit>25)throw new RangeError('search limit must be 1..25');
    const terms=normalize(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0,8);
    if(!terms.length)return {total:0,truncated:false,hits:[]};
    const notes=this.all.all(projectKey(project),MAX_NOTES);
    const scored=[];
    for(const note of notes){
      const title=normalize(note.title),body=normalize(note.body),tags=normalize(note.tags);
      if(!terms.every(t=>title.includes(t)||body.includes(t)||tags.includes(t)))continue;
      const score=terms.reduce((sum,t)=>sum+(title.includes(t)?4:0)+(tags.includes(t)?2:0)+(body.includes(t)?1:0),0);
      scored.push({...summary(note,project),score});
    }
    scored.sort((a,b)=>b.score-a.score||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    return {total:scored.length,truncated:scored.length>limit,hits:scored.slice(0,limit)};
  }
  forget(project,id){this.assertOpen();return this.delete.run(projectKey(project),idField(id)).changes===1;}
  exportMarkdown(project,id){const note=this.read(project,id);if(!note)throw new Error('memory note not found');
    const body=note.body.trim();
    return body.startsWith(`# ${note.title}\n`)?`${body}\n`:`# ${note.title}\n\n${body}\n`;
  }
  status(project){this.assertOpen();return {enabled:true,total:this.count.get(projectKey(project)).n,maxNotes:MAX_NOTES,
    automaticTranscriptImport:false,automaticModelCalls:false,storage:'local-owner-only-SQLite-plaintext'};}
  close(){if(!this.closed){this.closed=true;this.db.close();}}
}

const schema=(properties)=>({type:'object',properties,additionalProperties:false});
export function registerProjectMemoryFeature(pi,{getMemory,project,getConfig}={}){
  pi.registerTool?.({
    name:'envelope_memory',label:'Envelope: Opt-in Project Memory',
    description:'Explicitly save, search, inspect, delete and Markdown-import source-anchored project notes. Off by default; no automatic transcript capture, vault scanning, or model calls.',
    parameters:schema({action:{type:'string',enum:['status','save','list','read','search','forget','importMarkdown','importClaudeTranscript','exportMarkdown']},
      kind:{type:'string',enum:[...KINDS]},title:{type:'string'},body:{type:'string'},tags:{type:'array',maxItems:8,items:{type:'string'}},
      id:{type:'string'},query:{type:'string'},path:{type:'string'},limit:{type:'integer',minimum:1,maximum:25}}),
    async execute(_id,params,_signal,_onUpdate,ctx){
      try{
        const enabled=getConfig()?.memory?.enabled===true;
        if(params?.action==='status'&&!enabled)return {isError:false,content:[{type:'text',text:JSON.stringify({enabled:false,automaticTranscriptImport:false})}],details:{}};
        if(!enabled)throw new Error('Project memory is OFF. Enable explicitly with /envelope memory on.');
        const memory=getMemory?.();if(!memory)throw new Error('project memory store unavailable');
        const cwd=project(ctx),action=params?.action??'status';
        const result=action==='status'?memory.status(cwd):action==='save'?memory.save(cwd,{kind:params.kind,title:params.title,body:params.body,tags:params.tags}):
          action==='list'?memory.list(cwd,params):action==='read'?memory.read(cwd,params.id):
          action==='search'?memory.search(cwd,params.query,params):action==='forget'?{deleted:memory.forget(cwd,params.id)}:
          action==='importMarkdown'?memory.importMarkdown(cwd,params.path):action==='importClaudeTranscript'?memory.importClaudeTranscript(cwd,params.path):action==='exportMarkdown'?memory.exportMarkdown(cwd,params.id):null;
        if(result===null)throw new Error('memory note not found or action unknown');
        return {isError:false,content:[{type:'text',text:typeof result==='string'?result:JSON.stringify(result,null,2)}],details:{}};
      }catch(err){return {isError:true,content:[{type:'text',text:`Envelope memory: ${err.message}`}],details:{}};}
    }
  });
}
