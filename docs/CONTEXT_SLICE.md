# Task-scoped verified context slices

This is a native, independently authored adaptation of the **bounded graph-slice and conditional-card patterns** described by [SDL-MCP](https://github.com/GlitterKill/sdl-mcp) and the local surgical-context principles of [CodeGraph](https://github.com/colbymchenry/codegraph) and [TeaRAGs](https://github.com/artk0de/TeaRAGs-MCP). It operates on Envelope's **one shared CodeIndex** and existing hash-verified retrieval and context-card modules, with no second scanner, model provider, graph database or MCP host.

## Call `envelope_code_slice`

Start from exactly one of a lexical query or an indexed project-relative file path:

```json
{"query":"authenticate","depth":1,"direction":"both","limit":6,"maxChars":4000}
{"path":"src/auth.ts","depth":2,"direction":"outgoing","limit":6,"maxChars":4000}
```

The query path uses `envelope_code_retrieve`'s local lexical rank fusion to select at most five verified file seeds. An exact path is preferred when known: it is checked against the canonical project root and current index, with no fuzzy selection. Graph expansion follows **only** statically resolved file imports from the CodeIndex (outgoing, incoming, or both). It explores at most 150 files to a maximum traversal depth of 3. This is **not** a semantic similarity graph, full cross-language reference resolution, SCC/cluster detector or runtime call graph.

Each selected source is SHA-256 verified when its context card is constructed; stale or symlink-escaped evidence fails closed. The output is a deterministic breadth-first selection containing path, distance, optional parent, source-derived ETag, and one of three levels:

- `card` — the existing verified source card with at most two symbols, import links and syntactic call facts per evidence category, never source code excerpts;
- `skeleton` — compact source SHA/language, a few symbol labels, and import/call totals with uncertainty reasons;
- `ref` — the ETag and source path only, used when callers already provided `knownEtags` or the byte budget cannot accommodate a larger rung.

The engine selects the richest **complete JSON object** that fits, rather than truncating its serialized contents. Raw source text, file contents, secrets inside function bodies, chat transcripts or generated summaries are never included. Symbol names and relative source paths remain visible metadata.

## Budgets and continuity

`limit` is 1–12 items (default 6), `maxChars` 900–16,000 bytes of **serialized UTF-8 JSON** (default 4,000), and `depth` 0–3. The output includes `totalCandidates`, `returned`, `truncated`, and `nextOffset`. To retrieve the next page use its `version` as `ifVersion`:

```json
{"path":"src/auth.ts","depth":2,"limit":1,"maxChars":4000}
{"path":"src/auth.ts","depth":2,"limit":1,"offset":1,"ifVersion":"<version from previous page>","maxChars":4000}
```

The version binds the task/entry, traversal options and **all currently indexed source hashes/import edges**; any source or dependency change invalidates stale page cursors. Pass `knownEtags` as an array of up to 30 existing 64-character SHA-256 card tags to avoid retransmitting unchanged card bodies. No persistent slice store, lease or server-side continuation is created.

`complete:false` and `reasons` disclose lexical candidate limits, missing seeds, graph expansion caps, parser/verification omissions and response budgets. No source-file evidence is invented when a query has no lexical match. Do not cite an absent path as proof that a dependency cannot exist. `maxChars` is a real output byte cap, **not** measured provider token consumption.

## Verification and upstream limitations

`tests/context-slice.test.mjs` covers lexical and exact seeds, incoming/outgoing traversal, bounded depth, deterministic order, omission of raw code bodies, SHA-256 source freshness, context rung fallbacks, ETag-only responses, versioned pagination, missing seeds, adversarial arguments and Pi single-hook ownership.

```sh
node --test tests/context-slice.test.mjs
npm run check
npm run pack:check
```

This does **not** implement SDL's full versioned graph slices/leases, semantic embeddings, multi-hop symbol-level ranking, language-provider/SCIP typed references, vector hybrid search, formal confidence proofs, or provider-billed token savings. Those remain separate acceptance criteria in [the 16-source audit](GRAPH_SOURCE_AUDIT.md) and issue #10. Use `envelope_code_delta` for explicit before/after changed declarations, `envelope_code_context_card` for an individual exact source, and `envelope_code_retrieve` for lexical ranked file search.
