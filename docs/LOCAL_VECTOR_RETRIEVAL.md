# Source-verified offline vector and lexical-hybrid retrieval (review candidate)

This adapts the **vector-retrieval boundary** of CodeGraph, TeaRAGs, and SDL-MCP without installing their engines, downloading a model, invoking a provider, or starting a daemon. It is a genuine cosine-similarity implementation over **precomputed numeric embeddings supplied by the operator**. The read-only vector search tool does **not itself** generate embeddings or establish semantic quality. An optional, **human-invoked** operator-pinned local encoder can now produce source and query vectors; see [local encoder protocol](LOCAL_EMBEDDING_RUNTIME.md).

## Explicit activation

Create or explicitly build a trusted local artifact in the indexed project at `.envelope/embeddings.json` (do not commit potentially sensitive embeddings or filenames to a public repo). Each record must match the current source bytes:

```json
{
  "schema": 1,
  "model": "locally-managed-embedding-model-name",
  "dimensions": 8,
  "entries": [
    {"path":"src/a.ts","sha256":"<real SHA-256 of src/a.ts>","vector":[1,0,0,0,0,0,0,0]},
    {"path":"src/b.ts","sha256":"<real SHA-256 of src/b.ts>","vector":[0,1,0,0,0,0,0,0]}
  ]
}
```

Embeddings can come from any independently reviewed local provider or offline export process. All vectors, including the query vector, must come from the **same model and dimensionality** for cosine scores to have any useful meaning. Envelope does not assert model provenance from the `model` field. The manifest supports 8–1024 dimensions, up to 256 rows, and at most 1 MiB JSON. Each vector must have a nonzero finite norm with bounded component magnitudes. The file must be a non-symlinked, project-local regular file; no path outside the project can be referenced.

Activate explicitly with `/envelope code vectors on` and revoke with `/envelope code vectors off`. The feature is **disabled by default**; enabling it does not run a model. The operator may separately invoke a pinned, trusted executable through explicit `build`, `replace` or `find` commands. Envelope never downloads a model or forwards inherited provider credentials, but the external executable is not network-sandboxed; see [encoder safety boundary](LOCAL_EMBEDDING_RUNTIME.md).

## Read-only agent tool

```json
{"action":"status"}
{"action":"search","queryVector":[1,0,0,0,0,0,0,0],"limit":8,"maxChars":3000}
{"action":"search","queryVector":[1,0,0,0,0,0,0,0],"query":"retry handler","limit":8}
```

`envelope_code_vector` performs offline cosine similarity over the validated numeric vectors. When `query` is also supplied, the existing local hash-verified lexical retrieval provides a small explicit rank feature, combined as `0.7 * ((cosine + 1)/2) + 0.3 * (1/lexicalRank)` for matching lexical results (zero bonus otherwise). The weights are a transparent heuristic, **not** calibrated probabilities, verified semantic relevance or a token-savings claim.

Only indexed source rows with an exact matching source SHA-256 are admitted; changed or deleted source rows are excluded and counted as `skippedStale`. An indexed source that changed since refresh triggers a hard error rather than a plausible stale answer. Results include source path, current source hash, cosine, optional lexical rank and combined score, never original embedding arrays, source code excerpts, or raw prompts.

Pages use a query+manifest+current-index-bound `version`, `nextOffset`, `ifVersion`, and a strict 900–16,000-byte serialized JSON output budget. Limit is 1–15 results, and no unbounded disk or network calls occur. A missing manifest results in an actionable error; there is no automatic build or model use. Metadata paths and embeddings should be handled as potentially sensitive.

## Tests and remaining parity

`tests/local-vectors.test.mjs` covers numerical ranking, lexical fusion, stale source detection, malformed rows, symlink and root isolation, vector dimensions/norms, byte/cursor limits, and the required human opt-in with exactly one existing Pi hook set.

The read-only agent tool still requires a numeric query vector. The optional [human-only local encoder adapter](LOCAL_EMBEDDING_RUNTIME.md) can explicitly build source vectors and encode a human text query with a separately installed trusted model, but Envelope **does not ship** that model or certify its retrieval quality. It does not reproduce TeaRAGs' Qdrant/DuckDB trajectory system, CodeGraph's Rust graph kernel, SDL's hybrid agent routing or learned rerankers. No retrieval quality, memory savings, or actual provider billing has been benchmarked. Full source parity and semantic model execution remain in [tracker #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10).
