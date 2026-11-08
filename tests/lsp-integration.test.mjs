import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import registerEnvelope from '../extensions/envelope/index.mjs';
const mock=fileURLToPath(new URL('./fixtures/mock-lsp-server.mjs',import.meta.url));
function fixture(t,{mode='pull',configured=true}={}){
 const root=mkdtempSync(join(tmpdir(),'envelope-lsp-api-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo=join(root,'repo'),home=join(root,'home');mkdirSync(join(repo,'src'),{recursive:true});mkdirSync(home);
 writeFileSync(join(repo,'src','a.ts'),'export function add(n:number) { return n+1; }\n');
 writeFileSync(join(repo,'src','b.ts'),"import { add } from './a';\nexport const result=add(2);\n");
 assert.equal(spawnSync('git',['init','-q'],{cwd:repo}).status,0);
 if(configured)writeFileSync(join(home,'settings.json'),JSON.stringify({envelope:{code:{lspCommand:[process.execPath,mock,mode]}}}));
 const hooks=new Map(),tools=new Map(),commands=new Map(),notices=[];
 const pi={cwd:repo,logger:{warn(){}},on(name,fn){hooks.set(name,[...(hooks.get(name)||[]),fn]);},registerTool(tool){assert.ok(!tools.has(tool.name));tools.set(tool.name,tool);},registerCommand(name,handler){commands.set(name,handler);}};
 const extension=registerEnvelope(pi,{home});const ctx={cwd:repo,ui:{notify:(text)=>notices.push(text)},sessionManager:{getSessionId:()=> 's'}};
 const call=(name,args)=>tools.get(name).execute('test-id',args,undefined,undefined,ctx);
 const command=(cmd)=>commands.get('envelope').handler(cmd,ctx);
 return {root,repo,home,tools,commands,hooks,notices,call,command,extension};
}
const req={path:'src/a.ts',line:1,column:17,newName:'multiply'};
const body=(x)=>JSON.parse(x.content[0].text);

test('registers two namespaced LSP tools without new context/tool-result hook owners',async t=>{
 const h=fixture(t);
 assert.ok(h.tools.has('envelope_code_lsp_verify'));
 assert.ok(h.tools.has('envelope_code_rename'));
 assert.equal(h.hooks.get('context').length,1);
 assert.equal(h.hooks.get('tool_result').length,1);
 assert.equal(h.hooks.get('tool_call').length,1);
 h.extension.close();
});
test('LSP verified clean, error, and unavailable produce distinct verdicts',async t=>{
 const clean=fixture(t);assert.equal(body(await clean.call('envelope_code_lsp_verify',{path:'src/a.ts'})).verdict,'PASS');
 const errors=fixture(t,{mode:'errors'});const problem=body(await errors.call('envelope_code_lsp_verify',{path:'src/a.ts'}));
 assert.equal(problem.verdict,'FAIL');assert.equal(problem.diagnostics[0].severity,'error');
 const none=fixture(t,{configured:false});const missing=body(await none.call('envelope_code_lsp_verify',{path:'src/a.ts'}));
 assert.equal(missing.verdict,'UNVERIFIED');assert.notEqual(missing.verdict,'PASS');
});
test('rename previews without writing, requires opt-in and fingerprint, then changes two files',async t=>{
 const h=fixture(t);const original=readFileSync(join(h.repo,'src','a.ts'),'utf8');
 const preview=body(await h.call('envelope_code_rename',req));
 assert.equal(preview.applied,false);assert.match(preview.planId,/^[a-f0-9]{64}$/);assert.equal(preview.files.length,2);
 assert.equal(readFileSync(join(h.repo,'src','a.ts'),'utf8'),original);
 const deny=await h.call('envelope_code_rename',{...req,apply:true,planId:preview.planId});
 assert.equal(deny.isError,true);assert.match(deny.content[0].text,/enable|off|disabled/i);
 await h.command('code rename on');
 const mismatch=await h.call('envelope_code_rename',{...req,apply:true,planId:'f'.repeat(64)});
 assert.equal(mismatch.isError,true);assert.equal(readFileSync(join(h.repo,'src','a.ts'),'utf8'),original);
 const changed=body(await h.call('envelope_code_rename',{...req,apply:true,planId:preview.planId}));
 assert.equal(changed.applied,true);assert.equal(changed.files.length,2);
 assert.match(readFileSync(join(h.repo,'src','a.ts'),'utf8'),/function multiply/);
 assert.match(readFileSync(join(h.repo,'src','b.ts'),'utf8'),/result=multiply/);
 const settings=JSON.parse(readFileSync(join(h.home,'settings.json'),'utf8'));
 assert.equal(settings.envelope.code.renameEnabled,true);
});
test('stale preview, unsafe workspace edit, disabled code and missing server never write',async t=>{
 const h=fixture(t);const preview=body(await h.call('envelope_code_rename',req));
 await h.command('code rename on');writeFileSync(join(h.repo,'src','b.ts'),"import { add } from './a';\nconst changed=add(1);\n");
 const stale=await h.call('envelope_code_rename',{...req,apply:true,planId:preview.planId});assert.equal(stale.isError,true);
 assert.match(readFileSync(join(h.repo,'src','a.ts'),'utf8'),/function add/);
 await h.command('code off');assert.equal((await h.call('envelope_code_rename',req)).isError,true);
 const outside=fixture(t,{mode:'outside'});assert.equal((await outside.call('envelope_code_rename',req)).isError,true);
 const no=fixture(t,{configured:false});assert.equal((await no.call('envelope_code_rename',req)).isError,true);
});
test('malformed or timed-out LSP produces UNVERIFIED without claiming success',async t=>{
 const h=fixture(t,{mode:'unchanged'});assert.equal(body(await h.call('envelope_code_lsp_verify',{path:'src/a.ts'})).verdict,'UNVERIFIED');
});

test('unreliable language-server diagnostics cannot masquerade as PASS',async t=>{
 const infra=fixture(t,{mode:'infra'});const out=body(await infra.call('envelope_code_lsp_verify',{path:'src/a.ts'}));
 assert.equal(out.verdict,'UNVERIFIED');assert.ok(out.errorCount>0);
 const malformed=fixture(t,{mode:'bad-range'});assert.equal(body(await malformed.call('envelope_code_lsp_verify',{path:'src/a.ts'})).verdict,'UNVERIFIED');
});

test('rename apply is blocked when a different affected file has LSP errors',async t=>{
 const h=fixture(t,{mode:'errors-in-b'});
 const plan=body(await h.call('envelope_code_rename',req));
 await h.command('code rename on');
 const response=await h.call('envelope_code_rename',{...req,apply:true,planId:plan.planId});
 assert.equal(response.isError,true);assert.match(response.content[0].text,/src\/b\.ts.*FAIL/i);
 assert.match(readFileSync(join(h.repo,'src','a.ts'),'utf8'),/function add/);
 assert.match(readFileSync(join(h.repo,'src','b.ts'),'utf8'),/result=add/);
});
