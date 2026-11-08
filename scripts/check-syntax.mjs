/** Exhaustive syntax check of shipped native JS modules; avoids a brittle filename list. */
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT=resolve(fileURLToPath(new URL('../',import.meta.url)));

export function listSyntaxFiles(root=ROOT){
  const base=resolve(root instanceof URL ? fileURLToPath(root) : root);
  const files=[];
  for(const folder of ['extensions','scripts']){
    const visit=(directory)=>{
      for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        if(entry.isSymbolicLink())continue;
        const file=join(directory,entry.name);
        if(entry.isDirectory())visit(file);
        else if(entry.isFile() && /\.(?:mjs|js)$/.test(entry.name))files.push(relative(base,file).split(sep).join('/'));
      }
    };
    visit(join(base,folder));
  }
  return files;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const files=listSyntaxFiles();
  for(const file of files){
    const checked=spawnSync(process.execPath,['--check',join(ROOT,file)],{encoding:'utf8',timeout:10_000,maxBuffer:100_000});
    if(checked.error || checked.status!==0){
      process.stderr.write(`Syntax check failed for ${file}: ${checked.error?.message||checked.stderr||checked.status}\n`);
      process.exitCode=1;
    }
  }
  if(!process.exitCode)console.log(`Syntax: ${files.length} native JavaScript modules checked`);
}
