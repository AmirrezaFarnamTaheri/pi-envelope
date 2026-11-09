# Consent-gated Graphify code refresh watcher (unmerged review candidate)

Envelope adapts the deterministic code-only update pattern of `yetanotheraryan/graphify-chokidar` without loading its separate Pi/Claude hooks. **Off by default.** This is a separate watcher from `envelope_code_external_graph({action:"watch"})`, which only observes invalidation. The new coordinator can actually run the externally pinned Graphify CLI, but exclusively after explicit human consent.

## Interactive controls

First install and review a trusted Graphify executable and pin its absolute path. Build the code graph once:

```text
/envelope graphify binary /absolute/path/to/graphify
/envelope graphify on
/envelope graphify build
/envelope graphify watch on 1200
/envelope graphify watch status
/envelope graphify watch off
```

`/envelope graphify watch on` defaults to a 1200 ms debounce. An optional debounce of 250–10000 ms is supported. `watch on` requires Envelope code intelligence, the enabled pinned external CLI, and a readable **non-stale** `graphify-out/graph.json` in the current project. Explicit `watch off` cancels the watcher and waits for any running CLI update to finish or abort. The watcher is in-memory and **not persisted** across Pi sessions or restarts. There is no automatic installation, provider configuration, or server.

## Which changes can automatically update the graph?

- Code-like file extensions (JavaScript/TypeScript, Python, Go, Rust, Java, C/C++, C#, Ruby and other explicitly listed extensions in `graphify-watch.mjs`) coalesce into a single, sequential `graphify update . --no-cluster` command after the debounce. Graphify is executed with `GRAPHIFY_BACKEND=none`, with no forwarded provider API keys and no shell interpolation. **This is not an OS sandbox; trust the pinned CLI.**
- Markdown, PDF, images, JSON/configuration, unknown formats, newly created directories, symlinks, ambiguous path events, or unsupported media **never trigger an LLM extraction**. Instead, `manualRebuildRequired` is set. Use an explicitly reviewed/manual upstream Graphify semantic workflow for documents and media.
- Generated and sensitive directories including `.git`, `node_modules`, `graphify-out`, build outputs, caches, and symlinked directories are not watched. Source directories are scanned once at activation, not recursively monitored for new folders; stop and restart the watch after creating a new source directory.
- Per-project watcher limits are 64 directories and 256 pending distinct code paths. Overflow refuses a partial refresh. Status deliberately reports counts rather than source paths, queries, or subprocess output.

## Failure behavior and lifecycle

The coordinator runs at most one automatic refresh at a time. Events arriving during an update are coalesced into a later update. A filesystem-watch error, failed CLI update, or invalid/stale resulting artifact halts further updates and marks the state as requiring manual recovery. A new explicit `watch on` is required to restart; an incomplete update never silently retries.

Manual `/envelope graphify build` or `update` first stops the watcher and **waits for the previous update** to finish cancelling. The CLI also prevents two concurrent graph writes to the same project root. `/envelope graphify off`, changing the pinned executable, `/envelope code off`, and Pi session shutdown revoke the watch and abort running updates. Re-enable only after checking the resulting graph freshness and provenance.

The agent's `envelope_graphify_cli` tool remains read-only; it can inspect watcher status alongside graph health but cannot enable, configure, build or start an automatic refresh. Graphify stdout is limited to 16 KiB, and its stderr is not included in user/agent error messages. Metrics record only operation kind/outcome/duration, not filenames or source bodies.

## Evidence and non-goals

`tests/graphify-watch.test.mjs`, `tests/graphify-watch-integration.test.mjs` and `tests/graphify-watch-safety.test.mjs` cover debounce, classification, file/event handling, watcher errors, post-failure halt, cancellation, write serialization, Pi single-hook ownership, and error redaction. Hosted regression and packaged-install workflows are mandatory. The separate version-pinned `graphifyy==0.9.100` smoke covers the real CLI's AST build/query/path/explain/update contract; this does **not by itself** prove native filesystem-watch behavior on every OS.

Not included: automatic documentation/media LLM extraction, multi-provider credential handling, remote Graphify service, persistent daemon, unbounded recursive watching, imported upstream UI or guaranteed semantic/full graph completeness. See the [16-source capability audit](GRAPH_SOURCE_AUDIT.md) and [CLI contract](GRAPHIFY_CLI.md).


**Recovery/invalidation:** An ambiguous event, new directory/symlink, watcher failure, source-attestation drift or unknown/document event raises `manualRebuildRequired` and writes the existing `graphify-out/needs_update` marker when the output directory is safe. Both graph-read guards treat the artifact as stale and require explicit `allowStale:true` to inspect it; the in-memory watch-state guard also fails closed if the marker cannot be safely written. Further automatic refresh is blocked pending operator recovery. The marker and old source attestation are **never silently overwritten** or reinterpreted as fresh after a Graphify update: a successful CLI exit is not evidence that existing `envelope-sources.json` hashes still match. The operator must inspect/rebuild/attest before re-enabling. Stop/off uses the retained project path if a watched root has been renamed, and still aborts running work.
