/** Versioned, local settings. Independent of Tersio's existing mode state. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  output: Object.freeze({ enabled: true, minBytes: 1200, maxChars: 12000, minSavingsRatio: 0.2, retentionDays: 0 }),
  policy: Object.freeze({ enabled: false }),
  context: Object.freeze({ enabled: false, minBytes: 2400, maxPreviewChars: 650, recentMessages: 8, minSavingsRatio: 0.4 }),
  code: Object.freeze({ enabled: true, languagesEnabled: false, treeEnabled: false, guardEnabled: false, renameEnabled: false, lspCommand: null, lspTimeoutMs: 3500 }),
  workflow: Object.freeze({ enabled: true, runEnabled: false }),
  memory: Object.freeze({ enabled: false }),
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
  const memory = source.memory && typeof source.memory === 'object' ? source.memory : {};
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
      lspCommand: Array.isArray(code.lspCommand) && code.lspCommand.length>=1 && code.lspCommand.length<=16 && code.lspCommand.every(x=>typeof x==='string'&&x.length>=1&&x.length<=512&&!x.includes('\0')) ? [...code.lspCommand] : null,
      lspTimeoutMs: safeInteger(code.lspTimeoutMs, DEFAULT_CONFIG.code.lspTimeoutMs, 100, 10000)
    },
    workflow: { enabled: safeBoolean(workflow.enabled, DEFAULT_CONFIG.workflow.enabled), runEnabled: safeBoolean(workflow.runEnabled, DEFAULT_CONFIG.workflow.runEnabled) },
    memory: { enabled: safeBoolean(memory.enabled, DEFAULT_CONFIG.memory.enabled) },
    observability: { enabled: safeBoolean(observability.enabled, DEFAULT_CONFIG.observability.enabled), retentionDays: safeInteger(observability.retentionDays, DEFAULT_CONFIG.observability.retentionDays, 1, 365) }
  };
}

function readSettingsRoot(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export function readConfig(path) {
  const raw = readSettingsRoot(path);
  // Keep Envelope settings isolated from Tersio root keys.
  return normalizeConfig(raw.envelope);
}

export function saveConfig(path, config) {
  const normalized = normalizeConfig(config);
  const previous = readSettingsRoot(path);
  const combined = { ...previous, envelope: normalized };
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(combined, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  return normalized;
}
