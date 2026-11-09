# Explicit persistent symbol history (optional)
This is the retained unique capability from independent review PR #7, composed with the newer stacked symbol-delta implementation from PR #12. Both reuse Envelope's **one CodeIndex**, rather than installing another parser, hook, watcher, agent or model runtime.

| Interface | Lifetime | Evidence | Captures |
| --- | --- | --- | --- |
| `envelope_code_delta` | In memory, cleared at extension shutdown | Source-verified TS/JS declaration body hashes and static importers; Python/Go uncertain | Human-triggered `capture` only |
| `envelope_code_symbol_history` | Private SQLite across sessions | Source-verified snapshots of indexed filenames, SHA-256s, declaration names/kinds/lines | Human-triggered `capture` only |

## Durable history actions
Requires `/envelope code on`. All writes require an explicit action. Status may create an empty private SQLite store on first invocation, but never captures source. `capture` refuses incomplete evidence unless `allowIncomplete:true` is supplied.

```json
{"action":"status","limit":10}
{"action":"capture"}
{"action":"diff","from":"<snapshot UUID>","to":"current","limit":20}
{"action":"diff","from":"<older UUID>","to":"<newer UUID>"}
{"action":"erase","id":"<snapshot UUID>"}
```

No code bodies, model prompts or provider secrets are stored. Snapshot source files are SHA-256 verified and symlink components rejected. Comparison records syntactic identity and line relocation, not function-body equivalence, rename inference, runtime dependency, or formal correctness. The session-only delta tool is the appropriate interface for conservative TS/JS body-change evidence.

The private SQLite data resides under `<Envelope home>/envelope-symbol-history/symbol-delta.sqlite` with owner-restricted directory/file permissions. Per-project snapshots are keyed to the canonical root; quotas bound snapshot count, files, declarations, source bytes and diff output. Erasure is logical, **not** secure sanitization of SQLite WAL pages, backups, or filesystem snapshots. Unlike session-local delta storage, this metadata survives restarting Pi; users must explicitly erase it to control retention.

Tests: `node --test tests/persistent-symbol-history.test.mjs`, `node --test tests/symbol-delta.test.mjs`, and `npm run check`. This integration preserves PR #7's independently verified durability behavior without replacing or weakening PR #12's safer session-local source-body fingerprint path. It is **not** full SDL-MCP parity, a cross-language semantic graph, or a measured token-saving claim.
