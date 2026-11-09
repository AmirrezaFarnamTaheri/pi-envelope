# Read-only MCP stdio interoperability — operator-started

Envelope includes a narrow, independent MCP stdio server conforming to the **2025-11-25** newline-delimited JSON-RPC transport for three **read-only** graph-history tools. The server does **not** register another Pi lifecycle hook, start automatically, listen on HTTP, make external calls, index the project or return raw source. It reads only private, **previously human-captured** content-addressed file-graph versions from `docs/PERSISTENT_GRAPH_VERSIONS.md`.

## Explicit setup

First, within Pi, run `/envelope code versions capture` on the intended project. Then manually configure an MCP client to launch:

```sh
node /absolute/path/to/pi-envelope/scripts/envelope-mcp-stdio.mjs --project /absolute/path/to/project --home /absolute/path/to/envelope-home
```

The `--home` argument is **Envelope's data home** (the directory containing `envelope-graph-versions/`), not an arbitrary output directory. Both paths must be absolute and accessible to the current OS account. MCP client implementations may receive private filenames, declaration labels, static imports and hashes; only connect **trusted clients**. No local/remote server is started until the operator launches this process. To revoke access, terminate the MCP subprocess and remove its client configuration; captured snapshot files remain until human `prune`.

The service supports `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`; `tools/list` advertises:

- `envelope.graph.versions`: list previously captured versions, sizes and timestamps.
- `envelope.graph.snapshot`: read a bounded page of metadata from a specified content-addressed version.
- `envelope.graph.compare`: read a bounded historical static file/import diff between two versions.

It does not expose `capture`, `prune`, shell execution, code execution, LLM provider configuration, project source reads or tool registry mutation. Each message must be one UTF-8 JSON-RPC request/notification per line (max 16 KiB input), responses are valid single-line JSON-RPC and limited to a bounded maximum (20 KiB). Unsupported protocol versions fail closed; requests before the completed initialization handshake are rejected. The server logs no project paths or raw request payloads to stderr on error. It exits after the input stream closes.

The `tools/call` result includes both standard MCP `content` and `structuredContent` with explicit `isError`. Invalid or tampered snapshot IDs produce a bounded error response without disclosing storage paths or raw data. This is not a substitute for strong access controls: the local MCP client runs under the operator's OS permissions and can request sensitive project metadata that the operator explicitly chose to capture. It is **not** an authenticated multi-tenant Streamable HTTP MCP host; no DNS rebinding/OAuth/remote transport support is claimed.

## Verification

`tests/mcp-stdio-interop.test.mjs` runs a real child process and checks initialize, handshake, capability discovery, read tool calls, invalid and oversized frames, mutation refusal and absence of raw source in responses. The pinned Graphify/other Pi release gates continue to run normally. Protocol behavior is scoped to these three read-only operations; full MCP client ecosystems, transports, subscriptions, prompt routing and tool creation remain unimplemented.

[Official MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio) and [MCP tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) are the relevant upstream protocol references. See [issue #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10) for further interoperability acceptance.
