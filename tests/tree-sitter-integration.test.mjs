import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import registerEnvelope from '../extensions/envelope/index.mjs';

function runtime(){
  class Parser {
    static async init(){}
    setLanguage(language){this.language=language;}
    parse(content){return {rootNode:{hasError(){return false;},content},delete(){}};}
    delete(){}
  }
  class Language {static async load(path){return {path};}}
  class Query {
    constructor(language,source){this.source=source;}
    matches(root){return [{patternIndex:0,captures:[{name:'symbol',node:{type:'identifier',text:'target',startPosition:{row:0,column:8},endPosition:{row:0,column:14}}}]}];}
    captures(root){return this.matches(root)[0].captures;}
    delete(){}
  }
  return {Parser,Language,Query};
}
function fixture(t,opts={}){
  const root=mkdtempSync(join(tmpdir(),'envelope-tree-integration-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo');mkdirSync(repo);
  writeFileSync(join(repo,'file.js'),'function target() {return 3;}\n');
  writeFileSync(join(repo,'hidden.secret'),'avoid reporting this');
  assert.equal(spawnSync('git',['init','-q'],{cwd:repo}).status,0);
  const pi={cwd:repo,logger:{warn(){}},on(name,fn){hooks.set(name,[...(hooks.get(name)||[]),fn]);},
    registerTool(obj){assert.equal(tools.has(obj.name),false);tools.set(obj.name,obj);},
    registerCommand(name,obj){commands.set(name,obj);}};
  const hooks=new Map(),tools=new Map(),commands=new Map(),notices=[];
  const ext=registerEnvelope(pi,{home:join(root,'state'),loadTreeRuntime:opts.loadTreeRuntime??(async()=>runtime()),getTreeGrammarPath:async name=>'/mock/'+name+'.wasm'});
  const ctx={cwd:repo,ui:{notify(s){notices.push(s);}}};
  const call=(name,params={},at=ctx)=>tools.get(name).execute('id',params,undefined,undefined,at);
  const command=(text)=>commands.get('envelope').handler(text,ctx);
  return {root,repo,ext,ctx,hooks,tools,commands,notices,call,command};
}

test('single code owner registers Tree-sitter tools with unchanged hook inventory and disabled query default',async t=>{
  const h=fixture(t);
  for(const name of ['envelope_code_tree_query','envelope_code_tree_capture','envelope_code_tree_status'])assert.ok(h.tools.has(name));
  assert.deepEqual([...h.hooks.keys()].sort(),['before_agent_start','context','message_end','session_shutdown','tool_call','tool_result']);
  assert.equal(h.hooks.get('context').length,1);
  assert.equal(h.hooks.get('tool_result').length,1);
  const status=await h.call('envelope_code_tree_status');
  assert.equal(status.isError,false);
  assert.equal(JSON.parse(status.content[0].text).enabled,false);
  const result=await h.call('envelope_code_tree_query',{path:'file.js',query:'(identifier) @symbol'});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/tree-sitter.*disabled/i);
  h.ext.close();
});

test('tree toggle persists in Tersio settings without changing language, guard or rename toggles',async t=>{
  const h=fixture(t);
  await h.command('code tree on');
  const config=JSON.parse(readFileSync(join(h.root,'state','settings.json'),'utf8')).envelope.code;
  assert.equal(config.treeEnabled,true);
  assert.equal(config.guardEnabled,false);
  assert.equal(config.renameEnabled,false);
  assert.equal(config.languagesEnabled,false);
  const query=await h.call('envelope_code_tree_query',{path:'file.js',query:'(identifier) @symbol',limit:3});
  assert.equal(query.isError,false,query.content[0].text);
  assert.equal(JSON.parse(query.content[0].text).matches[0].captures[0].text,'target');
  const capture=await h.call('envelope_code_tree_capture',{path:'file.js',group:'functions'});
  assert.equal(capture.isError,false,capture.content[0].text);
  const status=await h.call('envelope_code_tree_status');
  assert.equal(JSON.parse(status.content[0].text).runtime.available,true);
  await h.command('code tree off');
  assert.equal(JSON.parse(readFileSync(join(h.root,'state','settings.json'),'utf8')).envelope.code.treeEnabled,false);
  assert.equal((await h.call('envelope_code_tree_capture',{path:'file.js',group:'functions'})).isError,true);
  h.ext.close();
});

test('query results enforce existing project isolation and no path escapes or ignored files',async t=>{
  const h=fixture(t);
  await h.command('code tree on');
  const other=join(h.root,'second');mkdirSync(other);
  writeFileSync(join(other,'other.js'),'function private(){return 1;}\n');
  spawnSync('git',['init','-q'],{cwd:other});
  const query=h.tools.get('envelope_code_tree_query');
  const denied=await query.execute('id',{path:join(h.repo,'file.js'),query:'(identifier) @name'},undefined,undefined,{cwd:other});
  assert.equal(denied.isError,true);
  assert.doesNotMatch(denied.content[0].text,/function target/);
  assert.equal((await h.call('envelope_code_tree_query',{path:'hidden.secret',query:'(identifier) @name'})).isError,true);
  symlinkSync(join(h.repo,'file.js'),join(h.repo,'link.js'));
  assert.equal((await h.call('envelope_code_tree_query',{path:'link.js',query:'(identifier) @name'})).isError,true);
  h.ext.close();
});

test('missing WebAssembly engine fails read-only queries explicitly and leaves existing TS index working',async t=>{
  const h=fixture(t,{loadTreeRuntime:async()=>{throw Error('engine WASM not installed');}});
  await h.command('code tree on');
  const status=JSON.parse((await h.call('envelope_code_tree_status')).content[0].text);
  assert.equal(status.runtime.available,false);
  const query=await h.call('envelope_code_tree_query',{path:'file.js',query:'(identifier) @name'});
  assert.equal(query.isError,true);
  assert.match(query.content[0].text,/tree-sitter.*unavailable/i);
  const symbols=JSON.parse((await h.call('envelope_code_lookup',{query:'target'})).content[0].text);
  assert.equal(symbols[0].name,'target');
  h.ext.close();
});

test('invalid tree toggles leave settings unchanged and status command stays read-only',async t=>{
  const h=fixture(t);
  await h.command('code tree invalid');
  assert.match(h.notices.at(-1),/Usage:/);
  assert.equal(existsSync(join(h.root,'state','settings.json')),false);
  await h.command('code tree status');
  assert.match(h.notices.at(-1),/Tree-sitter/i);
  h.ext.close();
});
