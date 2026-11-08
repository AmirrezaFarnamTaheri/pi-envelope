import test from 'node:test';
import assert from 'node:assert/strict';
import { compactOutput, isAnchorSensitive } from '../extensions/envelope/compactor.mjs';

const verboseTests = [
  'RUN v3.0.0 /repo',
  '✓ package/test/cache.test.ts (120 tests) 90ms',
  ...Array.from({ length: 90 }, (_, i) => `  ✓ cache routine ${i + 1} should report correct result (1 ms)`),
  'Test Files  1 passed (1)',
  'Tests  120 passed (120)',
  'Duration  1.02s'
].join('\n');

test('reduces repetitive successful test lines while retaining exact summary counts', () => {
  const result = compactOutput(verboseTests, { minBytes: 500, maxChars: 2200, minSavingsRatio: 0.1 });
  assert.equal(result.changed, true);
  assert.equal(result.category, 'tests');
  assert.match(result.text, /120 passed \(120\)/);
  assert.match(result.text, /repetitive test lines omitted/);
  assert.ok(result.renderedBytes < result.originalBytes);
  assert.ok(result.renderedBytes < 2200);
});

test('does not modify short, raw JSON, anchored source, or noisy unknown output', () => {
  const options = { minBytes: 60, maxChars: 300, minSavingsRatio: 0.1 };
  const examples = [
    'done',
    JSON.stringify({ results: Array.from({length:40}, (_,i) => ({value:i})) }, null, 2),
    '[L12] const alpha = 1;\n[L13] function setAlpha(value) { return value; }\n'.repeat(18),
    'important unclassified text\n'.repeat(150)
  ];
  for (const text of examples) {
    const result = compactOutput(text, options);
    assert.equal(result.changed, false);
    assert.equal(result.text, text);
  }
  assert.equal(isAnchorSensitive(examples[2]), true);
});

test('collapses long git status with a full, true count and bounded file preview', () => {
  const git = ['On branch main', 'Changes not staged for commit:',
    ...Array.from({length:80}, (_,i) => ` modified:   src/module-${i}.ts`),
    'no changes added to commit'].join('\n');
  const result = compactOutput(git, { minBytes: 500, maxChars: 1100, minSavingsRatio: 0.1 });
  assert.equal(result.changed, true);
  assert.equal(result.category, 'git');
  assert.match(result.text, /On branch main/);
  assert.match(result.text, /src\/module-0\.ts/);
  assert.match(result.text, /80 change entries/);
  assert.match(result.text, /additional entries omitted/);
});

test('retains error and warning lines verbatim instead of treating them as pass noise', () => {
  const output = ['Building 450 files...',
    ...Array.from({length:80}, (_,i) => `Compiling module ${i + 1}/80`),
    'src/main.ts:42:7 warning: deprecated use',
    'Build finished in 5s'].join('\n');
  const result = compactOutput(output, { minBytes: 500, maxChars: 1000, minSavingsRatio: 0.1 });
  assert.equal(result.changed, true);
  assert.match(result.text, /src\/main.ts:42:7 warning: deprecated use/);
  assert.match(result.text, /Build finished in 5s/);
});

test('keeps unicode intact and measurements in bytes, not JS string length', () => {
  const output = `✓ tests passed 🚀\n${'  ✓ 成功 test case\n'.repeat(110)}Tests 110 passed (110)`;
  const result = compactOutput(output, { minBytes: 400, maxChars: 900, minSavingsRatio: 0.1 });
  assert.equal(result.originalBytes, Buffer.byteLength(output));
  assert.ok(result.changed);
  assert.ok(result.renderedBytes <= 900);
  assert.match(result.text, /Tests 110 passed/);
});

test('compacts passing test noise around complete source anchors without touching anchors or diagnostics', () => {
  const protectedLines = [
    '[L12] const current = "✓ progress"; // edit anchor',
    '[L13] const next = { done: true };',
    '42 # aBcD12: export function demo() {}',
    '43:abc123|  // hashline content',
    '44ab| const sensitive = true;',
    'src/important.ts:15:3 warning: syntax check needs manual review'
  ];
  const original = ['RUN v3.0.0',
    ...Array.from({length:110}, (_,i)=>`  ✓ ordinary passing check ${i+1}`),
    ...protectedLines,
    'Tests 110 passed (110)', 'Duration 1.4s'].join('\n');
  const options = {minBytes:100,maxChars:2000,minSavingsRatio:0.1};
  assert.equal(isAnchorSensitive(original),true);
  const result = compactOutput(original,options);
  assert.equal(result.changed,true);
  assert.equal(result.category,'tests');
  assert.equal(result.omittedLines,110);
  for (const line of protectedLines) assert.ok(result.text.includes(line),`protected bytes lost: ${line}`);
  assert.match(result.text,/Tests 110 passed \(110\)/);
  assert.equal(compactOutput(result.text,options).changed,false,'repeated reduction must not mutate anchors');
});

test('keeps git diagnostics, branch headers and untracked annotations in their original order', () => {
  const messages = [
    'On branch audit',
    'Changes not staged for commit:',
    'early warning: do not delete local state',
    ...Array.from({length:55}, (_,i)=>` modified: src/file-${i}.ts`),
    'Untracked files:',
    'important verification: 3 conflicts require review',
    'fatal: prior run failed; inspect journal',
    'no changes added to commit'
  ];
  const result = compactOutput(messages.join('\n'), {minBytes:100,maxChars:1500,minSavingsRatio:0.1});
  assert.equal(result.changed,true);
  for (const needle of ['early warning: do not delete local state','Untracked files:',
    'important verification: 3 conflicts require review','fatal: prior run failed; inspect journal',
    'no changes added to commit']) assert.ok(result.text.includes(needle));
  assert.ok(result.text.indexOf('Untracked files:') < result.text.indexOf('important verification:'));
});

test('preserves CRLF, escape bytes, Unicode and all anchored lines exactly', () => {
  const critical = '\x1b[31merror: vérifier sortie 🚨\x1b[0m';
  const anchors = ['[L91] const résumé = "é";', '[L92] const exit = "\\x1b[0m";'];
  const source = ['RUN v3.5.0',...Array.from({length:92},(_,i)=>`\x1b[32m  ✓ passing ${i}\x1b[0m`),
    critical,...anchors,'Tests 92 passed (92)'].join('\r\n');
  const result = compactOutput(source,{minBytes:100,maxChars:1800,minSavingsRatio:0.1});
  assert.equal(result.changed,true);
  for(const line of [critical,...anchors]) assert.ok(result.text.includes(line));
  assert.match(result.text,/error: vérifier sortie 🚨/);
  assert.ok(result.text.includes(`${critical}\r\n${anchors[0]}\r\n${anchors[1]}\r\n`));
});

test('keeps raw output unchanged if preserved source and diagnostic lines exceed UTF-8 byte cap', () => {
  const protectedSource = Array.from({length:45}, (_,i)=>`[L${i+1}] const ${'語'.repeat(16)}_${i} = true;`);
  const input = ['RUN v3.5.0',...Array.from({length:80},(_,i)=>`  ✓ passing ${i}`),...protectedSource,'Tests 80 passed (80)'].join('\n');
  const reduced=compactOutput(input,{minBytes:100,maxChars:600,minSavingsRatio:0.1});
  assert.equal(reduced.changed,false);
  assert.equal(reduced.text,input);
});

test('keeps all deletion, rename and merge-conflict Git entries despite file-preview limits', () => {
  const critical=[' deleted: src/customer-data.ts',' renamed: src/config-old.ts -> src/config-new.ts',
    'UU src/merge-conflict.ts','AA src/add-add-conflict.ts',' D src/removal.ts'];
  const source=['On branch merge','Changes not staged for commit:',
    ...Array.from({length:80},(_,i)=>` modified: src/ordinary-${i}.ts`),...critical].join('\n');
  const result=compactOutput(source,{minBytes:100,maxChars:1700,minSavingsRatio:0.1});
  assert.equal(result.changed,true);
  for(const line of critical) assert.ok(result.text.includes(line),`critical git entry lost: ${line}`);
});
