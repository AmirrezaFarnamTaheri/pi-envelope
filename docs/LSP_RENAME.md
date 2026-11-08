# Optional LSP diagnostics and symbol rename

Envelope adds a small **external LSP stdio client** to its existing JavaScript/TypeScript AST code feature. This is an independent, limited adaptation of the reliability and rename-transaction patterns in [Pi Shazam at pinned commit 2bd39ff](https://github.com/gjczone/pi-shazam/tree/2bd39ffcecf999f61d624e060bd1ef5ea709af8e), not a copy of Pi Shazam's code or its full LSP manager.

## Prerequisites and manual trust decision

1. Install a trusted, locally runnable language server that implements `initialize`, `textDocument/rename`, and either `textDocument/diagnostic` (pull) or `textDocument/publishDiagnostics` (push).
2. Add an explicit **argv array** under `envelope.code` in your Tersio settings file (normally `~/.tersio/settings.json`):

```json
{
  "envelope": {
    "code": {
      "enabled": true,
      "lspCommand": ["typescript-language-server", "--stdio"],
      "lspTimeoutMs": 3500,
      "renameEnabled": false
    }
  }
}
```

`typescript-language-server` in this example is **not** bundled or verified in this offline source release. Choose a language-server executable you trust and configure it yourself. Its working directory will be the project root; it runs with your full operating-system permissions and may use network access according to its own implementation. No command is taken from the model, and `spawn` uses `shell:false`. Restart or reload Pi after manually changing `lspCommand`; there is intentionally no model-callable server-configuration tool.

Rename preview and application remain JS/TS-only, even when optional Python/Go AST indexing is enabled. File-level `envelope_code_lsp_verify` can query Python/Go indexed files with a matching manually configured language server; those integrations have not yet been production-tested. Unindexed, ignored, symlink or oversized files are not supported by the shared index. No Tree-sitter, LSP daemon or language-server package is added as a mandatory dependency.

## Native Pi tools and commands

- `envelope_code_lsp_verify({"path":"src/a.ts"})`: opens one source file, requests a full LSP diagnostic report or receives a version-matched push notification; displays up to 20 diagnostics and counts all observations.
- `envelope_code_rename({"path":"src/a.ts","line":2,"column":17,"newName":"updatedName"})`: semantic rename **preview** only; returns changed paths, UTF-16 source locations, original/proposed content hashes and a SHA-256 `planId`. Both line and column are **1-based** (LSP itself uses 0-based positions).
- `/envelope code rename on`: authorizes a subsequent explicit apply operation. Default is off; `/envelope code rename off` revokes it.
- `envelope_code_rename({"path":"src/a.ts","line":2,"column":17,"newName":"updatedName","apply":true,"planId":"<64-digit preview SHA-256>"})`: requests a fresh server plan, checks its fingerprint, validates current on-disk files and attempts the change. If any file/response changes, it refuses. Requires a reliable LSP diagnostic result on **every affected source** with no reported errors; the LSP checks pre-rename state, while the local parser checks proposed syntax.
- `/envelope code lsp status`: displays whether local LSP argv is configured and the configured timeout; never executes the server.

The existing `envelope_code_verify` remains a lightweight, in-memory **syntax-only** check that never needs an external server.

## Diagnostic verdict model

| Verdict | Meaning |
|---|---|
| `PASS` | The server supplied a **fresh full diagnostic report** (or a matching push report) for this one file, with no reported errors or warnings |
| `WARN` | The server reported one or more warnings but no errors |
| `FAIL` | The server reported one or more error-severity diagnostics |
| `UNVERIFIED` | Server absent/unavailable, invalid/incomplete result, timeout, or likely broken language-server dependency state |

A result does not certify all project files, typechecking, test success, runtime correctness, or absence of problems that the particular server cannot diagnose. Diagnostics are bounded in the tool result, and server stderr is drained without forwarding private logs to the model. A server reporting no diagnostics is not a proof of model correctness.

## WorkspaceEdit safety and transaction semantics

1. Only textual `changes` or `documentChanges` are accepted. File creation/deletion/rename operations are rejected, as are mixed, overlapping or duplicate edits.
2. Every touched file must already be in the shared project AST index, inside the canonical root, not a symlink, and at most 512 KB. Total cap: 25 files, 400 edits and 3 MB of original-plus-proposed contents. Indexes at their file limit refuse rename to avoid claiming coverage they cannot prove.
3. Each replacement must be an exact occurrence of the original ASCII symbol with the requested identifier. Elaborate server rewrite operations (e.g., property-prefix edits, string replacements, arbitrary formatting) are rejected rather than partly applied. The parser rejects existing or introduced JS/TS syntax errors.
4. A preview hashes the exact base bytes and proposed bytes for every affected file, plus the target, cursor, new name and project. Applying requires the original `planId` and reconstructs the plan from a **fresh** LSP request; stale source or changed plan means refusal.
5. Before an apply, a fresh LSP report is requested for **every affected file**; a missing, unreliable or error-severity report cancels the operation. These pre-rename diagnostics are not a post-edit typecheck; run the project compiler/tests after applying.
6. Files are staged in the same directory; originals are backed up before any swaps. An exclusive per-project lock prevents a second Envelope rename from running in parallel. A normal rename error or observed abort attempts rollback of previously touched files.
7. **Important:** this is *not* an ACID, crash-atomic transaction. Another program can edit the same files between checks; a forced kill/power failure between file replacements can leave a partial rename. `.envelope-*.bak` files are retained when rollback fails so manual recovery remains possible. Inspect Git diffs after apply and run your real build/tests before merging.

These safeguards are deliberately conservative and narrower than a full language server refactoring system. Exact compatibility with real language servers (beyond the local protocol fixture) remains to be demonstrated with installed Tersio and servers.

## Validation

```bash
npm run check
node --test tests/lsp-client.test.mjs tests/rename-transaction.test.mjs tests/lsp-integration.test.mjs
npm run pack:check
npm run doctor:bundle
```

The local tests launch a deterministic **fake LSP stdio process** to verify real Content-Length framing and JSON-RPC dispatch without a network/model call. They do not prove integration with a production language-server implementation. The bundle doctor must also pass on the installation machine before claiming live Pi/Tersio readiness.

## Real language-server smoke

The independent `npm run smoke:lsp-real` check now runs **actual clangd 17** against temporary C files and verifies both clean and error push diagnostics. This confirms the stdio client can communicate with a real server. It does **not** imply C files are indexed by CodeIndex or that JS/TS or Python/Go production LSP rename has been validated. Rename still requires explicit opt-in, matching preview fingerprint, and conservative JS/TS-only validation.
