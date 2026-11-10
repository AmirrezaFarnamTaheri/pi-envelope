/** Small, opt-in Pi TUI workspace panel.
 * No custom terminal renderer, raw source paths, encoder paths, credentials,
 * model metadata, terminal escape sequences or implicit executable calls.
 * All lines are ASCII and bounded for narrow terminals and RPC notifications.
 */
const enabled=(settings,key)=>settings?.[key]?.enabled===true;
const capped=(value)=>Number.isSafeInteger(value)&&value>=0?Math.min(value,9999):0;
const mode=(active)=>active?'ON':'OFF';
const health=(status)=>{
 if(status?.manualRebuildRequired||status?.queueOverflow)return 'REVIEW REQUIRED';
 if(status?.active)return status.updating?'WATCHING (SYNCING)':'WATCHING';
 return 'OFF';
};
export function formatEmbeddingFooter(watch){
 if(watch?.manualRebuildRequired||watch?.queueOverflow)return 'Envelope vectors: REVIEW';
 if(watch?.active)return watch.updating?'Envelope vectors: SYNCING':'Envelope vectors: WATCH ON';
 return undefined;
}
/** Derive an actionable, read-only and bounded panel from already available state. */
export function formatEnvelopeDashboard(config,{vectorWatch,graphWatch,loaded=0}={}){
 const v=vectorWatch||{},g=graphWatch||{};
 const code=enabled(config,'code'),vectors=code&&config?.code?.vectorEnabled===true;
 const pinned=typeof config?.code?.vectorExecutable==='string'&&config.code.vectorExecutable.length>0;
 const graphMode=enabled(config,'graphify'),ctx=enabled(config,'context'),wf=enabled(config,'workflow');
 const vectorState=!vectors?'OFF':!pinned?'NO ENCODER':health(v);
 const graphState=g?.manualRebuildRequired?'REVIEW REQUIRED':!graphMode?'OFF':g.active?'WATCHING':'ON DEMAND';
 const lines=[
  'ENVELOPE / WORKSPACE',
  'CODE      '+mode(code)+'    CONTEXT '+mode(ctx)+'    WORKFLOW '+mode(wf),
  'VECTORS   '+vectorState+(v.active?'  |  '+capped(v.pendingCodeFiles)+' pending  '+capped(v.batches)+' batches':''),
  'GRAPHIFY  '+graphState+'    MEMORY '+mode(enabled(config,'memory')),
 ];
 if(vectorState==='REVIEW REQUIRED'){
  lines.push('NEXT      Review files; /envelope code vectors watch off');
  lines.push('THEN      /envelope code vectors sync; watch on');
 }else if(!vectors){
  lines.push('NEXT      /envelope code vectors on (opt-in, no download)');
 }else if(!pinned){
  lines.push('NEXT      /envelope code vectors encoder <trusted executable>');
 }else if(v.active){
  lines.push('NEXT      /envelope code vectors watch status | watch off');
 }else{
  lines.push('NEXT      /envelope code vectors build; watch on (session)');
 }
 if(g?.manualRebuildRequired)lines.push('GRAPH     Review artifact; /envelope graphify status');
 lines.push('INDEX     '+capped(loaded)+' project caches  |  /envelope dashboard hide');
 lines.push('PRIVACY   Local state only; external models are not bundled');
 return lines;
}
