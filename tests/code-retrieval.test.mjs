import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {retrieveCodeEvidence} from '../extensions/envelope/code-retrieval.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';
const corpus={
 'src/auth/tokenManager.ts':'export function validateAuthToken(raw: string){return raw.length > 3;}\nexport class AuthTokenStore{}\n',
 'src/user/userRepository.ts':'export function readUser(id:string){return id;}\n',
 'src/web/login.ts':'import {validateAuthToken} from "../auth/tokenManager";\nexport function login(token:string){return validateAuthToken(token)}\n',
 'src/db/client.ts':'export function connectDatabase() { return 1; }\n',
 'src/unused.ts':'export const ordinary = 1;\n'
};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-code-retrieve-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const [path,text] of Object.entries(corpus)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);}
 const index=new CodeIndex(root,{ts,maxFiles:100});index.refresh();
 return {root,index};
}
test('lexical symbol and path evidence retrieves exact relevant declarations with graph provenance',t=>{
 const {index}=fixture(t);
 const report=retrieveCodeEvidence(index,{query:'validate auth token',limit:3});
 assert.equal(report.mode,'local-symbol-and-path-rank-fusion');
 assert.equal(report.results[0].path,'src/auth/tokenManager.ts');
 assert.equal(report.results[0].bestSymbol.name,'validateAuthToken');
 assert.ok(report.results[0].bestSymbol.line>=1);
 assert.match(report.results[0].sha256,/^[0-9a-f]{64}$/);
 assert.deepEqual(report.results[0].importedBy,['src/web/login.ts']);
 assert.equal(report.results[0].evidence,'indexed-source-hash-verified');
 assert.ok(report.results.every(x=>!Object.hasOwn(x,'snippet')));
 assert.equal(report.externalProvidersUsed,false);
});
test('filename terms and camelcase splitting ground lookup without source-body scanning',t=>{
 const {index}=fixture(t);
 const match=retrieveCodeEvidence(index,{query:'database client'});
 assert.equal(match.results[0].path,'src/db/client.ts');
 assert.ok(match.results[0].termCoverage>=2);
 const empty=retrieveCodeEvidence(index,{query:'hidden_private_string'});
 assert.deepEqual(empty.results,[]);
});
test('source mutation after indexing blocks stale code retrieval, never exposes replaced bytes',t=>{
 const {index,root}=fixture(t);
 writeFileSync(join(root,'src/auth/tokenManager.ts'),'SECRET_OVERRIDE_NOT_INDEXED\n');
 const report=retrieveCodeEvidence(index,{query:'validate auth token'});
 assert.ok(report.skippedUnverified>0);
 assert.equal(report.complete,false);
 assert.equal(report.results.some(x=>x.path==='src/auth/tokenManager.ts'),false);
 assert.doesNotMatch(JSON.stringify(report),/SECRET_OVERRIDE/);
});
test('bounded snippets remain opt-in, exact-source verified and Unicode-safe',t=>{
 const {index}=fixture(t);
 const card=retrieveCodeEvidence(index,{query:'auth token',limit:1,includeSnippet:true});
 assert.equal(card.results.length,1);
 assert.ok(card.results[0].snippet.length<=450);
 assert.match(card.results[0].snippet,/validateAuthToken/);
 assert.ok(card.results[0].snippetStartLine>=1);
 assert.throws(()=>retrieveCodeEvidence(index,{query:'token',limit:30}),/limit/i);
 assert.throws(()=>retrieveCodeEvidence(index,{query:' '.repeat(200)}),/query/i);
});
test('bounded result lists and incomplete parser coverage are explicitly disclosed',t=>{
 const {index}=fixture(t);
 const result=retrieveCodeEvidence(index,{query:'src',limit:1});
 assert.equal(result.results.length,1);
 assert.equal(result.truncated,true);
 assert.equal(result.complete,false);
 index.lastRefresh.unavailable=['python'];
 const partial=retrieveCodeEvidence(index,{query:'validate auth token'});
 assert.ok(partial.reasons.includes('parser-unavailable'));
});
test('existing code API registers one read-only retrieval tool and no event hooks',async t=>{
 const {root}=fixture(t);const tools=new Map(),events=[];
 const pi={registerTool(x){tools.set(x.name,x)},on(e){events.push(e)}};
 const api=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,treeEnabled:false,languagesEnabled:false}}),loadCompiler:async()=>ts});
 const tool=tools.get('envelope_code_retrieve');assert.ok(tool);
 const response=await tool.execute('id',{query:'validate token'},null,null,{cwd:root});
 assert.equal(response.isError,false,response.content[0].text);
 assert.equal(JSON.parse(response.content[0].text).results[0].path,'src/auth/tokenManager.ts');
 assert.equal(events.length,0);
 api.close();
});
