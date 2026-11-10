/** Versioned, local settings. Independent of Tersio's existing mode state. */
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, statSync, realpathSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  output: Object.freeze({ enabled: true, minBytes: 1200, maxChars: 12000, minSavingsRatio: 0.2, retentionDays: 0 }),
  policy: Object.freeze({ enabled: false }),
  context: Object.freeze({ enabled: false, minBytes: 2400, maxPreviewChars: 650, recentMessages: 8, minSavingsRatio: 0.4 }),
  code: Object.freeze({ enabled: true, languagesEnabled: false, treeEnabled: false, guardEnabled: false, renameEnabled: false, vectorEnabled: false, vectorExecutable: null, lspCommand: null, lspTimeoutMs: 3500 }),
  workflow: Object.freeze({ enabled: true, runEnabled: false }),
  jobs: Object.freeze({ enabled: false, agentEnabled: false }),
  memory: Object.freeze({ enabled: false }),
  graphify: Object.freeze({ enabled: false, executable: null, timeoutMs: 30000, orientationEnabled: false }),
  graphifyDotnet: Object.freeze({ enabled: false, executable: null, timeoutMs: 30000 }),
  observability: Object.freeze({ enabled: true, retentionDays: 30 })
});

function safeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}
function safeInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function safeRatio(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const output = source.output && typeof source.output === 'object' ? source.output : {};
  const policy = source.policy && typeof source.policy === 'object' ? source.policy : {};
  const context = source.context && typeof source.context === 'object' ? source.context : {};
  const code = source.code && typeof source.code === 'object' ? source.code : {};
  const workflow = source.workflow && typeof source.workflow === 'object' ? source.workflow : {};
  const jobs = source.jobs && typeof source.jobs === 'object' ? source.jobs : {};
  const memory = source.memory && typeof source.memory === 'object' ? source.memory : {};
  const graphify = source.graphify && typeof source.graphify === 'object' && !Array.isArray(source.graphify) ? source.graphify : {};
  const graphifyDotnet = source.graphifyDotnet && typeof source.graphifyDotnet === 'object' && !Array.isArray(source.graphifyDotnet) ? source.graphifyDotnet : {};
  const observability = source.observability && typeof source.observability === 'object' ? source.observability : {};
  return {
    version: 1,
    output: {
      enabled: safeBoolean(output.enabled, DEFAULT_CONFIG.output.enabled),
      minBytes: safeInteger(output.minBytes, DEFAULT_CONFIG.output.minBytes, 100, 1_000_000),
      maxChars: safeInteger(output.maxChars, DEFAULT_CONFIG.output.maxChars, 300, 2_000_000),
      minSavingsRatio: safeRatio(output.minSavingsRatio, DEFAULT_CONFIG.output.minSavingsRatio),
      retentionDays: safeInteger(output.retentionDays, DEFAULT_CONFIG.output.retentionDays, 0, 365)
    },
    policy: { enabled: safeBoolean(policy.enabled, DEFAULT_CONFIG.policy.enabled) },
    context: {
      enabled: safeBoolean(context.enabled, DEFAULT_CONFIG.context.enabled),
      minBytes: safeInteger(context.minBytes, DEFAULT_CONFIG.context.minBytes, 200, 1_000_000),
      maxPreviewChars: safeInteger(context.maxPreviewChars, DEFAULT_CONFIG.context.maxPreviewChars, 240, 2_000),
      recentMessages: safeInteger(context.recentMessages, DEFAULT_CONFIG.context.recentMessages, 0, 50),
      minSavingsRatio: safeRatio(context.minSavingsRatio, DEFAULT_CONFIG.context.minSavingsRatio)
    },
    code: {
      enabled: safeBoolean(code.enabled, DEFAULT_CONFIG.code.enabled),
      languagesEnabled: safeBoolean(code.languagesEnabled, DEFAULT_CONFIG.code.languagesEnabled),
      treeEnabled: safeBoolean(code.treeEnabled, DEFAULT_CONFIG.code.treeEnabled),
      guardEnabled: safeBoolean(code.guardEnabled, DEFAULT_CONFIG.code.guardEnabled),
      renameEnabled: safeBoolean(code.renameEnabled, DEFAULT_CONFIG.code.renameEnabled),
      vectorEnabled: safeBoolean(code.vectorEnabled, DEFAULT_CONFIG.code.vectorEnabled),
      vectorExecutable: typeof code.vectorExecutable === 'string' && code.vectorExecutable.length > 1 && code.vectorExecutable.length <= 1024 && isAbsolute(code.vectorExecutable) && !/[\u0000-\u001f\u007f]/.test(code.vectorExecutable) ? code.vectorExecutable : null,
      lspCommand: Array.isArray(code.lspCommand) && code.lspCommand.length>=1 && code.lspCommand.length<=16 && code.lspCommand.every(x=>typeof x==='string'&&x.length>=1&&x.length<=512&&!x.includes('\0')) ? [...code.lspCommand] : null,
      lspTimeoutMs: safeInteger(code.lspTimeoutMs, DEFAULT_CONFIG.code.lspTimeoutMs, 100, 10000)
    },
    workflow: { enabled: safeBoolean(workflow.enabled, DEFAULT_CONFIG.workflow.enabled), runEnabled: safeBoolean(workflow.runEnabled, DEFAULT_CONFIG.workflow.runEnabled) },
    jobs: { enabled: safeBoolean(jobs.enabled, DEFAULT_CONFIG.jobs.enabled), agentEnabled: safeBoolean(jobs.agentEnabled, DEFAULT_CONFIG.jobs.agentEnabled) },
    memory: { enabled: safeBoolean(memory.enabled, DEFAULT_CONFIG.memory.enabled) },
    graphify: {
      enabled: safeBoolean(graphify.enabled, DEFAULT_CONFIG.graphify.enabled),
      executable: typeof graphify.executable === 'string' && graphify.executable.length > 1 &&
        graphify.executable.length <= 1024 && isAbsolute(graphify.executable) &&
        !/[\u0000-\u001f\u007f]/.test(graphify.executable) ? graphify.executable : null,
      timeoutMs: safeInteger(graphify.timeoutMs, DEFAULT_CONFIG.graphify.timeoutMs, 50, 120000),
      orientationEnabled: safeBoolean(graphify.orientationEnabled, DEFAULT_CONFIG.graphify.orientationEnabled)
    },
    graphifyDotnet: {
      enabled: safeBoolean(graphifyDotnet.enabled, DEFAULT_CONFIG.graphifyDotnet.enabled),
      executable: typeof graphifyDotnet.executable === 'string' && graphifyDotnet.executable.length > 1 &&
        graphifyDotnet.executable.length <= 1024 && isAbsolute(graphifyDotnet.executable) &&
        !/[\u0000-\u001f\u007f]/.test(graphifyDotnet.executable) ? graphifyDotnet.executable : null,
      timeoutMs: safeInteger(graphifyDotnet.timeoutMs, DEFAULT_CONFIG.graphifyDotnet.timeoutMs, 50, 120000)
    },
    observability: { enabled: safeBoolean(observability.enabled, DEFAULT_CONFIG.observability.enabled), retentionDays: safeInteger(observability.retentionDays, DEFAULT_CONFIG.observability.retentionDays, 1, 365) }
  };
}

function readSettingsRoot(path, { strict = false } = {}) {
  let text, linked=false;
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return {};
    linked=stat.isSymbolicLink();
    const target=linked?statSync(path):stat;
    if (!target.isFile()) {
      if (strict||linked) throw new Error('settings path must resolve to a regular file');
      return {};
    }
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // A broken or unsafe link must not silently discard saved opt-in/opt-out
    // policy. Ordinary missing nonlinked files still use safe defaults.
    if (linked) throw new Error('settings symlink must resolve to an accessible regular file');
    if (strict && err?.code !== 'ENOENT') throw err;
    return {};
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (strict || linked) throw new Error('existing settings.json root must be a JSON object');
      return {};
    }
    return raw;
  } catch (err) {
    if (strict || linked) throw new Error(`refusing to overwrite malformed settings.json: ${err.message}`);
    return {};
  }
}

export function readConfig(path) {
  const raw = readSettingsRoot(path);
  // Keep Envelope settings isolated from Tersio root keys.
  return normalizeConfig(raw.envelope);
}

export function saveConfig(path, config) {
  const normalized = normalizeConfig(config);
  const previous = readSettingsRoot(path, { strict: true });
  const combined = { ...previous, envelope: normalized };
  // Write the resolved regular target of an explicitly configured symlink.
  // Renaming the symlink itself would silently break dotfile-manager setups.
  const linked=lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink()??false;
  const destination=linked?realpathSync(path):path;
  const folder = dirname(destination);
  if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('settings directory may not be a symlink');
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if(!linked)chmodSync(folder, 0o700);
  const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(combined, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, destination);
  } finally { rmSync(temp, { force: true }); }
  return normalized;
}
