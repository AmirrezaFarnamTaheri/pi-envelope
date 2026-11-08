# Envelope — release status and verification gates

This document is the current, user-facing release assessment. It replaces the historic execution plans and avoids retaining obsolete command and package examples.

## v0.21.0 unmerged candidate: implemented locally

- Namespaced `pi-envelope` package, `envelope` command and `envelope_*` tools, `extensions/envelope` and `skills/envelope`. No `upper` command or extension is shipped.
- Default-safe bash output compactor with exact recall, byte checks, durable FTS5 chunk search and bounded lexical/BM25 reciprocal-rank fusion, and optional retention/erasure, all project scoped. Raw output can contain secrets and no filesystem erasure claim covers backups/snapshots.
- Manual checkpoints, reversible context projections and versioned, transactional replay blocks, conservative JS/TS/Python/Go code intelligence, optional Tree-sitter and LSP tools, preview-first rename.
- Fingerprint-reviewed detached Git worktree child runner (opt-in); `isolated:false` rejected; git worktrees are not OS sandboxes.
- Project-scoped numeric observability, offline benchmarks and commit-pinned static impact reports.

## Required before distributing as a bundled Pi release

1. On a machine with npm access, run `npm install --include=optional`. Inspect `npm ls` and licensing of the pinned Tersio and optional WASM packages.
2. Run `npm run doctor:bundle` and `npm run pack:check`; the latter now deliberately requires the doctor first.
3. Run `npm run smoke:runtime` against the actual installed Pi/Tersio package. Confirm Tersio command registration and native tools, with zero duplicated commands and hooks.
4. Run `npm run smoke:tree` with real WASM grammars, and `npm run smoke:lsp-real` with clangd or a configured trusted LSP.
5. Measure model coding outcomes and actual provider usage separately from synthetic byte reductions.

## Missing/partial extraction work

No full parity is claimed across the 33 source repositories. Among the unimplemented or partially implemented features: multi-generation ACP context hierarchies and model-generated summaries (the checkpoint-linked v1 replay ledger is not full ACP); mature call-resolution with Python MRO, cross-language types and ambiguity proofs; semantic embeddings; persistent multi-agent message relay; automatic task milestones and approval loop; full streaming RTK sanitizer; optional Memex/OpenRig adapters; and OS sandboxing for children. The decision for each upstream source is documented in `integrations/extraction-audit.json`.

**Do not conflate** a passing local regression suite, a source-only npm pack, or an injected mock parser with a successful live production installation.

## Context replay gate

The v0.14.0 candidate adds a hash-only, checkpoint-scoped SQLite frontier with atomic batch commits. An archived block is replayed only when source bytes, tool-call fingerprint and stored SHA-256 output agree. A missing or explicitly erased object is not recreated by context projection; the Pi transcript is shown instead. Failures to commit a batch leave outgoing context unchanged. See `docs/CONTEXT_COORDINATOR.md` and `tests/context-frontier.test.mjs`.

The original v0.17.0 graph candidate passed [hosted CI](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42481113031) with real Pi/Tersio/WASM/clangd gates; integrity corrections and consolidation require a new hosted run before merge.

## v0.15.0 chunk retrieval gate

The prior whole-document 25-output prefilter could miss the most relevant section. v0.15.0 adds persistent, bounded local chunk FTS5, verified exact-object search, lexical/BM25 reciprocal rank fusion and batch migration of legacy captures. The existing `envelope_search_fragments` text response remains an array; its Pi result details include index coverage and explicit partial status when a backfill or candidate limit is incomplete. The raw objects are still the source of truth. See `docs/CHUNK_RETRIEVAL.md` and `tests/output-chunk-index.test.mjs`. This is not embedding/vector retrieval or an execution sandbox.

## v0.16.0 Python call evidence gate

This candidate extends the existing optional Python stdlib `ast` call scanner and shared CodeIndex, without a new Pi hook or graph database. It links uniquely indexed module-alias member calls, tracks top-level assignment/rebinding and package initializer collisions, and fails closed on duplicate/ambiguous declaration and import candidates. The parser contract validates and caps new initializer binding metadata. Regression tests include namespace aliases, relative imports, dynamic nested attributes, shadowing, source edits, project isolation, absence of code execution and bounded parser facts. These are syntactic links, not Python import-runtime, class receiver, or type-checked proof. See `docs/CALL_EVIDENCE.md` and `tests/python-module-calls.test.mjs`.

## v0.17.0 native graph integration gate

The user-supplied 16-source Graphify/CodeGraph/SDL/TeaRAGs cohort is pinned and decomposed in `docs/GRAPH_SOURCE_AUDIT.md` and `integrations/graph-source-audit.json`. This candidate implements deterministic read-only static import/call graph queries (status, shortest paths, neighbors, incoming-degree hubs, weak components, advisory boundaries and bounded JSON/Mermaid) through **one additional tool** and the existing CodeIndex. No new session/context hook, daemon, model call or generated file. Regression tests cover direction, budgets, provenance, project root and symlink refusal, no project-code execution and Pi tool registration; see `tests/graph-intelligence.test.mjs` and `docs/GRAPH_NATIVE.md`. Additional source features are phased candidates, not full port or token-savings claims.

## v0.18.0 Graphify artifact interoperability gate

The v0.18.0 candidate adds `envelope_code_external_graph` under the existing CodeIndex. It reads fixed project-local `graphify-out/graph.json` (including NetworkX root metadata, `nodes` and `links`) and optional self-declared `envelope-sources.json` SHA-256 source/graph manifest. Each returned edge retains external provenance and upstream confidence, never joining native AST evidence. Missing, stale, invalid and partially attested input statuses are distinct; the `needs_update` marker blocks traversal until explicit acknowledgement. Query budgets and path-only status do not imply semantic completeness. The watcher is opt-in, bounded, invalidation-only and disposed on extension shutdown; no Graphify or model invocation is made. Tests: `tests/graphify-adapter.test.mjs` and `docs/GRAPHIFY_ARTIFACTS.md`. PR #6 and this PR remain unmerged unless explicitly approved.

## v0.19.0 explicit project memory, co-change evidence and cards

Opt-in `envelope_memory` adds typed, project-scoped SQLite notes with manual Markdown and Claude Code JSONL import, source-hash freshness, explicit deletion and no automatic capture or vault write. `envelope_code_history` adds bounded, read-only non-merge Git co-change/churn, not causal/ownership proof. `envelope_code_context_card` composes bounded source-hash-verified AST symbol/import/call evidence; source excerpts are opt-in. New tests: `tests/project-memory.test.mjs`, `tests/code-history.test.mjs`, and `tests/context-card.test.mjs`. Full hosted regressions and real Pi/Tersio/WASM/clangd/packed-install gates must pass before publication or merge.

## v0.20.0 .NET Graphify interoperability, retrieval and architecture policy

The actual Graphify.NET exported JSON fields are now consumed in the local external graph reader, including `edges[].relationship` and nested source locations. Foreign absolute paths are redacted and cannot act as attestations. Local source retrieval combines AST symbol/path rankings, verifies source bytes before disclosure and reports candidate/verification gaps; no vector/embedding backend is implied. `envelope_code_policy` provides read-only advisory architecture checks and the manually invoked `architecture:gate` script with strict incomplete-evidence treatment, never an automatic failing CI step. Git co-change uses NUL-delimited filenames. The v0.19.0 predecessor passed hosted [run 42491266788](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42491266788) (361 pass, 0 fail, 1 skip); this v0.20.0 candidate requires its own complete hosted verification before release claims.

## v0.21.0 discovery and visual export

The new `envelope_capabilities` tool is a read-only capability status and advisory route planner. Optional `graphify`/`jcodemunch`/`rtk`/`headroom` PATH detections are presence-only, never executed. Native file graphs can export bounded static SVG and Obsidian Mermaid Markdown with security-focused escaping; declared external Graphify community IDs are queryable separately from native graph evidence. This phase does not automatically run tools, invoke models, install viewers, start servers, or write Obsidian files. Tests `tests/capability-cockpit.test.mjs`, `tests/graph-visualization.test.mjs`, and `tests/graphify-dotnet.test.mjs`. The prior v0.20.0 candidate passed hosted run 42492265689 (376 passed, 0 failed, 1 skipped); this candidate requires independent hosted CI.

## v0.22.0 Graphify CLI integration (unmerged review candidate)

An explicit, project-fenced `envelope_graphify_cli` read-only tool invokes a user-pinned Graphify Python binary for bounded query/path/explain only after `/envelope graphify on`. `status` never launches any process. Human slash commands provide code-only, no-cluster build/update with forced `GRAPHIFY_BACKEND=none` and stripped API keys. A single existing prompt hook can opt in to concise artifact-state orientation; a standalone background watcher, model extraction and arbitrary CLI flags are not implemented. Active processes are cancelled on disable/shutdown, errors cannot masquerade as successful partial CLI output, and local metrics store only action/outcome/duration. See `docs/GRAPHIFY_CLI.md` and `tests/graphify-cli-bridge.test.mjs`. Fake-executable integration passing is not proof of real Graphify CLI compatibility: require separate hosted full regressions, packaging and live versioned Graphify smoke before release.
