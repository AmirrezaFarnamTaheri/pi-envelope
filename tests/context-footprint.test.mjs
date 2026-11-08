import test from 'node:test';
import assert from 'node:assert/strict';
import { contextFootprint } from '../extensions/envelope/context-footprint.mjs';
import { registerContextFeature } from '../extensions/envelope/context-api.mjs';

test('context footprint reports counts and byte estimates without exposing sensitive text or paths',()=>{
  const secret='s3cr3t ACCESS_TOKEN=abc';
  const options={customSystemPrompt:`private ${secret}`,contextFiles:[{path:'/private/a',content:`user ${secret}`},{path:'/private/b',content:'hello'}],
    activeTools:['bash','write'],customSections:[{name:'private-sys',content:`internal ${secret}`}],appendSystemPrompt:`suffix ${secret}`};
  const ctx={getSystemPromptOptions:()=>options};
  const first=JSON.stringify(contextFootprint(ctx));
  assert.doesNotMatch(first,/s3cr3t|ACCESS_TOKEN|\/private\/|private-sys|private /);
  const report=JSON.parse(first);
  assert.equal(report.status,'available');
  assert.equal(report.contextFileCount,2);
  assert.equal(report.toolCount,2);
  assert.equal(report.customSectionCount,1);
  assert.ok(report.measuredContentBytes>60);
  assert.equal(JSON.stringify(ctx.getSystemPromptOptions()),JSON.stringify(options));
});

test('unavailable host footprint method is explicit and never invents zero-token usage',()=>{
  const report=contextFootprint({});
  assert.equal(report.status,'unavailable');
  assert.equal(report.measuredContentBytes,undefined);
});

test('context inspection is read-only and uses the sole existing context owner',async()=>{
  const tools=new Map(),handlers=new Map();
  const pi={registerTool:t=>tools.set(t.name,t),on:(name,cb)=>handlers.set(name,(handlers.get(name)||[]).concat(cb))};
  const ledger={timeline:()=>({active:null,checkpoints:[]})};
  registerContextFeature(pi,{ledger,getStore:()=>null,getConfig:()=>({context:{enabled:false}}),project:()=>'/a',metrics:{contextCalls:0}});
  assert.equal(handlers.get('context').length,1);
  const tool=tools.get('envelope_context_footprint');
  assert.ok(tool);
  const result=await tool.execute('id',{},undefined,undefined,{getSystemPromptOptions:()=>({activeTools:['bash']})});
  assert.match(result.content[0].text,/"toolCount": 1/);
});
