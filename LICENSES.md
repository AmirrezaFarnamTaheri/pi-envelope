# Source provenance and licensing

Envelope v0.13.0 contains locally authored integration code and declares `@krtclcdy/tersio@2.25.18` as a pinned runtime dependency. **This source ZIP does not vendor Tersio, Pi, external parsers, external model runtimes, or source copies of the 33 reviewed repositories.** The root package is marked `UNLICENSED` and `private`; do not assume an unrestricted redistribution license for Envelope itself.

## Original 33 repositories

All 33 reviewed repository identities, pinned revisions, extraction decisions, coverage evidence, and remaining gaps are recorded once in [`integrations/extraction-audit.json`](integrations/extraction-audit.json). The corresponding readable summary is [`docs/ALL_33_SOURCE_AUDIT.md`](docs/ALL_33_SOURCE_AUDIT.md). References to an upstream implementation or its behavior are acknowledgements, not evidence that its source files were copied or its full feature set shipped.

The source algorithms are independent adaptations. In particular, exact-output protection draws on MasuRii/pi-rtk-optimizer and JayPokale/Chisle; syntax preflight on markokocic/pi-tree-sitter; LSP/rename safety on gjczone/pi-shazam; code graphs on gzy987/RepoPilot, kuangxiaoc/code-graph-pilot and EnTeQuAk/pi-repomap; durable task handoffs on open-gsd/gsd-pi and mvschwarz/openrig. Each original license remains relevant if individual source files are ported later. **No third-party file-level copyright notice should be removed from a future direct port.**

## Declared runtime dependencies and redistribution

- Tersio `@krtclcdy/tersio@2.25.18` reports MIT upstream. The installable npm package must include its own notices and required dependency resources; `npm run doctor:bundle` verifies actual installed entrypoints. Until that passes, **this source archive is not an installable bundled npm release**.
- TypeScript `5.8.3` is a pinned runtime dependency for JS/TS AST parsing; its upstream license and notices must be preserved if bundled.
- `web-tree-sitter@0.25.3` and `tree-sitter-wasm@2.0.4` are optional npm dependencies. Individual compiled grammars and `.scm` queries can have additional upstream licenses. **None of their binaries or WASM assets are included in the source ZIP**. Evaluate binary provenance and license notices separately before distributing a complete bundle.
- Python/Go adapters call installed standard-library parsers via bounded local child processes, without vendoring the toolchains or executing project code. Separately configured LSP executables are subject to their own trust and licensing requirements.

The two reviewed projects `scmlab/tree-sitter-pi` (Pi-calculus grammar) and `marifat0/tree-sitter-pipe` (placeholder grammar) are not coding-agent extensions and are intentionally excluded. External Neo4j, pgvector, daemon-based, messaging and transcript-indexing systems are optional integrations, not bundled services. This project is not an official merged derivative of every reviewed upstream.
