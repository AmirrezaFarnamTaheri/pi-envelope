import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';
import { SymbolDeltaLedger } from '../extensions/envelope/symbol-delta.mjs';
import { registerCodeFeature } from '../extensions/envelope/code-api.mjs';

const sha = txt => createHash('sha256').update(txt).digest('hex');
function repo(t, sources = {}) {
  const root = mkdtempSync(join(tmpdir(), 'envelope-delta-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [p, code] of Object.entries(sources)) {
    const pieces = p.split('/');
    if (pieces.length > 1) mkdirSync(join(root, ...pieces.slice(0,-1)), { recursive:true });
    writeFileSync(join(root,p),code);
  }
  const index = new CodeIndex(root, { ts, maxFiles:40, maxBytesPerFile:100_000 });
  index.refresh();
  return {root,index, write:(p,text) => writeFileSync(join(root,p),text)};
}

test('explicit baseline does not save raw source and reports an unchanged version deterministically', t=>{
  const {index}=repo(t, {'src/main.ts':'export function greet() { return "SECRET_BASELINE_4721"; }\n'});
  const ledger=new SymbolDeltaLedger();
  assert.equal(ledger.status(index).captured,false);
  const baseline=ledger.capture(index);
  assert.equal(baseline.captured,true);
  assert.equal(baseline.files,1);
  assert.equal(baseline.symbols,1);
  assert.match(baseline.version,/^[a-f0-9]{64}$/);
  const result=ledger.compare(index);
  assert.equal(result.notModified,true);
  assert.equal(result.totalChanges,0);
  assert.equal(result.returned,0);
  assert.equal(result.complete,true);
  assert.doesNotMatch(JSON.stringify([baseline,result]),/SECRET_BASELINE_4721/);
  assert.equal(ledger.status(index).version,baseline.version);
  ledger.close();
  assert.equal(ledger.status(index).captured,false);
});

test('modifying a declaration body is precise, exposes only hashes and static importer blast radius',t=>{
  const {index,write}=repo(t,{
    'src/core.ts':'export function compute() { return 1; }\n',
    'src/use.ts':"import { compute } from './core';\nexport function run() { return compute(); }\n"
  });
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  write('src/core.ts','export function compute() { return 882233; /* PRIVATE_TOKEN_TO_NOT_ECHO */ }\n');
  index.refresh();
  const result=ledger.compare(index);
  assert.equal(result.notModified,false);
  assert.equal(result.totalChanges,1);
  assert.equal(result.items[0].change,'modified');
  assert.equal(result.items[0].path,'src/core.ts');
  assert.equal(result.items[0].symbol,'compute');
  assert.equal(result.items[0].precision,'ast-node-text-hash');
  assert.deepEqual(result.items[0].staticImporters,['src/use.ts']);
  assert.equal(result.items[0].staticImporterCount,1);
  assert.equal(result.complete,true);
  assert.equal(result.filesWithoutAttributedDeclarationChanges,0);
  assert.doesNotMatch(JSON.stringify(result),/882233|PRIVATE_TOKEN_TO_NOT_ECHO|return 882233/);
});

test('comments and line shifts outside a declaration do not fabricate a modified symbol',t=>{
  const {index,write}=repo(t,{'src/core.ts':'export function run(){return 1;}\n'});
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  write('src/core.ts','// new comment\n\nexport function run(){return 1;}\n');
  index.refresh();
  const result=ledger.compare(index);
  assert.equal(result.notModified,true);
  assert.equal(result.totalChanges,0);
  assert.equal(result.filesWithByteChanges,1);
  assert.equal(result.filesWithoutAttributedDeclarationChanges,1);
  assert.equal(result.complete,false);
  assert.ok(result.reasons.includes('file-bytes-changed-without-attributed-declaration'));
});

test('added and removed symbols are identified by stable name and kind rather than line number',t=>{
  const {index,write}=repo(t,{'src/api.ts':'export function oldApi(){return 1;}\nexport function keep(){return 2;}'});
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  write('src/api.ts','\nexport function keep(){return 2;}\nexport function newApi(){return 3;}');
  index.refresh();
  const report=ledger.compare(index);
  assert.equal(report.totalChanges,2);
  assert.deepEqual(report.items.map(x=>[x.change,x.symbol]).sort(),[['added','newApi'],['removed','oldApi']]);
});

test('budgeted pages are stable only for the same comparison version and bounded output',t=>{
  const {index,write}=repo(t,{'src/many.ts':'export const a=1;export const b=2;export const c=3;'});
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  write('src/many.ts','export const a=4;export const b=5;export const c=6;');index.refresh();
  const page=ledger.compare(index,{limit:1,maxChars:1200});
  assert.equal(page.totalChanges,3);
  assert.equal(page.returned,1);
  assert.equal(page.truncated,true);
  assert.equal(page.nextOffset,1);
  assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=1200);
  const next=ledger.compare(index,{offset:1,ifVersion:page.comparisonVersion,limit:1,maxChars:1200});
  assert.equal(next.returned,1);
  assert.notEqual(page.items[0].symbol,next.items[0].symbol);
  assert.throws(()=>ledger.compare(index,{offset:1,limit:1}),/version|cursor/i);
  write('src/many.ts','export const a=10;export const b=5;export const c=6;');index.refresh();
  assert.throws(()=>ledger.compare(index,{offset:1,ifVersion:page.comparisonVersion}),/stale|version/i);
});

test('Python and Go unchanged identities are uncertain, not falsely precise, after file changes',t=>{
  const root=mkdtempSync(join(tmpdir(),'envelope-delta-python-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path='mod.py',before='def verify():\n    return True\n',after='def verify():\n    return False\n';
  writeFileSync(join(root,path),before);
  const file={path,language:'python',symbols:[{path,name:'verify',kind:'function',line:1,column:1}],contentSha256:sha(before)};
  const index={root,files:new Map([[path,file]]),checkedPath:p=>p,lastRefresh:{unavailable:[]},maxFiles:40};
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  writeFileSync(join(root,path),after);
  index.files.set(path,{...file,contentSha256:sha(after)});
  const out=ledger.compare(index);
  assert.equal(out.totalChanges,1);
  assert.equal(out.items[0].change,'uncertain');
  assert.equal(out.items[0].precision,'file-hash-only');
  assert.equal(out.complete,false);
  assert.ok(out.reasons.includes('symbol-body-precision-unavailable'));
});

test('source changing without CodeIndex refresh is rejected rather than returning stale evidence',t=>{
  const {index,write}=repo(t,{'src/a.ts':'export function x(){return 1}'});
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  write('src/a.ts','export function x(){return 2}');
  assert.throws(()=>ledger.compare(index),/changed since|refresh|hash/i);
  assert.equal(ledger.status(index).captured,true);
});

test('a source swapped to a symlink cannot be reported as an ordinary deletion',t=>{
  const {root,index}=repo(t,{'src/a.ts':'export function x(){return 1}'});
  const other=mkdtempSync(join(tmpdir(),'envelope-outside-'));
  t.after(()=>rmSync(other,{recursive:true,force:true}));
  writeFileSync(join(other,'out.ts'),'export const secret = 6;');
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  unlinkSync(join(root,'src/a.ts'));
  symlinkSync(join(other,'out.ts'),join(root,'src/a.ts'));
  index.refresh();
  assert.throws(()=>ledger.compare(index),/symlink|unsafe|outside/i);
});

test('duplicate symbol identities cannot be asserted to be uniquely changed',t=>{
  const {index,write}=repo(t,{'src/dupe.ts':'export function overloaded(a:string){return a;}\nexport function overloaded(a:number){return a;}'});
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  write('src/dupe.ts','export function overloaded(a:string){return a;}\nexport function overloaded(a:number){return a+1;}');
  index.refresh();
  const out=ledger.compare(index);
  assert.ok(out.items.some(x=>x.change==='uncertain'));
  assert.equal(out.complete,false);
  assert.ok(out.reasons.includes('duplicate-symbol-identity'));
});

test('invalid budget, impossible cursor and project mismatches reject without mutating baselines',t=>{
  const a=repo(t,{'a.ts':'export const a=1;'}),b=repo(t,{'b.ts':'export const b=2;'});
  const ledger=new SymbolDeltaLedger();ledger.capture(a.index);
  assert.throws(()=>ledger.compare(a.index,{maxChars:30}),/budget|maxChars/i);
  assert.throws(()=>ledger.compare(a.index,{limit:0}),/limit/i);
  assert.throws(()=>ledger.compare(a.index,{offset:-1}),/offset/i);
  assert.throws(()=>ledger.compare(b.index),/baseline|capture/i);
  assert.equal(ledger.status(b.index).captured,false);
  assert.equal(ledger.clear(a.index).captured,false);
  assert.throws(()=>ledger.compare(a.index),/baseline|capture/i);
});

test('Pi registers one delta tool on the existing CodeIndex without a second hook',async t=>{
  const {root}=repo(t,{'src/a.ts':'export function value(){return 1;}'});
  const tools=new Map(),events=[];
  registerCodeFeature({registerTool:x=>tools.set(x.name,x),on:name=>events.push(name)},
    {project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,languagesEnabled:false,treeEnabled:false}}),loadCompiler:()=>ts});
  const tool=tools.get('envelope_code_delta');
  assert.ok(tool);
  assert.deepEqual(tool.parameters.properties.action.enum,['status','capture','compare','clear']);
  const ctx={cwd:root};
  const before=await tool.execute('1',{action:'status'},null,null,ctx);
  assert.equal(JSON.parse(before.content[0].text).captured,false);
  const cap=await tool.execute('2',{action:'capture'},null,null,ctx);
  assert.equal(cap.isError,false);
  const cmp=await tool.execute('3',{action:'compare'},null,null,ctx);
  assert.equal(JSON.parse(cmp.content[0].text).notModified,true);
  assert.equal(events.length,0,'registerCodeFeature must not register Pi lifecycle hooks');
});

test('import-only edits stay visible as unattributed file changes rather than proof of no difference',t=>{
  const {index,write}=repo(t,{
    'src/a.ts':"import { x } from './b';\nexport function app(){return 1;}\n",
    'src/b.ts':'export const x=1;',
    'src/c.ts':'export const y=1;',
  });
  const ledger=new SymbolDeltaLedger();ledger.capture(index);
  write('src/a.ts',"import { y } from './c';\nexport function app(){return 1;}\n");index.refresh();
  const diff=ledger.compare(index);
  assert.equal(diff.notModified,true,'unchanged declaration body should not be called modified');
  assert.equal(diff.filesWithoutAttributedDeclarationChanges,1);
  assert.equal(diff.complete,false,'changed import relationship must not be hidden by an empty symbol delta');
});
