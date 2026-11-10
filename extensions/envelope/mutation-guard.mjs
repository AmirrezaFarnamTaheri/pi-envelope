/**
 * Conservative pre-write syntax gate, adapted from Pi Tree-sitter's preflight
 * pattern. It never mutates files and deliberately fails open when an exact
 * prospective edit cannot be reconstructed from Pi's current tool input.
 * Only local JS/TS syntax is checked; this is not a typechecker or security gate.
 */
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,extname,isAbsolute,relative,resolve,sep} from 'node:path';

const TYPES=new Set(['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs']);
const MAX_BYTES=1_000_000;
const within=(root,file)=>file===root||file.startsWith(root+sep);
const normalizeLF=s=>s.replace(/\r\n?/g,'\n');

function parse(ts,path,text) {
 const ext=extname(path).toLowerCase();
 const mode=ext==='.tsx'?ts.ScriptKind.TSX:
  ext==='.jsx'?(ts.ScriptKind.JSX??ts.ScriptKind.JS):
  ['.js','.mjs','.cjs'].includes(ext)?ts.ScriptKind.JS:ts.ScriptKind.TS;
 const sf=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,mode);
 return (sf.parseDiagnostics||[]).map(d=>{
  const loc=sf.getLineAndCharacterOfPosition(d.start||0);
  return {line:loc.line+1,column:loc.character+1,code:d.code,
   message:ts.flattenDiagnosticMessageText(d.messageText,' ').slice(0,260)};
 });
}

function getEdits(input) {
 let edits=input?.edits;
 if(typeof edits==='string'){
  try {edits=JSON.parse(edits);} catch {return null;}
 }
 if(!edits && typeof input?.oldText==='string'&&typeof input?.newText==='string')
  edits=[{oldText:input.oldText,newText:input.newText}];
 if(edits&&!Array.isArray(edits)&&typeof edits==='object')edits=[edits];
 if(!Array.isArray(edits)||!edits.length||edits.length>100)return null;
 return edits.every(x=>typeof x?.oldText==='string'&&x.oldText.length>0&&typeof x?.newText==='string')?edits:null;
}

function prospectiveEdit(original,edits){
 const content=normalizeLF(original.replace(/^\uFEFF/,''));
 const changes=[];
 for(const edit of edits){
  const needle=normalizeLF(edit.oldText),replacement=normalizeLF(edit.newText);
  if(!needle)return null;
  const offset=content.indexOf(needle);
  if(offset<0||content.indexOf(needle,offset+1)>=0)return null;
  changes.push({start:offset,end:offset+needle.length,text:replacement});
 }
 changes.sort((a,b)=>a.start-b.start);
 for(let i=1;i<changes.length;i++)if(changes[i].start<changes[i-1].end)return null;
 let result=content;
 for(let i=changes.length-1;i>=0;i--){const c=changes[i];result=result.slice(0,c.start)+c.text+result.slice(c.end);}
 return {baseline:content,proposed:result};
}

/** Return Pi's {block:true,reason} or undefined to leave its native tool alone. */
export function guardMutation(toolName,input,cwd,ts) {
 try {
  if(!ts?.createSourceFile||!['write','edit'].includes(toolName))return;
  if(!input||typeof input.path!=='string'||typeof cwd!=='string')return;
  const ext=extname(input.path).toLowerCase();
  if(!TYPES.has(ext))return;
  const root=realpathSync(cwd);
  const file=resolve(root,input.path);
  if(!within(root,file))return;
  // Do not claim to protect filesystem paths which the preview cannot inspect safely.
  let old=null;
  try{
   const stat=lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||!within(root,realpathSync(file)))return;
   if(toolName==='edit'){if(stat.size>MAX_BYTES)return;old=readFileSync(file,'utf8');}
  }catch{
   if(toolName==='edit')return;
   let parent=dirname(file);
   while(within(root,parent)){
    try{if(!within(root,realpathSync(parent)))return;break;}catch{parent=dirname(parent);}
   }
  }
  let proposed;
  if(toolName==='write'){
   if(typeof input.content!=='string'||Buffer.byteLength(input.content)>MAX_BYTES)return;
   proposed=input.content;
  }else{
   if(typeof old!=='string')return;
   if(Buffer.byteLength(old)>MAX_BYTES)return;
   const edits=getEdits(input);if(!edits)return;
   const result=prospectiveEdit(old,edits);if(!result)return;
   // Existing parser damage is not grounds for rejecting unrelated edits.
   if(parse(ts,file,result.baseline).length)return;
   proposed=result.proposed;
  }
  const errors=parse(ts,file,proposed);
  if(!errors.length)return;
  const e=errors[0];
  const n=errors.length>1?` (+${errors.length-1} more)`:'';
  return {block:true,reason:`Envelope pre-write syntax gate: ${toolName} rejected at line ${e.line}, column ${e.column}: TS${e.code} ${e.message}${n}. No source file was changed. Use /envelope code guard off to disable this opt-in gate.`.slice(0,850)};
 } catch { // Parser or file system failed: preserve native Pi tool behavior.
  return;
 }
}
