# Opt-in authenticated loopback GraphQL history projection

This is a narrow GraphQL interoperability bridge for Envelope's **explicitly captured private static file-graph versions**. It is not a port of the full [OpenGraphify](https://github.com/nainglinnphyo/OpenGraphify) NestJS/Apollo/Prisma application. It also does not expose raw repository code, run code, index automatically, bill a provider, open a public listener or connect to a graph database.

## Operator setup

1. In Pi, explicitly capture a project metadata snapshot with `/envelope code versions capture`. This saves file names, file SHA-256, declaration labels and static imports, **not source bodies**.
2. Install and review the **optional** GraphQL.js reference runtime `graphql@16.15.0` in the package where Envelope is installed. It is not a new mandatory dependency and is not installed automatically by Envelope.
3. Generate a high-entropy bearer token in your own secret-management process (minimum 32 characters); supply it in the environment variable `ENVELOPE_GRAPHQL_TOKEN` **without writing it to source control or logs**.
4. Manually launch:

```sh
node /absolute/path/to/pi-envelope/scripts/envelope-graphql-local.mjs --project /absolute/project --home /absolute/envelope-home --port 0
```

The command responds with a JSON object containing `host:127.0.0.1`, an assigned local TCP port and `readOnly:true`; it never prints the token. Use a trusted local client to `POST /graphql` with `Content-Type: application/json` and `Authorization: Bearer <your-token>`. To revoke, terminate the process and remove the client's access to the token. It is **never** launched as part of ordinary Pi agent use or the code indexing lifecycle.

## Schema and queries

The reference GraphQL.js `buildSchema`, `parse`, and `graphql` parser/executor are used; Envelope does not invent a GraphQL dialect. A read-only `Query` root exposes:

```graphql
{ versions { version capturedAt files symbols } }
```

```graphql
{ snapshot(version:"<64-hex-version>",limit:20,offset:0) { totalFiles truncated files { path sha256 language symbolCount imports } } }
```

```graphql
{ compare(from:"<old-version>",to:"<new-version>") { filesChanged changes { path change addedImports removedImports } } }
```

These fields resolve against the same content-integrity-checked private `GraphVersionStore` used by the MCP bridge; snapshot pages are capped at 50 files, and the stored version can be independently SHA-256 validated. A missing/tampered version returns a sanitized GraphQL error rather than arbitrary file contents. No `Mutation` or `Subscription` type exists.

## Security boundaries and remaining limitations

- **Loopback only:** always bind `127.0.0.1`; never a public host or a remote service. No Docker/k8s exposure or proxy is configured.
- **Bearer token required** (32–512 chars, timing-safe comparison). Reject any `Origin` header to avoid browser-origin and DNS rebinding access patterns; no CORS is enabled. Trusted local non-browser clients must supply the token.
- **Read-only POST only:** reject GET and unsupported paths, non-JSON content types, mutations, fragments, introspection fields, AST depth above 5, or more than 24 selected fields. No aliases/fragments bypass the field count.
- Maximum query string length 2 KiB, JSON body 4 KiB, output 16 KiB, at most 30 requests/minute per server instance; invalid or too-large requests fail closed. Request tokens, raw query bodies, source code and full resolver errors are not logged.
- The server is a manual local process, not a multi-user authenticated remote deployment. OS account permissions remain important; even a read-only graph can reveal sensitive filenames, file digests, imports and declaration metadata. Keep the bearer token and source metadata private.
- This does not implement OpenGraphify's Apollo/Prisma persistence, GraphiQL/playground UI, external network authentication/OAuth, source editing, semantic search, live provider integration or distributed graph event streaming.

**Verification:** `tests/graphql-bridge.test.mjs` covers complexity-policy rejection and real loopback bearer/Origin/request limits using a controlled executor. Hosted CI separately installs **pinned GraphQL.js 16.15.0 (CI only)** and runs `scripts/smoke-graphql-real.mjs`, exercising actual GraphQL parsing, schema validation, authenticated version/snapshot/diff queries, mutation refusal, and no source body. A successful matching-head CI run is required for any claim of genuine GraphQL.js compatibility.

See the [upstream acceptance tracker](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10) for full OpenGraphify and the broader graph engine gaps.
