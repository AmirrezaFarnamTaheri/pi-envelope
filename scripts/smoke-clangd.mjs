/** Read-only production LSP smoke; checks actual clangd, not a protocol stub. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { withLspSession } from '../extensions/envelope/lsp-client.mjs';

export async function probeClangd({command=['clangd','--background-index=false','--log=error'],timeoutMs=5000}={}){
  if(!Array.isArray(command)||!command[0])return {status:'blocked',reason:'No clangd command configured'};
  const availability=spawnSync(command[0],['--version'],{encoding:'utf8',timeout:3000,maxBuffer:50000,shell:false});
  if(availability.error||availability.status!==0)return {status:'blocked',reason:'Real clangd executable not installed'};
  const root=mkdtempSync(join(tmpdir(),'envelope-clangd-smoke-'));
  const sources={
    'valid.c':'int add(int a, int b) { return a + b; }\n',
    'invalid.c':'int main(void) { return missing_identifier; }\n'
  };
  try{
    for(const [path,content] of Object.entries(sources))writeFileSync(join(root,path),content,{mode:0o600});
    const result={};
    for(const [path,content] of Object.entries(sources)){
      const diagnostics=await withLspSession({root,command,timeoutMs},async session=>{
        await session.open(path,content);
        return session.diagnostics(path);
      });
      result[path==='valid.c'?'valid':'invalid']=diagnostics;
    }
    const good=result.valid?.status==='verified'&&result.valid.diagnostics.length===0;
    const bad=result.invalid?.status==='verified'&&result.invalid.diagnostics.some(x=>x.severity===1);
    return {status:good&&bad?'ready':'failed',valid:result.valid,invalid:result.invalid};
  }catch{return {status:'failed',reason:'Real clangd session or diagnostic check failed'};}
  finally{rmSync(root,{recursive:true,force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await probeClangd();
  console.log(JSON.stringify(report,null,2));
  if(report.status!=='ready')process.exitCode=report.status==='blocked'?2:1;
}
