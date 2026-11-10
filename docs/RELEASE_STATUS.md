# Envelope — release status and verification gates

This document is the current, user-facing release assessment. It replaces the historic execution plans and avoids retaining obsolete command and package examples.

## v0.22.1 patch release candidate: compiled-Pi Node worker interoperability

- Namespaced `pi-envelope` package, `envelope` command and `envelope_*` tools, `extensions/envelope` and `skills/envelope`. No `upper` command or extension is shipped.
- Default-safe bash output compactor with exact recall, byte checks, durable FTS5 chunk search and bounded lexical/BM25 reciprocal-rank fusion, and optional retention/erasure, all project scoped. Raw output can contain secrets and no filesystem erasure claim covers backups/snapshots.
- Manual checkpoints, reversible context projections and versioned, transactional replay blocks, conservative JS/TS/Python/Go code intelligence, optional Tree-sitter and LSP tools, preview-first rename.
- Fingerprint-reviewed detached Git worktree child runner (opt-in); `isolated:false` rejected; git worktrees are not OS sandboxes.
- Project-scoped numeric observability, offline benchmarks and commit-pinned static impact reports.
- Default-off managed background command jobs with durable capped logs, status, cancellation, and an independently authorized read-only background agent session. Inline Pi remains the default. See [Managed jobs](MANAGED_JOBS.md) for permissions and limitations.

## Required before distributing as a bundled Pi release

1. On a machine with npm access, run `npm install --include=optional`. Inspect `npm ls` and licensing of the pinned Tersio and optional WASM packages.
2. Run `npm run doctor:bundle` and `npm run pack:check`; the latter now deliberately requires the doctor first.
3. Run `npm run smoke:runtime` against the actual installed Pi/Tersio package. Confirm Tersio command registration and native tools, with zero duplicated commands and hooks.
4. Run `npm run smoke:tree` with real WASM grammars, and `npm run smoke:lsp-real` with clangd or a configured trusted LSP.
5. Measure model coding outcomes and actual provider usage separately from synthetic byte reductions.

## Missing/partial extraction work

No full parity is claimed across the 33 source repositories. Among the unimplemented or partially implemented features: multi-generation ACP context hierarchies and model-generated summaries (the checkpoint-linked v1 replay ledger is not full ACP); mature call-resolution with Python MRO, cross-language types and ambiguity proofs; semantic embeddings; persistent multi-agent message relay; automatic task milestones and approval loop; full streaming RTK sanitizer; optional Memex/OpenRig adapters; and OS sandboxing for children. The decision for each upstream source is documented in `integrations/extraction-audit.json`.

**Do not conflate** a passing local regression suite, a source-only npm pack, or an injected mock parser with a successful live production installation.

## Context replay gate

The v0.14.0 candidate adds a hash-only, checkpoint-scoped SQLite frontier with atomic batch commits. An archived block is replayed only when source bytes, tool-call fingerprint and stored SHA-256 output agree. A missing or explicitly erased object is not recreated by context projection; the Pi transcript is shown instead. Failures to commit a batch leave outgoing context unchanged. See `docs/CONTEXT_COORDINATOR.md` and `tests/context-frontier.test.mjs`.

The original v0.17.0 graph candidate passed [hosted CI](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42481113031) with real Pi/Tersio/WASM/clangd gates; integrity corrections and consolidation require a new hosted run before merge.

## v0.15.0 chunk retrieval gate

The prior whole-document 25-output prefilter could miss the most relevant section. v0.15.0 adds persistent, bounded local chunk FTS5, verified exact-object search, lexical/BM25 reciprocal rank fusion and batch migration of legacy captures. The existing `envelope_search_fragments` text response remains an array; its Pi result details include index coverage and explicit partial status when a backfill or candidate limit is incomplete. The raw objects are still the source of truth. See `docs/CHUNK_RETRIEVAL.md` and `tests/output-chunk-index.test.mjs`. This is not embedding/vector retrieval or an execution sandbox.

## v0.16.0 Python call evidence gate

This candidate extends the existing optional Python stdlib `ast` call scanner and shared CodeIndex, without a new Pi hook or graph database. It links uniquely indexed module-alias member calls, tracks top-level assignment/rebinding and package initializer collisions, and fails closed on duplicate/ambiguous declaration and import candidates. The parser contract validates and caps new initializer binding metadata. Regression tests include namespace aliases, relative imports, dynamic nested attributes, shadowing, source edits, project isolation, absence of code execution and bounded parser facts. These are syntactic links, not Python import-runtime, class receiver, or type-checked proof. See `docs/CALL_EVIDENCE.md` and `tests/python-module-calls.test.mjs`.

## v0.17.0 native graph integration gate

The user-supplied 16-source Graphify/CodeGraph/SDL/TeaRAGs cohort is pinned and decomposed in `docs/GRAPH_SOURCE_AUDIT.md` and `integrations/graph-source-audit.json`. This candidate implements deterministic read-only static import/call graph queries (status, shortest paths, neighbors, incoming-degree hubs, weak components, advisory boundaries and bounded JSON/Mermaid) through **one additional tool** and the existing CodeIndex. No new session/context hook, daemon, model call or generated file. Regression tests cover direction, budgets, provenance, project root and symlink refusal, no project-code execution and Pi tool registration; see `tests/graph-intelligence.test.mjs` and `docs/GRAPH_NATIVE.md`. Additional source features are phased candidates, not full port or token-savings claims.

## v0.18.0 Graphify artifact interoperability gate

The v0.18.0 candidate adds `envelope_code_external_graph` under the existing CodeIndex. It reads fixed project-local `graphify-out/graph.json` (including NetworkX root metadata, `nodes` and `links`) and optional self-declared `envelope-sources.json` SHA-256 source/graph manifest. Each returned edge retains external provenance and upstream confidence, never joining native AST evidence. Missing, stale, invalid and partially attested input statuses are distinct; the `needs_update` marker blocks traversal until explicit acknowledgement. Query budgets and path-only status do not imply semantic completeness. The watcher is opt-in, bounded, invalidation-only and disposed on extension shutdown; no Graphify or model invocation is made. Tests: `tests/graphify-adapter.test.mjs` and `docs/GRAPHIFY_ARTIFACTS.md`. PR #6 and this PR remain unmerged unless explicitly approved.

## v0.19.0 explicit project memory, co-change evidence and cards

Opt-in `envelope_memory` adds typed, project-scoped SQLite notes with manual Markdown and Claude Code JSONL import, source-hash freshness, explicit deletion and no automatic capture or vault write. `envelope_code_history` adds bounded, read-only non-merge Git co-change/churn, not causal/ownership proof. `envelope_code_context_card` composes bounded source-hash-verified AST symbol/import/call evidence; source excerpts are opt-in. New tests: `tests/project-memory.test.mjs`, `tests/code-history.test.mjs`, and `tests/context-card.test.mjs`. Full hosted regressions and real Pi/Tersio/WASM/clangd/packed-install gates must pass before publication or merge.

## v0.20.0 .NET Graphify interoperability, retrieval and architecture policy

The actual Graphify.NET exported JSON fields are now consumed in the local external graph reader, including `edges[].relationship` and nested source locations. Foreign absolute paths are redacted and cannot act as attestations. Local source retrieval combines AST symbol/path rankings, verifies source bytes before disclosure and reports candidate/verification gaps; no vector/embedding backend is implied. `envelope_code_policy` provides read-only advisory architecture checks and the manually invoked `architecture:gate` script with strict incomplete-evidence treatment, never an automatic failing CI step. Git co-change uses NUL-delimited filenames. The v0.19.0 predecessor passed hosted [run 42491266788](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42491266788) (361 pass, 0 fail, 1 skip); this v0.20.0 candidate requires its own complete hosted verification before release claims.

## v0.21.0 discovery and visual export

The new `envelope_capabilities` tool is a read-only capability status and advisory route planner. Optional `graphify`/`jcodemunch`/`rtk`/`headroom` PATH detections are presence-only, never executed. Native file graphs can export bounded static SVG and Obsidian Mermaid Markdown with security-focused escaping; declared external Graphify community IDs are queryable separately from native graph evidence. This phase does not automatically run tools, invoke models, install viewers, start servers, or write Obsidian files. Tests `tests/capability-cockpit.test.mjs`, `tests/graph-visualization.test.mjs`, and `tests/graphify-dotnet.test.mjs`. The prior v0.20.0 candidate passed hosted run 42492265689 (376 passed, 0 failed, 1 skipped); this candidate requires independent hosted CI.

## v0.22.0 Graphify CLI integration (unmerged review candidate)

An explicit, project-fenced `envelope_graphify_cli` read-only tool invokes a user-pinned Graphify Python binary for bounded query/path/explain only after `/envelope graphify on`. `status` never launches any process. Human slash commands provide code-only, no-cluster build/update with forced `GRAPHIFY_BACKEND=none` and stripped API keys. A single existing prompt hook can opt in to concise artifact-state orientation; a persistent daemon, automatic model extraction and arbitrary CLI flags are not implemented; a separate, explicitly enabled in-memory code-only watcher is available in PR #11. Active processes are cancelled on disable/shutdown, errors cannot masquerade as successful partial CLI output, and local metrics store only action/outcome/duration. See `docs/GRAPHIFY_CLI.md` and `tests/graphify-cli-bridge.test.mjs`. Fake-executable tests alone are not proof of real Graphify compatibility. Hosted CI now installs `graphifyy==0.9.100` in an isolated venv and runs a disposable AST code-only build/query/path/explain/update smoke; this gate and the full regressions/packaging must all pass before a real runtime claim.

## Static-import-aware historical co-change diagnostics (stacked review candidate)

One new read-only `envelope_code_coupling` tool composes existing bounded non-merge Git cochange history and current static import edges, verifies current source SHA-256, and lists file pairs that repeatedly change together without a detected direct import. No independent Git scanner, external provider, new Pi hook, risk/causal/ownership inference, or automatic CI enforcement. Output has exact-byte and history/candidate limits, and version-bound pagination. Real Git fixture tests cover cochange/no-import candidates, direct import handling, stale source, unsafe symlinks, cursor drift and missing history. See `docs/COCHANGE_REVIEW.md`; its own hosted gates must pass before release claims.

## Task-scoped static graph context slices (stacked review candidate)

A new read-only `envelope_code_slice` composes existing verified lexical retrieval, static import edges and hash-checked context cards. It selects deterministic bounded BFS file neighborhoods (at most 150 candidates, 0–3 hops), supports exact entry paths, direction, optional conditional ETag references, card/skeleton/ref escalation under a 900–16000-byte JSON limit, and a current-index version cursor preventing stale pages. It never registers hooks, runs project code, stores a persistent slice, calls a model, includes raw code excerpts or claims semantic graph quality. See `docs/CONTEXT_SLICE.md` and `tests/context-slice.test.mjs`. Independent hosted validation is required on its own stacked PR.

## SDL-inspired session-local source-verified symbol deltas (stacked review candidate)

A single `envelope_code_delta` Pi tool adds explicit `status|capture|compare|clear` in-memory baselines to the existing CodeIndex. It hashes actual JS/TS declaration text, re-verifies indexed source bytes, reports added/removed/modified symbols and static importers under a strict JSON byte budget, and uses comparison-version cursors. Python/Go body changes and duplicate declarations are marked uncertain; comments/import-only changes do not masquerade as confirmed unchanged source. No new scanner service, network/LLM provider, raw-source storage, extra Pi hooks or advertised token-savings multipliers. See `docs/SYMBOL_DELTA.md` and `tests/symbol-delta.test.mjs`; the latest stacked PR requires its own hosted release gates before any readiness claim.

## v0.22.0 consent-only Graphify code watcher (review-only PR #11)

A separate, explicit `/envelope graphify watch on [250..10000]` action can now debounce supported code-file changes into the already-pinned Graphify Python CLI's offline `update . --no-cluster` operation. It does not run before user consent, does not persist across Pi sessions, does not auto-extract documents/media with LLMs, and cannot be enabled through an agent tool. Watch count/error state is available through `/envelope graphify watch status` and read-only CLI status. Directory and event limits, symlink exclusions, failure-to-manual handoff, watcher error handlers, cancellation that waits for in-flight writes, graph-write locking and stderr redaction have dedicated regression tests. See `docs/GRAPHIFY_WATCH.md` and `tests/graphify-watch*.test.mjs`. Verification must include independent hosted regressions, real Pi packaging and a pinned Graphify runtime gate on the latest PR #11 head; earlier PR #9 success does not prove this watcher integration. Full parity with all 16 repositories remains open and tracked in issue #10.

## Explicit persistent file-graph metadata versions (stacked draft)

`envelope_code_versions` provides status/list/compare of user-authorized, project-scoped source-hash + static-import version snapshots; capture and prune are only available through `/envelope code versions ...` human commands. Deterministic version IDs, 0600 storage, symlink/root and stale-source fences, explicit retention and JSON output limits have regression coverage. This is a durable **file graph metadata** history, not a full multi-version cross-language symbol graph, semantic model or runtime proof. Latest-head hosted regression and package testing must pass before marking the draft verified. See `docs/PERSISTENT_GRAPH_VERSIONS.md`.

## Offline, source-verified user-supplied vector retrieval (stacked draft)

`envelope_code_vector` adds cosine/hybrid ranking against a strictly validated project-local manifest of precomputed numeric embeddings. Off by default; only `/envelope code vectors on` enables search. Source SHA-256 re-verification, symlink/root fences, bounded dimensions/rows/bytes, deterministic query-version continuations and omission of embedding vectors/source text are regression-tested. No automatic text-to-embedding model, semantic relevance benchmark or network provider is bundled. See `docs/LOCAL_VECTOR_RETRIEVAL.md`; full latest-head hosted CI must pass before review-readiness claims.

## Checkable static import graph invariants (stacked draft)

A new `envelope_code_invariant` read-only tool verifies bounded SHA-attested static **file import** predicates (acyclic, reach, no-path) and returns independently checkable cycle/topological/path/closure certificates. It fails closed on stale source, symlinks and invalid input; incomplete parser or index/budget coverage produces `unknown`, not ungrounded proof. No compiler-backed IR, program logic prover, generated model, external service, second graph scanner or extra Pi hooks. See `docs/STATIC_GRAPH_INVARIANTS.md` and dedicated tests. Hosted head CI must pass before review-readiness.

## Explicit Graphify.NET 10 AST-only CLI bridge (stacked draft)

`envelope_graphify_dotnet` is status-only; `/envelope graphify-dotnet binary|on|off|build` is a human-controlled external .NET engine. It uses a pinned executable outside the project, fixed `run . --format json --output .envelope/graphify-dotnet-out` arguments, an ephemeral allowlisted environment with `GRAPHIFY__Provider=None` and no inherited Graphify/Copilot/Azure credentials. Output is disjoint from Python Graphify, labeled unverified and bounded. Negative/fake process tests cover symlinks, malformed graphs, cancellation and no source/stderr disclosure. Hosted CI now installs .NET 10 and pinned Graphify.NET 0.7.0 for an AST-only real smoke on a disposable C# fixture. **Do not claim real compatibility until that specific run passes.** See `docs/GRAPHIFY_DOTNET_RUNTIME.md`.

## Read-only MCP stdio graph-version bridge (stacked draft)

A manually launched newline-delimited JSON-RPC MCP 2025-11-25 stdio process can list, snapshot and compare **explicitly captured** private static file-graph metadata, without source rescanning, network listeners, automatic model calls, mutation tools, or extra Pi hooks. Requests/responses and metadata are bounded; invalid snapshots and protocol handshakes fail closed. Real subprocess fixture tests in `tests/mcp-stdio-interop.test.mjs` check the contract. No authenticated remote HTTP MCP, OAuth, subscriptions, provider routing or GraphQL server is implied. See `docs/MCP_STDIO_BRIDGE.md`.

## Bounded TypeScript compiler facts (stacked draft)

`envelope_code_typecheck` uses the actual TypeScript 5.8.3 TypeChecker over bounded SHA-verified JS/TS source from the shared CodeIndex. It provides type errors, exact indexed declaration positions and aliases across modules; it does not run/emit project code, compile Python/Go/C#, resolve arbitrary npm packages or certify program correctness. Unresolved modules and coverage gaps are explicit. Seven TypeScript compiler tests cover real type resolution, mismatch diagnostics, staleness, unsafe paths and one native Pi tool. See `docs/TYPESCRIPT_COMPILER_EVIDENCE.md`; hosted CI must pass on this head before claiming review readiness.

## Authenticated read-only GraphQL local projection (stacked draft)

An operator-launched `scripts/envelope-graphql-local.mjs` uses optional reference GraphQL.js on `127.0.0.1`, requiring a strong bearer token. Its only queries list, inspect and diff previously captured private file-graph versions. Browser `Origin`, GET, mutation, introspection and excessive AST/query/request/output shapes fail closed. No public endpoint, source rescanning, model, automatic service startup, database migration or new Pi hook is added. Local HTTP/security tests and a separate real pinned GraphQL.js hosted smoke are required. This is **not** the full OpenGraphify NestJS/Apollo/Prisma application. See `docs/GRAPHQL_HISTORY_BRIDGE.md`.

## Offline Go go/types compiler evidence (stacked draft)

`envelope_code_go_types` now invokes the actual standard-library Go `go/types` checker on a bounded one-package set of SHA-verified indexed Go files. It reports type errors, exact local declaration/type facts and explicit gaps when imports are unavailable. It is opt-in via the existing languages setting, sends no provider requests, runs no project entrypoints, and rejects symlinks, stale source, oversized records and incomplete inputs. Seven local Go tests verify compiler facts, redaction, source integrity and Pi single-tool registration. This is **not** a full Go build, third-party dependency resolver, formal checker or common Go/Python/TS/C# typed graph. See `docs/GO_COMPILER_EVIDENCE.md` and the current PR's independent hosted workflow.

## Human-invoked local embedding encoder protocol (stacked draft)

A separate `LocalEmbeddingRuntime` accepts an operator-pinned executable outside the project to embed SHA-verified current indexed source excerpts on the explicit human `/envelope code vectors build` or `replace` command; `find <text>` separately requests a matching query vector and uses existing local vector retrieval. No automatic model download, agent-triggered process, provider credentials, second index, or Pi hook is added. Outputs are private, bounded, `0600`, atomically published and rechecked for source changes during encoding; invalid model/dimension, symlink, stale or oversized responses fail closed. Eight focused local tests, including Pi human-only authority and real subprocess behavior, passed; hosted exact-head regression and package gates remain mandatory. **The binary must be trusted and is not a network sandbox.** See `docs/LOCAL_EMBEDDING_RUNTIME.md`.
