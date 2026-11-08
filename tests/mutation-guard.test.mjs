import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {guardMutation} from '../extensions/envelope/mutation-guard.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';

function project(t){const root=mkdtempSync(join(tmpdir(),'envelope-mutation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'src'));writeFileSync(join(root,'src','main.ts'),'export function a() { return 1; }\nexport function b() { return 2; }\n');return root;}

test('blocks malformed JS/TS write before touching the file, with bounded coordinates',async t=>{
 const cwd=project(t), input={path:'src/main.ts',content:'export function a( {'};
 const found=await guardMutation('write',input,cwd,ts);
 assert.equal(found.block,true);assert.match(found.reason,/syntax/i);assert.match(found.reason,/line \d+/i);assert.ok(found.reason.length<=900);
 assert.match(readFileSync(join(cwd,'src','main.ts'),'utf8'),/return 1/);
 assert.equal(await guardMutation('write',{path:'src/main.ts',content:'export const good = 1;'},cwd,ts),undefined);
});

test('evaluates Pi multi-edit batches in original-file coordinates before blocking',async t=>{
 const cwd=project(t);
 const bad={path:'src/main.ts',edits:[{oldText:'return 1;',newText:'return (1;'}, {oldText:'return 2;',newText:'return 22;'}]};
 assert.equal((await guardMutation('edit',bad,cwd,ts)).block,true);
 const good={path:'src/main.ts',edits:[{oldText:'return 1;',newText:'return 11;'}, {oldText:'return 2;',newText:'return 22;'}]};
 assert.equal(await guardMutation('edit',good,cwd,ts),undefined);
 assert.match(readFileSync(join(cwd,'src','main.ts'),'utf8'),/return 1/);
});

test('fails open for unsupported/ambiguous previews and pre-existing parse errors',async t=>{
 const cwd=project(t);
 assert.equal(await guardMutation('write',{path:'notes.md',content:'broken {'},cwd,ts),undefined);
 assert.equal(await guardMutation('edit',{path:'src/main.ts',edits:[{oldText:'not-there',newText:'('}]},cwd,ts),undefined);
 assert.equal(await guardMutation('edit',{path:'src/main.ts',edits:[{oldText:'return',newText:'('}]},cwd,ts),undefined);
 assert.equal(await guardMutation('write',{path:'src/main.ts',content:'invalid ('},cwd,null),undefined);
 writeFileSync(join(cwd,'src','main.ts'),'export function a( {');
 assert.equal(await guardMutation('edit',{path:'src/main.ts',edits:[{oldText:'a(',newText:'a('}]},cwd,ts),undefined);
});

test('default disabled, runtime toggle and error recovery in the Pi extension',async t=>{
 const cwd=project(t);const hooks=new Map(),commands=new Map();const info=[];
 const pi={cwd,on(name,fn){hooks.set(name,[...(hooks.get(name)||[]),fn]);},registerTool(){},registerCommand(name,c){commands.set(name,c);},logger:{warn(){}}};
 const ext=registerEnvelope(pi,{home:join(cwd,'state'),loadCompiler:async()=>ts});
 const ctx={cwd,ui:{notify:(x)=>info.push(x)},sessionManager:{getSessionId:()=> 's'}};
 const hook=hooks.get('tool_call').at(-1);
 const input={toolName:'write',input:{path:'src/main.ts',content:'export function a( {'}};
 assert.equal(await hook(input,ctx),undefined);
 await commands.get('envelope').handler('code guard on',ctx);
 assert.equal((await hook(input,ctx)).block,true);
 await commands.get('envelope').handler('code off',ctx);
 assert.equal(await hook(input,ctx),undefined);
 await commands.get('envelope').handler('code on',ctx);
 assert.equal((await hook(input,ctx)).block,true);
 await commands.get('envelope').handler('code guard off',ctx);
 assert.equal(await hook(input,ctx),undefined);
 ext.close();
});
