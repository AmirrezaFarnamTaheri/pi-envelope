/**
 * Real WebAssembly Tree-sitter smoke. No fake runtime, network or model calls.
 * Exit: 0 = JS/Python/Go grammars parsed and captured; 2 = prerequisites
 * missing; 1 = installed runtime or grammar behaved incorrectly.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';
import { TreeSitterBroker } from '../extensions/envelope/tree-sitter-broker.mjs';

const root=mkdtempSync(join(tmpdir(),'envelope-tree-real-smoke-'));
try {
  mkdirSync(join(root,'src'));
  const fixtures=[
    {path:'src/fixture.js',content:'function treeJavascript() { return 1; }\n',name:'treeJavascript',language:'javascript'},
    {path:'src/fixture.py',content:'def treePython():\n    return 2\n',name:'treePython',language:'python'},
    {path:'src/fixture.go',content:'package fixtures\nfunc treeGo() int { return 3 }\n',name:'treeGo',language:'go'}
  ];
  for(const fixture of fixtures)writeFileSync(join(root,fixture.path),fixture.content);
  let ts;
  try {const mod=await import('typescript');ts=mod.default||mod;}
  catch(err){console.error('BLOCKED: TypeScript AST dependency not installed: '+err.message);process.exitCode=2;}
  if(ts){
    const broker=new TreeSitterBroker();
    const ready=await broker.availability();
    if(!ready.available){
      console.error('BLOCKED: Real Tree-sitter WASM engine not installed: '+ready.reason);
      process.exitCode=2;
    }else{
      const index=new CodeIndex(root,{ts,languagesEnabled:true,maxFiles:20});
      index.refresh();
      if(fixtures.some(f=>!index.files.has(f.path))){
        console.error('BLOCKED: local Python/Go AST toolchains unavailable; check `python3` and `go`');
        process.exitCode=2;
      }else{
        const reports=[];
        for(const fixture of fixtures){
          try {
            const output=await broker.run(index,{path:fixture.path,mode:'capture',group:'functions',limit:5});
            if(output.language!==fixture.language||output.truncated||!output.captures.some(c=>c.text===fixture.name)){
              throw new Error(`expected ${fixture.name} capture; got ${JSON.stringify(output.captures)}`);
            }
            reports.push({language:fixture.language,ok:true,captures:output.captures.length});
          }catch(err){
            const reason=String(err.message);
            console.error((/grammar unavailable|not found|ENOENT/i.test(reason)?'BLOCKED':'FAIL')+`: ${fixture.language}: ${reason}`);
            process.exitCode=/grammar unavailable|not found|ENOENT/i.test(reason)?2:1;
            break;
          }
        }
        if(!process.exitCode)console.log(JSON.stringify({ok:true,engine:'web-tree-sitter',fixtures:reports},null,2));
      }
    }
  }
}finally {rmSync(root,{recursive:true,force:true});}
