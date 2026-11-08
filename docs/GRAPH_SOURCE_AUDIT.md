# 16-source graph, memory and workflow integration audit

**Audit date:** 2026-11-08. **Baseline:** Envelope v0.16.0 commit `0ae309be24ca2ba3ceb73f80fe52ad4a8d27dc64`. **Candidate:** v0.20.0 on the unmerged review stack.

The user supplied an assumption that licensing clearance will be resolved separately. It is not a legal opinion. This implementation uses independently written graph code; retain upstream attribution if later copying actual source.

The repositories represent distinct *engines*, *host adapters*, *watchers*, *viewers*, *memory pipelines*, *workflow controllers*, and one unrelated GraphQL project. Each is pinned below to its inspected default-branch commit, not a floating version.

| Source (pinned SHA prefix) | Observed role | Envelope status / decision |
|---|---|---|
| [lucasrosati/claude-code-memory-setup](https://github.com/lucasrosati/claude-code-memory-setup) (`4cd2e6bd4319`) | Obsidian notes, chat import and session autosave | v0.19 opt-in project notes, Markdown import/export and explicit, bounded Claude Code JSONL session extraction; no automatic vault/session hooks |
| [elbruno/graphify-dotnet](https://github.com/elbruno/graphify-dotnet) (`008477767c81`) | File extraction > typed graph > communities > report/export; AST or optional AI | v0.20 reads actual .NET Graphify JSON edge/metadata fields; .NET SDK execution and semantic extraction remain external |
| [juhas96/graphify-pi](https://github.com/juhas96/graphify-pi) (`dd54ac9ae22b`) | Pi graphify CLI wrapper, freshness prompts and wiki-first guidance | Single native graph-query tool; v0.18 external node-link health and freshness adapter |
| [franklywatson/claude-rig](https://github.com/franklywatson/claude-rig) (`54b4a5c79ebe`) | Claude cockpit, dependency detection, tool routing, skill-chain and metrics | Keep existing Tersio RTK/workflow ownership; future capability status |
| [gaodes/pi-graphify](https://github.com/gaodes/pi-graphify) (`4826f5eb351b`) | Pi graphify CLI query, paths, hubs, reports, watchers and exports | Native graph queries plus v0.18 external Graphify artifact read; no CLI/LLM backend |
| [QuantumKuba/dsh-graphify-plugin](https://github.com/QuantumKuba/dsh-graphify-plugin) (`74a2c72b31ab`) | DSH graph adapter, project-root fencing, freshness/status and MCP lifecycle | Reuse CodeIndex project isolation; v0.18 external graph artifact root fencing |
| [nainglinnphyo/OpenGraphify](https://github.com/nainglinnphyo/OpenGraphify) (`4732f159ffc7`) | NestJS/GraphQL server with Apollo playground, unrelated to AST Graphify | No native runtime role; optional GraphQL read-only projection later |
| [yetanotheraryan/graphify-chokidar](https://github.com/yetanotheraryan/graphify-chokidar) (`9c584df9ab08`) | Debounced file watcher, code vs media classification, user-confirmed LLM rebuild | Existing incremental refresh; v0.18 optional invalidation-only debounced watcher |
| [crafter-station/graphify-visualizer](https://github.com/crafter-station/graphify-visualizer) (`15c67d7e5a3c`) | Obsidian bridge that embeds Graphify HTML, not a graph extractor | Native bounded JSON/Mermaid export; UI bridge later |
| [m4t0t0/cmd-mod-graphify](https://github.com/m4t0t0/cmd-mod-graphify) (`474ecaecbf18`) | CommandCode Graphify adapter with architecture exploration and god nodes | Native degree hubs/paths/exports; no competing host adapter |
| [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) (`f72c9d2efb14`) | Rust/TS codegraph kernel, typed traversal, auto-sync, impact and agent tools | Typed native graph BFS plus v0.19 bounded Git co-change evidence; advanced multi-language backends later |
| [AxiomCodeAI/axiomcodegraph](https://github.com/AxiomCodeAI/axiomcodegraph) (`29f7ecf05297`) | IR and formal-methods oriented call analysis with asserted links | Explicit uncertainty; no false proof claim; optional IR link adapters later |
| [GlitterKill/sdl-mcp](https://github.com/GlitterKill/sdl-mcp) (`2a20acbd283a`) | Symbol delta ledger, compact context cards, graph slices, memory and policies | Existing replay/FTS and graph plus v0.19 source-hash-verified context cards and opt-in notes; no independent SDL engine |
| [Ancienttwo/repo-harness](https://github.com/Ancienttwo/repo-harness) (`6b3c8def0a5b`) | Repo-local task state, review proof, Pi hook bridge and capability contracts | Reuse Envelope workflow ledger; no second task scheduler |
| [optave/ops-codegraph-tool](https://github.com/optave/ops-codegraph-tool) (`427c96f6da08`) | Dependency/impact graph, weak/semantic communities, boundaries, CI and co-change | v0.20 explicit native static boundary/fan-in policy and opt-in CI gate plus v0.19 Git co-change; no automatic policy activation |
| [artk0de/TeaRAGs-MCP](https://github.com/artk0de/TeaRAGs-MCP) (`5ba0ac24a02d`) | Semantic retrieval, call graph, Git trajectory, architecture and naming lexicon | Existing FTS/calls and graph navigation plus v0.20 verified local symbol/path retrieval and v0.19 Git/cards; embeddings/vector backends absent |

## Architecture decisions

- Reuse **one** live CodeIndex and its static import/uniquely resolved call candidates. Do not duplicate graph scanners, RTK rewriting, memory/context hooks or task schedulers.
- The v0.17 native `envelope_code_graph` tool exposes status, neighbors, shortest paths, incoming-degree hubs, **weak components (not semantic/Louvain communities)**, advisory directory boundary audits, and bounded JSON/Mermaid exports.
- Each edge declares whether it is a parsed static import or a syntactic call candidate. Unresolved dynamic calls are not upgraded to known edges; `complete:false` and `reasons` describe known caps and parser gaps. No source code execution or model calls.
- External Graphify/CodeGraph/SDL/TeaRAGs results must be opt-in adapters with schema, project root, freshness and provenance validation; never trusted as native AST evidence without checking.
- No automatic transcript import, credential reuse, LLM extraction, *automatically enabled* filesystem watcher, HTML embedding, network fetch, Git commit, CI failure or provider billing.
- Historical upstream token-savings multipliers are not measured Envelope outcomes.

## Follow-on phases, separate review gates

1. **18 (implemented in candidate):** Read-only Graphify/NetworkX graph artifact adapter with declared SHA-256 source checks and opt-in invalidation-only watch. No automatic CLI/LLM rebuild.
2. **19 (implemented in candidate):** Project-scoped, explicit typed notes, Markdown import/export, bounded Claude JSONL extraction, source SHA status and deletion; no default chat transcription or vault writes.
3. **20 (partial in candidate):** Bounded Git co-change/churn with explicit uncertainty; full ownership-risk and architecture CI policies remain future work.
4. **21 (partial in candidate):** Hash-verified symbol-first context cards plus existing lexical retrieval; embeddings, semantic providers and provider-billed evaluations remain future work.
5. **22:** Read-only Graphify/Mermaid/Obsidian visual interoperability, optional MCP/GraphQL adapters, no required server or untrusted HTML execution.

**Boundary:** Listing a source here is not a claim of full or byte-for-byte port. See `docs/GRAPH_NATIVE.md` for the implemented v0.17 API and limits.

## v0.18 evidence boundary

`extensions/envelope/graphify-adapter.mjs` adds an explicit reader for local `graphify-out/graph.json` NetworkX node-link documents. It preserves upstream `EXTRACTED`/`INFERRED`/`AMBIGUOUS` labels while tagging **every edge** as an untrusted external assertion; this never upgrades to native AST proof. A separate optional `graphify-out/envelope-sources.json` self-declared SHA-256 manifest can detect byte changes in named project-local source files and in the graph file, and `needs_update` marks known staleness. Files not in that manifest remain explicitly unattested; manifest possession does not prove origin or completeness. The watcher is off until expressly enabled and only reports invalidation. See [Graphify artifact interoperability](GRAPHIFY_ARTIFACTS.md).

## v0.19 evidence boundary

`envelope_memory` requires an explicit `/envelope memory on` toggle, stores notes in owner-only project-scoped SQLite, imports only specific project-local Markdown or Claude Code JSONL files when requested, and does not auto-capture chats. JSONL extraction omits raw commands and assistant responses. Source hashes indicate byte freshness, not truth. `envelope_code_history` computes limited non-merge Git co-change/churn without inferring causal dependency, ownership, or code quality. `envelope_code_context_card` rechecks indexed source SHA-256 and returns bounded symbols/imports/call candidates without source excerpts unless requested. These parts are independently adapted from the patterns documented above, not full ports of their engines. See `docs/PROJECT_MEMORY.md`, `docs/CODE_HISTORY.md`, and `docs/CONTEXT_CARDS.md`.

## v0.20 evidence boundary

The actual Graphify.NET `JsonExporter` was inspected and used to make the external node-link reader compatible with `.NET` `file_path`, `relationship`, and nested location metadata, with foreign absolute paths redacted. Local `envelope_code_retrieve` adds AST symbol/path rank fusion with original-source hashes, no embeddings or automatic raw-source disclosure. Optional `envelope_code_policy`/`architecture-gate.mjs` evaluates reviewed architectural dependency and fan-in rules; it does not run automatically. Git-history co-change now uses NUL-framed filenames, preserving spaces/newlines/tabs. See `docs/GRAPHIFY_DOTNET.md`, `docs/CODE_RETRIEVAL.md` and `docs/ARCHITECTURE_POLICY.md`.
