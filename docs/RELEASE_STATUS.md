# Envelope — release status and verification gates

This document is the current, user-facing release assessment. It replaces the historic execution plans and avoids retaining obsolete command and package examples.

## v0.14.0 candidate: implemented locally

- Namespaced `pi-envelope` package, `envelope` command and `envelope_*` tools, `extensions/envelope` and `skills/envelope`. No `upper` command or extension is shipped.
- Default-safe bash output compactor with exact recall, byte checks, bounded section search and optional retention/erasure, all project scoped. Raw output can contain secrets and no filesystem erasure claim covers backups/snapshots.
- Manual checkpoints, reversible context projections and versioned, transactional replay blocks, conservative JS/TS/Python/Go code intelligence, optional Tree-sitter and LSP tools, preview-first rename.
- Fingerprint-reviewed detached Git worktree child runner (opt-in); `isolated:false` rejected; git worktrees are not OS sandboxes.
- Project-scoped numeric observability, offline benchmarks and commit-pinned static impact reports.

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

Previous [v0.13.0 hosted CI](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42476557073) passed real Pi/Tersio/WASM/clangd gates; new code requires an independent CI run before release.
