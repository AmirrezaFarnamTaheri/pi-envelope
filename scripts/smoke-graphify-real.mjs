/** Hosted, genuine Graphify CLI compatibility smoke using a disposable code-only project.
 * This is distinct from fake-executable subprocess tests. Never contacts an LLM.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute,relative} from 'node:path';
import {GraphifyCliBridge} from '../extensions/envelope/graphify-cli.mjs';

export async function smokeRealGraphify(executable,{fixture=null}={}){
  if(typeof executable!=='string'||!isAbsolute(executable))throw new Error('absolute Graphify executable required');
  const tmp=mkdtempSync(join(tmpdir(),'envelope-real-graphify-'));
  const project=join(tmp,'project');
  const privateHome=join(tmp,'home');
  mkdirSync(project);mkdirSync(privateHome);
  const previousHome=process.env.HOME;
  const cli=new GraphifyCliBridge();
  try {
    process.env.HOME=privateHome;
    writeFileSync(join(project,'a.js'),"export function greet(name) { return 'hello ' + name; }\n");
    writeFileSync(join(project,'b.js'),"import {greet} from './a.js';\nexport function main(){ return greet('Envelope'); }\n");
    const config={enabled:true,executable,timeoutMs:120_000};
    const before=await cli.run(project,config,{action:'status'});
    assert.equal(before.available,true,'expected executable to be trusted and accessible');
    assert.equal(before.artifactState,'missing','fixture should begin with no graph');
    const built=await cli.run(project,config,{action:'build'},undefined,{humanCommand:true});
    assert.equal(built.writeRequested,true);
    assert.equal(built.artifactChanged,true,'Graphify build should materialize new graph.json');
    const graphPath=join(project,'graphify-out','graph.json');
    assert.ok(existsSync(graphPath),'Graphify CLI did not create graph.json');
    const graph=JSON.parse(readFileSync(graphPath,'utf8'));
    const links=graph.links??graph.edges;
    assert.ok(Array.isArray(graph.nodes)&&graph.nodes.length>0,'code-only graph must contain AST nodes');
    assert.ok(Array.isArray(links),'graph must contain node-link edge array');
    const after=await cli.run(project,config,{action:'status'});
    assert.ok(!['missing','invalid','stale'].includes(after.artifactState), 'graph must be safely readable after build');
    const sample=graph.nodes.find(n=>typeof n.label==='string'&&n.label.includes('greet'))??graph.nodes[0];
    const symbol=sample.label??sample.name??sample.id;
    assert.ok(typeof symbol==='string'&&symbol.length>0,'graph sample node must have a name');
    // A direct node explanation must be supported by the same Graphify runtime.
    const explained=await cli.run(project,config,{action:'explain',source:symbol});
    assert.equal(explained.action,'explain');
    assert.ok(typeof explained.output==='string'&&explained.output.length>0,'empty explain');
    const queried=await cli.run(project,config,{action:'query',question:'greet',budget:750,depth:2});
    assert.equal(queried.action,'query');
    assert.ok(queried.output.length>0,'empty graph query');
    // Reindex the same project without triggering doc/media LLM semantics.
    const updated=await cli.run(project,config,{action:'update'},undefined,{humanCommand:true});
    assert.equal(updated.action,'update');
    assert.ok(!['missing','invalid'].includes(updated.artifactState),'update broke graph schema');
    return {ok:true,builtNodes:graph.nodes.length,builtEdges:links.length,readActions:['status','explain','query'],writeActions:['build','update'],externalProof:false};
  }finally{
    cli.close();
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    rmSync(tmp,{recursive:true,force:true});
  }
}

if(process.argv[1]&&process.argv[1].endsWith('smoke-graphify-real.mjs')){
  try{
    const result=await smokeRealGraphify(process.argv[2]);
    console.log(JSON.stringify(result));
  }catch(err){
    // The Graphify graph can contain project text, but CI diagnostics should be
    // bounded and should not print raw graph objects, prompts or credentials.
    console.error('Graphify real CLI smoke failed:',String(err?.message??'unknown error').slice(0,350));
    process.exitCode=1;
  }
}
