import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const audit = JSON.parse(readFileSync(new URL('../integrations/extraction-audit.json',import.meta.url),'utf8'));
const coverage = new Set(['native-partial','dependency-unverified','optional-external','compared-only','excluded']);

test('single pinned ledger tracks all 33 originals without inflated full-port statuses', () => {
  assert.equal(audit.sources_reachable,33);
  assert.equal(audit.repositories.length,33);
  assert.equal(new Set(audit.repositories.map(x=>x.repo)).size,33);
  for (const row of audit.repositories) {
    assert.match(row.commit,/^[0-9a-f]{40}$/);
    assert.equal(row.pinned_url,`https://github.com/${row.repo}/tree/${row.commit}`);
    assert.ok(row.extraction_target&&row.acceptance_test&&row.distinctive_value);
    assert.ok(coverage.has(row.coverage_status),row.repo);
    assert.ok(typeof row.remaining_gap==='string'&&row.remaining_gap.length>8,row.repo);
    assert.ok(typeof row.coverage_evidence==='string'&&row.coverage_evidence.length>5,row.repo);
    assert.notEqual(row.coverage_status,'complete');
  }
});

test('unrelated grammars are excluded and the unverified Tersio dependency is not declared complete',()=>{
  const rows=Object.fromEntries(audit.repositories.map(row=>[row.repo,row]));
  assert.equal(rows['scmlab/tree-sitter-pi'].coverage_status,'excluded');
  assert.equal(rows['marifat0/tree-sitter-pipe'].coverage_status,'excluded');
  assert.equal(rows['KurutoDenzeru/tersio'].coverage_status,'dependency-unverified');
});

test('redundant, stale upstream ledgers and interim plan documents are absent',()=>{
  assert.equal(existsSync(new URL('../integrations/upstreams.json',import.meta.url)),false);
  assert.equal(existsSync(new URL('../docs/UPSTREAMS.md',import.meta.url)),false);
  assert.equal(existsSync(new URL('../docs/plans',import.meta.url)),false);
  assert.equal(existsSync(new URL('../docs/specs',import.meta.url)),false);
});
