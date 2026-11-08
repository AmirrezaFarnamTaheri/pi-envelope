import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import {listSyntaxFiles} from '../scripts/check-syntax.mjs';

const packageJson=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const read=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');

test('current package checks and ships native workflow engine as part of one Pi extension',()=>{
  assert.equal(packageJson.version,'0.13.0');
  assert.equal(packageJson.pi.extensions.filter(x=>x.endsWith('extensions/envelope/index.js')).length,1);
  for(const path of ['extensions/envelope/workflow-ledger.mjs','extensions/envelope/workflow-api.mjs','extensions/envelope/worktree-adapter.mjs']) {
    assert.ok(listSyntaxFiles().includes(path),`missing syntax check for ${path}`);
    assert.ok(existsSync(new URL('../'+path,import.meta.url)),path);
  }
  assert.ok(existsSync(new URL('../docs/WORKFLOWS.md',import.meta.url)));
});

test('docs disclose opt-in child execution, no automatic verification, and source provenance',()=>{
  const docs=read('../docs/WORKFLOWS.md');
  const guide=read('../README.md');
  assert.match(docs,/review/i);
  assert.match(docs,/worktree|fingerprint/i);
  assert.match(guide,/envelope_workflow_handoff/);
  assert.match(docs,/open-gsd\/gsd-pi/i);
  assert.match(docs,/mvschwarz\/openrig/i);
  assert.match(guide,/envelope_workflow_run/);
  assert.match(guide,/isolated:false.*rejected/);
});
