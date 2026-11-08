# GitHub Actions release gates

The **Envelope release gates** workflow runs on pull requests, pushes to `main`, and manual `workflow_dispatch`. It is a **release gate**, not a publishing or deployment pipeline. It uses read-only GitHub permissions, no model calls and no provider tokens.

The Ubuntu 24.04 runner installs Node 22 (minimum 22.19), Python and Go, the pinned npm dependencies including optional WASM grammars, and `@earendil-works/pi-coding-agent@1.5.0`. It verifies bundled Tersio resources, runs the complete regression suite and offline benchmark, tests real Pi RPC registration, real JS/Python/Go Tree-sitter WASM captures, real clangd diagnostics and a fresh npm tarball after extraction.

**Missing or broken prerequisites fail CI**, including a BLOCKED (exit code 2) smoke. There are no simulated runtime fallbacks or skipped release gates. GitHub Actions uploads the tarball, pack metadata and any generated lockfile for review; it never publishes, tags, merges or deploys.

## Inspect pull request results

Open the repository **Actions** tab and select **Envelope release gates** for the pull request. Check every job step and download the seven-day `envelope-candidate-<run>` artifact to inspect the package and generated lockfile.

The repository currently does not commit a lockfile: transitives are therefore not fully reproducible across runs. The workflow emits the lockfile for review so it may be committed in a separate dependency-pinning change. A passing hosted install indicates compatibility with the dependency versions resolved at that time, not a guarantee against future upstream changes.

## Real GitHub runner evidence and follow-up

On [run 42464944338](https://github.com/AmirrezaFarnamTaheri/pi-envelope/actions/runs/42464944338), early attempts had **no executed steps**. A later attempt allocated a **hosted runner** and successfully installed pinned Tersio, TypeScript and Pi, ran the regression suite, and passed the bundle doctor. The remaining error was **`Pi RPC exited before discovery (0)`**. That is a real command-discovery failure, not evidence of billing or runner starvation.

The RPC probe now drains output until process `close`, and reports only bounded, categorized stderr diagnostics rather than printing arbitrary extension output that might contain secrets. A failing smoke still fails CI; a subprocess exit code of zero does not imply successful command registration.

Tree-sitter, clangd and packed-artifact checks now use `if: !cancelled()` to continue independently when Pi RPC fails, without `continue-on-error`. The overall job remains red until all gates pass. A small evidence file is created before installation, so the CI artifact exists even if an earlier step fails.

The pinned GitHub Actions v6 releases use Node.js 24 internally, eliminating the old action-runtime deprecation warning. Pi itself remains pinned to Node.js 22. Use the run log to inspect the **new failure reason** before making further changes.

If future jobs fail without running any steps, check the job annotation and repository Actions settings; only investigate billing if the annotation indicates it. Do not purchase runner capacity or change repository visibility without explicit approval.
## Boundaries

The workflow verifies code loading and tool-protocol interoperability, not production model usage or autonomous coding quality. Provider-backed evaluations must run separately with explicit opt-in credentials, cost budgets and approval controls. Such provider evaluations, persistent optional agent adapters, OS-level worker sandboxing, and comprehensive parity with all 33 upstream sources are distinct future work.

### Tree-sitter runtime interoperability

Hosted run 42465598056 reached the real WASM smoke and reported `Dynamic require of "fs/promises" is not supported` under the ESM entrypoint of `web-tree-sitter@0.25.3`. That package also publishes a CommonJS `require` entrypoint. The Node-only broker now selects it with `createRequire(import.meta.url)`; this change is subject to the next **real hosted WASM smoke**, not asserted as verified by injected-unit tests.

The same run found the Pi subprocess emitted startup JSON without a command-discovery response. The smoke now records **event type names only** (bounded, without event payloads) to distinguish startup events from protocol replies. A zero exit code without `get_commands` remains a failed gate.

### RPC startup UI handshake

Run 42465842215 confirmed that Pi emitted `extension_ui_request` before its `get_commands` reply. For **only the model-free release smoke**, the RPC client now sends `{cancelled:true}` to recognized `confirm`, `select`, `input` and `editor` dialogs (at most four). It never consents, approves commands or supplies synthetic text. Notifications and status updates are not answered. This follows Pi's documented [RPC extension UI contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md).

The smoke still rejects missing/duplicate commands or an early exit; it now categorizes UI method names without logging request bodies. Real hosted validation is required to prove that the handshake unblocks Pi's startup.
