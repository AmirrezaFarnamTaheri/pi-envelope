import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLspSession } from '../extensions/envelope/lsp-client.mjs';
const mock=fileURLToPath(new URL('./fixtures/mock-lsp-server.mjs',import.meta.url));
function setup(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'envelope-lsp-client-')));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'src'));writeFileSync(join(root,'src','a.ts'),'export function add(n:number) { return n+1; }\n');writeFileSync(join(root,'src','b.ts'),"import { add } from './a';\nexport const result=add(2);\n");return root;}
const opts=(root,mode='pull',timeoutMs=1200)=>({root,command:[process.execPath,mock,mode],timeoutMs});

test('pull diagnostics distinguish verified clean and genuine errors',async t=>{
 const root=setup(t),text=readFileSync(join(root,'src','a.ts'),'utf8');
 const clean=await withLspSession(opts(root),async s=>{await s.open('src/a.ts',text);return s.diagnostics('src/a.ts');});
 assert.equal(clean.status,'verified');assert.equal(clean.source,'pull');assert.deepEqual(clean.diagnostics,[]);
 const invalid=await withLspSession(opts(root,'errors'),async s=>{await s.open('src/a.ts',text);return s.diagnostics('src/a.ts');});
 assert.equal(invalid.status,'verified');assert.equal(invalid.diagnostics[0].severity,1);
});
test('push diagnostics are accepted only after didOpen for the active URI/version',async t=>{
 const root=setup(t);const seen=await withLspSession(opts(root,'push'),async s=>{await s.open('src/a.ts','export const a=1;');return s.diagnostics('src/a.ts');});
 assert.equal(seen.status,'verified');assert.equal(seen.source,'push');
});
test('missing diagnostics cannot be reported as clean',async t=>{
 const root=setup(t);const result=await withLspSession(opts(root,'unchanged'),async s=>{await s.open('src/a.ts','x');return s.diagnostics('src/a.ts');});
 assert.equal(result.status,'unverified');
});
test('timeouts, missing executables and hung initialization fail closed and terminate',async t=>{
 const root=setup(t);
 await assert.rejects(withLspSession(opts(root,'hang-init',160),async s=>s.diagnostics('src/a.ts')),/timeout/i);
 await assert.rejects(withLspSession({root,command:['envelope-missing-lsp-executable-xyz'],timeoutMs:200},async s=>s.diagnostics('src/a.ts')),/ENOENT|spawn|not found/i);
 const no=await withLspSession(opts(root,'hang-diagnostics',160),async s=>{await s.open('src/a.ts','x');return s.diagnostics('src/a.ts');});
 assert.equal(no.status,'unverified');
});
test('LSP rename request returns WorkspaceEdit but never modifies files',async t=>{
 const root=setup(t);const before=readFileSync(join(root,'src','a.ts'),'utf8');
 const edit=await withLspSession(opts(root),async s=>{await s.open('src/a.ts',before);return s.rename('src/a.ts',1,17,'multiply');});
 assert.equal(Object.keys(edit.changes).length,2);assert.equal(readFileSync(join(root,'src','a.ts'),'utf8'),before);
});

test('stale push version and related documents cannot produce verified clean reports',async t=>{
 const root=setup(t);
 const stale=await withLspSession(opts(root,'push-stale',140),async s=>{await s.open('src/a.ts','x');return s.diagnostics('src/a.ts');});
 assert.equal(stale.status,'unverified');
 const related=await withLspSession(opts(root,'related'),async s=>{await s.open('src/a.ts','x');return s.diagnostics('src/a.ts');});
 assert.equal(related.status,'unverified');
});


test('definition and references return bounded local source locations from an advertised LSP provider',async t=>{
 const root=setup(t),text=readFileSync(join(root,'src','a.ts'),'utf8');
 const result=await withLspSession(opts(root),async s=>{
   await s.open('src/a.ts',text);
   return {definition:await s.locations('definition','src/a.ts',1,17),
     references:await s.locations('references','src/a.ts',1,17)};
 });
 assert.equal(result.definition.status,'verified');
 assert.equal(result.definition.locations.length,1);
 assert.equal(result.references.status,'verified');
 assert.equal(result.references.locations.length,2);
 assert.equal(result.definition.locations[0].range.start.line,0);
});

test('unsupported or foreign LSP navigation remains unverified rather than implying a complete graph',async t=>{
 const root=setup(t),text=readFileSync(join(root,'src','a.ts'),'utf8');
 const unsupported=await withLspSession(opts(root,'nav-unsupported'),async s=>{
   await s.open('src/a.ts',text);return s.locations('references','src/a.ts',1,17);
 });
 assert.equal(unsupported.status,'unverified');
 const foreign=await withLspSession(opts(root,'nav-outside'),async s=>{
   await s.open('src/a.ts',text);return s.locations('definition','src/a.ts',1,17);
 });
 assert.equal(foreign.status,'unverified');
 assert.deepEqual(foreign.locations,[]);
});
