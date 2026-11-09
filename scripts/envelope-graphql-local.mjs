/** Operator-started authenticated loopback GraphQL projection of captured metadata. */
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {GraphVersionStore} from '../extensions/envelope/graph-versions.mjs';
export const GRAPHQL_SCHEMA=[
 'type Version { version: String!, capturedAt: String!, files: Int!, symbols: Int! }',
 'type FileMetadata { path: String!, sha256: String!, language: String, symbolCount: Int!, imports: [String!]!, truncatedSymbols: Boolean!, truncatedImports: Boolean! }',
 'type Snapshot { version: String!, capturedAt: String!, totalFiles: Int!, offset: Int!, returned: Int!, truncated: Boolean!, files: [FileMetadata!]! }',
 'type FileChange { path: String!, change: String!, addedImports: [String!]!, removedImports: [String!]!, symbolCountBefore: Int!, symbolCountAfter: Int! }',
 'type Diff { from: String!, to: String!, version: String!, filesChanged: Int!, totalChanges: Int!, truncated: Boolean!, changes: [FileChange!]! }',
 'type Query { versions: [Version!]!, snapshot(version: String!, limit: Int = 20, offset: Int = 0): Snapshot!, compare(from: String!, to: String!, limit: Int = 10, offset: Int = 0, ifVersion: String): Diff! }'
].join('\n');
const err=message=>({error:message});
export function checkGraphqlAst(document){
 if(document?.kind!=='Document'||!Array.isArray(document.definitions)||document.definitions.length!==1)return {ok:false};
 const def=document.definitions[0];if(def.kind!=='OperationDefinition'||def.operation!=='query')return {ok:false};
 let fields=0,invalid=false;
 const visit=(set,depth)=>{
   if(depth>5||!set||!Array.isArray(set.selections)){invalid=true;return;}
   for(const item of set.selections){
     if(item.kind!=='Field'||!item.name?.value||item.name.value.startsWith('__')){invalid=true;return;}
     if(++fields>24){invalid=true;return;}
     if(item.selectionSet)visit(item.selectionSet,depth+1);
   }
 };
 visit(def.selectionSet,1);
 return {ok:!invalid&&fields>0,fields};
}
function rootResolvers(store,source){
 return {
  versions:()=>store.list(source).versions,
  snapshot:({version,limit=20,offset=0})=>{
    const data=store.snapshot(source,{version,limit,offset});
    return {...data,files:data.files.map(x=>({...x,symbolCount:x.symbols.length}))};
  },
  compare:({from,to,limit=10,offset=0,ifVersion})=>store.compare(source,{from,to,limit,offset,ifVersion,maxChars:15000})
 };
}
function authenticated(provided,secret){
 if(typeof provided!=='string'||!provided.startsWith('Bearer '))return false;
 const supplied=Buffer.from(provided.slice(7)),expected=Buffer.from(secret);
 return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}
export async function createGraphqlServer({store,source,gql,token,port=0}={}){
 if(!store?.list||!store?.snapshot||!store?.compare||!source?.root)throw new TypeError('captured private graph version store required');
 if(!gql?.buildSchema||!gql?.parse||!gql?.graphql)throw new TypeError('real GraphQL parser/executor required');
 if(typeof token!=='string'||token.length<32||token.length>512)throw new Error('operator-provided bearer token must have 32-512 chars');
 if(!Number.isInteger(port)||port<0||port>65535)throw new RangeError('invalid loopback port');
 const schema=gql.buildSchema(GRAPHQL_SCHEMA),rootValue=rootResolvers(store,source);
 let minute=Date.now(),requests=0;
 const server=createServer(async(req,res)=>{
   const send=(code,payload)=>{
     if(res.writableEnded)return;
     res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"});
     res.end(JSON.stringify(payload));
   };
   if(req.headers.origin)return send(403,err('Origin not permitted'));
   if(!authenticated(req.headers.authorization,token))return send(401,err('Authentication required'));
   if(req.method!=='POST')return send(405,err('POST only'));
   if(req.url!=='/graphql')return send(404,err('Not found'));
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return send(415,err('JSON content type required'));
   if(Date.now()-minute>60000){minute=Date.now();requests=0;}
   if(++requests>30)return send(429,err('Request limit exceeded'));
   req.setTimeout(3000,()=>req.destroy());
   let total=0,overflow=false;const parts=[];
   try{for await(const chunk of req){total+=chunk.length;if(total>4096){overflow=true;continue;}if(!overflow)parts.push(chunk);}}
   catch{return;}
   if(overflow)return send(413,err('Request too large'));
   let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return send(400,err('Malformed JSON'));}
   if(typeof data?.query!=='string'||data.query.length>2048||!data.query.trim()||
       (data.variables!==undefined&&(!data.variables||typeof data.variables!=='object'||Array.isArray(data.variables))))return send(400,err('Invalid query'));
   let ast;try{ast=gql.parse(data.query);}catch{return send(400,err('Invalid GraphQL document'));}
   if(!checkGraphqlAst(ast).ok)return send(400,err('GraphQL query exceeds read-only complexity policy'));
   let executed;
   try{executed=await gql.graphql({schema,source:data.query,rootValue,variableValues:data.variables??{}});}
   catch{return send(400,err('Query unavailable'));}
   const result=executed?.errors?{data:executed.data??null,errors:executed.errors.map(()=>({message:'Query unavailable or invalid'}))}:executed;
   if(Buffer.byteLength(JSON.stringify(result),'utf8')>16000)return send(413,err('Response too large'));
   send(200,result);
 });
 server.requestTimeout=5000;server.headersTimeout=5000;
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
 return server;
}
function argsOf(argv){
 const args=argv.slice(2);
 if(args.length!==6||args[0]!=='--project'||args[2]!=='--home'||args[4]!=='--port')throw Error('Usage: --project /abs --home /abs --port 0');
 if(!isAbsolute(args[1])||!isAbsolute(args[3]))throw Error('absolute project and Envelope home required');
 const port=Number(args[5]);if(!Number.isInteger(port)||port<0||port>65535)throw Error('invalid port');
 return {root:realpathSync(resolve(args[1])),home:realpathSync(resolve(args[3])),port};
}
export async function runGraphqlCli(argv=process.argv){
 const {root,home,port}=argsOf(argv),token=process.env.ENVELOPE_GRAPHQL_TOKEN;
 const gql=await import('graphql');
 const store=new GraphVersionStore(join(home,'envelope-graph-versions'));
 const server=await createGraphqlServer({store,source:{root,files:new Map(),checkedPath:p=>p},gql,token,port});
 const address=server.address();process.stdout.write(JSON.stringify({host:'127.0.0.1',port:address.port,readOnly:true})+'\n');
 const shutdown=()=>server.close();process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
if(process.argv[1]?.endsWith('envelope-graphql-local.mjs')){
 runGraphqlCli().catch(()=>{process.stderr.write('Envelope GraphQL setup failed: verify optional GraphQL.js installation, private token and absolute paths\n');process.exitCode=1;});
}
