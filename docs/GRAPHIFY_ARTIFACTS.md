# Graphify artifact interoperability — v0.18.0 (review candidate)

**Status:** Implemented as an opt-in, local, read-only adapter. The parent Envelope v0.17.0 consolidation is in **unmerged PR #6**. This extension does not execute, install, or bundle Graphify or its CLI; no LLM or provider calls occur. There is no daemon or automatic graph rebuild.

## Source compatibility and boundary

Pinned external reference: [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify), branch `v8`, commit `6c8002eca4acad58db6160eabcb466e61fc35afb`. This candidate understands the NetworkX `node_link_data` style **top-level** `nodes` and `links` / `edges` arrays, as well as a direct `{nodes,edges}` file. It accepts an optional nested graph only when it is itself a node-link collection; a NetworkX top-level `graph` metadata dictionary is not mistaken for the actual graph. The default local input path is fixed to `graphify-out/graph.json` relative to the current project root.

- Nodes: stable string `id`, optional `label` / `name`, `type` / `file_type`, `source_file` (or `file`/`path`), and `source_location`. Paths must resolve **inside the active project**. Source bodies are never returned.
- Graphify direction provenance: when a NetworkX export has both `_src` and `_tgt`, Envelope uses that retained arc direction instead of a potentially reordered undirected `source`/`target` pair. Partial, dangling or inconsistent markers invalidate the artifact. Reported edges include `directionEvidence: graphify-arc-markers` when the explicit markers are present.
- `explain` is a bounded read-only node report containing its own metadata plus incoming and outgoing edge assertions, independent counts and truncation flags; all graph outputs remain explicitly unverified external evidence.
- Edges: `source`, `target`, `relation` (or `type`), and optional `confidence` (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`), `confidence_score` and `source_file`. Every edge is separately marked `external-graph-assertion`, **even when Graphify calls it `EXTRACTED`**. Envelope does not promote those assertions to verified native AST imports or calls.
- Bounds: max graph JSON 2 MB, 2,000 nodes, 8,000 edges, max 25 returned nodes/neighbors, max 350 visited path nodes and max depth 8. JSON is parsed in memory only and never evaluated.

The tool is `envelope_code_external_graph`, registered once by the existing CodeIndex owner. Code intelligence must be enabled through `/envelope code on` (the current default). Example calls:

```json
{"action":"status"}
{"action":"nodes","query":"auth","limit":10}
{"action":"neighbors","source":"n_auth","direction":"outgoing","limit":15}
{"action":"explain","source":"n_auth","limit":10}
{"action":"path","source":"n_auth","target":"n_storage","maxDepth":5}
```

Graphify artifacts are external observations, not a second native index. Statuses distinguish `missing`, `invalid`, `unverified`, `stale`, and `declared-sources-match`. **All graph results remain `complete:false`** because external semantic/model-derived relationships cannot prove the absence of additional facts. A known-stale graph does not support navigation without explicit `allowStale:true` on that request.

## Source fingerprint evidence

The upstream Graphify manifest can track incremental extraction, but its hashing and extraction policy is not an authenticated SHA-256 statement that the graph is derived from all current source files. Envelope therefore does **not** equate Graphify's own `manifest.json` with verified provenance.

An operator can optionally provide `graphify-out/envelope-sources.json` containing a bounded **self-declared** SHA-256 inventory:

```json
{
  "version": 1,
  "graphSha256": "<64-hex-sha256-of-graph.json>",
  "files": [
    {"path":"src/auth.ts","sha256":"<64-hex-sha256-of-source-file>"}
  ]
}
```

Use a local SHA-256 tool to calculate the values **after** creating or updating the graph; Envelope neither constructs the attestation nor writes to the codebase. Hashes are rechecked from file bytes each time. Paths must be project-relative, and symlink traversal, path traversal, out-of-root source references, malformed schema, changed/missing inputs and oversized artifacts fail closed. `graphify-out/needs_update` marks the graph known-stale. A matching manifest means only that **the declared file bytes and graph bytes currently match those hashes**; the manifest does not prove who created the graph or that all input files were declared. `attestation.unattestedNodeSources` and `attestation.allGraphSourcesCovered` distinguish incomplete source coverage. Unlisted, external and semantic statements retain external-only trust.

## Explicit invalidation-only watch

A deliberate tool call with `{"action":"watch","enabled":true,"debounceMs":750}` starts a bounded, local `fs.watch` on the graph artifact directory and on the declared input directories. The watcher never executes Graphify, starts a child process, runs model extraction, rewrites source, touches Git, or changes context prompts. It only reports `changedSinceStart`, a debounced invalidation counter and pending status. Call `{"action":"watch","enabled":false}` to stop. All handles and timers close when code intelligence is switched off, at Pi session shutdown or extension closure, including failed partial setup. A watcher does not replace a fresh source-byte comparison; `status` rechecks hashes.

## Reproducibility and verification

`tests/graphify-adapter.test.mjs` covers actual upstream NetworkX node-link shape, confidence preservation, source-hash consistency, partial declarations, stale marker, missing/changed files, oversized and malformed artifacts, symlink/path isolation, bounded traversal, opt-in watcher cleanup and Pi registration without new event hooks. Real Pi/Tersio RPC and bundled-installation verification are required in hosted CI for this candidate; a source-only local pass is not sufficient to claim distribution readiness.

## Limitations

This is deliberately **not** full upstream graph/semantic extraction, Obsidian visualization, MCP or GraphQL serving, graph clustering, ownership/co-change history, formal verification, model-token benchmarking or arbitrary custom Graphify output-location support. It accepts no remote URLs or injected HTML. Future integration work is documented in `GRAPH_SOURCE_AUDIT.md` and must be separately reviewed; user-provided license compatibility is an assumption and not independent legal clearance.
