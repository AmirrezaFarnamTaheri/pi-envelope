import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectMemory,registerProjectMemoryFeature} from '../extensions/envelope/project-memory.mjs';
import {registerEnvelope} from '../extensions/envelope/index.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'envelope-memory-'));
  mkdirSync(join(root,'project-a'));mkdirSync(join(root,'project-b'));
  const home=join(root,'home');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,home,a:join(root,'project-a'),b:join(root,'project-b')};
}

test('project note save, restart, scope isolation, and bounded metadata-only list',t=>{
  const {home,a,b}=fixture(t);
  const memory=new ProjectMemory(home);
  const note=memory.save(a,{kind:'decision',title:'Prefer one graph',body:'Use a single source-backed index and preserve provenance.',tags:['graph','architecture']});
  assert.match(note.id,/^[a-f0-9-]{36}$/);
  assert.equal(memory.read(a,note.id).body,'Use a single source-backed index and preserve provenance.');
  assert.equal(memory.read(b,note.id),null);
  assert.equal(memory.list(b).total,0);
  const listing=memory.list(a);
  assert.equal(listing.total,1);
  assert.ok(!JSON.stringify(listing).includes('Use a single source-backed'));
  assert.equal(lstatSync(join(home,'memory.sqlite')).mode & 0o777,0o600);
  memory.close();
  const reopened=new ProjectMemory(home);
  t.after(()=>reopened.close());
  assert.equal(reopened.read(a,note.id).title,'Prefer one graph');
  assert.deepEqual(reopened.search(a,'single GRAPH').hits.map(x=>x.id),[note.id]);
});

test('explicit Markdown import, idempotence, export, and source change freshness',t=>{
  const {home,a}=fixture(t);
  mkdirSync(join(a,'notes'));writeFileSync(join(a,'notes','architecture.md'),'# Architecture decision\n\nKeep source evidence exact.\n');
  const memory=new ProjectMemory(home);t.after(()=>memory.close());
  const first=memory.importMarkdown(a,'notes/architecture.md');
  assert.equal(first.added,true);
  assert.equal(memory.importMarkdown(a,'notes/architecture.md').id,first.id);
  assert.equal(memory.list(a).total,1);
  const read=memory.read(a,first.id);
  assert.equal(read.sourceStatus,'fresh');
  assert.match(memory.exportMarkdown(a,first.id),/^# Architecture decision/m);
  writeFileSync(join(a,'notes','architecture.md'),'# Architecture decision\n\nChanged evidence.\n');
  assert.equal(memory.read(a,first.id).sourceStatus,'stale');
  const changed=memory.importMarkdown(a,'notes/architecture.md');
  assert.equal(changed.added,true);
  assert.notEqual(changed.id,first.id);
  assert.equal(memory.list(a).total,2);
});

test('anchor read rejects symlinks and project escape without creating memory entries',t=>{
  const {home,root,a}=fixture(t);
  writeFileSync(join(root,'secret.md'),'# Hidden\nsecret');
  symlinkSync(join(root,'secret.md'),join(a,'danger.md'));
  const memory=new ProjectMemory(home);t.after(()=>memory.close());
  assert.throws(()=>memory.importMarkdown(a,'../secret.md'),/path|root|relative/i);
  assert.throws(()=>memory.importMarkdown(a,'danger.md'),/symlink|safe/i);
  assert.throws(()=>memory.importMarkdown(a,'/etc/hidden.md'),/path|relative/i);
  assert.equal(memory.list(a).total,0);
});

test('validates note fields, bounded search and per-project quotas without side effects',t=>{
  const {home,a}=fixture(t);const memory=new ProjectMemory(home);t.after(()=>memory.close());
  assert.throws(()=>memory.save(a,{kind:'other',title:'Thing',body:'text'}),/kind/i);
  assert.throws(()=>memory.save(a,{kind:'fact',title:'x'.repeat(200),body:'text'}),/title|length/i);
  assert.throws(()=>memory.save(a,{kind:'fact',title:'Thing',body:'x'.repeat(9000)}),/body|limit|bytes/i);
  assert.throws(()=>memory.save(a,{kind:'fact',title:'Thing',body:'text',tags:['illegal/tag']}),/tag/i);
  for(let i=0;i<35;i++)memory.save(a,{kind:'reference',title:`item ${i}`,body:'Shared factual context and tests.'});
  const found=memory.search(a,'factual', {limit:5});
  assert.equal(found.hits.length,5);
  assert.equal(found.total,35);
  assert.equal(found.truncated,true);
  assert.equal(memory.list(a,{limit:12}).notes.length,12);
  assert.equal(memory.list(a,{limit:12}).truncated,true);
  assert.throws(()=>memory.search(a,'a'.repeat(200)),/query|limit/i);
});

test('explicit erasure is project-scoped; deleted note cannot be read or exported',t=>{
  const {home,a,b}=fixture(t);const memory=new ProjectMemory(home);t.after(()=>memory.close());
  const note=memory.save(a,{kind:'task',title:'Remove after review',body:'Confidential internal context'});
  assert.equal(memory.forget(b,note.id),false);
  assert.equal(memory.forget(a,note.id),true);
  assert.equal(memory.read(a,note.id),null);
  assert.throws(()=>memory.exportMarkdown(a,note.id),/not found/i);
  assert.equal(memory.search(a,'Confidential').hits.length,0);
});

test('database symlink refuses opening without touching its target',t=>{
  const {home,root}=fixture(t);mkdirSync(home,{recursive:true});
  const secret=join(root,'outsider');writeFileSync(secret,'private');
  symlinkSync(secret,join(home,'memory.sqlite'));
  assert.throws(()=>new ProjectMemory(home),/symlink|database/i);
  assert.equal(readFileSync(secret,'utf8'),'private');
});

test('Pi memory tool requires opt-in, stays scoped and adds no competing hooks',async t=>{
  const {root,home,a,b}=fixture(t);
  const tools=new Map(),commands=new Map(),events=[];
  const pi={cwd:a,on(name){events.push(name);},registerTool(x){tools.set(x.name,x)},registerCommand(n,x){commands.set(n,x)},logger:{warn(){}}};
  const app=registerEnvelope(pi,{home});t.after(()=>app.close());
  assert.equal(events.filter(e=>e==='context').length,1);
  const invoke=(name,p,cwd=a)=>tools.get(name).execute('x',p,null,null,{cwd});
  const memory=tools.get('envelope_memory');assert.ok(memory);
  const off=await invoke('envelope_memory',{action:'save',title:'A',body:'secret',kind:'fact'});
  assert.equal(off.isError,true);
  assert.equal(lstatSync(join(home,'envelope-memory'),{throwIfNoEntry:false}),undefined,'disabled memory must not initialize a persistent database');
  const notes=[];const ctx={cwd:a,ui:{notify:x=>notes.push(x)}};
  await commands.get('envelope').handler('memory on',ctx);
  const saved=await invoke('envelope_memory',{action:'save',title:'A',body:'Project-scoped fact',kind:'fact'});
  assert.equal(saved.isError,false,saved.content[0].text);
  const id=JSON.parse(saved.content[0].text).id;
  const cross=await invoke('envelope_memory',{action:'read',id},b);
  assert.equal(cross.isError,true);
  const found=await invoke('envelope_memory',{action:'search',query:'project-scoped'},a);
  assert.equal(found.isError,false);
  assert.equal(JSON.parse(found.content[0].text).hits.length,1);
  await commands.get('envelope').handler('memory off',ctx);
  assert.equal((await invoke('envelope_memory',{action:'read',id})).isError,true);
});

test('explicit Claude Code JSONL session import records bounded, privacy-aware facts only',t=>{
  const {home,a}=fixture(t);mkdirSync(join(a,'sessions'));
  const entries=[
    {timestamp:'2026-11-01T10:00:00Z',type:'user',message:{role:'user',content:'Fix the flaky parser test'}},
    {timestamp:'2026-11-01T10:01:00Z',type:'assistant',message:{role:'assistant',content:[
      {type:'tool_use',name:'Edit',input:{file_path:join(a,'src','parser.ts')}},
      {type:'tool_use',name:'Bash',input:{command:'export AWS_SECRET_ACCESS_KEY=LEAK_ME'}}]}},
    {timestamp:'2026-11-01T10:02:00Z',type:'user',message:{role:'user',content:[{type:'text',text:'Add a regression test'}]}},
    {timestamp:'2026-11-01T10:03:00Z',type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Some private assistant content NO_PUBLICATION'}]}}
  ];
  mkdirSync(join(a,'src'));writeFileSync(join(a,'src','parser.ts'),'export const parser = 1;');
  const log=join(a,'sessions','claude.jsonl');writeFileSync(log,entries.map(JSON.stringify).join('\n')+'\n');
  const memory=new ProjectMemory(home);t.after(()=>memory.close());
  const item=memory.importClaudeTranscript(a,'sessions/claude.jsonl');
  assert.equal(item.added,true);
  assert.equal(memory.importClaudeTranscript(a,'sessions/claude.jsonl').id,item.id);
  const note=memory.read(a,item.id);
  assert.match(note.body,/Fix the flaky parser test/);
  assert.match(note.body,/src\/parser.ts/);
  assert.match(note.body,/User messages: 2/);
  assert.equal(note.sourceStatus,'fresh');
  assert.doesNotMatch(JSON.stringify(note),/LEAK_ME|AWS_SECRET_ACCESS_KEY|NO_PUBLICATION/);
  assert.equal(memory.list(a).total,1);
});

test('Claude transcript import refuses malformed or out-of-project sources without chat capture',t=>{
  const {home,a}=fixture(t);const memory=new ProjectMemory(home);t.after(()=>memory.close());
  writeFileSync(join(a,'bad.jsonl'),'not JSON\n');
  assert.throws(()=>memory.importClaudeTranscript(a,'bad.jsonl'),/no usable user messages/i);
  assert.throws(()=>memory.importClaudeTranscript(a,'../private.jsonl'),/relative|path|root/i);
  assert.equal(memory.list(a).total,0);
});

test('Markdown exports never duplicate the imported H1 heading; titles reject line breaks',t=>{
 const {home,a}=fixture(t),memory=new ProjectMemory(home);t.after(()=>memory.close());
 writeFileSync(join(a,'draft.md'),'# Imported title\n\nBody text.\n');
 const note=memory.importMarkdown(a,'draft.md');
 const markdown=memory.exportMarkdown(a,note.id);
 assert.equal(markdown.match(/^# Imported title$/gm)?.length,1);
 assert.throws(()=>memory.save(a,{kind:'fact',title:'first\n# injected',body:'body'}),/title/i);
});

test('long explicit session import makes its mechanical 600-line parse cap visible',t=>{
 const {home,a}=fixture(t),memory=new ProjectMemory(home);t.after(()=>memory.close());
 const lines=Array.from({length:650},(_,i)=>JSON.stringify({type:'user',message:{role:'user',content:`message ${i}`}}));
 writeFileSync(join(a,'long.jsonl'),lines.join('\n')+'\n');
 const note=memory.importClaudeTranscript(a,'long.jsonl');
 assert.match(memory.read(a,note.id).body,/600 input lines examined/i);
 assert.match(memory.read(a,note.id).body,/incomplete session evidence/i);
});
