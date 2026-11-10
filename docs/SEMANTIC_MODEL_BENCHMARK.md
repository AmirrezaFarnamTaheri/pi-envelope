# Operator-supplied semantic model benchmark (no bundled model)

This evaluation runner is inspired by the local-retrieval and hybrid-search directions in TeaRAGs-MCP, codegraph and ops-codegraph-tool. It **does not copy a model or require online services**. Its purpose is to make real-model validation reproducible rather than infer quality from synthetic fixtures. The four cross-project acceptance goals in issue #10 are not closed by this harness.

## Prerequisites and invocation

Use a trusted, operator-installed executable that implements the [existing local embedding JSON stdin/stdout protocol](LOCAL_EMBEDDING_RUNTIME.md): `schema:1`, `embed-documents` and `embed-query` tasks, self-declared `model`, `dimensions`, and matching vectors. Pin model weights and tokenizer hashes separately; the executable-provided model string cannot prove which model actually ran. The launcher forwards no provider secrets and requests offline operation, but **cannot enforce network isolation**. Choose your own offline model and use operating-system network controls when needed.

Prepare a held-out JSON fixture with at least two source documents and independently judged relevance labels:

```json
{
  "schema": 1,
  "documents": [
    {"path":"src/retry.ts","content":"export function retryToken() { return 'refresh token'; }"},
    {"path":"src/store.ts","content":"export function persistRecord() { return 'database commit'; }"}
  ],
  "queries": [
    {"id":"auth-recovery","text":"authentication retry","relevant":["src/retry.ts"]},
    {"id":"database-save","text":"database record","relevant":["src/store.ts"]}
  ]
}
```

```sh
npm run benchmark:semantic -- --dataset /absolute/corpus.json --encoder /absolute/trusted-local-encoder --k 5
```

The runner validates bounded paths, files, labels and per-query limits; copies only the explicitly supplied source fixture into an owner-private temporary project; uses **one shared CodeIndex**, the regular source-hash-verified vector manifest, and one invocation of the encoder for source documents plus one for each query; compares vector-only, hybrid and lexical rankings. Temporary source bytes and vector manifests are removed on completion. It returns aggregate **hit@k**, **recall@k**, **MRR@k**, document/query counts, an input SHA-256, the self-reported model label and measured process elapsed time. It omits source bodies, full query strings and vectors from the JSON output.

## Interpretation and acceptance

- The synthetic encoder exercised in unit tests is a protocol fixture, not a semantic language model. **No actual semantic model has yet been benchmarked or certified by this PR.**
- For credible quality claims, benchmark at least two independently pinned, genuinely local semantic models (include executable and weights hashes, tokenizer, dimensions, CPU/GPU model, OS, thread count, hardware, memory and runtime versions) on a held-out corpus with human-checked relevance labels. Evaluate vector-only and hybrid against the same lexical baseline, and run multiple times for latency variance.
- This tool does **not** measure provider-billed tokens, production retrieval impact, coding success, full cross-language semantics, or privacy against a malicious trusted executable. Those need separate evidence.
- Limits are intentionally small (2–32 TS/JS source documents, 1–32 labeled queries, k=1–8). The runner is for controlled, local candidate comparison, **not** a comprehensive public benchmark or an automatic index synchronization daemon.
- The operator must retain evaluation outputs privately and check that the corpus does not contain confidential code; although printed output omits bodies and full query text, the trusted encoder sees them.
