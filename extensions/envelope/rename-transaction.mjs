/** Strict LSP WorkspaceEdit preview, content-bound plan and reversible file swap. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, constants } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_FILES=25, MAX_EDITS=400, MAX_TOTAL_BYTES=3_000_000;
const JS_TS_SOURCE=/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i;
function requireJsTs(path){if(!JS_TS_SOURCE.test(path))throw new Error('LSP rename only supports JS/TS source files; other indexed languages are read-only for rename');}
const sha=text=>createHash('sha256').update(text).digest('hex');
const within=(root,p)=>p===root||p.startsWith(root+sep);
function safePath(index,uri){
  if(typeof uri!=='string'||!uri.startsWith('file:'))throw new Error('LSP edit has unsupported URI');
  const absolute=fileURLToPath(uri);
  if(!within(index.root,absolute))throw new Error('LSP edit is outside project root');
  const key=index.checkedPath(absolute);
  requireJsTs(key);
  const segments=relative(index.root,absolute).split(sep);
  let current=index.root;
  for(const segment of segments){current=join(current,segment);if(lstatSync(current).isSymbolicLink())throw new Error('LSP edit references a symlink');}
  if(realpathSync(absolute)!==absolute)throw new Error('LSP edit resolves through a symlink');
  return {key,absolute};
}
function lineStarts(text){
  const begins=[0],ends=[];
  for(let i=0;i<text.length;i++){
    if(text[i]==='\r'||text[i]==='\n'){
      ends.push(i);
      if(text[i]==='\r'&&text[i+1]==='\n')i++;
      begins.push(i+1);
    }
  }
  ends.push(text.length);
  return {begins,ends};
}
function toOffset(text,position,lines){
  if(!position||!Number.isInteger(position.line)||!Number.isInteger(position.character)||position.line<0||position.character<0)throw new Error('invalid LSP position');
  const {begins,ends}=lines;
  if(position.line>=begins.length||position.character>ends[position.line]-begins[position.line])throw new Error('LSP range exceeds source line');
  const offset=begins[position.line]+position.character;
  if(offset>0&&offset<text.length){
    const a=text.charCodeAt(offset-1),b=text.charCodeAt(offset);
    if(a>=0xd800&&a<=0xdbff&&b>=0xdc00&&b<=0xdfff)throw new Error('LSP range splits a UTF-16 surrogate');
  }
  return offset;
}
function identifierAt(text,position,ts){
  const offset=toOffset(text,{line:position.line-1,character:position.column-1},lineStarts(text));
  const re=/[A-Za-z_$][A-Za-z0-9_$]*/g;
  for(const m of text.matchAll(re))if(offset>=m.index&&offset<m.index+m[0].length)return m[0];
  throw new Error('rename target is not a supported identifier');
}
function sourceKind(ts,path){return /\.tsx$/i.test(path)?ts.ScriptKind.TSX:/\.jsx$/i.test(path)?(ts.ScriptKind.JSX??ts.ScriptKind.JS):/\.(js|mjs|cjs)$/i.test(path)?ts.ScriptKind.JS:ts.ScriptKind.TS;}
function hasSyntaxErrors(index,path,text){
  const sf=index.ts.createSourceFile(path,text,index.ts.ScriptTarget.Latest,true,sourceKind(index.ts,path));
  return (sf.parseDiagnostics||[]).length>0;
}
function extractWorkspaceChanges(edit){
  if(!edit||typeof edit!=='object'||Array.isArray(edit))throw new Error('LSP did not return a valid WorkspaceEdit');
  const output=new Map();
  if(edit.changes!==undefined&&edit.documentChanges!==undefined)throw new Error('ambiguous LSP WorkspaceEdit form');
  if(edit.changes!==undefined){
    if(!edit.changes||typeof edit.changes!=='object'||Array.isArray(edit.changes))throw new Error('invalid LSP changes map');
    for(const [uri,edits] of Object.entries(edit.changes))output.set(uri,edits);
  }else if(edit.documentChanges!==undefined){
    if(!Array.isArray(edit.documentChanges))throw new Error('invalid LSP documentChanges');
    for(const change of edit.documentChanges){
      if(!change?.textDocument||!Array.isArray(change.edits))throw new Error('unsupported LSP file operation');
      if(change.textDocument.version!==null&&change.textDocument.version!==undefined&&change.textDocument.version!==1)throw new Error('unsupported LSP document version');
      const uri=change.textDocument.uri;if(output.has(uri))throw new Error('duplicate LSP document change');
      output.set(uri,change.edits);
    }
  }
  if(!output.size)throw new Error('LSP rename returned no edits');
  return output;
}

export function planRename({index,workspaceEdit,request}){
  if(!index?.ts||!index?.files)throw new Error('shared code index is required');
  if(index.files.size>=index.maxFiles)throw new Error('code index at file limit: rename would have incomplete coverage');
  const {path,line,column,newName}=request||{};
  if(!Number.isInteger(line)||line<1||!Number.isInteger(column)||column<1)throw new Error('rename line and column must be one-based integers');
  if(typeof newName!=='string'||!newName||newName.length>128||!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName))throw new Error('rename name must be a supported identifier');
  const token=index.ts.stringToToken(newName);
  if(typeof token==='number'&&token>=index.ts.SyntaxKind.FirstKeyword&&token<=index.ts.SyntaxKind.LastKeyword)throw new Error('rename name is a reserved keyword');
  const target=index.checkedPath(path);
  requireJsTs(target);
  const source=readFileSync(join(index.root,target),'utf8');
  const oldName=identifierAt(source,{line,column},index.ts);
  const tokenSource=index.ts.createSourceFile(target,source,index.ts.ScriptTarget.Latest,true,sourceKind(index.ts,target));
  const cursor=toOffset(source,{line:line-1,character:column-1},lineStarts(source));
  const targetToken=index.ts.getTokenAtPosition(tokenSource,cursor);
  if(!targetToken||!index.ts.isIdentifier(targetToken)||targetToken.getStart(tokenSource)>cursor||targetToken.getEnd()<=cursor||targetToken.getText(tokenSource)!==oldName)
    throw new Error('rename target must be a source-code identifier, not a string or comment');
  if(oldName===newName)throw new Error('rename name is unchanged');
  const data=extractWorkspaceChanges(workspaceEdit);
  if(data.size>MAX_FILES)throw new Error('LSP rename affects too many files');
  const files=[];let count=0,total=0;
  for(const [uri,edits] of data){
    const {key,absolute}=safePath(index,uri);
    if(!Array.isArray(edits)||!edits.length)throw new Error('LSP edit list must not be empty');
    count+=edits.length;if(count>MAX_EDITS)throw new Error('LSP rename has too many edits');
    const text=readFileSync(absolute,'utf8');
    const bytes=Buffer.byteLength(text);total+=bytes;
    if(bytes>index.maxBytesPerFile||text.includes('\0')||total>MAX_TOTAL_BYTES)throw new Error('LSP rename source exceeds safe limit');
    if(hasSyntaxErrors(index,key,text))throw new Error(`source ${key} already has syntax errors; refusing rename`);
    const lines=lineStarts(text);
    const sf=index.ts.createSourceFile(key,text,index.ts.ScriptTarget.Latest,true,sourceKind(index.ts,key));
    const allowedReplacements=new Set([newName,`${oldName}: ${newName}`,`${oldName}:${newName}`]);
    const normalized=edits.map(edit=>{
      if(!edit||typeof edit.newText!=='string'||!allowedReplacements.has(edit.newText))throw new Error('LSP rename contains a non-identifier replacement');
      const start=toOffset(text,edit.range?.start,lines),end=toOffset(text,edit.range?.end,lines);
      if(end<=start||text.slice(start,end)!==oldName)throw new Error('LSP rename span is not the expected identifier');
      if(edit.newText!==newName){
        const token=index.ts.getTokenAtPosition(sf,start);
        if(!token||!index.ts.isIdentifier(token)||token.getStart(sf)!==start||token.getEnd()!==end||
          !index.ts.isShorthandPropertyAssignment(token.parent)||token.parent.name!==token)
          throw new Error('LSP expanded replacement requires a genuine shorthand property identifier');
      }
      return {start,end,newText:edit.newText,line:edit.range.start.line+1,column:edit.range.start.character+1};
    }).sort((a,b)=>a.start-b.start||a.end-b.end);
    for(let i=1;i<normalized.length;i++)if(normalized[i].start<normalized[i-1].end||normalized[i].start===normalized[i-1].start)throw new Error('LSP rename edits overlap or duplicate');
    let proposed=text;
    for(const edit of [...normalized].reverse())proposed=proposed.slice(0,edit.start)+edit.newText+proposed.slice(edit.end);
    if(hasSyntaxErrors(index,key,proposed))throw new Error(`LSP rename would introduce syntax errors in ${key}`);
    const proposedBytes=Buffer.byteLength(proposed);
    if(proposedBytes>index.maxBytesPerFile)throw new Error('LSP rename proposal exceeds safe limit');
    total+=Math.max(0,proposedBytes-bytes);if(total>MAX_TOTAL_BYTES)throw new Error('LSP rename proposal exceeds safe limit');
    files.push({path:key,absolute,originalHash:sha(text),proposedHash:sha(proposed),originalText:text,proposedText:proposed,edits:normalized});
  }
  if(!files.some(f=>f.path===target))throw new Error('LSP rename did not update the selected symbol');
  files.sort((a,b)=>a.path.localeCompare(b.path));
  const id=sha(JSON.stringify({root:index.root,target,line,column,newName,files:files.map(f=>[f.path,f.originalHash,f.proposedHash,f.edits.map(e=>[e.start,e.end])])}));
  return {id,target,oldName,newName,files,changeCount:count,preview:files.map(f=>({path:f.path,edits:f.edits.length,locations:f.edits.slice(0,15).map(x=>({line:x.line,column:x.column})),originalHash:f.originalHash,proposedHash:f.proposedHash}))};
}

/** Per-project exclusive lock + preflight + same-directory temp/backup + rollback.
 * Crash-atomicity across multiple files is NOT claimed. Backups are deliberately
 * preserved if rollback itself fails (an explicit recovery path). */
export function applyRename({index,plan,lockRoot,expectedId,replaceFile=renameSync,signal}){
  if(!plan?.files?.length||typeof expectedId!=='string'||expectedId!==plan.id)throw new Error('rename preview fingerprint does not match this plan');
  if(typeof lockRoot!=='string'||!lockRoot)throw new Error('rename lock directory required');
  mkdirSync(lockRoot,{recursive:true,mode:0o700});
  const lockPath=join(lockRoot,sha(index.root));
  try{mkdirSync(lockPath,{mode:0o700});}catch(err){if(err.code==='EEXIST')throw new Error('rename already in progress for project');throw err;}
  const stages=[], replaced=[];
  let rollbackFailed=false;
  try {
    for(const file of plan.files){
      if(signal?.aborted)throw new Error('rename aborted');
      const safe=safePath(index,pathToFileURL(file.absolute).href);
      if(safe.key!==file.path)throw new Error('rename path changed');
      if(sha(readFileSync(file.absolute,'utf8'))!==file.originalHash)throw new Error(`stale source changed: ${file.path}`);
      const stat=lstatSync(file.absolute);
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error('rename source is no longer a regular file');
      const nonce=randomUUID();const tmp=`${file.absolute}.envelope-${nonce}.tmp`,backup=`${file.absolute}.envelope-${nonce}.bak`;
      const stage={...file,tmp,backup,mode:stat.mode&0o777};stages.push(stage);
      writeFileSync(tmp,file.proposedText,{flag:'wx',mode:stat.mode&0o777});
      chmodSync(tmp,stat.mode&0o777);
    }
    // Revalidate all sources immediately before commit; never silently apply stale plans.
    for(const stage of stages)if(sha(readFileSync(stage.absolute,'utf8'))!==stage.originalHash)throw new Error(`stale source changed: ${stage.path}`);
    for(const stage of stages)copyFileSync(stage.absolute,stage.backup,constants.COPYFILE_EXCL);
    for(const stage of stages){
      if(signal?.aborted)throw new Error('rename aborted');
      replaceFile(stage.tmp,stage.absolute);
      replaced.push(stage);
    }
    return {applied:true,planId:plan.id,changes:plan.changeCount,files:stages.map(s=>s.path)};
  } catch(err){
    const failures=[];
    for(const stage of [...replaced].reverse()){
      try{renameSync(stage.backup,stage.absolute);}catch(rollbackError){failures.push(stage.path);}
    }
    if(failures.length){rollbackFailed=true;throw new Error(`rename failed; rollback incomplete for ${failures.join(', ')}; .envelope-*.bak backups preserved`);}
    throw err;
  } finally {
    for(const stage of stages){rmSync(stage.tmp,{force:true});if(!rollbackFailed)rmSync(stage.backup,{force:true});}
    rmSync(lockPath,{recursive:true,force:true});
  }
}
