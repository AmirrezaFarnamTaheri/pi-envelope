import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {listSyntaxFiles} from '../scripts/check-syntax.mjs';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');

test('one native Pi package exposes lazy WASM tooling with exact optional packages',()=>{
  const manifest=JSON.parse(read('package.json'));
  assert.equal(manifest.version,'0.16.0');
  assert.equal(manifest.optionalDependencies?.['web-tree-sitter'],'0.25.3');
  assert.equal(manifest.optionalDependencies?.['tree-sitter-wasm'],'2.0.4');
  assert.equal(manifest.dependencies?.['typescript'],'5.8.3');
  assert.equal(manifest.dependencies?.['@krtclcdy/tersio'],'2.25.18');
  assert.equal(manifest.pi.extensions.filter(x=>x==='./extensions/envelope/index.js').length,1);
  assert.equal(manifest.pi.extensions.length,9);
  assert.ok(!manifest.pi.extensions.some(x=>x.includes('tree-sitter-')));
  assert.ok(listSyntaxFiles().includes('extensions/envelope/tree-sitter-broker.mjs'));
  assert.match(manifest.scripts['smoke:tree'],/smoke-tree-sitter\.mjs/);
});

test('documentation acknowledges WASM install and mock-only limitations',()=>{
  assert.ok(existsSync(new URL('docs/TREE_SITTER.md',root)));
  const text=read('docs/TREE_SITTER.md');
  for(const claim of ['web-tree-sitter','tree-sitter-wasm','npm install','off by default','unavailable','not a sandbox','smoke:tree']){
    assert.ok(text.toLowerCase().includes(claim.toLowerCase()),claim);
  }
  assert.match(read('README.md'),/envelope_code_tree_query/);
  assert.match(read('LICENSES.md'),/tree-sitter-wasm/);
});
