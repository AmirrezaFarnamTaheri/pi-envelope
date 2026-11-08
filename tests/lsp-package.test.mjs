import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeConfig,readConfig,saveConfig} from '../extensions/envelope/config.mjs';
import {listSyntaxFiles} from '../scripts/check-syntax.mjs';
const read=(path)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('current distribution includes optional LSP and transaction modules in the single Envelope extension',()=>{
 const pkg=JSON.parse(read('package.json'));
 assert.equal(pkg.version,'0.16.0');
 assert.deepEqual(pkg.pi.extensions.filter(s=>s.endsWith('/envelope/index.js')),['./extensions/envelope/index.js']);
 for(const path of ['extensions/envelope/lsp-client.mjs','extensions/envelope/lsp-api.mjs','extensions/envelope/rename-transaction.mjs'])assert.ok(listSyntaxFiles().includes(path),path);
 assert.ok(!pkg.dependencies['vscode-jsonrpc']&&!pkg.dependencies['typescript-language-server']);
 assert.match(read('docs/LSP_RENAME.md'),/not.*crash-atomic|not.*crash.*atomic/i);
 assert.match(read('README.md'),/UNVERIFIED/);
});
test('manual LSP argv remains separate from model tool inputs and defaults to disabled',t=>{
 const config=normalizeConfig();
 assert.equal(config.code.renameEnabled,false);assert.equal(config.code.lspCommand,null);
 assert.equal(normalizeConfig({code:{lspCommand:['sh','-c','echo test'],renameEnabled:'yes'}}).code.renameEnabled,false);
 for(const invalid of [[],[42],[''],['bad\0name'],new Array(17).fill('x')])assert.equal(normalizeConfig({code:{lspCommand:invalid}}).code.lspCommand,null);
 const root=mkdtempSync(join(tmpdir(),'envelope-lsp-config-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'settings.json');writeFileSync(path,JSON.stringify({comboDefault:'balanced',envelope:{code:{lspCommand:['trusted-language-server','--stdio'],renameEnabled:true}}}));
 const changed=saveConfig(path,{...readConfig(path),policy:{enabled:true}});
 assert.deepEqual(changed.code.lspCommand,['trusted-language-server','--stdio']);
 assert.equal(readConfig(path).code.renameEnabled,true);
 assert.equal(JSON.parse(readFileSync(path,'utf8')).comboDefault,'balanced');
});
