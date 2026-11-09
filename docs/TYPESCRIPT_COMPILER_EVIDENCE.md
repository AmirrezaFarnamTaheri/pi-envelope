# Bounded TypeScript compiler facts over one CodeIndex

`envelope_code_typecheck` uses the **pinned TypeScript 5.8.3 compiler API** to type-check and identify symbols in currently indexed TypeScript/JavaScript source files. It does not execute user project code, emit files, install compilers, start another Pi hook, or call a model/provider.

## Usage

```json
{"action":"diagnostics","path":"src/entry.ts","limit":20,"maxChars":4000}
{"action":"symbol","path":"src/entry.ts","line":3,"column":12,"maxChars":4000}
```

`diagnostics` reports TypeScript compiler error/warning counts and up to 30 bounded diagnostic locations/codes/messages. A compiler error is actual evidence of a TypeScript diagnostic under the adapter's documented options; a zero-error result does **not** certify the project can build, test or run correctly. `symbol` reports a compiler-resolved symbol name, bounded type string, and exact declaration locations **within the currently indexed project**. TypeScript aliases are resolved to their declarations across indexed JS/TS files. It never includes function/source bodies. Cursor `line` and `column` are 1-based UTF-16 positions.

The compiler runs in memory with `noEmit`, `allowJs`, `checkJs`, strict checking, ES2022/ESNext, bundler-style module resolution, no auto-loaded `@types`, and a bounded source set. Only **indexed, source-hash-verified TS/JS** files are available as project modules; the compiler's trusted standard libraries may be read separately. If a project uses excluded/unindexed package modules or custom `tsconfig` options, diagnostics and inferred types may differ from its real build. Such missing imports are explicitly reported as `complete:false` with `unresolved-compiler-module`. This is not an execution sandbox.

## Safety and scope

At most 100 TS/JS indexed files and 8 MiB verified current source bytes are read per call. Source files must be non-symlinks inside the canonical project root, with SHA-256 matching the current shared CodeIndex; stale or unsafe inputs fail closed. Output is capped at 900–16,000 UTF-8 JSON bytes and excludes raw code bodies. Type `any` or `unknown` is explicitly tagged incomplete, not a type proof. Compiler messages are short and may contain local identifier names; treat them as private metadata.

Existing Envelope language evidence remains separate: the Python/Go AST helpers capture syntax and conservative call candidates, while user-configured external LSP servers can supply file diagnostics for supported language IDs (and clangd is tested with real C). **This tool does not provide a unified compiler-backed cross-language symbol graph**, nor does it formally prove program properties across TS/Go/Python/C/C#. Genuine cross-language references require independently tested language servers or type-checker IR adapters with stable source spans and provenance. These acceptance gaps remain open.

`tests/typechecker-evidence.test.mjs` runs the real TypeScript compiler against temporary linked modules, tests type errors, declaration provenance, unresolved imports, stale hash/symlink refusal, budget checks, and single Pi-tool registration. See [issue #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10) for the remaining multi-language work.


The compiler now loads the requested indexed source and a bounded, deterministic static-import closure (up to 100 indexed JS/TS files and 8 MiB), not every unrelated indexed file. Overflow reports incomplete evidence via `compiler-file-budget` or `compiler-source-byte-budget`; it does not silently claim a whole-project check. Installed TypeScript standard-library declarations may be read from the trusted TypeScript package even when it resides within the project. Arbitrary unindexed project sources are still not loaded.
