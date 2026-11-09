# Explicit Graphify CLI bridge (v0.22.0 review candidate)

Envelope has two distinct Graphify interfaces: `envelope_code_external_graph` directly **reads** the project-local `graphify-out/graph.json` as untrusted node-link evidence; `envelope_graphify_cli` optionally **invokes** a preinstalled and deliberately pinned Graphify Python CLI for read-only `query`, `path`, and `explain`. Both are separate from the native Envelope AST/CodeIndex. Neither silently promotes external graph edges to verified code facts.

## Install and enable (never automatic)

Install a Graphify CLI yourself (for example, with `uv tool install graphifyy`) and review/trust its executable before enabling it. Find its absolute path (including possible spaces). In an interactive Pi session run:

```text
/envelope graphify status
/envelope graphify binary /absolute/path/to/graphify
/envelope graphify on
/envelope graphify timeout 30000
/envelope graphify orientation on
```

`/envelope graphify binary none` clears the path. `/envelope graphify off` revokes the adapter and cancels active subprocesses. `/envelope graphify orientation off` removes the contextual prompt hint. The binary must exist, be executable, be outside the active project, and be explicitly pinned. Relative paths, inherited project-side binaries, default PATH discovery, automatic installation and upgrades are refused. No processes run automatically **unless** the user explicitly enables the session-scoped code-only watcher. `status` never launches the binary.

Agent-visible **read-only** tool examples:

```json
{"action":"status"}
{"action":"query","question":"what connects authentication to storage?","budget":1200,"depth":2}
{"action":"path","source":"Auth","target":"Storage"}
{"action":"explain","source":"Auth"}
```

`envelope_graphify_cli` has no build or update schema. Its use is blocked until `/envelope graphify on`, and code intelligence must also be enabled. The graph must already exist and have a valid schema. Known-stale artifacts are blocked unless `allowStale:true` is explicitly supplied; unverified/self-attested artifacts remain labeled as external assertions.

Only **direct user slash commands** request graph-writing operations:

```text
/envelope graphify build
/envelope graphify update
```

Build invokes a fixed `graphify extract . --code-only --no-cluster` argument vector. Graphify itself creates `graphify-out/` in the working project; adding `--out graphify-out` would incorrectly nest that directory and is forbidden by the adapter. Update invokes `graphify update . --no-cluster`. Both run from the current canonical project root, without a shell. `GRAPHIFY_BACKEND=none` is forced, provider API credentials and arbitrary environment keys are not forwarded, and Graphify query logging is disabled. As a consequence, *docs, images, and other semantic/LLM content are not imported by this bridge*. Use a separately reviewed/manual upstream Graphify workflow for that. File changes trigger no external execution by default; the separately enabled session watcher can run **code-only incremental updates**. See [watcher controls](GRAPHIFY_WATCH.md).

## Budgets, safety and lifecycle

- Graphify CLI operations are subject to a 16 KiB stdout ceiling; stderr is never returned in agent/user errors, and nonzero exits, process signals, timeouts, and output truncation are **errors**, never partial-success answers.
- Fixed subcommands and validated strings eliminate shell interpolation or user-supplied arbitrary CLI flags. Questions are capped at 240 characters; graph path and node values are bounded. Query token budget: 200–3000, depth: 1–5; configured timeout: 50–120000 ms.
- The executable's resolved path cannot lie inside the project; the program is explicitly trusted by the operator and **is not OS-sandboxed**. It may have all of the host user's filesystem and network access, independently of the environment keys Envelope omits. Review it before pinning it.
- Prompts are never enriched by default. Optional orientation is short, idempotent and derived from artifact status, not raw node bodies. It uses the original `before_agent_start` handler (not a new one), respects `needs_update`, and removes stale hints when disabled.
- Cancellation, `/envelope graphify off`, `/envelope code off`, changing the pinned executable, and Pi session shutdown terminate active subprocesses. An optional, explicit `/envelope graphify watch on [250..10000 ms]` enables a bounded session-only code watcher; `watch off` stops and awaits cancellation. No persistent daemon or model-extraction watcher is created.
- `graphHash` and source manifest matching provide local byte-consistency information, not origin/authenticity proof. A successful CLI exit does not prove semantic completeness or perfect indexing.
- Local observability stores outcome, known action and duration only. It does **not** store raw queries, graph responses, provider keys, or claimed token savings.

## Verification

Focused regression tests are in `tests/graphify-cli-bridge.test.mjs`: default-off status, pinned executable and environment isolation, fixed arguments, query/path/explain, stale/missing artifacts, exact write ownership, malformed input, oversized/nonzero output, timeout/cancellation/session cleanup, Pi tool/command registration, metrics validation and idempotent orientation.

```bash
node --test tests/graphify-cli-bridge.test.mjs
npm run check
npm run benchmark
npm run doctor:bundle
npm run pack:check
```

The focused integration tests use a controlled **fake executable** to verify the subprocess contract. The release workflow separately installs pinned `graphifyy==0.9.100` in a disposable Python virtual environment and runs `scripts/smoke-graphify-real.mjs` to validate code-only build, graph artifacts, query, path, explain and update. Only a **successful linked hosted CI run** establishes real runtime compatibility; a failing or skipped smoke must block release. Upstream syntax was inspected at pinned Graphify-Labs/graphify `6c8002eca4acad58db6160eabcb466e61fc35afb`, especially `graphify/cli.py` `query`, `path`, `explain`, `extract` and `update` command handlers. A Graphify update that changes these contracts requires new compatibility tests.

## Upstream adoption scope

This adds the optional read-only/runtime command layer described by `gaodes/pi-graphify`, `juhas96/graphify-pi`, `m4t0t0/cmd-mod-graphify`, `QuantumKuba/dsh-graphify-plugin` and the capability-routing/opt-in control ideas in `franklywatson/claude-rig`. It is **not** the original Pi/DSH/CommandCode host extension and does not include Graphify.NET SDK, OpenGraphify's GraphQL server, formal analysis from AxiomCode, new vector/embedding providers, Claude session capture, unrestricted upstream chokidar parity, or full parity with any of the 16 upstream projects. The source-by-source gap matrix remains in `docs/GRAPH_SOURCE_AUDIT.md`.

## Optional session-only code watcher

For explicitly authorized incremental AST updates, run `/envelope graphify watch on 1200`; inspect `/envelope graphify watch status`, and revoke it with `/envelope graphify watch off`. Only supported code suffixes trigger local `GRAPHIFY_BACKEND=none` updates. Documents, images, unfamiliar file types, new source directories and watcher errors require manual review/rebuild instead. Failed updates halt further automatic retries; manual build/update awaits watcher cancellation and CLI graph writes cannot overlap. The agent's read-only tool cannot enable this watcher. Full constraints and caveats are in [Graphify watcher](GRAPHIFY_WATCH.md).


**Graph output preflight:** Human and explicitly consented watcher writes fail before launching Graphify when `graphify-out` is a symlink/non-directory or known graph output files are symlinks/non-files. These checks are defense in depth against a changed project tree, not OS isolation for the pinned executable.


**CLI concurrency:** A project-scoped reader/writer coordinator prevents a graph write from overtaking an in-flight CLI query. A queued writer blocks new reads and awaits current readers, preserving this bridge's status hash/read pairing. Other processes remain outside the in-process guard. Cancellation attempts to terminate the full subprocess group on POSIX and process tree on Windows, but a trusted executable can escape the group; this is not a sandbox.
