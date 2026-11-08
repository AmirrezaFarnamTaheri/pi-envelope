# Opt-in project memory (v0.19.0 review candidate)

## Scope, commands and consent

The native `envelope_memory` tool holds **only** notes explicitly created or imported by a caller who has enabled `/envelope memory on`. It is off by default, and disabling it does not erase existing notes. When off, no memory database is initialized. Existing context and session hooks do **not** save transcripts or model messages into this memory.

The same one extension registers `envelope_memory` actions:

| Action | Intent | Bound |
|---|---|---|
| `status` | Count notes for current project (no body) | No local memory access when off |
| `save` | Explicit typed note (`fact`, `decision`, `architecture`, `task`, `reference`) | 8 KiB text, title 160 bytes, at most eight tags |
| `list` | IDs, titles, tags and source freshness only | 25 notes |
| `search` | Deterministic Unicode-normalized title/body/tag lexical match | At most 256 stored notes, 25 results; no embeddings |
| `read` | Exact plaintext of one ID | Same 8 KiB stored bound |
| `forget` | Delete one project-scoped note ID | Exact ID and current project required |
| `importMarkdown` | **Explicit** path to a `.md` file inside the project | 8 KiB UTF-8 source, no symlinks/traversal |
| `importClaudeTranscript` | **Explicit** path to a Claude Code `.jsonl` file inside project | 128 KiB, parse at most 600 lines; no automatic hooks |
| `exportMarkdown` | Render one note as text suitable for a Markdown/Obsidian note | No file writes |

`importClaudeTranscript` extracts the first user objective, counts user messages/tool calls and lists up to 20 project-relative paths reported by edit tools. Raw Bash command bodies, assistant message bodies and tool results are *not* stored in the generated note. Imported content remains untrusted: it is never automatically appended to system instructions or executed. Session extracts beyond the line bound report incomplete evidence. Both imports use file-byte SHA-256, reject traversal and symlinks, and avoid duplicating an unchanged import. Edited sources make the old note `stale`, not silently updated.

## Persistence and limitations

Data is stored at `<TERSiO_HOME>/envelope-memory/memory.sqlite`, created lazily on enable, with 0700 directory and 0600 file mode, SQLite WAL and FULL synchronous, v1 schema. Notes are scoped to the realpath of the active project and limited to 256 per project. No background services, API keys, remote memory store, Obsidian vault scanning or model calls are needed. Disk/WAL snapshots and backups may contain erased plaintext; **this is not secure erasure or encryption**. Avoid importing secrets unless you intentionally accept local retention.

This is not all of `claude-code-memory-setup`: no automatic session-end hook, cross-vault filesystem writer, semantic memory graph or provenance-guaranteed summary is shipped. It is an independently written, deliberately conservative partial adaptation. It also reuses the existing Envelope workflow ledger rather than installing a new repo-harness scheduler.

Tests: `tests/project-memory.test.mjs`; hosted real Pi/Tersio and pack checks are required before release.
