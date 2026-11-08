import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OutputStore } from '../extensions/envelope/store.mjs';

function fresh(t) {
  const home = mkdtempSync(join(tmpdir(), 'envelope-store-test-'));
  const store = new OutputStore(join(home, 'data'));
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  return store;
}

test('stores and retrieves the original UTF-8 text byte for byte', (t) => {
  const store = fresh(t);
  const original = 'Error at src/你好.ts:17\nemoji 🚀\r\nLine\u0000 null';
  const saved = store.save({ text: original, tool: 'bash', command: 'npm test', project: '/repo/a' });
  assert.match(saved.id, /^[a-f0-9]{64}$/);
  assert.equal(saved.bytes, Buffer.byteLength(original));
  assert.equal(store.retrieve(saved.id).text, original);
  assert.equal(store.retrieve(saved.id).command, 'npm test');
  assert.equal(store.retrieve(saved.id).project, '/repo/a');
  assert.equal(statSync(store.objectPath(saved.id)).mode & 0o777, 0o600);
});

test('deduplicates repeated captures but not captures from different projects', (t) => {
  const store = fresh(t);
  const a = store.save({text:'same errors', tool:'bash', project:'/repo/a'});
  const b = store.save({text:'same errors', tool:'bash', project:'/repo/a'});
  const c = store.save({text:'same errors', tool:'bash', project:'/repo/b'});
  assert.equal(a.id,b.id);
  assert.notEqual(a.id,c.id);
  assert.equal(store.stats().items, 2);
});

test('search indexes raw outputs and filters by current project', (t) => {
  const store = fresh(t);
  const a = store.save({text:'Compile error: permission denied for migration', tool:'bash', project:'/repo/a'});
  store.save({text:'Compile error: permission denied for other migration', tool:'bash', project:'/repo/b'});
  const hits = store.search('compile permission', {project:'/repo/a', limit:12});
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, a.id);
  assert.equal(hits[0].project,'/repo/a');
  assert.ok(!Object.hasOwn(hits[0], 'text'), 'search returns short metadata, never full raw output');
});

test('rejects malicious object identifiers and treats unknown IDs as missing', (t) => {
  const store = fresh(t);
  assert.throws(() => store.retrieve('../../secrets'), /identifier/i);
  assert.equal(store.retrieve('f'.repeat(64)), null);
  assert.deepEqual(store.search('" OR *', {project:'/repo/a'}), []);
});

test('reports storage path failure without returning a partial record', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'envelope-store-invalid-'));
  t.after(() => rmSync(home, {recursive:true,force:true}));
  writeFileSync(join(home,'not-a-dir'),'x');
  assert.throws(() => new OutputStore(join(home,'not-a-dir')), /ENOTDIR|EEXIST/);
});
