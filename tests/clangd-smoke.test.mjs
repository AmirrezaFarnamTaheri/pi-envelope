import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { probeClangd } from '../scripts/smoke-clangd.mjs';

const present=spawnSync('clangd',['--version'],{timeout:3000}).status===0;
test('real clangd reports both clean and genuine C diagnostic evidence', {skip:!present},async()=>{
 const result=await probeClangd();
 assert.equal(result.status,'ready',JSON.stringify(result));
 assert.equal(result.valid.status,'verified');assert.deepEqual(result.valid.diagnostics,[]);
 assert.equal(result.invalid.status,'verified');
 assert.ok(result.invalid.diagnostics.some(x=>x.severity===1));
});

test('missing real clangd is a blocked smoke, never silently simulated PASS',async()=>{
 const result=await probeClangd({command:['envelope-clangd-not-installed']});
 assert.equal(result.status,'blocked');
});
