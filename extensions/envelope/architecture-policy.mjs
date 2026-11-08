/**
 * Explicit, read-only architecture policy over native AST import/call evidence.
 * Does not install a CI hook, run project code or confuse heuristic fan-in
 * metrics with correctness, formal-method proof or runtime dependencies.
 */
import {inspectCodeGraph} from './graph-intelligence.mjs';
const bounded=(value,defaultValue,min,max,label)=>{
 if(value===undefined)return defaultValue;
 if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`${label} must be ${min}..${max}`);
 return value;
};
export function evaluateArchitecturePolicy(index,{rules=[],relation='imports',maxIncomingFiles,requireComplete=true,limit=50}={}){
 if(!index?.files||typeof index.checkedPath!=='function')throw new TypeError('current CodeIndex required');
 if(!Array.isArray(rules)||rules.length>12)throw new TypeError('policy rules must be a bounded array');
 if(!['imports','calls','both'].includes(relation))throw new TypeError('invalid architecture relation');
 if(typeof requireComplete!=='boolean')throw new TypeError('requireComplete must be boolean');
 limit=bounded(limit,50,1,50,'limit');
 if(maxIncomingFiles!==undefined)maxIncomingFiles=bounded(maxIncomingFiles,undefined,1,500,'maxIncomingFiles');
 if(!rules.length&&maxIncomingFiles===undefined)throw new Error('policy needs at least one boundary or fan-in rule');
 const state=inspectCodeGraph(index,{action:'status',relation});
 const boundaries=rules.length ? inspectCodeGraph(index,{action:'boundaries',rules,relation,limit}):
   {action:'boundaries',mode:'advisory-static-dependency-audit',total:0,violations:[],truncated:false,complete:state.complete,reasons:state.reasons};
 const hubs=maxIncomingFiles===undefined?null:inspectCodeGraph(index,{action:'hubs',relation,limit:30});
 const violations=hubs?.hubs.filter(x=>x.incomingFiles>maxIncomingFiles)||[];
 const known=violations.length;
 const potentiallyMore=Boolean(hubs?.truncated&&known===hubs.hubs.length);
 const fanIn={enabled:maxIncomingFiles!==undefined,threshold:maxIncomingFiles??null,knownViolations:known,
   potentiallyMore,violations:violations.slice(0,limit),truncated:violations.length>limit||potentiallyMore,
   total:known};
 const reasons=[...state.reasons];
 if(boundaries.truncated)reasons.push('boundary-report-limit');
 if(fanIn.truncated)reasons.push('fan-in-report-limit');
 const complete=state.complete&&!boundaries.truncated&&!fanIn.truncated;
 const hasViolation=boundaries.total>0||known>0;
 const pass=!hasViolation&&(!requireComplete||complete);
 return {mode:'advisory-policy-over-static-evidence',relation,pass,requireComplete,
   complete,reasons:[...new Set(reasons)],evidence:'current-index-static-imports-and-conservative-calls',
   boundaries:{ruleCount:rules.length,total:boundaries.total,violations:boundaries.violations,truncated:boundaries.truncated},
   fanIn,sourceFileCount:state.files,edgeCount:state.edges,
   note:'A policy pass means only the inspected native static evidence met these explicit rules; no runtime safety or architecture correctness proof.'};
}
