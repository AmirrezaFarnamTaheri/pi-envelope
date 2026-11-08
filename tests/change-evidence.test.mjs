import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';
import { analyzeChangeImpact } from '../extensions/envelope/change-evidence.mjs';

function repo(t) {
  const root=mkdtempSync(join(tmpdir(),'envelope-change-impact-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...argv)=>{
    const r=spawnSync('git',argv,{cwd:root,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Envelope Test',GIT_COMMITTER_NAME:'Envelope Test',GIT_AUTHOR_EMAIL:'envelope@test.invalid',GIT_COMMITTER_EMAIL:'envelope@test.invalid'}});
    assert.equal(r.status,0,`${argv.join(' ')}: ${r.stderr}`);return r.stdout.trim();
  };
  const put=(file,body)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),body);};
  git('init','-q');
  put('src/math.ts','export function sum(a:number,b:number){return a+b}\n');
  put('src/app.ts',"import {sum} from './math';\nexport function use(){return sum(1,2)}\n");
  put('tests/math.test.ts',"import {sum} from '../src/math';\nexport const a=sum(1,2);\n");
  put('README.md','# Example\n');
  git('add','.');git('commit','-qm','base');
  const base=git('rev-parse','HEAD');
  put('src/math.ts','export function sum(a:number,b:number){return a-b}\nexport function extra(){return sum(3,2)}\n');
  git('add','.');git('commit','-qm','change math');
  const head=git('rev-parse','HEAD');
  const index=new CodeIndex(root,{ts});index.refresh();
  return {root,put,git,base,head,index};
}

test('pinned Git comparison reports verified new lines and bounded static import impact',t=>{
  const h=repo(t);
  const result=analyzeChangeImpact(h.index,{base:h.base,head:h.head,limit:10});
  assert.equal(result.base,h.base);assert.equal(result.head,h.head);
  assert.equal(result.complete,true);
  assert.equal(result.changed.length,1);
  assert.equal(result.changed[0].path,'src/math.ts');
  assert.equal(result.changed[0].status,'modified');
  assert.ok(result.changed[0].lineRanges.some(x=>x.start===1));
  assert.match(result.changed[0].contentSha256,/^[a-f0-9]{64}$/);
  assert.ok(result.impacted.some(x=>x.path==='src/app.ts'&&x.distance===1));
  assert.ok(result.candidateTests.some(x=>x.path==='tests/math.test.ts'));
  assert.match(result.notes,/not.*coverage|heuristic/i);
});

test('a dirty worktree or changed HEAD cannot produce false PR-head evidence',t=>{
  const h=repo(t);
  h.put('src/math.ts','export function sum(){return 42}\n');
  assert.throws(()=>analyzeChangeImpact(h.index,{base:h.base}),/clean|dirty|uncommitted/i);
  h.git('restore','src/math.ts');
  assert.throws(()=>analyzeChangeImpact(h.index,{base:h.base,head:h.base}),/HEAD|match|stale/i);
  assert.throws(()=>analyzeChangeImpact(h.index,{base:'../evil'}),/SHA|commit|invalid/i);
  assert.throws(()=>analyzeChangeImpact(h.index,{base:'f'.repeat(40)}),/commit|exist|unknown|invalid/i);
});

test('deletion, rename and non-source paths are explicit incomplete evidence, not fabricated call edges',t=>{
  const h=repo(t);
  h.git('mv','src/math.ts','src/maths.ts');
  h.git('rm','src/app.ts');
  h.put('docs/summary.md','hello');
  h.git('add','.');h.git('commit','-qm','rename and delete');
  h.index.refresh();
  const result=analyzeChangeImpact(h.index,{base:h.head,limit:2});
  assert.equal(result.complete,false);
  assert.ok(result.changed.some(x=>x.status==='deleted'&&x.path==='src/app.ts'));
  assert.ok(result.changed.some(x=>x.status==='renamed'&&x.previousPath==='src/math.ts'));
  assert.ok(result.incompleteReasons.includes('deleted-or-unindexed-source'));
  assert.ok(result.changed.some(x=>x.path==='docs/summary.md'));
  assert.equal(result.changed.some(x=>x.path.includes('..')),false);
});

test('unindexed symlink and unsupported sources never resolve into project files',t=>{
  const h=repo(t);
  symlinkSync('/etc/passwd',join(h.root,'src','external.ts'));
  h.git('add','src/external.ts');h.git('commit','-qm','symlink');
  h.index.refresh();
  const result=analyzeChangeImpact(h.index,{base:h.head});
  assert.equal(result.complete,false);
  assert.ok(result.incompleteReasons.includes('deleted-or-unindexed-source'));
  assert.ok(result.changed.some(x=>x.path==='src/external.ts'&&x.indexed===false));
});

test('unchanged cached files keep content hashes and changed Git HEAD invalidates old snapshots',t=>{
  const h=repo(t);
  const m=h.index.files.get('src/math.ts');
  assert.match(m.contentSha256,/^[a-f0-9]{64}$/);
  assert.equal(h.index.refresh().reparsed,0);
  const source=h.index.files.get('src/math.ts');
  h.put('README.md','# Another line\n');
  h.git('add','.');h.git('commit','-qm','docs');
  assert.equal(h.index.refresh().reparsed,0);
  assert.equal(h.index.files.get('src/math.ts').contentSha256,source.contentSha256);
});
