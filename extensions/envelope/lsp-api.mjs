/** LSP-specific tools built over Envelope's existing one-index-per-project service. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLspSession } from './lsp-client.mjs';
import { planRename, applyRename } from './rename-transaction.mjs';

const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const textResult=(value,isError=false)=>({isError,content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}],details:{}});
const short=(text,max=340)=>String(text||'LSP unavailable').replace(/[\r\n]+/g,' ').slice(0,max);
function normalizeDiagnostic(d){
  const severity=['error','warning','info','hint'][d?.severity-1]||'warning';
  return {severity,line:(Number.isInteger(d?.range?.start?.line)?d.range.start.line:0)+1,
    column:(Number.isInteger(d?.range?.start?.character)?d.range.start.character:0)+1,
    code:String(d?.code??'').slice(0,32),message:short(d?.message,420),source:String(d?.source??'lsp').slice(0,50)};
}
function diagnosticReport(raw){
  if(raw.status!=='verified')return {verdict:'UNVERIFIED',source:'lsp',reason:short(raw.reason),diagnostics:[]};
  if(!Array.isArray(raw.diagnostics)||raw.diagnostics.length>1000)return {verdict:'UNVERIFIED',source:'lsp',reason:'LSP diagnostics exceeded the bounded response contract',diagnostics:[]};
  if(raw.diagnostics.some(d=>!d?.range?.start||!d?.range?.end||!Number.isInteger(d.range.start.line)||!Number.isInteger(d.range.start.character)||d.range.start.line<0||d.range.start.character<0))
    return {verdict:'UNVERIFIED',source:'lsp',reason:'LSP returned invalid diagnostic positions',diagnostics:[]};
  const all=raw.diagnostics.map(normalizeDiagnostic);
  const failures=all.filter(d=>d.severity==='error').length;
  const warnings=all.filter(d=>d.severity==='warning').length;
  const infra=all.filter(d=>/cannot find (module|name)|missing tsconfig|failed to load config/i.test(d.message)).length;
  const untrusted=all.length>=2&&infra>all.length/2;
  return {verdict:untrusted?'UNVERIFIED':failures?'FAIL':warnings?'WARN':'PASS',
    source:`lsp-${raw.source}`,totalDiagnostics:all.length,errorCount:failures,warningCount:warnings,
    ...(untrusted?{reason:'LSP diagnostics appear dominated by missing-project infrastructure; not treated as a reliable verdict'}:{}),
    diagnostics:all.slice(0,20),truncatedDiagnostics:Math.max(0,all.length-20)};
}

export function registerLspFeature(pi,{indexOf,getConfig,home,observe}={}) {
  async function withIndex(ctx,signal,action){
    const index=await indexOf(ctx);
    const config=getConfig();const command=config.code.lspCommand;
    if(!command)return {index,configured:false};
    return {index,configured:true,run:(callback)=>withLspSession({root:index.root,command,timeoutMs:config.code.lspTimeoutMs,signal},callback)};
  }
  function tool(name,label,description,parameters,run){
    pi.registerTool?.({name,label,description,parameters,
      async execute(_id,params,signal,_update,ctx){
        const started=performance.now();let result;
        try{result=await run(ctx,params||{},signal);}catch(err){result=textResult(`LSP: ${short(err.message)}`,true);}
        observe?.(ctx,'code_query',{action:name,outcome:result.isError?'error':'ok',durationMs:performance.now()-started});
        return result;
      }
    });
  }
  tool('envelope_code_lsp_verify','Envelope: LSP Diagnostics',
    'Request fresh diagnostics from a user-configured external language server. PASS is issued only after a full or matching push report; timeout/absence is UNVERIFIED. Never edits files.',
    schema({path:{type:'string',description:'Indexed, project-relative JS/TS source file'}},['path']),
    async (ctx,params,signal)=>{
      const runner=await withIndex(ctx,signal);
      const key=runner.index.checkedPath(params.path);
      if(!runner.configured)return textResult({verdict:'UNVERIFIED',reason:'No LSP server configured in envelope.code.lspCommand',diagnostics:[]});
      let report;
      try{
        report=await runner.run(async session=>{
          await session.open(key,readFileSync(join(runner.index.root,key),'utf8'));
          return diagnosticReport(await session.diagnostics(key));
        });
      }catch(err){report={verdict:'UNVERIFIED',reason:short(err.message),diagnostics:[]};}
      return textResult({path:key,...report});
    });

  tool('envelope_code_rename','Envelope: LSP Symbol Rename',
    'Preview language-server rename edits in indexed JS/TS files. Applying needs /envelope code rename on AND a matching preview planId; source is rechecked, staged, backed up and rollback is attempted on failure. No cross-file crash-atomicity.',
    schema({path:{type:'string',description:'Indexed project-relative source file'},
      line:{type:'integer',minimum:1,description:'One-based symbol cursor line'},
      column:{type:'integer',minimum:1,description:'One-based UTF-16 cursor column'},
      newName:{type:'string',description:'New identifier name'},
      apply:{type:'boolean',description:'False by default: preview only'},
      planId:{type:'string',description:'Required exact 64-digit SHA-256 preview identifier when apply is true'}},['path','line','column','newName']),
    async (ctx,params,signal)=>{
      const runner=await withIndex(ctx,signal);const config=getConfig();
      if(params.apply===true&&!config.code.renameEnabled)throw new Error('Rename apply disabled; enable with /envelope code rename on');
      if(params.apply===true&&(!/^[0-9a-f]{64}$/.test(params.planId||'')))throw new Error('A matching preview planId is required for rename apply');
      if(!runner.configured)throw new Error('No LSP server configured in envelope.code.lspCommand');
      const key=runner.index.checkedPath(params.path);
      let output;
      const plan=await runner.run(async session=>{
        const openedText=readFileSync(join(runner.index.root,key),'utf8');
        await session.open(key,openedText);
        const workspaceEdit=await session.rename(key,params.line,params.column,params.newName);
        const planned=planRename({index:runner.index,workspaceEdit,request:{...params,path:key}});
        if(planned.files.find(f=>f.path===key).originalText!==openedText)throw new Error('rename source changed while LSP was preparing edits');
        if(params.apply===true){
          // Check every touched source, not merely the initiating document.
          // A single missing or unreliable report blocks the entire file transaction.
          for(const file of planned.files){
            if(file.path!==key)await session.open(file.path,file.originalText);
            const diagnostic=diagnosticReport(await session.diagnostics(file.path));
            if(diagnostic.verdict==='UNVERIFIED'||diagnostic.verdict==='FAIL')throw new Error(`LSP rename safety check failed in ${file.path}: ${diagnostic.verdict}`);
          }
        }
        return planned;
      });
      if(params.apply===true){
        const outcome=applyRename({index:runner.index,plan,expectedId:params.planId,lockRoot:join(home,'envelope-rename-locks'),signal});
        runner.index.refresh();output={...outcome,notice:'Committed with staged files and ordinary-error rollback; multi-file crash-atomicity is not guaranteed'};
      }else{
        output={applied:false,planId:plan.id,from:plan.oldName,to:plan.newName,changes:plan.changeCount,
          files:plan.preview,notice:'Dry-run only; to apply, run /envelope code rename on and repeat with apply=true plus this planId. External server must also return reliable diagnostics.'};
      }
      return textResult(output);
    });
}
