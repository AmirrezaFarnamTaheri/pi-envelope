# Native context coordinator

## Purpose and upstream practices

Pi Context inspired named checkpoints and a view of the current session timeline. Context Prune motivated explicit batching and prompt-cache-friendly activation. Billion Context motivated one `context` hook owner, a protected recent zone, and versioned atomic sidecars. Context Mode's local FTS5 storage and exact-output retrieval are reused from Phase 1. This is a native implementation of a bounded subset; it is **not** a full port of any upstream context engine.

## Hook ownership

`extensions/envelope/context-api.mjs` registers exactly one `context` event handler. All its source-of-truth state belongs to the same Envelope extension instance, not a separately installed context plugin. The handler receives Pi's copy of `event.messages`, checks the current session and project, and returns `{messages}` only when compaction succeeds. It does not use `context_with_system`, alter the system prompt, mutate user turns, remove assistant tool calls, or edit the Pi session log.

## Activation

`/envelope context on` persists a feature flag but does not transform history. Calling `envelope_context_checkpoint(name)` saves a versioned sidecar record keyed by the active Pi session ID and project path. Calling `envelope_context_prune(checkpoint)` chooses that checkpoint as a boundary. The corresponding tool-result anchor must exist on the current branch; otherwise the projection is a no-op. `/envelope context off` clears activation for the current session, while `envelope_context_restore` disables a projection without deleting checkpoints.

## Projection rules

Eligible messages are historical `toolResult` entries that precede the active checkpoint and lie outside the last 8 messages (configurable) and are not source reads, edit results, media or JSON. A matching preceding assistant tool call is required. Failures and nonzero exit-code results remain exact. Anchored output and previously compacted output are skipped to avoid corruption and double trimming. An eligible result is stored byte-exact through OutputStore before a preview and recall ID are inserted into Pi's outgoing model context. If storage or rendering fails, nothing is changed.

## Persistence

- `~/.tersio/settings.json`: `envelope.context.{enabled,minBytes,maxPreviewChars,recentMessages,minSavingsRatio}`
- `~/.tersio/envelope-context/sessions/<sha256(project + sessionId)>.json`: checkpoint records, active checkpoint and v1 schema; atomic owner-only files
- `~/.tersio/envelope-output/index.sqlite` and `objects/`: exact UTF-8 raw result bodies, locally indexed with SQLite FTS5

Checkpoint labels are strict identifiers and never become filesystem paths. Unknown sidecar schema versions fail closed, preserving the original file. State is session/project scoped, and branches lacking the named checkpoint receive no projection. The implementation uses no model calls, external services or network telemetry.

## Limits

The pruning currently offers deterministic head/tail previews rather than semantic model summaries. It does not implement Boomerang task execution, multi-generational hierarchical compression, Context Mode's sandboxed execution or Memex transcript indexing. Full Pi installation, provider-side cache behavior and native runtime test remain unverified without the pinned Tersio dependency and an actual Pi binary.
