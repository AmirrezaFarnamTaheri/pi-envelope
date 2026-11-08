/** Local-only, payload-free event accounting. This never replaces Tersio's own usage ledger. */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const KINDS=new Set(['output_compaction','context_projection','model_usage','code_query','workflow_action','graphify_cli']);
const ACTIONS={
  code_query:new Set(['envelope_code_overview','envelope_code_languages','envelope_code_tree_status','envelope_code_tree_query','envelope_code_tree_capture','envelope_code_lookup','envelope_code_calls','envelope_code_impact','envelope_code_change_impact','envelope_code_verify','envelope_code_delta','envelope_code_slice','envelope_code_coupling','envelope_code_versions','envelope_code_vector','envelope_code_invariant','envelope_code_typecheck']),
  graphify_cli:new Set(['status','query','path','explain','build','update']),
  workflow_action:new Set(['envelope_workflow_create','envelope_workflow_status','envelope_workflow_claim','envelope_workflow_finish','envelope_workflow_review','envelope_workflow_retry','envelope_workflow_events','envelope_workflow_handoff','envelope_workflow_run'])
};
const OUTCOMES=new Set(['ok','error','review','completed','failed']);
const NUMBERS=new Set(['rawBytes','renderedBytes','durationMs','inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','costUsd']);
const FIELDS=new Set([...NUMBERS,'action','outcome','providerBilled']);
const BYTES_MAX=2_000_000_000; // 10,000 retained events cannot overflow JS safe integer sums.
const MILLIS_MAX=3_600_000;
const USD_MAX=100_000;
const scopeKey=(project)=>{
  if(typeof project!=='string'||!project.trim()) throw new TypeError('project must be a nonempty string');
  return createHash('sha256').update(project).digest('hex');
};
const safeNumber=(name,value)=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0) throw new TypeError(`${name} must be a finite nonnegative number`);
  const max=name==='durationMs'?MILLIS_MAX:name==='costUsd'?USD_MAX:BYTES_MAX;
  if(value>max) throw new RangeError(`${name} is too large`);
  if(name!=='durationMs'&&name!=='costUsd'&&!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  return value;
};
function clean(kind,data){
  if(!KINDS.has(kind)) throw new TypeError('unknown metrics event kind');
  if(!data||typeof data!=='object'||Array.isArray(data)) throw new TypeError('metrics fields must be an object');
  for(const key of Object.keys(data)) if(!FIELDS.has(key)) throw new TypeError(`unexpected metrics field: ${key}`);
  const action=data.action??'';
  if(typeof action!=='string'||(action&&!ACTIONS[kind]?.has(action))||((kind==='code_query'||kind==='workflow_action'||kind==='graphify_cli')&&!action)) throw new TypeError('unrecognized metrics action');
  const outcome=data.outcome??'ok';
  if(!OUTCOMES.has(outcome)) throw new TypeError('invalid outcome');
  if(data.providerBilled!==undefined&&typeof data.providerBilled!=='boolean') throw new TypeError('providerBilled must be boolean');
  const nums=Object.fromEntries([...NUMBERS].map(key=>[key,safeNumber(key,data[key]??0)]));
  if(kind==='output_compaction'||kind==='context_projection'){
    if(nums.renderedBytes>nums.rawBytes) throw new RangeError('renderedBytes exceeds rawBytes');
  }
  return {...nums,action,outcome,providerBilled:data.providerBilled===true};
}
const checkClosed=(self)=>{if(self.closed)throw new Error('metrics ledger is closed');};

export class MetricsLedger {
  constructor(home,{now=Date.now,maxEvents=10000,retentionDays=30}={}){
    if(typeof home!=='string'||!home.trim()) throw new TypeError('metrics home path required');
    if(typeof now!=='function') throw new TypeError('now must be a function');
    if(!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>100000) throw new TypeError('maxEvents must be 1-100000');
    if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>365) throw new TypeError('retentionDays must be 1-365');
    this.now=now;this.maxEvents=maxEvents;this.retentionMs=retentionDays*86400000;
    mkdirSync(home,{recursive:true,mode:0o700});chmodSync(home,0o700);
    const filename=join(home,'envelope-metrics.sqlite');
    this.db=new DatabaseSync(filename);chmodSync(filename,0o600);
    this.db.exec(`
      PRAGMA busy_timeout=2000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_key TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
        outcome TEXT NOT NULL, raw_bytes INTEGER NOT NULL, rendered_bytes INTEGER NOT NULL,
        duration_ms REAL NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL, provider_billed INTEGER NOT NULL, at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS metric_project_seq ON events(project_key,seq);
      CREATE INDEX IF NOT EXISTS metric_time ON events(at_ms);
    `);
    this.add=this.db.prepare(`INSERT INTO events
      (project_key,kind,action,outcome,raw_bytes,rendered_bytes,duration_ms,input_tokens,
       output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,provider_billed,at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.deleteOld=this.db.prepare('DELETE FROM events WHERE at_ms < ?');
    this.deleteOverflow=this.db.prepare('DELETE FROM events WHERE seq <= COALESCE((SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?),-1)');
    this.readKinds=this.db.prepare(`SELECT kind,COUNT(*) AS count,SUM(raw_bytes) AS rawBytes,
      SUM(rendered_bytes) AS renderedBytes,AVG(duration_ms) AS meanDurationMs
      FROM events WHERE project_key=? GROUP BY kind`);
    this.readUsage=this.db.prepare(`SELECT COUNT(*) AS messages,
      COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
      COALESCE(SUM(CASE WHEN provider_billed=1 THEN cost_usd ELSE 0 END),0) AS providerBilledUsd,
      COALESCE(SUM(CASE WHEN provider_billed=0 THEN cost_usd ELSE 0 END),0) AS catalogEstimatedUsd
      FROM events WHERE project_key=? AND kind='model_usage'`);
    this.readEvents=this.db.prepare(`SELECT seq,kind,action,outcome,raw_bytes AS rawBytes,
      rendered_bytes AS renderedBytes,duration_ms AS durationMs,
      input_tokens AS inputTokens,output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens,cache_write_tokens AS cacheWriteTokens,
      cost_usd AS costUsd,provider_billed AS providerBilled,at_ms AS atMs
      FROM events WHERE project_key=? ORDER BY seq DESC LIMIT ?`);
    this.closed=false;this.prune();
  }
  prune(){
    checkClosed(this);
    const cutoff=this.now()-this.retentionMs;
    this.deleteOld.run(cutoff);
    this.deleteOverflow.run(this.maxEvents);
  }
  record(project,kind,fields={}){
    checkClosed(this);
    const projectKey=scopeKey(project);
    const d=clean(kind,fields);
    const at=this.now();
    if(!Number.isSafeInteger(at)||at<0) throw new TypeError('clock must return positive epoch milliseconds');
    this.add.run(projectKey,kind,d.action,d.outcome,d.rawBytes,d.renderedBytes,d.durationMs,
      d.inputTokens,d.outputTokens,d.cacheReadTokens,d.cacheWriteTokens,d.costUsd,d.providerBilled?1:0,at);
    this.prune();
  }
  snapshot(project){
    checkClosed(this);this.prune();
    const key=scopeKey(project),byKind={};
    let totalEvents=0;
    for(const row of this.readKinds.all(key)){
      const count=Number(row.count),rawBytes=Number(row.rawBytes),renderedBytes=Number(row.renderedBytes);
      byKind[row.kind]={count,rawBytes,renderedBytes,savedBytes:Math.max(0,rawBytes-renderedBytes),meanDurationMs:row.meanDurationMs};
      totalEvents+=count;
    }
    const usage=this.readUsage.get(key);
    return {projectScoped:true,totalEvents,byKind,modelUsage:{
      messages:Number(usage.messages),inputTokens:Number(usage.inputTokens),outputTokens:Number(usage.outputTokens),
      cacheReadTokens:Number(usage.cacheReadTokens),cacheWriteTokens:Number(usage.cacheWriteTokens),
      providerBilledUsd:usage.providerBilledUsd,catalogEstimatedUsd:usage.catalogEstimatedUsd
    }};
  }
  events(project,{limit=10}={}){
    checkClosed(this);this.prune();
    const count=Math.min(Math.max(Number.isInteger(limit)?limit:10,1),50);
    return this.readEvents.all(scopeKey(project),count).map(e=>({...e,providerBilled:e.providerBilled===1}));
  }
  close(){if(!this.closed){this.closed=true;this.db.close();}}
}
