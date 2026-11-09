import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runSemanticBenchmark,measureRanks} from '../scripts/benchmark-local-embeddings.mjs';

const sample={
 schema:1,
 documents:[
  {path:'src/retry.ts',content:'export function retryToken(){ return "refresh authentication token on transient failure"; }'},
  {path:'src/database.ts',content:'export function saveRecord(){ return "database query transaction"; }'}
 ],
 queries:[
  {id:'auth',text:'token retry',relevant:['src/retry.ts']},
  {id:'database',text:'database record',relevant:['src/database.ts']}
 ]
};
function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'envelope-semantic-test-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const dataset=join(home,'dataset.json'),encoder=join(home,'trusted-encoder'),count=join(home,'calls.txt');
 writeFileSync(dataset,JSON.stringify(sample));
 const script='#!/usr/bin/env node\n'+
  'const fs=require("node:fs");\n'+
  'const input=JSON.parse(fs.readFileSync(0,"utf8"));\n'+
  'const calls='+JSON.stringify(count)+';\n'+
  'fs.appendFileSync(calls,"x");\n'+
  'const vector=text=>{const t=text.toLowerCase();return [t.includes("token")||t.includes("auth")||t.includes("retry")?1:0.01,t.includes("database")||t.includes("record")?1:0.01,0,0,0,0,0,0];};\n'+
  'const entries=input.documents?.map(d=>({path:d.path,vector:vector(d.text)}));\n'+
  'process.stdout.write(JSON.stringify({schema:1,model:"synthetic-test-encoder-NOT-semantic-quality",dimensions:8,...(entries?{entries}:{vector:vector(input.text)})}));\n';
 writeFileSync(encoder,script,{mode:0o700});
 return {home,dataset,encoder,count};
}
test('rank evaluation computes deterministic hit, recall and reciprocal-rank metrics',()=>{
 const r=measureRanks(['b.ts','a.ts','c.ts'],['a.ts','c.ts'],2);
 assert.equal(r.hit,1);
 assert.equal(r.recall,0.5);
 assert.equal(r.reciprocalRank,0.5);
 assert.deepEqual(measureRanks([],['a.ts'],2),{hit:0,recall:0,reciprocalRank:0});
});
test('operator-supplied model benchmark invokes a real local encoder once per query and keeps source private',async t=>{
 const f=fixture(t);
 const report=await runSemanticBenchmark({datasetPath:f.dataset,encoderPath:f.encoder,topK:2});
 assert.equal(report.schema,1);
 assert.equal(report.documentCount,2);
 assert.equal(report.queryCount,2);
 assert.equal(report.topK,2);
 assert.equal(report.model,'synthetic-test-encoder-NOT-semantic-quality');
 assert.equal(report.results.vector.hitRate,1);
 assert.equal(report.results.vector.meanReciprocalRank,1);
 assert.equal(report.results.hybrid.hitRate,1);
 assert.ok(report.results.lexical.hitRate>=0);
 assert.equal(readFileSync(f.count,'utf8').length,3,'one document embedding and one query embedding per question');
 assert.equal(report.modelQualityVerified,false);
 assert.doesNotMatch(JSON.stringify(report),/export function|refresh authentication|database query|token retry/);
});
test('benchmark refuses unknown relevance labels, unsafe paths, symlinks and invalid evaluation budgets',async t=>{
 const f=fixture(t);
 const bad={...sample,queries:[{id:'broken',text:'query',relevant:['src/missing.ts']}]};
 writeFileSync(f.dataset,JSON.stringify(bad));
 await assert.rejects(runSemanticBenchmark({datasetPath:f.dataset,encoderPath:f.encoder}),/relevant|unknown|indexed/i);
 bad.queries=[sample.queries[0]];
 bad.documents=[{path:'../secret.ts',content:'export const x=1;'},sample.documents[1]];
 writeFileSync(f.dataset,JSON.stringify(bad));
 await assert.rejects(runSemanticBenchmark({datasetPath:f.dataset,encoderPath:f.encoder}),/path|unsafe|relative/i);
 writeFileSync(f.dataset,JSON.stringify(sample));
 await assert.rejects(runSemanticBenchmark({datasetPath:f.dataset,encoderPath:f.encoder,topK:20}),/topK/i);
 const link=join(f.home,'symlink.json');symlinkSync(f.dataset,link);
 await assert.rejects(runSemanticBenchmark({datasetPath:link,encoderPath:f.encoder}),/symlink|unsafe/i);
});
