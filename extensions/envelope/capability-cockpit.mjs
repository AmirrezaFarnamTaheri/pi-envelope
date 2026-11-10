/** Deterministic read-only Pi capability discovery and safe workflow routing.
 * Detecting an executable does not imply a supported runtime or permission to
 * invoke it. No tool is executed and no PATH/environment values are returned.
 */
import {accessSync,constants,lstatSync} from 'node:fs';
import {join} from 'node:path';
const CLI=['graphify','jcodemunch','rtk','headroom'];
const ROUTES={
 orient:['envelope_code_overview','envelope_code_retrieve','envelope_code_graph'],
 graph:['envelope_code_external_graph','envelope_code_graph','envelope_code_policy'],
 review:['envelope_code_change_impact','envelope_code_policy','envelope_code_verify'],
 resume:['envelope_memory','envelope_workflow_status','envelope_code_context_card'],
 evidence:['envelope_code_context_card','envelope_code_history','envelope_metrics_snapshot'],
 jobs:['envelope_job','envelope_agent_start'],
};
function hasExecutable(name,pathEnv){
 if(typeof pathEnv!=='string'||pathEnv.length>4096)return false;
 const folders=pathEnv.split(':').slice(0,24);
 for(const folder of folders){
  if(!folder||!folder.startsWith('/')||folder.length>250)continue;
  try{
   const path=join(folder,name),st=lstatSync(path);
   if(st.isSymbolicLink()||!st.isFile())continue;
   accessSync(path,constants.X_OK);
   return true;
  }catch{/* Treat inaccessible commands as absent; do not execute them. */}
 }
 return false;
}
export function inspectCapabilityCockpit(config,{intent='orient',pathEnv=process.env.PATH||''}={}){
 if(!ROUTES[intent])throw new TypeError('unsupported capability route intent');
 const enabled=(name)=>config?.[name]?.enabled===true;
 const code=enabled('code'),memory=enabled('memory'),workflow=enabled('workflow');
 const graphifyCli=code&&enabled('graphify')&&typeof config?.graphify?.executable==='string'&&config.graphify.executable.length>0;
 const capabilities={
  code:code?'enabled':'disabled',graph:code?'native-static':'disabled',
  externalGraph:code?'opt-in-local-artifact':'disabled',
  graphifyCli:graphifyCli?'configured-unverified':'disabled',
  memory:memory?'enabled':'disabled',context:enabled('context')?'enabled':'disabled',
  output:enabled('output')?'enabled':'disabled',
  workflow:workflow?'enabled':'disabled',childRunner:workflow&&config?.workflow?.runEnabled?'opt-in-enabled':'disabled',
  jobs:enabled('jobs')?'enabled':'disabled',backgroundAgent:config?.jobs?.agentEnabled?'opt-in-enabled':'disabled',
  metrics:enabled('observability')?'enabled':'disabled',
  optionalTree:code&&config?.code?.treeEnabled?'opt-in-enabled':'disabled',
  syntaxGuard:code&&config?.code?.guardEnabled?'opt-in-enabled':'disabled',
 };
 const externalCli=Object.fromEntries(CLI.map(name=>[name,hasExecutable(name,pathEnv)?'detected-unverified':'not-detected']));
 const tools=intent==='graph'&&graphifyCli ? [ROUTES.graph[0],'envelope_graphify_cli',...ROUTES.graph.slice(1)] : ROUTES[intent];
 const plan=tools.map(tool=>{
  const category=tool.startsWith('envelope_code_')?'code':tool==='envelope_memory'?'memory':
    tool==='envelope_graphify_cli'?'graphify':tool.startsWith('envelope_workflow_')?'workflow':tool.startsWith('envelope_metrics_')?'metrics':
    tool==='envelope_job'?'jobs':tool==='envelope_agent_start'?'agent':null;
  const available=category==='code'?code:category==='graphify'?graphifyCli:category==='memory'?memory:category==='workflow'?workflow:category==='metrics'?enabled('observability'):
    category==='jobs'?enabled('jobs'):category==='agent'?config?.jobs?.agentEnabled===true:true;
  return {tool,state:available?'suggested':'blocked',reason:available?null:`${category}-disabled`};
 });
 const reasons=[...new Set(plan.filter(x=>x.reason).map(x=>x.reason))];
 return {mode:'read-only-capability-advisory',intent,capabilities,externalCli,plan,reasons,
   toolExecution:false,externalProviderCalls:false,automaticSkillEnforcement:false,
   note:'External CLI detection and pinned Graphify settings are presence/configuration only, not proof of runtime compatibility. Routes are advisory; no tools or skills were invoked.'};
}
export function registerCapabilityCockpit(pi,{getConfig}={}){
 pi.registerTool?.({
  name:'envelope_capabilities',label:'Envelope: Local Capability Cockpit',
  description:'Inspect actual Envelope mode toggles and bounded local CLI presence, then suggest a deterministic manual evidence workflow. Never executes an external tool or enforces skills automatically.',
  parameters:{type:'object',properties:{intent:{type:'string',enum:Object.keys(ROUTES)}},additionalProperties:false},
  async execute(_id,params){
   try{const report=inspectCapabilityCockpit(getConfig(),{intent:params?.intent});
     return {isError:false,content:[{type:'text',text:JSON.stringify(report,null,2)}],details:{}};}
   catch(e){return {isError:true,content:[{type:'text',text:`Envelope capabilities: ${e.message}`}],details:{}};}
  }
 });
}
