import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probePiRpc } from '../scripts/smoke-runtime.mjs';

function mockPi(t, content) {
  const root = mkdtempSync(join(tmpdir(), 'envelope-rpc-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fake-pi.mjs');
  writeFileSync(path, content);
  return { root, path };
}

const upstream = { extensions: [] };

test('a clean exit before discovery reports a bounded extension load diagnostic without leaking stderr', async t => {
  const { root, path } = mockPi(t,
    'process.stderr.write("Failed to load extension: unknown source\\nSECRET ghp_ABCD1234567890TOKEN\\n");\nprocess.exit(0);\n');
  const result = await probePiRpc({ root, piCommand: process.execPath, piPrefixArgs: [path], upstream, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /extension load failure/i);
  assert.match(result.reason, /code 0/);
  assert.doesNotMatch(result.reason, /ghp_|TOKEN|unknown source/i);
});

test('a valid RPC discovery response is accepted even if process closes immediately afterwards', async t => {
  const { root, path } = mockPi(t, [
    "let input='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  input += chunk;",
    "  if (!input.includes('\\n')) return;",
    "  const req = JSON.parse(input.slice(0, input.indexOf('\\n')));",
    "  process.stdout.write(JSON.stringify({ type:'response', id:req.id, command:'get_commands', success:true, data:{commands:[{name:'envelope', source:'extension'}, {name:'tersio',source:'extension'}]} }) + '\\n', () => process.exit(0));",
    "});"
  ].join('\n'));
  const result = await probePiRpc({ root, piCommand: process.execPath, piPrefixArgs: [path], upstream, timeoutMs: 2000 });
  assert.deepEqual(result, { ok: true, reason: 'Pi RPC loaded native Envelope and Tersio commands' });
});

test('non-response RPC event types are reported without exposing untrusted event bodies', async t => {
  const { root, path } = mockPi(t, [
    "process.stdout.write(JSON.stringify({type:'startup_notice',prompt:'ghp_SECRET_PRIVATE'})+'\\n');",
    "process.exit(0);"
  ].join('\n'));
  const result = await probePiRpc({ root, piCommand: process.execPath, piPrefixArgs: [path], upstream, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /startup_notice/);
  assert.doesNotMatch(result.reason, /ghp_SECRET_PRIVATE/);
});
