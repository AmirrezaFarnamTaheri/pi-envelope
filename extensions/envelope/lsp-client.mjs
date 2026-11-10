/** Bounded, one-shot LSP/JSON-RPC client. No server autodetection or shell. */
import { spawn } from 'node:child_process';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const MAX_MESSAGE_BYTES=4_000_000;
const MAX_HEADER_BYTES=8192;
const DEFAULT_TIMEOUT=3500;
const MAX_PENDING=8;
const VALID_TIMEOUT=(ms)=>Number.isInteger(ms)&&ms>=100&&ms<=10000?ms:DEFAULT_TIMEOUT;
function inside(root,file){const rel=relative(root,file);return rel!==''&&!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&rel!=='..'&&!isAbsolute(rel);}
const protocolError=(message)=>new Error(`LSP protocol: ${message}`);

/** LSP language identifiers must follow the source suffix, not default to TS. */
export function lspLanguageId(filePath){
  const ext=filePath.split('.').pop()?.toLowerCase();
  if(ext==='tsx')return 'typescriptreact';
  if(ext==='jsx')return 'javascriptreact';
  if(['js','mjs','cjs'].includes(ext))return 'javascript';
  if(['py','pyi','pyw'].includes(ext))return 'python';
  if(ext==='go')return 'go';
  if(['c','h'].includes(ext))return 'c';
  if(['cpp','hpp','cc','hh','cxx','hxx'].includes(ext))return 'cpp';
  if(ext==='rs')return 'rust';
  if(ext==='java')return 'java';
  return 'typescript';
}

export class StdioLspSession {
  constructor({root,command,timeoutMs=DEFAULT_TIMEOUT,signal}={}) {
    if(!Array.isArray(command)||!command.length||command.length>16||command.some(v=>typeof v!=='string'||!v||v.length>512||v.includes('\0')))throw new Error('LSP command must be non-empty argv');
    if(typeof root!=='string'||!root)throw new Error('project root required');
    this.root=resolve(root);
    this.timeoutMs=VALID_TIMEOUT(timeoutMs);
    this.pending=new Map();this.waiters=new Map();this.published=new Map();this.opened=new Map();this.buffer=Buffer.alloc(0);
    this.seq=0;this.closed=false;this.capabilities={};this.signal=signal;
    this.child=spawn(command[0],command.slice(1),{cwd:this.root,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
    this.child.stdout.on('data',chunk=>this.handleData(chunk));
    this.child.stderr.on('data',()=>{}); // Drain stderr; never place server logs or secrets in model context.
    for(const stream of [this.child.stdin,this.child.stdout,this.child.stderr])stream.on('error',err=>this.fail(new Error(`LSP stream error: ${err.code||'I/O'}`)));
    this.child.once('error',err=>this.fail(new Error(`LSP process failed: ${err.code||err.message}`)));
    this.child.once('exit',()=>this.fail(new Error('LSP process exited')));
    if(signal){this.onAbort=()=>this.fail(new Error('LSP aborted'));signal.addEventListener('abort',this.onAbort,{once:true});if(signal.aborted)this.onAbort();}
  }
  uri(path){
    const absolute=resolve(this.root,path);
    if(!inside(this.root,absolute))throw new Error('LSP path outside project');
    return pathToFileURL(absolute).href;
  }
  fail(error){
    if(this.closed)return;
    this.closed=true;
    for(const [,entry] of this.pending){clearTimeout(entry.timeout);entry.reject(error);}this.pending.clear();
    for(const [,entries] of this.waiters)for(const entry of entries){clearTimeout(entry.timeout);entry.resolve(null);}this.waiters.clear();
    this.child.kill('SIGTERM');
    // Short-lived sessions must not leave a server process behind if SIGTERM is ignored.
    if(this.child.exitCode===null){const force=setTimeout(()=>{if(this.child.exitCode===null)this.child.kill('SIGKILL');},350);force.unref();this.child.once('close',()=>clearTimeout(force));}
  }
  handleData(chunk){
    if(this.closed)return;
    if(this.buffer.length+chunk.length>MAX_MESSAGE_BYTES+MAX_HEADER_BYTES){this.fail(protocolError('response too large'));return;}
    this.buffer=Buffer.concat([this.buffer,chunk]);
    for(;;){
      const headerEnd=this.buffer.indexOf('\r\n\r\n');
      if(headerEnd<0){if(this.buffer.length>MAX_HEADER_BYTES)this.fail(protocolError('header too large'));return;}
      if(headerEnd>MAX_HEADER_BYTES){this.fail(protocolError('header too large'));return;}
      const header=this.buffer.subarray(0,headerEnd).toString('ascii');
      const match=/^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if(!match){this.fail(protocolError('missing Content-Length'));return;}
      const length=Number(match[1]);if(!Number.isSafeInteger(length)||length>MAX_MESSAGE_BYTES){this.fail(protocolError('invalid Content-Length'));return;}
      if(this.buffer.length<headerEnd+4+length)return;
      const body=this.buffer.subarray(headerEnd+4,headerEnd+4+length);this.buffer=this.buffer.subarray(headerEnd+4+length);
      let message;try{message=JSON.parse(body.toString('utf8'));}catch{this.fail(protocolError('invalid JSON'));return;}
      if(!message||typeof message!=='object'||Array.isArray(message)){this.fail(protocolError('invalid envelope'));return;}
      this.dispatch(message);
      if(this.closed)return;
    }
  }
  dispatch(message){
    if(message.id!==undefined && message.method===undefined){
      const entry=this.pending.get(message.id);
      if(!entry)return;
      this.pending.delete(message.id);clearTimeout(entry.timeout);
      if(message.error)entry.reject(new Error(`LSP request rejected (${String(message.error.code??'unknown')})`));
      else entry.resolve(message.result);
      return;
    }
    if(message.method==='textDocument/publishDiagnostics'){
      const data=message.params;
      if(typeof data?.uri!=='string'||!Array.isArray(data.diagnostics))return;
      if(this.opened.get(data.uri)!==undefined && data.version!==undefined && data.version!==this.opened.get(data.uri))return;
      if(!this.opened.has(data.uri))return;
      this.published.set(data.uri,data);
      const waiting=this.waiters.get(data.uri)||[];this.waiters.delete(data.uri);
      for(const entry of waiting){clearTimeout(entry.timeout);entry.resolve(data);}
      return;
    }
    if(message.method && message.id!==undefined){
      this.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported server request'}});
    }
  }
  send(msg){
    if(this.closed)throw new Error('LSP session closed');
    const body=Buffer.from(JSON.stringify(msg));
    if(body.length>MAX_MESSAGE_BYTES)throw protocolError('request too large');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);this.child.stdin.write(body);
  }
  request(method,params){
    if(this.closed)return Promise.reject(new Error('LSP session closed'));
    if(this.pending.size>=MAX_PENDING)return Promise.reject(protocolError('too many pending requests'));
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error(`LSP timeout: ${method}`));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timeout});
      try{this.send({jsonrpc:'2.0',id,method,params});}catch(err){clearTimeout(timeout);this.pending.delete(id);reject(err);}
    });
  }
  async initialize(){
    const result=await this.request('initialize',{
      processId:process.pid,rootUri:pathToFileURL(this.root).href,rootPath:this.root,
      capabilities:{textDocument:{diagnostic:{},rename:{prepareSupport:false},definition:{linkSupport:true},references:{}},workspace:{workspaceEdit:{documentChanges:true}}},
      workspaceFolders:[{uri:pathToFileURL(this.root).href,name:basename(this.root)}],trace:'off'
    });
    if(!result?.capabilities||typeof result.capabilities!=='object')throw protocolError('invalid initialize result');
    this.capabilities=result.capabilities;
    this.send({jsonrpc:'2.0',method:'initialized',params:{}});
  }
  async open(path,text){
    if(typeof text!=='string'||Buffer.byteLength(text)>512_000)throw new Error('LSP file is too large');
    const uri=this.uri(path);this.opened.set(uri,1);this.published.delete(uri);
    const languageId=lspLanguageId(path);
    this.send({jsonrpc:'2.0',method:'textDocument/didOpen',params:{textDocument:{uri,languageId,version:1,text}}});
  }
  async diagnostics(path){
    const uri=this.uri(path);
    if(!this.opened.has(uri))throw new Error('LSP document not open');
    if(this.capabilities.diagnosticProvider){
      try{
        const data=await this.request('textDocument/diagnostic',{textDocument:{uri}});
        if(data?.kind==='full'&&Array.isArray(data.items)){
          if(data.relatedDocuments&&Object.keys(data.relatedDocuments).length)return {status:'unverified',reason:'LSP returned related-document diagnostics outside this verification scope'};
          return {status:'verified',source:'pull',diagnostics:data.items};
        }
        return {status:'unverified',reason:'LSP did not return a full diagnostic report'};
      }catch(err){return {status:'unverified',reason:err.message.includes('timeout')?'LSP diagnostics timed out':'LSP diagnostics request failed'};}
    }
    if(this.published.has(uri))return {status:'verified',source:'push',diagnostics:this.published.get(uri).diagnostics};
    const data=await new Promise(resolve=>{
      const timeout=setTimeout(()=>{const old=this.waiters.get(uri)||[];this.waiters.set(uri,old.filter(x=>x.resolve!==resolve));resolve(null);},this.timeoutMs);
      this.waiters.set(uri,[...(this.waiters.get(uri)||[]),{resolve,timeout}]);
    });
    if(!data)return {status:'unverified',reason:'LSP did not publish diagnostics for this document'};
    return {status:'verified',source:'push',diagnostics:data.diagnostics};
  }
  /** Query a configured LSP for local definitions or references; no semantic claim beyond the response. */
  async locations(kind,path,line,column){
    if(kind!=='definition'&&kind!=='references')throw new Error('Unsupported LSP navigation kind');
    if(!Number.isInteger(line)||!Number.isInteger(column)||line<1||column<1)throw new Error('LSP navigation requires one-based positive coordinates');
    const uri=this.uri(path);
    if(!this.opened.has(uri))throw new Error('LSP document not open');
    if(!(kind==='definition'?this.capabilities.definitionProvider:this.capabilities.referencesProvider))
      return {status:'unverified',reason:'LSP server does not advertise '+kind+' support',locations:[]};
    const method=kind==='definition'?'textDocument/definition':'textDocument/references';
    let raw;
    try{raw=await this.request(method,{textDocument:{uri},position:{line:line-1,character:column-1},
      ...(kind==='references'?{context:{includeDeclaration:true}}:{})});}
    catch{return {status:'unverified',reason:'LSP navigation request failed or timed out',locations:[]};}
    const items=raw===null?[]:Array.isArray(raw)?raw:[raw];
    if(items.length>256)return {status:'unverified',reason:'LSP navigation exceeded the 256-location input cap',locations:[]};
    const locations=[];
    for(const item of items){
      const target=item?.targetUri??item?.uri;
      const range=item?.targetSelectionRange??item?.range??item?.targetRange;
      if(typeof target!=='string'||!target.startsWith('file:')||!range?.start||!range?.end)
        return {status:'unverified',reason:'LSP returned an invalid or non-file location',locations:[]};
      const points=[range.start,range.end];
      if(points.some(p=>!Number.isInteger(p.line)||!Number.isInteger(p.character)||p.line<0||p.character<0)
        ||range.end.line<range.start.line||(range.end.line===range.start.line&&range.end.character<range.start.character))
        return {status:'unverified',reason:'LSP returned an invalid source range',locations:[]};
      let absolute;
      try{absolute=fileURLToPath(target);}catch{return {status:'unverified',reason:'LSP returned an invalid source URI',locations:[]};}
      if(!inside(this.root,absolute))
        return {status:'unverified',reason:'LSP returned a location outside the project root',locations:[]};
      locations.push({uri:target,range});
    }
    const truncated=locations.length>64;
    return {status:truncated?'partial':'verified',locations:locations.slice(0,64),
      ...(truncated?{reason:'LSP navigation capped at 64 returned locations'}:{})};
  }
  async rename(path,line,column,newName){
    if(!this.capabilities.renameProvider)throw new Error('LSP server does not advertise rename support');
    if(!this.opened.has(this.uri(path)))throw new Error('LSP document not open');
    const edit=await this.request('textDocument/rename',{textDocument:{uri:this.uri(path)},position:{line:line-1,character:column-1},newName});
    if(!edit||typeof edit!=='object')throw new Error('LSP returned no WorkspaceEdit');
    return edit;
  }
  close(){
    if(this.signal&&this.onAbort)this.signal.removeEventListener('abort',this.onAbort);
    if(!this.closed){
      for(const uri of this.opened.keys()){
        try{this.send({jsonrpc:'2.0',method:'textDocument/didClose',params:{textDocument:{uri}}});}catch{}
      }
      try{this.send({jsonrpc:'2.0',method:'exit',params:{}});}catch{}
    }
    this.fail(new Error('LSP session closing'));
  }
}

export async function withLspSession(options,operation){
  const session=new StdioLspSession(options);
  try{await session.initialize();return await operation(session);}finally{session.close();}
}
