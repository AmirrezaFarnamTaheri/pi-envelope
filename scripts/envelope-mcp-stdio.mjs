/** Operator-launched read-only MCP stdio over explicitly persisted graph metadata. */
import {once} from 'node:events';
import {realpathSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {GraphVersionStore} from '../extensions/envelope/graph-versions.mjs';
const PROTOCOL='2025-11-25',MAX_LINE=16384,MAX_RESPONSE=20000;
const tools=[
 {name:'envelope.graph.versions',description:'List explicitly captured private file-graph metadata versions (no source bodies)',
  inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'envelope.graph.snapshot',description:'Inspect one stored graph metadata version with capped file list',
  inputSchema:{type:'object',properties:{version:{type:'string'},limit:{type:'integer',minimum:1,maximum:50},offset:{type:'integer',minimum:0,maximum:512}},required:['version'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'envelope.graph.compare',description:'Compare two content-addressed historical snapshots, read-only',
  inputSchema:{type:'object',properties:{from:{type:'string'},to:{type:'string'},limit:{type:'integer',minimum:1,maximum:25},offset:{type:'integer',minimum:0,maximum:1024},ifVersion:{type:'string'},maxChars:{type:'integer',minimum:900,maximum:16000}},required:['from','to'],additionalProperties:false},annotations:{readOnlyHint:true}}
];
function argsOf(argv){
 const args=argv.slice(2);if(args.length!==4||args[0]!=='--project'||args[2]!=='--home')throw Error('Usage: node scripts/envelope-mcp-stdio.mjs --project /absolute/project --home /absolute/home');
 if(!isAbsolute(args[1])||!isAbsolute(args[3]))throw Error('absolute project and Envelope home required');
 return {root:realpathSync(resolve(args[1])),home:realpathSync(resolve(args[3]))};
}
function index(root){return {root,files:new Map(),checkedPath:p=>p};}
export function createMcpHandler(store,source){
 let initialized=false,ready=false;
 const ok=(id,result)=>({jsonrpc:'2.0',id,result});
 const error=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
 return function handle(request){
   if(!request||typeof request!=='object'||Array.isArray(request)||request.jsonrpc!=='2.0'||typeof request.method!=='string')return error(request?.id??null,-32600,'Invalid request');
   if(!Object.hasOwn(request,'id')){if(request.method==='notifications/initialized'&&initialized)ready=true;return null;}
   const id=request.id;
   if(typeof id!=='number'&&typeof id!=='string')return error(null,-32600,'Invalid request ID');
   if(request.method==='initialize'){
     if(initialized)return error(id,-32600,'Already initialized');
     if(request.params?.protocolVersion!==PROTOCOL)return error(id,-32602,'Unsupported MCP protocol version');
     initialized=true;
     return ok(id,{protocolVersion:PROTOCOL,capabilities:{tools:{listChanged:false}},serverInfo:{name:'pi-envelope-private-graph',version:'0.1.0'},instructions:'Only operator-captured file metadata; not source code, typed symbols or semantic proof.'});
   }
   if(!ready)return error(id,-32002,'Initialize the MCP session first');
   if(request.method==='ping')return ok(id,{});
   if(request.method==='tools/list')return ok(id,{tools});
   if(request.method!=='tools/call')return error(id,-32601,'Method not found');
   const name=request.params?.name,arguments_=request.params?.arguments??{};
   if(typeof name!=='string'||!tools.some(x=>x.name===name))return error(id,-32602,'Unknown tool');
   if(!arguments_||typeof arguments_!=='object'||Array.isArray(arguments_))return error(id,-32602,'Invalid tool arguments');
   try{
     let data;
     if(name==='envelope.graph.versions'){
       if(Object.keys(arguments_).length)throw Error('unexpected arguments');
       data=store.list(source);
     }else if(name==='envelope.graph.snapshot'){
       if(Object.keys(arguments_).some(x=>!['version','limit','offset'].includes(x)))throw Error('unknown argument');
       data=store.snapshot(source,arguments_);
     }else{
       if(Object.keys(arguments_).some(x=>!['from','to','limit','offset','ifVersion','maxChars'].includes(x)))throw Error('unknown argument');
       data=store.compare(source,arguments_);
     }
     const serialized=JSON.stringify(data);
     const response=ok(id,{content:[{type:'text',text:serialized}],structuredContent:data,isError:false});
     if(Buffer.byteLength(JSON.stringify(response),'utf8')>MAX_RESPONSE)throw Error('response exceeded byte budget');
     return response;
   }catch{return ok(id,{content:[{type:'text',text:'Snapshot unavailable or invalid. Check authorization, version and byte limits.'}],isError:true});}
 };
}
export async function runMcpStdio(argv=process.argv,stdin=process.stdin,stdout=process.stdout){
 const {root,home}=argsOf(argv);
 const handler=createMcpHandler(new GraphVersionStore(join(home,'envelope-graph-versions')),index(root));
 // Parse raw bytes before assembling any unbounded line. Pausing consumption
 // while waiting for stdout drain also applies the stream's highWaterMark to
 // queued request bytes instead of accumulating every pipelined request.
 let pending=Buffer.alloc(0),tooLong=false;
 const send=async reply=>{
   if(!reply)return;
   let encoded=JSON.stringify(reply);
   if(Buffer.byteLength(encoded,'utf8')>MAX_RESPONSE)
     encoded=JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Response too large'}});
   if(!stdout.write(encoded+'\n'))await once(stdout,'drain');
 };
 for await(const part of stdin){
   const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);let cursor=0;
   while(cursor<chunk.length){
     const newline=chunk.indexOf(10,cursor),end=newline===-1?chunk.length:newline;
     const fragment=chunk.subarray(cursor,end);
     if(!tooLong){
       if(pending.length+fragment.length>MAX_LINE){tooLong=true;pending=Buffer.alloc(0);}
       else pending=Buffer.concat([pending,fragment]);
     }
     if(newline<0)break;
     let reply;
     if(tooLong)reply={jsonrpc:'2.0',id:null,error:{code:-32600,message:'Request too large'}};
     else{
       try{reply=handler(JSON.parse(pending.toString('utf8')));}
       catch{reply={jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}};}
     }
     pending=Buffer.alloc(0);tooLong=false;cursor=newline+1;
     await send(reply);
   }
 }
}
if(process.argv[1]?.endsWith('envelope-mcp-stdio.mjs')){
 runMcpStdio().catch(()=>{process.stderr.write('Envelope MCP setup failed: inspect absolute project and private home paths\n');process.exitCode=1;});
}
