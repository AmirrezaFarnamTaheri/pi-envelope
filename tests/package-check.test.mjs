import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listSyntaxFiles } from '../scripts/check-syntax.mjs';

const packageManifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
test('single syntax walker covers every native module including newly added features',()=>{
 const paths=listSyntaxFiles(new URL('../',import.meta.url));
 for(const modulePath of ['extensions/envelope/change-evidence.mjs','extensions/envelope/context-footprint.mjs',
   'extensions/envelope/output-fragments.mjs','extensions/envelope/index.js','scripts/smoke-runtime.mjs']){
   assert.ok(paths.includes(modulePath),`not checked: ${modulePath}`);
 }
 assert.equal(new Set(paths).size,paths.length);
 assert.ok(paths.every(path=>!path.includes('node_modules')));
 assert.match(packageManifest.scripts.check,/check-syntax\.mjs/);
});

test('strict release packaging requires a verified bundled runtime, separate from source dry run',()=>{
 assert.match(packageManifest.scripts['pack:check'],/doctor:bundle/);
 assert.match(packageManifest.scripts['pack:source-check'],/npm pack --dry-run/);
});
