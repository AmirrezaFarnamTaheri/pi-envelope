/** Pi-native context control plane. One context handler, one local ledger. */
import { projectContext } from './context-projection.mjs';
import { contextFootprint } from './context-footprint.mjs';

const reply = (text, isError = false, details = {}) => ({
  isError,
  content: [{ type:'text', text }],
  details
});

const noArgs = {type:'object',properties:{},additionalProperties:false};
const nameParam = (key) => ({
  type:'object',
  properties:{[key]:{type:'string',description:'Previously recorded checkpoint name'}},
  required:[key],additionalProperties:false
});

export function sessionIdentity(ctx) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Pi session manager with a session ID is required');
  }
  return sessionId;
}

/**
 * @param {object} pi Pi's registration surface.
 * @param {{ledger:object,getStore:Function,getConfig:Function,project:Function,metrics:object}} deps
 */
export function registerContextFeature(pi, deps) {
  const {ledger,getStore,getConfig,project,metrics,observe} = deps;
  const scope = (ctx) => ({project:project(ctx),sessionId:sessionIdentity(ctx)});
  const state = (ctx) => {
    const {project:cwd,sessionId} = scope(ctx);
    return ledger.timeline(cwd,sessionId);
  };
  const restore = (ctx) => {
    const {project:cwd,sessionId} = scope(ctx);
    return ledger.restore(cwd,sessionId);
  };

  pi.on('context', (event,ctx) => {
    const started=performance.now();
    metrics.contextCalls++;
    const settings = getConfig().context;
    const store = getStore();
    if (!settings.enabled || !store || !Array.isArray(event?.messages)) return;
    try {
      const {project:cwd,sessionId} = scope(ctx);
      const snapshot=ledger.read(cwd,sessionId);
      const active=snapshot.checkpoints.find((entry)=>entry.name===snapshot.active);
      if (!active) return;
      const result = projectContext(event.messages,{
        ...settings,project:cwd,store,anchorCallId:active.callId
      });
      if (!result.changed) return;
      metrics.contextCompacted += result.compacted;
      metrics.contextRawBytes += result.rawBytes;
      metrics.contextRenderedBytes += result.renderedBytes;
      observe?.(ctx,'context_projection',{rawBytes:result.rawBytes,renderedBytes:result.renderedBytes,durationMs:performance.now()-started});
      return {messages:result.messages};
    } catch (err) {
      pi.logger?.warn?.(`[envelope] context projection disabled for this request: ${err.message}`);
    }
  });

  pi.registerTool?.({
    name:'envelope_context_footprint',label:'Envelope: Prompt Footprint',
    description:'Report only byte counts for host-exposed prompt sections, context files and tool names, not the text or paths. Read-only and never injects context.',
    parameters:noArgs,
    async execute(_id,_params,_signal,_update,ctx){
      return reply(JSON.stringify(contextFootprint(ctx),null,2));
    }
  });

  pi.registerTool?.({
    name:'envelope_context_checkpoint',label:'Envelope: Context Checkpoint',
    description:'Save a named position in the current Pi session. This does not prune or summarize anything.',
    parameters:nameParam('name'),
    async execute(toolCallId,params,_signal,_update,ctx) {
      try {
        const {project:cwd,sessionId}=scope(ctx);
        const checkpoint=ledger.checkpoint(cwd,sessionId,{name:params?.name,callId:toolCallId});
        return reply(`Checkpoint "${checkpoint.name}" recorded; no context has been pruned.`,false,checkpoint);
      } catch (err) { return reply(`Could not save context checkpoint: ${err.message}`,true); }
    }
  });

  pi.registerTool?.({
    name:'envelope_context_timeline',label:'Envelope: Context Timeline',
    description:'View named checkpoints and which checkpoint, if any, bounds active recoverable historical pruning.',
    parameters:noArgs,
    async execute(_id,_params,_signal,_update,ctx) {
      try {return reply(JSON.stringify(state(ctx),null,2));}
      catch(err) {return reply(`Could not read context timeline: ${err.message}`,true);}
    }
  });

  pi.registerTool?.({
    name:'envelope_context_prune',label:'Envelope: Activate Recoverable Pruning',
    description:'Only after /envelope context on: activate a named checkpoint for cache-friendly reversible pruning of older successful tool results. Does not rewrite the session transcript.',
    parameters:nameParam('checkpoint'),
    async execute(_id,params,_signal,_update,ctx) {
      if (!getConfig().context.enabled) return reply('Context pruning is disabled. Use /envelope context on before activating a checkpoint.',true);
      if (!getStore()) return reply('Raw output store unavailable; pruning cannot preserve original results.',true);
      try {
        const {project:cwd,sessionId}=scope(ctx);
        const anchor=ledger.activate(cwd,sessionId,params?.checkpoint);
        return reply(`Recoverable pruning armed before checkpoint "${anchor.name}" on branches containing its tool-call anchor. Latest messages and current user instructions are protected.`,false,{checkpoint:anchor.name});
      } catch (err) {return reply(`Could not activate pruning: ${err.message}`,true);}
    }
  });

  pi.registerTool?.({
    name:'envelope_context_restore',label:'Envelope: Restore Full Context',
    description:'Deactivate the context projection. Pi transcript and stored raw output were never rewritten.',
    parameters:noArgs,
    async execute(_id,_params,_signal,_update,ctx) {
      try {restore(ctx);return reply('Context projection deactivated; the full Pi transcript is available again.');}
      catch(err) {return reply(`Could not deactivate context projection: ${err.message}`,true);}
    }
  });

  return { state, restore };
}
