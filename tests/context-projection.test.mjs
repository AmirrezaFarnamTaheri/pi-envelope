import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputStore } from '../extensions/envelope/store.mjs';
import { projectContext } from '../extensions/envelope/context-projection.mjs';

const options = { minBytes: 200, maxPreviewChars: 400, recentMessages: 3, minSavingsRatio: 0.2 };
function fixture() {
  const original = `Running tests\n${'✓ long green output with annotation 1234567890 🚀\n'.repeat(125)}Tests 125 passed`;
  return {
    original,
    messages: [
      {role:'user',content:'Investigate tests',timestamp:1},
      {role:'assistant',content:[{type:'toolCall',id:'run-1',name:'bash',arguments:{command:'npm test'}}],timestamp:2},
      {role:'toolResult',toolCallId:'run-1',toolName:'bash',content:[{type:'text',text:original}],
        isError:false,details:{custom:'stay'},timestamp:3},
      {role:'assistant',content:[{type:'toolCall',id:'checkpoint-1',name:'envelope_context_checkpoint',arguments:{name:'stage-1'}}],timestamp:4},
      {role:'toolResult',toolCallId:'checkpoint-1',toolName:'envelope_context_checkpoint',content:[{type:'text',text:'Checkpoint stage-1 saved'}],isError:false,timestamp:5},
      {role:'user',content:'Now implement the fix',timestamp:6},
      {role:'assistant',content:[{type:'text',text:'Working on it'}],timestamp:7},
      {role:'toolResult',toolCallId:'tail-1',toolName:'bash',content:[{type:'text',text:original}],isError:false,timestamp:8}
    ]
  };
}
function storage(t) {
  const root=mkdtempSync(join(tmpdir(),'envelope-context-proj-'));
  const store=new OutputStore(join(root,'store'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return store;
}
function project(messages,store,extra={}) {
  return projectContext(messages, {anchorCallId:'checkpoint-1',project:'/repo/a',store,...options,...extra});
}

test('prunes only old successful tool output, preserves tool IDs and exact raw content', (t) => {
  const store=storage(t); const {original,messages}=fixture();
  const before=structuredClone(messages);
  const result=project(messages,store);
  assert.equal(result.changed,true);
  assert.equal(result.compacted,1);
  assert.equal(result.messages.length,messages.length);
  assert.deepEqual(messages,before,'Pi-supplied context must be unchanged');
  assert.deepEqual(result.messages.filter(m=>m.role==='assistant'),messages.filter(m=>m.role==='assistant'));
  assert.equal(result.messages[2].toolCallId,'run-1');
  assert.equal(result.messages[2].details.custom,'stay');
  assert.equal(result.messages[2].isError,false);
  assert.equal(result.messages[2].content.length,1);
  assert.deepEqual(result.messages.slice(3),messages.slice(3),'checkpoint, last user and recent zone unchanged');
  const body=result.messages[2].content[0].text;
  assert.ok(Buffer.byteLength(body)<Buffer.byteLength(original));
  const match=body.match(/envelope_recall_output id=([a-f0-9]{64})/);
  assert.ok(match,'compact result carries exact recall ID');
  assert.equal(store.retrieve(match[1]).text,original);
  assert.equal(store.retrieve(match[1]).command,'npm test');
  assert.equal(result.rawBytes,Buffer.byteLength(original));
  assert.ok(result.renderedBytes < result.rawBytes);
});

test('context projection does nothing without an anchor on the current branch', (t) => {
  const store=storage(t); const {messages}=fixture();
  assert.equal(project(messages,store,{anchorCallId:'unrelated-branch'}).changed,false);
  assert.equal(project(messages,store,{anchorCallId:''}).changed,false);
  assert.equal(store.stats().items,0);
});

test('protects errors, source reads, anchor-sensitive text, JSON, image, mixed content and already compacted output', (t) => {
  const store=storage(t); const {messages,original}=fixture();
  const samples=[
    {...messages[2],isError:true},
    {...messages[2],details:{code:1}},
    {...messages[2],toolName:'read'},
    {...messages[2],content:[{type:'text',text:'[L12] src/main.ts: const a=1;\n'.repeat(80)}]},
    {...messages[2],content:[{type:'text',text:JSON.stringify({results:Array.from({length:100},(_,i)=>i)})}]},
    {...messages[2],content:[{type:'image',data:'...'}]},
    {...messages[2],content:[{type:'text',text:original},{type:'image',data:'...'}]},
    {...messages[2],content:[{type:'text',text:`[envelope: original retained; envelope_recall_output id=${'a'.repeat(64)}]\n${original}`}]},
    {...messages[2],toolName:'envelope_recall_output'}
  ];
  for(const candidate of samples){
    const copy=structuredClone(messages);copy[2]=candidate;
    const result=project(copy,store);
    assert.equal(result.changed,false,`unexpected compaction for ${candidate.toolName}`);
    assert.deepEqual(result.messages,copy);
  }
  assert.equal(store.stats().items,0);
});

test('does not transform a result without its corresponding preceding assistant tool call', (t) => {
  const store=storage(t); const {messages}=fixture();
  const result=project([messages[0],...messages.slice(2)],store);
  assert.equal(result.changed,false);
});

test('repeated calls have stable compact text and do not duplicate stored bodies', (t) => {
  const store=storage(t);const {messages}=fixture();
  const first=project(messages,store), second=project(messages,store);
  assert.deepEqual(second.messages,first.messages);
  assert.equal(store.stats().items,1);
});

test('storage failure leaves raw output and all other messages untouched', () => {
  const {messages}=fixture();
  const store={save(){throw new Error('disk full');}};
  const result=project(messages,store);
  assert.equal(result.changed,false);
  assert.deepEqual(result.messages,messages);
});

test('protects the most recent user message even if it precedes the checkpoint', (t) => {
  const store=storage(t);const {messages}=fixture();
  const latest=messages[0];
  // The user prompt before the checkpoint stays byte-exact.
  const result=project(messages.slice(0,5),store,{recentMessages:0});
  assert.equal(result.messages[0],latest);
});
