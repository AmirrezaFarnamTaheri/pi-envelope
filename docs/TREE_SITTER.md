# Optional native Tree-sitter query and capture bridge (Phase 11)

Envelope v0.11.0 adds a **real WebAssembly Tree-sitter integration path**, adapted from the structural-query interface in [UgoMendesDonelli/pi-tree-sitter](https://github.com/UgoMendesDonelli/pi-tree-sitter/tree/02bb779fab634bf55a6a1307d7a11aff2e3c3db6), under the **existing project-scoped CodeIndex**. No second Pi plugin, code graph, hook, network daemon, mutation interceptor, or competing repository scanner is installed. No source code from that repository is copied.

**Off by default.** Query results come from the `web-tree-sitter` WASM runtime and compiled language grammar assets, not from a regex or substitute TypeScript/Python/Go parser. When a runtime or grammar cannot be loaded, the tool returns **unavailable** and does **not** fabricate a match or an empty successful result. `envelope_code_tree_status` reports whether the engine loads; it does not certify that every grammar is installed or ABI-compatible.

## Installation and verification

```bash
npm install --include=optional
npm run check
npm run smoke:tree
```

The additional pinned **optional** dependencies are `web-tree-sitter@0.25.3` and `tree-sitter-wasm@2.0.4`. They must be present locally with compatible `.wasm` grammars. The dependency installation uses the package registry when available; **query execution itself makes no network requests** or downloads. Source ZIPs intentionally exclude `node_modules` and third-party grammar artifacts. The existing mandatory pinned Tersio and TypeScript packages are unchanged. A local Pi package needs `npm install` before `pi install .`.

`npm run smoke:tree` uses **only the actual runtime** and attempts JavaScript, Python and Go function captures. Its exit status is `0` for all three verified, `2` for missing engine, grammar or required stdlib toolchain, and `1` for incorrect parsing/captures or internal protocol failures. Unit and Pi-integration tests use a locally injected Tree-sitter-compatible test double to verify the adapter's behavior **but are not real-WASM test results**. This offline build could not install the optional packages, so the live WASM smoke is blocked. The installed Pi/Tersio runtime remains separately blocked in this environment. Running the smoke after installing dependencies is necessary before asserting real grammar compatibility.

## Commands and tools

```
/envelope code tree on
/envelope code tree status
/envelope code tree off
```

| Tool | Inputs | Output |
|---|---|---|
| `envelope_code_tree_status` | `{}` | `enabled`, engine availability, supported grammar groups, note on lazy grammar initialization |
| `envelope_code_tree_query` | `{ "path":"src/app.ts", "query":"(function_declaration name: (identifier) @name)", "limit":10 }` | Per-pattern matches with named captures, source positions, bounded node text, truncation flags |
| `envelope_code_tree_capture` | `{ "path":"src/app.ts", "group":"functions", "limit":10 }` | Named captures selected from a grammar-specific preset |

Group names: `identifiers`, `comments`, `functions`, `imports`, `calls`; `classes` for JS/TS/TSX/Python; `types` for Go. These are **conservative syntax patterns**; e.g. the call preset finds simple direct calls, not a static or dynamic call graph. Grammar versions can change node names and invalidate a preset; that returns a query error rather than a false successful result. Arbitrary S-expression queries are supported through the query tool. Scope is limited to indexed JS, JSX, TS, TSX, MTS, CTS, MJS, CJS and, when enabled, Python/PYI and Go files. Python and Go also require `/envelope code languages on` and their corresponding standard-library AST helpers to be available for indexing. This feature does not expand the semantic-rename language boundary (JS/TS only).

## Safety and resource limits

- Indexed existing project-relative paths only. Ignored files, symlinks, paths outside the project, non-source files and unindexed files are rejected by the existing CodeIndex and rechecked at read time.
- Read-only queries, no source execution, edits, mutation hooks, automatic downloads, external LSP processes or providers.
- Source cap 256,000 UTF-8 bytes; S-expression cap 2,048 characters; maximum 25 returned matches/captures; at most 10 displayed captures per match, 200 Unicode characters of each captured node, and 16 KB of total JSON output.
- The WASM query is passed a 128 in-progress-match limit and a 100,000-microsecond execution deadline. Exhaustion or returned-result truncation is recorded; do not treat truncated responses as proof that no later matches exist. Exact line/column coordinates are parser-native, 1-based for display; there is no claim of semantic type resolution.
- The runtime and grammars are **trusted locally installed native/WASM dependencies, not a sandbox**. They run with host process permissions. The language WASM packages are external assets with their own per-grammar upstream licenses; review those for redistribution.
- Tree-sitter parsing is on demand in a lazy cached broker; it does not add another history projection, tool-result transformer or before-agent-start prompt contributor.

## Verification boundary

The adapter's API and safety tests run without third-party WASM binaries, but those tests use fake parser/query responses. **Live Tree-sitter parser results, real Pi/Tersio co-loading, all grammar ABI matches and model-driven quality improvements remain unverified until an installation with the optional dependencies succeeds.** This capability does not replace typechecking, the TypeScript/Go/Python built-in AST verification, LSP diagnostics, code edits or workflow review.
