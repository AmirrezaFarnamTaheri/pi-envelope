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

`/envelope graphify binary none` clears the path. `/envelope graphify off` revokes the adapter and cancels active subprocesses. `/envelope graphify orientation off` removes the contextual prompt hint. The binary must exist, be executable, be outside the active project, and be explicitly pinned. Relative paths, inherited project-side binaries, default PATH discovery, automatic installation, upgrades, and background launches are refused. `status` never launches the binary.

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

Build invokes a fixed `graphify extract . --code-only --no-cluster --out graphify-out` argument vector. Update invokes `graphify update . --no-cluster`. Both run from the current canonical project root, without a shell. `GRAPHIFY_BACKEND=none` is forced, provider API credentials and arbitrary environment keys are not forwarded, and Graphify query logging is disabled. As a consequence, *docs, images, and other semantic/LLM content are not imported by this bridge*. Use a separately reviewed/manual upstream Graphify workflow for that. The adapter never runs Graphify for you just because a file changes.

## Budgets, safety and lifecycle

- Read-only Graphify CLI operations are subject to a 16 KiB stdout ceiling; stderr is capped and nonzero exits, process signals, timeouts, and output truncation are **errors**, never partial-success answers.
- Fixed subcommands and validated strings eliminate shell interpolation or user-supplied arbitrary CLI flags. Questions are capped at 240 characters; graph path and node values are bounded. Query token budget: 200–3000, depth: 1–5; configured timeout: 50–120000 ms.
- The executable's resolved path cannot lie inside the project; the program is explicitly trusted by the operator and **is not OS-sandboxed**. It may have all of the host user's filesystem and network access, independently of the environment keys Envelope omits. Review it before pinning it.
- Prompts are never enriched by default. Optional orientation is short, idempotent and derived from artifact status, not raw node bodies. It uses the original `before_agent_start` handler (not a new one), respects `needs_update`, and removes stale hints when disabled.
- Cancellation, `/envelope graphify off`, `/envelope code off`, and Pi session shutdown terminate active CLI subprocesses. No scheduled watcher or self-running daemon is created.
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

This adds the optional read-only/runtime command layer described by `gaodes/pi-graphify`, `juhas96/graphify-pi`, `m4t0t0/cmd-mod-graphify`, `QuantumKuba/dsh-graphify-plugin` and the capability-routing/opt-in control ideas in `franklywatson/claude-rig`. It is **not** the original Pi/DSH/CommandCode host extension and does not include Graphify.NET SDK, OpenGraphify's GraphQL server, formal analysis from AxiomCode, new vector/embedding providers, Claude session capture, auto-running chokidar rebuilds, or full parity with any of the 16 upstream projects. The source-by-source gap matrix remains in `docs/GRAPH_SOURCE_AUDIT.md`.
