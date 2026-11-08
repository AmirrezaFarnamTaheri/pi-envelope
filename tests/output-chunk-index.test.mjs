import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutputStore } from '../extensions/envelope/store.mjs';
import { splitIndexedChunks } from '../extensions/envelope/output-fragments.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'envelope-output-chunks-'));
  const home = join(root, 'output');
  const store = new OutputStore(home);
  t.after(() => {store.close();rmSync(root,{recursive:true,force:true});});
  return {root,home,store};
}

test('chunk search finds a co-located match even when 30 other outputs match only at the whole-body level', t => {
  const {store} = fixture(t);
  for (let i=0;i<32;i++) store.save({project:'/a',tool:'bash',text:`# First\nopaque_${i} amber signal\n# Other\nblue signal\n`});
  const target = store.save({project:'/a',tool:'bash',text:'# Intro\nordinary\n# Diagnosis\namber signal blue signal together\n'});
  const hits = store.searchFragments('amber blue',{project:'/a',limit:5});
  assert.equal(hits.length,1);
  assert.equal(hits[0].id,target.id);
  assert.equal(hits[0].lineStart,3);
  assert.match(hits[0].preview,/amber signal blue/);
  assert.equal(store.retrieve(target.id).text,'# Intro\nordinary\n# Diagnosis\namber signal blue signal together\n');
});

test('indexing is incremental and reopening does not duplicate chunk rows', t => {
  const {store,home} = fixture(t);
  const a=store.save({project:'/a',text:'# Tests\nfirst error\n# Notes\nimportant xyz\n'});
  const initial=store.chunkIndexStatus('/a');
  assert.equal(initial.pending,0);
  assert.equal(initial.indexed,1);
  assert.ok(initial.chunks>=2);
  store.save({project:'/a',text:'# Tests\nfirst error\n# Notes\nimportant xyz\n'});
  assert.deepEqual(store.chunkIndexStatus('/a'),initial);
  store.close();
  const resumed=new OutputStore(home);
  t.after(()=>resumed.close());
  assert.deepEqual(resumed.chunkIndexStatus('/a'),initial);
  assert.equal(resumed.searchFragments('important xyz',{project:'/a'}).at(0)?.id,a.id);
});

test('new chunk index backfills legacy raw outputs in bounded batches without changing their IDs', t => {
  const {store}=fixture(t);
  const old=[];
  for(let i=0;i<11;i++) old.push(store.save({project:'/a',text:`# Other\nlegacy_${i} apple term\n`}).id);
  store.db.exec('DELETE FROM output_chunks_fts; DELETE FROM output_chunks_state;');
  assert.equal(store.chunkIndexStatus('/a').pending,11);
  const report=store.searchFragmentsReport('apple',{project:'/a',limit:20});
  assert.equal(report.index.partial,true);
  assert.equal(report.index.pending,3);
  assert.equal(report.hits.length,8);
  assert.equal(store.chunkIndexStatus('/a').indexed,8);
  const next=store.searchFragmentsReport('apple',{project:'/a',limit:20});
  assert.equal(next.index.partial,false);
  assert.equal(next.index.pending,0);
  assert.equal(next.hits.length,11);
  assert.deepEqual(new Set(next.hits.map(h=>h.id)),new Set(old));
});

test('explicit output erasure and pruning remove chunk index text and metadata', t=>{
  const {store}=fixture(t);
  const a=store.save({project:'/a',text:'DELETE_ME signal signal'});
  const b=store.save({project:'/b',text:'DELETE_ME signal signal'});
  assert.equal(store.erase({project:'/b',id:a.id}),false);
  assert.equal(store.erase({project:'/a',id:a.id}),true);
  assert.deepEqual(store.searchFragments('DELETE_ME',{project:'/a'}),[]);
  assert.equal(store.chunkIndexStatus('/a').chunks,0);
  assert.equal(store.searchFragments('DELETE_ME',{project:'/b'})[0].id,b.id);
  store.db.prepare('UPDATE outputs SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',b.id);
  assert.equal(store.prune({project:'/b',before:'2022-01-01T00:00:00.000Z'}).deleted,1);
  assert.equal(store.chunkIndexStatus('/b').chunks,0);
});

test('corrupt stored output never leaks stale chunk text, while other valid results survive', t=>{
  const {store}=fixture(t);
  const corrupted=store.save({project:'/a',text:'critical warp signal'});
  const intact=store.save({project:'/a',text:'critical warp diagnostic remains'});
  writeFileSync(store.objectPath(corrupted.id),'poisoned');
  const hits=store.searchFragments('critical warp',{project:'/a'});
  assert.deepEqual(hits.map(h=>h.id),[intact.id]);
  assert.doesNotMatch(JSON.stringify(hits),/signal|poisoned/);
});

test('chunk-index failures never prevent exact output persistence or recall', t=>{
  const {store}=fixture(t);
  const index=store.indexOutputChunks;
  store.indexOutputChunks=()=>{throw new Error('disk full');};
  const saved=store.save({project:'/a',text:'index unavailable original content'});
  assert.equal(store.retrieve(saved.id).text,'index unavailable original content');
  assert.equal(store.chunkIndexStatus('/a').pending,1);
  store.indexOutputChunks=index.bind(store);
  assert.equal(store.searchFragments('index unavailable',{project:'/a'}).length,1);
  assert.equal(store.chunkIndexStatus('/a').pending,0);
});

test('each indexed long line stays within a fixed chunk budget, preserving Unicode and its exact line',()=>{
  const value='# Logs\n'+'🚀'+('ab'.repeat(1400))+'END\n# Next\nokay';
  const chunks=splitIndexedChunks(value);
  assert.ok(chunks.length>3);
  assert.ok(chunks.every(x=>Array.from(x.text).length<=1400));
  assert.ok(chunks.some(x=>x.text.includes('END')&&x.lineStart===2));
  assert.ok(chunks.some(x=>x.text.includes('🚀')));
  assert.equal(chunks.at(-1).lineStart,3);
});

test('tool search remains bounded, read-only in returned text, and enforces project scope',t=>{
  const {store}=fixture(t);
  for(let i=0;i<40;i++)store.save({project:'/b',text:`Confidential ${i}: marker bloom`});
  const mine=store.save({project:'/a',text:'marker bloom visible'});
  const found=store.searchFragments('marker bloom',{project:'/a',limit:25});
  assert.equal(found.length,1);
  assert.equal(found[0].id,mine.id);
  assert.deepEqual(store.searchFragments('" OR *',{project:'/a'}),[]);
  assert.ok(Buffer.byteLength(JSON.stringify(found))<5000);
});

test('Pi fragment tool reports incomplete legacy backfill without revealing raw query or other projects',async t=>{
  const {root}=fixture(t);
  const {default:registerEnvelope}=await import('../extensions/envelope/index.mjs');
  const tools=new Map(),commands=new Map(),events=[];
  const pi={cwd:'/a',on(n,fn){events.push(n);},registerTool(x){tools.set(x.name,x);},registerCommand(n,x){commands.set(n,x);},logger:{warn(){}}};
  const ext=registerEnvelope(pi,{home:join(root,'envelope')});
  t.after(()=>ext.close());
  const internal=new OutputStore(join(root,'envelope','envelope-output'));
  t.after(()=>internal.close());
  for(let i=0;i<12;i++)internal.save({project:'/a',text:`# Logs\n${i} confidential marker bloom`});
  internal.db.exec('DELETE FROM output_chunks_fts; DELETE FROM output_chunks_state;');
  const tool=tools.get('envelope_search_fragments');
  assert.ok(tool);
  assert.equal(events.filter(n=>n==='context').length,1);
  const result=await tool.execute('call',{query:'marker bloom',limit:25},undefined,undefined,{cwd:'/a'});
  assert.equal(result.isError,false);
  assert.equal(JSON.parse(result.content[0].text).length,8);
  assert.equal(result.details.chunkIndex.partial,true);
  assert.equal(result.details.chunkIndex.pending,4);
  assert.doesNotMatch(JSON.stringify(result.details),/confidential|\/a|marker bloom/);
  const second=await tool.execute('call',{query:'marker bloom',limit:25},undefined,undefined,{cwd:'/a'});
  assert.equal(second.details.chunkIndex.partial,false);
  assert.equal(JSON.parse(second.content[0].text).length,12);
});

test('a match near the end of a long chunk is visible in the bounded preview',t=>{
  const {store}=fixture(t);
  store.save({project:'/a',text:'# Output\n'+'padding '.repeat(120)+'fatal_unique_identifier crash details at end'});
  const hits=store.searchFragments('fatal_unique_identifier crash',{project:'/a'});
  assert.equal(hits.length,1);
  assert.match(hits[0].preview,/fatal_unique_identifier crash/);
  assert.ok(Array.from(hits[0].preview).length<=325);
});

test('a capped candidate list is reported as partial rather than falsely complete',t=>{
  const {store}=fixture(t);
  for(let i=0;i<215;i++)store.save({project:'/a',text:`log ${i}: repeatable batch match`});
  const report=store.searchFragmentsReport('repeatable batch',{project:'/a',limit:4});
  assert.equal(report.hits.length,4);
  assert.equal(report.index.candidateLimited,true);
  assert.equal(report.index.partial,true);
  assert.equal(report.index.pending,0);
});

test('candidate verification is bounded in both distinct outputs and raw bytes',t=>{
  const {store}=fixture(t);
  for(let i=0;i<60;i++)store.save({project:'/a',text:`check_${i} one shared failure`});
  const report=store.searchFragmentsReport('shared failure',{project:'/a',limit:25});
  assert.equal(report.index.pending,0);
  assert.equal(report.index.verificationLimited,true);
  assert.equal(report.index.partial,true);
  assert.ok(report.hits.length<=25);
});

test('a poisoned FTS chunk row is never returned without agreement from the verified original',t=>{
  const {store}=fixture(t);
  const source=store.save({project:'/a',text:'safe original with no panic'});
  store.db.prepare('UPDATE output_chunks_fts SET text=? WHERE id=?').run('injected panic marker',source.id);
  assert.deepEqual(store.searchFragments('injected panic',{project:'/a'}),[]);
  assert.equal(store.retrieve(source.id).text,'safe original with no panic');
});
