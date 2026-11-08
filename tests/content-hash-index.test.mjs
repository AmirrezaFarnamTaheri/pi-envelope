import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'envelope-hash-index-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'src'));
  const source=join(root,'src','main.ts');
  writeFileSync(source,'export function alpha() { return 3; }\n');
  assert.equal(spawnSync('git',['init','-q'],{cwd:root}).status,0);
  return {root,source,index:new CodeIndex(root,{ts})};
}

function git(root,...args){
  const result=spawnSync('git',['-c','user.name=Envelope Tests','-c','user.email=tests@example.invalid',...args],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}

test('timestamp-only churn reuses parsed symbols when bytes are identical',t=>{
  const {index,source}=fixture(t);
  assert.equal(index.refresh().reparsed,1);
  const previous=index.files.get('src/main.ts');
  const stat=statSync(source);
  utimesSync(source,new Date(stat.mtimeMs+9000),new Date(stat.mtimeMs+9000));
  const refresh=index.refresh();
  assert.equal(refresh.reparsed,0);
  assert.equal(refresh.reused,1);
  assert.equal(index.files.get('src/main.ts').contentSha256,previous.contentSha256);
  assert.equal(index.files.get('src/main.ts').symbols[0].name,'alpha');
});

test('unchanged files are reused across commit switches, with commit identity updated',t=>{
  const {root,index}=fixture(t);
  git(root,'add','.');git(root,'commit','-qm','initial');
  const first=index.refresh();
  assert.equal(first.reparsed,1);
  const sha=first.revision;
  writeFileSync(join(root,'README.md'),'# docs\n');
  git(root,'add','.');git(root,'commit','-qm','docs-only');
  const next=index.refresh();
  assert.notEqual(next.revision,sha);
  assert.equal(next.reparsed,0);
  assert.equal(next.reused,1);
  assert.equal(index.lookup('alpha').length,1);
});

test('same-length source change reparses even after resetting modification time',t=>{
  const {source,index}=fixture(t);
  index.refresh();
  const stamp=statSync(source);
  writeFileSync(source,'export function bravo() { return 3; }\n');
  utimesSync(source,new Date(stamp.mtimeMs),new Date(stamp.mtimeMs));
  const update=index.refresh();
  assert.equal(update.reparsed,1);
  assert.equal(index.lookup('alpha').length,0);
  assert.equal(index.lookup('bravo').length,1);
});
