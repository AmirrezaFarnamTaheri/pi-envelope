# Human-only local embedding generation

Envelope now supports an **operator-pinned executable** that creates numeric embeddings for the existing source-hash-verified vector index. This is an optional and independently authored protocol adapter: Envelope does **not bundle an embedding model**, download weights, call a provider, run a daemon or establish retrieval quality. The trusted executable must supply its own model.

## Explicit workflow

Human Pi commands, with code intelligence enabled:

```text
/envelope code vectors encoder /absolute/path/to/trusted-encoder
/envelope code vectors on
/envelope code vectors build
/envelope code vectors find auth retry backoff
/envelope code vectors replace
/envelope code vectors off
/envelope code vectors encoder none
```

`build` reads up to 64 indexed source files with exact SHA-256 verification, invokes the trusted executable and creates a private `0600` `.envelope/embeddings.json`. It **never overwrites** a preexisting manifest. `replace` requires an explicit separate human command. No automatic model runs occur when indexing, enabling vectors, or using the read-only agent tool. `find <text>` explicitly encodes a user query with the **same model** as the manifest and performs existing offline cosine + lexical-hybrid retrieval; it returns bounded paths/scores, not raw source text or query vectors. The existing agent-facing `envelope_code_vector` remains status / numeric-vector search only and cannot launch the encoder.

## Executable JSON protocol

The pinned executable must be a trusted, operator-installed, non-symlink executable at an **absolute path outside the project**. It runs with no argv or shell, reads one JSON object from stdin and writes one JSON object to stdout.

For a build, stdin looks like:

```json
{"schema":1,"task":"embed-documents","documents":[{"path":"src/api.ts","text":"source excerpt"},{"path":"src/db.ts","text":"other excerpt"}]}
```

Its stdout must contain **exactly one vector for every requested path**, matching the same source set:

```json
{"schema":1,"model":"trusted-model-v1","dimensions":8,"entries":[{"path":"src/api.ts","vector":[1,0,0,0,0,0,0,0]},{"path":"src/db.ts","vector":[0,1,0,0,0,0,0,0]}]}
```

For `find`, stdin is `{"schema":1,"task":"embed-query","text":"auth retry"}`. A valid response is `{"schema":1,"model":"trusted-model-v1","dimensions":8,"vector":[1,0,0,0,0,0,0,0]}`. **These example vectors are not semantic model outputs.** The real encoder must use identical model weights, preprocessing, pooling and dimensionality for document and query vectors. The `model` field is an unverified assertion supplied by the executable.

## Trust and consistency

- Source bodies and search text **are passed to the pinned executable**, which must be audited and trusted. The process receives an allowlisted environment with private temporary HOME/TMP, offline-oriented flags (`HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `PIP_NO_INDEX`) and **no inherited LLM provider credentials**. This does **not** stop a malicious executable from using the network or other available filesystem resources; use an independently managed OS/network sandbox for a hard isolation guarantee.
- Maximum **64 files**, **4 MiB SHA-verified source bytes**, first **6,000 JavaScript characters per file**, serialized encoder input at most **450 KB**, output at most **1.15 MB**, 8–1,024 numeric dimensions and manifest at most **1 MiB**. If limits are exceeded, **fail closed** instead of claiming complete coverage.
- Verify indexed SHA-256 both **before and after** execution, including file/symlink safety. Reject stale source, changed files mid-run, missing or extra vector paths, non-finite or zero vectors, model/dimension mismatch on query, untrusted executable locations, unsafe manifest directories, or malformed JSON. An encoder failure leaves an existing manifest unchanged; successful writes use an atomic private temporary file with `0600` permission.
- Explicit command cancellation, shutdown, a 30-second default timeout and redacted stderr prevent accidental source/secret leakage through error reporting. This is **not** a full system-call sandbox or filesystem race-proof against another hostile process sharing the same account.
- Embeddings, paths, model labels and hashes are private metadata. Add `.envelope/embeddings.json` to the project's Git ignore rules, assess backups and do not assume semantic similarity scores prove relevance, software correctness or token/cost savings.

## Verification and limits

`tests/local-embedding-runtime.test.mjs` covers real subprocess invocation using a controlled encoder, source hashes, private manifest permissions, model-consistent query ranking, malicious output, existing-manifest protection, symlinks, source changes during encoding, timeout/cancellation, output caps and Pi human-only commands. The full hosted workflow independently checks this against packaged Pi/Tersio and the previously verified Graphify, Graphify.NET, Tree-sitter, clangd, GraphQL and Go toolchains.

This is a **local encoding interface**, not a bundled/benchmark-validated semantic encoder, vector database, automatic content watcher, ANN index, full compiler-backed cross-language graph or formal program proof. The remaining 16-source gaps are tracked in [issue #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10).
