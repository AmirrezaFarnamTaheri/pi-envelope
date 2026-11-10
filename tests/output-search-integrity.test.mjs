import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OutputStore} from '../extensions/envelope/store.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'envelope-search-audit-'));
  const store=new OutputStore(join(home,'store'));
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  return store;
}

test('whole-output search skips deleted original files rather than leaking stale FTS excerpts',t=>{
  const store=fixture(t);
  const {id}=store.save({text:'sentinel_checkout_marker confidential output',project:'/repo/a',tool:'bash'});
  assert.equal(store.search('sentinel_checkout_marker',{project:'/repo/a'}).length,1);
  rmSync(store.objectPath(id));
  assert.deepEqual(store.search('sentinel_checkout_marker',{project:'/repo/a'}),[]);
});

test('whole-output search rejects corrupted originals, preserving valid matches',t=>{
  const store=fixture(t);
  const broken=store.save({text:'sealed_token_U9 unique marker',project:'/repo/a',tool:'bash'});
  const good=store.save({text:'unique marker verified result',project:'/repo/a',tool:'bash'});
  writeFileSync(store.objectPath(broken.id),'tampered text');
  const hits=store.search('unique marker',{project:'/repo/a'});
  assert.deepEqual(hits.map(x=>x.id),[good.id]);
  assert.doesNotMatch(JSON.stringify(hits),/sealed_token_U9/);
});

test('whole-output search refuses cross-project records with forged FTS project fields',t=>{
  const store=fixture(t);
  const foreign=store.save({text:'cross_scope_secret_AA import failure',project:'/repo/b',tool:'bash'});
  store.db.prepare('UPDATE outputs_fts SET project=? WHERE id=?').run('/repo/a',foreign.id);
  const hits=store.search('import failure',{project:'/repo/a'});
  assert.deepEqual(hits,[]);
});

test('whole-output search never displays a poisoned index excerpt',t=>{
  const store=fixture(t);
  const good=store.save({text:'valid yellow diagnostics output',project:'/repo/a',tool:'bash'});
  store.db.prepare('UPDATE outputs_fts SET text=? WHERE id=?').run('poisoned secret dangerous diagnostics',good.id);
  const hits=store.search('dangerous diagnostics',{project:'/repo/a'});
  assert.deepEqual(hits,[]);
  assert.equal(store.retrieve(good.id).text,'valid yellow diagnostics output');
});

test('whole-output search reports bounded source-derived excerpts and never full raw text',t=>{
  const store=fixture(t);
  const text='header '+('prefix line '.repeat(160))+'tailneedle final diagnostics';
  store.save({text,project:'/repo/a',tool:'bash',command:'secret command'});
  const hits=store.search('tailneedle diagnostics',{project:'/repo/a'});
  assert.equal(hits.length,1);
  assert.ok(hits[0].excerpt.includes('tailneedle'));
  assert.ok(hits[0].excerpt.length<=330);
  assert.equal(Object.hasOwn(hits[0],'text'),false);
});

test('Pi whole-output search reports incomplete verification without exposing stale previews',async t=>{
  const {registerEnvelope}=await import('../extensions/envelope/index.mjs');
  const home=mkdtempSync(join(tmpdir(),'envelope-search-tool-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const hooks=new Map(),tools=new Map();
  const pi={cwd:'/repo/a',on(name,handler){hooks.set(name,handler);},registerTool(tool){tools.set(tool.name,tool);},registerCommand(){},logger:{warn(){}}};
  const app=registerEnvelope(pi,{home});
  t.after(()=>app.close());
  const ctx={cwd:'/repo/a'};
  const compact=[...Array.from({length:80},(_,i)=>`  ✓ success row ${i}`),'Tests 80 passed (80)'].join('\n');
  const result=await hooks.get('tool_result')({toolName:'bash',isError:false,content:[{type:'text',text:compact}]},ctx);
  assert.ok(result?.content?.[0]?.text,'fixture must be stored by the actual Pi handler');
  const id=result.content[0].text.match(/id=([a-f0-9]{64})/)?.[1];
  assert.ok(id);
  const independent=new OutputStore(join(home,'envelope-output'));
  t.after(()=>independent.close());
  rmSync(independent.objectPath(id));
  const tool=tools.get('envelope_search_output');
  const found=await tool.execute('search-1',{query:'success'},undefined,undefined,ctx);
  assert.equal(found.isError,false);
  assert.match(found.content[0].text,/incomplete/i);
  assert.equal(found.details.searchCoverage.integritySkipped,1);
  assert.equal(found.details.searchCoverage.partial,true);
  assert.doesNotMatch(JSON.stringify(found),/success row 1/);
});

test('metadata-only match does not display an unrelated body prefix or disclose argv',t=>{
 const store=fixture(t);
 store.save({text:'unrelated captured body',project:'/repo/a',tool:'bash',command:'private-secret-needle'});
 const hits=store.search('needle',{project:'/repo/a'});
 assert.equal(hits.length,1);
 assert.match(hits[0].excerpt,/metadata match/);
 assert.doesNotMatch(hits[0].excerpt,/unrelated|private-secret-needle/);
});
