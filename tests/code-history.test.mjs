import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,symlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {inspectCodeHistory} from '../extensions/envelope/code-history.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';
function run(root,cmd,args=[]){const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',timeout:3000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function project(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-cochange-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(path,content)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content)};
 run(root,'git',['init','-q']);
 const commit=(files,msg)=>{for(const [p,c] of Object.entries(files))put(p,c);run(root,'git',['add','.']);run(root,'git',['-c','user.email=audit@example.test','-c','user.name=Test Writer','commit','-qm',msg]);};
 commit({'src/a.ts':'export const a=1;\n','src/b.ts':'export const b=1;\n'},'first');
 commit({'src/a.ts':'export const a=2;\n','src/b.ts':'export const b=2;\n'},'paired');
 commit({'src/a.ts':'export const a=3;\n','src/c.ts':'export const c=3;\n'},'other');
 commit({'src/b.ts':'export const b=4;\n'},'solo');
 const index=new CodeIndex(root,{ts});index.refresh();return {root,index,put,commit};
}
test('co-change evidence is exact commit co-occurrence, not guessed causal dependency',t=>{
 const {root,index}=project(t);const tip=run(root,'git',['rev-parse','HEAD']);
 const report=inspectCodeHistory(index,{action:'cochange',path:'src/a.ts',limit:10,maxCommits:20});
 assert.deepEqual(report.related.map(r=>[r.path,r.sharedCommits]),[['src/b.ts',2],['src/c.ts',1]]);
 assert.equal(report.commitCount,4);
 assert.equal(report.complete,true);
 assert.match(report.mode,/historical/);
 assert.equal(run(root,'git',['rev-parse','HEAD']),tip,'read-only history must not change git HEAD');
 assert.doesNotMatch(JSON.stringify(report),/audit@example.test|Test Writer/);
});
test('historical churn uses bounded project-indexed file names',t=>{
 const {index}=project(t);
 const result=inspectCodeHistory(index,{action:'churn',limit:2,maxCommits:20});
 assert.equal(result.files.length,2);
 assert.deepEqual(result.files.map(f=>[f.path,f.commits]),[['src/a.ts',3],['src/b.ts',3]]);
 assert.equal(result.truncated,true);
});
test('limited window reports partial evidence and never claims a negative causal conclusion',t=>{
 const {index}=project(t);
 const result=inspectCodeHistory(index,{action:'cochange',path:'src/a.ts',maxCommits:2});
 assert.equal(result.complete,false);
 assert.ok(result.reasons.includes('history-window-limit'));
 assert.equal(result.commitCount,2);
 assert.ok(result.related.every(r=>r.sharedCommits<=2));
});
test('source path guards reject outside-root and symlink substitutions',t=>{
 const {index,root}=project(t);
 const outside=join(root,'outside.md');writeFileSync(outside,'secret');
 symlinkSync(outside,join(root,'src','link.ts'));
 assert.throws(()=>inspectCodeHistory(index,{action:'cochange',path:'../outside.md'}),/outside|root/);
 assert.throws(()=>inspectCodeHistory(index,{action:'cochange',path:'src/link.ts'}),/symlink|indexed/i);
});
test('not a Git repository reports unavailable instead of failing open',t=>{
 const dir=mkdtempSync(join(tmpdir(),'envelope-nohistory-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'a.ts'),'export const x=1;\n');
 const index=new CodeIndex(dir,{ts});index.refresh();
 const result=inspectCodeHistory(index,{action:'status'});
 assert.equal(result.available,false);
 assert.equal(result.complete,false);
 assert.equal(result.reason,'git-not-at-project-root');
});
test('Pi history tool is read-only and registered through CodeFeature without new hooks',async t=>{
 const {root}=project(t);const tools=new Map(),hooks=[];
 const pi={registerTool(x){tools.set(x.name,x)},on(name){hooks.push(name)}};
 const api=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,treeEnabled:false,languagesEnabled:false}}),loadCompiler:async()=>ts});
 const tool=tools.get('envelope_code_history');assert.ok(tool);
 const result=await tool.execute('run',{action:'cochange',path:'src/a.ts'},null,null,{cwd:root});
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(JSON.parse(result.content[0].text).related[0].path,'src/b.ts');
 assert.equal(hooks.length,0);api.close();
});
