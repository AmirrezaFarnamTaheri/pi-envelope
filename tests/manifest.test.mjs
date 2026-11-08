import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));

test('single Pi package embeds the exact upstream Tersio extension entrypoints', () => {
  const upstream = read('fixtures/tersio-pi-manifest.json');
  const parent = read('package.json');
  assert.equal(parent.dependencies?.['@krtclcdy/tersio'], upstream.version);
  assert.ok(parent.bundledDependencies.includes('@krtclcdy/tersio'));
  assert.deepEqual(parent.pi.extensions.slice(0, upstream.extensions.length),
    upstream.extensions.map((s) => 'node_modules/@krtclcdy/tersio/' + s.replace(/^\.\//, '')));
  assert.deepEqual(parent.pi.skills,
    [...upstream.skills.map((s) => 'node_modules/@krtclcdy/tersio/' + s.replace(/^\.\//, '')), './skills/envelope']);
  assert.deepEqual(parent.pi.extensions.filter((s) => s === './extensions/envelope/index.js'),
    ['./extensions/envelope/index.js']);
  assert.equal(new Set(parent.pi.extensions).size, parent.pi.extensions.length);
  assert.ok(parent.keywords.includes('pi-package'));
});

test('parent extension is loaded after the RTK filter so its hook does not preempt RTK', () => {
  const parent = read('package.json');
  const extensions = parent.pi.extensions;
  assert.ok(extensions.indexOf('node_modules/@krtclcdy/tersio/extensions/rtk/filter.ts')
    < extensions.indexOf('./extensions/envelope/index.js'));
});


test('bundles a pinned native AST parser alongside the Tersio base', () => {
  const manifest = read('package.json');
  assert.equal(manifest.dependencies.typescript, '5.8.3');
  assert.ok(manifest.bundledDependencies.includes('typescript'));
  assert.ok(manifest.pi.extensions.includes('./extensions/envelope/index.js'));
  assert.equal(manifest.version, '0.20.0');
});
