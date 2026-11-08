/**
 * Session-scoped context checkpoint ledger (pi-context's named anchors,
 * billion-context's versioned/atomic sidecar contract). The file is a
 * projection control-plane, not a replacement for Pi's JSONL transcript.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = 1;
const CHECKPOINT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_CHECKPOINTS = 128;

function validIdentity(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw new TypeError(`${name} must be a nonempty string (max 2048 characters)`);
  }
  return value;
}

function validName(name) {
  if (typeof name !== 'string' || !CHECKPOINT_NAME.test(name) || name === 'root') {
    throw new TypeError('checkpoint name must be 1-64 characters: letters, numbers, dot, underscore or dash; not root');
  }
  return name;
}

function empty(project, sessionId) {
  return { version: VERSION, project, sessionId, active: null, checkpoints: [] };
}

export class ContextLedger {
  constructor(home) {
    this.home = validIdentity(home, 'ledger home');
    this.directory = join(home, 'sessions');
  }

  fileFor(project, sessionId) {
    validIdentity(project, 'project');
    validIdentity(sessionId, 'session');
    const digest = createHash('sha256').update(project).update('\0').update(sessionId).digest('hex');
    return join(this.directory, `${digest}.json`);
  }

  read(project, sessionId) {
    const path = this.fileFor(project, sessionId);
    if (!existsSync(path)) return empty(project, sessionId);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state?.version !== VERSION) throw new Error(`unsupported newer/unknown context ledger schema version: ${state?.version}`);
    if (state.project !== project || state.sessionId !== sessionId || !Array.isArray(state.checkpoints)
      || !(state.active === null || typeof state.active === 'string')) {
      throw new Error('invalid context ledger record');
    }
    return state;
  }

  write(state) {
    const file = this.fileFor(state.project, state.sessionId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  checkpoint(project, sessionId, { name, callId }) {
    validName(name);
    if (typeof callId !== 'string' || !callId.trim() || callId.length > 256) {
      throw new TypeError('call identifier must be nonempty and at most 256 characters');
    }
    const state = this.read(project, sessionId);
    if (state.checkpoints.some((c) => c.name === name)) throw new Error(`checkpoint already exists: ${name}`);
    if (state.checkpoints.length >= MAX_CHECKPOINTS) throw new RangeError('checkpoint limit reached (128 per session)');
    const entry = { name, callId, createdAt: new Date().toISOString() };
    this.write({ ...state, checkpoints: [...state.checkpoints, entry] });
    return entry;
  }

  activate(project, sessionId, name) {
    validName(name);
    const state = this.read(project, sessionId);
    const checkpoint = state.checkpoints.find((c) => c.name === name);
    if (!checkpoint) throw new Error(`unknown checkpoint: ${name}`);
    this.write({ ...state, active: name });
    return checkpoint;
  }

  restore(project, sessionId) {
    const state = this.read(project, sessionId);
    if (state.active !== null) this.write({ ...state, active: null });
    return { active: null };
  }

  timeline(project, sessionId) {
    const { active, checkpoints } = this.read(project, sessionId);
    return { version: VERSION, active, checkpoints };
  }
}
