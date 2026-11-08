import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import registerEnvelope from '../extensions/envelope/index.mjs';

function harness(t,options={}) {
  const root=mkdtempSync(join(tmpdir(),'envelope-code-int-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo');
  mkdirSync(join(repo,'src'),{recursive:true});
  writeFileSync(join(repo,'src','a.ts'),`export function add(n: number) { return n + 1; }\n`);
  writeFileSync(join(repo,'src','b.ts'),`import { add } from './a';\nexport function run() { return add(2); }\n`);
  spawnSync('git',['init','-q'],{cwd:repo});
  const handlers=new Map(),tools=new Map(),commands=new Map(),notices=[];
  const pi={cwd:repo,logger:{warn(){}},on(name,fn){handlers.set(name,[...(handlers.get(name)||[]),fn]);},
    registerTool(tool){if(tools.has(tool.name))throw Error('duplicate '+tool.name);tools.set(tool.name,tool);},
    registerCommand(name,command){commands.set(name,command);}};
  const registered=registerEnvelope(pi,{home:join(root,'state'),...options});
  const ctx={cwd:repo,sessionManager:{getSessionId:()=> 'session-1'},ui:{notify:(text,level)=>notices.push([text,level])}};
  const call=(name,args={})=>tools.get(name).execute('test-id',args,undefined,undefined,ctx);
  const command=(args)=>commands.get('envelope').handler(args,ctx);
  return {root,repo,handlers,tools,commands,notices,ctx,call,command,registered};
}

test('registers exactly four code tools, without competing shell or context handlers', (t)=>{
  const h=harness(t);
  for(const name of ['envelope_code_overview','envelope_code_lookup','envelope_code_impact','envelope_code_verify']){
    assert.ok(h.tools.has(name),name);
  }
  assert.equal(h.handlers.get('context').length,1);
  assert.equal(h.handlers.get('tool_call').length,1); // native preflight, opt-in; Tersio retains bash rewriting
});

test('native code tools share a repository index and return grounded, bounded evidence',async(t)=>{
  const h=harness(t);
  const overview=await h.call('envelope_code_overview',{limit:5});
  assert.equal(overview.isError,false,overview.content[0].text);
  const m=JSON.parse(overview.content[0].text);
  assert.equal(m.files,2);
  assert.ok(m.topFiles.length<=5);
  assert.ok(m.topFiles.every(x=>!x.path.includes(h.root)));
  const lookup=await h.call('envelope_code_lookup',{query:'add'});
  assert.equal(lookup.isError,false);
  assert.equal(JSON.parse(lookup.content[0].text)[0].path,'src/a.ts');
  const impact=await h.call('envelope_code_impact',{path:'src/a.ts'});
  assert.equal(impact.isError,false);
  const affected=JSON.parse(impact.content[0].text);
  assert.equal(affected.mode,'static-imports');
  assert.deepEqual(affected.importers.map(x=>x.path),['src/b.ts']);
  const verify=await h.call('envelope_code_verify',{path:'src/a.ts',content:'export function broken( {'});
  assert.equal(verify.isError,false);
  assert.equal(JSON.parse(verify.content[0].text).ok,false);
  assert.match(readFileSync(join(h.repo,'src','a.ts'),'utf8'),/function add/);
});

test('explicit code-off mode disables tools, persists preferences and re-enables without affecting context',async(t)=>{
  const h=harness(t);
  await h.command('context on');
  await h.command('code off');
  const blocked=await h.call('envelope_code_lookup',{query:'add'});
  assert.equal(blocked.isError,true);
  assert.match(blocked.content[0].text,/disabled/i);
  const stored=JSON.parse(readFileSync(join(h.root,'state','settings.json'),'utf8'));
  assert.equal(stored.envelope.code.enabled,false);
  assert.equal(stored.envelope.context.enabled,true);
  await h.command('code on');
  const found=await h.call('envelope_code_lookup',{query:'add'});
  assert.equal(found.isError,false,found.content[0].text);
});

test('source scan refreshes after edits and prevents outside-root reads',async(t)=>{
  const h=harness(t);
  await h.call('envelope_code_lookup',{query:'add'});
  writeFileSync(join(h.repo,'src','a.ts'),'export function multiply(n: number) { return n * 2; }\n');
  const next=await h.call('envelope_code_lookup',{query:'multiply'});
  assert.equal(next.isError,false);
  assert.ok(JSON.parse(next.content[0].text).length>0);
  const forbidden=await h.call('envelope_code_verify',{path:'../../sensitive.ts'});
  assert.equal(forbidden.isError,true);
  assert.doesNotMatch(forbidden.content[0].text,/source content|secret/i);
});

test('missing TypeScript parser fails only code tools, leaving context and output hooks available',async(t)=>{
  const h=harness(t,{loadCompiler:async()=>{throw Error('parser unavailable');}});
  assert.ok(h.handlers.get('context'));
  assert.ok(h.handlers.get('tool_result'));
  assert.equal((await h.call('envelope_code_overview')).isError,true);
  assert.match((await h.call('envelope_code_lookup',{query:'test'})).content[0].text,/typescript|parser/i);
});

test('code index evidence remains scoped to each Pi working project', async (t) => {
  const h=harness(t);
  const second=join(h.root,'other-repo');
  mkdirSync(second,{recursive:true});
  writeFileSync(join(second,'second.ts'),'export function onlySecond() { return 2; }\n');
  spawnSync('git',['init','-q'],{cwd:second});
  const alternate={...h.ctx,cwd:second};
  const tool=h.tools.get('envelope_code_lookup');
  const first=await tool.execute('a',{query:'onlySecond'},undefined,undefined,h.ctx);
  const other=await tool.execute('b',{query:'onlySecond'},undefined,undefined,alternate);
  assert.deepEqual(JSON.parse(first.content[0].text),[]);
  assert.equal(JSON.parse(other.content[0].text)[0].path,'second.ts');
  const readOutside=await h.tools.get('envelope_code_verify').execute('c',{path:join(h.repo,'src','a.ts')},undefined,undefined,alternate);
  assert.equal(readOutside.isError,true);
  assert.doesNotMatch(readOutside.content[0].text,/function add/);
});

test('call evidence tool uses the shared index for incoming and outgoing links and never pretends dynamic calls are resolved',async t=>{
 const h=harness(t);
 assert.ok(h.tools.has('envelope_code_calls'));
 const result=await h.call('envelope_code_calls',{path:'src/b.ts',symbol:'run',limit:5});
 assert.equal(result.isError,false,result.content[0].text);
 const report=JSON.parse(result.content[0].text);
 assert.equal(report.mode,'static-syntax-call-evidence');
 assert.ok(report.outgoing.some(x=>x.target.path==='src/a.ts'&&x.target.name==='add'));
 assert.deepEqual(report.unresolved,[]);
 assert.ok(report.outgoing.every(x=>x.path==='src/b.ts'));
 const inverse=await h.call('envelope_code_calls',{path:'src/a.ts',symbol:'add'});
 assert.equal(inverse.isError,false,inverse.content[0].text);
 assert.ok(JSON.parse(inverse.content[0].text).incoming.some(x=>x.path==='src/b.ts'));
});

test('call evidence tool honors code-off, rejects traversal and does not expose absolute project paths',async t=>{
 const h=harness(t);
 await h.command('code off');
 assert.equal((await h.call('envelope_code_calls',{path:'src/a.ts'})).isError,true);
 await h.command('code on');
 const error=await h.call('envelope_code_calls',{path:'../../absent.ts'});
 assert.equal(error.isError,true);
 assert.doesNotMatch(error.content[0].text,/function add/);
 const bounded=await h.call('envelope_code_calls',{path:'src/a.ts',limit:99});
 assert.equal(bounded.isError,true);
});
