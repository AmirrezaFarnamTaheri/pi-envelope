import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import registerEnvelope from '../extensions/envelope/index.mjs';
import { readConfig } from '../extensions/envelope/config.mjs';

const hasPy=spawnSync('python3',['--version'],{timeout:2500}).status===0;
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-ml-cfg-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo=join(root,'repo');mkdirSync(repo);writeFileSync(join(repo,'app.py'),'def python_only():\n    return 3\n');
 writeFileSync(join(repo,'current.ts'),'export function current() {return 1;}\n');
 assert.equal(spawnSync('git',['init','-q'],{cwd:repo}).status,0);
 const tools=new Map(),commands=new Map(),hookCounts=new Map(),notice=[];
 const pi={cwd:repo,on(name,fn){hookCounts.set(name,(hookCounts.get(name)||0)+1);},
 registerTool(tool){tools.set(tool.name,tool)},registerCommand(name,data){commands.set(name,data)},logger:{warn(){}}};
 const ext=registerEnvelope(pi,{home:join(root,'home')});
 const ctx={cwd:repo,sessionManager:{getSessionId:()=> 'abc'},ui:{notify:(message)=>notice.push(message)}};
 const call=(name,params={})=>tools.get(name).execute('id',params,undefined,undefined,ctx);
 const command=(cmd)=>commands.get('envelope').handler(cmd,ctx);
 return {root,repo,tools,hookCounts,ext,call,command,notice};
}

test('one code-index owner exposes parser status and opt-in language toggle', {skip:!hasPy}, async t=>{
 const h=setup(t);
 const status=await h.call('envelope_code_languages');
 assert.equal(status.isError,false);
 assert.equal(JSON.parse(status.content[0].text).enabled,false);
 assert.deepEqual(JSON.parse((await h.call('envelope_code_lookup',{query:'python_only'})).content[0].text),[]);
 await h.command('code languages on');
 const after=JSON.parse((await h.call('envelope_code_languages')).content[0].text);
 assert.equal(after.enabled,true);assert.ok(after.languages.python>=1);
 assert.equal(JSON.parse((await h.call('envelope_code_lookup',{query:'python_only'})).content[0].text)[0].path,'app.py');
 await h.command('code languages off');
 assert.deepEqual(JSON.parse((await h.call('envelope_code_lookup',{query:'python_only'})).content[0].text),[]);
 assert.equal(h.hookCounts.get('context'),1);assert.equal(h.hookCounts.get('tool_result'),1);
 h.ext.close();
});

test('language toggle persists inside existing Tersio settings without enabling rename or pre-write guard',async t=>{
 const h=setup(t);await h.command('code languages on');
 const file=readConfig(join(h.root,'home','settings.json'));
 assert.equal(file.code.languagesEnabled,true);
 assert.equal(file.code.renameEnabled,false);
 assert.equal(file.code.guardEnabled,false);
 await h.command('code languages off');
 assert.equal(readConfig(join(h.root,'home','settings.json')).code.languagesEnabled,false);
});
