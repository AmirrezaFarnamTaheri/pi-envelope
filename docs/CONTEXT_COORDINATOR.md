# Native context coordinator

## Scope and ownership

Envelope retains one Pi `context` hook, one non-destructive projection function, and the original Pi session transcript as the source of truth. `/envelope context on` enables the feature; `envelope_context_checkpoint(name)` anchors a point in the session; `envelope_context_prune(checkpoint)` activates reversible compaction before that anchor. Branches missing the checkpoint tool-result anchor are not projected. `/envelope context off` and `envelope_context_restore` deactivate compaction without rewriting Pi's transcript.

Context Prune motivates batching and a durable frontier; Pi Context motivates named anchors; Billion Context motivates replayable, versioned blocks and protected recent messages. This adaptation is **not** a full port of those upstream engines. It neither starts a new context hook nor makes LLM summarization calls.

## v0.14.0 replay blocks

`extensions/envelope/context-frontier.mjs` introduces a version 1 SQLite WAL ledger at `~/.tersio/envelope-context/frontier.sqlite` (owner-only directory and file permissions, synchronous FULL). Each checkpoint is the parent of zero or more replay blocks. A block stores **only** SHA-256 scope/checkpoint/tool-call keys, the content-addressed original-output ID, a command fingerprint, and measured byte counts. No user prompts, command bodies, model messages, filenames or output excerpts are in the frontier. The separate existing `envelope-output` store *does* retain exact raw outputs; those may contain secrets and follow the output retention policy.

A bounded batch (at most 128 newly archived results per model projection) is committed in one SQLite transaction **after** original output objects have been written and verified. On a crashed write before the block transaction commits, the original Pi transcript is available; any orphaned store object has no active replay block and may be deduplicated by content ID on the next request. When a committed block exists, projection rechecks its source bytes, tool name/command fingerprint, and verified output bytes and **does not save that output a second time**. Changed, corrupt, or erased originals are never silently resurrected: that message stays unmodified. An unavailable or unwriteable frontier disables projection rather than pretending pruning is armed.

`envelope_context_timeline` adds a bounded `replay` section for the active checkpoint (`version`, `total`, `hasMore`, at most 25 block IDs and byte counts). Exact text is still recovered through the project-scoped `envelope_recall_output id=...` tool. This is a **single-level checkpoint → output block** hierarchy. It does not offer model-generated summaries, multiple generations of ACP summaries, or arbitrary session-message reconstruction.

## Projection protections

Only sufficiently large, successful old `bash`/search tool-result text is eligible. Tool calls must precede their matching results and must have identical tool names. Old error diagnostics, anchored code/source lines, source reads, media, structured results and recent/user messages remain untouched. Only a copied model-context message is transformed; the session history remains verbatim. Projection handles restart and branch switching by requiring the checkpoint tool-result anchor in the current branch, while the replay metadata is scoped to the project, session, anchor and tool-call identity. Deletion can leave metadata referring to an erased object, but replay fails open and never re-captures it merely because context is requested again.

## Persistence, limits, and verification

- `~/.tersio/settings.json`: `envelope.context` activation and preview thresholds (off by default).
- `~/.tersio/envelope-context/sessions/<SHA-256>.json`: existing v1 checkpoint and active pointer, atomic file replacement.
- `~/.tersio/envelope-context/frontier.sqlite`: v1 per-checkpoint replay blocks; unsupported future DB schema versions fail closed and are not migrated implicitly.
- `~/.tersio/envelope-output/index.sqlite` and `objects/`: exact original bodies and project-scoped recall; stored text can contain secrets.

New tests cover restart without extra writes, atomic rollback, corrupt/missing/deleted replay objects, changed source, project/session/branch isolation, metadata size and privacy, version rejection, symlink refusal, and single-hook integration. The local tests prove file- and process-level behavior only. Real Pi/Tersio runtime compatibility is gated separately by hosted CI; production cache-hit or token-billing improvements have not been measured. This is not an OS sandbox.
