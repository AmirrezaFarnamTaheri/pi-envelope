# Native Code Graph Evidence (v0.17.0 candidate)

## Architecture

`extensions/envelope/graph-intelligence.mjs` is a read-only, deterministic **file graph projection** of Envelope's existing and refreshed `CodeIndex`. It does not parse code independently, install a second Pi hook, run the project, require Graphify CLI, start a daemon or trigger a model call.

One tool is registered by `registerCodeFeature`: **`envelope_code_graph`**. It is disabled whenever existing `/envelope code off` disables CodeIndex. Its actions are:

| Action | Inputs | Output and limits |
|---|---|---|
| `status` | `relation` imports/calls/both | File/edge counts, parser availability, known incompleteness; no bodies |
| `neighbors` | indexed `source`, optional `direction`, `relation`, `limit` | At most 30 adjacent typed file edges with provenance |
| `path` | indexed `source` and `target`, optional `maxDepth` (1–8) | Deterministic shortest BFS route, at most 400 discovered files; incoming/outgoing/both |
| `hubs` | relation, limit | Ranked by **distinct inbound files**, plus source/call count details |
| `components` | relation, limit | Weakly connected components, at most 25 displayed; **not** Louvain or semantic communities |
| `boundaries` | `rules:[{from:'src/domain/',forbid:['src/infra/']}]`, relation, limit | Up to 50 advisory violations found in current static import/call graph; **not** a CI gate |
| `export` | `format:'json'|'mermaid'`, relation, limit | At most 100 nodes and 250 edges in read-only tool result, no file writes |

Examples:

```json
{"action":"path","source":"src/api.ts","target":"src/data.ts","relation":"imports","maxDepth":5}
```

```json
{"action":"boundaries","relation":"imports","rules":[{"from":"src/domain/","forbid":["src/infrastructure/"]}]}
```

```json
{"action":"export","format":"mermaid","relation":"both","limit":30}
```

## Data integrity, provenance and completeness

- An `imports` edge means `CodeIndex` resolved a **static** JS/TS, opted-in Python or Go package import. A `calls` edge means the existing call-evidence linker found a uniquely resolved **syntactic** candidate; it is not type-checked or runtime proof. The `evidence` property is always `parsed-static-import` or `resolved-syntactic-call`.
- The existing `indexOf(ctx)` performs hash-aware `refresh()` immediately before each query. The inherited `checkedPath` rejects outside-root and unindexed paths, including symlink substitutions.
- At most 2,000 indexed files, 15,000 file edges and 400 visited path nodes are admitted by this derived projection. Unavailable optional parsers, omitted or unresolved call facts, edge caps, path depth caps and visit caps mark `complete:false` with explicit `reasons`. A graph exceeding the 2,000-file hard budget returns an error rather than a misleading partial graph. A missing route is **not** negative proof if the search is incomplete. A `complete:true` result still only claims complete traversal of known source-evidence edges, not semantic completeness.
- Exports use project-relative paths and do not write to disk, execute code, fetch URLs, spawn providers, embed arbitrary graph HTML or expose raw source bodies. The underlying CodeIndex refresh can run bounded Git and optional stdlib AST subprocesses as before.

## Non-goals and follow-on work

This phase does **not** claim full adoption of 16 heterogeneous upstreams, semantic graph extraction, Obsidian vault integration, graph UI compatibility, a persistent historical graph, Louvain clustering, formal proof, or provider-billed savings.

The [16-source audit](GRAPH_SOURCE_AUDIT.md) records every pinned upstream, specifically incorporated ideas, intentionally avoided duplicate host integrations, and scoped next phases: external artifact/freshness adapters; opt-in durable project memory; temporal/co-change/ownership policies; semantic/graph retrieval; read-only visual interoperability and controlled evaluation.

## Focused tests and release gates

`node --test tests/graph-intelligence.test.mjs` tests directed shortest paths and depth budgets, uniquely resolved call links, hubs, weak components, advisory boundary violations, bounded JSON/Mermaid, project isolation, symlink refusal, no execution, and one Pi tool registration without new hooks.

`npm run check`, `npm run benchmark`, `npm run doctor:bundle`, and `npm run pack:check` are required, followed by hosted real Pi/Tersio RPC, Tree-sitter WASM, clangd and packed-installation smokes. Source-package checks alone do not establish distributable runtime compatibility.
