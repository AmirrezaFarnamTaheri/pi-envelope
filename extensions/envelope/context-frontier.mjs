/**
 * Versioned, crash-recoverable context block ledger. The Pi transcript remains
 * authoritative. This SQLite ledger stores only scope-bound scope/call hashes and
 * exact output IDs, never messages, previews, commands or filenames.
 *
 * A checkpoint is a parent; each archived tool result is a replayable child.
 * A committed batch is visible atomically. Uncommitted raw objects are inert.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const VERSION=1;
const ID=/^[a-f0-9]{64}$/;
const MAX_BATCH=128;
const MAX_CAPTURE_BYTES=2_000_000;

function identity(value,what,max=2048){
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new TypeError(`${what} must be a bounded nonempty string`);
  return value;
}
function digest(...pieces){
  const hash=createHash('sha256');
  for(const [index,piece] of pieces.entries()){
    if(index)hash.update('\0');
    hash.update(piece);
  }
  return hash.digest('hex');
}
/** Use the same exact output identity as OutputStore, without retaining its text. */
export function rawOutputId(project,text){
  identity(project,'project');
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX_CAPTURE_BYTES)throw new TypeError('raw output exceeds context capture limit');
  return digest(project,text);
}
/** Fingerprint the Pi tool name and arguments without persisting them. */
export function callFingerprint(toolName,command){
  return digest(identity(toolName,'tool name',128),String(command??''));
}

export class ContextFrontier {
  constructor(home){
    identity(home,'frontier home');
    if(lstatSync(home,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error('context frontier home may not be a symlink');
    mkdirSync(home,{recursive:true,mode:0o700});
    chmodSync(home,0o700);
    const path=join(home,'frontier.sqlite');
    const existing=lstatSync(path,{throwIfNoEntry:false});
    if(existing && (!existing.isFile()||existing.isSymbolicLink())){
      throw new Error('context frontier cannot open a symlink or nonfile database');
    }
    this.db=new DatabaseSync(path);
    this.closed=false;
    try{
      chmodSync(path,0o600);
      this.db.exec('PRAGMA busy_timeout=2500; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      // Serialize the version check with table creation across Pi processes.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const version=this.db.prepare('PRAGMA user_version').get().user_version;
        if(version!==0&&version!==VERSION)throw new Error(`unsupported context frontier schema version: ${version}`);
        if(version===0){
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS context_blocks (
              scope TEXT NOT NULL, anchor TEXT NOT NULL, call_key TEXT NOT NULL,
              output_id TEXT NOT NULL, command_hash TEXT NOT NULL,
              source_bytes INTEGER NOT NULL, rendered_bytes INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY(scope, anchor, call_key)
            );
            CREATE INDEX IF NOT EXISTS context_blocks_by_checkpoint ON context_blocks(scope,anchor,created_at,call_key);
            PRAGMA user_version=1;
          `);
        }
        this.db.exec('COMMIT');
      }catch(err){this.db.exec('ROLLBACK');throw err;}
      this.lookup=this.db.prepare('SELECT output_id,command_hash,source_bytes,rendered_bytes FROM context_blocks WHERE scope=? AND anchor=? AND call_key=?');
      this.insert=this.db.prepare('INSERT INTO context_blocks (scope,anchor,call_key,output_id,command_hash,source_bytes,rendered_bytes,created_at) VALUES (?,?,?,?,?,?,?,?)');
      this.listRows=this.db.prepare('SELECT call_key,output_id,source_bytes,rendered_bytes FROM context_blocks WHERE scope=? AND anchor=? ORDER BY created_at,call_key LIMIT ?');
      this.countRows=this.db.prepare('SELECT COUNT(*) AS total FROM context_blocks WHERE scope=? AND anchor=?');
    }catch(err){this.db.close();this.closed=true;throw err;}
  }

  keys({project,sessionId,anchorCallId}){
    if(this.closed)throw new Error('context frontier is closed');
    return [digest(identity(project,'project'),identity(sessionId,'session')),digest(identity(anchorCallId,'checkpoint call ID',256))];
  }

  /** Find an archived result by exact session, checkpoint, and tool-call identity. */
  lookupBlock({project,sessionId,anchorCallId,callId}){
    const [scope,anchor]=this.keys({project,sessionId,anchorCallId});
    identity(callId,'tool call ID',256);
    const row=this.lookup.get(scope,anchor,digest(callId));
    return row?{outputId:row.output_id,commandHash:row.command_hash,sourceBytes:row.source_bytes,renderedBytes:row.rendered_bytes}:null;
  }

  /** Record a bounded batch; no partial commit may authorize a preview. */
  recordBatch({project,sessionId,anchorCallId,blocks}){
    const [scope,anchor]=this.keys({project,sessionId,anchorCallId});
    if(!Array.isArray(blocks)||blocks.length>MAX_BATCH)throw new RangeError('context block batch exceeds 128 records');
    const prepared=blocks.map(block=>{
      identity(block.callId,'tool call ID',256);
      if(!ID.test(block.outputId)||!ID.test(block.commandHash))throw new TypeError('invalid context block fingerprints');
      if(!Number.isInteger(block.sourceBytes)||block.sourceBytes<1||block.sourceBytes>MAX_CAPTURE_BYTES
        ||!Number.isInteger(block.renderedBytes)||block.renderedBytes<1||block.renderedBytes>=block.sourceBytes){
        throw new TypeError('context block byte lengths are invalid');
      }
      return {callKey:digest(block.callId),...block};
    });
    if(prepared.length===0)return {inserted:0};
    const date=new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      let inserted=0;
      for(const block of prepared){
        const prior=this.lookup.get(scope,anchor,block.callKey);
        if(prior){
          if(prior.output_id!==block.outputId||prior.command_hash!==block.commandHash||prior.source_bytes!==block.sourceBytes){
            throw new Error('context block fingerprint conflict: historical tool call changed');
          }
          continue;
        }
        this.insert.run(scope,anchor,block.callKey,block.outputId,block.commandHash,
          block.sourceBytes,block.renderedBytes,date);
        inserted++;
      }
      this.db.exec('COMMIT');
      return {inserted};
    }catch(err){this.db.exec('ROLLBACK');throw err;}
  }

  /** List metadata only. The exact text is available through envelope_recall_output. */
  list({project,sessionId,anchorCallId,limit=25}){
    const [scope,anchor]=this.keys({project,sessionId,anchorCallId});
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new RangeError('context block list limit must be 1..50');
    const total=this.countRows.get(scope,anchor).total;
    const blocks=this.listRows.all(scope,anchor,limit).map(row=>({
      callKey:row.call_key,outputId:row.output_id,sourceBytes:row.source_bytes,renderedBytes:row.rendered_bytes
    }));
    return {version:VERSION,total,hasMore:total>blocks.length,blocks};
  }

  close(){if(!this.closed){this.closed=true;this.db.close();}}
}
