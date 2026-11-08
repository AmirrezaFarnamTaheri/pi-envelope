import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {SymbolDeltaLedger} from '../extensions/envelope/symbol-delta.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';

function setup(t,sourceFiles={'src/a.ts':'export function alpha(){ return 1; }\n'}) {
  const home=mkdtempSync(join(tmpdir(),'envelope-symbol-delta-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'repo');mkdirSync(root);
  const write=(name,source)=>{const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,source);};
  for(const [name,text] of Object.entries(sourceFiles))write(name,text);
  assert.equal(spawnSync('git',['init','-q'],{cwd:root,timeout:4000}).status,0);
  const index=new CodeIndex(root,{ts,maxFiles:100});index.refresh();
  const storeHome=join(home,'ledger');
  const ledger=new SymbolDeltaLedger(storeHome);
  t.after(()=>ledger.close());
  return {root,home,storeHome,index,ledger,write};
}

test('only explicit capture creates a durable snapshot; status is metadata-only',t=>{
  const {ledger,index,storeHome}=setup(t);
  const empty=ledger.query(index,{action:'status'});
  assert.equal(empty.total,0);
  const saved=ledger.query(index,{action:'capture'});
  assert.match(saved.id,/^[0-9a-f-]{36}$/);
  assert.equal(saved.files,1);
  assert.ok(saved.symbols>=1);
  assert.equal(saved.complete,true);
  assert.equal(ledger.query(index,{action:'status'}).total,1);
  assert.equal(statSync(join(storeHome,'symbol-delta.sqlite')).mode&0o777,0o600);
  assert.doesNotMatch(JSON.stringify(saved),/return 1|source code/);
});

test('capture survives restart and detects changed files and added symbols without storing code bodies',t=>{
  const {ledger,storeHome,index,root,write}=setup(t);
  const first=ledger.query(index,{action:'capture'});
  ledger.close();
  const resumed=new SymbolDeltaLedger(storeHome);
  t.after(()=>resumed.close());
  write('src/a.ts','export function alpha(){ return 3333; }\nexport function beta(){ return 2; }\n');
  index.refresh();
  const report=resumed.query(index,{action:'diff',from:first.id,to:'current'});
  assert.equal(report.to,'current');
  assert.equal(report.files.modified.total,1);
  assert.equal(report.symbols.added.total,1);
  assert.equal(report.symbols.added.items[0].name,'beta');
  assert.equal(report.symbols.removed.total,0);
  assert.equal(report.complete,true);
  assert.doesNotMatch(readFileSync(join(storeHome,'symbol-delta.sqlite'),'latin1'),/return 3333|return 1;/);
});

test('line moves are not misclassified as new or deleted declarations',t=>{
  const {ledger,index,write}=setup(t);
  const first=ledger.query(index,{action:'capture'});
  write('src/a.ts','\n\nexport function alpha(){ return 1; }\n');
  index.refresh();
  const delta=ledger.query(index,{action:'diff',from:first.id});
  assert.equal(delta.symbols.added.total,0);
  assert.equal(delta.symbols.removed.total,0);
  assert.equal(delta.symbols.relocated.total,1);
  assert.equal(delta.symbols.relocated.items[0].before,1);
  assert.equal(delta.symbols.relocated.items[0].after,3);
});

test('snapshot-to-snapshot comparison never reads a changed working tree',t=>{
  const {ledger,index,write}=setup(t);
  const old=ledger.query(index,{action:'capture'});
  write('src/a.ts','export function beta(){return 2;}\n');index.refresh();
  const newer=ledger.query(index,{action:'capture'});
  write('src/a.ts','export function unrelated(){return 3;}\n');
  const delta=ledger.query(index,{action:'diff',from:old.id,to:newer.id});
  assert.deepEqual(delta.symbols.added.items.map(x=>x.name),['beta']);
  assert.deepEqual(delta.symbols.removed.items.map(x=>x.name),['alpha']);
});

test('added and removed files are counted without inventing symbol renames',t=>{
  const {ledger,index,write,root}=setup(t,{'src/a.ts':'export const first=1;\n'});
  const old=ledger.query(index,{action:'capture'});
  rmSync(join(root,'src/a.ts'));
  write('src/new.ts','export const second=2;\n');index.refresh();
  const diff=ledger.query(index,{action:'diff',from:old.id});
  assert.deepEqual(diff.files.added.items,['src/new.ts']);
  assert.deepEqual(diff.files.removed.items,['src/a.ts']);
  assert.equal(diff.symbols.added.total,1);
  assert.equal(diff.symbols.removed.total,1);
  assert.ok(!('renamed' in diff.symbols));
});

test('capture refuses stale parsed bytes and does not partially commit',t=>{
  const {ledger,index,write}=setup(t);
  write('src/a.ts','export function stale(){ return 4; }\n');
  assert.throws(()=>ledger.query(index,{action:'capture'}),/changed.*refresh|stale/i);
  assert.equal(ledger.query(index,{action:'status'}).total,0);
});

test('schema migration and malicious symlink database paths fail closed',t=>{
  const {ledger,storeHome,home}=setup(t);
  ledger.close();rmSync(join(storeHome,'symbol-delta.sqlite'));
  const outside=join(home,'external');writeFileSync(outside,'unmodified');
  symlinkSync(outside,join(storeHome,'symbol-delta.sqlite'));
  assert.throws(()=>new SymbolDeltaLedger(storeHome),/symlink/i);
  assert.equal(readFileSync(outside,'utf8'),'unmodified');
});

test('unknown snapshots and other project scopes do not authorize retrieval',t=>{
  const {ledger,index,home}=setup(t);
  const saved=ledger.query(index,{action:'capture'});
  assert.throws(()=>ledger.query(index,{action:'diff',from:'missing'}),/invalid snapshot ID/i);
  const otherRoot=join(home,'other');mkdirSync(otherRoot);
  writeFileSync(join(otherRoot,'same.ts'),'export function something(){return 9;}');
  assert.equal(spawnSync('git',['init','-q'],{cwd:otherRoot}).status,0);
  const another=new CodeIndex(otherRoot,{ts});another.refresh();
  assert.throws(()=>ledger.query(another,{action:'diff',from:saved.id}),/not found/i);
  assert.equal(ledger.query(another,{action:'status'}).total,0);
});

test('explicit erase destroys snapshot entries, never silently recreates them',t=>{
  const {ledger,index}=setup(t);
  const saved=ledger.query(index,{action:'capture'});
  assert.equal(ledger.query(index,{action:'erase',id:saved.id}).deleted,true);
  assert.equal(ledger.query(index,{action:'erase',id:saved.id}).deleted,false);
  assert.equal(ledger.query(index,{action:'status'}).total,0);
  assert.throws(()=>ledger.query(index,{action:'diff',from:saved.id}),/not found/i);
});

test('all list and diff results are bounded and report truncation',t=>{
  const {ledger,index,write}=setup(t);
  const first=ledger.query(index,{action:'capture'});
  for(let i=0;i<36;i++)write(`src/file_${i}.ts`,`export function fn_${i}(){return ${i};}\n`);
  index.refresh();
  const result=ledger.query(index,{action:'diff',from:first.id,limit:5});
  assert.equal(result.files.added.total,36);
  assert.equal(result.files.added.items.length,5);
  assert.equal(result.symbols.added.total,36);
  assert.equal(result.symbols.added.items.length,5);
  assert.equal(result.truncated,true);
  assert.equal(result.complete,false);
  assert.ok(result.reasons.includes('result-limit'));
  assert.throws(()=>ledger.query(index,{action:'diff',from:first.id,limit:1000}),/limit/i);
});

test('incomplete indexing requires opt-in acknowledgement to persist a snapshot',t=>{
  const {ledger,index}=setup(t);
  index.lastRefresh.unavailable=[{language:'python',reason:'compiler missing'}];
  assert.throws(()=>ledger.query(index,{action:'capture'}),/incomplete|allowIncomplete/i);
  assert.equal(ledger.query(index,{action:'status'}).total,0);
  const result=ledger.query(index,{action:'capture',allowIncomplete:true});
  assert.equal(result.complete,false);
  assert.ok(result.reasons.includes('parser-unavailable'));
});

test('duplicate declarations are reported as ambiguous, not guessed as renames',t=>{
  const {ledger,index,write}=setup(t,{'src/a.ts':'export function same(){ return 1; }\nexport function same(){ return 2; }\n'});
  const before=ledger.query(index,{action:'capture',allowIncomplete:true});
  write('src/a.ts','export function same(){ return 1; }\n');index.refresh();
  const result=ledger.query(index,{action:'diff',from:before.id});
  assert.ok(result.reasons.includes('ambiguous-symbol-identity'));
  assert.equal(result.complete,false);
});

test('Pi registers one scoped symbol-delta tool with no event hooks or implicit snapshot',async t=>{
  const {root,home}=setup(t);
  const tools=new Map(),events=[];
  const pi={cwd:root,on(name){events.push(name);},registerTool(item){tools.set(item.name,item);}};
  const feature=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,treeEnabled:false,languagesEnabled:false}}),loadCompiler:async()=>ts,home:join(home,'envelope')});
  t.after(()=>feature.close());
  assert.ok(tools.has('envelope_code_symbol_delta'));
  assert.deepEqual(events,[]);
  const tool=tools.get('envelope_code_symbol_delta');
  const ctx={cwd:root};
  const list=await tool.execute('list',{action:'status'},null,null,ctx);
  assert.equal(list.isError,false);
  assert.equal(JSON.parse(list.content[0].text).total,0);
  const captured=await tool.execute('cap',{action:'capture'},null,null,ctx);
  assert.equal(captured.isError,false,captured.content[0].text);
  assert.ok(JSON.parse(captured.content[0].text).id);
  assert.deepEqual(events,[]);
});

test('tampered stored symbol facts are rejected rather than returned as trusted deltas',t=>{
  const {ledger,index}=setup(t);
  const saved=ledger.query(index,{action:'capture'});
  ledger.db.prepare('UPDATE source_facts SET symbols_json=? WHERE snapshot_id=?')
    .run('[{"name":"poisoned","kind":"function","container":"","line":1}]',saved.id);
  assert.throws(()=>ledger.query(index,{action:'diff',from:saved.id}),/integrity|corrupt/i);
});

test('symlink source ancestors are refused even when they resolve inside the project',t=>{
  const {ledger,index,root}=setup(t);
  // A source path can become unsafe without changing its content hash.
  renameSync(join(root,'src'),join(root,'real_src'));
  symlinkSync(join(root,'real_src'),join(root,'src'));
  assert.throws(()=>ledger.query(index,{action:'capture'}),/symlink/i);
  assert.equal(ledger.query(index,{action:'status'}).total,0);
});


test('capability cockpit advertises explicit symbol history without automatically capturing it',async()=>{
  const {inspectCapabilityCockpit}=await import('../extensions/envelope/capability-cockpit.mjs');
  const config={code:{enabled:true},memory:{enabled:false},workflow:{enabled:false},observability:{enabled:false}};
  const report=inspectCapabilityCockpit(config,{intent:'evidence',pathEnv:''});
  assert.ok(report.plan.some(p=>p.tool==='envelope_code_symbol_delta'&&p.state==='suggested'));
  assert.equal(report.toolExecution,false);
});
