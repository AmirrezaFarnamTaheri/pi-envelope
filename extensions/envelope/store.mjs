/** Exact raw-output store with project-scoped SQLite FTS5 retrieval. Local only. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { splitIndexedChunks } from './output-fragments.mjs';

const ID = /^[0-9a-f]{64}$/;
const SEARCH_TERM = /[\p{L}\p{N}]+/gu;
const DEFAULT_MAX_CAPTURE = 2_000_000;
const BACKFILL_BATCH = 8;
const BACKFILL_SCAN = 64;
const CHUNK_FORMAT_VERSION = '2';
const MAX_SEARCH_CANDIDATES = 200;
const MAX_VERIFIED_OUTPUTS = 40;
const MAX_VERIFIED_BYTES = 8_000_000;
const PREVIEW_CHARS = 320;
const METADATA_SEARCH_CANDIDATES = 100;
const METADATA_SEARCH_VERIFY_BYTES = 8_000_000;

/** FTS is candidate discovery, not a trusted source for output text. */
function normalizedTerms(text) {
  return String(text).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().match(SEARCH_TERM) || [];
}
/** Convert normalized-codepoint indexes to source indexes without losing accents. */
function normalizedWithOffsets(text) {
  const original=Array.from(text), offsets=[];
  let flat='';
  for(let i=0;i<original.length;i++) {
    const folded=original[i].normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
    for(let j=0;j<folded.length;j++)offsets.push(i);
    flat+=folded;
  }
  return {flat,offsets,original};
}
function previewAt(text,words,padding=60) {
  const {flat,offsets,original}=normalizedWithOffsets(text);
  let first=Infinity;
  for(const word of words) {
    const at=flat.indexOf(word);
    if(at>=0 && at<first)first=at;
  }
  const position=Number.isFinite(first)?offsets[first]??0:0;
  const start=Math.max(0,position-padding),end=Math.min(original.length,start+PREVIEW_CHARS);
  return {preview:(start?'…':'')+original.slice(start,end).join('')+(end<original.length?'…':''),
    previewTruncated:start>0||end<original.length};
}
function verifiedSearchExcerpt(text, words) {return previewAt(text,words).preview;}

/** @param {string} query */
function matchExpression(query) {
  const words = normalizedTerms(query ?? '').slice(0, 8);
  return words.map((word) => `"${word.replaceAll('"', '""')}"`).join(' AND ');
}

/** Show the matching span, not a possibly irrelevant prefix; preserve Unicode. */
function chunkPreview(text,words){return previewAt(text,words,70);}

/** Refuse symlinks and any body whose bytes differ from its project-scoped ID.
 * Open with O_NOFOLLOW when supported to close the final-component symlink race. */
function verifiedBody(path, id, project, expectedBytes) {
  const handle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat=fstatSync(handle);
    if(!stat.isFile() || stat.size > DEFAULT_MAX_CAPTURE)throw new Error('invalid output object: not a bounded regular file');
    const text=readFileSync(handle,'utf8');
    const bytes=Buffer.byteLength(text);
    if(bytes!==stat.size || (expectedBytes!==undefined && expectedBytes!==bytes)){
      throw new Error('output integrity mismatch: object length changed');
    }
    const actual=createHash('sha256').update(project).update('\0').update(text).digest('hex');
    if(actual!==id)throw new Error('output integrity mismatch: object bytes changed');
    return text;
  } finally {closeSync(handle);}
}

/**
 * The body store is content-addressed; a SQLite index keeps searchable text,
 * tool metadata and project scopes. No model calls and no network operations.
 */
export class OutputStore {
  /** @param {string} home */
  constructor(home) {
    if (!home || typeof home !== 'string') throw new TypeError('store home path required');
    if (lstatSync(home, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('store home may not be a symlink');
    this.home = home;
    this.objects = join(home, 'objects');
    if (lstatSync(this.objects, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('store objects directory may not be a symlink');
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
    chmodSync(this.objects, 0o700);
    const dbPath = join(home, 'index.sqlite');
    const existingDb = lstatSync(dbPath, { throwIfNoEntry: false });
    if (existingDb && (!existingDb.isFile() || existingDb.isSymbolicLink())) throw new Error('store index database may not be a symlink');
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout=2500;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS outputs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        tool TEXT NOT NULL,
        command TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outputs_by_project_age ON outputs(project, created_at, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS outputs_fts USING fts5(
        id UNINDEXED, project UNINDEXED, tool UNINDEXED, command, text,
        tokenize='unicode61'
      );
    `);
    this.lookup = this.db.prepare('SELECT id, project, tool, command, bytes, created_at FROM outputs WHERE id = ?');
    this.insertMeta = this.db.prepare(
      'INSERT OR IGNORE INTO outputs (id, project, tool, command, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.touchMeta = this.db.prepare(
      'UPDATE outputs SET created_at = ?, tool = ?, command = ? WHERE id = ? AND project = ?'
    );
    this.insertSearch = this.db.prepare(
      'INSERT INTO outputs_fts (id, project, tool, command, text) VALUES (?, ?, ?, ?, ?)'
    );
    this.searchStmt = this.db.prepare(`
      SELECT o.id, o.project, o.tool, o.command, o.bytes, o.created_at
      FROM outputs_fts JOIN outputs o ON outputs_fts.id = o.id
      WHERE outputs_fts MATCH ? AND outputs_fts.project = ? AND o.project = ?
      ORDER BY bm25(outputs_fts), o.id LIMIT ?
    `);
    this.erasureAvailable=false;
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS output_erasure_tombstones (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, deleted_at TEXT NOT NULL
      )`);
      this.erasureLookup = this.db.prepare('SELECT 1 AS erased FROM output_erasure_tombstones WHERE id=? AND project=?');
      this.erasureInsert = this.db.prepare('INSERT OR REPLACE INTO output_erasure_tombstones (id,project,deleted_at) VALUES (?,?,?)');
      this.erasureClear = this.db.prepare('DELETE FROM output_erasure_tombstones WHERE id=? AND project=?');
      this.erasureAvailable=true;
    } catch {
      // Keep legacy exact recall usable. Historical recapture and deletion
      // must fail closed when durable erasure protection cannot be provided.
    }
    this.chunkAvailable=false;
    this.backfillCursor=new Map();
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS output_chunks_state (
        id TEXT PRIMARY KEY REFERENCES outputs(id) ON DELETE CASCADE,
        project TEXT NOT NULL,
        chunk_count INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS output_chunks_fts USING fts5(
        id UNINDEXED, project UNINDEXED, ordinal UNINDEXED,
        line_start UNINDEXED, line_end UNINDEXED, text,
        tokenize='unicode61'
      );
      CREATE TABLE IF NOT EXISTS output_chunk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      // Invalidate v1 windows that could split a token across the old overlap.
      const version=this.db.prepare("SELECT value FROM output_chunk_meta WHERE key='format'").get()?.value;
      if(version!==CHUNK_FORMAT_VERSION){
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec('DELETE FROM output_chunks_fts; DELETE FROM output_chunks_state;');
          this.db.prepare("INSERT OR REPLACE INTO output_chunk_meta (key,value) VALUES ('format',?)").run(CHUNK_FORMAT_VERSION);
          this.db.exec('COMMIT');
        }catch(e){this.db.exec('ROLLBACK');throw e;}
      }
    this.chunkState = this.db.prepare('SELECT chunk_count FROM output_chunks_state WHERE id = ?');
    this.chunkMark = this.db.prepare('INSERT INTO output_chunks_state (id, project, chunk_count) VALUES (?, ?, ?)');
    this.chunkInsert = this.db.prepare('INSERT INTO output_chunks_fts (id, project, ordinal, line_start, line_end, text) VALUES (?, ?, ?, ?, ?, ?)');
    this.chunkDelete = this.db.prepare('DELETE FROM output_chunks_fts WHERE id = ?');
    this.chunkStateDelete = this.db.prepare('DELETE FROM output_chunks_state WHERE id = ? AND project = ?');
    this.chunkCandidates = this.db.prepare(`
      SELECT output_chunks_fts.id AS id, output_chunks_fts.project AS project, ordinal, line_start AS lineStart, line_end AS lineEnd,
        text, o.bytes AS sourceBytes, bm25(output_chunks_fts) AS bm25score
      FROM output_chunks_fts JOIN outputs o ON o.id=output_chunks_fts.id
      WHERE output_chunks_fts MATCH ? AND output_chunks_fts.project = ? AND o.project = ?
      ORDER BY bm25score, id, ordinal LIMIT ?
    `);
    this.chunkPending = this.db.prepare(`
      SELECT o.id FROM outputs o LEFT JOIN output_chunks_state s ON s.id=o.id
      WHERE o.project=? AND s.id IS NULL AND o.id>? ORDER BY o.id LIMIT ?
    `);
    this.chunkCount = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN s.id IS NULL THEN 1 ELSE 0 END),0) AS pending,
        COALESCE(SUM(s.chunk_count),0) AS chunks
      FROM outputs o LEFT JOIN output_chunks_state s ON o.id=s.id
      WHERE o.project=?
    `);
      this.chunkAvailable=true;
    } catch(error) {
      // A failed *optional* chunk schema must never disable exact output recall.
      this.chunkError='chunk index unavailable';
    }
    this.statsStmt = this.db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(bytes), 0) AS capturedBytes FROM outputs');
    this.statsProjectStmt = this.db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(bytes), 0) AS capturedBytes FROM outputs WHERE project = ?');
    this.findOld = this.db.prepare('SELECT id FROM outputs WHERE project = ? AND created_at < ? ORDER BY created_at, id LIMIT ?');
    this.deleteMeta = this.db.prepare('DELETE FROM outputs WHERE id = ? AND project = ?');
    this.deleteIndex = this.db.prepare('DELETE FROM outputs_fts WHERE id = ? AND project = ?');
    this.closed = false;
  }

  isErased(id,project){
    if(!ID.test(id))throw new TypeError('invalid output identifier');
    if(this.closed)throw new Error('store is closed');
    if(!this.erasureAvailable)throw new Error('durable erasure protection unavailable');
    return Boolean(this.erasureLookup.get(id,project));
  }

  objectPath(id) {
    if (!ID.test(id)) throw new TypeError('invalid output identifier');
    return join(this.objects, `${id}.txt`);
  }

  /** @param {{text: string, tool?: string, command?: string, project?: string, maxCaptureBytes?: number}} data */
  save(data) {
    if (this.closed) throw new Error('store is closed');
    if (typeof data?.text !== 'string') throw new TypeError('text must be string');
    const project = String(data.project ?? 'unknown-project');
    const tool = String(data.tool ?? 'unknown-tool');
    const command = String(data.command ?? '');
    const bytes = Buffer.byteLength(data.text);
    if (bytes > (data.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE)) {
      throw new RangeError('raw output exceeds capture limit');
    }
    const id = createHash('sha256').update(project).update('\0').update(data.text).digest('hex');
    // Historical projections cannot resurrect a user-erased output. New
    // live tool results may legitimately create the same content again.
    if(data.historical && this.isErased(id,project))throw new Error('historical output was erased');
    const body = this.objectPath(id);
    if (!existsSync(body)) {
      const tmp = `${body}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, data.text, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, body);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    // A corrupted or replaced content-addressed object must never be indexed.
    verifiedBody(body,id,project,bytes);

    const createdAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(data.historical && this.isErased(id,project))throw new Error('historical output was erased');
      const existing = this.lookup.get(id);
      const inserted = this.insertMeta.run(id, project, tool, command, bytes, createdAt);
      if(!data.historical && this.erasureAvailable)this.erasureClear.run(id,project);
      if (inserted.changes) {
        this.insertSearch.run(id, project, tool, command, data.text);
      } else if (!data.historical) {
        const nextCommand = command || existing?.command || '';
        this.touchMeta.run(createdAt, tool, nextCommand, id, project);
        if (existing && (existing.command !== nextCommand || existing.tool !== tool)) {
          this.deleteIndex.run(id, project);
          this.insertSearch.run(id, project, tool, nextCommand, data.text);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Chunk indexing is additive. Never lose a recoverable raw capture if the
    // optional search index is full, corrupt, or temporarily unavailable.
    try {this.indexOutputChunks({id,project,text:data.text});}catch{/* Retry on search. */}
    return { id, bytes };
  }

  retrieve(id) {
    if (this.closed) throw new Error('store is closed');
    const filename = this.objectPath(id);
    const row = this.lookup.get(id);
    if (!row) return null;
    return {
      ...row,
      text: verifiedBody(filename,id,row.project,row.bytes)
    };
  }

  /** Search indexes only for candidate IDs; display snippets from verified raw objects.
   * Indexes can be stale, modified, or point to an erased object. Fail closed. */
  searchReport(query, options = {}) {
    if (this.closed) throw new Error('store is closed');
    const project = String(options.project ?? 'unknown-project');
    const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : 10, 1), 25);
    const expression = matchExpression(query);
    const blank={hits:[],coverage:{partial:false,integritySkipped:0,candidateLimited:false,verificationLimited:false}};
    if (!expression) return blank;
    const words=normalizedTerms(query).slice(0,8);
    if (!words.length) return blank;
    const maxCandidates=Math.min(METADATA_SEARCH_CANDIDATES,limit*8);
    const candidates=this.searchStmt.all(expression,project,project,maxCandidates);
    const hits=[];
    let integritySkipped=0,verifiedBytes=0,verificationLimited=false;
    for(const row of candidates){
      if(verifiedBytes+row.bytes>METADATA_SEARCH_VERIFY_BYTES){verificationLimited=true;continue;}
      verifiedBytes+=row.bytes;
      let original;
      try {original=this.retrieve(row.id);}catch{integritySkipped++;continue;}
      if(original?.project!==project){integritySkipped++;continue;}
      const sourceWords=new Set([
        ...normalizedTerms(original.text),
        ...normalizedTerms(original.command),
        ...normalizedTerms(original.tool)
      ]);
      if(!words.every(w=>sourceWords.has(w))){integritySkipped++;continue;}
      // Metadata-only matches are not body snippets. Do not leak command argv
      // (which may carry secrets), or display an unrelated source prefix.
      const bodyWords=new Set(normalizedTerms(original.text));
      const excerpt=words.every(w=>bodyWords.has(w))?
        verifiedSearchExcerpt(original.text,words):'[metadata match: command/tool]';
      hits.push({...row,excerpt});
      if(hits.length>=limit)break;
    }
    const candidateLimited=candidates.length===maxCandidates;
    return {hits,coverage:{partial:Boolean(integritySkipped||candidateLimited||verificationLimited),
      integritySkipped,candidateLimited,verificationLimited}};
  }

  /** Backwards-compatible hit array; use searchReport for bounded coverage. */
  search(query, options = {}) {
    return this.searchReport(query, options).hits;
  }

  /** Deletes metadata and FTS rows as one SQLite transaction. The object file is
   * removed afterwards; an interrupted process may leave an unindexed file. */
  deleteRecords(ids, project, { skipId = null } = {}) {
    if (this.closed) throw new Error('store is closed');
    if (typeof project !== 'string' || !project) throw new TypeError('project scope is required');
    if(!this.erasureAvailable)throw new Error('durable erasure protection unavailable');
    this.db.exec('BEGIN IMMEDIATE');
    const removed = [];
    try {
      for (const id of ids) {
        if (!ID.test(id)) throw new TypeError('invalid output identifier');
        if (skipId && id === skipId) continue;
        const row = this.lookup.get(id);
        if (!row || row.project !== project) continue;
        if(this.chunkAvailable){this.chunkDelete.run(id);this.chunkStateDelete.run(id, project);}
        this.erasureInsert.run(id,project,new Date().toISOString());
        this.deleteIndex.run(id, project);
        if (this.deleteMeta.run(id, project).changes) removed.push(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const id of removed) rmSync(this.objectPath(id), {force:true});
    return removed.length;
  }

  erase({id, project} = {}) {
    if (!ID.test(id)) throw new TypeError('invalid output identifier');
    return this.deleteRecords([id], project) > 0;
  }

  /** Bounded cleanup; caller must repeatedly invoke this while hasMore is true.
   * before is an explicit ISO 8601 UTC cutoff, not a search query. */
  prune({project, before, limit=100, skipId=null} = {}) {
    if (typeof project !== 'string' || !project) throw new TypeError('project scope is required');
    if (typeof before !== 'string' || !Number.isFinite(Date.parse(before)) || new Date(before).toISOString() !== before) {
      throw new TypeError('before must be a UTC ISO 8601 date');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be 1..100');
    if (this.closed) throw new Error('store is closed');
    const rows = this.findOld.all(project, before, limit+1);
    const deleted = this.deleteRecords(rows.slice(0,limit).map(row=>row.id), project, { skipId });
    return {deleted, hasMore:rows.length > limit};
  }

  /** Index one verified raw output, in one transaction, without duplicating rows. */
  indexOutputChunks({id,project,text}) {
    if(this.closed)throw new Error('store is closed');
    if(!this.chunkAvailable)return false;
    if(this.chunkState.get(id))return false;
    const chunks=splitIndexedChunks(text);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(this.chunkState.get(id)) {this.db.exec('COMMIT');return false;}
      for(let ordinal=0;ordinal<chunks.length;ordinal++){
        const part=chunks[ordinal];
        this.chunkInsert.run(id,project,ordinal,part.lineStart,part.lineEnd,part.text);
      }
      this.chunkMark.run(id,project,chunks.length);
      this.db.exec('COMMIT');
      return true;
    }catch(err){this.db.exec('ROLLBACK');throw err;}
  }

  /** Only existing, integrity-checked output objects can be lazily migrated. */
  backfillOutputChunks(project){
    if(!this.chunkAvailable)return {indexed:0,integritySkipped:0};
    let indexed=0,integritySkipped=0,attempts=0;
    let cursor=this.backfillCursor.get(project)||'';
    let wrapped=false;
    while(indexed<BACKFILL_BATCH && attempts<BACKFILL_SCAN){
      const pending=this.chunkPending.all(project,cursor,Math.min(BACKFILL_BATCH,BACKFILL_SCAN-attempts));
      if(!pending.length){
        if(wrapped)break;
        cursor='';wrapped=true;
        continue;
      }
      for(const {id} of pending){
        cursor=id;attempts++;
        try {
          const row=this.retrieve(id);
          if(row?.project===project && this.indexOutputChunks({id,project,text:row.text}))indexed++;
          else integritySkipped++;
        }catch{integritySkipped++;}
        if(indexed>=BACKFILL_BATCH||attempts>=BACKFILL_SCAN)break;
      }
    }
    this.backfillCursor.set(project,cursor);
    return {indexed,integritySkipped};
  }

  /** Project-only counts; no command bodies, filenames, previews or raw text. */
  chunkIndexStatus(project){
    if(this.closed)throw new Error('store is closed');
    if(typeof project!=='string'||!project)throw new TypeError('project scope required');
    if(!this.chunkAvailable)return {indexed:0,pending:0,chunks:0,partial:true,indexUnavailable:true};
    const {total,pending,chunks}=this.chunkCount.get(project);
    return {indexed:total-pending,pending,chunks,partial:pending>0};
  }

  /** Bounded FTS5/BM25 plus lexical reciprocal-rank fusion on verified chunks. */
  searchFragmentsReport(query,{project,limit=10}={}){
    if(this.closed)throw new Error('store is closed');
    if(typeof project!=='string'||!project)throw new TypeError('project scope required');
    if(!Number.isInteger(limit)||limit<1||limit>25)throw new RangeError('limit must be 1..25');
    const expression=matchExpression(query);
    if(!this.chunkAvailable)return {hits:[],index:this.chunkIndexStatus(project)};
    if(!expression)return {hits:[],index:this.chunkIndexStatus(project)};
    const backfill=this.backfillOutputChunks(project);
    const rows=this.chunkCandidates.all(expression,project,project,MAX_SEARCH_CANDIDATES);
    const verified=new Map(),candidates=[];
    let verifiedBytes=0,verificationLimited=false,integritySkipped=backfill.integritySkipped;
    const words=normalizedTerms(query).slice(0,8);
    for(const row of rows){
      if(!verified.has(row.id)){
        if(verified.size>=MAX_VERIFIED_OUTPUTS || verifiedBytes+row.sourceBytes>MAX_VERIFIED_BYTES){
          verificationLimited=true;
          continue;
        }
        verifiedBytes+=row.sourceBytes; // Charge before I/O even on verification failures.
        try {
          const output=this.retrieve(row.id);
          if(output?.project===project){
            verified.set(row.id,{output,chunks:splitIndexedChunks(output.text)});
          }else{verified.set(row.id,null);integritySkipped++;}
        }catch{verified.set(row.id,null);integritySkipped++;}
      }
      const match=verified.get(row.id);
      const expected=match?.chunks[Number(row.ordinal)];
      if(!expected || expected.text!==row.text || expected.lineStart!==Number(row.lineStart)
        || expected.lineEnd!==Number(row.lineEnd)){if(match)integritySkipped++;continue;}
      const lower=expected.text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
      const lexical=words.reduce((score,word)=>score+lower.split(word).length-1,0);
      candidates.push({...row,tool:match.output.tool,lexical});
    }
    const byLexical=[...candidates].sort((a,b)=>b.lexical-a.lexical || a.bm25score-b.bm25score || a.id.localeCompare(b.id) || Number(a.ordinal)-Number(b.ordinal));
    const lexRank=new Map(byLexical.map((part,i)=>[`${part.id}:${part.ordinal}`,i+1]));
    const fused=candidates.map((part,i)=>({...part,rank:1/(60+i+1)+1/(60+lexRank.get(`${part.id}:${part.ordinal}`))}));
    fused.sort((a,b)=>b.rank-a.rank || a.bm25score-b.bm25score || a.id.localeCompare(b.id) || Number(a.ordinal)-Number(b.ordinal));
    const perOutput=new Map(),hits=[];
    const candidateLimited=rows.length===MAX_SEARCH_CANDIDATES;
    for(const row of fused){
      if((perOutput.get(row.id)||0)>=2)continue;
      perOutput.set(row.id,(perOutput.get(row.id)||0)+1);
      hits.push({id:row.id,tool:row.tool,lineStart:Number(row.lineStart),lineEnd:Number(row.lineEnd),
        ...chunkPreview(row.text,words)});
      if(hits.length>=limit)break;
    }
    const index=this.chunkIndexStatus(project);
    return {hits,index:{...index,candidateLimited,verificationLimited,integritySkipped,
      partial:index.partial||candidateLimited||verificationLimited||integritySkipped>0}};
  }

  /** Preserve the original public return shape for existing Pi callers. */
  searchFragments(query,options={}){
    return this.searchFragmentsReport(query,options).hits;
  }

  stats(options = {}) {
    if (this.closed) throw new Error('store is closed');
    return options.project === undefined ? this.statsStmt.get() : this.statsProjectStmt.get(String(options.project));
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
