import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ContextFrontier } from '../extensions/envelope/context-frontier.mjs';
import { OutputStore } from '../extensions/envelope/store.mjs';
import { projectContext } from '../extensions/envelope/context-projection.mjs';

const project='/project/a', sessionId='session-one', anchorCallId='checkpoint-1';
const settings={minBytes:200,maxPreviewChars:400,recentMessages:2,minSavingsRatio:0.2};
function fixture() {
  const original=`Testing\n${'PASS stable diagnostic payload 1234567890\n'.repeat(160)}`;
  const messages=[
    {role:'user',content:'Run the tests'},
    {role:'assistant',content:[{type:'toolCall',id:'bash-1',name:'bash',arguments:{command:'npm test'}}]},
    {role:'toolResult',toolCallId:'bash-1',toolName:'bash',isError:false,content:[{type:'text',text:original}]},
    {role:'assistant',content:[{type:'toolCall',id:anchorCallId,name:'envelope_context_checkpoint',arguments:{name:'check'}}]},
    {role:'toolResult',toolCallId:anchorCallId,toolName:'envelope_context_checkpoint',isError:false,content:[{type:'text',text:'recorded'}]},
    {role:'user',content:'Continue'},
    {role:'assistant',content:[{type:'text',text:'Next steps'}]}
  ];
  return {original,messages};
}
function create(t){
  const root=mkdtempSync(join(tmpdir(),'envelope-frontier-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new OutputStore(join(root,'output'));
  const frontier=new ContextFrontier(join(root,'context'));
  t.after(()=>{store.close();frontier.close();});
  return {root,store,frontier};
}
function run(messages,store,frontier,overrides={}) {
  return projectContext(messages,{project,sessionId,anchorCallId,store,frontier,...settings,...overrides});
}
function outputId(result){return result.messages[2].content[0].text.match(/envelope_recall_output id=([0-9a-f]{64})/)?.[1];}

test('stores a versioned per-checkpoint replay block without storing prompts or output text',t=>{
  const {frontier,store,root}=create(t);
  const {messages,original}=fixture();
  const before=structuredClone(messages);
  const result=run(messages,store,frontier);
  assert.equal(result.changed,true);
  assert.deepEqual(messages,before);
  const id=outputId(result);
  assert.ok(id);
  assert.equal(store.retrieve(id).text,original);
  const blocks=frontier.list({project,sessionId,anchorCallId,limit:10});
  assert.equal(blocks.version,1);
  assert.equal(blocks.total,1);
  assert.deepEqual(blocks.blocks.map(x=>x.outputId),[id]);
  assert.equal(blocks.blocks[0].sourceBytes,Buffer.byteLength(original));
  assert.doesNotMatch(JSON.stringify(blocks),/PASS stable|npm test|Run the tests|\/project\/a/);
  assert.equal(statSync(join(root,'context','frontier.sqlite')).mode & 0o777,0o600);
});

test('after restart verified blocks replay byte-stable without calling save again',t=>{
  const {frontier,store,root}=create(t);
  const {messages}=fixture();
  const first=run(messages,store,frontier);
  frontier.close();store.close();
  const resumedFrontier=new ContextFrontier(join(root,'context'));
  const resumedStore=new OutputStore(join(root,'output'));
  t.after(()=>{resumedFrontier.close();resumedStore.close();});
  resumedStore.save=()=>{throw new Error('save called during replay')};
  const second=run(messages,resumedStore,resumedFrontier);
  assert.equal(second.changed,true);
  assert.deepEqual(second.messages,first.messages);
  assert.equal(resumedFrontier.list({project,sessionId,anchorCallId}).total,1);
});

test('missing or erased replay object is not silently re-created',t=>{
  const {frontier,store}=create(t);
  const {messages}=fixture();
  const result=run(messages,store,frontier);
  assert.ok(store.erase({id:outputId(result),project}));
  const replay=run(messages,store,frontier);
  assert.equal(replay.changed,false);
  assert.deepEqual(replay.messages,messages);
  assert.equal(store.stats({project}).items,0);
});

test('a conflicting tool call with different raw bytes never uses a stale replay block',t=>{
  const {frontier,store}=create(t);const {messages}=fixture();
  assert.equal(run(messages,store,frontier).changed,true);
  const modified=structuredClone(messages);
  modified[2].content[0].text+='changed bytes';
  const result=run(modified,store,frontier);
  assert.equal(result.changed,false);
  assert.deepEqual(result.messages,modified);
  assert.equal(frontier.list({project,sessionId,anchorCallId}).total,1);
});

test('a failed durable frontier transaction never returns compacted messages',t=>{
  const {frontier,store}=create(t);const {messages}=fixture();
  frontier.recordBatch=()=>{throw new Error('no space')};
  const result=run(messages,store,frontier);
  assert.equal(result.changed,false);
  assert.deepEqual(result.messages,messages);
});

test('replay remains isolated by project, session, checkpoint and branch',t=>{
  const {frontier,store}=create(t);const {messages}=fixture();
  assert.equal(run(messages,store,frontier).changed,true);
  for(const changed of [
    {project:'/project/b'},
    {sessionId:'session-two'},
    {anchorCallId:'checkpoint-other'},
  ]){
    const blocks=frontier.list({project:changed.project??project,sessionId:changed.sessionId??sessionId,anchorCallId:changed.anchorCallId??anchorCallId});
    assert.equal(blocks.total,0);
  }
  const otherBranch=messages.filter(m=>m.toolCallId!==anchorCallId);
  assert.equal(run(otherBranch,store,frontier).changed,false);
});

test('replay manifest refuses unsupported future versions and cannot follow a symlink',t=>{
  const {frontier,root}=create(t);
  frontier.close();
  const path=join(root,'context','frontier.sqlite');
  // Simulate newer schema without trying to rewrite it.
  const db=new DatabaseSync(path);
  db.exec('PRAGMA user_version=777');db.close();
  assert.throws(()=>new ContextFrontier(join(root,'context')),/unsupported.*version/i);
  rmSync(path);
  const outside=join(root,'outside');writeFileSync(outside,'secret');
  symlinkSync(outside,path);
  assert.throws(()=>new ContextFrontier(join(root,'context')),/symlink/i);
  rmSync(path);
  symlinkSync(join(root,'nonexistent-database'),path);
  assert.throws(()=>new ContextFrontier(join(root,'context')),/symlink/i);
});

test('two-block transaction rolls back atomically when a prior tool call conflicts',t=>{
  const {frontier}=create(t);
  const scope={project,sessionId,anchorCallId};
  const a={callId:'a',outputId:'a'.repeat(64),commandHash:'f'.repeat(64),sourceBytes:900,renderedBytes:200};
  const b={callId:'b',outputId:'b'.repeat(64),commandHash:'f'.repeat(64),sourceBytes:900,renderedBytes:200};
  assert.equal(frontier.recordBatch({...scope,blocks:[a]}).inserted,1);
  assert.equal(frontier.recordBatch({...scope,blocks:[a]}).inserted,0);
  assert.throws(()=>frontier.recordBatch({...scope,blocks:[b,{...a,outputId:'c'.repeat(64)}]}),/conflict/);
  assert.equal(frontier.list({...scope}).total,1,'new block b must roll back with the conflicting a');
  assert.equal(frontier.recordBatch({...scope,blocks:[b]}).inserted,1);
});

test('frontier lists only bounded metadata and rejects oversized record batches',t=>{
  const {frontier,root}=create(t);
  const scope={project,sessionId,anchorCallId};
  const blocks=Array.from({length:30},(_,i)=>({callId:`block-${i}`,outputId:i.toString(16).padStart(64,'0'),
    commandHash:'e'.repeat(64),sourceBytes:900,renderedBytes:200}));
  assert.equal(frontier.recordBatch({...scope,blocks}).inserted,30);
  const page=frontier.list({...scope,limit:5});
  assert.equal(page.total,30);
  assert.equal(page.blocks.length,5);
  assert.equal(page.hasMore,true);
  assert.throws(()=>frontier.recordBatch({...scope,blocks:Array.from({length:129},(_,i)=>({...blocks[0],callId:`extra-${i}`}))}),/128/);
  assert.doesNotMatch(readFileSync(join(root,'context','frontier.sqlite')).toString('latin1'),/\/project\/a|session-one|checkpoint-1/);
});

test('corrupted raw store objects are never replayed as verified context',t=>{
  const {frontier,store}=create(t);
  const {messages}=fixture();
  const first=run(messages,store,frontier);
  const id=outputId(first);
  writeFileSync(store.objectPath(id),'poisoned bytes');
  assert.equal(run(messages,store,frontier).changed,false);
  assert.equal(frontier.list({project,sessionId,anchorCallId}).total,1);
});
