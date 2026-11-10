# Shared native code intelligence

One project-scoped **`CodeIndex`** serves source maps, symbol lookup, syntactic call evidence, static import impact and read-only syntax checks. The pinned TypeScript 5.8.3 compiler parses JS/TS; optional **Python stdlib AST** and **Go stdlib AST** adapters are available from Phase 10. Neither stdlib parser is Tree-sitter; a separate **optional real WASM Tree-sitter query adapter** now uses the same indexed source paths. No second Pi context or tool-output hook is installed.

## Tools

| Native tool | Behavior | Limits |
|---|---|---|
| `envelope_code_overview` | PageRank-style ranked map of indexed files and declarations | Graph is static, not runtime call or semantic reference rank |
| `envelope_code_lookup` | Find AST declarations with project-relative paths and line numbers | No semantic type/identifier resolution |
| `envelope_code_impact` | Transitive static importers and package imports | JS/TS relative; Python local module; Go root-module package approximation only |
| `envelope_code_calls` | Bounded direct-function callers, callees, unresolved call evidence with project-relative positions | Not runtime/type-checked or class-method dispatch; see [limits](CALL_EVIDENCE.md) |
| `envelope_code_verify` | Syntax diagnostics of existing or proposed text, no file writes | No typecheck, runtime evaluation, code formatting or test execution |
| `envelope_code_languages` | Index counts, optional-parser toggle/status, unavailable parser reasons | Index status is not a guarantee every toolchain will stay available |
| `envelope_code_tree_status` | Lazy WASM engine readiness and supported grammar query groups | Status does not prove individual grammar load success |
| `envelope_code_tree_query` | S-expression syntax matches with named captures from real installed Tree-sitter grammars | Disabled by default; hard query/source/output limits; no fabricated fallback |
| `envelope_code_tree_capture` | Bounded group presets for imports, functions, classes/types, calls and identifiers | Grammar-dependent; no semantic call graph |
| `envelope_code_lsp_verify` | Explicitly configured external language-server diagnostics | UNVERIFIED on timeout/absent/unreliable responses |
| `envelope_code_definition` / `envelope_code_references` | Indexed, project-scoped LSP definition and reference locations, 1-based UTF-16 inputs | No whole-program completeness claim; missing server, foreign paths and invalid results are UNVERIFIED |
| `envelope_code_rename` | Preview-first, hash-checked LSP rename with ordinary-error rollback | **JS/TS-only**, manual apply opt-in, not crash-atomic across files |

Commands: `/envelope code on|off|status`, `/envelope code languages on|off`, `/envelope code tree on|off|status`, `/envelope code guard on|off`, `/envelope code rename on|off`, `/envelope code lsp status`.

JS/TS indexing and query are enabled by default. The Python/Go adapter, pre-write syntax guard and rename *application* are all off by default. The LSP client starts only with a manually configured command; no daemon or LSP auto-installer is bundled.

See [Tree-sitter WASM query/capture details](TREE_SITTER.md), [multi-language parser and runtime smoke details](MULTILANGUAGE.md), [LSP safety and rename caveats](LSP_RENAME.md), and [all upstream audit evidence](ALL_33_SOURCE_AUDIT.md).

## Source and trust model

Source inventory uses Git's tracked plus nonignored untracked files, falling back to a bounded directory walk without Git. Symlinks, dependency directories, generated folders, outside-root paths, oversized files and ignored/unindexed files are excluded. The per-project index is refreshed lazily; unchanged source content hashes reuse parsed facts even when metadata or Git HEAD changes; reverse links are recomputed and source is not executed. Syntactic calls can be incomplete: unmatched, shadowed and dynamic calls are not claimed as resolved. The optional stdlib helpers read a JSON batch on stdin, enforce bounded resource limits, and fail without providing fabricated clean diagnostics when unavailable.

The TS parser and source syntax guard remain distinct from LSP semantics. The TS/JS rename transaction refuses any `.py` or `.go` target or affected edit path. Python import paths are limited to actual indexed local modules; Go imports need `go.mod` and resolve to package directories; no cross-language or dynamic call graph is asserted. The index is not a security boundary for arbitrary agent shell execution or filesystem writes.

## Validation

```bash
npm run check
npm run benchmark
npm run smoke:lsp-real
npm run smoke:runtime
npm run doctor:bundle
npm run pack:check
```

`smoke:lsp-real` exercised real installed clangd 17 with C language IDs on temporary fixtures. `smoke:runtime` is independently blocked by absent Pi/Tersio in the offline environment; fake RPC tests are separate. `npm pack` must be run only after installing Tersio and TypeScript into `node_modules` to produce a fully bundled npm distribution.

Phase 12 adds bounded, unverified syntactic call evidence through `envelope_code_calls` without a second source scanner. See [CALL_EVIDENCE.md](CALL_EVIDENCE.md).


## Discovery completeness and downstream write safety

A refreshed CodeIndex reports `discoveryTruncated` and `discoveryReadErrors` separately from the final parsed file count. Discovery limits apply to the source universe **before** excluded language files or skipped unsafe/oversized sources can reduce that count. Read-only AST queries can still report partial evidence; a durable vector build/sync refuses discovery truncation, directory read failures, parser unavailability or a changed index policy. For pruning, the embedding integration additionally checks that a previously indexed missing row is actually absent from disk, rather than merely excluded by new size or ignore rules. This does not establish comprehensive auto-sync or a complete cross-language compiler graph.
