# Envelope — cumulative implementation progress

**Current unmerged review candidate:** v0.22.0. The canonical integrated review stack is PR #6 against `main`; v0.22.0 is a separately proposed change. No merge, package publication, deployment or deletion is authorized by this document. `main` remains at its post-revert state.

## Implemented and reviewed building blocks

- **Runtime and safety:** one namespaced Pi extension layered after pinned Tersio resources; one output compactor and one context transformer; real-runtime smoke, Wasm/clangd and extracted-package gates. User-approved mutation toggles and detached-worktree handoffs remain explicit.
- **v0.14–0.17:** content-addressed output retention and verified FTS5/BM25 retrieval, checkpoint-bound SQLite context replay, conservative Python/JS/TS/Go call evidence, typed native file graph traversal and bounded architecture summaries.
- **v0.18:** local Graphify/NetworkX node-link import, source-hash freshness and opt-in invalidation-only watcher. External confidence labels remain untrusted, not native AST proof.
- **v0.19:** explicit opt-in project memory, Markdown/Claude JSONL fact imports, Git co-change/churn and source-verified code context cards; no automatic chat transcription.
- **v0.20:** Graphify.NET export format, source-hash-verified lexical AST retrieval, opt-in architectural boundary/fan-in policy and manually invoked CI gate.
- **v0.21:** non-executing capability cockpit, static SVG/Obsidian Mermaid export and exporter-declared communities; no required third-party engine or HTML execution.
- **v0.22 candidate:** manually captured, project-scoped source-verified symbol snapshots; snapshot-to-current and snapshot-to-snapshot deltas, duplicate/coverage uncertainty, explicit deletion and SQLite snapshot integrity checks. No new hook or model call.

All 16 user-supplied graph/memory/workflow sources are pinned and assessed in `integrations/graph-source-audit.json`; the original 33-source ledger remains separate at `integrations/extraction-audit.json`. `completePort:false` is deliberate and must never be equated with full upstream feature parity. Upstream license compatibility is a user-supplied assumption, not independently verified.

## Evidence and release gates

PR #6 v0.21.0 passed [hosted run 42492983913](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42492983913), including full repository tests, real Pi/Tersio RPC registration, real Tree-sitter WASM, clangd, offline invariants, and extracted npm-package checks. All 21 recorded CodeRabbit inline threads are resolved. The new v0.22.0 candidate passed focused local TDD, syntax, offline benchmark and strict bundle/pack checks, but **requires its own hosted full-suite and real-runtime CI** before being called release-verified.

## Open technical gaps

Multi-generation ACP summarization, Python MRO/type-checked cross-language runtime resolution, full persistent multi-agent graph backends, embeddings and semantic providers, external MCP/GraphQL server engines, formal method proofs, automatic task approvals, host-enforced OS sandboxing, full upstream application parity and independently verified provider-billed quality/cost improvements are not implemented. These need separate designs, tests, user-controlled runtime permissions and review.
