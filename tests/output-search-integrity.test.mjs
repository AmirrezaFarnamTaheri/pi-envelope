import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OutputStore} from '../extensions/envelope/store.mjs';
import {registerEnvelope} from '../extensions/envelope/index.mjs';

function fixture(t) {
 const home=mkdtempSync(join(tmpdir(),'envelope-search-integrity-'));
 const store=new OutputStore(join(home,'output'));
 t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 return store;
}

test('whole-output search refuses deleted originals instead of showing stale FTS excerpts',t=>{
 const store=fixture(t);
 const {id}=store.save({text:'sentinel_deleted_file confidential output',project:'/a'});
 assert.equal(store.search('sentinel_deleted_file',{project:'/a'}).length,1);
 rmSync(store.objectPath(id));
 assert.deepEqual(store.search('sentinel_deleted_file',{project:'/a'}),[]);
 assert.equal(store.searchReport('sentinel_deleted_file',{project:'/a'}).coverage.integritySkipped,1);
});

test('whole-output search refuses tampered originals while retaining verified results',t=>{
 const store=fixture(t);
 const bad=store.save({text:'sealed_token_FF unique marker',project:'/a'});
 const good=store.save({text:'unique marker verified result',project:'/a'});
 writeFileSync(store.objectPath(bad.id),'tampered bytes');
 const found=store.search('unique marker',{project:'/a'});
 assert.deepEqual(found.map(x=>x.id),[good.id]);
 assert.doesNotMatch(JSON.stringify(found),/sealed_token_FF/);
});

test('whole-output search enforces both FTS and metadata project scopes',t=>{
 const store=fixture(t);
 const foreign=store.save({text:'cross_project_secret_AA import failure',project:'/b'});
 store.db.prepare('UPDATE outputs_fts SET project=? WHERE id=?').run('/a',foreign.id);
 assert.deepEqual(store.search('import failure',{project:'/a'}),[]);
});

test('whole-output search cannot leak poisoned index previews or fabricated matches',t=>{
 const store=fixture(t);
 const good=store.save({text:'valid yellow diagnostics output',project:'/a'});
 store.db.prepare('UPDATE outputs_fts SET text=? WHERE id=?').run('poisoned_private_XY dangerous diagnostics',good.id);
 assert.deepEqual(store.search('dangerous diagnostics',{project:'/a'}),[]);
 const valid=store.search('diagnostics',{project:'/a'});
 assert.equal(valid.length,1);
 assert.equal(valid[0].id,good.id);
 assert.doesNotMatch(valid[0].excerpt,/poisoned_private_XY/);
});

test('whole-output search uses bounded source-derived previews centered on terms',t=>{
 const store=fixture(t);
 const original='header '+('prefix line '.repeat(160))+'tailneedle final diagnostics';
 store.save({text:original,project:'/a',command:'a secret command'});
 const hits=store.search('tailneedle diagnostics',{project:'/a'});
 assert.equal(hits.length,1);
 assert.match(hits[0].excerpt,/tailneedle/);
 assert.ok(Array.from(hits[0].excerpt).length<=322);
 assert.equal(Object.hasOwn(hits[0],'text'),false);
});

test('Pi search warns when verification is incomplete and never exposes missing originals',async t=>{
 const home=mkdtempSync(join(tmpdir(),'envelope-search-tool-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const hooks=new Map(),tools=new Map();
 const pi={cwd:'/a',on(name,fn){hooks.set(name,fn);},registerTool(x){tools.set(x.name,x);},
  registerCommand(){},logger:{warn(){}}};
 const app=registerEnvelope(pi,{home});
 t.after(()=>app.close());
 const ctx={cwd:'/a'};
 const body=[...Array.from({length:80},(_,i)=>'  ✓ success row '+i),'Tests 80 passed (80)'].join('\n');
 const reduction=await hooks.get('tool_result')({toolName:'bash',isError:false,content:[{type:'text',text:body}]},ctx);
 const id=reduction?.content?.[0]?.text.match(/id=([a-f0-9]{64})/)?.[1];
 assert.ok(id,'the Pi hook must save the original');
 const separate=new OutputStore(join(home,'envelope-output'));
 t.after(()=>separate.close());
 rmSync(separate.objectPath(id));
 const result=await tools.get('envelope_search_output').execute('search-1',{query:'success'},undefined,undefined,ctx);
 assert.equal(result.isError,false);
 assert.match(result.content[0].text,/incomplete/i);
 assert.equal(result.details.searchCoverage.integritySkipped,1);
 assert.equal(result.details.searchCoverage.partial,true);
 assert.doesNotMatch(JSON.stringify(result),/success row 1/);
});
