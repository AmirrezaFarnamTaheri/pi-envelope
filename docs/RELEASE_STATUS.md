# Envelope — release status and verification gates

This document is the current, user-facing release assessment. It replaces the historic execution plans and avoids retaining obsolete command and package examples.

## v0.17.0 candidate: implemented locally

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

Previous [v0.16.0 hosted CI](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42479440053) passed real Pi/Tersio/WASM/clangd gates; v0.17.0 requires an independent CI run before release.

## v0.15.0 chunk retrieval gate

The prior whole-document 25-output prefilter could miss the most relevant section. v0.15.0 adds persistent, bounded local chunk FTS5, verified exact-object search, lexical/BM25 reciprocal rank fusion and batch migration of legacy captures. The existing `envelope_search_fragments` text response remains an array; its Pi result details include index coverage and explicit partial status when a backfill or candidate limit is incomplete. The raw objects are still the source of truth. See `docs/CHUNK_RETRIEVAL.md` and `tests/output-chunk-index.test.mjs`. This is not embedding/vector retrieval or an execution sandbox.

## v0.16.0 Python call evidence gate

This candidate extends the existing optional Python stdlib `ast` call scanner and shared CodeIndex, without a new Pi hook or graph database. It links uniquely indexed module-alias member calls, tracks top-level assignment/rebinding and package initializer collisions, and fails closed on duplicate/ambiguous declaration and import candidates. The parser contract validates and caps new initializer binding metadata. Regression tests include namespace aliases, relative imports, dynamic nested attributes, shadowing, source edits, project isolation, absence of code execution and bounded parser facts. These are syntactic links, not Python import-runtime, class receiver, or type-checked proof. See `docs/CALL_EVIDENCE.md` and `tests/python-module-calls.test.mjs`.

## v0.17.0 native graph integration gate

The user-supplied 16-source Graphify/CodeGraph/SDL/TeaRAGs cohort is pinned and decomposed in `docs/GRAPH_SOURCE_AUDIT.md` and `integrations/graph-source-audit.json`. This candidate implements deterministic read-only static import/call graph queries (status, shortest paths, neighbors, incoming-degree hubs, weak components, advisory boundaries and bounded JSON/Mermaid) through **one additional tool** and the existing CodeIndex. No new session/context hook, daemon, model call or generated file. Regression tests cover direction, budgets, provenance, project root and symlink refusal, no project-code execution and Pi tool registration; see `tests/graph-intelligence.test.mjs` and `docs/GRAPH_NATIVE.md`. Additional source features are phased candidates, not full port or token-savings claims.
