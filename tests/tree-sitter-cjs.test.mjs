import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTreeRuntime } from '../extensions/envelope/tree-sitter-broker.mjs';

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
