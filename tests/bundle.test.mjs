import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyUpstreamBundle, verifyAstParserBundle } from '../scripts/verify-bundle.mjs';

function staged(t) {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-bundle-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  return dir;
}

const upstream = {
  version:'2.25.18',
  pi:{extensions:['./extensions/rtk/session.ts','./extensions/rtk/filter.ts'], skills:['./extensions/ponytail/skills']}
};

function stageValid(root) {
  const where = join(root,'node_modules/@krtclcdy/tersio');
  mkdirSync(where,{recursive:true});
  writeFileSync(join(where,'package.json'),JSON.stringify(upstream));
  for(const file of upstream.pi.extensions) {
    const at = join(where,file);
    mkdirSync(dirname(at),{recursive:true});
    writeFileSync(at,'export default function() {}\n');
  }
  mkdirSync(join(where,'extensions/ponytail/skills'),{recursive:true});
  return where;
}

test('reports missing bundled source instead of claiming a valid Pi install', (t) => {
  const root=staged(t);
  const result = verifyUpstreamBundle(root, upstream);
  assert.equal(result.ok,false);
  assert.match(result.errors.join(' '), /not installed/);
});

test('accepts an exact bundled source and reports version or missing-file drift', (t) => {
  const root=staged(t);
  const where=stageValid(root);
  assert.equal(verifyUpstreamBundle(root,upstream).ok,true);
  writeFileSync(join(where,'package.json'),JSON.stringify({...upstream,version:'2.25.19'}));
  assert.match(verifyUpstreamBundle(root,upstream).errors.join(' '),/version/i);
});


test('bundle doctor verifies the actual pinned TypeScript runtime is materialized', (t) => {
  const root=staged(t);
  assert.equal(verifyAstParserBundle(root,'5.8.3').ok,false);
  const where=join(root,'node_modules/typescript');
  mkdirSync(join(where,'lib'),{recursive:true});
  writeFileSync(join(where,'package.json'),JSON.stringify({version:'5.8.2'}));
  writeFileSync(join(where,'lib','typescript.js'),'module.exports = {};\n');
  assert.match(verifyAstParserBundle(root,'5.8.3').errors.join(' '),/version mismatch/i);
  writeFileSync(join(where,'package.json'),JSON.stringify({version:'5.8.3'}));
  assert.equal(verifyAstParserBundle(root,'5.8.3').ok,true);
  rmSync(join(where,'lib','typescript.js'));
  assert.match(verifyAstParserBundle(root,'5.8.3').errors.join(' '),/missing.*parser/i);
});

test('bundle doctor rejects resource symlinks that escape the dependency root',t=>{
  const root=staged(t);
  const where=stageValid(root);
  const outside=join(root,'outside.ts');
  writeFileSync(outside,'export default function() {}\n');
  rmSync(join(where,'extensions/rtk/filter.ts'));
  symlinkSync(outside,join(where,'extensions/rtk/filter.ts'));
  const result=verifyUpstreamBundle(root,upstream);
  assert.equal(result.ok,false);
  assert.match(result.errors.join(' '),/symlink|escape|outside|unsafe/i);
});
