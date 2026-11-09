/** Genuine GraphQL.js parser/executor smoke on isolated loopback, no provider. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {GraphVersionStore} from '../extensions/envelope/graph-versions.mjs';
import {createGraphqlServer} from './envelope-graphql-local.mjs';
export async function smokeRealGraphql(){
 const gql=await import('graphql'),top=realpathSync(mkdtempSync(join(tmpdir(),'envelope-gql-real-')));
 const root=join(top,'project'),home=join(top,'home');mkdirSync(root);mkdirSync(home);
 let server;
 try{
   writeFileSync(join(root,'demo.ts'),'export function demo(){return 12;}');
   const index=new CodeIndex(root,{ts});index.refresh();
   const store=new GraphVersionStore(join(home,'envelope-graph-versions'));
   const version=store.capture(index).version,token=randomBytes(32).toString('hex');
   server=await createGraphqlServer({store,source:{root,files:new Map(),checkedPath:p=>p},gql,token,port:0});
   const url='http://127.0.0.1:'+server.address().port+'/graphql';
   const req=async(query,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...headers},body:JSON.stringify({query})});
   const versions=await req('{ versions { version files symbols } }');
   assert.equal(versions.status,200);
   const list=await versions.json();assert.equal(list.data.versions[0].version,version);
   const snapshot=await req('{ snapshot(version:"'+version+'") { totalFiles files { path imports } } }');
   assert.equal(snapshot.status,200);
   const data=await snapshot.json();assert.equal(data.data.snapshot.files[0].path,'demo.ts');
   assert.doesNotMatch(JSON.stringify(data),/export function demo\(\)\{return 12;\}/);
   const diff=await req('{ compare(from:"'+version+'",to:"'+version+'") { filesChanged } }');
   assert.equal((await diff.json()).data.compare.filesChanged,0);
   const mutation=await req('mutation { versions { version } }');assert.equal(mutation.status,400);
   const unauthed=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthed.status,401);
   const origin=await req('{ versions { version } }',{'Origin':'https://evil.example'});assert.equal(origin.status,403);
   return {ok:true,schema:'GraphQL.js',metadataOnly:true,queryTypes:['versions','snapshot','compare'],protectedOrigin:true,authenticated:true};
 }finally{server?.close();rmSync(top,{recursive:true,force:true});}
}
if(process.argv[1]?.endsWith('smoke-graphql-real.mjs')){
 try{console.log(JSON.stringify(await smokeRealGraphql()));}
 catch(err){console.error('GraphQL real smoke failed:',String(err?.message||'unknown').slice(0,220));process.exitCode=1;}
}
