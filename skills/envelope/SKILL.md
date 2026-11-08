---
name: envelope
summary: Use the unified Envelope extension's exact-output search and recall after output compaction.
---

# Envelope: Efficient Evidence Retrieval

Envelope is a single package that embeds Tersio's native Pi modes and adds output storage and recovery. Prefer the smallest sufficient evidence for the coding task.

## When a tool result is compressed

A compacted result includes an `envelope_recall_output id=<64-hex-hash>` marker.

- Read the compact result first. If it has everything needed, do not retrieve the original merely because it exists.
- When an omitted detail matters, call `envelope_recall_output` with the exact ID. The returned text is the original output, not a reconstructed summary.
- If you know an error phrase but not the ID, prefer `envelope_search_fragments` for bounded, line-numbered excerpts; use `envelope_search_output` for candidate IDs and recall the exact original only when needed.
- Fragment search uses a local chunk index; after an upgrade it may index at most eight legacy captures per query. Check `details.chunkIndex.partial` and repeat as needed before treating a result as exhaustive. A `partial` result may also indicate a retrieval safety budget. It never runs embeddings or external searches.
- Both tools default to the current project. The original data never leaves the local machine by these tools.

## Behavioral rules

- Do not treat estimates of bytes saved as token-billing savings.
- Do not disable validation to reduce output. Never lose failing test names, meaningful errors, or source edit anchors.
- Do not stack independently installed RTK or context-pruning extensions alongside this package: overlapping hook owners can create duplicate changes.
- Use `/envelope status`, `/envelope stats`, `/envelope output off`, and `/envelope policy on` for the native feature toggles. Tersio commands are available only when its pinned dependency is installed and the host loads it successfully.

## Session context checkpoints (optional)

- Historical context pruning is **off by default**. Never assume it has been enabled. The human can enter `/envelope context on`.
- After a meaningful work batch, call `envelope_context_checkpoint` with a stable, descriptive name. Checkpointing alone does not prune anything.
- When the human has enabled the coordinator, `envelope_context_prune` can arm a checkpoint. It abbreviates only eligible *older* successful tool results on branches that contain the checkpoint.
- Re-read exact archived tool output by the given `envelope_recall_output` ID before making decisions that need the missing details.
- Use `envelope_context_timeline` for checkpoint orientation and `envelope_context_restore` to stop the projection. The original Pi session transcript is never overwritten by this feature.
- Manual checkpoint pruning favors stable provider prompt prefixes and is not the same thing as LLM summarization or native Pi compaction.

## Project-aware code tools (JS/TS; optional Python and Go)

- Use `envelope_code_overview` for a bounded AST-based repository map when orienting in unfamiliar code. Do not call it repeatedly on every turn.
- Use `envelope_code_graph` for source-grounded file relationships: `status`, `neighbors`, shortest `path`, inbound-degree `hubs`, weak `components`, advisory `boundaries`, or bounded JSON/Mermaid `export`. Choose `relation: "imports"|"calls"|"both"` and interpret `complete` / `reasons`: no path with incomplete evidence is not proof of absence. Never automatically run a Graphify CLI, import a provider, or execute external HTML.
- Use `envelope_code_external_graph` only for a user-supplied local `graphify-out/graph.json`. First call `status`, treat relationships as untrusted external assertions (never native AST proof), and reject stale artifacts unless the user explicitly acknowledges staleness. `watch` is explicit opt-in and does not rebuild or call models. The optional `graphify-out/envelope-sources.json` SHA-256 manifest is self-declared byte-consistency evidence, not cryptographic authorship proof.
- Use `envelope_code_lookup` for declarations and exact source locations, and targeted reads when the original source body matters.
- Before changing an imported module, `envelope_code_impact` can show known direct and transitive *static relative importers*. Never claim this is a runtime call graph, full test impact or type-aware relationship proof.
- Use `envelope_code_calls` to inspect bounded direct-call **syntactic evidence** and explicit unresolved candidates. Python module aliases (`import pkg.mod as x` / `from . import mod as x`) may link to uniquely indexed functions, but dynamic attribute chains, rebinding, MRO and type inference are not proved. Do not treat `complete:true` as full call-graph coverage, type accuracy or runtime verification. Inbound/outbound edges are project-scoped; optional Python/Go parsing still requires the language toggle.
- Use `envelope_code_verify` to check existing or proposed JS/TS source, or opt-in Python/Go syntax, without writing files. It does not replace typechecking, tests, LSP or runtime verification.
- Use `/envelope code languages on` to enable local Python/Go stdlib AST parsers and `envelope_code_languages` for status. They are not Tree-sitter, and the LSP rename transaction is strictly JS/TS-only. All code tools use one shared per-project index, can be disabled with `/envelope code off`, and do not rely on extra independently installed Pi code plugins.

## Optional syntax-tree queries and named captures

The human must explicitly enable `/envelope code tree on` before Tree-sitter query or capture tools work. The optional `web-tree-sitter` and grammar WASM npm packages must also be installed; **never claim real Tree-sitter parsing if the engine or grammar reports unavailable**. Use `envelope_code_tree_status` to inspect engine readiness, `envelope_code_tree_query` for a bounded S-expression (e.g. `(function_declaration name: (identifier) @name)`), and `envelope_code_tree_capture` for `functions`, `classes`, `imports`, `comments`, `calls` or `identifiers` (Go also has `types`). Only indexed source paths may be queried; Python/Go additionally require `/envelope code languages on`. These are syntax captures, not type-aware call edges. The existing JS/TS-only rename and mutation gate do not gain Python/Go write capabilities.

## Durable project workflows and bounded delegation

- Use `envelope_workflow_create` for tasks with explicit dependencies, then inspect `envelope_workflow_status`.
- `envelope_workflow_claim` reserves one ready task and returns a token; `envelope_workflow_finish` must submit the result for `review` or `failed` using that exact token.
- Never mark a task `completed` solely because a Pi child exited 0; use `envelope_workflow_review` only after inspecting actual diff and tests, providing explicit evidence. Dependencies unblock after review only.
- `envelope_workflow_run` spawns a potentially source-editing child Pi process and is disabled by default. It is available only after a user explicitly enables `/envelope workflow run on`. Do not enable it on the user's behalf.
- Once the user enables child execution, `envelope_workflow_run` defaults to a **detached worktree at the committed HEAD** and requires a clean Git root. The child can still access other filesystem paths because Git worktrees are **not sandboxes**. The obsolete `isolated:false` shared-tree mode is **rejected** before the task can be claimed. Never attempt to bypass detached-worktree isolation.
- Use `envelope_workflow_handoff` to retrieve the saved worktree path, changed file preview, SHA-256 fingerprint and exact child output ID. Review changes independently; the review tool rechecks content fingerprints to reject stale approvals. A successful child exit alone never proves task correctness.
- If a child fails or a lease expires, inspect the preserved worktree before using `envelope_workflow_retry`. No automatic retry, parallel writer, auto-commit, automatic merge, auto-cleanup or recursive subagent loop is permitted.
- `envelope_workflow_events` returns the bounded ownership/audit timeline; no always-on OpenRig daemon or full GSD autonomous scheduler is installed.

## Opt-in project memory, history and source cards

- Human must enable `/envelope memory on` before `envelope_memory` saves, reads or imports. Do not auto-save chat transcripts, secrets, or output captures. Only `importMarkdown` / `importClaudeTranscript` with a user-directed local project path may import text; manually inspect for sensitivity. Off means no new memory database.
- Use `envelope_code_context_card` for short, hash-verified AST evidence; raw source snippets require `includeSnippet:true`, not the default. A card cannot prove runtime dispatch or semantic correctness.
- Use `envelope_code_history` for Git co-change/churn within bounded commits. Historical co-change is **not** a static import/call edge, ownership proof or causal relationship. Check `complete` and `reasons`.

## Local telemetry and evaluation

`envelope_metrics_snapshot({})` and `envelope_metrics_events({"limit":10})` provide private project-scoped numeric metrics. Do not present byte reductions as provider-billed token savings. `/envelope observability off` disables new collection only; `/envelope metrics` reads current local totals. `npm run benchmark` provides a synthetic offline exact-recovery check, not real coding effectiveness.

## User-controlled retention and change evidence

- Raw output may contain secrets, and the default local capture policy has no expiry. `/envelope output retention <days>`, `/envelope output prune <days>` and `/envelope output erase <id>` are user-only operations; **the model must not claim deleted IDs are recoverable**. For status only, call `envelope_output_retention`.
- `envelope_code_change_impact` takes a pinned base Git commit SHA and requires a clean checkout at the exact head. Its changed-line/import/test candidates are evidence, **not verified PR-review findings or test coverage**.
- Never report full compatibility with the 33 original repositories: several are comparison-only, third-party apps or excluded grammars, and Pi/Tersio/Tree-sitter real runtimes must pass independent smokes before any such assertion.

- Use `envelope_code_retrieve` for hash-verified lexical AST symbol/file retrieval; raw snippets require explicit `includeSnippet:true`. Use `envelope_code_policy` for advisory static architecture rules, and the optional `scripts/architecture-gate.mjs` only when the user deliberately configures an architecture CI gate. No automatic provider calls or CI enforcement.

- Use `envelope_capabilities` for mode and optional executable presence with manual-only route suggestions; never treat detection as activation. Use native `envelope_code_graph export format:svg|obsidian` for static, safely escaped graph views. `envelope_code_external_graph action:communities` reports only external exporter-declared groups.

### Optional Graphify CLI bridge (v0.22 candidate)

Use `envelope_code_external_graph` for bounded structured graph assertions first. If the user has explicitly pinned and enabled the trusted Graphify executable via `/envelope graphify binary <absolute-path>` and `/envelope graphify on`, `envelope_graphify_cli` may answer `status`, `query`, `path`, and `explain`. The read tool cannot invoke build/update. Graph writes require either explicit human `/envelope graphify build|update` commands or a **separately authorized** `/envelope graphify watch on` session watcher. Both use code-only operations and `GRAPHIFY_BACKEND=none`; the agent tool cannot enable the watcher. Filesystem/CLI failures halt automatic refresh and require manual review and fresh consent. Never auto-install Graphify, invent CLI results, claim upstream semantic/full graph parity, or treat external assertions as native AST proof. Known-stale graph state requires acknowledgement. Optional `/envelope graphify orientation on` adds one bounded non-repeating hint within the existing prompt hook. See `docs/GRAPHIFY_CLI.md`.

### Opt-in Graphify code watcher

The user may enable `/envelope graphify watch on 1200` after pinning an external executable and building a graph. This is not an agent tool action. Watcher status is count-only. Code-like changes may run one debounced offline `graphify update . --no-cluster` at a time; doc/media, new directories and invalid paths require a manual rebuild, never an LLM. Failure stops automatic retries. A manual build/update first cancels and awaits an active watcher write, and concurrent graph writes are refused. Do not start a watcher just to answer a question. See `docs/GRAPHIFY_WATCH.md`.
