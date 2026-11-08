import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';
import { planRename, applyRename } from '../extensions/envelope/rename-transaction.mjs';
const req={path:'src/a.ts',line:1,column:17,newName:'multiply'};
function setup(t){
  const root=mkdtempSync(join(tmpdir(),'envelope-rename-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'src','a.ts'),'export function add(n: number) { return n + 1; }\r\n');
  writeFileSync(join(root,'src','b.ts'),"import { add } from './a';\nexport const result = add(2);\n");
  assert.equal(spawnSync('git',['init','-q'],{cwd:root}).status,0);
  const index=new CodeIndex(root,{ts,maxFiles:100,maxBytesPerFile:512_000});index.refresh();
  const uri=(file)=>pathToFileURL(join(root,'src',file)).href;
  const range=(line,start,end)=>({start:{line,character:start},end:{line,character:end}});
  const edits={changes:{[uri('a.ts')]:[{range:range(0,16,19),newText:'multiply'}],
    [uri('b.ts')]:[{range:range(0,9,12),newText:'multiply'},{range:range(1,22,25),newText:'multiply'}]}};
  return {root,index,uri,range,edits,lockRoot:join(root,'state')};
}

test('previews sorted, UTF-16-positioned edits across files without writing', t=>{
  const {root,index,edits}=setup(t);const before=readFileSync(join(root,'src','a.ts'),'utf8');
  const plan=planRename({index,workspaceEdit:edits,request:req});
  assert.equal(plan.files.length,2);assert.equal(plan.changeCount,3);
  assert.match(plan.files[0].proposedText,/function multiply/);
  assert.match(plan.files[0].proposedText,/\r\n$/);
  assert.match(plan.files[1].proposedText,/result = multiply\(2\)/);
  assert.match(plan.id,/^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(root,'src','a.ts'),'utf8'),before);
});
test('applies only a fingerprint-matched plan, and rejects stale source files',t=>{
  const {root,index,edits,lockRoot}=setup(t);
  const plan=planRename({index,workspaceEdit:edits,request:req});
  assert.throws(()=>applyRename({index,plan,lockRoot,expectedId:'0'.repeat(64)}),/fingerprint|plan/i);
  writeFileSync(join(root,'src','b.ts'),"import { add } from './a';\nconst changed = add(2);\n");
  assert.throws(()=>applyRename({index,plan,lockRoot,expectedId:plan.id}),/changed|stale/i);
  assert.match(readFileSync(join(root,'src','a.ts'),'utf8'),/function add/);
});
test('successful apply updates both paths, with unchanged text and preserved line endings',t=>{
  const {root,index,edits,lockRoot}=setup(t);
  const plan=planRename({index,workspaceEdit:edits,request:req});
  const result=applyRename({index,plan,lockRoot,expectedId:plan.id});
  assert.equal(result.applied,true);assert.equal(result.files.length,2);
  assert.match(readFileSync(join(root,'src','a.ts'),'utf8'),/function multiply\(n: number\).+\r\n$/);
  assert.match(readFileSync(join(root,'src','b.ts'),'utf8'),/result = multiply/);
});
test('rejects unsafe workspace edits: traversal, file operations, overlapping edits, out-of-bounds and syntax damage',t=>{
  const {root,index,edits,uri,range}=setup(t);
  const outside=pathToFileURL(join(root,'..','outside-rename.ts')).href;
  assert.throws(()=>planRename({index,request:req,workspaceEdit:{changes:{[outside]:[{range:range(0,0,1),newText:'bad'}]}}}),/outside|indexed|project/i);
  assert.throws(()=>planRename({index,request:req,workspaceEdit:{documentChanges:[{kind:'create',uri:uri('c.ts')}]}}),/file operation|unsupported/i);
  assert.throws(()=>planRename({index,request:req,workspaceEdit:{changes:{[uri('a.ts')]:[edits.changes[uri('a.ts')][0],edits.changes[uri('a.ts')][0]]}}}),/overlap|duplicate/i);
  assert.throws(()=>planRename({index,request:req,workspaceEdit:{changes:{[uri('a.ts')]:[{range:range(5,0,1),newText:'multiply'}]}}}),/range|line/i);
  assert.throws(()=>planRename({index,request:req,workspaceEdit:{changes:{[uri('a.ts')]:[{range:range(0,16,19),newText:'('}]}}}),/non-identifier|syntax/i);
  assert.throws(()=>planRename({index,request:{...req,newName:'class'},workspaceEdit:edits}),/identifier|keyword/i);
});
test('rejects a symlink alias or a file not in the shared source index',t=>{
  const {root,index,edits,uri,range}=setup(t);
  symlinkSync(join(root,'src','a.ts'),join(root,'src','alias.ts'));
  assert.throws(()=>planRename({index,request:req,workspaceEdit:{changes:{[uri('alias.ts')]:[{range:range(0,16,19),newText:'x'}]}}}),/symlink|indexed/i);
  mkdirSync(join(root,'node_modules','p'),{recursive:true});writeFileSync(join(root,'node_modules','p','hidden.ts'),'add');
  assert.throws(()=>planRename({index,request:req,workspaceEdit:{changes:{[pathToFileURL(join(root,'node_modules','p','hidden.ts')).href]:[{range:range(0,0,3),newText:'new'}]}}}),/indexed|ignored/i);
});
test('ordinary replacement failure rolls back all already touched files',t=>{
  const {root,index,edits,lockRoot}=setup(t);
  const plan=planRename({index,workspaceEdit:edits,request:req});
  const first=readFileSync(join(root,'src','a.ts'),'utf8');const second=readFileSync(join(root,'src','b.ts'),'utf8');
  let calls=0;
  assert.throws(()=>applyRename({index,plan,lockRoot,expectedId:plan.id,replaceFile(from,to){calls++;if(calls===2)throw Error('injected second rename failure');const {renameSync}=requireNative();renameSync(from,to);}}),/injected|rollback|failed/i);
  assert.equal(readFileSync(join(root,'src','a.ts'),'utf8'),first);
  assert.equal(readFileSync(join(root,'src','b.ts'),'utf8'),second);
});
function requireNative(){return {renameSync:(...a)=>nativeRename(...a)};}
import { renameSync as nativeRename } from 'node:fs';
test('refuses UTF-16 surrogate-splitting ranges without corrupting source',t=>{
  const {root,index,uri,range}=setup(t);
  writeFileSync(join(root,'src','a.ts'),'// emoji \ud83d\ude42\nexport function add() {}\n');index.refresh();
  assert.throws(()=>planRename({index,request:{...req,line:2},workspaceEdit:{changes:{[uri('a.ts')]:[{range:range(0,10,11),newText:'multiply'}]}}}),/surrogate/i);
});

test('documentChanges text edits work, but cursor in a comment or string cannot authorize rename',t=>{
 const {root,index,edits,uri}=setup(t);
 const documentChanges=Object.entries(edits.changes).map(([target,changes])=>({textDocument:{uri:target,version:null},edits:changes}));
 const plan=planRename({index,workspaceEdit:{documentChanges},request:req});assert.equal(plan.changeCount,3);
 writeFileSync(join(root,'src','a.ts'),'// add is a comment\nexport function add() {}\n');index.refresh();
 assert.throws(()=>planRename({index,workspaceEdit:edits,request:{...req,line:1,column:4}}),/source-code identifier|string or comment/i);
 writeFileSync(join(root,'src','a.ts'),'export const text = "add";\nexport function add() {}\n');index.refresh();
 assert.throws(()=>planRename({index,workspaceEdit:edits,request:{...req,line:1,column:22}}),/source-code identifier|string or comment/i);
});
test('an exclusive project rename lock prevents conflicting commits',t=>{
 const {root,index,edits,lockRoot}=setup(t);
 const plan=planRename({index,workspaceEdit:edits,request:req});
 const {createHash}=cryptoModules();const id=createHash('sha256').update(index.root).digest('hex');
 mkdirSync(join(lockRoot,id),{recursive:true});
 assert.throws(()=>applyRename({index,plan,lockRoot,expectedId:plan.id}),/already in progress/i);
 assert.match(readFileSync(join(root,'src','a.ts'),'utf8'),/function add/);
});
function cryptoModules(){return {createHash:hashAlgorithm};}
import { createHash as hashAlgorithm } from 'node:crypto';

test('rename refuses Python/Go files even when the shared index has opted in',t=>{
 const {root,index,uri,edits,range}=setup(t);
 writeFileSync(join(root,'src','unexpected.py'),'const add=1;\n');
 index.languagesEnabled=true;index.refresh();
 assert.ok(index.files.has('src/unexpected.py'),'Python source is in shared read-only code index');
 const pythonEdit={changes:{[uri('unexpected.py')]:[{range:range(0,6,9),newText:'multiply'}]}};
 assert.throws(()=>planRename({index,workspaceEdit:pythonEdit,request:{path:'src/unexpected.py',line:1,column:7,newName:'multiply'}}),/JS\/TS|JavaScript|TypeScript|unsupported/i);
 assert.throws(()=>planRename({index,workspaceEdit:{changes:{...edits.changes,...pythonEdit.changes}},request:req}),/JS\/TS|JavaScript|TypeScript|unsupported/i);
});
