import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import registerEnvelope from '../extensions/envelope/index.mjs';
import {GraphifyWatchCoordinator} from '../extensions/envelope/graphify-watch.mjs';

function fixture(t){
 const base=mkdtempSync(join(tmpdir(),'envelope-pi-watch-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=join(base,'repo');mkdirSync(root);mkdirSync(join(root,'src'));mkdirSync(join(root,'graphify-out'));
 writeFileSync(join(root,'src','main.js'),'export function main(){return 1}');
 const handles=[],operations=[],notices=[],hooks=new Map(),tools=new Map(),commands=new Map();
 const watchFactory=(dir,_opts,callback)=>{const h={dir,callback,closed:false,close(){this.closed=true;}};handles.push(h);return h;};
 const watcher=new GraphifyWatchCoordinator({watchFactory});
 const cli={async run(_root,_settings,args,signal,opts){
   operations.push({action:args.action,signal,human:opts?.humanCommand===true});
   if(args.action==='status')return {available:true,enabled:true,artifactState:'unverified',action:'status'};
   return {action:args.action,output:'offline',artifactState:'unverified',artifactChanged:true};
 },close(){}};
 const pi={cwd:root,logger:{warn(){}},on(name,handler){hooks.set(name,[...(hooks.get(name)||[]),handler]);},
 registerTool(tool){assert.ok(!tools.has(tool.name));tools.set(tool.name,tool);},
 registerCommand(name,command){commands.set(name,command);}};
 registerEnvelope(pi,{home:join(base,'state'),graphifyCliBridge:cli,graphifyWatcher:watcher});
 const ctx={cwd:root,sessionManager:{getSessionId:()=> 'watch-1'},ui:{notify:text=>notices.push(text)}};
 const command=text=>commands.get('envelope').handler(text,ctx);
 const call=params=>tools.get('envelope_graphify_cli').execute('read',params,undefined,undefined,ctx);
 return {base,root,handles,operations,notices,hooks,tools,commands,watcher,ctx,command,call};
}
test('explicit session watch command uses existing Pi hooks and does not expose watcher mutation as an agent tool',async t=>{
 const f=fixture(t);
 assert.equal(f.hooks.get('before_agent_start').length,1);
 assert.equal(f.hooks.get('tool_call').length,1);
 assert.equal(f.hooks.get('tool_result').length,1);
 const tool=f.tools.get('envelope_graphify_cli');
 assert.ok(!tool.parameters.properties.action.enum.includes('watch'));
 assert.equal(f.watcher.status(f.root).active,false);
 await f.command('graphify on');
 await f.command('graphify watch on 250');
 assert.equal(f.watcher.status(f.root).active,true);
 assert.ok(f.notices.some(s=>/code-only watch active/.test(s)));
 const status=await f.call({action:'status'});
 assert.equal(status.isError,false);
 assert.equal(JSON.parse(status.content[0].text).watch.active,true);
 const handle=f.handles.find(x=>x.dir===join(f.root,'src'));
 assert.ok(handle);handle.callback('change','main.js');
 await f.watcher.flush(f.root);
 assert.equal(f.operations.filter(x=>x.action==='update').length,1);
 assert.ok(f.operations.some(x=>x.action==='update'&&x.human===true));
 await f.command('graphify watch off');
 assert.equal(f.watcher.status(f.root).active,false);
 assert.ok(f.handles.every(x=>x.closed));
});
test('manual rebuild, binary changes, code-off and shutdown revoke watcher consent',async t=>{
 const f=fixture(t);
 await f.command('graphify on');
 await f.command('graphify watch on');
 assert.equal(f.watcher.status(f.root).active,true);
 await f.command('graphify build');
 assert.equal(f.watcher.status(f.root).active,false);
 await f.command('graphify watch on');
 await f.command('graphify binary /tmp/another-graphify');
 assert.equal(f.watcher.status(f.root).active,false);
 await f.command('graphify watch on');
 await f.command('code off');
 assert.equal(f.watcher.status(f.root).active,false);
 await f.command('code on');
 await f.command('graphify watch on');
 assert.equal(f.watcher.status(f.root).active,true);
 await f.hooks.get('session_shutdown')[0]({reason:'close'},f.ctx);
 assert.equal(f.watcher.status(f.root).active,false);
 assert.ok(f.handles.every(x=>x.closed));
});
test('off-by-default watch refuses stale or missing external graph and disabled modes',async t=>{
 const f=fixture(t);
 await f.command('graphify watch on');
 assert.equal(f.watcher.status(f.root).active,false);
 assert.ok(f.notices.some(s=>/not enabled/.test(s)));
 await f.command('graphify on');
 await f.command('graphify watch on 2');
 assert.equal(f.watcher.status(f.root).active,false);
 assert.ok(f.notices.some(s=>/debounce/i.test(s)));
});

test('ambiguous manual-rebuild state blocks both direct graph and CLI edge reads',async t=>{
 const f=fixture(t);
 writeFileSync(join(f.root,'graphify-out','graph.json'),JSON.stringify({nodes:[{id:'a'},{id:'b'}],links:[{source:'a',target:'b'}]}));
 await f.command('graphify on');await f.command('graphify watch on 250');
 const handle=f.handles.find(x=>x.dir===join(f.root,'src'));
 assert.ok(handle);handle.callback('rename',null);
 assert.equal(f.watcher.status(f.root).manualRebuildRequired,true);
 assert.equal(existsSync(join(f.root,'graphify-out','needs_update')),true);
 const blocked=await f.tools.get('envelope_code_external_graph').execute('read',{action:'nodes'},undefined,undefined,f.ctx);
 assert.equal(blocked.isError,true);
 const blockedCli=await f.call({action:'query',question:'inspect graph'});
 assert.equal(blockedCli.isError,true);
 const acknowledged=await f.call({action:'query',question:'inspect graph',allowStale:true});
 assert.equal(acknowledged.isError,false,acknowledged.content[0].text);
 assert.ok(JSON.parse(acknowledged.content[0].text).reasons.includes('watcher-manual-rebuild-required'));
});
