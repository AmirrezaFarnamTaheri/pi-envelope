import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {inspectCodeGraph} from '../extensions/envelope/graph-intelligence.mjs';
import {registerCodeFeature} from '../extensions/envelope/code-api.mjs';
function project(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-svg-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const files={'src/a.ts':'export const a=1;\n',
   'src/b.ts':'import {a} from "./a";export const b=a;\n',
   'src/<script>alert(1)</script>.ts':'export const bad=1;\n'};
 for(const [path,content] of Object.entries(files)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content)}
 const index=new CodeIndex(root,{ts,maxFiles:50});index.refresh();return {root,index};
}
test('static SVG export is deterministic, escaped, bounded and script-free',t=>{
 const {index}=project(t);
 const one=inspectCodeGraph(index,{action:'export',format:'svg',relation:'imports',limit:10});
 const two=inspectCodeGraph(index,{action:'export',format:'svg',relation:'imports',limit:10});
 assert.equal(one.content,two.content);
 assert.match(one.content,/^<svg /);
 assert.match(one.content,/<\/svg>$/);
 assert.match(one.content,/&lt;script&gt;/);
 assert.doesNotMatch(one.content,/<script|onerror\s*=|onload\s*=|<foreignObject|<image|<a\s|href\s*=/i);
 assert.ok(one.content.length<18000);
 assert.equal(one.format,'svg');
});
test('Obsidian Markdown export embeds native Mermaid and safe percent-encoded file links',t=>{
 const {index}=project(t);
 const result=inspectCodeGraph(index,{action:'export',format:'obsidian',relation:'imports',limit:10});
 assert.equal(result.format,'obsidian');
 assert.match(result.content,/```mermaid/);
 assert.match(result.content,/flowchart LR/);
 assert.match(result.content,/\[\[src%2Fa.ts\|src\/a.ts\]\]/);
 assert.ok(result.content.length<20000);
 assert.doesNotMatch(result.content,/<script|javascript:/i);
});
test('visual exports obey size limits and make incompleteness visible',t=>{
 const {index}=project(t);
 const report=inspectCodeGraph(index,{action:'export',format:'svg',limit:1});
 assert.equal(report.truncated,true);
 assert.equal(report.totalFiles,3);
 assert.throws(()=>inspectCodeGraph(index,{action:'export',format:'svg',limit:101}),/limit/i);
});
test('existing graph tool exposes static visualization formats with no additional hooks',async t=>{
 const {root}=project(t);const tools=new Map(),events=[];
 const pi={registerTool(x){tools.set(x.name,x)},on(name){events.push(name)}};
 const api=registerCodeFeature(pi,{project:ctx=>ctx.cwd,getConfig:()=>({code:{enabled:true,treeEnabled:false,languagesEnabled:false}}),loadCompiler:async()=>ts});
 const result=await tools.get('envelope_code_graph').execute('x',{action:'export',format:'svg'},null,null,{cwd:root});
 assert.equal(result.isError,false,result.content[0].text);
 assert.match(JSON.parse(result.content[0].text).content,/^<svg /);
 assert.equal(events.length,0);api.close();
});
