# Envelope — release progress

**Current source candidate:** v0.16.0 (unmerged; prior validated release candidate v0.15.0). The initial v0.1–v0.12 development plans and duplicate upstream ledger were interim planning artifacts; they are removed from the deliverable. The 33 pinned source references live only in `integrations/extraction-audit.json` and `docs/ALL_33_SOURCE_AUDIT.md`.

## Integrated

- Single Pi package with Tersio manifest entrypoints and one native `extensions/envelope` extension.
- Conservative exact-recoverable output compression, anchored-line preservation, incrementally indexed, bounded chunk FTS5/BM25 and lexical-RRF retrieval, project-scoped capture erasure and optional 0–365 day retention.
- Opt-in reversible context pruning using session checkpoints; v0.14 adds versioned, checkpoint-scoped SQLite replay blocks, atomic batch commits, verified restart reuse and fail-open handling of erased/corrupt originals; no second context owner.
- v0.16 extends conservative opt-in Python call evidence to uniquely indexed module aliases, with explicit shadowed/ambiguous handling and no runtime/type claims.
- Shared AST lookup/impact/call evidence (JS/TS, opt-in Python and Go), syntax preflight, optional Tree-sitter query adapter, LSP diagnostics and opt-in hash-bound rename.
- Commit-pinned clean-checkout change impact; worktree-only child workflow with fingerprinted review and no shared-tree escape hatch.
- Private numeric metrics, offline benchmark, extensive Node regression tests and real local clangd smoke when installed.
- Full public namespace `envelope`; stale migration files and duplicate source ledger removed.

## Independent release gates

- `npm run check` — complete source syntax and unit/integration regressions.
- `npm run benchmark` — offline deterministic fixtures only, not billed-token or agent quality measurements.
- `npm run pack:source-check` — source npm dry run only.
- `npm run doctor:bundle` and `npm run pack:check` — must pass on a machine with the pinned Tersio and TypeScript modules actually installed.
- `npm run smoke:runtime` and `npm run smoke:tree` — require external Pi/Tersio and WASM assets respectively.
- `npm run smoke:lsp-real` — actual installed clangd with temporary C fixtures.

## Explicitly incomplete

Hosted v0.15.0 real Pi/Tersio/WASM/clangd gates passed on [run 42478614461](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42478614461). The new v0.16.0 candidate requires its own hosted checks before any release claim. The other partial integration items, rejected duplicates and external adapters remain recorded in the 33-source audit. No live provider-billed savings or complete 33-repository parity is claimed.
