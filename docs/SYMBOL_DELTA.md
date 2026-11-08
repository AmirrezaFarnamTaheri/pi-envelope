# Verified, session-local symbol deltas

Envelope adapts the **delta-pack and budgeted-context pattern** from [SDL-MCP](https://github.com/GlitterKill/sdl-mcp), with conservative importer hints related to [CodeGraph](https://github.com/colbymchenry/codegraph) and [TeaRAGs](https://github.com/artk0de/TeaRAGs-MCP). This is independently written, native Pi functionality on the **existing Envelope CodeIndex**, not a vendored SDL service or MCP transport.

## Tool and workflow

The tool is `envelope_code_delta`. It is available only when Envelope code intelligence is enabled (`/envelope code on`). All operations use the same current source index, which refreshes before a tool call:

```json
{"action":"status"}
{"action":"capture"}
{"action":"compare","limit":12,"maxChars":3000}
{"action":"compare","offset":12,"ifVersion":"<comparisonVersion from prior page>","limit":12,"maxChars":3000}
{"action":"clear"}
```

**Capture before editing.** A capture stores bounded declaration metadata, per-file source SHA-256, and TypeScript/JavaScript declaration-node text hashes **in memory only**. It does not write code, save raw source, import chat transcripts, call an LLM, run project code, or register a new context hook. The baseline is project-local and lasts only for the current Pi extension lifecycle; `clear` removes it explicitly, and disabling/closing code intelligence clears it. Repeating `capture` intentionally replaces the baseline. Up to four projects have session-local baselines.

`compare` re-reads and SHA-256-verifies current indexed source before comparison. A TS/JS symbol is **added**, **removed**, or **modified** when its declaration identity/body differs. It is not a semantic/type-checker proof. A declaration retaining the same body hash after moving lines does not count as modified. Duplicate declaration identities are marked `uncertain` rather than guessed. In Python/Go, symbol names may come from the existing opt-in AST index but their bodies are not independently hashed here; after a file change, unchanged identities are explicitly `uncertain` with `file-hash-only` precision.

A file can change outside any declaration (imports, comments, configuration references). `filesWithByteChanges`, `filesWithoutAttributedDeclarationChanges` and the `file-bytes-changed-without-attributed-declaration` reason prevent a false inference that the *whole file* is unchanged. `notModified:true` means only **no attributed declaration change**, and is not a guarantee of equivalent behavior. If a file is no longer indexed but still exists, the result is uncertain rather than declaring it deleted. Symlinks and stale index SHA checks fail closed.

Each change includes only source metadata, before/after line numbers, precision, and up to three statically resolved importing **files**. Those `staticImporters` are review candidates, not runtime propagation, test coverage, verified call chains, owners, severity/risk scores, or a formal proof. Use `envelope_code_context_card`, `envelope_code_calls`, `envelope_code_retrieve` or `envelope_code_change_impact` for separate, appropriately scoped evidence.

## Budgets and pagination

- Snapshot: maximum **1,000 indexed files**, **25,000 symbols**, and **24 MB verified source bytes**; no silent overflow. Index file caps and missing parser families cause `complete:false` with reasons.
- Compare: `limit` 1–30 change items, `maxChars` 900–16,000 bytes of **serialized UTF-8 JSON**, and zero-based `offset`. The default is 12 items and 3,000 bytes. If one item cannot fit, it errors instead of emitting an over-budget payload. This is a **byte/character output budget, not a provider token measurement**.
- Continuations: `nextOffset` and `comparisonVersion` identify the current baseline/current-source pair; offsets beyond zero require `ifVersion`. Changing source between pages invalidates the cursor, preventing silent page drift. The full comparison is recomputed from the current index on each query.
- No command executor, automated task runner, embeddings, vector database, SCM mutations, authorization bypass, raw source window, network/LLM use, or durable persisted delta ledger.

## Verification

`tests/symbol-delta.test.mjs` covers exact body edits, unchanged declaration bodies after comment shifts, imports-only changes, added/removed symbols, source-hash staleness, symlink substitution, duplicate ambiguity, file-hash-only Python evidence, exact byte budgets, cursor drift, project isolation and one-tool Pi registration.

```sh
node --test tests/symbol-delta.test.mjs
npm run check
npm run pack:check
```

Passing these tests proves the bounded, source-verified behavior above, not parity with SDL-MCP's persisted multi-version database, ranked subgraph beam search, SCIP/provider facts, memory bridge, multi-client MCP, semantic retrieval, exact token accounting, or PR-risk framework. Those remain explicitly open in the [16-source audit](GRAPH_SOURCE_AUDIT.md) and tracking issue #10.
