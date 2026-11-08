/**
 * The sole non-destructive context projection owner. Inspired by Pi Context's
 * checkpoints, Context Prune's cache-aware batching and Billion Context's
 * protected recent zone. This intentionally does NOT summarize with an LLM.
 * It replaces old successful tool results with an exact-recall pointer while
 * preserving tool-call pairing and the session transcript.
 */
import { isAnchorSensitive } from './compactor.mjs';

const SAFE_TOOL_NAMES = new Set(['bash', 'grep', 'glob', 'rg', 'find', 'fd', 'ls']);
const RECALL_MARKER = /\benvelope_recall_output\s+id=[a-f0-9]{64}\b/;

function outputCandidate(message, minBytes) {
  if (!message || message.role !== 'toolResult' || !SAFE_TOOL_NAMES.has(message.toolName)
    || message.isError !== false) return null;
  if (typeof message.details?.code === 'number' && message.details.code !== 0) return null;
  if (typeof message.details?.exitCode === 'number' && message.details.exitCode !== 0) return null;
  if (!Array.isArray(message.content) || message.content.length !== 1
    || message.content[0]?.type !== 'text' || typeof message.content[0].text !== 'string') return null;
  const text = message.content[0].text;
  if (Buffer.byteLength(text) < minBytes || isAnchorSensitive(text) || RECALL_MARKER.test(text)) return null;
  const start = text.trimStart();
  if (start.startsWith('{') || start.startsWith('[')) {
    try { if (typeof JSON.parse(text) === 'object') return null; } catch { /* a human log, not JSON */ }
  }
  return text;
}

/** Build a bounded plain-text preview; this is never used for source-edit anchors. */
function preview(text, id, limit) {
  const marker = `[envelope-context: archived ${Buffer.byteLength(text)} raw bytes; exact original: envelope_recall_output id=${id}]`;
  const spacer = '\n[... historical result omitted; retrieve original for full detail ...]\n';
  if (Buffer.byteLength(marker + spacer) + 64 > limit) return null;
  let budget = Math.floor((limit - Buffer.byteLength(marker + spacer)) / 2);
  for (let retries=0; retries<6; retries++) {
    const head = text.slice(0, Math.floor(budget * 1.1)).trimEnd();
    const tail = text.slice(-Math.floor(budget * 0.7)).trimStart();
    const rendered = `${marker}\n${head}${spacer}${tail}`;
    if (Buffer.byteLength(rendered) <= limit) return rendered;
    budget = Math.floor(budget * 0.7);
  }
  return marker;
}

const unchanged = (messages) => ({ changed:false, messages, compacted:0, rawBytes:0, renderedBytes:0 });

/**
 * @param {unknown[]} messages Pi's deep-copied context messages (not persisted history).
 * @param {{anchorCallId:string,project:string,store:object,minBytes?:number,maxPreviewChars?:number,recentMessages?:number,minSavingsRatio?:number}} options
 */
export function projectContext(messages, options) {
  if (!Array.isArray(messages) || !options?.store || !options.anchorCallId || !options.project) {
    return unchanged(messages);
  }
  const anchorIndex = messages.findIndex((m) => m?.role === 'toolResult' && m.toolCallId === options.anchorCallId);
  if (anchorIndex < 0) return unchanged(messages); // No cross-branch leakage.

  const minBytes = options.minBytes ?? 2400;
  const maxPreviewChars = options.maxPreviewChars ?? 650;
  const recentMessages = options.recentMessages ?? 8;
  const minSavingsRatio = options.minSavingsRatio ?? 0.4;
  const cut = Math.min(anchorIndex, Math.max(0, messages.length - recentMessages));
  if (cut <= 0) return unchanged(messages);

  const latestUser = messages.findLastIndex((m) => m?.role === 'user');
  let rendered = messages;
  let compacted = 0, rawBytes = 0, renderedBytes = 0;
  const calls = new Map();
  for (let i = 0; i < cut; i++) {
    const message = messages[i];
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'toolCall' && typeof part.id === 'string') calls.set(part.id, part);
      }
      continue;
    }
    if (i === latestUser || message?.role !== 'toolResult') continue;
    const original = outputCandidate(message, minBytes);
    const call = calls.get(message.toolCallId);
    if (!original || !call || call.name !== message.toolName) continue;
    // Check the bound before writing a raw artifact; huge outputs stay untouched.
    const originalBytes = Buffer.byteLength(original);
    if (originalBytes < maxPreviewChars * 1.5) continue;
    try {
      const { id } = options.store.save({ text:original, project:options.project, tool:message.toolName,
        command:typeof call.arguments?.command === 'string' ? call.arguments.command : '' });
      const result = preview(original, id, maxPreviewChars);
      if (!result || Buffer.byteLength(result) >= originalBytes * (1 - minSavingsRatio)) continue;
      if (rendered === messages) rendered = messages.slice();
      rendered[i] = { ...message, content:[{ ...message.content[0], text:result }] };
      compacted++;
      rawBytes += originalBytes;
      renderedBytes += Buffer.byteLength(result);
    } catch {
      // Source transcript and model context remain unmodified on storage failure.
    }
  }
  return { changed:compacted > 0, messages:rendered, compacted, rawBytes, renderedBytes };
}
