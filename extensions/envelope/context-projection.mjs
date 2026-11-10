/**
 * The sole non-destructive context projection owner. Inspired by Pi Context's
 * checkpoints, Context Prune's cache-aware batching and Billion Context's
 * protected recent zone. This intentionally does NOT summarize with an LLM.
 * It replaces old successful tool results with an exact-recall pointer while
 * preserving tool-call pairing and the session transcript.
 */
import { isAnchorSensitive } from './compactor.mjs';
import { rawOutputId, callFingerprint } from './context-frontier.mjs';

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
  if (Buffer.byteLength(marker) > limit) return null;
  const spacer = '\n[... historical result omitted; retrieve original for full detail ...]\n';
  if (Buffer.byteLength(marker + spacer) + 24 > limit) return marker;
  const points = Array.from(text);
  let budget = Math.floor((limit - Buffer.byteLength(marker + spacer)) / 2);
  for (let retries=0; retries<6; retries++) {
    const headCount = Math.min(points.length, Math.max(1, Math.floor(budget * 1.1)));
    const tailCount = Math.min(Math.max(0, points.length - headCount), Math.max(1, Math.floor(budget * 0.7)));
    const head = points.slice(0, headCount).join('').trimEnd();
    const tail = tailCount > 0 ? points.slice(points.length - tailCount).join('').trimStart() : '';
    const rendered = `${marker}\n${head}${spacer}${tail}`;
    if (Buffer.byteLength(rendered) <= limit) return rendered;
    budget = Math.floor(budget * 0.7);
  }
  return marker;
}

const unchanged = (messages) => ({ changed:false, messages, compacted:0, rawBytes:0, renderedBytes:0 });

/**
 * @param {unknown[]} messages Pi's deep-copied context messages (not persisted history).
 * @param {{anchorCallId:string,project:string,store:object,frontier?:object,sessionId?:string,minBytes?:number,maxPreviewChars?:number,recentMessages?:number,minSavingsRatio?:number}} options
 */
export function projectContext(messages, options) {
  if (!Array.isArray(messages) || !options?.store || !options.anchorCallId || !options.project) {
    return unchanged(messages);
  }
  if (options.frontier && !options.sessionId) return unchanged(messages);
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
  const visited = new Set();
  const newBlocks = [];
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
    // Keep every replay bound to a unique preceding tool call in this branch.
    if (visited.has(message.toolCallId)) continue;
    visited.add(message.toolCallId);
    const originalBytes = Buffer.byteLength(original);
    if (originalBytes < maxPreviewChars * 1.5) continue;
    try {
      const id = rawOutputId(options.project, original);
      const command = typeof call.arguments?.command === 'string' ? call.arguments.command : '';
      const commandHash = callFingerprint(message.toolName, command);
      const result = preview(original, id, maxPreviewChars);
      if (!result || Buffer.byteLength(result) >= originalBytes * (1 - minSavingsRatio)) continue;
      if (options.frontier) {
        const prior = options.frontier.lookupBlock({project:options.project,sessionId:options.sessionId,
          anchorCallId:options.anchorCallId,callId:message.toolCallId});
        if (prior) {
          // A deleted, corrupt, replaced or branch-conflicting raw result is NOT
          // silently rearchived. Show the untouched transcript for that result.
          if (prior.outputId !== id || prior.commandHash !== commandHash || prior.sourceBytes !== originalBytes) continue;
          const recalled = options.store.retrieve(id);
          if (!recalled || recalled.project !== options.project || recalled.text !== original) continue;
        } else {
          if (newBlocks.length >= 128) continue; // Bounded, cache-friendly batch per invocation without skipping prior archived blocks.
          if(options.store.isErased?.(id,options.project))continue;
          const saved = options.store.save({text:original,project:options.project,tool:message.toolName,command,historical:true});
          if (saved.id !== id) continue;
          newBlocks.push({callId:message.toolCallId,outputId:id,commandHash,
            sourceBytes:originalBytes,renderedBytes:Buffer.byteLength(result)});
        }
      } else {
        // Backwards compatible stateless API for isolated projection consumers.
        if(options.store.isErased?.(id,options.project))continue;
        options.store.save({text:original,project:options.project,tool:message.toolName,command,historical:true});
      }
      if (rendered === messages) rendered = messages.slice();
      rendered[i] = { ...message, content:[{ ...message.content[0], text:result }] };
      compacted++;
      rawBytes += originalBytes;
      renderedBytes += Buffer.byteLength(result);
    } catch {
      // Source transcript and model context remain unmodified on storage failure.
    }
  }
  if (newBlocks.length) {
    try {options.frontier.recordBatch({project:options.project,sessionId:options.sessionId,
      anchorCallId:options.anchorCallId,blocks:newBlocks});}
    catch {return {...unchanged(messages),storageFailure:"context replay frontier write failed"};} // Never publish unjournaled previews.
  }
  return { changed:compacted > 0, messages:rendered, compacted, rawBytes, renderedBytes };
}
