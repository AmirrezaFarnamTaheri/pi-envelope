#!/usr/bin/env node
/** Opt-in architecture CI gate. Never runs automatically or invokes models. */
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {evaluateArchitecturePolicy} from '../extensions/envelope/architecture-policy.mjs';
try{
 if(process.argv.length!==2)throw new Error('usage: node scripts/architecture-gate.mjs (from the project root)');
 const root=realpathSync(process.cwd());
 const folder=join(root,'.envelope'),path=join(folder,'architecture-policy.json');
 if(lstatSync(folder).isSymbolicLink()||!lstatSync(folder).isDirectory()||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error('policy path is not a safe project-local regular file');
 const stat=lstatSync(path);if(stat.size>16384)throw new Error('policy exceeds 16 KiB');
 const policy=JSON.parse(readFileSync(path,'utf8'));
 if(!policy||typeof policy!=='object'||Array.isArray(policy)||policy.version!==1)throw new Error('unsupported architecture policy version');
 for(const key of Object.keys(policy))if(!['version','rules','relation','maxIncomingFiles','requireComplete','limit'].includes(key))throw new Error('unknown architecture policy property');
 const index=new CodeIndex(root,{ts,maxFiles:1000,maxBytesPerFile:512_000,languagesEnabled:false});
 index.refresh();
 const report=evaluateArchitecturePolicy(index,policy);
 process.stdout.write(JSON.stringify(report)+'\n');
 process.exitCode=report.pass?0:1;
}catch(error){
 process.stderr.write('Architecture gate: '+(error.code||'invalid-configuration-or-evidence')+'\n');
 process.exitCode=2;
}
