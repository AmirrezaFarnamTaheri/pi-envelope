import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutputStore } from '../extensions/envelope/store.mjs';
import { splitOutputSections, rankFragments } from '../extensions/envelope/output-fragments.mjs';

const text=['# Build','status: compiling','success', '# Tests','ALERT: task failed at src/main.ts:42', 'failure code 7', '# Notes','no regressions'].join('\n');

test('section-aware chunks preserve exact, grounded line locations and headings',()=>{
  const chunks=splitOutputSections(text,{maxChars:90});
  assert.ok(chunks.length>=3);
  assert.deepEqual(chunks.map(c=>c.lineStart),[1,4,7]);
  assert.match(chunks[1].text,/ALERT: task failed/);
  assert.equal(chunks[1].lineEnd,6);
});

test('bounded ranking orders matching chunks but never fabricates a semantic or token score',()=>{
  const chunks=splitOutputSections(text,{maxChars:90});
  const out=rankFragments(chunks,'task failed',{limit:2});
  assert.equal(out.length,1);
  assert.equal(out[0].lineStart,4);
  assert.ok(out[0].preview.length<=400);
  assert.equal(Object.hasOwn(out[0],'tokensSaved'),false);
});

test('stored fragment retrieval is exact-ID anchored and project-scoped',t=>{
  const folder=mkdtempSync(join(tmpdir(),'envelope-fragments-'));
  const store=new OutputStore(join(folder,'data'));
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  const a=store.save({text,project:'/a'}),b=store.save({text,project:'/b'});
  const matches=store.searchFragments('task failed',{project:'/a',limit:2});
  assert.equal(matches.length,1);
  assert.equal(matches[0].id,a.id);
  assert.equal(matches[0].lineStart,4);
  assert.equal(matches[0].lineEnd,6);
  assert.match(matches[0].preview,/task failed/);
  assert.equal(matches[0].id===b.id,false);
  assert.equal(store.retrieve(a.id).text,text);
  assert.deepEqual(store.searchFragments('anything absent',{project:'/a'}),[]);
});

test('huge output and malicious queries stay within fixed model-visible limits',t=>{
  const folder=mkdtempSync(join(tmpdir(),'envelope-fragments-bound-'));
  const store=new OutputStore(join(folder,'data'));
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  store.save({text:'# Massive\n'+'urgent failure '.repeat(3000),project:'/a'});
  const out=store.searchFragments('urgent failure',{project:'/a',limit:5});
  assert.ok(out.length<=5);
  assert.ok(JSON.stringify(out).length<5000);
  assert.deepEqual(store.searchFragments('" OR *',{project:'/a'}),[]);
});
