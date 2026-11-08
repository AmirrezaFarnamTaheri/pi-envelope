import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=(path)=>readFileSync(resolve(root,path),'utf8');

test('hosted release gate checks real installed runtime, strict package and WASM',()=>{
  const yaml=read('.github/workflows/release-gates.yml');
  for(const required of ['pull_request:', 'workflow_dispatch:', 'contents: read', 'npm install --include=optional',
    'npm run check', 'npm run doctor:bundle', 'npm run smoke:runtime', 'npm run smoke:tree',
    'npm run smoke:lsp-real', '@earendil-works/pi-coding-agent@1.5.0'])
    assert.ok(yaml.includes(required),required);
  assert.doesNotMatch(yaml,/continue-on-error:\s*true/);
  assert.doesNotMatch(yaml,/\|\|\s*true/);
});

test('release gate verifies packed artifact, not only dry run',()=>{
  const yaml=read('.github/workflows/release-gates.yml');
  for(const part of ['npm pack --ignore-scripts','tar -xzf','package/scripts/verify-bundle.mjs',
    'package/scripts/smoke-runtime.mjs','upload-artifact'])
    assert.ok(yaml.includes(part),part);
});

test('CI docs specify no model calls and separate provider evaluations',()=>{
  const docs=read('docs/GITHUB_ACTIONS.md');
  assert.match(docs,/no model calls/i);
  assert.match(docs,/provider-backed evaluations/i);
  assert.match(docs,/pull requests/i);
});
