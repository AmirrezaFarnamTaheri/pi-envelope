# Symbol-first source context cards (v0.19.0 review candidate)

`envelope_code_context_card` composes a small, deterministic evidence card from the *existing* hash-aware `CodeIndex` (no new AST parser, vector DB, LLM or context hook). Required `path` must resolve to an indexed project-local file. Optional `symbol` filters to an exact declaration; an unknown symbol fails rather than fabricating matches. Optional `limit` is 1–16, default eight.

The response includes a source SHA-256, syntax language, declaration lines/kinds, up to `limit` statically resolved importers/imports, bounded syntactic caller/callee evidence, and explicit unresolved/dropped fact counts. It re-reads the source and compares SHA-256 with the refreshed index before producing a card; changed files require a refresh. `includeSnippet:true` explicitly enables at most 450 source codepoints near a declaration. **No source body is included by default.**

`complete:false` and reasons acknowledge unresolved calls, parser gaps, diagnostics or card result caps. Even `complete:true` says only that the displayed known static evidence has no flagged collection gaps, *not* that the code is runtime/type-correct or semantically understood.

This adapts the bounded symbol/graph context-card idea from SDL-MCP and related local repository intelligence projects, without embedding their autonomous agents, inference engines or context-budget schedulers. Tests: `tests/context-card.test.mjs`.
