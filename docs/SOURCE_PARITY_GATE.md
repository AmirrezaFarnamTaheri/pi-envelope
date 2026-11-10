# Sixteen-source integration coverage and remaining acceptance

Audit updated 2026-11-10. This is a current-head follow-up to [the original 16-source audit](GRAPH_SOURCE_AUDIT.md) and the machine-readable ledgers in `integrations/graph-source-audit.json` and `integrations/upstream-source-evidence.json`. All supplied original names are preserved. `Ancienttwo/repo-harness` now redirects to `aimpact-inc/repo-harness`; the new owner and commit are recorded separately.

**Interpretation:** "adapted" means some capabilities operate inside Envelope; it does not mean the upstream application's full feature set was copied. No row is fully ported. User-supplied licensing compatibility is taken as an assumption for this development exercise; formal clearance is deferred to the repository owner.

| Source, pinned default branch | Existing Envelope evidence | Distinct acceptance still required |
|---|---|---|
| [claude-code-memory-setup](https://github.com/lucasrosati/claude-code-memory-setup/tree/4cd2e6bd4319fcb2e8d24c2407a864516e7c133a) | `project-memory.mjs`: explicit project notes and Claude JSONL import | Consented automatic session capture, Obsidian vault round-trip conflict tests and privacy review; no 71.5x token-savings claim |
| [graphify-dotnet](https://github.com/elbruno/graphify-dotnet/tree/008477767c813f0cc48dda3644282330cc288c8b) | `graphify-adapter.mjs`, `graphify-dotnet-runtime.mjs`: .NET graph JSON and optional pinned CLI | Complete Copilot SDK/LLM pipeline, real .NET 10 platform matrix, authenticated provider custody, incremental pipeline and full graph result parity |
| [graphify-pi](https://github.com/juhas96/graphify-pi/tree/dd54ac9ae22bc48195fafd5b25ffe0c7ef09c4a9) | `graphify-cli.mjs`, graph-first orientation | Complete wiki-first instructions, status UI and CLI/skill parity with every upstream subcommand; must not duplicate Pi's command owner |
| [claude-rig](https://github.com/franklywatson/claude-rig/tree/54b4a5c79ebea0d81c576c449d1828c349f3e453) | `capability-cockpit.mjs`: read-only capability detection and manual routes | Proven enforced skill chains, dependency install/version checks and tool routing without bypassing user consent; do not copy Claude-specific hooks into Pi |
| [pi-graphify](https://github.com/gaodes/pi-graphify/tree/4826f5eb351b72f49f44dc5ede24f3a886552b2d) | Native graph tools, opt-in local Graphify CLI, watcher | Full code/docs/media graph pipelines, upstream CLI flags, wiki output and provenance consistency tests |
| [dsh-graphify-plugin](https://github.com/QuantumKuba/dsh-graphify-plugin/tree/74a2c72b31abef95adf7afa53ec45d7dcb0ba47e) | Root-scoped external graph reader, explicit status and Graphify CLI adapter | DSH-specific host/web hook parity would require a separate DSH adapter; no duplicate Pi-core hooks; MCP lifecycle compatibility gate |
| [OpenGraphify](https://github.com/nainglinnphyo/OpenGraphify/tree/4732f159ffc74b7121fe671bd6dbeeffdfd51964) | Optional read-only local GraphQL metadata bridge | Original NestJS/Prisma/Apollo app is a distinct product, **not a code graph engine**; separate install, schema/auth testing and network exposure review required for full application parity |
| [graphify-chokidar](https://github.com/yetanotheraryan/graphify-chokidar/tree/9c584df9ab087425fec3d030e3ef7d1a29431707) | Session-only, consented Graphify code watcher and debounce | Cross-platform native filesystem-watch tests, overflow recovery, restart policies and explicit doc/media LLM rebuild confirmation |
| [graphify-visualizer](https://github.com/crafter-station/graphify-visualizer/tree/15c67d7e5a3c717a3917f6af410e09bc0d9142ed) | Static, escaped SVG and Obsidian Mermaid export | Native Obsidian vault catalog/UI/HTML viewer remains external; separate plugin testing and untrusted HTML isolation required |
| [cmd-mod-graphify](https://github.com/m4t0t0/cmd-mod-graphify/tree/474ecaecbf181832572af9934dba99d1dddbf06b) | Graphify CLI query/path/analysis, hub ranking | CommandCode-specific host integration, command aliases, interactive renderer and CLI version matrix remain external |
| [codegraph](https://github.com/colbymchenry/codegraph/tree/f72c9d2efb14454ff4f9fd7b8460abd82f19a287) | Shared AST graph, static impact, versions, bounded change context | Rust pre-indexed multi-agent engine, framework-aware routing, full language matrix and file-watch sync: optional verified sidecar, not a second core index |
| [axiomcodegraph](https://github.com/AxiomCodeAI/axiomcodegraph/tree/45ee8b1b9d422409e93caed9a123d9c7b7998a8e) | Source-attested static graph invariants and real TS/Go compiler evidence | Cross-language formal IR, flow-sensitive analysis, proof obligations and measured coding-correctness results; no generic correctness proof claimed |
| [sdl-mcp](https://github.com/GlitterKill/sdl-mcp/tree/2a20acbd283a5edf8290fb217eee0ecff86b31f5) | Symbol deltas, context cards/slices, persistent file-graph metadata, optional vector retrieval | Persistent symbol-graph leases/versions, precise provider/SCIP facts, semantic graph walks and full MCP operations still separate |
| [repo-harness (transferred)](https://github.com/aimpact-inc/repo-harness/tree/c2bfe28bf495b1c2366148c4826b967c5ba04db6) | Envelope workflow ledger, review evidence, pinned worktree handoff, managed jobs candidate | GitHub issue-to-PR authority, capability contracts, long-lived handoffs across machines, verified checks/rollback gates and Bun host scripts remain external |
| [ops-codegraph-tool](https://github.com/optave/ops-codegraph-tool/tree/427c96f6da08fed88559075ef3c3c9eaa2122319) | Static impact, Git coupling, architecture rules and optional CI gate | Rust CFG/dataflow, broad typed language graph, external 34-tool MCP surface, CODEOWNERS and production retrieval benchmarks |
| [TeaRAGs-MCP](https://github.com/artk0de/TeaRAGs-MCP/tree/c921c47d76c7178ccd0f07d26538fca82bf8e259) | Verified retrieval, local opt-in embeddings, calls, history/coupling | Real embedding quality benchmarks, reuse/trajectory analysis, ownership/risk audits, language/provider production matrix and hybrid retrieval parity |

## Architecture constraints

1. **One code index and one output/context hook owner.** Reuse the existing CodeIndex and Tersio ownership. Optional engines must be sidecars or separately activated adapters with explicit source provenance.
2. **No agent hierarchy by default.** Inline single-agent work remains primary. Jobs and background sessions require their own explicit switches. Workflow DAGs are a separate optional feature.
3. **No silent execution or network access.** External engines, hosted services, Graphify LLM analysis, imports and vault writes require operator configuration and approval. An artifact is not a trusted compiler fact unless its source/freshness are attested.
4. **Proof boundary.** A code graph is not a semantic correctness proof; build success is not a reviewed task; raw byte reduction is not a measured token saving.
5. **Source identity.** The three pins refreshed on 2026-11-10 (AxiomCodeGraph, TeaRAGs-MCP and transferred repo-harness) were checked against their documented source paths. The remaining 13 have retained their prior inspected pins. Later upstream changes require another audit before claiming parity.

## Completion gates

- Native Envelope regression: `npm run check`, `npm run doctor:bundle`, `npm run pack:check`, real Pi/Tersio RPC and explicit grammar/LSP/Graphify smoke tests.
- Cross-repository gate: build `AmirrezaFarnamTaheri/pi` from a recorded commit, run Envelope tests and probe the real fork Pi RPC (not a fake).
- Managed jobs: persistent supervisor after launcher exit, bounded log and exit status, cancellation, process-group caveats, Windows/macOS/Linux regression; no implicit agent hierarchy.
- Provider-backed accuracy: operator-approved measured coding-task benchmark with fixed corpus, consistent model/budgets, test outcome verification and explicit failures.
- Full parity for any individual source: a source-specific test matrix, dependency/license review, external CLI or runtime contract and reproducible release artifact. **No source currently meets that last gate.**

Keep [tracking issue #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10) open until the substantive missing engines and acceptance evidence are delivered or explicitly rescoped by the maintainer.
