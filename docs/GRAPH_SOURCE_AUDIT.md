# 16-source graph, memory and workflow integration audit

**Audit date:** 2026-11-08. **Baseline:** Envelope v0.16.0 commit `0ae309be24ca2ba3ceb73f80fe52ad4a8d27dc64`. **Candidate:** v0.18.0 on the unmerged review stack.

The user supplied an assumption that licensing clearance will be resolved separately. It is not a legal opinion. This implementation uses independently written graph code; retain upstream attribution if later copying actual source.

The repositories represent distinct *engines*, *host adapters*, *watchers*, *viewers*, *memory pipelines*, *workflow controllers*, and one unrelated GraphQL project. Each is pinned below to its inspected default-branch commit, not a floating version.

| Source (pinned SHA prefix) | Observed role | Envelope status / decision |
|---|---|---|
| [lucasrosati/claude-code-memory-setup](https://github.com/lucasrosati/claude-code-memory-setup) (`4cd2e6bd4319`) | Obsidian notes, chat import and session autosave | Graph-first orientation in v0.17; explicit project memory/import in a later phase |
| [elbruno/graphify-dotnet](https://github.com/elbruno/graphify-dotnet) (`008477767c81`) | File extraction > typed graph > communities > report/export; AST or optional AI | Typed static provenance in v0.17; .NET / semantic Graphify bridge later |
| [juhas96/graphify-pi](https://github.com/juhas96/graphify-pi) (`dd54ac9ae22b`) | Pi graphify CLI wrapper, freshness prompts and wiki-first guidance | Single native graph-query tool; v0.18 external node-link health and freshness adapter |
| [franklywatson/claude-rig](https://github.com/franklywatson/claude-rig) (`54b4a5c79ebe`) | Claude cockpit, dependency detection, tool routing, skill-chain and metrics | Keep existing Tersio RTK/workflow ownership; future capability status |
| [gaodes/pi-graphify](https://github.com/gaodes/pi-graphify) (`4826f5eb351b`) | Pi graphify CLI query, paths, hubs, reports, watchers and exports | Native graph queries plus v0.18 external Graphify artifact read; no CLI/LLM backend |
| [QuantumKuba/dsh-graphify-plugin](https://github.com/QuantumKuba/dsh-graphify-plugin) (`74a2c72b31ab`) | DSH graph adapter, project-root fencing, freshness/status and MCP lifecycle | Reuse CodeIndex project isolation; v0.18 external graph artifact root fencing |
| [nainglinnphyo/OpenGraphify](https://github.com/nainglinnphyo/OpenGraphify) (`4732f159ffc7`) | NestJS/GraphQL server with Apollo playground, unrelated to AST Graphify | No native runtime role; optional GraphQL read-only projection later |
| [yetanotheraryan/graphify-chokidar](https://github.com/yetanotheraryan/graphify-chokidar) (`9c584df9ab08`) | Debounced file watcher, code vs media classification, user-confirmed LLM rebuild | Existing incremental refresh; v0.18 optional invalidation-only debounced watcher |
| [crafter-station/graphify-visualizer](https://github.com/crafter-station/graphify-visualizer) (`15c67d7e5a3c`) | Obsidian bridge that embeds Graphify HTML, not a graph extractor | Native bounded JSON/Mermaid export; UI bridge later |
| [m4t0t0/cmd-mod-graphify](https://github.com/m4t0t0/cmd-mod-graphify) (`474ecaecbf18`) | CommandCode Graphify adapter with architecture exploration and god nodes | Native degree hubs/paths/exports; no competing host adapter |
| [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) (`f72c9d2efb14`) | Rust/TS codegraph kernel, typed traversal, auto-sync, impact and agent tools | Deterministic bounded typed BFS over live CodeIndex; advanced bridges later |
| [AxiomCodeAI/axiomcodegraph](https://github.com/AxiomCodeAI/axiomcodegraph) (`29f7ecf05297`) | IR and formal-methods oriented call analysis with asserted links | Explicit uncertainty; no false proof claim; optional IR link adapters later |
| [GlitterKill/sdl-mcp](https://github.com/GlitterKill/sdl-mcp) (`2a20acbd283a`) | Symbol delta ledger, compact context cards, graph slices, memory and policies | Existing context/retrieval plus bounded graph views; cards/memory later |
| [Ancienttwo/repo-harness](https://github.com/Ancienttwo/repo-harness) (`6b3c8def0a5b`) | Repo-local task state, review proof, Pi hook bridge and capability contracts | Reuse Envelope workflow ledger; no second task scheduler |
| [optave/ops-codegraph-tool](https://github.com/optave/ops-codegraph-tool) (`427c96f6da08`) | Dependency/impact graph, weak/semantic communities, boundaries, CI and co-change | Advisory import/call boundary audit and weak components; temporal gates later |
| [artk0de/TeaRAGs-MCP](https://github.com/artk0de/TeaRAGs-MCP) (`5ba0ac24a02d`) | Semantic retrieval, call graph, Git trajectory, architecture and naming lexicon | Existing FTS/calls plus graph navigation; history/vector layers later |

## Architecture decisions

- Reuse **one** live CodeIndex and its static import/uniquely resolved call candidates. Do not duplicate graph scanners, RTK rewriting, memory/context hooks or task schedulers.
- The v0.17 native `envelope_code_graph` tool exposes status, neighbors, shortest paths, incoming-degree hubs, **weak components (not semantic/Louvain communities)**, advisory directory boundary audits, and bounded JSON/Mermaid exports.
- Each edge declares whether it is a parsed static import or a syntactic call candidate. Unresolved dynamic calls are not upgraded to known edges; `complete:false` and `reasons` describe known caps and parser gaps. No source code execution or model calls.
- External Graphify/CodeGraph/SDL/TeaRAGs results must be opt-in adapters with schema, project root, freshness and provenance validation; never trusted as native AST evidence without checking.
- No automatic transcript import, credential reuse, LLM extraction, *automatically enabled* filesystem watcher, HTML embedding, network fetch, Git commit, CI failure or provider billing.
- Historical upstream token-savings multipliers are not measured Envelope outcomes.

## Follow-on phases, separate review gates

1. **18 (implemented in candidate):** Read-only Graphify/NetworkX graph artifact adapter with declared SHA-256 source checks and opt-in invalidation-only watch. No automatic CLI/LLM rebuild.
2. **19:** Project-scoped, typed and consent-based notes, session/PR continuity, Obsidian Markdown import/export and explicit erasure; no default chat transcription.
3. **20:** Temporal/co-change/ownership risk signals, optional architecture CI policies, reviewed workflow evidence and explicit uncertainty.
4. **21:** Symbol-first graph context cards, hybrid evidence retrieval and optional semantic-provider adapters with reproducible answer-quality/cost evaluation.
5. **22:** Read-only Graphify/Mermaid/Obsidian visual interoperability, optional MCP/GraphQL adapters, no required server or untrusted HTML execution.

**Boundary:** Listing a source here is not a claim of full or byte-for-byte port. See `docs/GRAPH_NATIVE.md` for the implemented v0.17 API and limits.

## v0.18 evidence boundary

`extensions/envelope/graphify-adapter.mjs` adds an explicit reader for local `graphify-out/graph.json` NetworkX node-link documents. It preserves upstream `EXTRACTED`/`INFERRED`/`AMBIGUOUS` labels while tagging **every edge** as an untrusted external assertion; this never upgrades to native AST proof. A separate optional `graphify-out/envelope-sources.json` self-declared SHA-256 manifest can detect byte changes in named project-local source files and in the graph file, and `needs_update` marks known staleness. Files not in that manifest remain explicitly unattested; manifest possession does not prove origin or completeness. The watcher is off until expressly enabled and only reports invalidation. See [Graphify artifact interoperability](GRAPHIFY_ARTIFACTS.md).
