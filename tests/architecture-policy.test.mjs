import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {evaluateArchitecturePolicy} from '../extensions/envelope/architecture-policy.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';
const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t,{violate=true}={}){
 const root=mkdtempSync(join(tmpdir(),'envelope-architecture-ci-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const files={
  'src/domain/account.ts':violate?'import {database} from "../infra/db";export const account=database;':'export const account=1;',
  'src/domain/balance.ts':'export const balance=2;',
  'src/infra/db.ts':'export const database=1;',
  'src/api/index.ts':'import {account} from "../domain/account";export const api=account;',
  'src/app.ts':'import {account} from "./domain/account";export const app=account;'
 };
 for(const [p,s] of Object.entries(files)){mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),s+'\n');}
 const git=spawnSync('git',['init','-q'],{cwd:root});assert.equal(git.status,0);
 const index=new CodeIndex(root,{ts});index.refresh();return {root,index};
}
const rules=[{from:'src/domain/',forbid:['src/infra/']}];
test('explicit policy fails on real static boundary and excessive inbound file degree',t=>{
 const {index}=fixture(t);
 const result=evaluateArchitecturePolicy(index,{rules,maxIncomingFiles:1,relation:'imports'});
 assert.equal(result.pass,false);
 assert.equal(result.mode,'advisory-policy-over-static-evidence');
 assert.equal(result.boundaries.total,1);
 assert.deepEqual(result.boundaries.violations[0],{source:'src/domain/account.ts',target:'src/infra/db.ts',type:'imports',rule:0,evidence:'parsed-static-import'});
 assert.ok(result.fanIn.violations.some(x=>x.path==='src/domain/account.ts'&&x.incomingFiles===2));
 assert.equal(result.complete,true);
});
test('valid boundaries and higher fan-in threshold pass without modifying sources',t=>{
 const {index,root}=fixture(t,{violate:false});
 const before=readFileSync(join(root,'src/domain/account.ts'),'utf8');
 const result=evaluateArchitecturePolicy(index,{rules,maxIncomingFiles:4,relation:'imports'});
 assert.equal(result.pass,true);
 assert.equal(result.boundaries.total,0);
 assert.equal(result.fanIn.total,0);
 assert.equal(readFileSync(join(root,'src/domain/account.ts'),'utf8'),before);
});
test('invalid rules and insufficient graph evidence do not silently pass',t=>{
 const {index}=fixture(t);
 assert.throws(()=>evaluateArchitecturePolicy(index,{rules:[{from:'../evil',forbid:['src/infra/']}]}),/invalid|prefix/i);
 assert.throws(()=>evaluateArchitecturePolicy(index,{rules:[],maxIncomingFiles:0}),/maxIncoming|threshold/i);
 index.lastRefresh.unavailable=['python'];
 const result=evaluateArchitecturePolicy(index,{rules,requireComplete:true});
 assert.equal(result.pass,false);
 assert.equal(result.complete,false);
 assert.ok(result.reasons.includes('parser-unavailable'));
});
test('Pi tool evaluates policy through current CodeIndex without new hooks',async t=>{
 const {root}=fixture(t),tools=new Map(),events=[];
 const pi={registerTool(v){tools.set(v.name,v)},on(e){events.push(e)}};
 const feature=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,treeEnabled:false,languagesEnabled:false}}),loadCompiler:async()=>ts});
 const tool=tools.get('envelope_code_policy');assert.ok(tool);
 const res=await tool.execute('x',{rules,relation:'imports'},null,null,{cwd:root});
 assert.equal(res.isError,false,res.content[0].text);
 assert.equal(JSON.parse(res.content[0].text).pass,false);
 assert.equal(events.length,0);feature.close();
});
test('optional architecture CI gate reads a project-local manifest and exits nonzero for observed violations',t=>{
 const {root}=fixture(t);
 mkdirSync(join(root,'.envelope'));
 const policy={version:1,relation:'imports',rules};
 writeFileSync(join(root,'.envelope','architecture-policy.json'),JSON.stringify(policy));
 const script=join(ROOT,'scripts','architecture-gate.mjs');
 const failing=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',timeout:5000});
 assert.equal(failing.status,1,failing.stderr);
 assert.equal(JSON.parse(failing.stdout).pass,false);
 writeFileSync(join(root,'.envelope','architecture-policy.json'),JSON.stringify({...policy,rules:[{from:'src/api/',forbid:['src/infra/']}]}));
 const passing=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',timeout:5000});
 assert.equal(passing.status,0,passing.stderr);
 assert.equal(JSON.parse(passing.stdout).pass,true);
});

test('fan-in limit 1 reports a bounded sample and fails closed with two violators',t=>{
 const {root,index}=fixture(t);
 writeFileSync(join(root,'src','second.ts'),'import {database} from "./infra/db";export const second=database;\n');
 writeFileSync(join(root,'src','third.ts'),'import {database} from "./infra/db";export const third=database;\n');
 index.refresh();
 const result=evaluateArchitecturePolicy(index,{maxIncomingFiles:1,relation:'imports',limit:1,requireComplete:true});
 assert.equal(result.fanIn.knownViolations,1);
 assert.equal(result.fanIn.potentiallyMore,true);
 assert.equal(result.fanIn.truncated,true);
 assert.equal(result.complete,false);
 assert.equal(result.pass,false);
 assert.ok(result.reasons.includes('fan-in-report-limit'));
});
