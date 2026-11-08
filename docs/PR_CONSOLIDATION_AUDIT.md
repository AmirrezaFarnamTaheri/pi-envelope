# Envelope v0.17.0 — cumulative PR audit and consolidation

**Audit date:** 2026-11-08. **Baseline:** `main` at `c3bc84b37deb89e093540f3ae42a13f3bb3aeabe`. **Previous CI-verified candidate:** `0949bde03ca6aecb8fccbab6b3fa895ea2d11b61`. This records engineering evidence, not a formal security certification or a claim of upstream feature parity.

## Contribution chain (all original commits retained)

Before the final corrections, GitHub compared the v0.17.0 branch against `main` as **18 commits ahead, 0 behind**, with 46 modified paths. Every original PR is a strict ancestor of the v0.17.0 head.

| Original PR | Scope | Independently passing hosted CI |
|---|---|---|
| [#1](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/1) | Real Pi/Tersio/WASM/packaging CI; RPC diagnostics; CodeRabbit remediation | [Run 42476557073](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42476557073) |
| [#2](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/2) | v0.14 SQLite checkpoint/replay frontier | [Run 42477506854](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42477506854) |
| [#3](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/3) | v0.15 verified FTS5 chunk retrieval and RRF | [Run 42478614461](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42478614461) |
| [#4](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/4) | v0.16 conservative Python module-alias call evidence | [Run 42479440053](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42479440053) |
| [#5](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/5) | v0.17 native source-evidence graph and pinned 16-upstream audit | [Run 42481113031](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42481113031) |

All four CodeRabbit actionable threads on #1 were resolved. No new review threads were available on #2–#5 when audited. GitHub CI on the original #5 tip reported **297 tests: 296 passed, 0 failed, 1 skipped**, plus required real-runtime gates.

## Additional RED/GREEN review corrections

1. **Unverified whole-output search:** unlike the already verified chunk search, the old `envelope_search_output` returned FTS-generated excerpts without opening the corresponding original object. Regressions proved stale deletion, corruption, tampered FTS project fields and poisoned preview risks. Its query now requires both FTS and metadata project scopes, exact raw-body verification, matching terms and a source-derived bounded preview; `details.searchCoverage` marks incomplete results. Six focused tests cover the correction.
2. **False certainty in call graphs:** known unresolved dynamic calls could coexist with `complete:true` in call-only graph status/path queries. Such queries now report `unresolved-call-sites` and `complete:false`; import-only views remain separate. One focused regression test covers the change.
3. **README formatting and links:** corrected a literal `\n` in the command table; linked the independent 16-source ledger and packaged release status correctly.

## Safety and verification constraints

- One output hook and one context transformer; no competing RTK owner, daemon, automatic model extraction, source-code execution, or unapproved child execution.
- Replay is checkpoint-bound, exact-original verified and fail-open. Graph import/call evidence is syntactic and bounded; unknown runtime edges remain unknown.
- Whole-output and chunk searches use local indexes to identify candidates; only verified content-addressed originals can authorize excerpts. Partial results do not prove absence.
- The user provided a licensing-compatibility assumption, not independent legal clearance. No competing third-party engines were silently installed or copied.
- Local focused RED/GREEN tests, syntax verification, offline benchmark, strict bundle doctor and package dry-run passed. **The corrected combined commit must pass hosted full regression and real Pi/Tersio/WASM/clangd/package checks before treating it as ready to merge.**

## Remaining functionality explicitly not claimed

The [16-source graph audit](GRAPH_SOURCE_AUDIT.md) identifies still-unimplemented Obsidian/chat import, watcher, vector/semantic backends, historical co-change and ownership analysis, formal proof/IR, external Graphify/.NET/MCP/GraphQL integrations, advanced visualizers and provider-billed cost/quality evaluation. The original 33-source audit also tracks partial features. Treat v0.17.0 as an integrated, reviewed subset — **not** complete parity with 49 heterogeneous upstream repositories.

## Consolidation invariant

Retarget the cumulative #5 branch to `main` only after verifying linear Git ancestry, then close redundant #1–#4 as **superseded**, preserving their branches and every commit. Do not force-push, delete branch history, merge into `main`, publish an npm release, or deploy unless separately requested.
