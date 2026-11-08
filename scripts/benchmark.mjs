/** Offline synthetic microbenchmarks: real bytes, real local time, zero provider calls. */
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { compactOutput } from '../extensions/envelope/compactor.mjs';
import { projectContext } from '../extensions/envelope/context-projection.mjs';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';
import { OutputStore } from '../extensions/envelope/store.mjs';
import { WorkflowLedger } from '../extensions/envelope/workflow-ledger.mjs';

const tokenProxy = (rawBytes,renderedBytes) => ({
  baseline:Math.ceil(rawBytes/4),rendered:Math.ceil(renderedBytes/4),
  saved:Math.max(0,Math.ceil(rawBytes/4)-Math.ceil(renderedBytes/4))
});
function timings(work,iterations=17){
  const samples=[];
  // Warm up JIT and SQLite: local timing only, not a statistical cross-machine benchmark.
  work();work();
  for(let i=0;i<iterations;i++){
    const started=performance.now();work();samples.push(performance.now()-started);
  }
  samples.sort((a,b)=>a-b);
  return {median:Math.round(samples[Math.floor(samples.length/2)]*1000)/1000,
    p95:Math.round(samples[Math.ceil(samples.length*.95)-1]*1000)/1000};
}
const MIXED_ANCHOR_LINES = [
  '[L91] export const raw = "unchanged";',
  '[L92] const sign = "✓";',
  '93 # aBcD12: const hashline = true;',
  '94:abCD12| return raw;'
];
const MIXED_DIAGNOSTIC = '\x1b[31mwarning: review source imports before release\x1b[0m';
function syntheticCorpus(){
  const test=['RUN v3.1.0',...Array.from({length:180},(_,i)=>`  ✓ sample-${i+1} passes with controlled fixtures`),
    'Test Files  1 passed (1)','Tests  180 passed (180)','Duration  1.2s'].join('\n');
  const build=['Compiling module 1 / 140',...Array.from({length:140},(_,i)=>`Compiling module ${i+1} / 140`),
    'Build complete: 140 modules'].join('\n');
  const git=['On branch main','Changes not staged for commit:',...Array.from({length:92},(_,i)=>`  modified:   src/fake-module-${i+1}.ts`)].join('\n');
  const anchor=['[L1] export function sourceAnchor(){return 1;}',...Array.from({length:180},(_,i)=>`[L${i+2}] const item${i} = ${i};`)].join('\n');
  const json=JSON.stringify({results:Array.from({length:110},(_,i)=>({name:`sample-${i}`,ok:true}))});
  const mixed=['RUN v3.1.0',...Array.from({length:165},(_,i)=>`  ✓ sample passing ${i}`),
    ...MIXED_ANCHOR_LINES,MIXED_DIAGNOSTIC,'Tests 165 passed (165)'].join('\r\n');
  return [{id:'tests-success',text:test},{id:'mixed-anchored-tests',text:mixed},{id:'build-success',text:build},
    {id:'git-status',text:git},{id:'source-anchor',text:anchor},{id:'machine-json',text:json}];
}

export function runBenchmarks(){
  const root=mkdtempSync(join(tmpdir(),'envelope-bench-'));
  let store,workflow;
  try {
    store=new OutputStore(join(root,'output'));
    const project=join(root,'project');mkdirSync(project);
    const cases=syntheticCorpus().map(({id,text})=>{
      const config={minBytes:1200,maxChars:11860,minSavingsRatio:0.2};
      const latencyMs=timings(()=>compactOutput(text,config));
      const reduced=compactOutput(text,config);
      let rendered=text,exactRecovery=true;
      if(reduced.changed){
        const saved=store.save({text,project,tool:'benchmark',command:''});
        rendered=`${reduced.text}\n[envelope: original retained; envelope_recall_output id=${saved.id}]`;
        exactRecovery=store.retrieve(saved.id)?.text===text;
      }
      const rawBytes=Buffer.byteLength(text),renderedBytes=Buffer.byteLength(rendered);
      if(renderedBytes>rawBytes) throw new Error(`Benchmark output expands: ${id}`);
      const mixedSafety = id==='mixed-anchored-tests'
        ? {anchorsPreserved:MIXED_ANCHOR_LINES.every(line=>rendered.includes(`${line}\r\n`)),
           diagnosticsPreserved:rendered.includes(`${MIXED_DIAGNOSTIC}\r\n`)} : {};
      return {id,changed:reduced.changed,rawBytes,renderedBytes,bytesSaved:rawBytes-renderedBytes,
        exactRecovery,...mixedSafety,estimatedTokenProxy:tokenProxy(rawBytes,renderedBytes),latencyMs};
    });
    const historical=`start verification\n${'synthetic successful output xyz 1234567890\n'.repeat(220)}\n220 passed`;
    const messages=[
      {role:'user',content:'Check build'},
      {role:'assistant',content:[{type:'toolCall',id:'run-1',name:'bash',arguments:{command:'npm test'}}]},
      {role:'toolResult',toolCallId:'run-1',toolName:'bash',content:[{type:'text',text:historical}],isError:false},
      {role:'assistant',content:[{type:'toolCall',id:'cp-1',name:'envelope_context_checkpoint',arguments:{name:'review'}}]},
      {role:'toolResult',toolCallId:'cp-1',toolName:'envelope_context_checkpoint',content:[{type:'text',text:'checkpoint saved'}],isError:false},
      {role:'user',content:'Continue task'},
      ...Array.from({length:8},(_,i)=>({role:'assistant',content:[{type:'text',text:`progress ${i}`}] }))
    ];
    const originalSnapshot=JSON.stringify(messages);
    const opts={store,project,anchorCallId:'cp-1',minBytes:2400,maxPreviewChars:650,recentMessages:8,minSavingsRatio:.4};
    const contextLatency=timings(()=>projectContext(messages,opts),13);
    const projected=projectContext(messages,opts);
    const shortened=projected.messages[2]?.content?.[0]?.text??'';
    const id=shortened.match(/envelope_recall_output id=([a-f0-9]{64})/)?.[1];
    const context={changed:projected.changed,rawBytes:projected.rawBytes,renderedBytes:projected.renderedBytes,
      bytesSaved:projected.rawBytes-projected.renderedBytes,
      estimatedTokenProxy:tokenProxy(projected.rawBytes,projected.renderedBytes),
      exactRecovery:Boolean(id&&store.retrieve(id)?.text===historical),
      originalTranscriptUnmodified:JSON.stringify(messages)===originalSnapshot,
      toolCallPairingPreserved:projected.messages[1].content[0].id==='run-1'&&projected.messages[2].toolCallId==='run-1',
      latencyMs:contextLatency};
    writeFileSync(join(project,'math.ts'),'export function add(a: number, b: number) { return a + b; }\n');
    writeFileSync(join(project,'main.ts'),"import { add } from './math';\nexport function start() { return add(1, 2); }\n");
    const index=new CodeIndex(project,{ts,maxFiles:10,maxBytesPerFile:10000});
    const parseLatency=timings(()=>index.refresh(),13);
    const sourceCalls=index.calls('main.ts');
    const targetCalls=index.calls('math.ts');
    const cachedRefresh=index.refresh();
    const code={symbolMatches:index.lookup('add').length,staticImporters:index.impact('math.ts').importers.length,
      parseOnlyValid:index.verify('math.ts').ok,runtimeTypechecking:false,refreshLatencyMs:parseLatency,
      callsResolved:sourceCalls.totalOutgoing,incomingCallers:targetCalls.totalIncoming,
      unresolvedCallSites:sourceCalls.totalUnresolved,cachedRefresh:{reparsed:cachedRefresh.reparsed,reused:cachedRefresh.reused},
      typeCheckedCalls:false,callEvidence:'syntactic direct-call/explicit-import matching, not a runtime call graph'};
    workflow=new WorkflowLedger(join(root,'workflow'));
    const created=workflow.create(project,{name:'Synthetic one-task review',tasks:[
      {id:'validate',title:'Validate implementation',instructions:'Synthetic review gate'}]});
    const states=[workflow.status(project,created.workflowId).tasks[0].status];
    const claim=workflow.claim(project,created.workflowId,{worker:'synthetic'});
    states.push(workflow.status(project,created.workflowId).tasks[0].status);
    workflow.finish(project,created.workflowId,'validate',{token:claim.token,outcome:'review',summary:'Synthetic test result'});
    states.push(workflow.status(project,created.workflowId).tasks[0].status);
    workflow.review(project,created.workflowId,'validate',{outcome:'completed',evidence:'Synthetic invariant check only'});
    states.push(workflow.status(project,created.workflowId).tasks[0].status);
    const summary={
      rawBytes:cases.reduce((a,x)=>a+x.rawBytes,0),renderedBytes:cases.reduce((a,x)=>a+x.renderedBytes,0)
    };
    return {
      schemaVersion:1,corpus:'envelope-synthetic-v2',
      environment:{node:process.version,providerCalls:0,actualBilledTokenSavings:null,answerQualityMeasured:false,
        tokenProxy:{label:'heuristic approximation: ceil(UTF-8 bytes / 4); NOT a provider tokenizer or billed-token saving'}},
      output:{cases,aggregate:{...summary,bytesSaved:summary.rawBytes-summary.renderedBytes,
        estimatedTokenProxy:tokenProxy(summary.rawBytes,summary.renderedBytes)}},
      context,code,workflow:{states,agentSpawned:false,worktreeCreated:false},
      limitations:[
        'No live Pi/Tersio runtime, no provider calls, no provider token billing or answer-quality evaluation.',
        'Context reductions are measured for one synthetic projection, not unique cumulative cached-prefix or API-token savings.',
        'Local transform latencies depend on hardware, filesystem cache and process state; do not generalize across machines.',
        'Synthetic workflow verifies state transitions only; it does not execute an autonomous agent or evaluate implementation quality.'
      ]
    };
  } finally {
    workflow?.close();store?.close();rmSync(root,{recursive:true,force:true});
  }
}
const scriptPath=fileURLToPath(import.meta.url);
if(process.argv[1] && resolve(process.argv[1])===scriptPath){
  try{console.log(JSON.stringify(runBenchmarks(),null,2));}
  catch(err){console.error(`Benchmark failed: ${err instanceof Error?err.message:String(err)}`);process.exitCode=1;}
}
