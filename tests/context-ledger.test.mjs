import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ContextLedger } from '../extensions/envelope/context-ledger.mjs';

function create(t) {
  const root = mkdtempSync(join(tmpdir(), 'envelope-context-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, ledger: new ContextLedger(join(root, 'context')) };
}

test('checkpoint, activate, restore and resume are persistent and ordered', (t) => {
  const { root, ledger } = create(t);
  assert.deepEqual(ledger.timeline('/repo/a', 'session-1'), { version: 1, active: null, checkpoints: [] });
  ledger.checkpoint('/repo/a', 'session-1', {name: 'investigate', callId: 'call-1'});
  ledger.checkpoint('/repo/a', 'session-1', {name: 'verify', callId: 'call-2'});
  ledger.activate('/repo/a', 'session-1', 'investigate');
  const resumed = new ContextLedger(join(root, 'context'));
  assert.equal(resumed.read('/repo/a', 'session-1').active, 'investigate');
  assert.deepEqual(resumed.timeline('/repo/a', 'session-1').checkpoints.map(c => [c.name, c.callId]),
    [['investigate', 'call-1'], ['verify', 'call-2']]);
  resumed.restore('/repo/a', 'session-1');
  assert.equal(ledger.read('/repo/a', 'session-1').active, null);
});

test('validates checkpoint names and identifiers without using untrusted text as a path', (t) => {
  const { ledger } = create(t);
  for (const name of ['', 'root', '../escape', 'bad label', 'x'.repeat(66)]) {
    assert.throws(() => ledger.checkpoint('/repo', 'session', {name, callId: 'call'}), /checkpoint/i);
  }
  assert.throws(() => ledger.checkpoint('/repo', '', {name:'ok', callId:'call'}), /session/i);
  assert.throws(() => ledger.checkpoint('', 'session', {name:'ok', callId:'call'}), /project/i);
  assert.throws(() => ledger.checkpoint('/repo', 'session', {name:'ok', callId:''}), /call/i);
  ledger.checkpoint('/repo', 'session', {name:'ok', callId:'call-1'});
  assert.throws(() => ledger.checkpoint('/repo', 'session', {name:'ok', callId:'call-2'}), /exists/i);
  assert.throws(() => ledger.activate('/repo', 'session', 'missing'), /unknown checkpoint/i);
});

test('isolates sessions and projects with hashed file paths and owner-only permissions', (t) => {
  const {ledger, root} = create(t);
  ledger.checkpoint('/repo/a', 'session/..//a', {name:'alpha', callId:'call-1'});
  ledger.activate('/repo/a', 'session/..//a', 'alpha');
  assert.equal(ledger.read('/repo/b', 'session/..//a').active, null);
  assert.equal(ledger.read('/repo/a', 'another').active, null);
  const file = ledger.fileFor('/repo/a', 'session/..//a');
  assert.ok(file.startsWith(join(root, 'context', 'sessions')));
  assert.match(file, /[a-f0-9]{64}\.json$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.project, '/repo/a');
});

test('refuses unsupported future state instead of clobbering it', (t) => {
  const {ledger} = create(t);
  const file = ledger.fileFor('/repo/a', 'sess');
  mkdirSync(dirname(file), { recursive: true });
  const future = JSON.stringify({version:999, project:'/repo/a', sessionId:'sess', active:'x'});
  writeFileSync(file, future);
  assert.throws(() => ledger.read('/repo/a', 'sess'), /newer|schema|version/i);
  assert.throws(() => ledger.checkpoint('/repo/a', 'sess', {name:'ok',callId:'one'}), /newer|schema|version/i);
  assert.equal(readFileSync(file,'utf8'), future);
});

test('does not claim checkpoint activation when persistence is impossible', (t) => {
  const {ledger,root} = create(t);
  mkdirSync(join(root,'context'), {recursive:true});
  writeFileSync(join(root,'context','sessions'), 'blocked');
  assert.throws(() => ledger.checkpoint('/repo/a','s1',{name:'safe',callId:'id'}), /EEXIST|ENOTDIR/i);
});
