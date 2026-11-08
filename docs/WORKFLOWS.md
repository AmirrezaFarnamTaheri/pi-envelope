# Native workflows, isolated worker execution and verified handoffs

This Pi extension implements **native, durable dependency-aware tasks**. It draws on the task state/verification discipline of [open-gsd/gsd-pi](https://github.com/open-gsd/gsd-pi) and the local owned-work queue approach of [mvschwarz/openrig](https://github.com/mvschwarz/openrig). It is original integration code, **not** a complete port of GSD, OpenRig, their agent runtimes or their message buses.

## Safety and lifecycle

- A workflow is a named DAG of 1-40 tasks, each with a stable ID, title, instructions and optional dependencies. Invalid IDs, duplicate tasks, unknown dependencies and cycles are rejected before any data is written.
- Workflow state lives in `~/.tersio/envelope-workflows/workflow.sqlite`. The SQLite database uses WAL, foreign keys, scoped composite identifiers and `BEGIN IMMEDIATE` transactions; its containing directory is mode `0700` and the database mode `0600`.
- A task transitions `pending -> running -> review -> completed` after a reviewer supplies verification evidence. `running -> failed` and `review -> failed` are possible. A timed-out lease becomes `interrupted` on the next claim attempt.
- Dependencies require **completed**, not `review` or `failed`. Successful Pi process exit means `review`, NOT verified completion. Files may have changed even after a failed child; inspect the working tree before retrying.
- A claim is valid for the task's current private token, within its lease. Two ledger instances cannot simultaneously claim work in the same project. A claim from a different project cannot see or mutate the workflow.
- **No automatic retry and no task stealing.** A failed or interrupted task stays blocked until an explicit `envelope_workflow_retry` call; a running claim may be interrupted by worker loss, and a prior child could have left edits behind.
- At most one `running` task is allowed per canonical project at a time, across all workflows. Existing project symlink aliases resolve to the same project identity.
- Read-only status and audit output are bounded; full task instructions are returned only to the claimant, not repeated in a 40-task status dump.

## Pi tools

The nine tools are included in the existing single `envelope` Pi extension; no additional global Pi plugin, daemon or tmux process is registered.

| Tool | Purpose |
|---|---|
| `envelope_workflow_create` | Create a workflow and persist its dependency DAG |
| `envelope_workflow_status` | Show latest or selected project workflow, ready tasks, statuses and short instructions previews |
| `envelope_workflow_claim` | Claim exactly one ready task and obtain its lease token |
| `envelope_workflow_finish` | Submit claimed work with the token as `review` or `failed` |
| `envelope_workflow_review` | Mark reviewed work `completed` or `failed` with evidence |
| `envelope_workflow_retry` | Explicitly retry `failed` or `interrupted` work |
| `envelope_workflow_events` | Read recent durable ownership and transition events |
| `envelope_workflow_run` | Opt-in one-shot child Pi execution of one claimable task in a detached worktree |
| `envelope_workflow_handoff` | Read durable worktree location, changed paths, SHA-256 fingerprint and exact output ID |

### Example manual workflow

1. Create `envelope_workflow_create({"name":"Release","tasks":[{"id":"tests","title":"Add tests","instructions":"Write failing tests"},{"id":"fix","title":"Implement fix","instructions":"Make tests pass","dependsOn":["tests"]}]})`.
2. Record the returned `workflowId`; use `envelope_workflow_status({"workflowId":"..."})` to see `tests` ready and `fix` blocked.
3. Call `envelope_workflow_claim({"workflowId":"...","worker":"parent-agent"})`. The result contains the task and its private claim token. The worker can edit source using ordinary Pi tools.
4. Call `envelope_workflow_finish({"workflowId":"...","taskId":"tests","token":"...","outcome":"review","summary":"Added regression test and ran npm test"})`. The dependent `fix` remains blocked.
5. Verify changes and run the test yourself, then call `envelope_workflow_review({"workflowId":"...","taskId":"tests","outcome":"completed","evidence":"Confirmed red-green test cycle and npm test result"})`. Only then is `fix` ready.

The workflow ID and claim token are opaque values returned by the tools; they are not filesystem paths.

### Opt-in child-agent worker

Child-agent execution is **off by default**. Only `/envelope workflow run on` enables `envelope_workflow_run`. `/envelope workflow run off` disables it again; `/envelope workflow off` blocks workflow mutations altogether, while still permitting status and audit reads.

When enabled, `envelope_workflow_run({"workflowId":"..."})` validates a **clean committed Git repository root** before claiming a task, then uses `git worktree add --detach` to create a new private worktree pinned to the current HEAD. Pi executes `pi --print --no-session --no-mcp --exclude-tools 'envelope_workflow_*' -- <task prompt>` **inside that worktree**. Git and Pi commands use direct argv arrays without shell interpretation. The child can edit files there; the parent repository remains unchanged by ordinary worktree-local edits. **This is not a sandbox.** Child code still has host filesystem, credential and process permissions; a malicious or careless child could affect locations outside the worktree. The retired shared-directory execution mode is unsafe: `isolated:false` is rejected before a task is claimed or a child spawned. The child has a ten-minute abort signal and a fifteen-minute exclusive lease; hard process termination depends on the host runner honoring the signal.

Each worktree is retained under `~/.tersio/envelope-workflows/worktrees/<project-hash>/<workflow-id>/<task-id>-a<attempt>` for later inspection. Failed or interrupted attempts are never automatically deleted. On completion, the adapter hashes the complete tracked diff against pinned HEAD plus the byte contents of untracked files (limits: 2 MB tracked diff, 5 MB per untracked file, 10 MB total untracked data, 100 untracked and 500 changed paths). If the child changes HEAD, the worktree is removed/replaced, or the handoff cannot be captured, the task fails closed instead of entering review. The `envelope_workflow_handoff` read-only tool shows the saved fingerprint, a bounded preview (first 30 changed paths and 15 untracked hashes), path counts, and raw output ID. The SQLite handoff retains the complete path and hash lists; use Git inside the recorded worktree for full diff inspection. An `envelope_workflow_review` approval freshly rehashes the worktree and refuses stale/mismatched fingerprints. This provides reproducible Git-visible review evidence but **does not prove tests passed**, ensure a human reviewed, or capture files excluded by `.gitignore`. Approval remains explicitly requested and must be based on independent test/diff inspection.

The child receives instructions to work on only the claimed task, run targeted checks, avoid nested delegation and refrain from commits/pushes. The Pi CLI excludes Envelope workflow tools so it cannot recursively dispatch another Envelope workflow. The parent records stdout/stderr (up to 1.9 MB) into the existing project-scoped, byte-exact output store and returns an `outputId` for `envelope_recall_output`. The tool does not copy the full child transcript back into the model request.

An exit code of `0` **submits for review**; nonzero exit, killed/aborted child, spawn failure or raw-output capture failure records `failed`, with an audit event. Review still requires inspecting diffs, source changes and test evidence. Aborted calls before claiming do not change workflow state.

## State and data retention

Settings are stored as `envelope.workflow` inside Tersio's `settings.json`:

```json
{
  "workflow": {
    "enabled": true,
    "runEnabled": false
  }
}
```

Child execution is always isolated in a detached Git worktree; `isolated:false` is rejected before the task is claimed. There is no automatic merge or cherry-pick into the parent branch.

The object above is the nested `envelope.workflow` value, not a second root settings file. `ENVELOPE_HOME` or `TERSIO_HOME` can relocate it.

Workflow records, task prompts, actor IDs, review evidence and bounded event text remain on the local machine. There is no data retention cleanup or encryption at rest in this slice. Child runs may access the same privileges and credentials as the installed Pi host and should be enabled only in repositories where autonomous code edits are acceptable.

## Explicit non-goals / next integration points

This phase does **not** contain GSD's complete milestone/slice planner, automatic worktree integration/cleanup, automated model-selected verification, a continuous autonomous task loop, OpenRig's tmux daemon, RPC/HTTP server, team mailbox or parallel worker launch. The current isolated worktree adapter is one-shot and not an OS container or a supported automatic merge engine. The planned observability integration can read the bounded workflow `events` records without changing Pi lifecycle ownership.
