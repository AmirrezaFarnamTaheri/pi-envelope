import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {listSyntaxFiles} from '../scripts/check-syntax.mjs';
const read=(p)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const pkg=JSON.parse(read('package.json'));

test('current release keeps one Pi code extension and syntax-checks the shared call evidence module',()=>{
 assert.equal(pkg.version,'0.20.0');
 assert.equal(pkg.pi.extensions.filter(x=>x==='./extensions/envelope/index.js').length,1);
 assert.equal(pkg.pi.extensions.length,9);
 assert.ok(listSyntaxFiles().includes('extensions/envelope/code-call-evidence.mjs'));
 assert.ok(existsSync(new URL('../extensions/envelope/code-call-evidence.mjs',import.meta.url)));
 assert.ok(!pkg.dependencies.neo4j&&!pkg.dependencies['typescript-language-server']);
});

test('call evidence documentation states bounded syntactic evidence and partial graph limits',()=>{
 const doc=read('docs/CALL_EVIDENCE.md');
 for(const term of ['envelope_code_calls','syntactic','shadow','ambiguous','incomplete','Python','Go','unverified'])assert.match(doc,new RegExp(term,'i'));
 assert.match(read('README.md'),/envelope_code_calls/);
 assert.match(read('docs/ALL_33_SOURCE_AUDIT.md'),/RepoPilot/);
});
