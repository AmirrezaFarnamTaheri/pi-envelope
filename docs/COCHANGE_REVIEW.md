# Bounded co-change review versus direct static imports

`envelope_code_coupling` is a **read-only advisory view** of existing Envelope data: the bounded `envelope_code_history` non-merge Git commit window and the shared `CodeIndex` file-import graph. It is a deliberately narrow adaptation of the historical-coupling diagnostic described by [TeaRAGs](https://github.com/artk0de/TeaRAGs-MCP), and is related to [ops-codegraph-tool](https://github.com/optave/ops-codegraph-tool)'s co-change and impact goals. It does not install either upstream engine, start MCP/GraphQL services, invoke a model, change source, or create another scanner.

## Use

Specify one **exact indexed source file**:

```json
{"path":"src/auth.ts","maxCommits":60,"minShared":2,"limit":8,"maxChars":3000}
{"path":"src/auth.ts","includeDirect":true,"minShared":2,"limit":10,"maxChars":4000}
```

The tool examines at most 100 non-merge Git commits from the exact project root, matching filenames already present in CodeIndex. Large commits and history-window omissions are excluded by the existing bounded history parser and explicitly reported as incomplete. It considers at most the first 20 historically co-edited files for one source, ordered by shared commits. `minShared` (1–20) filters weak co-occurrence, with a conservative default of 2.

By default, a candidate is shown only when the two files repeatedly changed together and **no direct static import was detected** in either direction. Use `includeDirect:true` to inspect both classes. Each entry contains exact project-relative path, `sharedCommits`, ratio relative to the selected file's observed non-merge commits, `directStaticImport:detected|not-detected` and a readable review hint. There is no numeric risk/quality score, ownership attribution, LLM-generated summary or automatic CI gate.

**The absence of a detected direct static import does not mean there is no dependency.** Dynamic calls, indirect import paths, cross-service data flows and unresolved language semantics are outside this test. Changes appearing in the same commit are **not proof of causal coupling, an architectural defect, ownership, or a likely regression**. Treat the result as a small list of files worth manually reviewing, not a directive to refactor them.

## Consistency, freshness and limits

Before reporting a pair, the tool checks the current indexed source SHA-256 against the exact source bytes, rejects symlinks/out-of-project paths, and refuses very large sources. The version token binds the selected path, currently indexed hash, Git revision, report options and candidate evidence. If requesting another page, pass the previous response's `version` as `ifVersion` along with `nextOffset`:

```json
{"path":"src/auth.ts","minShared":2,"includeDirect":true,"limit":1}
{"path":"src/auth.ts","minShared":2,"includeDirect":true,"limit":1,"offset":1,"ifVersion":"<version from page 1>"}
```

Output `maxChars` is **serialized UTF-8 JSON bytes** (900–16,000; default 3,000), not provider tokens. The page `limit` is 1–10; `offset` is 0–20. If the minimum verified response cannot fit, it errors, rather than truncating source identifiers or manufacturing a score. Bounded histories or missing parsers result in `complete:false` and an explicit reason; a non-Git project gives `available:false`.

## Tests and limits of upstream adoption

`tests/cochange-review.test.mjs` creates a real temporary Git history and checks persistent co-edits with/without a direct import, precise ratio, versioned pagination, new-commit staleness, source byte changes, symlink replacement, non-Git fallback, invalid arguments and Pi tool registration without new hooks. `npm run check` and the full hosted release gates also apply.

This does **not** implement TeaRAGs' vector/semantic search, trajectory-derived architecture scoring, compiler-level call graph, real ownership, automatic test recommendations, five-layer indexing or multi-agent MCP. Nor does it implement ops-codegraph-tool's full 34-language code graph and CI gates. For independent evidence, use `envelope_code_history`, `envelope_code_graph`, `envelope_code_slice`, `envelope_code_delta` and `envelope_code_policy`. See the [16-source audit](GRAPH_SOURCE_AUDIT.md) and [remaining acceptance checklist](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10).
