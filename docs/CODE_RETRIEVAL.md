# Native source symbol and path retrieval (v0.20.0 candidate)

`envelope_code_retrieve` combines lexical symbol-name and file-path rankings from the **one existing CodeIndex** and returns small, verifiable source evidence. Query tokens are bounded, Unicode-normalized and camelCase/snake_case split. The output uses rank fusion over symbol and path evidence with static inbound import information as supporting context; it is **not** embedding similarity or a general natural-language understanding engine.

- Only indexed source files are candidates; at most 300 candidate files and about 3 MB of original source are inspected for verification. Every returned hit passes an exact SHA-256 hash comparison to the current file. Changed, missing, unsafe or unverified sources are omitted with `complete:false` reasons.
- Results include project-relative path, language, exact SHA-256, matched symbol and line, number of matched query terms, and at most three importing files. No raw source text is returned unless `includeSnippet:true` is requested; snippets are capped at 450 Unicode code points.
- `limit` is at most 25; result truncation, parser unavailability, index size limits, query term limits and verification budget are explicitly surfaced. `complete:true` refers only to the bounded *indexed* lexical evidence, never semantic completeness or a proof of no implementation.
- No network connection, provider API, new persistent database, extra watcher, source execution, or model call. The existing code feature toggle controls availability.

See `tests/code-retrieval.test.mjs` for exact symbol/path ranking, changed-source suppression, output budgets, no implicit source snippets and one tool owner. This adapts ideas from TeaRAGs/codegraph/SDL-MCP without claiming their full engines or measured provider cost savings.
