# Local capability cockpit (v0.21.0 candidate)

`envelope_capabilities` adds a **read-only capability and workflow advisor** under the single native Envelope extension. This is a narrow adaptation of the discovery/router/cockpit ideas in `franklywatson/claude-rig` and the file-backed workflow patterns already present in Envelope. It does **not** implement Claude Code hooks, invoke other tools or add competing RTK/Headroom owners.

It reports the current Envelope settings for code, context, memory, output, workflow, child runner, observability, optional syntax guard and Tree-sitter. It also checks whether executable files named `graphify`, `jcodemunch`, `rtk` or `headroom` exist in at most 24 safe PATH folders. This is **presence-only**, marked `detected-unverified` rather than claiming that a binary works or is connected. No command, version probe, provider API, network fetch or project source is executed. No environment paths, secrets, credentials or raw configuration bodies are returned.

`intent` accepts `orient`, `graph`, `review`, `resume` or `evidence`. The output is a bounded list of existing native Envelope tool names with `suggested`/`blocked` states, e.g. `envelope_code_overview` → `envelope_code_retrieve` → `envelope_code_graph` for orientation. The user or agent explicitly selects the next action. No automatic skill enforcement, tool routing, permission bypass, provider billing, or hidden child process is implied.

See `tests/capability-cockpit.test.mjs` for deterministic route selection, disabled-mode handling, executable detection with no execution, and Pi integration with exactly the original context/tool hooks. External services remain optional and unsupported until separately tested.
