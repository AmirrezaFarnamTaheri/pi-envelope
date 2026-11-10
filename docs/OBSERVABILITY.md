# Private observability and offline evaluation

Envelope provides local accounting for **Envelope-owned** operations. Tersio continues to own RTK command rewriting, its usage ledger, native timing widgets and dashboard. Envelope does not re-register those hooks, merge their databases, or claim to reproduce their accounting.

## Pi commands and tools

| Interface | What it returns |
| --- | --- |
| `/envelope metrics` | Project-only summary of stored byte deltas and provider-reported usage |
| `/envelope observability status` | Whether collection is enabled, and configured retention |
| `/envelope observability on` / `off` | Enable or suspend new event recording; neither erases existing rows |
| `envelope_metrics_snapshot({})` | Project-only JSON totals by kind and provider tokens/cost |
| `envelope_metrics_events({"limit":10})` | Latest 1–50 project-scoped event measurements, newest first |
| `npm run benchmark` | JSON result from a self-contained, synthetic, offline microbenchmark |

Settings are stored under `envelope.observability` in the existing Tersio settings file. Collection defaults **on**, with 30-day retention; `off` suppresses new events but keeps read-only queries available. The SQLite database `~/.tersio/envelope-metrics/envelope-metrics.sqlite` is a separate local file, owned by the user (`0600` on Unix), with a directory created at mode `0700`. It keeps at most **10,000 recent events** and expires entries older than 30 days. This file uses SQLite WAL: protect and dispose of its `-wal` and `-shm` siblings too. `ENVELOPE_HOME` and `TERSIO_HOME` affect this folder like the rest of Envelope.

There is **no network telemetry, exporter, tracing endpoint or hidden analytics service**. Project scopes are recorded only as SHA-256 hashes of project directory strings, not raw paths. Each metric row contains an allowlisted event kind and action, a bounded outcome, byte counts, processing duration, reported token counts and cost classification. **No prompts, output text, raw commands, source bodies, filenames or task instructions are written to the metrics database.** The separate exact-output store and workflow ledger still have their own retention and privacy properties described elsewhere.

If the metrics database fails to open or write, optimization and coding continue. Snapshot tools report unavailable instead of pretending collection succeeded. Observability does not control Tersio's own telemetry.

## Measurement boundaries

**Byte savings** are actual UTF-8 byte differences in the outgoing text. `output_compaction` includes the recall identifier marker in rendered bytes. `context_projection` measures individual pre-request historical tool-result projections, **not unique conversation bytes saved**, and multiple context projections of the same result may be counted more than once. These counters must not be added to claim billed token savings.

The `message_end` observer records only finalized **assistant** messages carrying `usage` from Pi. `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` are copied from the host's usage fields. Cost is split between `providerBilledUsd` when `usage.cost.totalFromProvider === true` and `catalogEstimatedUsd` otherwise. These numbers are consumption, **not savings**; attributing cost differences to one optimization requires a controlled on/off comparison with the same model, prompts, caching regime and workload. No token usage is invented when the host supplies none. Storing a non-billed price estimate is never described as a provider invoice.

`code_query` events record all 27 registered code and LSP intelligence tool names, outcomes and durations. `workflow_action` records predefined nine tool names, outcomes and durations. A tool's successful return is not evidence of code correctness: reviewed workflow completion still requires the explicit workflow evidence gate and, for isolated tasks, fresh fingerprint verification.

## Reproducible offline benchmark

Run `npm install` and `npm run benchmark` to display a report. For **machine-readable JSON on stdout without npm's command banner**, use `npm run benchmark --silent` or `node scripts/benchmark.mjs`; stderr may include Node's `node:sqlite` experimental warning. `node --test tests/benchmark.test.mjs` also verifies its stated invariants. The synthetic corpus `envelope-synthetic-v2` (v0.8.0) uses deterministic test, mixed anchored/test/diagnostic, build, Git, anchored-source and JSON fixtures. The mixed fixture reports `anchorsPreserved` and `diagnosticsPreserved` from the **actual model-visible transformed text**, while its exact raw input must remain recoverable. Each output case reports:

- `rawBytes`, `renderedBytes`, `bytesSaved` and `changed`, **including recall marker overhead**;
- `exactRecovery`, tested by retrieving the exact raw text from the local store;
- `estimatedTokenProxy` using `ceil(UTF-8 bytes / 4)` for both sides, prominently labelled **heuristic**;
- local transformation `median` and `p95` milliseconds from warm-up and 17 iterations (13 for context/code).

A context case checks non-destructive projection, tool-call/result pairing and exact recovery. The TypeScript AST case checks a real symbol match and static importer on two synthetic files, with parse-only verification (not a typechecker). A workflow case exercises the durable state sequence `pending → running → review → completed`, without spawning a worker.

The JSON sets `providerCalls: 0`, `actualBilledTokenSavings: null`, and `answerQualityMeasured: false`. There are **no** model inferences, real provider requests or real end-user coding outcomes. Timing is sensitive to machine, cache, SQLite and process state. Do not compare absolute latency or token proxies from different machines as if they were controlled model/tokenizer measurements.

## Future live-evaluation requirements

For genuine quality/cost claims, install a complete Pi + pinned Tersio package on a network-enabled machine. Run a reproducible cohort of real coding tasks with pinned model/version, provider, system prompt, tool set, seed where supported, cache mode, task files and success criteria. Execute randomized AB/BA on/off runs, measure provider usage/cost and wall-clock latency, run independent tests plus change-review assessment, and publish failures and confidence intervals. Never infer quality from shorter output alone. This evaluation harness has not been built into Envelope.
