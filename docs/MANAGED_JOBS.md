# Managed background jobs (review candidate)

Envelope adds a small, independent job-control surface. It deliberately does **not** reuse the workflow DAG, claim leases or reviewed worktree handoffs for ordinary commands. Foreground Pi execution remains unchanged.

## Explicit operator permission

Job starts and background agent starts are **off by default**. In an interactive Pi session:

- `/envelope jobs status`: inspect two separate switches.
- `/envelope jobs on`: authorize new background commands via `envelope_job`.
- `/envelope jobs off`: prohibit new command jobs, without stopping already running jobs.
- `/envelope jobs agent on`: authorize a single read-only Pi background session via `envelope_agent_start`.
- `/envelope jobs agent off`: prohibit new background agent sessions, without cancelling existing ones.

The two switches are independent from `/envelope workflow run on`; no workflow, task hierarchy, subagent, or clean Git checkout is required for a command job.

## Tools

`envelope_job` accepts these actions:

| Action | Parameters | Outcome |
|---|---|---|
| `start` | `command` (executable) and optional `args` array | Returns a UUID, starting state, kind and creation time without waiting for completion |
| `list` | none | Up to 30 recent jobs for the current canonical project |
| `status` | `jobId` | Persistent state, process identifiers, exit code and timestamps |
| `logs` | `jobId`, optional `maxBytes` (up to 32,000) and optional `fromByte` cursor | Tail by default, or read sequential bounded pages with `fromByte`, `nextByte` and `remainingBytes` for resumable log inspection |
| `wait` | `jobId`, optional `waitMs` (at most 10,000) | Poll for a terminal state or return the latest state at the deadline |
| `cancel` | `jobId` | Request process-tree termination through a private cancellation marker |
| `prune` | optional `retentionDays` (0–365) | Remove only terminal jobs older than the age threshold |

The command is executed directly with an argv array. It is **not** interpreted by a shell; if shell features are needed, the caller must explicitly select a trusted shell executable and arguments. There is no retry, automatic merge, code modification by the job manager, or automatic task hierarchy.

`envelope_agent_start({ "prompt": "Inspect the repository" })` creates a job of kind `agent` by launching the installed `pi` CLI in print mode with a generated persistent session ID and an allowlist of read-only built-in tools. It returns the session ID and a resume command. **Do not open the session as a second writer while the background job runs.** This initial path cannot edit files; editable, independently managed agent worktrees are a separate integration stage.

## Durable state and failure rules

The supervisor runs as a detached Node process, so Pi can return without waiting. A separate process owns child stdout/stderr and records exit status. Jobs live under `<ENVELOPE_HOME>/envelope-jobs/<sha256-project-prefix>/<uuid>/`, with private metadata, bounded output and a heartbeat. Project identity comes from the canonical project path. There is no global cross-project job search.

States include `starting`, `running`, `cancelling`, `completed`, `failed`, `cancelled` and `interrupted`. Exit code 0 alone means the process exited successfully, **not** that code edits or tests were reviewed. A missing supervisor heartbeat after 15 seconds is reported as `interrupted` rather than inventing a successful exit. An interrupted job is not automatically retried: verify its actual processes and output before starting a replacement.

Output has a 2 MB per-job default cap (configurable internally up to 10 MB), and `outputTruncated` is true only if output exceeds the cap and excess bytes are dropped. No background stdout/stderr is injected into the conversation. The normal Pi session transcript and Envelope exact-output store remain separate.

Cancellation is best-effort: the supervisor polls a file, sends termination to the launched process group on POSIX, uses Windows process-tree termination where supported, then escalates to SIGKILL. Descendants that create independent sessions can evade process-group cancellation. The jobs registry is **not an OS sandbox**; commands inherit the invoking environment and the current user's filesystem and network permissions. Restrict credentials and execute untrusted work in an actual sandbox.

Private job metadata records command argv (which may contain sensitive data). Do not pass tokens in argv. The job files are protected by owner-only modes where supported, but deletion is not guaranteed to remove copies from backups. There is no automatic expiry; use `prune` explicitly.

## Verification and non-goals

`node --test tests/managed-jobs.test.mjs` covers durable exit status, nonzero failures, cancellation, bounded logs, project isolation, supervisor survival after launching Pi exits, bad binaries, opt-in gating and safe retention. `npm run check`, `npm run smoke:runtime`, `npm run pack:check` and cross-platform verification are still required before releasing.

This is **not** yet a complete managed-agent implementation. Foreground-to-background detachment, live interaction with a running agent, crash-atomic session reattachment, automatic write-capable isolated worktrees, machine-level process containment, and auto-recovery after an OS restart remain separate capabilities requiring design and real-runtime testing.

For agent sessions, the installed Pi CLI executable is resolved to a canonical project-external path before execution; project-local `pi` shims are never selected. On Windows, npm `.cmd` shims cannot be spawned safely with `shell:false`: set `ENVELOPE_PI_CLI_ENTRYPOINT` to the absolute installed Pi Node `.js`/`.mjs` CLI entrypoint. This path must be a trusted regular executable or script outside the project. Missing/untrusted entrypoints refuse the start rather than guessing.
