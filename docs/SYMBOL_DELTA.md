# Explicit AST symbol history (v0.22.0 candidate)

The `envelope_code_symbol_delta` Pi tool provides a small, project-scoped, durable **symbol facts ledger** inspired by the Symbol Delta Ledger and CodeGraph concepts. It reuses Envelope's one current CodeIndex. It is not another parser, source database, semantic embedding service, or agent hook. It never executes repository source code, starts a network service, or calls a model.

## Actions and examples

The code-intelligence setting must be enabled (`/envelope code on`). All writes require an explicit action. The default action, `status`, only lists metadata and does not create a snapshot (though first access can initialize an empty SQLite file).

```json
{"action":"capture"}
```

Capture returns a UUID, source revision (if available), verified file count, declaration count, a metadata checksum, and `complete` with `reasons`. If the current index is limited, has parse diagnostics, duplicated symbol identities, or cannot access optional parsers, capture refuses unless the user explicitly passes `"allowIncomplete":true`. No automatic capture is triggered by the capability cockpit.

```json
{"action":"diff","from":"<returned-snapshot-uuid>","to":"current","limit":20}
```

A diff can target another prior captured UUID instead of `current`. It returns independent counts and bounded lists for added/removed/byte-changed files and added/removed/line-relocated symbol declarations. A line move is **not** a new definition; a same-named declaration moved across files is **not** guessed to be a rename. Source body edits without declaration changes appear as byte-changed files. Duplicates are explicitly marked ambiguous. Absence of a delta is never proof of semantic or runtime equivalence.

```json
{"action":"status","limit":10}
```

```json
{"action":"erase","id":"<returned-snapshot-uuid>"}
```

Erasure is per project and per snapshot, with SQLite FK cascading to the associated facts. Erasure does **not** securely sanitize disk free space, WAL pages, snapshots, logs or backups. No automatic retention or deletion occurs; each project holds up to 20 snapshots and must explicitly erase old snapshots to make room.

## Trust, coverage and performance

- Each explicit capture checks stored SHA-256 against the current on-disk bytes, rejects symlinked source components, and refuses changed sources until CodeIndex refresh. Snapshots store only project-relative filenames, source hashes, language, symbol names, kinds, containers and line numbers—not source bodies or prompts. This metadata itself can be sensitive and is kept in an owner-restricted SQLite database under `${ENVELOPE_HOME:-~/.tersio}/envelope-symbol-delta/symbol-delta.sqlite`.
- A digest across the stored snapshot facts rejects accidental or locally tampered rows on later retrieval. This is **not** a keyed signature, provenance attestation or protection against a malicious local database editor who can rewrite checksums.
- At most 1,000 files, 20,000 declarations, 1 MB per source file and 20 MB of verified bytes per capture. Each comparison returns at most 50 entries *per category* with accurate totals, `truncated` and `complete:false` if result limits or parser/index limits affect coverage.
- Source facts can be JS/TS and, when explicitly enabled and successfully parsed by the existing local helper, Python or Go. Indexing can omit unsupported extensions, ignored files, generated code or dynamic/runtime bindings. `complete:true` refers **only to available indexed syntactic evidence**, never to all possible project/runtime relationships.
- Snapshot metadata is scoped by SHA-256 of the canonical project root; there is no cross-project lookup. No remote service, LLM, automatic session transcription, Git commit, background watcher or Tersio rewrite is introduced.

## Verification

Focused tests: `node --test tests/symbol-delta.test.mjs`. Run the repository's complete `npm run check`, offline benchmark, bundled-dependency integrity gate, and hosted real Pi/Tersio/WASM/clangd/npm extraction checks before treating a candidate as release-verified.
