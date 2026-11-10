import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mode=process.argv[2]||'pull';
let incoming=Buffer.alloc(0);
const opened=new Map();
function send(data){const body=Buffer.from(JSON.stringify(data),'utf8');process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);process.stdout.write(body);}
function notify(method,params){send({jsonrpc:'2.0',method,params});}
function reply(id,result){send({jsonrpc:'2.0',id,result});}
function editsFor(file){let text;try{text=readFileSync(join(process.cwd(),file),'utf8');}catch{return [];}
 const edits=[];for(const match of text.matchAll(/\badd\b/g)){
   const before=text.slice(0,match.index);const lines=before.split('\n');const line=lines.length-1;const character=lines.at(-1).length;
   edits.push({range:{start:{line,character},end:{line,character:character+3}},newText:'multiply'});
 }return edits;
}
function onMessage(msg){
 if(msg.method==='initialize'){
   if(mode==='hang-init')return;
   reply(msg.id,{capabilities:{renameProvider:true,definitionProvider:mode!=='nav-unsupported',referencesProvider:mode!=='nav-unsupported',...(['push','push-stale'].includes(mode)?{}:{diagnosticProvider:{interFileDependencies:false,workspaceDiagnostics:false}})}});return;
 }
 if(msg.method==='initialized')return;
 if(msg.method==='textDocument/didOpen'){
   opened.set(msg.params.textDocument.uri,msg.params.textDocument);
   if(['push','push-stale'].includes(mode))notify('textDocument/publishDiagnostics',{uri:msg.params.textDocument.uri,version:msg.params.textDocument.version+(mode==='push-stale'?1:0),diagnostics:[]});
   return;
 }
 if(msg.method==='textDocument/diagnostic'){
   if(mode==='hang-diagnostics')return;
   if(mode==='unchanged')return reply(msg.id,{kind:'unchanged',resultId:'none'});
   let items=mode==='errors'||(mode==='errors-in-b'&&msg.params.textDocument.uri.endsWith('/b.ts'))?[{range:{start:{line:0,character:1},end:{line:0,character:4}},severity:1,code:'TS999',message:'Example error'}]:[];
   if(mode==='infra')items=[1,2,3].map(n=>({range:{start:{line:0,character:n},end:{line:0,character:n+1}},severity:1,message:'Cannot find module dependency'}));
   if(mode==='bad-range')items=[{severity:1,message:'bad range'}];
   return reply(msg.id,{kind:'full',items,...(mode==='related'?{relatedDocuments:{'file:///other.ts':{kind:'full',items:[]}}}:{})});
 }
 if(msg.method==='textDocument/definition'||msg.method==='textDocument/references'){
   if(mode==='nav-unsupported')return reply(msg.id,null);
   const a=pathToFileURL(join(process.cwd(),'src','a.ts')).href;
   const b=pathToFileURL(join(process.cwd(),'src','b.ts')).href;
   const outside=pathToFileURL(join(process.cwd(),'..','private.ts')).href;
   const location=(uri,line,character)=>({uri,range:{start:{line,character},end:{line,character:character+3}}});
   const result=mode==='nav-outside'?[location(outside,0,0)]:
     msg.method==='textDocument/references'?[location(a,0,16),location(b,1,20)]:[location(a,0,16)];
   return reply(msg.id,result);
 }
 if(msg.method==='textDocument/rename'){
   if(mode==='hang-rename')return;
   if(mode==='outside')return reply(msg.id,{changes:{[pathToFileURL(join(process.cwd(),'..','escape.ts')).href]:[{range:{start:{line:0,character:0},end:{line:0,character:1}},newText:'BAD'}]}});
   if(mode==='fileop')return reply(msg.id,{documentChanges:[{kind:'create',uri:pathToFileURL(join(process.cwd(),'src','new.ts')).href}]});
   if(mode==='overlap'){const uri=pathToFileURL(join(process.cwd(),'src','a.ts')).href;return reply(msg.id,{changes:{[uri]:[...editsFor('src/a.ts'),...editsFor('src/a.ts')]}});}
   const changes={};for(const file of ['src/a.ts','src/b.ts']){const edits=editsFor(file);if(edits.length)changes[pathToFileURL(join(process.cwd(),file)).href]=edits.map(e=>({...e,newText:msg.params.newName}));}
   return reply(msg.id,{changes});
 }
 if(msg.method==='shutdown')return reply(msg.id,null);
 if(msg.method==='exit')return process.exit(0);
 if(msg.id!==undefined)send({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'method unavailable'}});
}
process.stdin.on('data',chunk=>{incoming=Buffer.concat([incoming,chunk]);if(incoming.length>4_000_000)process.exit(2);
 for(;;){const sep=incoming.indexOf('\r\n\r\n');if(sep<0)break;const header=incoming.subarray(0,sep).toString('ascii');const m=/^Content-Length:\s*(\d+)\s*$/im.exec(header);if(!m)process.exit(3);const count=Number(m[1]);if(incoming.length<sep+4+count)break;
 let obj;try{obj=JSON.parse(incoming.subarray(sep+4,sep+4+count).toString('utf8'));}catch{process.exit(4);}incoming=incoming.subarray(sep+4+count);onMessage(obj);
 }
});
