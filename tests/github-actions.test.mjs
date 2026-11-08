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

test('hosted release checks use Node 24 actions and preserve evidence on failure',()=>{
  const yaml=read('.github/workflows/release-gates.yml');
  for(const sha of [
    'd23441a48e516b6c34aea4fa41551a30e30af803', // checkout v6
    '249970729cb0ef3589644e2896645e5dc5ba9c38', // setup-node v6
    'b7c566a772e6b6bfb58ed0dc250532a479d7789f', // upload-artifact v6
  ]) assert.ok(yaml.includes(sha), sha);
  assert.match(yaml,/runs-on:\s*ubuntu-24\.04/);
  assert.match(yaml,/mkdir -p "\$RUNNER_TEMP\/envelope-dist"/);
  assert.match(yaml,/if-no-files-found:\s*error/);
  assert.doesNotMatch(yaml,/ubuntu-slim/);
});

test('WASM, clangd and tarball checks still run after Pi RPC failure',()=>{
  const yaml=read('.github/workflows/release-gates.yml');
  for(const name of ['Prove real Tree-sitter WASM grammars','Ensure clangd exists',
    'Prove real clangd diagnostics','Build, inspect, and test the actual npm tarball']) {
    const offset=yaml.indexOf('- name: '+name);
    assert.ok(offset>0, name);
    const end=yaml.indexOf('\n      - name: ',offset+1);
    const stepBlock=yaml.slice(offset,end<0?undefined:end);
    assert.match(stepBlock,/^\s*if:\s*\$\{\{ !cancelled\(\) \}\}\s*$/m);
  }
  assert.doesNotMatch(yaml,/continue-on-error:\s*true/);
});

test('CI docs distinguish real Pi discovery failure from runner allocation',()=>{
  const docs=read('docs/GITHUB_ACTIONS.md');
  assert.match(docs,/Pi RPC closed before discovery|Pi RPC exited before discovery/i);
  assert.match(docs,/no executed steps/i);
  assert.match(docs,/hosted runner/i);
});

test('real Pi RPC smoke disables only Tersio first-run wizard inside isolated CI home',()=>{
  const yaml=read('.github/workflows/release-gates.yml');
  assert.match(yaml,/HOME="\$RUNNER_TEMP\/envelope-ci-home"/);
  assert.match(yaml,/comboSetupComplete/);
  assert.match(yaml,/comboDefault/);
  assert.match(yaml,/\.tersio\/settings\.json/);
  assert.match(yaml,/"off"/);
});

test('hosted CI exercises real pinned Graphify Python CLI separately from fake process tests',()=>{
  const yaml=read('.github/workflows/release-gates.yml');
  for(const required of [
    'graphifyy==0.9.100','python3 -m venv',
    'scripts/smoke-graphify-real.mjs',
    'Prove real Graphify CLI code-only compatibility',
    'GRAPHIFY_BACKEND=none',
  ])assert.ok(yaml.includes(required),required);
  assert.doesNotMatch(yaml,/continue-on-error:\s*true/);
  const smoke=read('scripts/smoke-graphify-real.mjs');
  for(const required of ['GraphifyCliBridge','action:\'build\'','action:\'update\'','action:\'query\'','action:\'path\'','action:\'explain\''])
    assert.ok(smoke.includes(required),required);
});
