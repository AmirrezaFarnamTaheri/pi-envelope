# Chunk-level output retrieval (v0.15.0 candidate)

## Motivation

Before v0.15.0, `envelope_search_fragments` performed a whole-body FTS query capped at 25 outputs, then split and ranked sections in memory. A highly relevant section could be excluded simply because more than 25 other whole outputs contained the query words in unrelated sections.

## Architecture

The sole local `OutputStore` now maintains `output_chunks_fts` (FTS5, with BM25 scoring) and `output_chunks_state` in its existing project-scoped SQLite database. The raw output object remains authoritative and retains its exact content-addressed, SHA-256-scoped ID. Chunk text is an **additional local full-text copy of potentially secret output**, not a remote embedding or telemetry feed.

- On capture, exact-output metadata commits first. Chunk indexing is an additive SQLite transaction; an indexing error cannot discard the original object or block exact recall/compaction.
- Each heading-aware section is split into at most 1,200 Unicode code points per index record; oversized single lines get overlapping windows (256-codepoint default overlap for long lines). Results carry original 1-based line ranges and bounded match-centered previews. Overlaps may produce multiple candidate windows from the same line.
- FTS5 matches query terms **inside the same indexed chunk**, rather than across unrelated sections of one original output. Up to 200 candidates (and at most 40 distinct originals / approximately 8 MB of verified raw text) are ranked via BM25 and lexical-frequency reciprocal-rank fusion (RRF, rank constant 60). At most two chunks per output are returned per call, with a global limit of 25.
- Before returning any candidate, retrieval re-opens the exact output object, verifies its content hash/bytes, and checks the indexed chunk against a fresh deterministic split. Stale, corrupt or erased objects cannot be rendered as verified snippets. `envelope_recall_output` continues to return the byte-exact incoming text by ID.
- `erase` and `prune` remove chunk text and indexing metadata in the same SQLite transaction as the original output search metadata. Files are deleted after database commit, as before.

## Upgrading existing stores

When the schema is opened against a prior Envelope store, old outputs initially lack chunk records. A fragment search indexes up to **eight** older, verified captures per call. It never rewrites or invents the raw objects. The existing `envelope_search_fragments` tool still returns a JSON array of hits in `content`. Its response `details.chunkIndex` reports `{indexed, pending, chunks, partial, candidateLimited, verificationLimited}`. If `pending` is positive, repeat a query to advance local migration; if the 200-candidate or verification budget is hit, the result is also marked `partial`. Corrupt or missing legacy objects remain pending and are never silently dropped as if indexing were complete.

The bounded migration may perform disk writes to the **local index** even though the tool only reads raw output; it makes no model calls, shell invocations or network requests. Large histories can take multiple queries to index completely. No token-billing or semantic-retrieval improvement is claimed from this alone.

## Privacy and limits

Project scope is enforced on the SQL query **and** on verified original retrieval. The returned excerpt, line span, tool and exact recall ID can contain sensitive source/output text; callers should treat it like any other tool result. FTS5 index pages and journal/WAL/backups are not cryptographically erased by a DELETE; Envelope does not claim secure media sanitization. Max raw capture remains 2 MB; chunk queries and model-visible previews are bounded. This is lexical ranking, not embeddings or full natural-language understanding. No new Pi event hook or competing context manager is registered.

## Evidence

Run `node --test tests/output-chunk-index.test.mjs` for co-located matching past the old 25-output cap, incremental persistence, bounded legacy migration, transaction deletion, corrupt-object suppression, Unicode line splitting, capped candidate diagnostics, safe source previews, and a real Pi tool registration harness. Run `npm run check`, `npm run benchmark`, and the hosted real Pi/Tersio/WASM/clangd package gates before claiming a distributable release.

### Index revision and incomplete results (review fixes)

The chunk index is independently versioned from raw captures. Upgrading from
an older boundary split clears only the derived local chunk index and lazily
rebuilds it from verified raw objects. A 256-codepoint window overlap preserves
common identifiers spanning a chunk boundary; extraordinarily long tokens
that exceed the fixed maximum window remain outside its completeness guarantee.
A bounded rotating migration cursor prevents missing or damaged oldest objects
from starving later healthy captures. Integrity failures and verification
budgets explicitly mark the report incomplete. The search tool keeps the
legacy hit-array in its first text block for callers and emits a second,
model-visible coverage block when results are partial.

The chunk index is optional: a failed upgrade cannot disable exact raw-output
recall. An intentionally erased historical object is protected by a persistent
project-scoped tombstone and cannot be silently recreated by a new checkpoint.
A **new live tool execution** can legitimately create the same content again.
