# Envelope — release progress

**Current source release:** v0.13.0. The initial v0.1–v0.12 development plans and duplicate upstream ledger were interim planning artifacts; they are removed from the deliverable. The 33 pinned source references live only in `integrations/extraction-audit.json` and `docs/ALL_33_SOURCE_AUDIT.md`.

## Integrated

- Single Pi package with Tersio manifest entrypoints and one native `extensions/envelope` extension.
- Conservative exact-recoverable output compression, anchored-line preservation, bounded fragment search, project-scoped capture erasure and optional 0–365 day retention.
- Opt-in reversible context pruning using session checkpoints; no second context owner.
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

The source alone does **not** prove an installable fully bundled release: Pi, Tersio, npm registry and WASM runtime are unavailable here. The other partial integration items, rejected duplicates and external adapters remain recorded in the 33-source audit. No live provider-billed savings or complete 33-repository parity is claimed.
