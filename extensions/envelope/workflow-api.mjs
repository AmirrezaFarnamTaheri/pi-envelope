/** Pi-native queue, review and one-shot child process integration. */
import { randomUUID } from 'node:crypto';
import { prepareWorktree, preflightWorktree, captureHandoff } from './worktree-adapter.mjs';

const reply=(value,isError=false)=>({
  isError,content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}],details:{}
});
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const string=(description)=>({type:'string',description});
const workflowId=string('Workflow UUID created by envelope_workflow_create');
const taskId=string('Stable task identifier in this workflow');
const outcome=(choices)=>({type:'string',enum:choices});
const maxChildMs=10*60*1000;
const conciseStatus=(state)=>({...state,tasks:state.tasks.map(({instructions,summary,...rest})=>({
  ...rest,instructionsPreview:instructions.slice(0,220),summary:summary?.slice(0,400)??null
}))});

export function registerWorkflowFeature(pi,{ledger,getStore,project,getConfig,metrics,home,observe}) {
  const scope=ctx=>project(ctx);
  const config=()=>getConfig().workflow;
  const active=()=>{
    if(!config().enabled) throw new Error('Workflow tools are disabled. Use /envelope workflow on.');
  };
  const tool=(name,label,description,parameters,execute,{readOnly=false}={})=>{
    pi.registerTool?.({name,label,description,parameters,
      async execute(_callId,params,signal,_update,ctx){
        const started=performance.now();let output;
        try {
          if(!readOnly) active();
          output=await execute(params||{},ctx,signal);
        }catch(err){output=reply(`Envelope workflow: ${err instanceof Error?err.message:String(err)}`,true);}
        const requested=['review','finish'].includes(name.replace('envelope_workflow_','')) && ['completed','failed','review'].includes(params?.outcome)?params.outcome:'ok';
        observe?.(ctx,'workflow_action',{action:name,outcome:output.isError?'error':requested,durationMs:performance.now()-started});
        return output;
      }
    });
  };
  tool('envelope_workflow_create','Envelope: Create Workflow',
    'Persist a bounded task DAG with explicit dependencies. This only creates state; it never executes a task.',
    obj({name:string('Workflow label'),tasks:{type:'array',minItems:1,maxItems:40,items:obj({
      id:string('Stable task id starting with a letter'),title:string('Short task title'),
      instructions:string('Exact implementation instructions'),
      dependsOn:{type:'array',items:{type:'string'},description:'Task IDs that must be reviewed complete before this task runs'}
    },['id','title','instructions'])}},['name','tasks']),
    (p,ctx)=>reply(ledger.create(scope(ctx),p)));
  tool('envelope_workflow_status','Envelope: Workflow Status',
    'Show current project task DAG, review states and ready tasks. Does not claim or execute.',
    obj({workflowId}),
    (p,ctx)=>{
      const state=ledger.status(scope(ctx),p.workflowId);
      if(p.workflowId&&!state.workflow) return reply('Workflow not found in current project.',true);
      return reply(conciseStatus(state));
    },{readOnly:true});
  tool('envelope_workflow_claim','Envelope: Claim Ready Task',
    'Atomically reserve next dependency-ready task for one worker; only one active worker per project.',
    obj({workflowId,worker:string('Worker identity for audit trail')},['workflowId','worker']),
    (p,ctx)=>{
      const claimed=ledger.claim(scope(ctx),p.workflowId,{worker:p.worker});
      return claimed?reply(claimed):reply('No claimable task: dependencies, review or an existing worker blocks execution.',true);
    });
  tool('envelope_workflow_finish','Envelope: Submit Claimed Task',
    'A worker submits a result for review or failure using its claim token. It cannot mark a task complete.',
    obj({workflowId,taskId,token:string('Lease claim token'),outcome:outcome(['review','failed']),summary:string('What was changed and verification attempted')},
      ['workflowId','taskId','token','outcome','summary']),
    (p,ctx)=>reply(ledger.finish(scope(ctx),p.workflowId,p.taskId,p)));
  tool('envelope_workflow_review','Envelope: Review Task',
    'After inspecting actual changes/tests, approve or reject a submitted task; dependencies unblock only after approval.',
    obj({workflowId,taskId,outcome:outcome(['completed','failed']),evidence:string('Specific checks performed; not an automatic test result')},
      ['workflowId','taskId','outcome','evidence']),
    async(p,ctx,signal)=>{
      const current=ledger.status(scope(ctx),p.workflowId).tasks.find(t=>t.id===p.taskId);
      const recorded=ledger.handoff(scope(ctx),p.workflowId,p.taskId);
      if(p.outcome==='completed' && recorded && current?.attempts===recorded.attempt){
        if(typeof pi.exec!=='function') throw new Error('Git runner unavailable; cannot verify handoff');
        const fresh=await captureHandoff({exec:pi.exec,workspace:recorded.workspace,baseHead:recorded.baseHead,signal});
        if(fresh.fingerprint!==recorded.fingerprint) throw new Error('Worktree changed since handoff; review is stale. Inspect changes and resubmit evidence.');
      }
      return reply(ledger.review(scope(ctx),p.workflowId,p.taskId,p));
    });
  tool('envelope_workflow_retry','Envelope: Retry Task',
    'Explicitly return a failed or interrupted task to pending; never automatically restart a worker.',
    obj({workflowId,taskId},['workflowId','taskId']),
    (p,ctx)=>reply(ledger.retry(scope(ctx),p.workflowId,p.taskId)));
  tool('envelope_workflow_events','Envelope: Workflow Audit',
    'Inspect bounded local task transition history, scoped to the current project.',
    obj({workflowId,limit:{type:'integer',minimum:1,maximum:50}},['workflowId']),
    (p,ctx)=>reply(ledger.events(scope(ctx),p.workflowId,{limit:p.limit})),{readOnly:true});
  tool('envelope_workflow_handoff','Envelope: Inspect Verifiable Handoff',
    'Read the latest worktree location, content fingerprint, changed paths and raw child output ID without changing Git files.',
    obj({workflowId,taskId},['workflowId','taskId']),
    (p,ctx)=>{
      const state=ledger.status(scope(ctx),p.workflowId);
      if(!state.workflow || !state.tasks.some(t=>t.id===p.taskId)) return reply('Unknown workflow or task in current project.',true);
      const result=ledger.handoff(scope(ctx),p.workflowId,p.taskId);
      if(!result) return reply('No isolated worktree handoff recorded for this task.',true);
      // Only bounded previews enter the model; the SQLite record retains all names/digests.
      const pathLimit=30,hashLimit=15;
      const hashes=Object.entries(result.untrackedHashes);
      return reply({...result,
        changedFileCount:result.changedFiles.length,
        changedFiles:result.changedFiles.slice(0,pathLimit).map(path=>path.length>240?`${path.slice(0,240)}...`:path),
        changedFilesTruncated:result.changedFiles.length>pathLimit,
        untrackedFileCount:hashes.length,
        untrackedHashes:Object.fromEntries(hashes.slice(0,hashLimit).map(([name,digest])=>[name.length>240?`${name.slice(0,240)}...`:name,digest])),
        untrackedHashesTruncated:hashes.length>hashLimit,
        currentAttempt:state.tasks.find(t=>t.id===p.taskId).attempts
      });
    },{readOnly:true});
  tool('envelope_workflow_run','Envelope: Run One Pi Worker',
    'Opt-in ONLY: run one pending task in a detached Git worktree. A successful exit submits review, NEVER completion. Shared-working-tree execution was removed.',
    obj({workflowId},['workflowId']),async(p,ctx,signal)=>{
      if(Object.hasOwn(p,'isolated')) throw new Error('Shared-working-tree mode is removed; isolated execution is always required.');
      if(!config().runEnabled) throw new Error('Child execution is OFF. Explicitly enable with /envelope workflow run on.');
      if(typeof pi.exec!=='function') throw new Error('This Pi host cannot spawn child tasks');
      if(!getStore()) throw new Error('Exact child output store is unavailable; refusing to spawn');
      const cwd=scope(ctx);
      const state=ledger.status(cwd,p.workflowId);
      if(!state.workflow) throw new Error('Workflow not found in current project');
      if(signal?.aborted) throw new Error('Task request aborted before launching worker');
      // Fail before claiming if the checkout is dirty or is not a Git root.
      const base=await preflightWorktree({exec:pi.exec,project:cwd,signal});
      const claimed=ledger.claim(cwd,p.workflowId,{worker:`worker-${randomUUID().replaceAll('-','').slice(0,24)}`,leaseMs:15*60*1000});
      if(!claimed) throw new Error('No claimable task; review dependencies or existing worker first');
      metrics.workflowRuns++;
      const prompt=[
        'You are executing exactly ONE task in this existing project.',
        `Workflow: ${state.workflow.name}; task: ${claimed.id}; title: ${claimed.title}.`,
        `Instructions:\n${claimed.instructions}`,
        'Inspect the repository, implement this task only, run targeted tests and report changed files, checks and problems.',
        'Do not mark the task completed: the parent will verify your work. Do not spawn other agents.',
        'Do not create commits, push, publish, or modify unrelated files.'
      ].join('\n\n');
      const abort=AbortSignal.timeout(maxChildMs);
      const controller=signal?AbortSignal.any([signal,abort]):abort;
      let savedId=null,code=null,errorMessage=null,killed=false,workspace=null,fingerprint=null;
      let child;
      try{
        const prepared=await prepareWorktree({exec:pi.exec,project:cwd,home,workflowId:p.workflowId,taskId:claimed.id,attempt:claimed.attempts,signal:controller,preflight:base});
        workspace=prepared.path;
        // Direct argv invocation: no shell, no implicit commit or merge.
        child=await pi.exec('pi',['--print','--no-session','--no-mcp','--exclude-tools','envelope_workflow_*','--',prompt],{cwd:workspace,signal:controller});
        code=Number.isInteger(child?.code)?child.code:null;
        killed=child?.killed===true;
      }catch(err){errorMessage=err instanceof Error?err.message:String(err);}
      try{
        const transcript=[child?.stdout,child?.stderr].filter(s=>typeof s==='string'&&s.length).join('\n');
        if(Buffer.byteLength(transcript)>1_900_000) throw new Error('child output exceeds exact capture limit');
        const result=getStore().save({text:transcript||'(child produced no output)',project:cwd,tool:'pi-child',command:`workflow ${state.workflow.name} task ${claimed.id}`});
        savedId=result.id;
        if(workspace){
          const handoff=await captureHandoff({exec:pi.exec,workspace,baseHead:base.baseHead,signal:controller});
          const saved=ledger.recordHandoff(cwd,p.workflowId,claimed.id,{
            token:claimed.token,attempt:claimed.attempts,workspace:handoff.path,baseHead:handoff.baseHead,
            head:handoff.head,fingerprint:handoff.fingerprint,trackedDiffHash:handoff.trackedDiffHash,
            changedFiles:handoff.changedFiles,untrackedHashes:handoff.untrackedHashes,outputId:savedId
          });
          fingerprint=saved.fingerprint;
        }
      }catch(err){errorMessage=[errorMessage,err instanceof Error?err.message:String(err)].filter(Boolean).join('; ').slice(0,600);}
      const ok=code===0&&!errorMessage&&!killed&&!controller.aborted&&Boolean(fingerprint);
      const summary=ok
        ?`Child Pi exited 0; outputId=${savedId}; worktree sha256=${fingerprint}; requires independent verification.`
        :`Child Pi was not verified: exit=${code===null?'unavailable':code}; ${killed?'worker killed; ':''}${controller.aborted?'worker aborted; ':''}${errorMessage?errorMessage.slice(0,240):`outputId=${savedId}`}`;
      const status=ledger.finish(cwd,p.workflowId,claimed.id,{token:claimed.token,outcome:ok?'review':'failed',summary});
      if(ok) metrics.workflowSubmitted++;
      else metrics.workflowFailed++;
      return reply({...status,workflowId:p.workflowId,isolated:true,workspace,outputId:savedId,exitCode:code,reviewRequired:ok,fingerprint},!ok);
    });
  return {status:(ctx)=>ledger.status(scope(ctx))};
}
