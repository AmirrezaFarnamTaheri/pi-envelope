/** Read-only Pi-native observability queries; no duplicate Tersio dashboard or event modifiers. */
const textReply=(value,isError=false)=>({
  isError,content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}],details:{}
});
const schema=(properties={})=>({type:'object',properties,additionalProperties:false});

export function registerMetricsFeature(pi,{getLedger,project}){
  const tool=(name,label,description,parameters,fn)=>pi.registerTool?.({
    name,label,description,parameters,
    async execute(_callId,params,_signal,_update,ctx){
      try {
        const ledger=getLedger();
        if(!ledger) throw new Error('Metrics database unavailable. Coding tools continue normally.');
        return textReply(fn(ledger,project(ctx),params||{}));
      }catch(err){return textReply(`Envelope observability: ${err instanceof Error?err.message:String(err)}`,true);}
    }
  });
  tool('envelope_metrics_snapshot','Envelope: Project Metrics',
    'Private, local, project-scoped aggregate of Envelope output/context byte savings, provider-reported usage and workflow/code actions. This is not a live cost-savings benchmark.',
    schema(),(ledger,root)=>ledger.snapshot(root));
  tool('envelope_metrics_events','Envelope: Recent Metric Events',
    'Read the most recent scoped numeric Envelope metrics, without prompt contents or raw file/command paths.',
    schema({limit:{type:'integer',minimum:1,maximum:50,description:'Number of events (default 10)'}}),
    (ledger,root,params)=>ledger.events(root,{limit:params.limit}));
}
