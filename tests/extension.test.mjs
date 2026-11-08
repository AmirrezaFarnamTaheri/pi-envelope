import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import registerEnvelope from '../extensions/envelope/index.mjs';
import { readConfig } from '../extensions/envelope/config.mjs';

function harness(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'envelope-extension-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const notices = [];
  const pi = {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) || []), handler]);
    },
    registerTool(tool) { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); },
    registerCommand(name, command) { assert.ok(!commands.has(name)); commands.set(name, command); },
    logger: { warn: () => {} }
  };
  registerEnvelope(pi, { home: join(root, 'state'), ...overrides });
  const ctx = { cwd: '/repo/a', ui: { notify: (message, level) => notices.push({ message, level }) }};
  return {root, pi, handlers, tools, commands, notices, ctx};
}

const verboseTests = ['RUN v3.1.0',
  ...Array.from({ length: 90 }, (_, i) => `  ✓ service ${i+1} passes with fixtures`),
  'Test Files  1 passed (1)', 'Tests  90 passed (90)', 'Duration  3.2s'].join('\n');

test('registers one output hook, one context hook, and a disjoint native tool namespace', (t) => {
  const h = harness(t);
  assert.deepEqual([...h.handlers.keys()].sort(), ['before_agent_start', 'context', 'message_end', 'session_shutdown', 'tool_call', 'tool_result']);
  assert.equal(h.handlers.get('tool_result').length, 1);
  assert.equal(h.handlers.get('tool_call').length, 1);
  assert.deepEqual([...h.tools.keys()].sort(), ['envelope_code_calls', 'envelope_code_change_impact', 'envelope_code_graph', 'envelope_code_impact', 'envelope_code_languages', 'envelope_code_lookup', 'envelope_code_lsp_verify', 'envelope_code_overview', 'envelope_code_rename', 'envelope_code_tree_capture', 'envelope_code_tree_query', 'envelope_code_tree_status', 'envelope_code_verify', 'envelope_context_checkpoint', 'envelope_context_footprint', 'envelope_context_prune', 'envelope_context_restore', 'envelope_context_timeline', 'envelope_metrics_events', 'envelope_metrics_snapshot', 'envelope_output_retention', 'envelope_recall_output', 'envelope_search_fragments', 'envelope_search_output', 'envelope_workflow_claim', 'envelope_workflow_create', 'envelope_workflow_events', 'envelope_workflow_finish', 'envelope_workflow_handoff', 'envelope_workflow_retry', 'envelope_workflow_review', 'envelope_workflow_run', 'envelope_workflow_status']);
  assert.ok(h.commands.has('envelope'));
});

test('shortens successful bash test noise and returns an exact recall identifier', async (t) => {
  const h = harness(t);
  const hook = h.handlers.get('tool_result')[0];
  const response = await hook({toolName:'bash',isError:false,content:[{type:'text',text:verboseTests}]},h.ctx);
  assert.ok(response?.content?.[0]?.text.length < verboseTests.length);
  assert.match(response.content[0].text,/Tests  90 passed/);
  const marker = response.content[0].text.match(/envelope_recall_output id=([a-f0-9]{64})/);
  assert.ok(marker, 'result contains exact recall key');
  const recall = await h.tools.get('envelope_recall_output').execute('call-1', {id:marker[1]}, undefined, undefined, h.ctx);
  assert.equal(recall.isError,false);
  assert.equal(recall.content[0].text, verboseTests);
  assert.equal(recall.details.bytes, Buffer.byteLength(verboseTests));
});

test('keeps errors, grep results, source reads, mixed parts and tiny messages identical', async (t) => {
  const h = harness(t);
  const hook = h.handlers.get('tool_result')[0];
  for (const event of [
    {toolName:'bash',isError:true,content:[{type:'text',text:verboseTests}]},
    {toolName:'grep',isError:false,content:[{type:'text',text:verboseTests}]},
    {toolName:'read',isError:false,content:[{type:'text',text:verboseTests}]},
    {toolName:'bash',isError:false,content:[{type:'text',text:'ok'}]},
    {toolName:'bash',isError:false,content:[{type:'image',data:'img'}]},
    {toolName:'bash',isError:false,content:[{type:'text',text:verboseTests},{type:'text',text:'extra'}]},
    {toolName:'bash',isError:false,structuredContent:{signal:'must survive'},content:[{type:'text',text:verboseTests}]},
    {toolName:'bash',isError:false,details:{exitCode:2},content:[{type:'text',text:verboseTests}]}
  ]) {
    const result = await hook(event,h.ctx);
    assert.equal(result, undefined, `${event.toolName} must be left unchanged`);
  }
});

test('searches only the current project and refuses cross-project retrieval', async (t) => {
  const h = harness(t);
  const hook = h.handlers.get('tool_result')[0];
  const result = await hook({toolName:'bash',content:[{type:'text',text:verboseTests}]},h.ctx);
  const id = result.content[0].text.match(/id=([a-f0-9]{64})/)[1];
  const search = h.tools.get('envelope_search_output');
  const found = await search.execute('call-2',{query:'service fixtures'},undefined,undefined,h.ctx);
  assert.equal(found.isError,false);
  assert.match(found.content[0].text, new RegExp(id));
  const forbidden = await h.tools.get('envelope_recall_output').execute('call-3',{id},undefined,undefined,{cwd:'/repo/b'});
  assert.equal(forbidden.isError,true);
  assert.doesNotMatch(forbidden.content[0].text,/service 1 passes/);
});

test('output and concise policy are toggled independently, and prompt injection is idempotent', async (t) => {
  const h = harness(t);
  const before = h.handlers.get('before_agent_start')[0];
  assert.equal(await before({systemPrompt:'Base Pi prompt'},h.ctx),undefined);
  await h.commands.get('envelope').handler('policy on',h.ctx);
  assert.equal(readConfig(join(h.root,'state','settings.json')).policy.enabled,true);
  const once = await before({systemPrompt:'Base Pi prompt'},h.ctx);
  assert.match(once.systemPrompt,/ENVELOPE_POLICY/);
  assert.match(once.systemPrompt,/stdlib/);
  const twice = await before({systemPrompt:once.systemPrompt},h.ctx);
  assert.equal((twice.systemPrompt.match(/<ENVELOPE_POLICY>/g)||[]).length,1);
  await h.commands.get('envelope').handler('policy off',h.ctx);
  assert.equal(await before({systemPrompt:'Base Pi prompt'},h.ctx),undefined);
  await h.commands.get('envelope').handler('output off',h.ctx);
  assert.equal(await h.handlers.get('tool_result')[0]({toolName:'bash',content:[{type:'text',text:verboseTests}]},h.ctx),undefined);
  assert.ok(h.notices.some((n) => n.message.includes('policy on')));
});

test('storage failure returns full original rather than a partially compacted result', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'envelope-invalid-state-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'file'),'not a directory');
  const h = harness(t, {home:join(root,'file')});
  const result = await h.handlers.get('tool_result')[0]({toolName:'bash',content:[{type:'text',text:verboseTests}]},h.ctx);
  assert.equal(result,undefined);
});

test('integrates into Tersio shared settings without erasing existing modes or host overrides', async (t) => {
  const h = harness(t);
  const settingsPath = join(h.root,'state','settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    comboDefault: 'lite',
    hosts: { pi: { rtkDefault: 'on' } },
    envelope: { policy: { enabled: false } }
  }));
  await h.commands.get('envelope').handler('policy on', h.ctx);
  const file = JSON.parse((await import('node:fs')).readFileSync(settingsPath,'utf8'));
  assert.equal(file.comboDefault, 'lite');
  assert.equal(file.hosts.pi.rtkDefault, 'on');
  assert.equal(file.envelope.policy.enabled, true);
  assert.equal(readConfig(settingsPath).policy.enabled, true);
});


test('session shutdown closes the local database and compaction remains fail-open', async (t) => {
  const h = harness(t);
  await h.handlers.get('session_shutdown')[0]({reason:'reload'}, h.ctx);
  const result = await h.handlers.get('tool_result')[0]({toolName:'bash',content:[{type:'text',text:verboseTests}]}, h.ctx);
  assert.equal(result, undefined);
});

test('never compacts killed, aborted, signaled, timed-out, or incomplete shell results', async (t) => {
  const h = harness(t);
  const resultHook = h.handlers.get('tool_result')[0];
  const unsafe = [
    { code:0, killed:true },
    { exitCode:0, aborted:true },
    { exitCode:0, timedOut:true },
    { exitCode:0, signal:'SIGTERM' },
    { code:0, truncated:true },
    { code:0, status:'failed' },
    { code:0, error:'A child process died' }
  ];
  for (const details of unsafe) {
    assert.equal(await resultHook({toolName:'bash',isError:false,details,
      content:[{type:'text',text:verboseTests}]},h.ctx),undefined,`unsafe shell outcome ${JSON.stringify(details)}`);
  }
});

test('returns a project-scoped exact recall key when compacting around source anchors', async (t) => {
  const h = harness(t);
  const anchors = ['[L12] const unchanged = 1;', '12 # aBcD: unchanged code;', '13:hash|keep-this-original'];
  const original = ['RUN v3.1.0',...Array.from({length:120},(_,i)=>`  ✓ passing ${i}`),
    ...anchors,'Tests 120 passed (120)'].join('\r\n');
  const result = await h.handlers.get('tool_result')[0]({toolName:'bash',isError:false,
    details:{code:0},content:[{type:'text',text:original}]},h.ctx);
  assert.ok(result?.content?.[0]?.text);
  for(const line of anchors) assert.ok(result.content[0].text.includes(line));
  const id = result.content[0].text.match(/envelope_recall_output id=([a-f0-9]{64})/)?.[1];
  assert.ok(id);
  const recalled = await h.tools.get('envelope_recall_output').execute('call-anchor',{id},undefined,undefined,h.ctx);
  assert.equal(recalled.content[0].text,original);
  const denied = await h.tools.get('envelope_recall_output').execute('call-anchor',{id},undefined,undefined,{cwd:'/other/project'});
  assert.equal(denied.isError,true);
});
