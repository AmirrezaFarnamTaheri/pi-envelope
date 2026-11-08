/**
 * Envelope's native Pi extension. Tersio upstream extensions are loaded
 * ahead of this module through the parent's explicit package manifest.
 *
 * RTK alone owns shell rewrites; RTK's filter owns grep/glob output; envelope
 * owns conservative bash-result compaction and exact local retrieval.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compactOutput } from './compactor.mjs';
import { OutputStore } from './store.mjs';
import { readConfig, saveConfig } from './config.mjs';
import { composePolicy } from './policy.mjs';
import { ContextLedger } from './context-ledger.mjs';
import { ContextFrontier } from './context-frontier.mjs';
import { registerContextFeature } from './context-api.mjs';
import { registerCodeFeature } from './code-api.mjs';
import { registerLspFeature } from './lsp-api.mjs';
import { guardMutation } from './mutation-guard.mjs';
import { WorkflowLedger } from './workflow-ledger.mjs';
import { registerWorkflowFeature } from './workflow-api.mjs';
import { MetricsLedger } from './metrics-ledger.mjs';
import {ProjectMemory, registerProjectMemoryFeature} from './project-memory.mjs';
import {registerCapabilityCockpit} from './capability-cockpit.mjs';
import { registerGraphifyCliFeature, normalizeGraphifyExecutable, composeGraphifyOrientation } from './graphify-cli.mjs';
import { registerGraphifyDotnetFeature, normalizeGraphifyDotnetExecutable } from './graphify-dotnet-runtime.mjs';
import { registerMetricsFeature } from './metrics-api.mjs';

function homePath() {
  if (process.env.ENVELOPE_HOME) return process.env.ENVELOPE_HOME;
  return process.env.TERSIO_HOME || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.tersio');
}

/** Native bash completion metadata varies by Pi host. Any uncertain terminal
 * state must bypass compaction; a signal with code 0 is still an interruption. */
function unsafeBashOutcome(details) {
  if (!details || typeof details !== 'object') return false;
  for (const flag of ['killed', 'aborted', 'timedOut', 'timeout', 'cancelled', 'canceled', 'interrupted', 'truncated']) {
    if (details[flag] === true) return true;
  }
  for (const key of ['code', 'exitCode']) {
    if (details[key] !== undefined && details[key] !== null &&
      (typeof details[key] !== 'number' || !Number.isInteger(details[key]) || details[key] !== 0)) return true;
  }
  if (details.signal || details.error) return true;
  if (typeof details.status === 'string' && !['success', 'completed', 'ok'].includes(details.status.toLowerCase())) return true;
  return false;
}

const textReply = (text, isError = false, details = {}) => ({
  isError,
  content: [{ type: 'text', text }],
  details
});

/**
 * @param {object} pi - Pi ExtensionAPI
 * @param {{home?:string}} options - only used by development harness and tests
 */
export function registerEnvelope(pi, options = {}) {
  const home = options.home || homePath();
  const settingsPath = join(home, 'settings.json');
  let config = readConfig(settingsPath);
  let store;
  try { store = new OutputStore(join(home, 'envelope-output')); }
  catch (err) {
    store = null;
    pi.logger?.warn?.(`[envelope] local store unavailable; output compaction disabled: ${err.message}`);
  }
  // Memory is OFF by default and MUST NOT create a database before explicit opt-in.
  let projectMemory=null;
  const getMemory=()=>{
    if(!config.memory.enabled)return null;
    if(!projectMemory){
      try{projectMemory=new ProjectMemory(join(home,'envelope-memory'));}
      catch(err){pi.logger?.warn?.(`[envelope] optional project memory unavailable: ${err.message}`);}
    }
    return projectMemory;
  };
  const lastOutputPrune = new Map();
  const metrics = { calls: 0, compacted: 0, rawBytes: 0, renderedBytes: 0, contextCalls: 0, contextCompacted: 0, contextRawBytes: 0, contextRenderedBytes: 0, workflowRuns: 0, workflowSubmitted: 0, workflowFailed: 0 };
  const ledger = new ContextLedger(join(home, 'envelope-context'));
  let frontier;
  try {frontier=new ContextFrontier(join(home,'envelope-context'));}
  catch(err){frontier=null;pi.logger?.warn?.(`[envelope] context replay frontier unavailable; pruning stays disabled: ${err.message}`);}
  const project = (ctx) => ctx?.cwd || pi.cwd || process.cwd();
  let metricLedger;
  try { metricLedger = new MetricsLedger(join(home,'envelope-metrics'),{retentionDays:config.observability.retentionDays}); }
  catch(err) { metricLedger = null; pi.logger?.warn?.(`[envelope] metrics unavailable; continuing without telemetry: ${err.message}`); }
  const observe = (ctx,kind,fields={}) => {
    if(!config.observability.enabled || !metricLedger) return;
    try { metricLedger.record(project(ctx),kind,fields); }
    catch(err) { pi.logger?.warn?.(`[envelope] metrics write failed (ignored): ${err.message}`); }
  };
  registerMetricsFeature(pi,{getLedger:()=>metricLedger,project});
  registerCapabilityCockpit(pi,{getConfig:()=>config});
  registerProjectMemoryFeature(pi,{getMemory,project,getConfig:()=>config});
  pi.on('message_end',(event,ctx)=>{
    const message=event?.message;
    if(message?.role!=='assistant'||!message.usage) return;
    const u=message.usage;
    observe(ctx,'model_usage',{
      inputTokens:u.input??0,outputTokens:u.output??0,
      cacheReadTokens:u.cacheRead??0,cacheWriteTokens:u.cacheWrite??0,
      costUsd:u.cost?.total??0,providerBilled:u.cost?.totalFromProvider===true
    });
  });
  const notify = (ctx, message, level = 'info') => {
    if (ctx?.ui?.notify) ctx.ui.notify(message, level);
    else pi.logger?.info?.(`[envelope] ${message}`);
  };

  pi.on('tool_result', async (event, ctx) => {
    const started=performance.now();
    metrics.calls++;
    if (!config.output.enabled || !store || event?.toolName !== 'bash' || event?.isError === true) return;
    if (event?.structuredContent !== undefined) return;
    if (unsafeBashOutcome(event?.details)) return;
    const content = event?.content;
    // Do not flatten mixed/structured results, losing their part boundaries.
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
      || typeof content[0]?.text !== 'string') return;
    const original = content[0].text;
    const reduced = compactOutput(original, {
      ...config.output,
      maxChars: config.output.maxChars - 140
    });
    if (!reduced.changed) return;

    try {
      const saved = store.save({
        text: original,
        project: project(ctx),
        tool: event.toolName,
        command: typeof event.input?.command === 'string' ? event.input.command : ''
      });
      // Expiry is opt-in and opportunistic; never prune the output just captured.
      if (config.output.retentionDays > 0) {
        const scope=project(ctx), now=Date.now();
        if ((lastOutputPrune.get(scope)??0) + 60_000 < now) {
          lastOutputPrune.set(scope,now);
          try {store.prune({project:scope,before:new Date(now-config.output.retentionDays*86_400_000).toISOString()});}
          catch(err){pi.logger?.warn?.(`[envelope] retention sweep failed: ${err.message}`);}
        }
      }
      const marker = `\n[envelope: original retained; envelope_recall_output id=${saved.id}]`;
      const contentText = `${reduced.text}${marker}`;
      if (Buffer.byteLength(contentText) > config.output.maxChars) return;
      metrics.compacted++;
      metrics.rawBytes += reduced.originalBytes;
      metrics.renderedBytes += Buffer.byteLength(contentText);
      observe(ctx,'output_compaction',{rawBytes:reduced.originalBytes,renderedBytes:Buffer.byteLength(contentText),durationMs:performance.now()-started});
      return { content: [{ type: 'text', text: contentText }] };
    } catch (err) {
      pi.logger?.warn?.(`[envelope] could not persist raw output; leaving original intact: ${err.message}`);
      // Do not compact anything that cannot be recovered.
      return;
    }
  });

  const contextApi = registerContextFeature(pi, {
    ledger, frontier, getStore:()=>store, getConfig:()=>config, project, metrics, observe
  });

  const codeApi = registerCodeFeature(pi, {project, getConfig:()=>config, loadCompiler:options.loadCompiler, loadTreeRuntime:options.loadTreeRuntime, getTreeGrammarPath:options.getTreeGrammarPath, watchGraphFactory:options.watchGraphFactory, home, observe});
  registerLspFeature(pi,{indexOf:codeApi.indexOf,getConfig:()=>config,home,observe});
  const graphifyCli = registerGraphifyCliFeature(pi,{project,getConfig:()=>config,observe,cli:options.graphifyCliBridge,watcher:options.graphifyWatcher});
  const graphifyDotnet = registerGraphifyDotnetFeature(pi,{project,getConfig:()=>config,bridge:options.graphifyDotnetBridge});

  // One read-only preflight stage for write/edit; Tersio only rewrites bash.
  // Deliberately disabled until the user opts in, and never writes to disk.
  let preflightCompiler;
  pi.on('tool_call', async (event, ctx) => {
    if(!config.code.enabled || !config.code.guardEnabled || !['write','edit'].includes(event?.toolName))return;
    try {
      preflightCompiler??=Promise.resolve().then(options.loadCompiler || (()=>import('typescript')));
      const imported=await preflightCompiler;
      return guardMutation(event.toolName,event.input,project(ctx),imported.default||imported);
    } catch(err) {
      pi.logger?.warn?.(`[envelope] pre-write syntax guard unavailable; allowing native tool: ${err.message}`);
      return;
    }
  });

  let workflowLedger;
  try { workflowLedger = new WorkflowLedger(join(home, 'envelope-workflows')); }
  catch (err) { pi.logger?.warn?.(`[envelope] workflow database unavailable: ${err.message}`); }
  const workflowApi = registerWorkflowFeature(pi, {
    ledger:workflowLedger, getStore:()=>store, getConfig:()=>config, project, metrics, home, observe
  });

  pi.on('before_agent_start', (event,ctx) => {
    const policy=composePolicy(event?.systemPrompt,config.policy.enabled);
    return composeGraphifyOrientation(policy?.systemPrompt??event?.systemPrompt,project(ctx),config.graphify.orientationEnabled) || policy || undefined;
  });
  pi.on('session_shutdown', () => { graphifyDotnet.close?.(); graphifyCli.close?.(); codeApi.close?.(); store?.close(); store = null; frontier?.close(); frontier=null; workflowLedger?.close(); metricLedger?.close(); metricLedger=null; });

  pi.registerTool?.({
    name: 'envelope_recall_output',
    label: 'Envelope: Recall Exact Output',
    description: 'Retrieve the exact original text of a compacted tool result by its hash, scoped to the current project.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '64-character hexadecimal original output ID' } },
      required: ['id'], additionalProperties: false
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!store) return textReply('Local output store unavailable.', true);
      try {
        const row = store.retrieve(params?.id);
        if (!row || row.project !== project(ctx)) return textReply('No captured output with this ID in the current project.', true);
        return textReply(row.text, false, { id: row.id, bytes: row.bytes, tool: row.tool, command: row.command });
      } catch (err) { return textReply(`Could not recall output: ${err.message}`, true); }
    }
  });

  pi.registerTool?.({
    name: 'envelope_search_fragments',
    label: 'Envelope: Search Output Fragments',
    description: 'Project-scoped search of bounded, verified output chunks. May incrementally index up to eight older local captures per call; raw outputs remain unchanged and recoverable by ID.',
    parameters:{type:'object',properties:{query:{type:'string',description:'Terms in historical output'},limit:{type:'integer',minimum:1,maximum:25}},required:['query'],additionalProperties:false},
    async execute(_id,p,_signal,_update,ctx){
      if(!store)return textReply('Local output store unavailable.',true);
      try {
        const report=store.searchFragmentsReport(p?.query,{project:project(ctx),limit:p?.limit??10});
        const result=textReply(JSON.stringify(report.hits,null,2),false,{chunkIndex:report.index});
        if(report.index.partial)result.content.push({type:'text',text:`Search incomplete; index coverage: ${JSON.stringify(report.index)}`});
        return result;
      }
      catch(err){return textReply(`Could not search fragments: ${err.message}`,true);}
    }
  });

  pi.registerTool?.({
    name: 'envelope_output_retention',
    label: 'Envelope: Raw Output Retention Status',
    description: 'Read-only status for this project raw-output storage and expiry policy. Erasure requires an explicit user slash command.',
    parameters:{type:'object',properties:{},required:[],additionalProperties:false},
    async execute(_id,_params,_signal,_onUpdate,ctx){
      if(!store)return textReply('Local output store unavailable.',true);
      try {return textReply(JSON.stringify({
        project:project(ctx),retentionDays:config.output.retentionDays,
        expiry:config.output.retentionDays===0?'disabled':'opportunistic on capture, batches of at most 100',
        ...store.stats({project:project(ctx)}),
        deletion:'Removal from local index and object store only; backups and filesystem snapshots may retain bytes.'
      },null,2));}
      catch(err){return textReply(`Could not inspect output retention: ${err.message}`,true);}
    }
  });

  pi.registerTool?.({
    name: 'envelope_search_output',
    label: 'Envelope: Search Captured Output',
    description: 'Search locally stored raw tool output within the current project; return IDs and short snippets, not full bodies.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for in raw tool output' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum matches (default 10)' }
      },
      required: ['query'], additionalProperties: false
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!store) return textReply('Local output store unavailable.', true);
      try {
        const {hits,coverage} = store.searchReport(params?.query, {project: project(ctx), limit: params?.limit});
        const message=hits.length?JSON.stringify(hits,null,2):coverage.partial
          ?'No verified captured output matched this query (search incomplete).':'No captured output matched this query.';
        const result=textReply(message,false,{searchCoverage:coverage});
        if(coverage.partial)result.content.push({type:'text',text:`Search incomplete; coverage: ${JSON.stringify(coverage)}`});
        return result;
      } catch (err) { return textReply(`Could not search output: ${err.message}`, true); }
    }
  });

  pi.registerCommand?.('envelope', {
    description: 'Manage Envelope modes and private local metrics; /envelope status|stats|metrics|observability|output|policy|context|code|graphify|workflow',
    async handler(args, ctx) {
      const rawArgs = String(args ?? '').trim();
      const [verb, value, ...extra] = rawArgs.toLowerCase().split(/\s+/);
      if (!verb || verb === 'status') {
        notify(ctx, `Envelope: output ${config.output.enabled ? 'on' : 'off'}; policy ${config.policy.enabled ? 'on' : 'off'}; context ${config.context.enabled ? 'on' : 'off'}; code ${config.code.enabled ? 'on' : 'off'}; workflow ${config.workflow.enabled ? 'on' : 'off'} (child ${config.workflow.runEnabled ? 'on' : 'off'}); ${metrics.compacted} results compacted`);
        return;
      }
      if (verb === 'observability') {
        if ((!value || value==='status') && !extra.length) {
          notify(ctx,`Envelope observability ${config.observability.enabled?'on':'off'}; local only; retention ${config.observability.retentionDays} days`);
          return;
        }
        if (!['on','off'].includes(value)||extra.length) {notify(ctx,'Usage: /envelope observability [on|off|status]','warning');return;}
        try { config=saveConfig(settingsPath,{...config,observability:{...config.observability,enabled:value==='on'}}); notify(ctx,`Envelope observability ${value}`); }
        catch(err){notify(ctx,`Envelope observability settings failed: ${err.message}`,'warning');}
        return;
      }
      if (verb === 'metrics') {
        if(value || extra.length){notify(ctx,'Usage: /envelope metrics','warning');return;}
        if(!metricLedger){notify(ctx,'Envelope metrics unavailable: local metrics database could not be opened','warning');return;}
        try {
          const s=metricLedger.snapshot(project(ctx));
          const out=s.byKind.output_compaction?.savedBytes??0, context=s.byKind.context_projection?.savedBytes??0;
          notify(ctx,`Envelope metrics: ${s.totalEvents} local events; output saved ${out} B; context projected ${context} B/request aggregate (not unique); model input ${s.modelUsage.inputTokens} tokens, output ${s.modelUsage.outputTokens}, cache-read ${s.modelUsage.cacheReadTokens}, provider-billed $${s.modelUsage.providerBilledUsd.toFixed(4)}, catalog-estimated $${s.modelUsage.catalogEstimatedUsd.toFixed(4)}. No claimed token savings.`);
        } catch(err){notify(ctx,`Envelope metrics read failed: ${err.message}`,'warning');}
        return;
      }
      if (verb === 'stats') {
        const local = store?.stats();
        notify(ctx, `Envelope: ${metrics.compacted}/${metrics.calls} results compacted; original ${metrics.rawBytes} B -> model ${metrics.renderedBytes} B; context ${metrics.contextCompacted} results compacted (${metrics.contextRawBytes} B -> ${metrics.contextRenderedBytes} B); ${local?.items ?? 0} stored outputs; workflows ${metrics.workflowRuns} spawned, ${metrics.workflowSubmitted} submitted, ${metrics.workflowFailed} failed`);
        return;
      }
      if (verb === 'memory') {
        if ((!value||value==='status')&&!extra.length) {
          notify(ctx,`Envelope project memory ${config.memory.enabled?'on':'off'} (explicit notes/Markdown import only; no transcript capture)`);
          return;
        }
        if(!['on','off'].includes(value)||extra.length){notify(ctx,'Usage: /envelope memory [status|on|off]','warning');return;}
        try{config=saveConfig(settingsPath,{...config,memory:{enabled:value==='on'}});notify(ctx,`Envelope project memory ${value}`);}
        catch(err){notify(ctx,`Envelope memory settings failed: ${err.message}`,'warning');}
        return;
      }
      if (verb === 'graphify-dotnet') {
        if ((!value || value==='status')&&!extra.length) {
          const s=await graphifyDotnet.status(ctx);
          notify(ctx,'Envelope Graphify.NET '+(s.enabled?'on':'off')+'; executable '+(s.available?'pinned and available':s.availabilityReason||'unavailable')+'; graph '+s.artifactState+' ('+s.nodes+' nodes, '+s.edges+' edges); AST-only human build, no model');return;
        }
        if(value==='binary') {
          const selected=rawArgs.replace(/^\S+\s+\S+\s*/,'').trim();
          try{
            if(!selected)throw new Error('absolute executable path required');
            const executable=selected.toLowerCase()==='none'?null:normalizeGraphifyDotnetExecutable(selected);
            config=saveConfig(settingsPath,{...config,graphifyDotnet:{...config.graphifyDotnet,executable}});
            graphifyDotnet.close?.();
            notify(ctx,'Envelope Graphify.NET executable '+(executable?'pinned':'cleared')+'; never auto-installed');
          }catch(err){notify(ctx,'Envelope Graphify.NET executable rejected: '+err.message,'warning');}
          return;
        }
        if(value==='build'&&!extra.length){
          try{
            if(!config.code.enabled)throw new Error('Envelope code intelligence disabled');
            const r=await graphifyDotnet.build(ctx);
            notify(ctx,'Envelope Graphify.NET AST-only build: '+r.artifactState+'; '+r.nodes+' nodes, '+r.edges+' edges; changed '+(r.artifactChanged?'yes':'no')+'; external assertion only');
          }catch(err){notify(ctx,'Envelope Graphify.NET build not enabled or failed: '+err.message,'warning');}
          return;
        }
        if((value==='on'||value==='off')&&!extra.length){
          try{
            config=saveConfig(settingsPath,{...config,graphifyDotnet:{...config.graphifyDotnet,enabled:value==='on'}});
            if(value==='off')graphifyDotnet.close?.();
            notify(ctx,'Envelope Graphify.NET '+value+'; no automatic execution or provider billing');
          }catch(err){notify(ctx,'Envelope Graphify.NET preference failed: '+err.message,'warning');}
          return;
        }
        notify(ctx,'Usage: /envelope graphify-dotnet [status|binary <absolute path>|binary none|on|off|build]','warning');return;
      }
      if (verb === 'graphify') {
        if ((!value || value==='status') && !extra.length) {
          const watch=graphifyCli.watchStatus(ctx);
          notify(ctx,`Envelope Graphify CLI ${config.graphify.enabled?'on':'off'}; binary ${config.graphify.executable?'pinned':'unconfigured'}; timeout ${config.graphify.timeoutMs} ms; orientation ${config.graphify.orientationEnabled?'on':'off'}; code-only watcher ${watch.active?'on':'off'} (${watch.watchedDirectories} directories, ${watch.pendingCodeFiles} pending, ${watch.batches} batches, manual rebuild ${watch.manualRebuildRequired?'required':'not flagged'}); no automatic LLM calls`);
          return;
        }
        if (value==='binary') {
          // Preserve the raw case and spaces in a user-selected absolute path.
          const selected=rawArgs.replace(/^\S+\s+\S+\s*/,'').trim();
          try {
            if (!selected)throw new Error('absolute executable path required');
            const executable=selected.toLowerCase()==='none'?null:normalizeGraphifyExecutable(selected);
            const changed=executable!==config.graphify.executable;
            config=saveConfig(settingsPath,{...config,graphify:{...config.graphify,executable}});
            if(changed)graphifyCli.close?.(); // changing the executable revokes active consent
            notify(ctx,`Envelope Graphify executable ${executable?'pinned':'cleared'}; never auto-installed`);
          } catch(err) {notify(ctx,`Envelope Graphify binary not changed: ${err.message}`,'warning');}
          return;
        }
        if (value==='orientation') {
          if(extra.length!==1||!['on','off'].includes(extra[0])){
            notify(ctx,'Usage: /envelope graphify orientation [on|off]','warning');return;
          }
          try{config=saveConfig(settingsPath,{...config,graphify:{...config.graphify,orientationEnabled:extra[0]==='on'}});
            notify(ctx,`Envelope Graphify graph orientation ${extra[0]} (one bounded existing prompt hook)`);}
          catch(err){notify(ctx,`Envelope Graphify orientation not changed: ${err.message}`,'warning');}
          return;
        }
        if (value==='watch') {
          const mode=extra[0]??'status';
          if(mode==='status'&&extra.length<=1) {
            const status=graphifyCli.watchStatus(ctx);
            notify(ctx,'Envelope Graphify watch '+(status.active?'on':'off')+
              '; directories '+status.watchedDirectories+
              '; pending code '+status.pendingCodeFiles+
              '; updating '+(status.updating?'yes':'no')+
              '; batches '+status.batches+
              '; manual rebuild '+(status.manualRebuildRequired?'required':'not flagged')+
              '; last '+status.lastOutcome+'; LLM never automatic');
            return;
          }
          if(mode==='off'&&extra.length===1) {
            try{await graphifyCli.watch(ctx,{enabled:false});notify(ctx,'Envelope Graphify watch stopped; no background rebuilds');}
            catch(err){notify(ctx,'Envelope Graphify watch stop failed: '+err.message,'warning');}
            return;
          }
          if(mode==='on'&&(extra.length===1||extra.length===2)) {
            const debounceMs=extra.length===2?Number(extra[1]):undefined;
            try{
              const status=await graphifyCli.watch(ctx,{enabled:true,debounceMs});
              notify(ctx,'Envelope Graphify code-only watch active in this session: '+
                status.watchedDirectories+' project directories, no LLM; docs/media require manual build');
            }catch(err){notify(ctx,'Envelope Graphify watch not enabled: '+err.message,'warning');}
            return;
          }
          notify(ctx,'Usage: /envelope graphify watch [status|on [250..10000 ms]|off]','warning');
          return;
        }
        if (value==='timeout') {
          const timeout=extra.length===1&&/^[1-9]\d{1,5}$/.test(extra[0])?Number(extra[0]):NaN;
          if (!Number.isInteger(timeout)||timeout<50||timeout>120000) {
            notify(ctx,'Usage: /envelope graphify timeout <50..120000 ms>','warning');return;
          }
          try {config=saveConfig(settingsPath,{...config,graphify:{...config.graphify,timeoutMs:timeout}});
            notify(ctx,`Envelope Graphify CLI timeout ${timeout} ms`);}
          catch(err){notify(ctx,`Envelope Graphify timeout not changed: ${err.message}`,'warning');}
          return;
        }
        if ((value==='build'||value==='update') && !extra.length) {
          try {
            // Always wait for a prior watch update, including a failed/halted one,
            // to settle before another operation writes the same graph.
            await graphifyCli.watch(ctx,{enabled:false});
            const report=await graphifyCli.run(ctx,{action:value},undefined,{humanCommand:true});
            notify(ctx,`Envelope Graphify ${value}: CLI exited successfully; artifact ${report.artifactState}; changed ${report.artifactChanged?'yes':'no'}; watcher stopped for manual rebuild. ${report.output.slice(0,300)}`);
          } catch(err){notify(ctx,`Envelope Graphify ${value} failed: ${err.message}`,'warning');}
          return;
        }
        if (['on','off'].includes(value) && !extra.length) {
          try {config=saveConfig(settingsPath,{...config,graphify:{...config.graphify,enabled:value==='on'}});
            if(value==='off')graphifyCli.close?.();
            notify(ctx,`Envelope Graphify CLI ${value}; no automatic external execution`);}
          catch(err){notify(ctx,`Envelope Graphify settings not saved: ${err.message}`,'warning');}
          return;
        }
        notify(ctx,'Usage: /envelope graphify [status|on|off|binary <absolute path>|binary none|timeout <ms>|orientation on|off|watch status|watch on [ms]|watch off|build|update]','warning');
        return;
      }
      if (verb === 'context') {
        if ((!value || value === 'status') && extra.length === 0) {
          try {
            const timeline = contextApi.state(ctx);
            notify(ctx, `Envelope context: ${config.context.enabled ? 'on' : 'off'}; active checkpoint ${timeline.active ?? 'none'}; ${timeline.checkpoints.length} checkpoints`);
          } catch (err) { notify(ctx, `Envelope context status unavailable: ${err.message}`, 'warning'); }
          return;
        }
        if (value === 'restore' && extra.length === 0) {
          try { contextApi.restore(ctx); notify(ctx, 'Envelope context: full transcript restored to future requests'); }
          catch (err) { notify(ctx, `Envelope context restore failed: ${err.message}`, 'warning'); }
          return;
        }
        if (!['on', 'off'].includes(value) || extra.length) {
          notify(ctx, 'Usage: /envelope context [status|on|off|restore]', 'warning');
          return;
        }
        try {
          config = saveConfig(settingsPath, { ...config, context: { ...config.context, enabled:value === 'on' } });
          if (value === 'off') {
            try { contextApi.restore(ctx); }
            catch (err) { notify(ctx, `Envelope context off, but checkpoint reset failed: ${err.message}`, 'warning'); }
          }
          notify(ctx, `Envelope context ${value}`);
        } catch (err) { notify(ctx, `Envelope context settings failed: ${err.message}`, 'warning'); }
        return;
      }
      if (verb === 'code') {
        if(value==='vectors'){
          const mode=extra[0]||'status';
          if(mode==='status'&&extra.length<=1){
            notify(ctx,`Envelope local vectors ${config.code.vectorEnabled?'on':'off'}; expects user-supplied .envelope/embeddings.json; no model or network`);return;
          }
          if(!['on','off'].includes(mode)||extra.length!==1){notify(ctx,'Usage: /envelope code vectors [status|on|off]','warning');return;}
          try{config=saveConfig(settingsPath,{...config,code:{...config.code,vectorEnabled:mode==='on'}});
            notify(ctx,`Envelope user-supplied local vector retrieval ${mode}; no model loaded or downloaded`);}
          catch(err){notify(ctx,`Envelope vector preference not saved: ${err.message}`,'warning');}
          return;
        }

        if(value==='versions') {
          const mode=extra[0]||'status';
          try {
            if(mode==='status'&&extra.length<=1){
              const s=await codeApi.versionStatus(ctx);
              notify(ctx,`Envelope graph versions: ${s.count} private metadata snapshots; explicit capture only`);return;
            }
            if(mode==='capture'&&extra.length===1){
              const s=await codeApi.captureVersion(ctx);
              notify(ctx,`Envelope graph version captured: ${s.version} (${s.files} files, ${s.symbols} symbols; ${s.existing?'already existed':'new'})`);return;
            }
            if(mode==='prune'&&extra.length===2&&/^(?:[1-9]|1[0-6])$/.test(extra[1])){
              const s=await codeApi.pruneVersions(ctx,Number(extra[1]));
              notify(ctx,`Envelope graph versions: pruned ${s.removed} snapshots; ${s.remaining} remain in this project (backups may persist)`);return;
            }
            notify(ctx,'Usage: /envelope code versions [status|capture|prune <1..16>]','warning');return;
          }catch(err){notify(ctx,`Envelope graph version operation failed: ${err.message}`,'warning');return;}
        }

        if(value==='tree') {
          const mode=extra[0];
          if((!mode||mode==='status')&&extra.length<=1){
            notify(ctx,`Envelope Tree-sitter ${config.code.treeEnabled?'on':'off'}; requires locally installed web-tree-sitter runtime and grammar WASM assets (lazy, no auto-download)`);
            return;
          }
          if(!['on','off'].includes(mode)||extra.length!==1){notify(ctx,'Usage: /envelope code tree [status|on|off]','warning');return;}
          try{config=saveConfig(settingsPath,{...config,code:{...config.code,treeEnabled:mode==='on'}});notify(ctx,`Envelope Tree-sitter ${mode}`);}
          catch(err){notify(ctx,`Envelope Tree-sitter settings failed: ${err.message}`,'warning');}
          return;
        }
        if(value==='languages') {
          const mode=extra[0];
          if(!['on','off'].includes(mode)||extra.length!==1){notify(ctx,'Usage: /envelope code languages [on|off]','warning');return;}
          try{config=saveConfig(settingsPath,{...config,code:{...config.code,languagesEnabled:mode==='on'}});notify(ctx,`Envelope Python/Go local AST ${mode}`);}
          catch(err){notify(ctx,`Envelope code language settings failed: ${err.message}`,'warning');}
          return;
        }
        if(value==='rename') {
          const mode=extra[0];
          if(!['on','off'].includes(mode)||extra.length!==1){notify(ctx,'Usage: /envelope code rename [on|off]','warning');return;}
          try{config=saveConfig(settingsPath,{...config,code:{...config.code,renameEnabled:mode==='on'}});notify(ctx,`Envelope code rename apply ${mode}`);}
          catch(err){notify(ctx,`Envelope code rename settings failed: ${err.message}`,'warning');}
          return;
        }
        if(value==='lsp') {
          if(extra.length!==1||extra[0]!=='status'){notify(ctx,'Usage: /envelope code lsp status','warning');return;}
          notify(ctx,`Envelope LSP: ${config.code.lspCommand?'configured (user-supplied argv)':'not configured'}; timeout ${config.code.lspTimeoutMs}ms; rename apply ${config.code.renameEnabled?'on':'off'}`);
          return;
        }
        if(value==='guard') {
          const mode=extra[0];
          if(!['on','off'].includes(mode)||extra.length!==1){notify(ctx,'Usage: /envelope code guard [on|off]','warning');return;}
          try{config=saveConfig(settingsPath,{...config,code:{...config.code,guardEnabled:mode==='on'}});notify(ctx,`Envelope code syntax guard ${mode}`);}
          catch(err){notify(ctx,`Envelope code guard settings failed: ${err.message}`,'warning');}
          return;
        }
        if ((!value || value === 'status') && !extra.length) {
          notify(ctx, `Envelope code: ${config.code.enabled ? 'on' : 'off'}; guard ${config.code.guardEnabled ? 'on' : 'off'}; Python/Go ${config.code.languagesEnabled?'on':'off'}; Tree-sitter ${config.code.treeEnabled?'on':'off'}; rename apply ${config.code.renameEnabled?'on':'off'}; LSP ${config.code.lspCommand?'configured':'off'}; ${codeApi.loaded()} project indexes initialized on demand`);
          return;
        }
        if (!['on', 'off'].includes(value) || extra.length) {
          notify(ctx, 'Usage: /envelope code [status|on|off|vectors on|vectors off|versions status|versions capture|versions prune <n>|languages on|languages off|tree on|tree off|tree status|guard on|guard off|rename on|rename off|lsp status]', 'warning');
          return;
        }
        try {
          config = saveConfig(settingsPath, { ...config, code:{...config.code,enabled:value === 'on'} });
          if(value==='off'){codeApi.close?.();graphifyCli.close?.();graphifyDotnet.close?.();} // Stop opt-in readers and CLI work on disable.
          notify(ctx, `Envelope code ${value}`);
        } catch(err) {notify(ctx, `Envelope code settings failed: ${err.message}`, 'warning');}
        return;
      }
      if(verb==='output' && value==='retention'){
        if(extra.length!==1 || !/^(?:0|[1-9]\d{0,2})$/.test(extra[0]) || Number(extra[0])>365){
          notify(ctx,'Usage: /envelope output retention <0..365> (0 disables automatic expiry)','warning');return;
        }
        try {config=saveConfig(settingsPath,{...config,output:{...config.output,retentionDays:Number(extra[0])}});
          lastOutputPrune.clear(); notify(ctx,`Envelope raw-output retention: ${config.output.retentionDays} days (0 = disabled; sweep occurs after successful captures)`);}
        catch(err){notify(ctx,`Envelope retention settings failed: ${err.message}`,'warning');}
        return;
      }
      if(verb==='output' && value==='erase'){
        if(extra.length!==1 || !/^[a-f0-9]{64}$/.test(extra[0])){notify(ctx,'Usage: /envelope output erase <64-hex-ID>','warning');return;}
        if(!store){notify(ctx,'Envelope raw store unavailable','warning');return;}
        try {const deleted=store.erase({id:extra[0],project:project(ctx)});
          notify(ctx,deleted?'Envelope output removed from local index and object storage (not backups).':'No matching output in this project.');}
        catch(err){notify(ctx,`Envelope output erasure failed: ${err.message}`,'warning');}
        return;
      }
      if(verb==='output' && value==='prune'){
        if(extra.length!==1 || !/^(?:0|[1-9]\d{0,2})$/.test(extra[0]) || Number(extra[0])>365){
          notify(ctx,'Usage: /envelope output prune <0..365 days> (0 = all existing outputs)','warning');return;
        }
        if(!store){notify(ctx,'Envelope raw store unavailable','warning');return;}
        try {const before=new Date(Date.now()-Number(extra[0])*86_400_000).toISOString();
          const r=store.prune({project:project(ctx),before,limit:100});
          notify(ctx,`Envelope raw output: ${r.deleted} records removed in this project; ${r.hasMore?'more remain, repeat command':'batch complete'}. Backups may persist.`);}
        catch(err){notify(ctx,`Envelope prune failed: ${err.message}`,'warning');}
        return;
      }
      if (verb === 'workflow') {
        if ((!value || value === 'status') && !extra.length) {
          try {const state=workflowApi.status(ctx);notify(ctx,`Envelope workflow ${config.workflow.enabled?'on':'off'}, child ${config.workflow.runEnabled?'on':'off'}; ${state.workflow?.name??'no workflow'}; ready ${state.ready.length}`);}
          catch(err){notify(ctx,`Envelope workflow: ${err.message}`,'warning');}
          return;
        }
        const isRun=value==='run';
        const action=isRun?extra[0]:value;
        if (!['on','off'].includes(action) || (isRun?extra.length!==1:extra.length!==0)) {
          notify(ctx,'Usage: /envelope workflow [status|on|off|run on|run off]','warning');
          return;
        }
        try {
          const next={...config.workflow,...(isRun?{runEnabled:action==='on'}:{enabled:action==='on'})};
          config=saveConfig(settingsPath,{...config,workflow:next});
          notify(ctx,`Envelope workflow ${isRun?'child run':'state'} ${action}`);
        }catch(err){notify(ctx,`Envelope workflow settings failed: ${err.message}`,'warning');}
        return;
      }
      if ((verb !== 'policy' && verb !== 'output') || !['on', 'off'].includes(value) || extra.length) {
        notify(ctx, 'Usage: /envelope [status|stats|metrics|observability on/off|output on/off/retention <days>/erase <id>/prune <days>|policy on/off|context status/on/off/restore|graphify status/on/off/binary/timeout/build/update|code status/on/off/languages on/languages off/guard on/guard off/rename on/rename off/lsp status|workflow status/on/off/run on/run off]', 'warning');
        return;
      }
      const next = {
        ...config,
        [verb]: { ...config[verb], enabled: value === 'on' }
      };
      try {
        config = saveConfig(settingsPath, next);
        notify(ctx, `Envelope: ${verb} ${value}`);
      } catch (err) {
        notify(ctx, `Envelope: failed to save settings: ${err.message}`, 'warning');
      }
    }
  });

  return { metrics, getConfig: () => config, close: () => {graphifyDotnet.close?.();graphifyCli.close?.();codeApi.close?.(); store?.close(); frontier?.close(); projectMemory?.close(); workflowLedger?.close(); metricLedger?.close();} };
}

export default registerEnvelope;
