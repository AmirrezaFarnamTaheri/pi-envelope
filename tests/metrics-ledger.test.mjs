import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MetricsLedger } from '../extensions/envelope/metrics-ledger.mjs';

const fixture=(t,options={})=>{
  const root=mkdtempSync(join(tmpdir(),'envelope-metrics-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const filename=join(root,'metrics','envelope-metrics.sqlite');
  const ledger=new MetricsLedger(join(root,'metrics'),options);
  t.after(()=>ledger.close());
  return {ledger,filename,root};
};

test('projects are isolated and payloads or raw project paths are not stored in SQLite',t=>{
  const {ledger,filename}=fixture(t);
  ledger.record('/secret/a','output_compaction',{rawBytes:2200,renderedBytes:800,durationMs:3});
  ledger.record('/secret/b','output_compaction',{rawBytes:5000,renderedBytes:1000,durationMs:2});
  const summary=ledger.snapshot('/secret/a');
  assert.equal(summary.totalEvents,1);
  assert.equal(summary.byKind.output_compaction.savedBytes,1400);
  assert.equal(ledger.events('/secret/b').length,1);
  assert.equal(ledger.events('/secret/a')[0].rawBytes,2200);
  assert.equal(statSync(filename).mode&0o777,0o600);
  const rawDb=readFileSync(filename);
  assert.equal(rawDb.includes(Buffer.from('/secret/a')),false);
  const sql=new DatabaseSync(filename);
  try { const cols=sql.prepare('PRAGMA table_info(events)').all().map(c=>c.name);
    for(const forbidden of ['text','command','prompt','session_id','filename','path','raw_project']) assert.equal(cols.includes(forbidden),false,forbidden);
  } finally {sql.close();}
});

test('separately sums observed output and repeated per-request context projections',t=>{
  const {ledger}=fixture(t);
  ledger.record('/repo','output_compaction',{rawBytes:2400,renderedBytes:800,durationMs:2.5});
  ledger.record('/repo','output_compaction',{rawBytes:1200,renderedBytes:400,durationMs:1.5});
  ledger.record('/repo','context_projection',{rawBytes:8000,renderedBytes:2000,durationMs:6});
  ledger.record('/repo','context_projection',{rawBytes:8000,renderedBytes:2000,durationMs:7});
  const {byKind}=ledger.snapshot('/repo');
  assert.equal(byKind.output_compaction.count,2);
  assert.equal(byKind.output_compaction.savedBytes,2400);
  assert.equal(byKind.output_compaction.meanDurationMs,2);
  assert.equal(byKind.context_projection.count,2);
  assert.equal(byKind.context_projection.savedBytes,12000);
});

test('provider usage records reported tokens and distinguishes billed cost from catalogue estimates',t=>{
  const {ledger}=fixture(t);
  ledger.record('/repo','model_usage',{inputTokens:1200,outputTokens:100,cacheReadTokens:300,cacheWriteTokens:50,costUsd:0.015,providerBilled:true});
  ledger.record('/repo','model_usage',{inputTokens:1600,outputTokens:210,cacheReadTokens:400,cacheWriteTokens:0,costUsd:0.025,providerBilled:false});
  ledger.record('/else','model_usage',{inputTokens:4000,costUsd:10,providerBilled:true});
  const stats=ledger.snapshot('/repo').modelUsage;
  assert.equal(stats.messages,2);
  assert.equal(stats.inputTokens,2800);
  assert.equal(stats.outputTokens,310);
  assert.equal(stats.cacheReadTokens,700);
  assert.equal(stats.cacheWriteTokens,50);
  assert.ok(Math.abs(stats.providerBilledUsd-0.015)<1e-8);
  assert.ok(Math.abs(stats.catalogEstimatedUsd-0.025)<1e-8);
});

test('records only known event names and bounded numeric properties, with no arbitrary text',t=>{
  const {ledger}=fixture(t);
  assert.throws(()=>ledger.record('/repo','prompt',{text:'secret'}),/kind|unknown/i);
  assert.throws(()=>ledger.record('/repo','code_query',{action:'some_private_filename'}),/action/i);
  assert.throws(()=>ledger.record('/repo','output_compaction',{rawBytes:100,text:'secret'}),/field|unexpected/i);
  assert.throws(()=>ledger.record('/repo','output_compaction',{rawBytes:-1}),/rawBytes|negative/i);
  assert.throws(()=>ledger.record('/repo','output_compaction',{durationMs:Infinity}),/durationMs/i);
  assert.throws(()=>ledger.record('/repo','model_usage',{costUsd:-0.2}),/costUsd/i);
  assert.equal(ledger.snapshot('/repo').totalEvents,0);
});

test('retains only latest maxEvents, expires aged events, and persists across restart',t=>{
  let now=1000000000;
  const root=mkdtempSync(join(tmpdir(),'envelope-metrics-retain-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let ledger=new MetricsLedger(root,{now:()=>now,maxEvents:3,retentionDays:1});
  ledger.record('/repo','output_compaction',{rawBytes:1});
  for(let i=0;i<4;i++) ledger.record('/repo','output_compaction',{rawBytes:i+2});
  assert.equal(ledger.snapshot('/repo').totalEvents,3);
  assert.deepEqual(ledger.events('/repo',{limit:20}).map(x=>x.rawBytes),[5,4,3]);
  ledger.close();
  ledger=new MetricsLedger(root,{now:()=>now,maxEvents:3,retentionDays:1});
  assert.equal(ledger.snapshot('/repo').totalEvents,3);
  now+=2*86400000;
  assert.equal(ledger.snapshot('/repo').totalEvents,0);
  ledger.close();
});

test('event list limit is bounded and closing prevents further writes',t=>{
  const {ledger}=fixture(t);
  ledger.record('/repo','workflow_action',{action:'envelope_workflow_review',outcome:'completed',durationMs:22});
  ledger.record('/repo','code_query',{action:'envelope_code_lookup',outcome:'ok',durationMs:4});
  assert.equal(ledger.events('/repo',{limit:1}).length,1);
  assert.equal(ledger.snapshot('/repo').byKind.workflow_action.count,1);
  ledger.close();
  assert.throws(()=>ledger.record('/repo','code_query',{action:'envelope_code_verify'}),/closed/i);
});

test('explicit symbol-history query metrics are permitted without arbitrary action labels',t=>{
 const {ledger}=fixture(t);
 ledger.record('/repo','code_query',{action:'envelope_code_symbol_history',outcome:'ok',durationMs:3});
 ledger.record('/repo','code_query',{action:'envelope_code_symbol_history',outcome:'error',durationMs:1});
 const rows=ledger.events('/repo',{limit:10});
 assert.equal(rows.length,2);
 assert.ok(rows.every(x=>x.action==='envelope_code_symbol_history'));
 assert.equal(ledger.snapshot('/repo').byKind.code_query.count,2);
});
