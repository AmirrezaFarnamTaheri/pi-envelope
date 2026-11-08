import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputStore } from '../extensions/envelope/store.mjs';
import { normalizeConfig } from '../extensions/envelope/config.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';

function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'envelope-retention-'));
  const store=new OutputStore(join(home,'objects'));
  t.after(()=>{store.close();rmSync(home,{force:true,recursive:true});});
  return store;
}

test('exact output deletion is project-scoped and removes full-text matches', t=>{
  const store=fixture(t);
  const left=store.save({text:'private compile error',project:'/a'});
  const right=store.save({text:'private compile error',project:'/b'});
  assert.equal(store.erase({id:left.id,project:'/b'}),false);
  assert.equal(store.retrieve(left.id).text,'private compile error');
  assert.equal(store.erase({id:left.id,project:'/a'}),true);
  assert.equal(store.retrieve(left.id),null);
  assert.equal(existsSync(store.objectPath(left.id)),false);
  assert.deepEqual(store.search('private compile',{project:'/a'}),[]);
  assert.equal(store.retrieve(right.id).text,'private compile error');
  assert.equal(store.erase({id:left.id,project:'/a'}),false);
});

test('bounded age pruning deletes only older records belonging to the supplied project',t=>{
  const store=fixture(t);
  const old=store.save({text:'old unique error',project:'/a'});
  const newer=store.save({text:'fresh unique error',project:'/a'});
  const other=store.save({text:'other unique error',project:'/b'});
  const timestamps=store.db.prepare('UPDATE outputs SET created_at = ? WHERE id = ?');
  timestamps.run('2020-01-01T00:00:00.000Z',old.id);
  timestamps.run('2026-10-31T00:00:00.000Z',newer.id);
  timestamps.run('2020-01-01T00:00:00.000Z',other.id);
  const pruned=store.prune({project:'/a',before:'2026-01-01T00:00:00.000Z',limit:1});
  assert.deepEqual(pruned,{deleted:1,hasMore:false});
  assert.equal(store.retrieve(old.id),null);
  assert.equal(store.retrieve(newer.id).text,'fresh unique error');
  assert.equal(store.retrieve(other.id).text,'other unique error');
  assert.equal(store.stats({project:'/a'}).items,1);
});

test('pruning is bounded with continuation and rejects unsafe arguments',t=>{
  const store=fixture(t);
  for(let i=0;i<3;i++){
    const saved=store.save({text:`old${i}`,project:'/a'});
    store.db.prepare('UPDATE outputs SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z',saved.id);
  }
  assert.deepEqual(store.prune({project:'/a',before:'2024-01-01T00:00:00.000Z',limit:2}),{deleted:2,hasMore:true});
  assert.deepEqual(store.prune({project:'/a',before:'2024-01-01T00:00:00.000Z',limit:2}),{deleted:1,hasMore:false});
  assert.throws(()=>store.prune({project:'/a',before:'invalid'}),/date|before/i);
  assert.throws(()=>store.erase({id:'../bad',project:'/a'}),/identifier/i);
  assert.throws(()=>store.prune({before:'2024-01-01T00:00:00.000Z'}),/project/i);
});

test('saved output remains search/retrieve compatible after database reopen and cleanup',t=>{
  const dir=mkdtempSync(join(tmpdir(),'envelope-retention-reopen-'));
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const a=new OutputStore(dir);
  const old=a.save({text:'retire this',project:'/a'});
  const keep=a.save({text:'remember this',project:'/a'});
  a.close();
  const b=new OutputStore(dir);
  assert.equal(b.erase({id:old.id,project:'/a'}),true);
  assert.equal(b.retrieve(keep.id).text,'remember this');
  b.close();
});

test('Envelope settings support a bounded, explicit raw-output retention period',()=>{
  assert.equal(normalizeConfig({}).output.retentionDays,0);
  assert.equal(normalizeConfig({output:{retentionDays:20}}).output.retentionDays,20);
  assert.equal(normalizeConfig({output:{retentionDays:5000}}).output.retentionDays,0);
});

test('only user command can erase output; model is limited to read-only retention status',async t=>{
  const home=mkdtempSync(join(tmpdir(),'envelope-retention-api-'));
  t.after(()=>rmSync(home,{force:true,recursive:true}));
  const tools=new Map(),commands=new Map(),notices=[];
  const pi={on(){},registerTool(x){tools.set(x.name,x);},registerCommand(k,v){commands.set(k,v);},logger:{warn(){}}};
  registerEnvelope(pi,{home});
  const ctx={cwd:'/a',ui:{notify:(msg)=>notices.push(msg)}};
  assert.ok(tools.has('envelope_output_retention'));
  assert.equal(tools.has('envelope_output_erase'),false);
  await commands.get('envelope').handler('output retention 14',ctx);
  const s=await tools.get('envelope_output_retention').execute('id',{},undefined,undefined,ctx);
  assert.match(s.content[0].text,/14/);
  assert.match(notices.at(-1),/14/);
});
