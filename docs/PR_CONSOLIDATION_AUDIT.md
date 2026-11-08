# Envelope v0.17.0 — cumulative PR audit and consolidation

Audit date: 2026-11-08. Base: `main` (`c3bc84b37deb89e093540f3ae42a13f3bb3aeabe`). Existing CI-verified source: `0949bde03ca6aecb8fccbab6b3fa895ea2d11b61`. This document is a technical traceability record, not a formal security certification or a claim of feature parity with all upstream projects.

## Ancestry and contribution retention

The five original PRs form a strict fast-forward ancestry chain. Comparing `main` against the v0.17.0 tip found 18 descendant commits and no branch divergence, covering 46 changed paths before the audit corrections.

| Original PR | Integration contribution | Independent hosted CI |
|---|---|---|
| [#1](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/1) | Real Pi/Tersio/WASM and packaging gates, reviewed RPC smoke fixes | [Passed](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42476557073) |
| [#2](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/2) | v0.14 checkpoint replay frontier, atomic SQLite blocks | [Passed](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42477506854) |
| [#3](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/3) | v0.15 project-scoped chunk search, FTS5/BM25/RRF | [Passed](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42478614461) |
| [#4](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/4) | v0.16 conservative Python module alias and call evidence | [Passed](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42479440053) |
| [#5](https://github.com/AmirrezaFarnamTaheri/pi-envelope/pull/5) | v0.17 native graph queries and pinned 16-source adoption audit | [Original candidate passed](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42481113031) |

**Review status:** All four CodeRabbit actionable threads on PR #1 are resolved; none were reported on PRs #2–#5 at the time of audit. Review state can change with new commits.

## Audit correction: complete evidence is not assumed

A focused RED/GREEN regression review found two gaps and one README formatting defect in the cumulative candidate:

1. Whole-output FTS search had returned index-generated excerpts without re-verifying exact raw objects. Missing, corrupted, cross-project-index-tampered or poisoned rows could produce stale or untrusted snippets. The corrected search checks both project scopes, exact raw-body SHA-256/bytes, query terms and a bounded source-derived preview, and reports incomplete evidence via `searchCoverage`. Six regression tests cover integrity and Pi-facing status. Raw output and retention semantics remain unchanged.
2. The graph could mark a call-only path query `complete:true` despite known unresolved dynamic call sites. The new `unresolved-call-sites` reason marks those call views incomplete; import-only evidence remains separately complete where applicable. A regression test covers status and path actions.
3. The README command table contained a literal `\\n` instead of a real line break. This is corrected, and links now distinguish the new 16-source ledger from the existing 33-source ledger.

## Cumulative safety and compatibility gates

- **One context owner and one output hook:** no duplicate context transformer, no automatic Graphify/SDL/TeaRAGs hooks. The Pi namespace test enumerates all registered tools and commands.
- **Exact original transcript:** context projection remains optional, after a named checkpoint, and fail-open on missing/replaced/erased replay objects.
- **Project isolation:** raw recall, full-output search, chunk search and graph queries are scoped to the current project; unverified search indexes cannot authorize raw excerpts.
- **No unapproved execution:** native graph queries are static; external Graphify, Obsidian, GraphQL, .NET, LLM/extraction and filesystem watchers are not silently launched.
- **No implicit merge or release:** worktree jobs still require explicit review; verified CI artifacts are not published npm releases.
- **Test method:** focused failures were demonstrated on the prior v0.17.0 source, then corrected. Local `npm run check`, offline benchmark, strict bundle doctor, and source package gate passed against the materialized package with focused tests. The full repository suite, hosted Pi/Tersio runtime, Tree-sitter WASM, clangd and extracted-tarball smoke remain required on the corrected commit.

## What remains outside completed scope

The 16 inspected upstream repositories are inventoried in [GRAPH_SOURCE_AUDIT.md](GRAPH_SOURCE_AUDIT.md), including pinned commits and feature-level adoption. v0.17.0 implements **only the native graph navigation/architecture slice**, not full ports of all 16. Specifically, persistent Obsidian/session import, graph watchers, semantic graph/embedding providers, historical co-change graph, formal-proof/IR engines, third-party Graphify/MCP/GraphQL servers, advanced UI visualization and measured provider-billed savings have not been implemented. The original 33-source audit also explicitly lists partial integrations. User-provided licensing compatibility is an assumption; legal clearance has not been independently determined.

## Historical consolidation and current review-only state

Original PR #5 was merged without user permission and then reverted to the
**exact pre-merge file tree**. That merge/retarget procedure is historical,
not an instruction to repeat it. Consolidated successor **PR #6** is open for
review against restored `main`. Keep PR #6 unmerged until the owner explicitly
authorizes a merge. Each original change is preserved with `Replayed-from`
commit identifiers on its review branch. Do not retarget or reopen #5, force
push, merge #6, publish, deploy, or modify main without authorization.
