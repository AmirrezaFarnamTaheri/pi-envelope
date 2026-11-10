import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import registerEnvelope from '../extensions/envelope/index.mjs';
import {DEFAULT_CONFIG} from '../extensions/envelope/config.mjs';
import {formatEnvelopeDashboard,formatEmbeddingFooter} from '../extensions/envelope/tui-dashboard.mjs';

const on={active:true,pendingCodeFiles:2,batches:3,updating:true,manualRebuildRequired:false,lastOutcome:'ok'};
const manual={...on,active:false,manualRebuildRequired:true,lastOutcome:'failed'};
test('dashboard is a bounded, readable, source-private overview with actionable states',()=>{
 const cfg={...DEFAULT_CONFIG,code:{...DEFAULT_CONFIG.code,vectorEnabled:true,
  vectorExecutable:'/private/secret_encoder --token=do-not-print'},graphify:{...DEFAULT_CONFIG.graphify,enabled:true}};
 const lines=formatEnvelopeDashboard(cfg,{vectorWatch:on,graphWatch:manual,loaded:7});
 assert.ok(Array.isArray(lines)&&lines.length<=9);
 assert.match(lines.join('\n'),/ENVELOPE.*WORKSPACE/i);
 assert.match(lines.join('\n'),/VECTORS.*WATCHING|VECTORS.*AUTO/i);
 assert.match(lines.join('\n'),/GRAPHIFY.*REVIEW/i);
 assert.match(lines.join('\n'),/watch off|watch status/i);
 assert.ok(lines.every(x=>x.length<=88&&!/[\x00-\x1f\x7f]/.test(x)));
 assert.doesNotMatch(lines.join('\n'),/private|secret_encoder|do-not-print|src\/|api.key/i);
 assert.equal(formatEmbeddingFooter(manual),'Envelope vectors: REVIEW');
 assert.equal(formatEmbeddingFooter(on),'Envelope vectors: SYNCING');
 assert.equal(formatEmbeddingFooter({active:false,manualRebuildRequired:false}),undefined);
});
function fixture(t,{widget=true,status=true}={}){
 const root=mkdtempSync(join(tmpdir(),'envelope-dashboard-test-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const commands=new Map(),hooks=new Map(),widgets=[],statuses=[],messages=[];
 const ui={notify:(value,level)=>messages.push({value,level})};
 if(widget)ui.setWidget=(key,lines,options)=>widgets.push({key,lines,options});
 if(status)ui.setStatus=(key,text)=>statuses.push({key,text});
 const pi={cwd:root,on:(name,fn)=>hooks.set(name,[...(hooks.get(name)||[]),fn]),
  registerTool(){},registerCommand:(name,cmd)=>commands.set(name,cmd),logger:{warn(){}}};
 const envelope=registerEnvelope(pi,{home:join(root,'private-state')});
 const ctx={cwd:root,ui};
 return {root,commands,hooks,widgets,statuses,messages,ctx,envelope,
  command:args=>commands.get('envelope').handler(args,ctx)};
}
test('dashboard show/hide uses native Pi widget and preserves existing hook owners',async t=>{
 const f=fixture(t);
 const hooksBefore=[...f.hooks].map(([name,a])=>[name,a.length]);
 await f.command('dashboard show');
 assert.equal(f.widgets.length,1);
 assert.equal(f.widgets[0].key,'envelope-dashboard');
 assert.equal(f.widgets[0].options.placement,'aboveEditor');
 assert.ok(f.widgets[0].lines.every(x=>typeof x==='string'&&x.length<=88));
 await f.command('dashboard status');
 assert.match(f.messages.at(-1).value,/ENVELOPE.*WORKSPACE/i);
 await f.command('dashboard hide');
 assert.equal(f.widgets.at(-1).key,'envelope-dashboard');
 assert.equal(f.widgets.at(-1).lines,undefined);
 assert.deepEqual([...f.hooks].map(([name,a])=>[name,a.length]),hooksBefore);
 f.envelope.close();
});
test('dashboard degrades to a notification in clients without widget APIs',async t=>{
 const f=fixture(t,{widget:false,status:false});
 await f.command('dashboard show');
 assert.match(f.messages.at(-1).value,/ENVELOPE.*WORKSPACE/i);
 await f.command('dashboard hide');
 assert.match(f.messages.at(-1).value,/hidden/i);
 f.envelope.close();
});
test('dashboard never enables a disabled encoder and shows a guided opt-in path',()=>{
 const lines=formatEnvelopeDashboard(DEFAULT_CONFIG,{vectorWatch:{active:false},graphWatch:{active:false},loaded:0});
 const text=lines.join('\n');
 assert.match(text,/VECTORS.*OFF/i);
 assert.match(text,/vectors on|vectors encoder/i);
 assert.doesNotMatch(text,/auto-sync active|model downloaded|verified model/i);
});
