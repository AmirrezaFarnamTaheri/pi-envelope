/** Hosted, genuine Graphify CLI compatibility smoke using a disposable code-only project.
 * This is distinct from fake-executable subprocess tests. Never contacts an LLM.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute,relative} from 'node:path';
import {GraphifyCliBridge} from '../extensions/envelope/graphify-cli.mjs';
import {GraphifyWatchCoordinator} from '../extensions/envelope/graphify-watch.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';

export async function smokeRealGraphify(executable,{fixture=null}={}){
  if(typeof executable!=='string'||!isAbsolute(executable))throw new Error('absolute Graphify executable required');
  const tmp=mkdtempSync(join(tmpdir(),'envelope-real-graphify-'));
  const project=join(tmp,'project');
  const privateHome=join(tmp,'home');
  mkdirSync(project);mkdirSync(privateHome);
  const previousHome=process.env.HOME;
  const cli=new GraphifyCliBridge();
  const watcher=new GraphifyWatchCoordinator();
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
    assert.equal(built.artifactChanged,true,`Graphify build did not produce a valid changed graph (state ${built.artifactState}; files ${readdirSync(project).join(',')}; output ${built.output.slice(-180).replace(/[^\x20-\x7e]/g,' ')})`);
    const graphPath=join(project,'graphify-out','graph.json');
    assert.ok(existsSync(graphPath),'Graphify CLI did not create graph.json');
    const graph=JSON.parse(readFileSync(graphPath,'utf8'));
    const links=graph.links??graph.edges;
    assert.ok(Array.isArray(graph.nodes)&&graph.nodes.length>0,'code-only graph must contain AST nodes');
    assert.ok(Array.isArray(links)&&links.length>0,'graph must contain at least one code relationship');
    const after=await cli.run(project,config,{action:'status'});
    assert.ok(!['missing','invalid','stale'].includes(after.artifactState), 'graph must be safely readable after build');
    const sample=graph.nodes.find(n=>typeof n.label==='string'&&n.label.includes('greet'))??graph.nodes[0];
    const symbol=sample.id;
    assert.ok(typeof symbol==='string'&&symbol.length>0,'graph sample node must have a name');
    // A direct node explanation must be supported by the same Graphify runtime.
    const explained=await cli.run(project,config,{action:'explain',source:symbol});
    assert.equal(explained.action,'explain');
    assert.ok(typeof explained.output==='string'&&explained.output.length>0,'empty explain');
    const arc=links.find(x=>typeof x.source==='string'&&typeof x.target==='string'&&x.source!==x.target);
    assert.ok(arc,'at least one graph edge must connect distinct nodes');
    const traced=await cli.run(project,config,{action:'path',source:arc._src??arc.source,target:arc._tgt??arc.target});
    assert.equal(traced.action,'path');
    assert.ok(traced.output.length>0&&!/no (?:directed )?path found/i.test(traced.output),'Graphify path failed to connect a direct edge');
    const queried=await cli.run(project,config,{action:'query',question:'greet',budget:750,depth:2});
    assert.equal(queried.action,'query');
    assert.ok(queried.output.length>0,'empty graph query');
    // Reindex the same project without triggering doc/media LLM semantics.
    const updated=await cli.run(project,config,{action:'update'},undefined,{humanCommand:true});
    assert.equal(updated.action,'update');
    assert.ok(!['missing','invalid'].includes(updated.artifactState),'update broke graph schema');
    // Integration gate: real fs.watch event on a disposable project -> bounded
    // session-only watcher -> real pinned Graphify offline incremental update.
    // Generated graphify-out changes are excluded, avoiding recursive loops.
    const priorHash=createHash('sha256').update(readFileSync(graphPath)).digest('hex');
    let watchState;
    try{
      watcher.start(project,{debounceMs:250,
        runUpdate:async(root,signal)=>{
          const refreshed=await cli.run(root,config,{action:'update'},signal,{humanCommand:true});
          assert.ok(!['missing','stale','invalid'].includes(refreshed.artifactState),'watcher produced stale/invalid graph');
          return refreshed;
        }});
      writeFileSync(join(project,'c.js'),"import {greet} from './a.js';\nexport const label = greet('watcher');\n");
      for(let attempt=0;attempt<150;attempt++){
        await delay(200);
        watchState=watcher.status(project);
        if(watchState.lastOutcome==='failed')throw new Error('real code watcher update failed');
        if(watchState.batches>=1&&!watchState.updating&&!watchState.pendingCodeFiles)break;
      }
      assert.ok(watchState?.batches>=1,'real fs.watch did not trigger a Graphify update');
      assert.equal(watchState.manualRebuildRequired,false,'code-only change incorrectly needs a manual LLM rebuild');
      const nextHash=createHash('sha256').update(readFileSync(graphPath)).digest('hex');
      assert.notEqual(nextHash,priorHash,'watcher did not refresh actual graph content');
      const watchedGraph=JSON.parse(readFileSync(graphPath,'utf8'));
      assert.ok(watchedGraph.nodes.length>graph.nodes.length,'new source not indexed by automatic update');
    }finally{await watcher.stopAndWait(project);}
    return {ok:true,builtNodes:graph.nodes.length,builtEdges:links.length,watcherBatches:watchState?.batches??0,realFsWatch:true,readActions:['status','path','explain','query'],writeActions:['build','update','opt-in-watch-update'],externalProof:false};
  }finally{
    watcher.close();
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
