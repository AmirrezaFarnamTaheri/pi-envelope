import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

test('read-only RPC smoke safely cancels startup UI dialogs and then discovers commands', async t => {
  const { root, path } = mockPi(t, [
    "process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'confirm-1',method:'confirm',message:'Approve? yes/no'})+'\\n');",
    "let pendingDiscovery=null;let cancelled=false;let buffer='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',chunk=>{",
    "  buffer+=chunk;",
    "  while(buffer.includes('\\n')){",
    "    const n=buffer.indexOf('\\n');const text=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!text)continue;",
    "    const item=JSON.parse(text);",
    "    if(item.type==='get_commands'){pendingDiscovery=item;}",
    "    if(item.type==='extension_ui_response'&&item.id==='confirm-1'){cancelled=item.cancelled===true&&!item.confirmed;}",
    "    if(pendingDiscovery&&cancelled){",
    "      process.stdout.write(JSON.stringify({type:'response',id:pendingDiscovery.id,command:'get_commands',success:true,data:{commands:[{name:'envelope',source:'extension'},{name:'tersio',source:'extension'}]}})+'\\n');",
    "      pendingDiscovery=null;",
    "    }",
    "  }",
    "});"
  ].join('\n'));
  const result = await probePiRpc({ root, piCommand: process.execPath, piPrefixArgs: [path], upstream, timeoutMs: 1200 });
  assert.deepEqual(result, { ok: true, reason: 'Pi RPC loaded native Envelope and Tersio commands' });
});

test('stderr hint counts raw bytes despite multi-chunk UTF-8 decoding',async t=>{
  const {root,path}=mockPi(t,"process.stderr.write(Buffer.from([0xc3]));setTimeout(()=>{process.stderr.write(Buffer.from([0xa9]));process.exit(0)},40);");
  const result=await probePiRpc({root,piCommand:process.execPath,piPrefixArgs:[path],upstream,timeoutMs:2000});
  assert.equal(result.ok,false);
  assert.match(result.reason,/Pi wrote 2 bytes on stderr \(redacted\)/);
});

test('stderr redaction uses original bytes and labels the bounded sample',async t=>{
  const {root,path}=mockPi(t,"process.stderr.write('€'.repeat(4000));process.exit(0);");
  const result=await probePiRpc({root,piCommand:process.execPath,piPrefixArgs:[path],upstream,timeoutMs:2000});
  assert.equal(result.ok,false);
  assert.match(result.reason,/Pi wrote 12000 bytes on stderr \(redacted\)/);
  assert.match(result.reason,/stderr truncated at 8192 bytes/);
  assert.doesNotMatch(result.reason,/€/);
});

test('oversized RPC output preserves bounded diagnostics but not startup secrets',async t=>{
  const {root,path}=mockPi(t,[
    "process.stderr.write('startup secret ghp_NEVER_ECHO');",
    "process.stdout.write(JSON.stringify({type:'extension_ui_request',method:'setStatus',secret:'ghp_NO_ECHO'})+'\\n');",
    "process.stdout.write(JSON.stringify({type:'startup_notice',secret:'ghp_NO_ECHO'})+'\\n');",
    "setTimeout(()=>process.stdout.write('X'.repeat(1_000_100)),80);",
    "setInterval(()=>{},1000);"
  ].join('\n'));
  const result=await probePiRpc({root,piCommand:process.execPath,piPrefixArgs:[path],upstream,timeoutMs:2000});
  assert.equal(result.ok,false);
  assert.match(result.reason,/output exceeded 1MB/);
  assert.match(result.reason,/extension_ui_request/);
  assert.match(result.reason,/startup_notice/);
  assert.match(result.reason,/UI methods: setStatus/);
  assert.match(result.reason,/stderr \(redacted\)/);
  assert.doesNotMatch(result.reason,/ghp_|NO_ECHO|NEVER_ECHO/);
});

test('command-discovery timeout includes allowlisted UI method names',async t=>{
  const {root,path}=mockPi(t,[
    "process.stdout.write(JSON.stringify({type:'extension_ui_request',method:'setWidget',message:'ghp_PRIVATE'})+'\\n');",
    "setInterval(()=>{},1000);"
  ].join('\n'));
  const result=await probePiRpc({root,piCommand:process.execPath,piPrefixArgs:[path],upstream,timeoutMs:700});
  assert.equal(result.ok,false);
  assert.match(result.reason,/discovery timed out/);
  assert.match(result.reason,/UI methods: setWidget/);
  assert.doesNotMatch(result.reason,/ghp_PRIVATE/);
});

test('stdin error settles within a diagnostic grace period instead of the full RPC timeout',async t=>{
  const {root,path}=mockPi(t,[
    "import {closeSync} from 'node:fs';",
    "closeSync(0);",
    "setTimeout(()=>process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'confirm-1',method:'confirm'})+'\\n'),80);",
    "setInterval(()=>{},1000);"
  ].join('\n'));
  const started=Date.now();
  const result=await probePiRpc({root,piCommand:process.execPath,piPrefixArgs:[path],upstream,timeoutMs:2500});
  const elapsed=Date.now()-started;
  assert.equal(result.ok,false);
  assert.match(result.reason,/stdin.*(?:failed|error)/i);
  assert.ok(elapsed<1800,'stdin error should settle before the full 2500 ms timeout');
});

test('startup UI cancels exactly four dialogs and rejects the fifth',async t=>{
  const {root,path}=mockPi(t,[
    "import {appendFileSync} from 'node:fs';",
    "const replies='replies.jsonl';",
    "let buffer='';let next=1;",
    "const request=()=>process.stdout.write(JSON.stringify({type:'extension_ui_request',id:'confirm-'+next,method:'confirm',message:'ghp_NOT_FOR_LOGS'})+'\\n');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){",
    " const p=buffer.indexOf('\\n');const line=buffer.slice(0,p);buffer=buffer.slice(p+1);if(!line)continue;",
    " const item=JSON.parse(line);",
    " if(item.type==='get_commands'){request();continue;}",
    " if(item.type==='extension_ui_response'){appendFileSync(replies,JSON.stringify(item)+'\\n');next++;request();}",
    "}});"
  ].join('\n'));
  const result=await probePiRpc({root,piCommand:process.execPath,piPrefixArgs:[path],upstream,timeoutMs:2500});
  assert.equal(result.ok,false);
  assert.match(result.reason,/Too many startup UI dialogs/);
  assert.doesNotMatch(result.reason,/ghp_NOT_FOR_LOGS/);
  const rows=readFileSync(join(root,'replies.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(x=>x.id),['confirm-1','confirm-2','confirm-3','confirm-4']);
  assert.ok(rows.every(x=>x.cancelled===true&&x.confirmed===undefined));
});
