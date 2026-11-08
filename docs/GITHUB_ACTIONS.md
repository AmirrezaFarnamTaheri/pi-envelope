# GitHub Actions release gates

The **Envelope release gates** workflow runs on pull requests, pushes to `main`, and manual `workflow_dispatch`. It is a **release gate**, not a publishing or deployment pipeline. It uses read-only GitHub permissions, no model calls and no provider tokens.

The Ubuntu 24.04 runner installs Node 22 (minimum 22.19), Python and Go, the pinned npm dependencies including optional WASM grammars, and `@earendil-works/pi-coding-agent@1.5.0`. It verifies bundled Tersio resources, runs the complete regression suite and offline benchmark, tests real Pi RPC registration, real JS/Python/Go Tree-sitter WASM captures, real clangd diagnostics and a fresh npm tarball after extraction.

**Missing or broken prerequisites fail CI**, including a BLOCKED (exit code 2) smoke. There are no simulated runtime fallbacks or skipped release gates. GitHub Actions uploads the tarball, pack metadata and any generated lockfile for review; it never publishes, tags, merges or deploys.

## Inspect pull request results

Open the repository **Actions** tab and select **Envelope release gates** for the pull request. Check every job step and download the seven-day `envelope-candidate-<run>` artifact to inspect the package and generated lockfile.

The repository currently does not commit a lockfile: transitives are therefore not fully reproducible across runs. The workflow emits the lockfile for review so it may be committed in a separate dependency-pinning change. A passing hosted install indicates compatibility with the dependency versions resolved at that time, not a guarantee against future upstream changes.

## Boundaries

The workflow verifies code loading and tool-protocol interoperability, not production model usage or autonomous coding quality. Provider-backed evaluations must run separately with explicit opt-in credentials, cost budgets and approval controls. Such provider evaluations, persistent optional agent adapters, OS-level worker sandboxing, and comprehensive parity with all 33 upstream sources are distinct future work.
