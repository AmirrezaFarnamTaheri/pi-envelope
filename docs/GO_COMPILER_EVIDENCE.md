# Source-verified Go `go/types` compiler evidence

This stage adds a **real, offline Go compiler type-checker** to Envelope. It uses Go's standard `go/parser` and `go/types` packages to analyze explicitly indexed Go source files **within one Go package**. Unlike the existing Go AST syntactic-call evidence, it returns compiler-resolved declaration types and diagnostics; it remains separate from TypeScript's compiler model, Python AST extraction, C/clangd diagnostics and Graphify.NET's external AST exports.

## Usage

Enable existing optional languages with `/envelope code languages on` (and ensure code intelligence is enabled). Then use the read-only native Pi tool:

```json
{"action":"diagnostics","path":"pkg/handler.go","limit":15,"maxChars":4000}
{"action":"symbol","path":"pkg/handler.go","line":12,"column":8,"maxChars":4000}
```

`diagnostics` invokes the real Go `go/types` checker and returns bounded diagnostic codes, source locations, redacted messages, and counts. `symbol` locates one identifier at a **1-based UTF-16** cursor and returns its compiler-resolved symbol, bounded type string and declaration locations *only where declarations fall within that indexed package*. Source bodies, imported package contents, and environment credentials are not included in results.

## Trust, limits and unsupported language semantics

- Envelope re-verifies SHA-256 of each indexed source against the current on-disk bytes before sending a bounded source batch to the dedicated Go helper via stdin. No source is written to disk by the helper and project executables are not run.
- The helper uses a checked-in, fixed `go run scripts/go-typechecker-helper.go` command, `shell:false`, with Go module/workspace/network resolution disabled (`GOPROXY=off`, `GOSUMDB=off`, `GOWORK=off`, `GO111MODULE=off`, `GOTOOLCHAIN=local`). This runs **Envelope's own helper**, not project entrypoints; a local trusted Go toolchain is required.
- It inspects at most **64 non-test .go files in one indexed package**, 2 MiB verified source, 2.4 MiB JSON request, and returns at most 30 diagnostics with a **900–16,000-byte** response limit. Unsafe source paths, symlinks, stale bytes and oversized records fail closed. Standard-library/importer evidence may depend on the installed Go toolchain.
- External/private module imports that cannot be resolved in the isolated checker result in diagnostics and **`complete:false`**, not a false proof. `go/types` type correctness under these bounds is not an actual `go build`, dependency installation, program execution, runtime correctness or policy assurance. Coverage and symbol results are limited to the indexed package; `_test.go` source is excluded.
- Go and TypeScript use their **own** compiler abstractions here. This does not establish typed edges across Go↔Python, Go↔TS, Go↔C#, or native bindings/FFI. A unified, sound cross-language code graph, import resolution against third-party modules, and formal program verification remain open.

## Verification

`tests/go-typechecker-evidence.test.mjs` contains seven focused tests exercising actual `go/types` compilation, cross-file Go declaration resolution, mismatched types and message redaction, unavailable dependencies, stale file hashes, symlink/path refusal, strict request budgets, and native Pi registration without a second lifecycle hook. `npm run check` and the real-runtime release workflow run this on the latest review head with a local Go toolchain; the workflow also preserves the previous TypeScript, Pi, Graphify, .NET, GraphQL, MCP and npm-packaging gates.

See [TypeScript compiler facts](TYPESCRIPT_COMPILER_EVIDENCE.md), [language support](MULTILANGUAGE.md), and [open integration tracker #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10).
