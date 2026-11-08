import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runBenchmarks } from '../scripts/benchmark.mjs';

let report;
function measured(){return report??=runBenchmarks();}

test('reports a labelled offline corpus, not invented provider token savings or model quality',()=>{
  const stats=measured();
  assert.equal(stats.schemaVersion,1);
  assert.equal(stats.corpus,'envelope-synthetic-v2');
  assert.equal(stats.environment.providerCalls,0);
  assert.equal(stats.environment.actualBilledTokenSavings,null);
  assert.equal(stats.environment.answerQualityMeasured,false);
  assert.match(stats.environment.tokenProxy.label,/heuristic|approximation/i);
  assert.ok(stats.environment.node);
});

test('synthetic output cases preserve exact source and count marker overhead as rendered bytes',()=>{
  const r=measured();
  assert.ok(r.output.cases.length>=4);
  const compressed=r.output.cases.filter(c=>c.changed);
  assert.ok(compressed.length>=2);
  const safe=r.output.cases.find(c=>c.id==='source-anchor');
  assert.equal(safe.changed,false);
  assert.equal(r.output.cases.find(c=>c.id==='machine-json').changed,false);
  for(const row of r.output.cases){
    assert.equal(row.exactRecovery,true,row.id);
    assert.equal(row.bytesSaved,row.rawBytes-row.renderedBytes,row.id);
    assert.ok(row.bytesSaved>=0,row.id);
    assert.ok(row.estimatedTokenProxy.saved>=0);
    assert.ok(row.latencyMs.median>=0);
    assert.ok(row.latencyMs.p95>=row.latencyMs.median);
  }
});

test('offline context projection preserves tool call identifiers and restores raw results',()=>{
  const r=measured().context;
  assert.equal(r.changed,true);
  assert.ok(r.rawBytes>r.renderedBytes);
  assert.equal(r.originalTranscriptUnmodified,true);
  assert.equal(r.toolCallPairingPreserved,true);
  assert.equal(r.exactRecovery,true);
  assert.ok(r.latencyMs.p95>=r.latencyMs.median);
});

test('code and workflow checks are described as bounded local invariants, not real agent effectiveness',()=>{
  const r=measured();
  assert.ok(r.code.symbolMatches>=1);
  assert.equal(r.code.runtimeTypechecking,false);
  assert.deepEqual(r.workflow.states,['pending','running','review','completed']);
  assert.equal(r.workflow.agentSpawned,false);
  assert.ok(r.limitations.some(s=>/Pi|provider/i.test(s)));
});

test('benchmark CLI prints valid JSON with no network required',()=>{
  const run=spawnSync(process.execPath,['scripts/benchmark.mjs'],{cwd:new URL('..',import.meta.url).pathname,encoding:'utf8',maxBuffer:1_000_000});
  assert.equal(run.status,0,run.stderr);
  const json=JSON.parse(run.stdout);
  assert.equal(json.schemaVersion,1);
  assert.equal(json.environment.providerCalls,0);
  assert.ok(!run.stdout.includes('source with private details'));
});

test('mixed anchored-output corpus measures actual reduction with byte-exact anchor recovery',()=>{
  const report=measured();
  assert.equal(report.corpus,'envelope-synthetic-v2');
  const mixed=report.output.cases.find(c=>c.id==='mixed-anchored-tests');
  assert.ok(mixed,'mixed anchored fixture must be present in the offline benchmark');
  assert.equal(mixed.changed,true);
  assert.equal(mixed.exactRecovery,true);
  assert.equal(mixed.anchorsPreserved,true);
  assert.equal(mixed.diagnosticsPreserved,true);
  assert.ok(mixed.rawBytes>mixed.renderedBytes);
  assert.equal(report.environment.actualBilledTokenSavings,null);
});

test('offline code benchmark checks grounded call linking and unchanged-file cache reuse',()=>{
 const info=measured().code;
 assert.equal(info.callsResolved,1);
 assert.equal(info.unresolvedCallSites,0);
 assert.equal(info.incomingCallers,1);
 assert.equal(info.cachedRefresh.reparsed,0);
 assert.equal(info.cachedRefresh.reused,2);
 assert.equal(info.typeCheckedCalls,false);
});
