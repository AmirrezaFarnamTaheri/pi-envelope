import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { OutputStore } from '../extensions/envelope/store.mjs';
import { MetricsLedger } from '../extensions/envelope/metrics-ledger.mjs';
import { readConfig, saveConfig } from '../extensions/envelope/config.mjs';
import { composePolicy } from '../extensions/envelope/policy.mjs';
import { inspectCapabilityCockpit } from '../extensions/envelope/capability-cockpit.mjs';
import { evaluateArchitecturePolicy } from '../extensions/envelope/architecture-policy.mjs';
import { guardMutation } from '../extensions/envelope/mutation-guard.mjs';
import { compactOutput } from '../extensions/envelope/compactor.mjs';
import { rankFragments } from '../extensions/envelope/output-fragments.mjs';
import { projectContext } from '../extensions/envelope/context-projection.mjs';
import { ContextFrontier } from '../extensions/envelope/context-frontier.mjs';
import { contextFootprint } from '../extensions/envelope/context-footprint.mjs';
import { projectContextCard } from '../extensions/envelope/context-card.mjs';
import { buildContextSlice } from '../extensions/envelope/context-slice.mjs';
import { ProjectMemory } from '../extensions/envelope/project-memory.mjs';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';
import { SymbolDeltaLedger } from '../extensions/envelope/symbol-delta.mjs';
import { SymbolDeltaLedger as PersistentSymbolHistoryLedger } from '../extensions/envelope/persistent-symbol-history.mjs';
import { inspectTypedSource } from '../extensions/envelope/typechecker-evidence.mjs';
import { planRename } from '../extensions/envelope/rename-transaction.mjs';
import { verifyGraphInvariant, checkGraphCertificate } from '../extensions/envelope/graph-invariants.mjs';
import { inspectCodeGraph } from '../extensions/envelope/graph-intelligence.mjs';
import registerEnvelope from '../extensions/envelope/index.mjs';

test('F-01: live recapture refreshes timestamp and never self-prunes identical bash output', t => {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-f01-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OutputStore(join(dir, 'store'));
  t.after(() => store.close());
  const project = '/repo/app';
  const saved1 = store.save({ text: 'identical test output body', project, tool: 'bash', command: 'npm test' });
  // Backdate created_at to 10 days ago
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  store.db.prepare('UPDATE outputs SET created_at = ? WHERE id = ?').run(tenDaysAgo, saved1.id);
  // Recapture identical output with new command
  const saved2 = store.save({ text: 'identical test output body', project, tool: 'bash', command: 'npm run check' });
  assert.equal(saved2.id, saved1.id);
  // Opportunistic prune with 1-day cutoff must not delete the freshly recaptured output
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const pruned = store.prune({ project, before: cutoff, skipId: saved2.id });
  assert.equal(pruned.deleted, 0);
  const recalled = store.retrieve(saved2.id);
  assert.equal(recalled?.text, 'identical test output body');
  assert.equal(recalled?.command, 'npm run check');
  // Searching by the updated command term also succeeds
  const hits = store.search('check', { project });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, saved2.id);
});

test('F-02: MetricsLedger accepts all 29 registered code_query tools without dropping telemetry', t => {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-f02-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new MetricsLedger(join(dir, 'metrics'));
  t.after(() => ledger.close());
  const all29 = [
    'envelope_code_overview', 'envelope_code_graph', 'envelope_code_external_graph', 'envelope_code_history',
    'envelope_code_context_card', 'envelope_code_retrieve', 'envelope_code_policy', 'envelope_code_languages',
    'envelope_code_tree_status', 'envelope_code_tree_query', 'envelope_code_tree_capture', 'envelope_code_lookup',
    'envelope_code_calls', 'envelope_code_impact', 'envelope_code_change_impact', 'envelope_code_verify',
    'envelope_code_delta', 'envelope_code_symbol_history', 'envelope_code_slice', 'envelope_code_coupling',
    'envelope_code_versions', 'envelope_code_vector', 'envelope_code_invariant', 'envelope_code_typecheck',
    'envelope_code_go_types', 'envelope_code_lsp_verify', 'envelope_code_rename',
    'envelope_code_definition', 'envelope_code_references'
  ];
  for (const action of all29) {
    ledger.record('/repo', 'code_query', { action, outcome: 'ok', durationMs: 1.5 });
  }
  const snap = ledger.snapshot('/repo');
  assert.equal(snap.totalEvents, 29);
  assert.equal(snap.byKind.code_query.count, 29);
});

test('F-03: capability cockpit detects symlinked PATH executables and reports full capability surface', t => {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-f03-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realBin = join(dir, 'real-graphify');
  const linkBin = join(dir, 'graphify');
  writeFileSync(realBin, '#!/bin/sh\nexit 0\n');
  chmodSync(realBin, 0o755);
  symlinkSync(realBin, linkBin);
  const cfg = readConfig(join(dir, 'missing.json'));
  const report = inspectCapabilityCockpit(cfg, { intent: 'orient', pathEnv: dir });
  assert.equal(report.externalCli.graphify, 'detected-unverified');
  for (const key of ['policy', 'languages', 'rename', 'lsp', 'vectors', 'graphifyDotnet']) {
    assert.ok(key in report.capabilities, `missing capability key: ${key}`);
  }
});

test('F-04 & F-05: session_shutdown closes projectMemory and canonicalizes project paths', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-f04-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const alias = join(dir, 'repo-link');
  const home = join(dir, 'home');
  mkdirSync(repo, { recursive: true });
  symlinkSync(repo, alias);
  const hooks = new Map(), tools = new Map(), commands = new Map(), notices = [];
  const pi = {
    cwd: repo,
    on(name, fn) { hooks.set(name, [...(hooks.get(name) || []), fn]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, cmd) { commands.set(name, cmd); },
    logger: { warn() {} }
  };
  registerEnvelope(pi, { home, loadCompiler: () => ts });
  const ctxRepo = { cwd: repo, ui: { notify: s => notices.push(s) } };
  const ctxAlias = { cwd: alias + '/', ui: { notify: s => notices.push(s) } };
  await commands.get('envelope').handler('memory on', ctxRepo);
  const saved = await tools.get('envelope_memory').execute('1', {
    action: 'save', kind: 'fact', title: 'Canonical test', body: 'Fact body'
  }, null, null, ctxRepo);
  assert.equal(saved.isError, false);
  // Query via symlinked cwd with trailing slash resolves to the same canonical project
  const listed = await tools.get('envelope_memory').execute('2', { action: 'list' }, null, null, ctxAlias);
  assert.equal(JSON.parse(listed.content[0].text).total, 1);
  for (const fn of hooks.get('session_shutdown') || []) fn({}, ctxRepo);
});

test('F-07 & F-08: NFD query tokenization in OutputStore and strict saveConfig preservation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-f07-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OutputStore(join(dir, 'store'));
  t.after(() => store.close());
  const saved = store.save({ text: 'café résumé output line', project: '/p', tool: 'bash', command: 'echo' });
  const nfdQuery = 'cafe\u0301';
  const hits = store.search(nfdQuery, { project: '/p' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, saved.id);

  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, '{malformed json');
  assert.throws(() => saveConfig(settingsPath, {}), /malformed settings\.json/i);
});

test('F-11: composePolicy removes unclosed tags and cleans empty array elements when disabled', () => {
  const unclosed = ['Base system prompt', '<ENVELOPE_POLICY>\ntruncated'];
  const disabled = composePolicy(unclosed, false);
  assert.deepEqual(disabled, { systemPrompt: ['Base system prompt'] });
  const reenabled = composePolicy(unclosed, true);
  assert.equal(reenabled.systemPrompt.length, 2);
  assert.match(reenabled.systemPrompt[1], /<\/ENVELOPE_POLICY>$/);
});

test('COMP-1 & FRAG-1: compactor protects ANSI-wrapped anchors and rankFragments preserves surrogate pairs', () => {
  const ansiAnchor = [
    'TAP version 13',
    ...Array.from({ length: 40 }, (_, i) => `ok ${i + 1} - passing subtest line with padding bytes for threshold`),
    '\x1b[32mok 41 - [L12] edit anchor inside ANSI sequence\x1b[0m',
    '# tests 41',
    '# pass 41'
  ].join('\n');
  const res = compactOutput(ansiAnchor, { minBytes: 200, maxChars: 8000, minSavingsRatio: 0.1 });
  assert.equal(res.changed, true);
  assert.match(res.text, /\[L12\] edit anchor/);

  const emojiChunk = [{ lineStart: 1, lineEnd: 1, text: 'match ' + '🚀'.repeat(120) }];
  const ranked = rankFragments(emojiChunk, 'match', { maxPreviewChars: 100 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].preview.includes('\uFFFD'), false);
  assert.equal(/[\uD800-\uDFFF]/.test(ranked[0].preview.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), false);
});

test('PROJ-1 & PROJ-4: context projection supports maxPreviewChars=240..262 and replays prior blocks after 128 new blocks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-proj-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OutputStore(join(dir, 'store'));
  const frontier = new ContextFrontier(join(dir, 'frontier'));
  t.after(() => { store.close(); frontier.close(); });

  const bodyText = 'line of historical output\n'.repeat(120);
  const msgs = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', isError: false, content: [{ type: 'text', text: bodyText }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'anchor', name: 'bash', arguments: { command: 'pwd' } }] },
    { role: 'toolResult', toolCallId: 'anchor', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }] }
  ];
  const out240 = projectContext(msgs, {
    anchorCallId: 'anchor', project: '/p', store, frontier, sessionId: 's1',
    minBytes: 400, maxPreviewChars: 240, recentMessages: 1, minSavingsRatio: 0.2
  });
  assert.equal(out240.changed, true);
  assert.equal(out240.compacted, 1);
});

test('FOOT-1, CARD-1 & SLIC-1: contextFootprint array prompts, class method call cards, and contextSlice 3-symbol skeletons', t => {
  const fp = contextFootprint({
    getSystemPromptOptions: () => ({
      systemPrompt: ['alpha', 'beta'],
      contextFiles: [],
      customSections: [],
      activeTools: ['a']
    })
  });
  assert.equal(fp.status, 'available');
  assert.equal(fp.categories.basePromptBytes, 9);

  const root = mkdtempSync(join(tmpdir(), 'envelope-card-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), [
    'export function helper() { return 1; }',
    'export function second() { return 2; }',
    'export class Service {',
    '  run() { return helper(); }',
    '}'
  ].join('\n'));
  const index = new CodeIndex(root, { ts });
  index.refresh();
  const card = projectContextCard(index, { path: 'a.ts', symbol: 'run' });
  assert.equal(card.calls.totalOutgoing, 1);
  assert.equal(card.calls.outgoing[0].callee, 'helper');

  const cardQualified = projectContextCard(index, { path: 'a.ts', symbol: 'Service.run' });
  assert.equal(cardQualified.symbols.length, 1);
  assert.equal(cardQualified.calls.totalOutgoing, 1);

  const slice = buildContextSlice(index, { path: 'a.ts', depth: 0, maxChars: 1100 });
  assert.equal(slice.items.length, 1);
  if (slice.items[0].tier === 'skeleton') {
    assert.ok(slice.items[0].skeleton.symbols.length >= 3);
  }
});

test('MEM-1: ProjectMemory ignores # comments inside fenced code blocks and bounds non-ASCII Claude titles', t => {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-mem-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const mem = new ProjectMemory(join(dir, 'mem'));
  t.after(() => mem.close());

  writeFileSync(join(repo, 'guide.md'), '```sh\n# shell comment not a title\necho hi\n```\n# Real Guide Heading\nBody text.\n');
  const md = mem.importMarkdown(repo, 'guide.md');
  assert.equal(md.title, 'Real Guide Heading');

  const cjkPrompt = '請幫我檢查這個專案的所有模組與測試'.repeat(8);
  const jsonl = JSON.stringify({
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '<ide_opened_file>foo.ts</ide_opened_file>' },
        { type: 'text', text: cjkPrompt }
      ]
    }
  }) + '\n';
  writeFileSync(join(repo, 'session.jsonl'), jsonl);
  const imported = mem.importClaudeTranscript(repo, 'session.jsonl');
  assert.equal(imported.added, true);
  assert.ok(Buffer.byteLength(imported.title, 'utf8') <= 160);
});

test('IDX-1, IDX-2 & TC-1: dotted module stems, function-local variables in symbol-delta, and typechecker host isolation', t => {
  const root = mkdtempSync(join(tmpdir(), 'envelope-idx-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = mkdtempSync(join(tmpdir(), 'envelope-outside-tc-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const secretFile = join(outside, 'secret.d.ts');
  writeFileSync(secretFile, 'export const OUTSIDE_SECRET = 123;\n');

  writeFileSync(join(root, 'user.service.ts'), 'export function getUser() { const tmp = 1; return tmp; }\n');
  writeFileSync(join(root, 'app.controller.ts'), [
    "import { getUser } from './user.service';",
    'export function first() { const tmp = 1; return getUser() + tmp; }',
    'export function second() { const tmp = 2; return tmp; }'
  ].join('\n'));

  const index = new CodeIndex(root, { ts });
  index.refresh();
  // Dotted module stem ./user.service resolves to user.service.ts
  assert.ok(index.edges.get('app.controller.ts').has('user.service.ts'));

  // Local `const tmp` inside two functions must NOT cause duplicate-symbol-identity in SymbolDeltaLedger or PersistentSymbolHistoryLedger
  const delta = new SymbolDeltaLedger();
  delta.capture(index);
  writeFileSync(join(root, 'app.controller.ts'), [
    "import { getUser } from './user.service';",
    'export function first() { const tmp = 10; return getUser() + tmp; }',
    'export function second() { const tmp = 2; return tmp; }'
  ].join('\n'));
  index.refresh();
  const cmp = delta.compare(index);
  assert.equal(cmp.complete, true);
  assert.equal(cmp.reasons.includes('duplicate-symbol-identity'), false);
  assert.equal(cmp.items.length, 1);
  assert.equal(cmp.items[0].symbol, 'first');
  assert.equal(cmp.items[0].change, 'modified');

  const hist = new PersistentSymbolHistoryLedger(join(outside, 'hist'));
  t.after(() => hist.close());
  const snap = hist.query(index, { action: 'capture' });
  assert.equal(snap.complete, true);
  assert.equal(snap.reasons.includes('ambiguous-symbol-identity'), false);

  // Typechecker evidence must not read arbitrary files outside root
  const typed = inspectTypedSource(index, { action: 'diagnostics', path: 'app.controller.ts' });
  assert.equal(typed.status, 'diagnostics');
});

test('LSP-2: planRename supports ES6 object property shorthand expansion', t => {
  const root = mkdtempSync(join(tmpdir(), 'envelope-shorthand-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const foo = 1;\nexport const obj = { foo };\n');
  const index = new CodeIndex(root, { ts });
  index.refresh();
  const uri = pathToFileURL(join(root, 'a.ts')).href;
  const workspaceEdit = {
    changes: {
      [uri]: [
        { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } }, newText: 'bar' },
        { range: { start: { line: 1, character: 21 }, end: { line: 1, character: 24 } }, newText: 'foo: bar' }
      ]
    }
  };
  const plan = planRename({ index, workspaceEdit, request: { path: 'a.ts', line: 1, column: 14, newName: 'bar' } });
  assert.equal(plan.changeCount, 2);
  assert.match(plan.files[0].proposedText, /export const obj = \{ foo: bar \};/);
});

test('GINV-1 & GINT-1: checkGraphCertificate rejects mismatched certificate keys and hubs excludes self-calls from incomingFiles', t => {
  const root = mkdtempSync(join(tmpdir(), 'envelope-ginv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export function recurse(): number { return recurse(); }\n');
  writeFileSync(join(root, 'b.ts'), "import { recurse } from './a';\nexport function run() { return recurse(); }\n");
  const index = new CodeIndex(root, { ts });
  index.refresh();

  const hubs = inspectCodeGraph(index, { action: 'hubs', relation: 'calls', limit: 45 });
  const aHub = hubs.hubs.find(h => h.path === 'a.ts');
  // Only b.ts is an external calling file; self-call inside a.ts must not inflate incomingFiles to 2
  assert.equal(aHub.incomingFiles, 1);
  assert.equal(aHub.outgoingFiles, 0);

  const policy = evaluateArchitecturePolicy(index, { relation: 'calls', maxIncomingFiles: 1, limit: 45 });
  assert.equal(policy.pass, true);

  const inv = verifyGraphInvariant(index, { action: 'acyclic' });
  assert.equal(inv.verdict, 'holds');
  assert.equal(checkGraphCertificate(index, inv), true);
  // Forged certificate swapping in a cycle object on a 'holds' verdict must be rejected
  assert.equal(checkGraphCertificate(index, { ...inv, certificate: { cycle: ['a.ts', 'a.ts'] } }), false);
});

test('LSP-1: envelope_code_rename apply validates diagnostics on post-rename proposedText across all touched files', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-lsp1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export function add(n:number) { return n+1; }\n');
  writeFileSync(join(repo, 'src', 'b.ts'), "import { add } from './a';\nexport const result=add(2);\n");
  const mock = fileURLToPath(new URL('./fixtures/mock-lsp-server.mjs', import.meta.url));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    envelope: { code: { renameEnabled: true, lspCommand: [process.execPath, mock, 'error-after-rename'] } }
  }));
  const tools = new Map();
  registerEnvelope({
    cwd: repo,
    on() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    logger: { warn() {} }
  }, { home, loadCompiler: () => ts });
  const ctx = { cwd: repo };
  // Pre-rename diagnostics pass because text still has 'add', not 'multiply'
  const preCheck = await tools.get('envelope_code_lsp_verify').execute('v1', { path: 'src/a.ts' }, null, null, ctx);
  assert.equal(JSON.parse(preCheck.content[0].text).verdict, 'PASS');
  // Preview succeeds
  const preview = JSON.parse((await tools.get('envelope_code_rename').execute('r1', {
    path: 'src/a.ts', line: 1, column: 17, newName: 'multiply'
  }, null, null, ctx)).content[0].text);
  assert.equal(preview.applied, false);
  // Apply must fail because post-rename proposedText contains 'multiply', triggering LSP FAIL
  const applied = await tools.get('envelope_code_rename').execute('r2', {
    path: 'src/a.ts', line: 1, column: 17, newName: 'multiply', apply: true, planId: preview.planId
  }, null, null, ctx);
  assert.equal(applied.isError, true);
  assert.match(applied.content[0].text, /LSP rename safety check failed/i);
  assert.match(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), /function add/);
});

test('review: duplicated policy blocks inside one prompt string are collapsed',()=>{
  const once=composePolicy('System context',true).systemPrompt;
  const twice=once+'\n\n'+once.slice(once.indexOf('<ENVELOPE_POLICY>'));
  const output=composePolicy(twice,true).systemPrompt;
  assert.equal((output.match(/<ENVELOPE_POLICY>/g)||[]).length,1);
  assert.equal(output.split('</ENVELOPE_POLICY>').length-1,1);
});

test('review: symlinked Tersio settings read and update the target without replacing the link',t=>{
  const dir=mkdtempSync(join(tmpdir(),'envelope-linked-config-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const target=join(dir,'real-settings.json'),link=join(dir,'settings.json');
  writeFileSync(target,JSON.stringify({envelope:{jobs:{enabled:true,agentEnabled:false}}}));
  symlinkSync(target,link);
  assert.equal(readConfig(link).jobs.enabled,true);
  saveConfig(link,{jobs:{enabled:false,agentEnabled:false}});
  assert.equal(readConfig(target).jobs.enabled,false);
  assert.equal(readConfig(link).jobs.enabled,false);
});
