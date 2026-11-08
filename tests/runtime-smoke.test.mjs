import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { probeRuntime, probePiRpc } from '../scripts/smoke-runtime.mjs';
import { lspLanguageId } from '../extensions/envelope/lsp-client.mjs';

const upstream={version:'2.25.18',extensions:['./extensions/commands/commands.ts','./extensions/combo/combo.ts'],skills:['./extensions/ponytail/skills']};
function fixture(t,{ready=true,mode='normal'}={}){
 const root=mkdtempSync(join(tmpdir(),'envelope-runtime-smoke-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'fixtures'));writeFileSync(join(root,'fixtures','tersio-pi-manifest.json'),JSON.stringify(upstream));
 writeFileSync(join(root,'package.json'),JSON.stringify({dependencies:{typescript:'5.8.3'}}));
 const src=join(root,'extensions/envelope/index.js');mkdirSync(dirname(src),{recursive:true});writeFileSync(src,'export default function(){}\n');
 if(ready){
   const where=join(root,'node_modules/@krtclcdy/tersio');mkdirSync(where,{recursive:true});
   writeFileSync(join(where,'package.json'),JSON.stringify({version:upstream.version,pi:{extensions:upstream.extensions,skills:upstream.skills}}));
   for(const p of upstream.extensions){const fp=join(where,p);mkdirSync(dirname(fp),{recursive:true});writeFileSync(fp,'export default function(){}');}
   mkdirSync(join(where,upstream.skills[0]),{recursive:true});
   const ts=join(root,'node_modules/typescript/lib');mkdirSync(ts,{recursive:true});writeFileSync(join(dirname(ts),'package.json'),JSON.stringify({version:'5.8.3'}));writeFileSync(join(ts,'typescript.js'),'exports.x=1;\n');
 }
 const script=join(root,'fake-pi.mjs');
 writeFileSync(script,`import process from 'node:process';\nif(process.argv.includes('--version')){ console.log('fake-pi 1.0');process.exit(0); }\nlet buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',(chunk)=>{buffer+=chunk;for(;;){const index=buffer.indexOf('\\n');if(index<0)break;const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;const req=JSON.parse(line);if('${mode}'==='hang')continue;if('${mode}'==='malformed'){process.stdout.write('not-json\\n');continue;}const commands='${mode}'==='missing-envelope'?[{name:'tersio',source:'extension'}]:
  '${mode}'==='duplicate-envelope'?[{name:'envelope',source:'extension'},{name:'envelope',source:'extension'},{name:'tersio',source:'extension'}]:
  [{name:'envelope',source:'extension'},{name:'tersio',source:'extension'}];process.stdout.write(JSON.stringify({id:req.id,type:'response',command:'get_commands',success:true,data:{commands}})+'\\n');}});`);
 return {root,script};
}

test('runtime readiness is blocked when Tersio is not materialized; does not claim ready',async t=>{
 const {root,script}=fixture(t,{ready:false});
 const result=await probeRuntime({root,piCommand:process.execPath,piPrefixArgs:[script]});
 assert.equal(result.status,'blocked');assert.ok(result.checks.some(x=>x.name==='tersio'&&!x.ok));
});

test('valid isolated RPC command discovery requires both Envelope and Tersio',async t=>{
 const {root,script}=fixture(t);
 const result=await probeRuntime({root,piCommand:process.execPath,piPrefixArgs:[script]});
 assert.equal(result.status,'ready',JSON.stringify(result));assert.ok(result.checks.every(x=>x.ok));
});

test('RPC malformed lines, missing commands, and hung child fail or time out rather than pass',async t=>{
 for(const mode of ['malformed','missing-envelope','duplicate-envelope','hang']){
   const {root,script}=fixture(t,{mode});
   const result=await probePiRpc({root,piCommand:process.execPath,piPrefixArgs:[script],upstream,timeoutMs:mode==='hang'?350:2500});
   assert.equal(result.ok,false,mode);
 }
});

test('language-id mapping covers Python, Go and real clangd C-family documents',()=>{
 assert.equal(lspLanguageId('src/main.c'),'c');
 assert.equal(lspLanguageId('src/main.cpp'),'cpp');
 assert.equal(lspLanguageId('src/main.go'),'go');
 assert.equal(lspLanguageId('src/main.py'),'python');
 assert.equal(lspLanguageId('src/a.tsx'),'typescriptreact');
});
