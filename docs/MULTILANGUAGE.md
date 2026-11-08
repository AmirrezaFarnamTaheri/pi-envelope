# Multi-language AST and real-runtime smoke tests

Envelope continues to expose **one shared `CodeIndex`** and one native Pi extension. JS/TS remains the default parser using the pinned TypeScript 5.8.3 compiler. This release adds **optional Python and Go structural parsers**; neither is Tree-sitter.

## Enable optional languages

Within Pi:

```text
/envelope code languages on
```

Or set `envelope.code.languagesEnabled: true` in `~/.tersio/settings.json`. `/envelope code languages off` returns to JS/TS only without disabling other code tools or the separate syntax-guard and LSP-rename preferences.

`envelope_code_languages({})` returns indexed counts, optional-parser state, and bounded reasons for unavailable parsers. It does **not** claim that a parser's executable is installed merely because earlier AST records remain cached. Sources can be inspected through `envelope_code_lookup`, `envelope_code_overview`, `envelope_code_impact`, `envelope_code_calls`, and `envelope_code_verify` (including proposed in-memory text).

## Parsers and dependencies

| Language | Source suffixes | Mechanism | Availability |
|---|---|---|---|
| JavaScript/TypeScript | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | TypeScript 5.8.3 compiler AST | Required by the package |
| Python | `.py`, `.pyi` | `python3 -I -S` with package-owned `scripts/py-ast-helper.py` using stdlib `ast` | Optional local Python 3 executable |
| Go | `.go` | `go run scripts/go-ast-helper.go` with stdlib `go/parser` + `go/ast` | Optional local Go toolchain; compiler cache can affect first-use latency |

Returned declaration lines are one-based, with display columns normalized toward UTF-16 units for Pi/LSP compatibility. Python and Go syntax diagnostics remain parse-only, not type diagnostics.

The helpers accept source **through standard input**, not executable file paths or arbitrary command arguments; they **parse but never import/run indexed code**. No network connection, embeddings, Tree-sitter grammar, Neo4j, Go module download, or LSP server is needed for these structural tools. Go execution sets `GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`, and `GOWORK=off` to avoid network/toolchain upgrades.

Parser batches are capped at approximately 3 MB; outputs are capped at 3 MB. Python has a five-second deadline and Go a 30-second deadline (including Go's compile/cache work). The Pi adapter retains its total maximum of 1,000 indexed paths and 512 KB per source file. Parser failures or missing executables produce **unavailable** rather than false syntax-valid verdicts. Existing JS/TS indexing remains available. Batch failures omit affected Python/Go records until a succeeding refresh; there is no fallback to regex pretending to be an AST.

The optional parser bridge does spawn a trusted local executable with the user's OS permissions; it is **not an execution sandbox**. Use the Go/Python parsing toggle only where those toolchains are trusted.

## Static import evidence (limited)

- JS/TS: static relative `import`/`export`/`import =` references, same as earlier releases; no aliases, runtime calls or dynamic imports.
- Python: `import pkg.mod`, `from pkg.mod import item`, and valid relative `from .mod`/`from ..mod` references, resolved **only** to indexed local `.py/.pyi` files or `__init__` modules. Attribute imports are considered potential modules only when the exact module file exists. Invalid beyond-root relative paths are ignored. Runtime monkey-patching and `importlib` are not resolved.
- Go: module-prefixed import paths declared by the repo's own `go.mod`, resolved to the indexed `.go` files in that package directory. This is a **file-to-package approximation**, not symbol-level calls or build-tag-aware dependencies. Third-party and standard-library imports are not linked.

All results are project-relative and respect existing Git/ignore, symlink and source-size safeguards. The index cache uses file size, mtime and ctime, and reparses when any differs; it is not a content-hash guarantee against preserved timestamps or concurrent modification. No cross-language FFI/call edges are claimed.

## Rename safety

`envelope_code_lsp_verify` can query any **indexed** file if a compatible LSP server is explicitly configured in `envelope.code.lspCommand`. Python and Go LSP-server compatibility is not production-verified. `envelope_code_rename` and its transaction engine remain **JS/TS-only**, even when Python/Go are indexed; all affected files must also be JS/TS. The JS/TS pre-write syntax guard remains JS/TS-only. This avoids applying a TypeScript-based rename validator to a different language.

## Runtime readiness and real language server verification

```bash
npm install
npm run doctor:bundle
npm run smoke:runtime
npm run smoke:lsp-real
npm run check
```

`smoke:runtime` is read-only: it checks Tersio's exact pinned manifest/resources, the TypeScript compiler, Pi's CLI version, then starts Pi in `--mode rpc --no-session --no-extensions` with **explicit** `--extension` entries for every pinned Tersio extension and Envelope. It sends only the RPC command `get_commands`, and requires `envelope` and `tersio` registered as extension commands. It never requests a model, executes a coding prompt, installs dependencies, or mutates user settings. Exit status: `0` = loaded and commands discovered, `2` = blocked (missing prerequisites), `1` = protocol/runtime failure. Its test suite uses a fake Pi RPC subprocess to verify framing, timeouts and command expectations, **not** to claim real Pi compatibility.

`smoke:lsp-real` tests a real local `clangd` on temporary C fixtures: one clean and one undeclared identifier. It verifies an actual push/pull diagnostic report rather than trusting an empty response; exits `0` on success, `2` on missing clangd, `1` on incorrect/incomplete reports. This is a direct LSP-client smoke, **not** proof that C is indexed by CodeIndex or that Python/Go rename works. All temporary fixtures are deleted. Tests also use the existing fake LSP for protocol edge cases.

In the development environment used for this release, **Pi and pinned Tersio are absent** and npm registry resolution fails, so `smoke:runtime` reports blocked. A real `clangd` 17 returned verified clean and verified error diagnostics in its independent smoke. Neither a Tree-sitter runtime nor model/provider evaluation was executed.

## Remaining work

An opt-in Tree-sitter WASM S-expression/capture interface was added in Phase 11 but **cannot be verified with real grammars in this offline environment**; broader grammar queries and AST graph semantics, Python MRO/call graphs, Go build-tag/package-level compiler analysis, real Pi/Tersio coinstallation, real Python/Go LSP servers and safe semantic rename support, and model-based coding-task comparisons remain pending. See the [33-source audit](ALL_33_SOURCE_AUDIT.md) for individual extraction decisions.


Phase 11 adds an independent Tree-sitter WASM **query** adapter under the same CodeIndex paths, not a replacement for Python/Go stdlib symbol/diagnostic extraction. It requires optional locally installed WASM dependencies and an explicit `/envelope code tree on`. See [TREE_SITTER.md](TREE_SITTER.md).

Phase 12 adds **bounded direct-call evidence**, including selected imported symbol links, without executing project code. For exact syntax, uncertainty and shadowing limitations see [CALL_EVIDENCE.md](CALL_EVIDENCE.md).
