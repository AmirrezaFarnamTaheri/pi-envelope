import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DEFAULT_CONFIG} from '../extensions/envelope/config.mjs';
import {inspectCapabilityCockpit} from '../extensions/envelope/capability-cockpit.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';

test('capability cockpit describes real local toggles without claiming external integrations',()=>{
 const c=inspectCapabilityCockpit(DEFAULT_CONFIG,{intent:'orient',pathEnv:''});
 assert.equal(c.mode,'read-only-capability-advisory');
 assert.equal(c.capabilities.code,'enabled');
 assert.equal(c.capabilities.memory,'disabled');
 assert.equal(c.capabilities.context,'disabled');
 assert.equal(c.capabilities.graph,'native-static');
 assert.equal(c.externalCli.graphify,'not-detected');
 assert.equal(c.externalCli.jcodemunch,'not-detected');
 assert.ok(c.plan.some(x=>x.tool==='envelope_code_overview'));
 assert.equal(c.toolExecution,false);
 assert.equal(c.externalProviderCalls,false);
});
test('route chain reports disabled capability, never executes or silently turns it on',()=>{
 const disabled={...DEFAULT_CONFIG,code:{...DEFAULT_CONFIG.code,enabled:false}};
 const c=inspectCapabilityCockpit(disabled,{intent:'review',pathEnv:''});
 assert.ok(c.plan.some(x=>x.state==='blocked'));
 assert.ok(c.reasons.includes('code-disabled'));
 assert.equal(c.toolExecution,false);
});
test('PATH detection reads only safe executable entries without launching untrusted commands',t=>{
 const dir=mkdtempSync(join(tmpdir(),'envelope-detect-'));t.after(()=>rmSync(dir,{force:true,recursive:true}));
 const sentinel=join(dir,'ran.txt');const executable=join(dir,'graphify');
 writeFileSync(executable,'#!/bin/sh\necho unsafely_run > '+sentinel+'\n');chmodSync(executable,0o755);
 const c=inspectCapabilityCockpit(DEFAULT_CONFIG,{intent:'graph',pathEnv:dir});
 assert.equal(c.externalCli.graphify,'detected-unverified');
 assert.equal(c.externalCli.jcodemunch,'not-detected');
 assert.equal(existsSync(sentinel),false);
 assert.doesNotMatch(JSON.stringify(c),new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});
test('existing extension exposes cockpit without registering extra hooks or modifying opt-in state',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'envelope-cockpit-pi-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const tools=new Map(),hooks=new Map();const pi={cwd:dir,on(e,f){hooks.set(e,[...(hooks.get(e)||[]),f])},registerTool(v){tools.set(v.name,v)},registerCommand(){},logger:{warn(){}}};
 const app=registerEnvelope(pi,{home:join(dir,'state')});t.after(()=>app.close());
 assert.ok(tools.has('envelope_capabilities'));
 assert.equal(hooks.get('context').length,1);
 const response=await tools.get('envelope_capabilities').execute('id',{intent:'resume'},null,null,{cwd:dir});
 assert.equal(response.isError,false,response.content[0].text);
 assert.equal(JSON.parse(response.content[0].text).capabilities.memory,'disabled');
 assert.equal(hooks.get('tool_result').length,1);
});
