import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read=(p)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const pkg=JSON.parse(read('package.json'));
import {listSyntaxFiles} from '../scripts/check-syntax.mjs';

test('current distribution checks and ships observability and benchmark without extra Pi hooks',()=>{
  assert.equal(pkg.version,'0.14.0');
  assert.equal(pkg.pi.extensions.filter(s=>s.endsWith('/envelope/index.js')).length,1);
  for(const path of ['extensions/envelope/metrics-ledger.mjs','extensions/envelope/metrics-api.mjs','scripts/benchmark.mjs']){
    assert.equal(existsSync(new URL('../'+path,import.meta.url)),true,path);
    assert.ok(listSyntaxFiles().includes(path),path);
  }
  assert.equal(pkg.scripts.benchmark,'node scripts/benchmark.mjs');
  assert.ok(existsSync(new URL('../docs/OBSERVABILITY.md',import.meta.url)));
});

test('documentation distinguishes local measured bytes, provider token usage and estimated proxies',()=>{
  const guide=read('README.md');const docs=read('docs/OBSERVABILITY.md');
  assert.match(guide,/envelope_metrics_snapshot/);
  assert.match(guide,/observability off/);
  assert.match(docs,/providerBilledUsd/);
  assert.match(docs,/catalogEstimatedUsd/);
  assert.match(docs,/synthetic/i);
  assert.match(docs,/not.*(?:billed|token)|billed.*not/i);
});
