import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadTreeRuntime } from '../extensions/envelope/tree-sitter-broker.mjs';

const requireModule=createRequire(import.meta.url);
const installed=(()=>{try{return Boolean(requireModule.resolve('web-tree-sitter'));}catch{return false;}})();

test('Node Tree-sitter runtime loads its CommonJS export condition instead of the ESM dynamic require path', async () => {
  let loaded = '';
  const shim = { Parser: class {}, Query: class {}, Language: { load: async () => ({}) } };
  const runtime = await loadTreeRuntime({ requireModule(specifier) {
    loaded = specifier;
    return shim;
  } });
  assert.equal(loaded, 'web-tree-sitter');
  assert.equal(runtime, shim);
});

test('Node Tree-sitter runtime reports unavailable CJS package without silent parser substitutes', async () => {
  await assert.rejects(() => loadTreeRuntime({ requireModule() {
    throw new Error('MODULE_NOT_FOUND');
  } }), /web-tree-sitter runtime unavailable.*MODULE_NOT_FOUND/);
});

test('default loader uses the actual optional Tree-sitter CJS runtime', {skip:!installed}, async () => {
  const runtime=await loadTreeRuntime();
  const expected=requireModule('web-tree-sitter');
  assert.equal(runtime.Parser,expected.Parser);
  assert.equal(typeof runtime.Query,'function');
  assert.equal(typeof runtime.Language?.load,'function');
});
