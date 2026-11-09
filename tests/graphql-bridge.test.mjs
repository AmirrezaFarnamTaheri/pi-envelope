import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {GraphVersionStore} from '../extensions/envelope/graph-versions.mjs';
import {checkGraphqlAst,createGraphqlServer} from '../scripts/envelope-graphql-local.mjs';
const selection=selections=>({kind:'SelectionSet',selections});
const field=(name,children)=>({kind:'Field',name:{value:name},...(children?{selectionSet:selection(children)}:{})});
const doc=selections=>({kind:'Document',definitions:[{kind:'OperationDefinition',operation:'query',selectionSet:selection(selections)}]});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'env-gql-repo-')),home=mkdtempSync(join(tmpdir(),'env-gql-home-'));
 t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});});
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src','a.ts'),'export const a=1;');
 const index=new CodeIndex(root,{ts});index.refresh();
 const store=new GraphVersionStore(join(home,'envelope-graph-versions')),version=store.capture(index).version;
 return {root,home,store,index,version};
}
test('AST guard accepts shallow query and rejects mutation, fragments, introspection, deep and wide expansion',()=>{
 assert.equal(checkGraphqlAst(doc([field('versions',[field('version')])])).ok,true);
 assert.equal(checkGraphqlAst({kind:'Document',definitions:[{kind:'OperationDefinition',operation:'mutation',selectionSet:selection([field('x')])}]}).ok,false);
 assert.equal(checkGraphqlAst({kind:'Document',definitions:[{kind:'FragmentDefinition',selectionSet:selection([field('x')])}]}).ok,false);
 assert.equal(checkGraphqlAst(doc([field('__schema')])).ok,false);
 let nested=field('version');for(let i=0;i<8;i++)nested=field('files',[nested]);
 assert.equal(checkGraphqlAst(doc([nested])).ok,false);
 assert.equal(checkGraphqlAst(doc(Array.from({length:80},()=>field('versions')))).ok,false);
});
test('loopback rejects missing bearer tokens, browser Origin, and GET requests',async t=>{
 const f=fixture(t),token='my-super-secret-32-char-token-1234';
 const fakeGql={buildSchema:s=>s,parse:()=>doc([field('versions')]),graphql:async()=>({data:{versions:[]}})};
 const server=await createGraphqlServer({store:f.store,source:f.index,gql:fakeGql,token,port:0});
 t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/graphql';
 const opts={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'{ versions { version } }'})};
 assert.equal((await fetch(url,opts)).status,401);
 assert.equal((await fetch(url,{...opts,headers:{...opts.headers,Authorization:'Bearer '+token,Origin:'https://evil.example'}})).status,403);
 assert.equal((await fetch(url,{...opts,headers:{...opts.headers,Authorization:'Bearer '+token}})).status,200);
 assert.equal((await fetch(url,{method:'GET',headers:{Authorization:'Bearer '+token}})).status,405);
});
test('server returns only captured metadata and bounds oversized queries',async t=>{
 const f=fixture(t),token='my-super-secret-32-char-token-1234';
 const fakeGql={buildSchema:s=>s,parse:()=>doc([field('versions')]),graphql:async({rootValue})=>({data:{versions:rootValue.versions()}})};
 const server=await createGraphqlServer({store:f.store,source:f.index,gql:fakeGql,token,port:0});
 t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/graphql';
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({query:'{ versions { version } }'})});
 assert.equal(r.status,200);
 const response=await r.json();assert.equal(response.data.versions[0].version,f.version);
 assert.doesNotMatch(JSON.stringify(response),/export const a=1/);
 const oversized=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({query:'x'.repeat(10000)})});
 assert.ok([400,413].includes(oversized.status));
});

test('GraphQL snapshot exposes full count of 35 declarations while keeping the compact cap of 30',async t=>{
 const f=fixture(t),token='my-super-secret-32-char-token-1234';
 writeFileSync(join(f.root,'src','a.ts'),Array.from({length:35},(_,i)=>'export const symbol'+i+'='+i+';').join('\n'));
 f.index.refresh();const saved=f.store.capture(f.index).version;
 const snapshot=f.store.snapshot(f.index,{version:saved});
 assert.equal(snapshot.files[0].symbolCount,35);
 assert.equal(snapshot.files[0].symbols.length,30);
 const fakeGql={buildSchema:s=>s,parse:()=>doc([field('snapshot',[field('files',[field('symbolCount')])])]),
  graphql:async({rootValue})=>({data:{snapshot:rootValue.snapshot({version:saved})}})};
 const server=await createGraphqlServer({store:f.store,source:f.index,gql:fakeGql,token,port:0});
 t.after(()=>server.close());
 const res=await fetch('http://127.0.0.1:'+server.address().port+'/graphql',{method:'POST',
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({query:'{ snapshot { files { symbolCount } } }'})});
 assert.equal(res.status,200);
 const body=await res.json();assert.equal(body.data.snapshot.files[0].symbolCount,35);
});
