/** Exact raw-output store with project-scoped SQLite FTS5 retrieval. Local only. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { rankFragments, splitOutputSections } from './output-fragments.mjs';

const ID = /^[0-9a-f]{64}$/;
const SEARCH_TERM = /[\p{L}\p{N}_]+/gu;
const DEFAULT_MAX_CAPTURE = 2_000_000;

/** @param {string} query */
function matchExpression(query) {
  const words = String(query ?? '').match(SEARCH_TERM)?.slice(0, 8) || [];
  return words.map((word) => `"${word.replaceAll('"', '""')}"`).join(' AND ');
}

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
    this.home = home;
    this.objects = join(home, 'objects');
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    const dbPath = join(home, 'index.sqlite');
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(`
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
    this.insertSearch = this.db.prepare(
      'INSERT INTO outputs_fts (id, project, tool, command, text) VALUES (?, ?, ?, ?, ?)'
    );
    this.searchStmt = this.db.prepare(`
      SELECT o.id, o.project, o.tool, o.command, o.bytes, o.created_at,
        snippet(outputs_fts, 4, '[', ']', '...', 12) AS excerpt
      FROM outputs_fts JOIN outputs o ON outputs_fts.id = o.id
      WHERE outputs_fts MATCH ? AND outputs_fts.project = ?
      ORDER BY bm25(outputs_fts) LIMIT ?
    `);
    this.statsStmt = this.db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(bytes), 0) AS capturedBytes FROM outputs');
    this.statsProjectStmt = this.db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(bytes), 0) AS capturedBytes FROM outputs WHERE project = ?');
    this.findOld = this.db.prepare('SELECT id FROM outputs WHERE project = ? AND created_at < ? ORDER BY created_at, id LIMIT ?');
    this.deleteMeta = this.db.prepare('DELETE FROM outputs WHERE id = ? AND project = ?');
    this.deleteIndex = this.db.prepare('DELETE FROM outputs_fts WHERE id = ? AND project = ?');
    this.closed = false;
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
      const inserted = this.insertMeta.run(id, project, tool, command, bytes, createdAt);
      if (inserted.changes) this.insertSearch.run(id, project, tool, command, data.text);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  search(query, options = {}) {
    if (this.closed) throw new Error('store is closed');
    const expression = matchExpression(query);
    if (!expression) return [];
    const project = String(options.project ?? 'unknown-project');
    const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : 10, 1), 25);
    return this.searchStmt.all(expression, project, limit);
  }

  /** Deletes metadata and FTS rows as one SQLite transaction. The object file is
   * removed afterwards; an interrupted process may leave an unindexed file. */
  deleteRecords(ids, project) {
    if (this.closed) throw new Error('store is closed');
    if (typeof project !== 'string' || !project) throw new TypeError('project scope is required');
    this.db.exec('BEGIN IMMEDIATE');
    const removed = [];
    try {
      for (const id of ids) {
        if (!ID.test(id)) throw new TypeError('invalid output identifier');
        const row = this.lookup.get(id);
        if (!row || row.project !== project) continue;
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
  prune({project, before, limit=100} = {}) {
    if (typeof project !== 'string' || !project) throw new TypeError('project scope is required');
    if (typeof before !== 'string' || !Number.isFinite(Date.parse(before)) || new Date(before).toISOString() !== before) {
      throw new TypeError('before must be a UTC ISO 8601 date');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be 1..100');
    if (this.closed) throw new Error('store is closed');
    const rows = this.findOld.all(project, before, limit+1);
    const deleted = this.deleteRecords(rows.slice(0,limit).map(row=>row.id),project);
    return {deleted, hasMore:rows.length > limit};
  }

  /** Return bounded, section-aware line snippets; raw bytes remain in exact recall. */
  searchFragments(query,{project,limit=10}={}) {
    if(this.closed)throw new Error('store is closed');
    if(typeof project!=='string'||!project)throw new TypeError('project scope required');
    if(!Number.isInteger(limit)||limit<1||limit>25)throw new RangeError('limit must be 1..25');
    const outputs=this.search(query,{project,limit:25});
    const fragments=[];
    for(const entry of outputs){
      const row=this.retrieve(entry.id);
      if(!row || row.project!==project)continue;
      for(const hit of rankFragments(splitOutputSections(row.text),query,{limit:2})){
        fragments.push({id:row.id,tool:row.tool,...hit});
        if(fragments.length>=limit)return fragments;
      }
    }
    return fragments;
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
