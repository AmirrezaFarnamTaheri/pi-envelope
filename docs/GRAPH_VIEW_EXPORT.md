# Safe native graph visualization exports (v0.21.0 candidate)

`envelope_code_graph {"action":"export","format":"svg"}` returns a **static**, deterministic bounded SVG diagram generated exclusively from Envelope's native indexed imports/calls. It contains labels, circles and edges—not scripts, inline event handlers, foreign objects, external images, URLs, data links, remote content or a project file write. Every source filename is XML-escaped. SVG is limited to 30 visible nodes. A security-sensitive client should still render untrusted SVG according to its own content policy.

`format:"obsidian"` returns Markdown with a fenced Mermaid diagram plus percent-encoded Obsidian-style wiki links for indexed project files. Wiki-link display text escapes HTML/Markdown delimiters; filenames cannot inject HTML or close Mermaid fences. Both exports declare truncation and incomplete AST evidence; no diagram is proof of runtime reachability or architecture correctness.

These formats adapt the useful visual output boundaries of `crafter-station/graphify-visualizer`, `m4t0t0/cmd-mod-graphify`, Graphify.NET SVG/Obsidian exporters and the existing Envelope JSON/Mermaid export. **They do not embed Graphify's third-party graph.html**, run an Obsidian plugin, modify a vault, install a viewer server, or imply semantic communities.

The external artifact reader `envelope_code_external_graph` adds `action:"communities"` for **exporter-declared** community numbers/labels. It returns at most 25 groups, eight member IDs each, and tags them `exporter-declared-community-not-inferred`. Groups are external assertions that remain separate from the native AST graph; no Louvain/semantic clustering or provider-driven taxonomy is computed.

Tests: `tests/graph-visualization.test.mjs`, `tests/graphify-dotnet.test.mjs`, and `tests/graphify-adapter.test.mjs` cover escaping, deterministic bounds, schema formats, community ordering, and Pi tool registration without a second context hook.
