# Persistent, source-verified static file graph versions (review candidate)

Envelope can now preserve **explicit, bounded metadata snapshots** of the existing CodeIndex across Pi sessions. This adopts a narrow part of SDL-MCP's multi-version-graph and CodeGraph's incremental-history goals; it is **not** a persistent semantic knowledge graph, a compiler proof, a graph daemon, or a copy of an upstream database.

## Opt-in human commands

After `/envelope code on`, explicitly run:

```text
/envelope code versions status
/envelope code versions capture
/envelope code versions prune 8
```

The human-only `capture` command SHA-256-verifies each indexed source file and writes only project-relative file paths, file hashes, language labels, bounded declaration names/kinds and static import edges to a private local directory at `<Envelope home>/envelope-graph-versions/<SHA256(project canonical root)>`. It **does not persist source bodies**, chat transcripts, embeddings, or model responses. File permissions are `0600`; new storage directories are `0700`. An already-existing symlink in the storage path is rejected. Creating a snapshot never contacts a provider or launches another scanner. The same metadata yields the same content-addressed snapshot version and is not duplicated.

`prune N` explicitly retains the N newest versions of the current project (1–16). No background compaction, deletion, automatic index capture, or silent overwrite occurs. Up to 16 versions exist per project; beyond this, capture refuses until a human prunes old ones. Pruning local files does **not** remove backups or external snapshots.

## Read-only Pi tool

Agents can inspect snapshots using `envelope_code_versions`, which deliberately exposes only `status`, `list`, and `compare`. It does not expose `capture` or `prune`.

```json
{"action":"list"}
{"action":"compare","from":"<64-hex older version>","to":"<64-hex newer version>","limit":10,"maxChars":4000}
{"action":"compare","from":"<older>","to":"<newer>","offset":10,"ifVersion":"<previous comparison version>"}
```

Comparison reports added/removed/modified **files**, changed imported-file edges, and before/after declaration counts, without raw code. A file hash change does not prove which declaration changed, let alone behavior or runtime impact. Continued pages require an exact comparison version. A missing/corrupt/tampered snapshot fails closed; historical versions are checked for their own content-addressed integrity rather than treated as authoritative merely because the file name matches.

## Hard limits, privacy, and correctness

Capture accepts at most **512 files**, **12,000 declaration records**, **16 MiB of read-and-hash verified source bytes**, and **2 MiB of serialized metadata** per version. Historical compare defaults to 10 file changes; its limit is 1–25 and its serialized JSON byte budget is 900–16,000. Unsafe source paths, symlinks, changed source bytes since the index refreshed, invalid version IDs, insufficient output budget and unsafe storage paths fail closed. Historical snapshots are read-only observations at capture time, not verified original commits or a complete repository record; files beyond configured indexing limits may be absent. Other processes with the same account permissions and backups may still copy this metadata.

**Verification:** `tests/graph-versions.test.mjs` exercises real index captures across edits, integrity tampering, symlink attacks, raw source exclusion, source-staleness rejection, project isolation, explicit pruning, exact output bounds and single-hook Pi registration. The review branch also requires hosted npm regression, real Pi runtime and packaging gates.

**Remaining work:** SDL-MCP's full multi-version *symbol* graph, stable cross-language symbol IDs, typed calls, graph leases and spillover; CodeGraph's native multi-language graph kernel and automated incremental sync; semantic/vector retrieval, formal proof and external MCP/GraphQL transport. These are not provided by a private metadata snapshot. See [the 16-source audit](GRAPH_SOURCE_AUDIT.md) and [acceptance tracker #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10).
