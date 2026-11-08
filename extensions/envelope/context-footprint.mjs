/** Read-only, privacy-preserving size accounting for Pi's exposed prompt inputs.
 * No injected content is returned, logged, persisted or modified. */
const bytes=(value)=>typeof value==='string'?Buffer.byteLength(value):0;
const count=(value)=>Array.isArray(value)?value.length:0;

export function contextFootprint(ctx){
  if(typeof ctx?.getSystemPromptOptions!=='function')return {
    status:'unavailable',reason:'This Pi host does not expose getSystemPromptOptions; no prompt size or token estimate is claimed.'
  };
  let opts;
  try {opts=ctx.getSystemPromptOptions();}
  catch{return {status:'unavailable',reason:'Pi rejected the read-only prompt snapshot.'};}
  if(!opts||typeof opts!=='object'||typeof opts.then==='function')return {
    status:'unavailable',reason:'The prompt snapshot is unavailable or asynchronous.'
  };
  const contextFiles=Array.isArray(opts.contextFiles)?opts.contextFiles:[];
  const sections=Array.isArray(opts.customSections)?opts.customSections:[];
  const promptBytes=['customSystemPrompt','forcedSystemPrompt','appendSystemPrompt','systemPrompt'].reduce((total,key)=>total+bytes(opts[key]),0);
  const contextBytes=contextFiles.reduce((total,file)=>total+bytes(file?.content),0);
  const sectionBytes=sections.reduce((total,section)=>total+bytes(section?.content),0);
  return {
    status:'available',scope:'host-exposed-base-inputs-only',
    contextFileCount:contextFiles.length,toolCount:count(opts.activeTools),
    customSectionCount:sections.length,
    measuredContentBytes:promptBytes+contextBytes+sectionBytes,
    categories:{basePromptBytes:promptBytes,contextFileBytes:contextBytes,customSectionBytes:sectionBytes},
    notes:'Byte counts are not tokens, do not include all provider/request transforms, and do not reflect billed usage. No names, paths or contents are exposed.'
  };
}
