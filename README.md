# Envelope

**Envelope v0.22.0 (unmerged review candidate)** is one Pi coding-agent package that combines pinned Tersio modes with native, project-scoped output recovery, context checkpoints, code intelligence, reviewed worktree tasks, and local numeric observability. It is a source distribution: **no installed Pi, Tersio, or Tree-sitter WASM runtime is included**.

The [16-source graph adoption audit](docs/GRAPH_SOURCE_AUDIT.md) and [33-source, commit-pinned audit](docs/ALL_33_SOURCE_AUDIT.md), with their [graph ledger](integrations/graph-source-audit.json) and [original-source ledger](integrations/extraction-audit.json), distinguish delivered adaptations from external or deferred capabilities. These are **not** claims of full upstream parity.

## Install and verify

Requires Node.js >=22.13.0, a Pi coding-agent CLI supporting package manifests, and npm access to install `@krtclcdy/tersio@2.25.18` and `typescript@5.8.3`. Git is required for worktree child execution; Python, Go, Tree-sitter and a trusted LSP executable are optional.

```sh
cd pi-envelope
npm install --include=optional
npm run doctor:bundle
npm run pack:check
pi install .
```

`npm run pack:check` is intentionally strict: it must **fail** if any declared bundled Tersio resource is missing. `npm run pack:source-check` only inspects source package contents and **does not** verify bundled installability. For local path installation, install dependencies first: Pi does not install local-package dependencies automatically. Optional grammars have their own licenses and separate availability requirements. Only enable execution of reviewed third-party packages.

## Architecture and commands

`pi.extensions` loads the eight pinned Tersio extension entrypoints, then one native `extensions/envelope/index.js` entrypoint. Tersio owns its existing RTK rewrite/filter, Caveman, pstack, Headroom, timing, Combo and `/tersio` command; Envelope does not install a second competing RTK rewrite or separate code index. The native Pi command is **`/envelope`**; all added agent tools start with **`envelope_`**. The original Ponytail skill is referenced through the Tersio dependency.

| Area | User command and native tools | Behavior |
|---|---|---|
| Status and policy | `/envelope status`, `/envelope stats`, `/envelope policy on\|off` | Optional concise policy; no automatic prompt replacement |
| Output | `/envelope output on\|off`, `envelope_recall_output`, `envelope_search_output`, `envelope_search_fragments` | Conservative completed-bash compaction; exact project-scoped recovery or incrementally indexed chunk FTS5 + bounded BM25/lexical RRF search |
| Retention | `/envelope output retention <0..365>`, `/envelope output prune <days>`, `/envelope output erase <64-hex-id>`, `envelope_output_retention` | Explicit user-controlled deletion and bounded opportunistic expiry; 0 disables automatic expiry |
| Context | `/envelope context on\|off\|status\|restore`, `envelope_context_checkpoint`, `envelope_context_timeline`, `envelope_context_prune`, `envelope_context_restore`, `envelope_context_footprint` | Session-aware checkpointed projection with versioned crash-recoverable replay blocks; original Pi session transcript remains intact |
| Code | `/envelope code on\|off\|status`, `envelope_code_overview`, `envelope_code_lookup`, `envelope_code_impact`, `envelope_code_calls`, `envelope_code_verify` | Shared JS/TS AST index and static call evidence, with opt-in conservatively linked Python module aliases and Go packages |
| Graph | `envelope_code_graph` | Read-only typed static import/call paths, neighbors, inbound-degree hubs, weak components, boundary audits, JSON/Mermaid; bounded with explicit incompleteness |
| Memory | `envelope_memory` | Off-by-default, explicit project notes and Markdown/Claude JSONL imports, SHA freshness, lexical search, deletion; no automatic transcript capture |
| Context cards | `envelope_code_context_card` | Bounded source-hash-verified symbol, import and syntactic call evidence; no source bodies unless explicitly requested |
| Git history | `envelope_code_history` | Bounded read-only co-change/churn evidence; never causal dependency or author identity |
| Graphify | `envelope_code_external_graph` | Opt-in local NetworkX/Graphify node-link artifact inspection: source hash freshness, typed external assertions, bounded paths/neighbors, explicit read-only watcher; no external program or model calls |
| Symbol deltas (session-local) | `envelope_code_delta` | Explicit verified baseline, bounded versioned changes for AST declarations, conservative Python/Go uncertainty, static importer hints; no raw source or token-savings claim |
| Context slices (bounded) | `envelope_code_slice` | Lexical or exact-path source seeds, static import traversal, hash-verified card/skeleton/ETag references, version-safe pagination and strict JSON byte budget; no embeddings or source excerpts |
| Co-change review (advisory) | `envelope_code_coupling` | Bounded Git co-edit candidates compared with direct static file imports, source-hash verified, no causal or numeric risk claim |
| Persistent graph versions (explicit) | `envelope_code_versions` | Private, content-addressed file-hash + static-import snapshots; human-only capture/prune, metadata-only historical diffs |
| Local vectors (explicit opt-in) | `envelope_code_vector` | Source-hash verified cosine/hybrid ranking over user-provided numeric embeddings, no encoder or provider calls |
| Graphify CLI (opt-in) | `/envelope graphify status/on/off/binary/timeout/orientation/build/update/watch`, `envelope_graphify_cli` | User-pinned external Graphify executable: status, read-only query/path/explain, explicit human build/update or consent-only session code watch, no LLM provider keys; bounded and stale-aware |
| Changes | `envelope_code_change_impact` | Commit-pinned clean-checkout diff with changed-line evidence, static dependents, and candidate tests; not a complete semantic blast radius |
| Other languages | `/envelope code languages on\|off`, `envelope_code_languages` | Opt-in Python/Go stdlib AST through bounded subprocess parsing |
| Tree-sitter | `/envelope code tree on\|off\|status`, `envelope_code_tree_status`, `envelope_code_tree_query`, `envelope_code_tree_capture` | Optional real WASM S-expression queries and capture groups; unavailable grammar is reported, not simulated |
| Mutation safety | `/envelope code guard on\|off`, `/envelope code rename on\|off`, `/envelope code lsp status`, `envelope_code_lsp_verify`, `envelope_code_rename` | Optional JS/TS pre-write syntax guard; LSP diagnostics distinguish PASS/WARN/FAIL/UNVERIFIED; preview-first, fingerprint-bound JS/TS semantic rename |
| Workflow | `/envelope workflow on\|off\|status`, `/envelope workflow run on\|off`, `envelope_workflow_create`, `envelope_workflow_status`, `envelope_workflow_claim`, `envelope_workflow_finish`, `envelope_workflow_review`, `envelope_workflow_retry`, `envelope_workflow_events`, `envelope_workflow_run`, `envelope_workflow_handoff` | Durable dependency task DAG, review and fingerprinted detached-worktree handoffs; explicit opt-in Pi child |
| Metrics | `/envelope metrics`, `/envelope observability on`, `/envelope observability off`, `/envelope observability status`, `envelope_metrics_snapshot`, `envelope_metrics_events` | Local project-scoped numeric events, provider-reported usage and measured bytes; no billed token-savings claims |

**Worker isolation is mandatory.** `envelope_workflow_run` requires a clean, committed Git project and a detached worktree. **`isolated:false` is rejected** before any task claim or process launch. An exit status of 0 submits work for review; it does not verify the result, merge changes, or run tests automatically. A worktree is **not an OS sandbox**: the child still has host permissions. No automatic push, merge, cherry-pick, or worktree deletion occurs.

**Output privacy:** raw captured tool text can contain secrets. The local chunk FTS5 index also contains copies of searchable text, never sent to a service. Envelope stores up to 2 MB per capture in local owner-restricted files and a project-scoped SQLite index; SHA-256 verification rejects corruption and symlink-swapped objects. By default, there is **no automatic raw-output expiry**; set a retention policy or explicitly erase/prune. Deletion cannot guarantee erasure from backups or storage media. The numeric-only metrics ledger is separate, with a bounded 30-day retention default.

**Context safety:** projection is disabled until `/envelope context on` and requires explicit checkpoint/prune actions. A versioned, checkpoint-scoped SQLite replay ledger commits bounded output references atomically; replay verifies the stored original and fails open when missing, corrupt, or changed. The full Pi transcript remains available. `envelope_context_footprint` shows byte counts, not prompt bodies. Static call and import evidence may omit dynamic and ambiguous relations. LSP rename is JS/TS-only, off for application by default, and is not crash-atomic across multiple files.

## Local storage and settings

Settings live under `envelope` in Tersio's `~/.tersio/settings.json`. `ENVELOPE_HOME` overrides the home directory for development or isolated profiles; `TERSIO_HOME` is respected otherwise. Numeric measurements, exact output objects, context checkpoint sidecars and hash-only replay metadata, and workflow logs live in separate `envelope-*` directories inside that home. See [project memory](docs/PROJECT_MEMORY.md), [source context cards](docs/CONTEXT_CARDS.md), [Git history evidence](docs/CODE_HISTORY.md), [Graphify artifact integration](docs/GRAPHIFY_ARTIFACTS.md), [native graph evidence](docs/GRAPH_NATIVE.md), [16-source audit](docs/GRAPH_SOURCE_AUDIT.md), [chunk retrieval](docs/CHUNK_RETRIEVAL.md), [output safety](docs/OUTPUT_SAFETY.md), [context](docs/CONTEXT_COORDINATOR.md), [workflows](docs/WORKFLOWS.md), and [observability](docs/OBSERVABILITY.md).

## Development and evidence

```sh
npm run check                 # Syntax check and automated regression suite
npm run benchmark             # Synthetic offline bytes, quality invariants
npm run pack:source-check     # Source-package inspection only
npm run doctor:bundle         # Strict pinned-dependency integrity gate
npm run pack:check            # Strict installable package dry-run
npm run smoke:lsp-real        # Real local clangd smoke (when present)
npm run smoke:runtime         # Real installed Pi/Tersio RPC, or BLOCKED
npm run smoke:tree            # Real installed WASM grammar, or BLOCKED
```

The offline suite includes mocked Pi/Tree-sitter protocol and workflow integration, actual local Git worktrees, real Python/Go AST runs when installed, and real clangd LSP when available. **Passing those tests does not establish complete Pi/Tersio live compatibility.** The v0.18.0 Graphify candidate passed [hosted real-runtime validation](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42490446378) (339 passing, 1 skipped). The v0.19.0 memory/history/cards extension requires its own hosted suite before any release claim. This source archive alone does not prove a new bundled release.

## Scope and provenance

Envelope's native modules are independently authored adaptations; the 33 originals are neither all vendored nor all feature-equivalent. The 16 additional upstreams are under a user-provided licensing-clearance assumption, not an independently validated legal conclusion. v0.18 adds a read-only local Graphify node-link adapter and an explicitly enabled invalidation-only watcher. v0.19 adds explicit project notes, bounded source-history and context cards, plus on-demand local Markdown/Claude JSONL imports. External Graphify/Neo4j/Qdrant/.NET/MCP servers, automatic chat importers and model-runner fleets are not installed or executed. Preserve their separate installation/licensing and use explicit optional integrations rather than loading another hook owner. The [source coverage matrix](docs/ALL_33_SOURCE_AUDIT.md), [license notes](LICENSES.md), and [current status](docs/RELEASE_STATUS.md) document evidence and remaining external work. A source ZIP without `node_modules` is not a prebundled npm release.

## Additional native graph/retrieval tooling (v0.20.0 candidate)

`envelope_code_retrieve` ranks and hash-verifies local indexed symbols/files without a model or embeddings; `envelope_code_policy` evaluates user-supplied architecture boundaries and incoming-file-degree heuristics. An optional standalone `scripts/architecture-gate.mjs` can fail a user-configured CI job but **does not run by default**. The external graph reader also consumes actual Graphify.NET `graph.json` edge and source-location fields and redacts foreign Windows/UNC paths. See [retrieval](docs/CODE_RETRIEVAL.md), [policies](docs/ARCHITECTURE_POLICY.md), and [.NET interoperability](docs/GRAPHIFY_DOTNET.md).

## Capability discovery and read-only visual interoperability (v0.21.0 candidate)

`envelope_capabilities` shows actual Envelope mode toggles, detected-but-unverified external CLI presence and manual orientation/review/resume tool sequences. `envelope_code_graph` can export a bounded static SVG or Obsidian-compatible Mermaid Markdown note with safely encoded labels. `envelope_code_external_graph` can inspect Graphify/Graphify.NET exporter-declared communities, never as native inferred graph proof. None of these changes install new host adapters, execute external CLI tools, modify a vault or publish a service. See [capability cockpit](docs/CAPABILITY_COCKPIT.md) and [visual exports](docs/GRAPH_VIEW_EXPORT.md).

## v0.22.0 opt-in Graphify CLI review candidate

The existing read-only `graphify-out/graph.json` adapter can optionally be complemented by `envelope_graphify_cli` to run a pinned, trusted Graphify Python executable. Disabled until explicitly configured; agent tool operations are read-only and project-scoped, while local AST-only build/update require user slash commands. Optional graph orientation reuses the existing prompt hook; an explicitly enabled session-only code watcher can debounce local AST updates without LLM calls. See [CLI contracts](docs/GRAPHIFY_CLI.md) and [consent-only watcher controls](docs/GRAPHIFY_WATCH.md). [Verified symbol delta guide](docs/SYMBOL_DELTA.md) and [context slice guide](docs/CONTEXT_SLICE.md) and [co-change review guide](docs/COCHANGE_REVIEW.md) describes explicit, session-local declaration snapshots and budgeted, source-checked change pages. Real Graphify CLI compatibility is tested by a new isolated `graphifyy==0.9.100` release gate; verify the specific hosted run before treating this candidate as runtime-tested.

For explicit durable static graph history, see [persistent graph version commands](docs/PERSISTENT_GRAPH_VERSIONS.md). Captures contain private source paths and declaration names, but never source bodies.

[Local vector retrieval guide](docs/LOCAL_VECTOR_RETRIEVAL.md) documents the operator-supplied embedding manifest and strict source-staleness controls.
