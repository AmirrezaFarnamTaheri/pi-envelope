import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';

function fixture(t,{git=true}={}) {
  const root=mkdtempSync(join(tmpdir(),'envelope-code-index-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'src','math.ts'),`export function add(a: number, b: number) { return a+b; }\nexport class Calculator {\n  addOne(n: number) { return add(n, 1); }\n}\n`);
  writeFileSync(join(root,'src','feature.ts'),`import { add } from './math';\nexport function feature() { return add(1, 2); }\n`);
  writeFileSync(join(root,'src','api.ts'),`export { feature } from './feature';\nexport interface Service { run(): void }\n`);
  writeFileSync(join(root,'src','dynamic.ts'),`export function unrelated() { return 'add'; }\n`);
  mkdirSync(join(root,'node_modules','secret'),{recursive:true});
  writeFileSync(join(root,'node_modules','secret','secrets.ts'), 'export const PASSWORD="secret";');
  mkdirSync(join(root,'ignored'));
  writeFileSync(join(root,'ignored','private.ts'),'export const SECRET=1;');
  writeFileSync(join(root,'.gitignore'),'node_modules/\nignored/\n');
  const outside=join(root,'..','outside-ts-'+process.pid+'-'+Date.now()+'.ts');
  writeFileSync(outside,'export const Outside = 1;');
  t.after(()=>rmSync(outside,{force:true}));
  symlinkSync(outside,join(root,'src','external.ts'));
  if(git) {
    const result=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
  return {root,index:new CodeIndex(root,{ts,maxFiles:100,maxBytesPerFile:2048})};
}

test('indexes symbol declarations with grounded locations, kinds and methods', (t)=>{
  const {index}=fixture(t);const stats=index.refresh();
  assert.equal(stats.files,4);
  const add=index.lookup('add');
  assert.ok(add.some(x=>x.path==='src/math.ts' && x.name==='add' && x.kind==='function' && x.line===1));
  const method=index.lookup('addOne');
  assert.equal(method.length,1);
  assert.equal(method[0].container,'Calculator');
  assert.equal(method[0].line,3);
  assert.equal(index.lookup('Calculator')[0].kind,'class');
  assert.equal(index.lookup('Service')[0].kind,'interface');
  assert.equal(index.lookup('PASSWORD').length,0);
  assert.equal(index.lookup('SECRET').length,0);
});

test('resolves direct and transitive relative importers without claiming dynamic call relationships', (t)=>{
  const {index}=fixture(t);index.refresh();
  const impact=index.impact('src/math.ts',{depth:3});
  assert.deepEqual(impact.importers.map(x=>[x.path,x.distance]),[['src/feature.ts',1],['src/api.ts',2]]);
  assert.equal(impact.mode,'static-imports');
  assert.ok(!impact.importers.some(x=>x.path==='src/dynamic.ts'));
  const noImpact=index.impact('src/dynamic.ts');
  assert.deepEqual(noImpact.importers,[]);
});

test('produces a token-bounded repository overview ranked by dependency importance', (t)=>{
  const {index}=fixture(t);index.refresh();
  const info=index.overview({limit:2});
  assert.equal(info.files,4);
  assert.equal(info.topFiles.length,2);
  assert.equal(info.topFiles[0].path,'src/math.ts');
  assert.ok(info.symbols>=6);
  assert.ok(info.topFiles[0].symbols <= info.symbols);
});

test('verifies parse-time diagnostics of proposed source without writing to disk', (t)=>{
  const {index,root}=fixture(t);index.refresh();
  const original=readFileSync(join(root,'src','math.ts'),'utf8');
  const good=index.verify('src/math.ts');
  assert.equal(good.ok,true);
  assert.deepEqual(good.diagnostics,[]);
  const bad=index.verify('src/math.ts',{content:'export function broken( {\n'});
  assert.equal(bad.ok,false);
  assert.ok(bad.diagnostics.length>0);
  assert.ok(bad.diagnostics[0].line>=1);
  assert.equal(readFileSync(join(root,'src','math.ts'),'utf8'),original);
});

test('refreshes stale file symbols and import edges when source changes', (t)=>{
  const {index,root}=fixture(t);index.refresh();
  writeFileSync(join(root,'src','feature.ts'),`export function newerName() { return 42; }\n`);
  const changed=index.refresh();
  assert.ok(changed.reparsed>=1);
  assert.ok(index.lookup('newerName').some(x=>x.path==='src/feature.ts'));
  assert.equal(index.lookup('feature').some((symbol)=>symbol.name==='feature'),false);
  assert.deepEqual(index.impact('src/math.ts').importers,[]);
});

test('rejects traversal, symlinks and ignored locations and honors no-git fallback', (t)=>{
  const {index}=fixture(t,{git:false});index.refresh();
  assert.throws(()=>index.verify('../outside.ts'),/outside|project|path/i);
  assert.throws(()=>index.verify('src/external.ts'),/symlink|indexed|allowed/i);
  assert.throws(()=>index.verify('ignored/private.ts'),/indexed|allowed|ignored/i);
  assert.throws(()=>index.impact('../../escape'),/outside|project|path/i);
  assert.ok(index.lookup('Calculator').length>0);
});

test('skips giant files and honors a fixed maximum file count', (t)=>{
  const {root}=fixture(t);
  writeFileSync(join(root,'src','oversized.ts'),`export const massive = '${'x'.repeat(3000)}'`);
  const idx=new CodeIndex(root,{ts,maxFiles:2,maxBytesPerFile:512});
  const stats=idx.refresh();
  assert.ok(stats.files<=2);
  assert.equal(idx.lookup('massive').length,0);
});

test('relative imports escaping project root never become fabricated graph edges', (t)=>{
  const {index,root}=fixture(t);
  writeFileSync(join(root,'root.ts'),'export function root() { return 1; }\n');
  writeFileSync(join(root,'src','danger.ts'),"import { root } from '../../../../root';\nexport const attempt = root;\n");
  index.refresh();
  assert.deepEqual(index.impact('root.ts').importers,[]);
});


test('discovery advertises truncation when excluded language files consume the raw source cap', t=>{
 const {root}=fixture(t);
 for(let i=0;i<5;i++)writeFileSync(join(root,'src','a'+i+'.py'),'def unused(): pass\n');
 const capped=new CodeIndex(root,{ts,maxFiles:5,maxBytesPerFile:2048});
 const result=capped.refresh();
 assert.ok(capped.files.size<5,'Python candidates were filtered after discovery');
 assert.equal(result.discoveryTruncated,true,'cap must describe all source candidates, not only indexed TS files');
 assert.equal(capped.languageStatus().discoveryTruncated,true);
});

test('fallback directory traversal exposes truncation even with filtered language candidates',t=>{
 const {root}=fixture(t,{git:false});
 for(let i=0;i<5;i++)writeFileSync(join(root,'src','a'+i+'.py'),'def unused(): pass\n');
 const capped=new CodeIndex(root,{ts,maxFiles:5,maxBytesPerFile:2048});
 const result=capped.refresh();
 assert.equal(result.discoveryTruncated,true);
});
