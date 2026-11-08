# Exact-output safety and anchored source integrity

## What Envelope does

One native Envelope `tool_result` hook (loaded after the Tersio RTK modules) processes **only completed, successful, single-text-part `bash` results**. Tersio remains the single owner of shell-command rewriting and its native `grep`/`glob` result filtering; Envelope never runs an RTK rewrite or changes tool arguments.

The reducer examines a stripped-of-ANSI *view* for classification but emits every **retained original text record**, with its original ANSI escapes, CRLF/LF/CR separator and UTF-8 characters intact. A record containing a `[L123]` source marker, numeric/hashline anchor, or explicit edit-anchor terminology is never removed or rewritten, even if it resembles a success line. Warnings, errors, fatal and aborted diagnostics stay verbatim. Mixed output can therefore lose repetitive passing-check rows without disturbing a copy-pasteable source line.

Only these full lines can disappear:

- Recognizable successful Vitest/TAP-style rows, where the same row does not contain diagnostics or protected anchors.
- Repeated build progress lines with recognized module counters.
- Excess ordinary `git status` file entries, after a preview of the first ten; **all deletion, rename, copy, and merge-conflict index entries are always retained**, and all non-file lines remain in place and are never reordered.

A bounded omitted-line count is appended. Exact recall rechecks the project-scoped SHA-256 and stored byte length; tampered object contents or symlinked object files are rejected instead of being returned as original evidence. If the result cannot achieve the configured minimum byte savings, or the final representation exceeds `output.maxChars` **UTF-8 bytes** (the historical setting name), nothing is changed. JSON, source-read tools, mixed image/text, structured output, failed tool calls, signaled/killed/aborted/timed-out/truncated results and unknown log categories are left unchanged.

When a shortened result qualifies, Envelope **first persists** the complete incoming text in the project-scoped local `OutputStore` (SQLite metadata plus SHA-256-addressed exact UTF-8 text). Only after persistence succeeds does it return reduced text plus an `envelope_recall_output id=…` marker. Storage errors result in no output patch. The recall tool refuses access from another project scope.

### Boundaries and limitations

- **No live stream mutation.** This release does not sanitize streamed `tool_execution_update` chunks; the documented Pi update event is observational, and altering it would be an unsupported integration claim. v0.8.0 transforms complete `tool_result` blocks only.
- **No source-code transformation.** The reducer preserves anchored content and skips the `read` tool; it does not implement the upstream RTK Optimizer's read-source filtering or anchor-aware partial truncation.
- **No universal parser.** Line classifications are deliberately narrow and may decline to shorten unusual output. Exact-billed token savings and effectiveness on real tasks are not yet verified.
- **Store boundaries.** Exact means the incoming Pi text result, after any earlier host/Tersio transformations; it does not recreate bytes that a shell or upstream hook already discarded. Text is encoded as UTF-8 in the store; arbitrary binary streams are not supported.
- **Privacy and retention.** The exact-output store can include commands and raw tool text, is kept locally, and retains data indefinitely by default. `/envelope output retention <days>` enables opportunistic expiry; `/envelope output erase <id>` and `/envelope output prune <days>` remove project-scoped records from the local object store and index, but not backups or filesystem snapshots; see the README. This is separate from the numeric-only observability store.

## Validation

`node --test tests/compactor.test.mjs tests/extension.test.mjs` covers a red/green regression for mixed Pi anchors, the upstream numeric/hashline formats, source text with embedded success symbols, CRLF/ANSI/Unicode, Git messages interspersed with file entries, stringent byte caps, interrupted results and project-scoped exact recall. `npm run benchmark` emits `envelope-synthetic-v2`, including a mixed anchored fixture with `anchorsPreserved` and `diagnosticsPreserved`. Its bytes and local elapsed timings are empirical; the token proxy is deliberately labelled a heuristic, and no provider calls are made.

Pattern references: [MasuRii/pi-rtk-optimizer pinned revision](https://github.com/MasuRii/pi-rtk-optimizer/tree/d155d253cb2f1358e34e717d47a82ebccb08cb8e) and [JayPokale/Chisle pinned revision](https://github.com/JayPokale/Chisle/tree/8851f7a17b6b20975e1c40a7de5c7e8523832658). No upstream implementation files were copied into this module.

## v0.15.0 indexed fragment search

`envelope_search_fragments` now performs project-scoped FTS5 matches over bounded stored sections rather than first selecting only 25 whole outputs. It combines FTS/BM25 ranks with lexical rank via reciprocal-rank fusion and returns UTF-8-safe previews around matching terms. Every hit is checked against the content-hashed raw object before display, and deletion/pruning removes chunk-index rows transactionally. Older existing outputs are lazily indexed in batches of at most eight per query. Tool response `details.chunkIndex` reports `partial`, `pending`, `candidateLimited` and `verificationLimited` so incomplete results are not presented as exhaustive. The fragment tool can write to the **local index** during migration, never to raw objects or remote systems. The extra full-text index may retain recoverable text in local database/WAL pages or filesystem backups even after deletion; do not treat this as cryptographic secure erasure. See `docs/CHUNK_RETRIEVAL.md`.

## v0.17.0 whole-output search integrity hardening

The legacy `envelope_search_output` search index is treated as **candidate discovery only**, just as the newer chunk index is. Results are returned only when the project scope agrees in both FTS and raw metadata, the content-addressed object passes exact SHA-256/byte validation, and the query terms exist in the verified original. Preview text is created exclusively from that original, never from a possibly stale or poisoned FTS snippet. Missing or corrupt raw objects are skipped rather than leaked through the index. Search is bounded to at most 100 candidates and 8 MB of verified original text per request; its `details.searchCoverage` reports skipped/unverified candidates, candidate-budget limits, and an explicit `partial` flag. A partial no-match response does **not** prove no evidence exists. Tests: `tests/output-search-integrity.test.mjs`.

## 2026-11-08 review hardening

Erasure creates a hash-only, project-scoped tombstone, preventing context
projection under another checkpoint from re-creating a deleted historical
object. Fresh tool execution may create a matching object again. Optional
chunk-index initialization failures do not prevent exact recall, and owner-
authorized deletion removes derived chunks by output ID even if FTS project
metadata was tampered with. Search indexes are untrusted; integrity failures,
resource budgets, and interrupted migration are reported as incomplete, both
in tool details and a separate model-visible text block.
