import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,lstatSync,rmSync,symlinkSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {GraphVersionStore} from '../extensions/envelope/graph-versions.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';
function setup(t){
 const home=realpathSync(mkdtempSync(join(tmpdir(),'graph-ledger-state-'))),root=realpathSync(mkdtempSync(join(tmpdir(),'graph-ledger-repo-')));
 t.after(()=>{rmSync(home,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});});
 mkdirSync(join(root,'src'));
 const put=(p,content)=>writeFileSync(join(root,'src',p),content);
 put('a.ts',"import {b} from './b';\nexport function a() { return b(); }\n");
 put('b.ts','export function b(){return 1;}\n');
 const index=new CodeIndex(root,{ts,maxFiles:30,maxBytesPerFile:100_000});index.refresh();
 const storage=join(home,'private-graph-ledger');
 return {root,home,storage,index,put,ledger:new GraphVersionStore(storage)};
}
test('manual snapshot persists only bounded graph metadata, survives reopen and preserves file permissions',t=>{
 const f=setup(t),before=f.ledger.status(f.index);
 assert.equal(before.count,0);assert.equal(before.persisted,true);
 const captured=f.ledger.capture(f.index);
 assert.equal(captured.existing,false);assert.match(captured.version,/^[0-9a-f]{64}$/);
 assert.equal(captured.files,2);
 const location=join(f.storage,captured.projectKey,captured.version+'.json');
 assert.equal(lstatSync(location).mode&0o777,0o600);
 const text=readFileSync(location,'utf8');
 assert.doesNotMatch(text,/return b\(\)|return 1|private-graph-ledger/);
 assert.match(text,/src\/a\.ts/);
 assert.equal(f.ledger.capture(f.index).existing,true);
 assert.equal(new GraphVersionStore(f.storage).list(f.index).versions[0].version,captured.version);
});
test('compares persistent graph versions with added and changed files and import edges',t=>{
 const f=setup(t),first=f.ledger.capture(f.index);
 f.put('a.ts','export function a(){return 2;}\n');
 f.put('c.ts','export function c(){return 3;}\n');f.index.refresh();
 const second=f.ledger.capture(f.index);
 assert.notEqual(first.version,second.version);
 const diff=f.ledger.compare(f.index,{from:first.version,to:second.version,limit:10,maxChars:8000});
 assert.deepEqual(diff.changes.map(x=>[x.path,x.change]),[['src/a.ts','modified'],['src/c.ts','added']]);
 assert.ok(diff.changes[0].removedImports.includes('src/b.ts'));
 assert.equal(diff.filesChanged,2);
 assert.equal(diff.precision,'file-byte-and-static-import-graph');
 assert.doesNotMatch(JSON.stringify(diff),/return 2|return 3/);
});
test('snapshots reject changed content unless CodeIndex refreshed',t=>{
 const f=setup(t);f.ledger.capture(f.index);
 f.put('a.ts','export const a = 9;');
 assert.throws(()=>f.ledger.capture(f.index),/stale|changed|refresh|source/i);
 assert.equal(f.ledger.status(f.index).count,1);
});
test('tampering with a stored snapshot fails closed, never trusting a file name alone',t=>{
 const f=setup(t),s=f.ledger.capture(f.index);
 const file=join(f.storage,s.projectKey,s.version+'.json');
 const parsed=JSON.parse(readFileSync(file,'utf8'));parsed.payload.files[0].sha256='0'.repeat(64);
 writeFileSync(file,JSON.stringify(parsed));
 assert.throws(()=>f.ledger.list(f.index),/integrity|tamper|corrupt|hash/i);
});
test('prune is an explicit operation, bounded retention and project isolated',t=>{
 const f=setup(t);for(let i=1;i<=4;i++){f.put('b.ts','export function b(){return '+i+';}\n');f.index.refresh();f.ledger.capture(f.index);}
 assert.equal(f.ledger.status(f.index).count,4);
 const old=f.ledger.list(f.index).versions.at(-1).version;
 assert.equal(f.ledger.prune(f.index,{keep:2}).removed,2);
 assert.equal(f.ledger.list(f.index).versions.length,2);
 assert.throws(()=>f.ledger.compare(f.index,{from:old,to:f.ledger.list(f.index).versions[0].version}),/not found|missing/i);
 const other=realpathSync(mkdtempSync(join(tmpdir(),'graph-ledger-other-')));t.after(()=>rmSync(other,{recursive:true,force:true}));
 writeFileSync(join(other,'q.ts'),'export const q=1;');const idx=new CodeIndex(other,{ts});idx.refresh();
 assert.equal(new GraphVersionStore(f.storage).status(idx).count,0);
});
test('rejects symlinked snapshot storage and symlinked source files',t=>{
 const f=setup(t),outside=realpathSync(mkdtempSync(join(tmpdir(),'graph-ledger-external-')));
 t.after(()=>rmSync(outside,{recursive:true,force:true}));
 symlinkSync(outside,f.storage);
 assert.throws(()=>f.ledger.capture(f.index),/symlink|unsafe/i);
 const other=setup(t);other.ledger.capture(other.index);
 unlinkSync(join(other.root,'src','b.ts'));symlinkSync(join(outside,'secret.ts'),join(other.root,'src','b.ts'));
 assert.throws(()=>other.ledger.capture(other.index),/symlink|unsafe|source/i);
});
test('invalid budget and version args fail rather than spilling all persistent metadata',t=>{
 const f=setup(t),s=f.ledger.capture(f.index);
 assert.throws(()=>f.ledger.compare(f.index,{from:'not-a-hash',to:s.version}),/version/i);
 assert.throws(()=>f.ledger.compare(f.index,{from:s.version,to:s.version,maxChars:20}),/maxChars/i);
 assert.throws(()=>f.ledger.prune(f.index,{keep:0}),/keep/i);
});
test('Pi exposes only read operations; persistent captures require explicit human slash command',async t=>{
 const f=setup(t),tools=new Map(),commands=new Map(),hooks=new Map(),notes=[];
 const pi={cwd:f.root,on(name,fn){hooks.set(name,[...(hooks.get(name)||[]),fn]);},registerTool(v){tools.set(v.name,v);},registerCommand(name,v){commands.set(name,v);},logger:{warn(){}}};
 registerEnvelope(pi,{home:f.home,loadCompiler:()=>ts});
 const ctx={cwd:f.root,sessionManager:{getSessionId:()=> 'local-test'},ui:{notify:v=>notes.push(v)}};
 const tool=tools.get('envelope_code_versions');assert.ok(tool);
 assert.deepEqual(tool.parameters.properties.action.enum,['status','list','compare']);
 const cmd=async text=>commands.get('envelope').handler(text,ctx);
 await cmd('code on');await cmd('code versions capture');
 assert.ok(notes.some(v=>v.includes('graph version captured:')));
 const response=await tool.execute('call',{action:'list'},undefined,undefined,ctx);
 assert.equal(response.isError,false,response.content[0].text);
 assert.equal(JSON.parse(response.content[0].text).count,1);
 await cmd('code versions prune 1');
 assert.equal(hooks.get('before_agent_start').length,1);
 assert.equal(hooks.get('tool_result').length,1);
 assert.equal(hooks.get('session_shutdown').length,1);
});

test('capturedAt tampering is detected before timestamp-based prune selects versions',t=>{
 const f=setup(t),s=f.ledger.capture(f.index),file=join(f.storage,s.projectKey,s.version+'.json');
 const original=JSON.parse(readFileSync(file,'utf8'));
 original.capturedAt='2000-01-01T00:00:00.000Z';
 writeFileSync(file,JSON.stringify(original));
 assert.throws(()=>f.ledger.list(f.index),/timestamp integrity/i);
 assert.throws(()=>f.ledger.prune(f.index,{keep:1}),/timestamp integrity/i);
});

test('capture/prune reject an existing cross-process writer lock without changing snapshots',t=>{
 const f=setup(t),first=f.ledger.capture(f.index);
 const lock=join(f.storage,first.projectKey,'.snapshot-writer.lock');
 const held=openSync(lock,'wx',0o600);
 t.after(()=>{try{closeSync(held);}catch{}try{unlinkSync(lock);}catch{}});
 f.put('b.ts','export const b=222;');f.index.refresh();
 assert.throws(()=>f.ledger.capture(f.index),/busy|writer/i);
 assert.throws(()=>f.ledger.prune(f.index,{keep:1}),/busy|writer/i);
 assert.equal(f.ledger.list(f.index).count,1);
 closeSync(held);unlinkSync(lock);
 assert.equal(f.ledger.capture(f.index).existing,false);
});

test('compare accepts pages above 512 for disjoint maximum-size snapshots',t=>{
 const f=setup(t);f.index.maxFiles=600;
 for(let i=0;i<510;i++)f.put('old_'+i+'.ts','export const value'+i+'=1;');
 f.index.refresh();const first=f.ledger.capture(f.index);
 for(let i=0;i<510;i++){unlinkSync(join(f.root,'src','old_'+i+'.ts'));f.put('new_'+i+'.ts','export const value'+i+'=2;');}
 f.index.refresh();const second=f.ledger.capture(f.index);
 const firstPage=f.ledger.compare(f.index,{from:first.version,to:second.version,limit:1,maxChars:4000});
 assert.equal(firstPage.totalChanges,1020);
 const later=f.ledger.compare(f.index,{from:first.version,to:second.version,offset:700,ifVersion:firstPage.version,limit:2,maxChars:4000});
 assert.equal(later.returned,2);assert.equal(later.offset,700);
});

test('final graph diff page fits its exact byte budget without imaginary continuation',t=>{
 const f=setup(t),a=f.ledger.capture(f.index);
 for(let i=0;i<12;i++)f.put('name_'+i+'.ts','export const v'+i+'=1;');
 f.index.refresh();const b=f.ledger.capture(f.index);
 const full=f.ledger.compare(f.index,{from:a.version,to:b.version,limit:25,maxChars:16000});
 const exact=Buffer.byteLength(JSON.stringify(full),'utf8');
 assert.ok(exact>=900);
 const packed=f.ledger.compare(f.index,{from:a.version,to:b.version,limit:25,maxChars:exact});
 assert.equal(packed.returned,full.returned);
 assert.equal(packed.truncated,false);
 assert.equal(Buffer.byteLength(JSON.stringify(packed),'utf8'),exact);
});

test('graph diff pages respect a real UTF-8 byte budget through the final page',t=>{
 const f=setup(t),first=f.ledger.capture(f.index);
 f.index.maxFiles=100;
 for(let i=0;i<35;i++)f.put('diffbudget_'+i+'.ts','export const marker'+i+' = '+i+';');
 f.index.refresh();const second=f.ledger.capture(f.index);
 let offset=0,cursor,round=0,total=0,finished=false;
 while(!finished){
   const page=f.ledger.compare(f.index,{from:first.version,to:second.version,limit:25,
     maxChars:950,offset,...(cursor?{ifVersion:cursor}:{})});
   assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=950);
   assert.ok(page.returned>0);
   total+=page.returned;
   if(!page.truncated){assert.equal(Object.hasOwn(page,'nextOffset'),false);finished=true;}
   else {assert.ok(page.nextOffset>offset);offset=page.nextOffset;cursor=page.version;}
   assert.ok(++round<60,'pagination failed to advance');
 }
 assert.equal(total,35);
 assert.ok(round>2,'byte limit should require more than the 25-entry item limit');
});
