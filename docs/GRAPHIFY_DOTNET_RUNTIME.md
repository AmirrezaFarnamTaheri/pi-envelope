# Graphify.NET 10 — Explicit AST-only runtime adapter

This is a separate opt-in adapter for [elbruno/graphify-dotnet](https://github.com/elbruno/graphify-dotnet). Unlike the existing `graphify` Python CLI bridge, this one runs the **Graphify.NET global-tool executable** and never treats its output as native CodeIndex proof.

## Human-only setup and command

Install and review Graphify.NET 0.7.0 **yourself** in a trusted location outside your source repository, using the official .NET 10 toolchain. Then set the exact executable:

```text
/envelope graphify-dotnet binary /absolute/trusted/path/graphify
/envelope graphify-dotnet on
/envelope graphify-dotnet build
/envelope graphify-dotnet status
/envelope graphify-dotnet off
```

The default is **off** with no pinned executable. `binary none` clears the executable. No automatic installation, upgrades, watcher, model download, network provider setup, or project code execution by Envelope is performed outside the explicitly authorized build. The agent-facing `envelope_graphify_dotnet` Pi tool exposes **status only**, not build or provider configuration.

An explicit build runs the fixed argument vector `graphify run . --format json --output .envelope/graphify-dotnet-out`, with the current canonical project as its working directory, and a temporary private home. The child environment is an allowlist (path, OS-specific runtime keys, temporary dirs, .NET CLI controls) with `GRAPHIFY__Provider=None`; inherited Graphify/Azure/Copilot API keys are not forwarded. No shell interpolation or arbitrary command-line argument route is permitted. The trusted executable itself still reads project files—**this is not a process sandbox or cryptographic guarantee of provider non-use**.

Output is isolated under `.envelope/graphify-dotnet-out/graph.json`, preserving Python Graphify's separate `graphify-out/graph.json`. This directory must not be an external symlink; its JSON is treated as **unverified external assertions**. The status tool reads no source bodies or graph contents beyond bounded counts (maximum 2 MiB graph JSON, 2,000 nodes and 8,000 edges) and SHA-256 checksum. Successful process exit does not mean extraction was complete or semantically correct, and the output is not merged into native CodeIndex.

## Safety, limits and proof

- Graphify.NET executable path must be absolute, resolvable, a file, executable when applicable, and outside the indexed source root; command changes revoke any running process.
- Builds require both enabled Envelope code intelligence and explicit Graphify.NET permission, a human slash command, and a 50–120,000 ms timeout (default 30,000 ms). One active writer per project.
- Subprocess stdout is bounded to 16 KiB; stderr is **never** copied into the result or errors. Explicit cancellation and Pi shutdown abort running processes. Results contain counts, hashes and status only.
- C# AST-only source extraction is tested against an isolated, version-pinned .NET CLI in CI; the smoke creates and deletes a disposable C# source fixture. It does not import credentials or bill a model. The real smoke must **pass on the matching PR head** before claiming upstream runtime compatibility.
- The fake-executable and Pi tests cover fixed argv, environment isolation, symlinks, cancellation, output overflow, invalid graphs and read-only agent authority.
- Separate external graph freshness, source provenance, actual C# semantic correctness, full Copilot SDK, AI-backed extractor, Neo4j/Obsidian exporters, dynamic server and watcher parity are **not implemented**.

See [16-source audit](GRAPH_SOURCE_AUDIT.md) and [integration tracker #10](https://github.com/AmirrezaFarnamTaheri/pi-envelope/issues/10). This is a narrowly scoped execution bridge, not a full .NET port into JavaScript or any claim of full 16-project integration.
