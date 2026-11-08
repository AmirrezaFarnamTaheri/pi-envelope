/**
 * Native, durable coordination layer inspired by GSD's verified task lifecycle
 * and OpenRig's atomic, project-scoped queue. This is not either product's daemon.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const IDENTIFIER=/^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA40=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256=/^[a-f0-9]{64}$/;
const OUTCOMES=new Set(['review','failed']);
const REVIEW_OUTCOMES=new Set(['completed','failed']);
const STATUSES=['pending','running','review','completed','failed','interrupted'];

function bounded(value,field,max,{trim=true}={}) {
  if (typeof value!=='string') throw new TypeError(`${field} must be text`);
  const text=trim?value.trim():value;
  if(!text || text.length>max) throw new TypeError(`${field} must contain 1-${max} characters`);
  return text;
}
function projectKey(project) {
  const value=bounded(project,'project',4096);
  const absolute=resolve(value);
  return existsSync(absolute)?realpathSync(absolute):absolute;
}
function workflowKey(id) {
  if(typeof id!=='string'||!UUID.test(id)) throw new TypeError('workflow identifier must be a UUID');
  return id;
}
function taskKey(id) {
  if(typeof id!=='string'||!IDENTIFIER.test(id)) throw new TypeError('task id must be 1-48 ASCII letters, numbers, underscore or dash, starting with a letter');
  return id;
}
function validatePlan(plan) {
  const name=bounded(plan?.name,'workflow name',120);
  if(!Array.isArray(plan?.tasks)||plan.tasks.length<1||plan.tasks.length>40) throw new TypeError('workflow must have 1-40 tasks');
  const tasks=plan.tasks.map((task,i)=>{
    const id=taskKey(task?.id);
    const title=bounded(task?.title,'task title',160);
    const instructions=bounded(task?.instructions,'task instructions',12_000);
    const dependsOn=task.dependsOn===undefined?[]:task.dependsOn;
    if(!Array.isArray(dependsOn)||dependsOn.length>40) throw new TypeError(`invalid dependencies for ${id}`);
    const deps=dependsOn.map(taskKey);
    if(new Set(deps).size!==deps.length) throw new Error(`duplicate dependencies for ${id}`);
    return {id,title,instructions,dependsOn:deps,order:i};
  });
  const map=new Map();
  for(const task of tasks){
    if(map.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    map.set(task.id,task);
  }
  const visited=new Set(),active=new Set();
  const visit=(id)=>{
    if(active.has(id)) throw new Error(`dependency cycle detected at ${id}`);
    if(visited.has(id)) return;
    if(!map.has(id)) throw new Error(`unknown dependency: ${id}`);
    active.add(id);
    for(const dependency of map.get(id).dependsOn) visit(dependency);
    active.delete(id);visited.add(id);
  };
  for(const task of tasks) visit(task.id);
  return {name,tasks};
}
function taskFromRow(row){
  return {
    id:row.task_id,title:row.title,instructions:row.instructions,
    dependsOn:JSON.parse(row.dependencies),status:row.status,
    owner:row.owner,attempts:row.attempts,leaseUntil:row.lease_until,
    summary:row.summary,updatedAt:row.updated_at
  };
}

export class WorkflowLedger {
  constructor(home,{now=Date.now}={}) {
    this.now=now;
    mkdirSync(home,{recursive:true,mode:0o700});
    chmodSync(home,0o700);
    const filename=join(home,'workflow.sqlite');
    this.db=new DatabaseSync(filename);
    chmodSync(filename,0o600);
    this.db.exec(`
      PRAGMA busy_timeout=2000;
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workflows (
        project TEXT NOT NULL, workflow_id TEXT NOT NULL, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(project,workflow_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        project TEXT NOT NULL, workflow_id TEXT NOT NULL, task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
        dependencies TEXT NOT NULL, status TEXT NOT NULL,
        owner TEXT, token TEXT, lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, summary TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project,workflow_id,task_id),
        FOREIGN KEY(project,workflow_id) REFERENCES workflows(project,workflow_id)
      );
      CREATE INDEX IF NOT EXISTS tasks_project_status ON tasks(project,status,lease_until);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL, workflow_id TEXT NOT NULL, task_id TEXT,
        type TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY(project,workflow_id) REFERENCES workflows(project,workflow_id)
      );
      CREATE INDEX IF NOT EXISTS events_workflow ON events(project,workflow_id,sequence);
      CREATE TABLE IF NOT EXISTS handoffs (
        project TEXT NOT NULL, workflow_id TEXT NOT NULL, task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, workspace TEXT NOT NULL, base_head TEXT NOT NULL,
        head TEXT NOT NULL, fingerprint TEXT NOT NULL, tracked_diff_hash TEXT NOT NULL,
        changed_files TEXT NOT NULL, untracked_hashes TEXT NOT NULL,
        output_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
        PRIMARY KEY(project,workflow_id,task_id,attempt),
        FOREIGN KEY(project,workflow_id,task_id) REFERENCES tasks(project,workflow_id,task_id)
      );
      CREATE INDEX IF NOT EXISTS handoffs_task ON handoffs(project,workflow_id,task_id,attempt);
    `);
    this.closed=false;
  }
  transaction(fn){
    if(this.closed) throw new Error('workflow ledger closed');
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}
    catch(err){this.db.exec('ROLLBACK');throw err;}
  }
  event(project,id,task,type,actor,detail=''){
    this.db.prepare('INSERT INTO events(project,workflow_id,task_id,type,actor,detail,timestamp) VALUES(?,?,?,?,?,?,?)')
      .run(project,id,task,type,actor,String(detail).slice(0,400),this.now());
  }
  workflow(project,id){
    return this.db.prepare('SELECT * FROM workflows WHERE project=? AND workflow_id=?').get(project,id);
  }
  mustWorkflow(project,id){
    const row=this.workflow(project,id);
    if(!row) throw new Error('unknown workflow in current project');
    return row;
  }
  task(project,id,taskId){
    const row=this.db.prepare('SELECT * FROM tasks WHERE project=? AND workflow_id=? AND task_id=?').get(project,id,taskId);
    if(!row) throw new Error('unknown task in current workflow');
    return row;
  }
  rows(project,id){
    return this.db.prepare('SELECT * FROM tasks WHERE project=? AND workflow_id=? ORDER BY ordinal ASC').all(project,id);
  }
  create(project,plan){
    const key=projectKey(project),verified=validatePlan(plan),id=randomUUID(),at=this.now();
    return this.transaction(()=>{
      this.db.prepare('INSERT INTO workflows VALUES(?,?,?,?)').run(key,id,verified.name,at);
      const stmt=this.db.prepare(`INSERT INTO tasks
        (project,workflow_id,task_id,ordinal,title,instructions,dependencies,status,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?)`);
      for(const task of verified.tasks){
        stmt.run(key,id,task.id,task.order,task.title,task.instructions,JSON.stringify(task.dependsOn),at);
      }
      this.event(key,id,null,'created','operator',`${verified.tasks.length} tasks`);
      return {workflowId:id,name:verified.name,tasks:verified.tasks.length};
    });
  }
  status(project,workflowId){
    const key=projectKey(project);
    let id;
    if(workflowId===undefined||workflowId===null||workflowId==='') {
      id=this.db.prepare('SELECT workflow_id FROM workflows WHERE project=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(key)?.workflow_id;
    } else id=workflowKey(workflowId);
    if(!id||!this.workflow(key,id)) return {workflow:null,tasks:[],ready:[],counts:{}};
    const rows=this.rows(key,id),completed=new Set(rows.filter(t=>t.status==='completed').map(t=>t.task_id));
    const ready=rows.filter(t=>t.status==='pending'&&JSON.parse(t.dependencies).every(dep=>completed.has(dep))).map(t=>t.task_id);
    const counts=Object.fromEntries(STATUSES.map(s=>[s,rows.filter(t=>t.status===s).length]));
    return {workflow:{id,name:this.workflow(key,id).name},tasks:rows.map(taskFromRow),ready,counts};
  }
  interruptExpired(project){
    const stale=this.db.prepare("SELECT workflow_id,task_id FROM tasks WHERE project=? AND status='running' AND lease_until<=?").all(project,this.now());
    for(const task of stale){
      this.db.prepare("UPDATE tasks SET status='interrupted',owner=NULL,token=NULL,lease_until=NULL,updated_at=? WHERE project=? AND workflow_id=? AND task_id=?")
        .run(this.now(),project,task.workflow_id,task.task_id);
      this.event(project,task.workflow_id,task.task_id,'interrupted','system','worker lease expired; manual retry required');
    }
  }
  claim(project,workflowId,{worker,leaseMs=20*60*1000}={}){
    const key=projectKey(project),id=workflowKey(workflowId);
    const owner=bounded(worker,'worker',128);
    if(!IDENTIFIER.test(owner)) throw new TypeError('worker id must be ASCII letters, numbers, underscore or dash, starting with a letter');
    if(!Number.isInteger(leaseMs)||leaseMs<60_000||leaseMs>3_600_000) throw new TypeError('leaseMs must be 60000-3600000 milliseconds');
    return this.transaction(()=>{
      this.mustWorkflow(key,id);
      this.interruptExpired(key);
      if(this.db.prepare("SELECT 1 AS busy FROM tasks WHERE project=? AND status='running' LIMIT 1").get(key)) return null;
      const rows=this.rows(key,id),done=new Set(rows.filter(t=>t.status==='completed').map(t=>t.task_id));
      const next=rows.find(t=>t.status==='pending'&&JSON.parse(t.dependencies).every(dep=>done.has(dep)));
      if(!next) return null;
      const token=randomUUID(),leaseUntil=this.now()+leaseMs;
      this.db.prepare("UPDATE tasks SET status='running',owner=?,token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE project=? AND workflow_id=? AND task_id=?")
        .run(owner,token,leaseUntil,this.now(),key,id,next.task_id);
      this.event(key,id,next.task_id,'claimed',owner,`lease until ${leaseUntil}`);
      return {...taskFromRow({...next,status:'running',owner,lease_until:leaseUntil,attempts:next.attempts+1}),token};
    });
  }
  finish(project,workflowId,taskId,{token,outcome,summary}={}){
    const key=projectKey(project),id=workflowKey(workflowId),task=taskKey(taskId);
    if(!OUTCOMES.has(outcome)) throw new TypeError('outcome must be review or failed');
    const detail=bounded(summary,'summary',6000);
    if(typeof token!=='string'||!UUID.test(token)) throw new TypeError('invalid claim token');
    return this.transaction(()=>{
      this.mustWorkflow(key,id);
      this.interruptExpired(key);
      const row=this.task(key,id,task);
      if(row.status!=='running') throw new Error('task is not running');
      if(row.token!==token) throw new Error('claim token is not the current holder');
      this.db.prepare('UPDATE tasks SET status=?,owner=NULL,token=NULL,lease_until=NULL,summary=?,updated_at=? WHERE project=? AND workflow_id=? AND task_id=?')
        .run(outcome,detail,this.now(),key,id,task);
      this.event(key,id,task,outcome,row.owner,detail);
      return {id:task,status:outcome};
    });
  }
  /** Bind a content fingerprint to exactly one live worker attempt. Records are append-only. */
  recordHandoff(project,workflowId,taskId,{token,attempt,workspace,baseHead,head,fingerprint,trackedDiffHash,changedFiles,untrackedHashes,outputId}={}){
    const key=projectKey(project),id=workflowKey(workflowId),task=taskKey(taskId);
    if(typeof token!=='string'||!UUID.test(token)) throw new TypeError('invalid claim token');
    if(!Number.isSafeInteger(attempt)||attempt<1||attempt>1_000_000) throw new TypeError('invalid handoff attempt');
    if(typeof workspace!=='string'||!isAbsolute(workspace)||workspace.length>4096) throw new TypeError('invalid worktree workspace path');
    if(!SHA40.test(baseHead)||!SHA40.test(head)||baseHead!==head) throw new TypeError('handoff Git HEAD must match the pinned base');
    for(const [name,value] of Object.entries({fingerprint,trackedDiffHash,outputId})){
      if(typeof value!=='string'||!SHA256.test(value)) throw new TypeError(`invalid handoff ${name}`);
    }
    const safeName=name=>typeof name==='string'&&name.length>0&&name.length<=4096&&!name.startsWith('/')&&!name.includes('\0')&&name.split(/[\\/]/).every(part=>part!=='..');
    if(!Array.isArray(changedFiles)||changedFiles.length>500||!changedFiles.every(safeName)||new Set(changedFiles).size!==changedFiles.length) throw new TypeError('invalid handoff changed files');
    if(!untrackedHashes||typeof untrackedHashes!=='object'||Array.isArray(untrackedHashes)||Object.keys(untrackedHashes).length>100) throw new TypeError('invalid handoff untracked hashes');
    if(Object.entries(untrackedHashes).some(([name,value])=>!safeName(name)||typeof value!=='string'||!SHA256.test(value))) throw new TypeError('invalid handoff untracked hash');
    return this.transaction(()=>{
      this.mustWorkflow(key,id);
      this.interruptExpired(key);
      const row=this.task(key,id,task);
      if(row.status!=='running') throw new Error('task is not running');
      if(row.token!==token) throw new Error('claim token is not the current holder');
      if(row.attempts!==attempt) throw new Error('handoff attempt does not match claimed task');
      if(this.db.prepare('SELECT 1 AS found FROM handoffs WHERE project=? AND workflow_id=? AND task_id=? AND attempt=?').get(key,id,task,attempt)) throw new Error('handoff already recorded for this attempt');
      this.db.prepare(`INSERT INTO handoffs(project,workflow_id,task_id,attempt,workspace,base_head,head,fingerprint,tracked_diff_hash,changed_files,untracked_hashes,output_id,timestamp)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(key,id,task,attempt,workspace,baseHead,head,fingerprint,trackedDiffHash,JSON.stringify(changedFiles),JSON.stringify(untrackedHashes),outputId,this.now());
      this.event(key,id,task,'handoff',row.owner,`attempt ${attempt}; sha256=${fingerprint}`);
      return this.handoff(key,id,task);
    });
  }
  handoff(project,workflowId,taskId){
    const key=projectKey(project),id=workflowKey(workflowId),task=taskKey(taskId);
    const row=this.db.prepare('SELECT * FROM handoffs WHERE project=? AND workflow_id=? AND task_id=? ORDER BY attempt DESC LIMIT 1').get(key,id,task);
    if(!row) return null;
    return {attempt:row.attempt,workspace:row.workspace,baseHead:row.base_head,head:row.head,
      fingerprint:row.fingerprint,trackedDiffHash:row.tracked_diff_hash,
      changedFiles:JSON.parse(row.changed_files),untrackedHashes:JSON.parse(row.untracked_hashes),
      outputId:row.output_id,timestamp:row.timestamp};
  }
  review(project,workflowId,taskId,{outcome,evidence}={}){
    const key=projectKey(project),id=workflowKey(workflowId),task=taskKey(taskId);
    if(!REVIEW_OUTCOMES.has(outcome)) throw new TypeError('review outcome must be completed or failed');
    const detail=bounded(evidence,'review evidence',6000);
    return this.transaction(()=>{
      this.mustWorkflow(key,id);
      const row=this.task(key,id,task);
      if(row.status!=='review') throw new Error('task must be awaiting review');
      this.db.prepare('UPDATE tasks SET status=?,summary=?,updated_at=? WHERE project=? AND workflow_id=? AND task_id=?')
        .run(outcome,detail,this.now(),key,id,task);
      this.event(key,id,task,'review','reviewer',`${outcome}: ${detail}`);
      return {id:task,status:outcome};
    });
  }
  retry(project,workflowId,taskId){
    const key=projectKey(project),id=workflowKey(workflowId),task=taskKey(taskId);
    return this.transaction(()=>{
      this.mustWorkflow(key,id);
      const row=this.task(key,id,task);
      if(row.status!=='failed'&&row.status!=='interrupted') throw new Error('retry allowed only for failed or interrupted tasks');
      this.db.prepare("UPDATE tasks SET status='pending',owner=NULL,token=NULL,lease_until=NULL,updated_at=? WHERE project=? AND workflow_id=? AND task_id=?")
        .run(this.now(),key,id,task);
      this.event(key,id,task,'retry','operator',`after ${row.status}`);
      return {id:task,status:'pending'};
    });
  }
  events(project,workflowId,{limit=30}={}){
    const key=projectKey(project),id=workflowKey(workflowId);
    const n=Number.isInteger(limit)?Math.min(50,Math.max(1,limit)):30;
    return this.db.prepare('SELECT sequence,task_id AS taskId,type,actor,detail,timestamp FROM events WHERE project=? AND workflow_id=? ORDER BY sequence DESC LIMIT ?').all(key,id,n).reverse();
  }
  close(){if(!this.closed){this.closed=true;this.db.close();}}
}
